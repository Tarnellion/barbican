#!/usr/bin/env node

/**
 * Verification of the tool against the crAPI polygon's oracle.
 *
 * Brings crAPI up in docker, logs in the pre-seeded users, runs the built
 * `dist/cli.js run` and compares the findings against `ground-truth.json` in both
 * directions — what was missed and what was extra. A false positive devalues the tool
 * no less than a miss, so "found beyond the oracle" is just as much a discrepancy as
 * "not found".
 *
 * There is exactly one variant: crAPI has no vulnerability switch, and the oracle's
 * `selector` is empty. The details are in the oracle itself; the emptiness check is
 * below.
 *
 * crAPI itself is not vendored into the repository: someone else's project under its
 * own licence. The path to its `deploy/docker` comes from `CRAPI_DEPLOY_DIR`, the
 * specification from `CRAPI_SPEC` or from the same tree.
 *
 * Zero dependencies: built-in modules and docker only.
 *
 * Usage:
 *   CRAPI_DEPLOY_DIR=/path/to/crAPI/deploy/docker node polygons/crapi/verify.mjs
 *   ... node polygons/crapi/verify.mjs --keep    # do not stop the deployment after the run
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCoverage, compareVariant, loadGroundTruth } from "../../tools/oracle/index.mjs";
import { provision, USERS } from "./tokens.mjs";

const POLYGON_DIR = import.meta.dirname;
const REPO_ROOT = resolve(POLYGON_DIR, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const CONFIG = join(POLYGON_DIR, "barbican.run.yaml");
const OVERRIDE = join(POLYGON_DIR, "docker-compose.override.yaml");
const GROUND_TRUTH = join(POLYGON_DIR, "ground-truth.json");

/**
 * crAPI's images. Checked before the launch: otherwise `compose up` silently goes off
 * to pull a gigabyte and a half in the middle of the verification.
 */
const IMAGES = [
  "crapi/crapi-web",
  "crapi/crapi-identity",
  "crapi/crapi-community",
  "crapi/crapi-workshop",
];

/**
 * The endpoint a request to which writes to the deployment.
 *
 * `GET /workshop/api/mechanic/receive_report` is called create_service_report in the
 * specification and creates a service report: a safe method, an unsafe action.
 * Checked separately — once probed, it would change the deployment's state in the
 * middle of the run, and a match with the oracle would be accidental.
 */
const WRITING_ENDPOINT = "create_service_report";

/**
 * The local loopback tolerates a higher rate than the default.
 *
 * The tool's defaults (2 at a time, 5 per second) are meant for someone else's
 * deployment. Here the deployment is our own and in containers on the same machine.
 */
const RUN_FLAGS = ["--rps", "20", "--concurrency", "4"];

const PREFIX = "verify: ";

const NL = "\n";

/** Everything the script prints goes to stdout: this is a verification report, not diagnostics. */
function say(text) {
  process.stdout.write(text + NL);
}

function fail(message) {
  process.stderr.write(PREFIX + message + NL);
  process.exit(2);
}

/** A wrapper over spawn: it collects the output and never throws. */
function run(command, args, options) {
  return new Promise((done) => {
    const settings = {};
    settings.stdio = ["ignore", "pipe", "pipe"];
    settings.env = options?.env ?? process.env;
    const child = spawn(command, args, settings);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => done({ code: -1, stdout: out, stderr: error.message }));
    child.on("exit", (code) => done({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

/**
 * Pulls the baseUrl out of the run configuration.
 *
 * With a regular expression rather than by parsing YAML: the script must have no
 * dependencies. Exactly one value is needed, and we control the file's format.
 */
function readBaseUrl(configText) {
  const match = /^\s*baseUrl:\s*(\S+)\s*$/m.exec(configText);
  if (match === null) {
    fail("target.baseUrl not found in the run configuration");
  }
  return new URL(match[1]);
}

/**
 * Checks that the script logs in exactly those the configuration declares.
 *
 * A discrepancy here does not fail loudly, it quietly spoils the run: an account with
 * no token gets a 401 on every request, a 401 reads as a denial, a denial agrees with
 * the policy — and the report comes out clean having tested nothing.
 */
function assertLoginsMatchConfig(configText) {
  const hits = [...configText.matchAll(/^\s*tokenEnv:\s*(\S+)\s*$/gm)];
  const declared = hits.map((hit) => hit[1]);
  if (declared.length === 0) {
    fail("no tokenEnv found in the run configuration");
  }
  const provided = new Set(USERS.map((account) => account.tokenEnv));
  for (const name of declared) {
    if (!provided.has(name)) {
      fail(`the configuration needs ${name}, but tokens.mjs does not provide it`);
    }
  }
  for (const account of USERS) {
    if (!declared.includes(account.tokenEnv)) {
      fail(`tokens.mjs logs in ${account.id}, but the configuration has no such account`);
    }
  }
}

/**
 * Where crAPI itself lives.
 *
 * It is not vendored into the repository: someone else's project under its own
 * licence. The `deploy/docker` directory of its tree is set by the CRAPI_DEPLOY_DIR
 * variable, the specification by CRAPI_SPEC or by the same tree.
 */
function locateCrapi() {
  const deployDir = process.env.CRAPI_DEPLOY_DIR;
  if (deployDir === undefined) {
    fail("CRAPI_DEPLOY_DIR is not set: the deploy/docker directory of the crAPI tree");
  }
  const compose = join(deployDir, "docker-compose.yml");
  if (!existsSync(compose)) {
    fail(`${compose} not found`);
  }
  const guess = join(deployDir, "..", "..", "openapi-spec", "crapi-openapi-spec.json");
  const spec = process.env.CRAPI_SPEC ?? guess;
  if (!existsSync(spec)) {
    fail(`specification ${spec} not found; set CRAPI_SPEC`);
  }
  return { compose, spec };
}

/**
 * The compose environment.
 *
 * LISTEN_IP is set explicitly: the polygon is deliberately vulnerable, and it must
 * not be published anywhere but the loopback. The value from crAPI's own .env is
 * overridden in the process — an environment variable beats a file in compose.
 */
function composeEnvironment() {
  const environment = { ...process.env };
  environment.LISTEN_IP = "127.0.0.1";
  return environment;
}

/**
 * Only the web container is brought up: compose pulls the rest in itself through
 * depends_on. The chatbot is not on that list — see the override next to this file.
 */
async function composeUp(compose, environment) {
  const args = ["compose", "-f", compose, "-f", OVERRIDE, "up", "-d", "crapi-web"];
  const result = await run("docker", args, { env: environment });
  if (result.code !== 0) {
    fail(`docker compose up exited with code ${result.code}${NL}${result.stderr}`);
  }
}

/** Everything is stopped along with the volumes: a deliberately vulnerable deployment is not left running. */
async function composeDown(compose, environment) {
  const args = ["compose", "-f", compose, "-f", OVERRIDE, "down", "-v"];
  await run("docker", args, { env: environment });
}

/**
 * Waits for the web container's `GET /health`.
 *
 * It is the verification that waits, not the tool: crAPI takes a minute and more to
 * come up, and a run against a deployment that is not ready would give a solid wall
 * of 502s — a report without a single finding, indistinguishable from a clean one
 * from the outside.
 */
async function waitForHealth(baseUrl, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const options = { signal: AbortSignal.timeout(5000) };
      const response = await fetch(new URL("/health", baseUrl), options);
      if (response.ok) {
        return true;
      }
    } catch {
      // Not listening yet — try again.
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  return false;
}

/** The endpoints come from crAPI's own specification — the polygon keeps no list of its own. */
function runCli(spec, reportPath, environment) {
  const args = [CLI, "run", "-c", CONFIG, "-s", spec, "-r", reportPath, ...RUN_FLAGS];
  return run("node", args, { env: environment });
}

async function checkVariant(variant, baseUrl, spec, reportDir, compose) {
  const environment = composeEnvironment();
  say("");
  say(`=== ${variant.id} ===`);

  // An empty selector is how the polygon is built, not an oversight: crAPI has no
  // vulnerability switch. A non-empty one would mean the oracle has changed while the
  // script has not, and there is nothing to pass that to the deployment with.
  if (Object.keys(variant.selector).length > 0) {
    fail(`variant ${variant.id} sets a selector, but crAPI has nothing to switch`);
  }

  await composeUp(compose, environment);
  const healthy = await waitForHealth(baseUrl, 240);
  if (!healthy) {
    await composeDown(compose, environment);
    fail(`crAPI did not come up on ${baseUrl.origin}`);
  }

  const note = (message) => say(`  setup: ${message}`);
  const tokens = await provision({ baseUrl: baseUrl.origin, log: note });

  const reportPath = join(reportDir, `${variant.id}.report.json`);
  const withTokens = { ...environment, ...Object.fromEntries(tokens) };
  const result = await runCli(spec, reportPath, withTokens);

  if (!existsSync(reportPath)) {
    say(`  MISMATCH: no report was produced, exit code ${result.code}`);
    say(result.stderr);
    return false;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));

  // The comparison and the trustworthiness checks are shared by all polygons
  // (ADR-0012). There is no comparison code of our own here and there must not be.
  const shared = compareVariant(variant, report, result.code);
  const problems = [...shared.problems];

  // The writing endpoint must stay untouched: once probed, it creates a service
  // report, and the rest of the matrix is tested against an already changed
  // deployment.
  const writing = report.skipped.find((item) => item.endpointId === WRITING_ENDPOINT);
  if (writing?.reason !== "excluded") {
    problems.push(
      `${WRITING_ENDPOINT} was not excluded from the run — the deployment may have changed`,
    );
  }
  if (report.summary.failures > 0) {
    problems.push(`failed requests: ${report.summary.failures}`);
  }
  if (report.canariesChecked === 0) {
    problems.push("no canary was checked: authentication is unconfirmed");
  }

  const seen = report.summary.findings + report.summary.checkFindings;
  const counts = `  cells probed: ${report.summary.observations}`;
  const detail = `, canaries: ${report.canariesChecked}, findings: ${seen}`;
  say(`${counts + detail} (oracle expects ${variant.findings.length})`);

  if (problems.length === 0) {
    say(`  MATCHES the ground truth, exit code ${result.code}`);
    return true;
  }
  for (const problem of problems) {
    say(`  MISMATCH: ${problem}`);
  }
  say("  tool output:");
  say(result.stderr.replace(/^/gm, "    "));
  return false;
}

async function main() {
  if (!existsSync(CLI)) {
    fail(`${CLI} not found. Build the tool: pnpm run build`);
  }

  for (const image of IMAGES) {
    const inspected = await run("docker", ["image", "inspect", image]);
    if (inspected.code !== 0) {
      fail(
        "image " +
          image +
          " is not present locally. Pull the crAPI images beforehand: pulling a gigabyte and a half mid-verification is not something this script does.",
      );
    }
  }

  const located = locateCrapi();
  const configText = await readFile(CONFIG, "utf8");
  const baseUrl = readBaseUrl(configText);
  if (baseUrl.hostname !== "127.0.0.1") {
    fail(`baseUrl points at ${baseUrl.hostname}; the polygon lives on loopback only`);
  }
  assertLoginsMatchConfig(configText);

  // Completeness is checked before the run: a defect declared visible and expected in
  // no variant is either a forgotten variant or a wrong visibility mark.
  const groundTruth = loadGroundTruth(await readFile(GROUND_TRUTH, "utf8"));
  const gaps = checkCoverage(groundTruth);
  if (gaps.length > 0) {
    fail(`the ground truth is incomplete:${NL}  ${gaps.join(`${NL}  `)}`);
  }

  const keep = process.argv.includes("--keep");
  const keepReports = process.argv.includes("--keep-reports");
  const named = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const chosen = (variant) => named.length === 0 || named.includes(variant.id);
  const variants = groundTruth.variants.filter(chosen);
  if (variants.length === 0) {
    fail(`no variant matched the filter: ${named.join(", ")}`);
  }

  const reportDir = await mkdtemp(join(tmpdir(), "barbican-crapi-"));
  let mismatched = 0;

  for (const variant of variants) {
    let matched = false;
    try {
      matched = await checkVariant(variant, baseUrl, located.spec, reportDir, located.compose);
    } catch (error) {
      // A setup that fell through is not a discrepancy but an inability to test.
      // The deployment is stopped in any case: leaving a deliberately vulnerable API
      // running, one that serves other people's orders without a token, is a poor way
      // to finish a verification.
      await composeDown(located.compose, composeEnvironment());
      fail(`variant ${variant.id}: ${error.message}`);
    }
    if (!matched) {
      mismatched += 1;
    }
    if (!keep) {
      await composeDown(located.compose, composeEnvironment());
    }
  }

  say("");
  const tail = `Total: ${variants.length} variants, ${mismatched} mismatches`;
  say(tail);
  if (keep) {
    say("The deployment was left running. To stop it: docker compose down -v in the crAPI tree.");
  }
  // The reports go with the run unless asked for: kept always and removed never,
  // they had grown to 214 MB by the audit of 14 August, and against a real
  // platform their contents are not synthetic.
  if (!keepReports) {
    await rm(reportDir, { recursive: true, force: true });
  }
  return mismatched === 0 ? 0 : 1;
}

process.exitCode = await main();

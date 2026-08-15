#!/usr/bin/env node

/**
 * Verification of the tool against the VAmPI polygon's oracle.
 *
 * Brings VAmPI up in docker, creates the users and the books, obtains the tokens,
 * runs the built `dist/cli.js run` and compares the findings against
 * `ground-truth.json` in both directions — what was missed and what was extra. A
 * false positive devalues the tool no less than a miss, so "found beyond the oracle"
 * is just as much a discrepancy as "not found".
 *
 * There are two modes: `vulnerable` and `secure`. This is not "there are defects /
 * there are none": by response status the modes differ by exactly one defect
 * (ADR-0009), so each has a list of findings of its own, and the secure mode is not a
 * check for zero but a check for a different non-empty set.
 *
 * Zero dependencies: built-in modules and docker only.
 *
 * Usage:
 *   node polygons/vampi/verify.mjs                 # both modes
 *   node polygons/vampi/verify.mjs vulnerable      # only the named one
 *   node polygons/vampi/verify.mjs --keep          # do not stop the deployment after the run
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
const COMPOSE = join(POLYGON_DIR, "docker-compose.yaml");
const CONFIG = join(POLYGON_DIR, "barbican.run.yaml");
const ENDPOINTS = join(POLYGON_DIR, "endpoints.yaml");
const GROUND_TRUTH = join(POLYGON_DIR, "ground-truth.json");

/** The image is checked before the launch: otherwise `compose up` silently goes off to pull it. */
const IMAGE = "erev0s/vampi:latest";

/**
 * The endpoint a request to which destroys the deployment.
 *
 * Checked separately: should it turn out to have been probed, every finding after it
 * was obtained against an empty database, and a match with the oracle would be
 * accidental.
 */
const DESTRUCTIVE_ENDPOINT = "db.createdb";

/**
 * The local loopback tolerates a higher rate than the default.
 *
 * The tool's defaults (2 at a time, 5 per second) are meant for someone else's
 * deployment. Here the deployment is our own and in a container on the same machine.
 */
const RUN_FLAGS = ["--rps", "25", "--concurrency", "4"];

function fail(message) {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(2);
}

function run(command, args, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
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
    fail(`target.baseUrl not found in ${CONFIG}`);
  }
  return new URL(match[1]);
}

function readTokenEnvNames(configText) {
  const names = [...configText.matchAll(/^\s*tokenEnv:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (names.length === 0) {
    fail(`no tokenEnv found in ${CONFIG}`);
  }
  return names;
}

/**
 * Checks that the script creates exactly those the configuration declares.
 *
 * A discrepancy here does not fail loudly, it quietly spoils the run: a user that was
 * not created gives a 404 on every request, a 404 reads as a denial, a denial agrees
 * with the policy — and the report comes out clean having tested nothing.
 */
function assertProvisioningMatchesConfig(configText) {
  const declared = new Set(readTokenEnvNames(configText));
  const provided = new Set(USERS.map((user) => user.tokenEnv));
  for (const name of declared) {
    if (!provided.has(name)) {
      fail(`the configuration needs ${name}, but tokens.mjs does not provide that variable`);
    }
  }
  for (const user of USERS) {
    if (!configText.includes(`username: ${user.username}`)) {
      fail(`tokens.mjs creates user "${user.username}", but ${CONFIG} has no such resource`);
    }
    if (!configText.includes(`book_title: ${user.book}`)) {
      fail(`tokens.mjs creates book "${user.book}", but ${CONFIG} has no such resource`);
    }
  }
}

/**
 * Checks the oracle for internal consistency and completeness.
 *
 * Parsing the format and the "finding → defect" link is the shared module's job
 * (ADR-0012). What is left here is what the shared module need not know: completeness
 * — a defect declared visible and expected in no variant is either a forgotten
 * variant or a wrong visibility mark.
 */
function assertOracleIsSound(groundTruth) {
  const gaps = checkCoverage(groundTruth);
  if (gaps.length > 0) {
    fail(`the ground truth is incomplete:\n  ${gaps.join("\n  ")}`);
  }
}

function composeEnvironment(port, vulnerable) {
  return { ...process.env, VAMPI_PORT: String(port), VAMPI_VULNERABLE: String(vulnerable) };
}

async function composeUp(environment) {
  const result = await run("docker", ["compose", "-f", COMPOSE, "up", "-d"], {
    env: environment,
  });
  if (result.code !== 0) {
    fail(`docker compose up exited with code ${result.code}:\n${result.stderr}`);
  }
}

async function composeDown(environment) {
  await run("docker", ["compose", "-f", COMPOSE, "down", "-v"], { env: environment });
}

/**
 * Waits for the `GET /` banner and returns its body.
 *
 * The body is read by the verification, not by the tool: in the banner VAmPI declares
 * its mode, and that is the only way to make sure the deployment came up exactly as
 * requested. A variable that did not arrive would otherwise look like a miss by the
 * tool.
 */
async function waitForBanner(baseUrl, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(new URL("/", baseUrl), { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Not listening yet — try again.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return undefined;
}

function runCli(reportPath, environment) {
  return run("node", [CLI, "run", "-c", CONFIG, "-e", ENDPOINTS, "-r", reportPath, ...RUN_FLAGS], {
    env: environment,
  });
}

async function checkMode(mode, baseUrl, reportDir) {
  const environment = composeEnvironment(baseUrl.port, mode.selector.vulnerable);

  process.stdout.write(`\n=== ${mode.id} === vulnerable=${mode.selector.vulnerable}\n`);

  await composeUp(environment);
  const banner = await waitForBanner(baseUrl);
  if (banner === undefined) {
    await composeDown(environment);
    fail(`VAmPI did not come up on ${baseUrl.origin}`);
  }
  if (banner.vulnerable !== mode.selector.vulnerable) {
    await composeDown(environment);
    fail(
      `the deployment came up with vulnerable=${banner.vulnerable}, expected ${mode.selector.vulnerable}`,
    );
  }

  const tokens = await provision({
    baseUrl: baseUrl.origin,
    log: (message) => process.stdout.write(`  setup: ${message}\n`),
  });

  const reportPath = join(reportDir, `${mode.id}.report.json`);
  const result = await runCli(reportPath, { ...environment, ...Object.fromEntries(tokens) });

  if (!existsSync(reportPath)) {
    process.stdout.write(
      `  MISMATCH: no report was produced, exit code ${result.code}\n${result.stderr}`,
    );
    return false;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));

  // The comparison and the trustworthiness checks are shared by all polygons
  // (ADR-0012).
  const { problems: shared } = compareVariant(mode, report, result.code);
  const problems = [...shared];

  // The destructive endpoint must stay untouched: once probed, it wipes the users and
  // the books, and the rest of the matrix is tested against an empty database.
  const destructive = report.skipped.find((item) => item.endpointId === DESTRUCTIVE_ENDPOINT);
  if (destructive?.reason !== "excluded") {
    problems.push(
      `${DESTRUCTIVE_ENDPOINT} was not excluded from the run — the deployment may have been reset`,
    );
  }
  // The signs of an untrustworthy run: there may be no findings simply because they
  // were never reached.
  if (report.truncated) {
    problems.push("the run was cut short (truncated), the tail of the matrix was never tested");
  }
  if (report.unauthenticated.length > 0) {
    problems.push(`accounts with no access anywhere: ${report.unauthenticated.join(", ")}`);
  }
  if (report.summary.failures > 0) {
    problems.push(`failed requests: ${report.summary.failures}`);
  }
  if (report.canariesChecked === 0) {
    problems.push("no canary was checked: authentication is unconfirmed");
  }

  process.stdout.write(
    `  cells probed: ${report.summary.observations}, ` +
      `canaries: ${report.canariesChecked}, ` +
      `findings: ${report.summary.findings} (oracle expects ${mode.findings.length})\n`,
  );

  if (problems.length === 0) {
    process.stdout.write(`  MATCHES the ground truth, exit code ${result.code}\n`);
    return true;
  }
  for (const problem of problems) {
    process.stdout.write(`  MISMATCH: ${problem}\n`);
  }
  process.stdout.write(`  tool output:\n${result.stderr.replace(/^/gm, "    ")}`);
  return false;
}

async function main() {
  if (!existsSync(CLI)) {
    fail(`${CLI} not found. Build the tool: pnpm run build`);
  }

  const docker = await run("docker", ["image", "inspect", IMAGE]);
  if (docker.code !== 0) {
    fail(
      `image ${IMAGE} is not present locally (docker image inspect: ${docker.code}). ` +
        `Run docker pull ${IMAGE} — pulling it silently mid-verification is not something this script does.`,
    );
  }

  const configText = await readFile(CONFIG, "utf8");
  const baseUrl = readBaseUrl(configText);
  if (baseUrl.hostname !== "127.0.0.1") {
    fail(`baseUrl points at ${baseUrl.hostname}; the polygon is published on loopback only`);
  }
  assertProvisioningMatchesConfig(configText);

  const groundTruth = loadGroundTruth(await readFile(GROUND_TRUTH, "utf8"));
  assertOracleIsSound(groundTruth);

  const keep = process.argv.includes("--keep");
  const keepReports = process.argv.includes("--keep-reports");
  const selected = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const modes = groundTruth.variants.filter(
    (mode) => selected.length === 0 || selected.includes(mode.id),
  );
  if (modes.length === 0) {
    fail(`no mode matched the filter: ${selected.join(", ")}`);
  }

  const reportDir = await mkdtemp(join(tmpdir(), "barbican-vampi-"));
  let mismatched = 0;

  for (const mode of modes) {
    let matched = false;
    try {
      matched = await checkMode(mode, baseUrl, reportDir);
    } catch (error) {
      // A setup that fell through is not a discrepancy but an inability to test.
      // The deployment is stopped in any case: leaving a deliberately vulnerable API
      // running, one that serves passwords without a token, is a poor way to finish a
      // verification.
      await composeDown(composeEnvironment(baseUrl.port, mode.selector.vulnerable));
      fail(`mode ${mode.id}: ${error.message}`);
    }
    if (!matched) {
      mismatched += 1;
    }
    if (!keep) {
      await composeDown(composeEnvironment(baseUrl.port, mode.selector.vulnerable));
    }
  }

  process.stdout.write(`\nTotal: ${modes.length} modes, ${mismatched} mismatches.\n`);
  if (keep) {
    process.stdout.write(`The deployment was left running: docker compose -f ${COMPOSE} down -v\n`);
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

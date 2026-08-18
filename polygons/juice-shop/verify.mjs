#!/usr/bin/env node

/**
 * Verification of the tool against the Juice Shop polygon's oracle.
 *
 * Brings the container up, registers the two customers, obtains their tokens,
 * runs the built `dist/cli.js run` and compares the findings against
 * `ground-truth.json` in both directions — what was missed and what was extra. A
 * false positive devalues the tool no less than a miss, so "found beyond the
 * oracle" is as much a discrepancy as "not found".
 *
 * One variant, unlike VAmPI. There is no vulnerability switch here: the defects
 * are what the application is for. ADR-0009 had already settled that the oracle
 * is a hand-written list of defects rather than the difference between two modes,
 * so nothing is lost.
 *
 * There is also nothing to exclude. VAmPI needed `exclude: [db.createdb]` because
 * a GET there wipes the database and every finding after it would have been taken
 * against an empty one. Juice Shop has no destructive GET on this list, which is
 * said here rather than left as an absence somebody has to notice.
 *
 * Zero dependencies: built-in modules and docker only.
 *
 * Usage:
 *   node polygons/juice-shop/verify.mjs            # bring up, verify, tear down
 *   node polygons/juice-shop/verify.mjs --keep     # leave the deployment running
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

/**
 * The local loopback tolerates a higher rate than the default.
 *
 * The tool's defaults (2 at a time, 5 per second) are meant for somebody else's
 * deployment. Here it is our own container on the same machine, and 69 cells at
 * five a second is fourteen seconds of waiting for a stand to answer itself.
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
 * With a regular expression rather than by parsing YAML: the script has no
 * dependencies. Exactly one value is needed and we control the file's format. The
 * port then goes to compose, so the two cannot name different ports.
 */
function readBaseUrl(configText) {
  const match = /^\s*baseUrl:\s*(\S+)\s*$/m.exec(configText);
  if (match === null) {
    fail(`target.baseUrl not found in ${CONFIG}`);
  }
  return new URL(match[1]);
}

/**
 * Checks that provisioning creates exactly what the configuration addresses.
 *
 * A discrepancy here does not fail loudly, it quietly spoils the run: a customer
 * that was not created gets 401 everywhere, a 401 reads as a denial, a denial
 * agrees with a policy of mostly denials — and the report comes out clean having
 * tested nothing.
 */
function assertProvisioningMatchesConfig(configText) {
  const declared = new Set(
    [...configText.matchAll(/^\s*tokenEnv:\s*(\S+)\s*$/gm)].map((match) => match[1]),
  );
  if (declared.size === 0) {
    fail(`no tokenEnv found in ${CONFIG}`);
  }
  const provided = new Set(USERS.map((user) => user.tokenEnv));
  for (const name of declared) {
    if (!provided.has(name)) {
      fail(`the configuration needs ${name}, but tokens.mjs does not provide that variable`);
    }
  }
  // The ids are the image's to assign and the policy's to address. tokens.mjs
  // asserts the same pairing from the other side, against what the login actually
  // returned; this side catches a configuration edited without it.
  for (const user of USERS) {
    if (!configText.includes(`basketId: "${user.basketId}"`)) {
      fail(
        `tokens.mjs expects basket ${user.basketId} for ${user.id}, and ${CONFIG} declares no such resource`,
      );
    }
    if (!configText.includes(`userId: "${user.userId}"`)) {
      fail(
        `tokens.mjs expects user ${user.userId} for ${user.id}, and ${CONFIG} declares no such resource`,
      );
    }
  }
}

/**
 * Checks the oracle for completeness.
 *
 * Parsing the format and the "finding → defect" link is the shared module's job
 * (ADR-0012). What is left here is what that module need not know: a defect
 * declared visible and expected in no variant is either a forgotten variant or a
 * wrong visibility mark.
 */
function assertOracleIsSound(groundTruth) {
  const gaps = checkCoverage(groundTruth);
  if (gaps.length > 0) {
    fail(`the ground truth is incomplete:\n  ${gaps.join("\n  ")}`);
  }
}

function composeEnvironment(port) {
  return { ...process.env, JUICE_PORT: String(port) };
}

async function composeUp(environment) {
  const result = await run("docker", ["compose", "-f", COMPOSE, "up", "-d"], { env: environment });
  if (result.code !== 0) {
    fail(`docker compose up exited with code ${result.code}:\n${result.stderr}`);
  }
}

async function composeDown(environment) {
  await run("docker", ["compose", "-f", COMPOSE, "down", "-v"], { env: environment });
}

/**
 * Waits for the application, and for the application rather than for the port.
 *
 * The version endpoint and not `/`: the shopfront is an Angular bundle that is
 * served long before the database has been seeded, and a wait that ends there
 * would hand provisioning a container that cannot yet register anybody.
 */
async function waitForApplication(baseUrl, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(new URL("/rest/admin/application-version", baseUrl), {
        signal: AbortSignal.timeout(5000),
      });
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

async function main() {
  if (!readFileSync(CLI, "utf8")) {
    fail("dist/cli.js is empty — run `pnpm run build` first");
  }

  const configText = await readFile(CONFIG, "utf8");
  const baseUrl = readBaseUrl(configText);
  assertProvisioningMatchesConfig(configText);

  const groundTruth = loadGroundTruth(await readFile(GROUND_TRUTH, "utf8"));
  assertOracleIsSound(groundTruth);

  const environment = composeEnvironment(baseUrl.port);
  const reportDir = await mkdtemp(join(tmpdir(), "barbican-juice-"));
  const keep = process.argv.includes("--keep");
  let mismatches = 0;

  try {
    // Recreated, not merely started. There is no reset endpoint here — VAmPI has
    // `/createdb` and this application has nothing like it — so a container left
    // over from an earlier run already holds alice, and registration fails on the
    // unique email. The fresh database is also what makes the user and basket ids
    // deterministic, which is the assertion tokens.mjs rests on.
    await composeDown(environment);
    await composeUp(environment);
    const version = await waitForApplication(baseUrl);
    if (version === undefined) {
      fail(`Juice Shop did not come up on ${baseUrl.origin}`);
    }
    process.stdout.write(`\n=== juice-shop ${version.version} === ${baseUrl.origin}\n`);

    const tokens = await provision({
      baseUrl: baseUrl.origin,
      log: (message) => process.stdout.write(`  setup: ${message}\n`),
    });

    const reportPath = join(reportDir, "juice-shop.report.json");
    const result = await runCli(reportPath, { ...environment, ...Object.fromEntries(tokens) });
    const report = JSON.parse(await readFile(reportPath, "utf8"));

    const variant = groundTruth.variants[0];
    const comparison = compareVariant(variant, report, result.code);

    process.stdout.write(
      `  cells probed: ${(report.observations ?? []).length}, ` +
        `canaries: ${report.canariesChecked ?? 0}, ` +
        `findings: ${(report.findings ?? []).length} ` +
        `(oracle expects ${variant.findings.length})\n`,
    );

    if (comparison.problems.length === 0) {
      process.stdout.write(`  MATCHES the ground truth, exit code ${result.code}\n`);
    } else {
      mismatches = comparison.problems.length;
      for (const problem of comparison.problems) {
        process.stdout.write(`  MISMATCH: ${problem}\n`);
      }
      process.stdout.write(`  tool output:\n${result.stderr.replace(/^/gm, "    ")}\n`);
    }
  } finally {
    if (!keep) {
      await composeDown(environment);
    }
    await rm(reportDir, { recursive: true, force: true });
  }

  process.stdout.write(`\nTotal: 1 variant, ${mismatches} mismatches.\n`);
  process.exit(mismatches === 0 ? 0 : 1);
}

try {
  await main();
} catch (error) {
  fail(error.message);
}

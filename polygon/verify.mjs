#!/usr/bin/env node

/**
 * Verification of the tool against the reference platform's oracle.
 *
 * For every combination of defect flags: brings the platform up, runs the built
 * `dist/cli.js run`, compares the findings against `ground-truth.json` and prints
 * the discrepancies in both directions — what was missed and what was extra.
 *
 * More important than detection is an empty result with the flags switched off. A
 * tool that finds defects but fabricates findings on a correct platform is just as
 * useless.
 *
 * Zero dependencies: built-in modules only.
 *
 * Usage:
 *   node polygon/verify.mjs            # all combinations
 *   node polygon/verify.mjs clean all  # only the named ones
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCoverage, compareVariant, loadGroundTruth } from "../tools/oracle/index.mjs";

const POLYGON_DIR = import.meta.dirname;
const REPO_ROOT = resolve(POLYGON_DIR, "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const SERVER = join(POLYGON_DIR, "server.mjs");
const CONFIG = join(POLYGON_DIR, "barbican.run.yaml");
const ENDPOINTS = join(POLYGON_DIR, "endpoints.yaml");
const GROUND_TRUTH = join(POLYGON_DIR, "ground-truth.json");

/** The environment variable name → the field in the `/v1/health` response. */
const FLAG_FIELDS = {
  POLYGON_DEFECT_CROSS_TENANT: "crossTenant",
  POLYGON_DEFECT_NO_ROLE_CHECK: "noRoleCheck",
  POLYGON_DEFECT_IDOR_SAME_TENANT: "idorSameTenant",
  POLYGON_DEFECT_LIST_NO_FILTER: "listNoFilter",
  POLYGON_DEFECT_CROSS_HOLDING: "crossHolding",
  POLYGON_DEFECT_ANCESTOR_LEAK: "ancestorLeak",
  POLYGON_DEFECT_PARENT_LEAK: "parentLeak",
  POLYGON_DEFECT_PRIMARY_TENANT_ONLY: "primaryTenantOnly",
  POLYGON_DEFECT_GEO_BYPASS: "geoBypass",
  POLYGON_DEFECT_SCOPE_ALL_HONORED: "scopeAllHonored",
  POLYGON_DEFECT_WRITE_CROSS_TENANT: "writeCrossTenant",
  POLYGON_DEFECT_WRITE_NO_OWNER_CHECK: "writeNoOwnerCheck",
};

/**
 * The local loopback tolerates a higher rate than the default.
 *
 * The tool's defaults (2 at a time, 5 per second) are meant for someone else's
 * deployment. Here the deployment is our own, under the same parent process, and 80
 * requests at 5 per second would stretch each of the nineteen combinations to half
 * a minute.
 */
const RUN_FLAGS = ["--rps", "50", "--concurrency", "4"];

function fail(message) {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(2);
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

/** The token variable names come from the same configuration — so the two cannot diverge. */
function readTokenEnvNames(configText) {
  const names = [...configText.matchAll(/^\s*tokenEnv:\s*(\S+)\s*$/gm)].map((match) => match[1]);
  if (names.length === 0) {
    fail(`no tokenEnv found in ${CONFIG}`);
  }
  return names;
}

async function waitForHealth(baseUrl, child, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode !== null) {
      return undefined;
    }
    try {
      const response = await fetch(new URL("/v1/health", baseUrl));
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Not listening yet — try again.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return undefined;
}

function startServer(environment) {
  const child = spawn(process.execPath, [SERVER], {
    env: environment,
    stdio: ["ignore", "inherit", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return { child, readStderr: () => stderr };
}

function stopServer(child) {
  return new Promise((done) => {
    if (child.exitCode !== null) {
      done();
      return;
    }
    child.once("exit", () => done());
    child.kill("SIGTERM");
  });
}

function runCli(reportPath, environment, unsafeMethods, extra = []) {
  return new Promise((done) => {
    // The flag comes from the variant rather than from the command line: whether a
    // write endpoint is probed is a property of the claim being checked, and a
    // human deciding it per invocation would make the oracle depend on how the
    // script was called.
    const flags = unsafeMethods ? [...RUN_FLAGS, "--unsafe-methods"] : RUN_FLAGS;
    const child = spawn(
      process.execPath,
      [
        CLI,
        "run",
        "-c",
        CONFIG,
        "-e",
        ENDPOINTS,
        // A dry run writes no report, and giving it a path would say it did.
        ...(reportPath === undefined ? [] : ["-r", reportPath]),
        ...flags,
        ...extra,
      ],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * `--dry-run` sends nothing.
 *
 * Proved rather than asserted, and proved the only way that admits no argument:
 * the platform is not running. The configuration points at a port nothing is
 * listening on, so a single request would fail — and the dry run has to come
 * back with the endpoint list and exit code 0 all the same.
 *
 * Without this the flag is a promise about traffic on someone else's deployment
 * held up by nothing but the order of two lines in `cli.ts`.
 */
async function assertDryRunSendsNothing(baseUrl) {
  const environment = { ...process.env, POLYGON_PORT: baseUrl.port };
  const { code, stderr } = await runCli(undefined, environment, false, ["--dry-run"]);

  if (code !== 0) {
    fail(`--dry-run against a platform that is not up ended with ${code}:\n${stderr}`);
  }
  // The endpoint identifiers are the point of the mode: a reader who does not
  // know them cannot write a policy rule.
  if (!stderr.includes("orders.cancel")) {
    fail(`--dry-run printed no endpoint list:\n${stderr}`);
  }
  process.stdout.write("--dry-run: nothing sent, the platform was not even up\n");
}

/**
 * An unusable --report path is refused before the first request.
 *
 * The audit of 14 August spent 152 requests against the platform and then died
 * on ENOENT with nothing to show for them. Proved the same way as the dry run:
 * the platform is not up, so a check that ran after the walk would fail on the
 * connection instead, and the message tells the two apart.
 */
async function assertReportPathIsCheckedFirst(baseUrl) {
  const environment = { ...process.env, POLYGON_PORT: baseUrl.port };
  const { code, stderr } = await runCli(undefined, environment, false, [
    "-r",
    "/nonexistent-dir-for-verify/report.json",
  ]);

  if (code === 0) {
    fail("a run with an unusable --report path ended with 0");
  }
  if (!stderr.includes("--report cannot be written")) {
    fail(`an unusable --report path was not refused up front:\n${stderr}`);
  }
  process.stdout.write("--report: an unusable path is refused before the first request\n");
}

/**
 * A mistake in the command line does not report as a finding about the platform.
 *
 * commander exits 1 on an unknown option, and 1 is this tool's "checked, and
 * reality does not match what you declared" — so `--unsafe-metods` reported as a
 * privilege escalation, in the one place where the exit code is the whole
 * interface. Found by the audit of 14 August.
 *
 * Spawned rather than unit-tested because the number under test is produced by
 * commander and by `process.exitCode` between them, and neither is visible from
 * inside the process. `--help` is here for the same reason the fix needed a
 * condition: commander reports printing it as an exit too.
 */
async function assertUsageErrorsHaveTheirOwnCode() {
  const cases = [
    { argv: ["run", "--unsafe-metods"], want: 64, what: "an unknown option" },
    { argv: ["run"], want: 64, what: "a missing required option" },
    { argv: ["run", "-c", CONFIG, "--concurrency", "abc"], want: 64, what: "a bad option value" },
    { argv: ["nosuchcommand"], want: 64, what: "an unknown command" },
    { argv: ["--help"], want: 0, what: "--help" },
    { argv: ["run", "--help"], want: 0, what: "--help on a subcommand" },
    { argv: ["--version"], want: 0, what: "--version" },
  ];

  for (const { argv, want, what } of cases) {
    const code = await new Promise((done) => {
      // No POLYGON_PORT and no platform: none of these may get as far as a
      // request, and if one does it fails on the connection instead of here.
      const child = spawn(process.execPath, [CLI, ...argv], {
        env: process.env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("exit", (one) => done(one ?? -1));
    });
    if (code !== want) {
      fail(`${what} (${argv.join(" ")}) ended with ${code}, expected ${want}`);
    }
  }
  process.stdout.write("exit codes: a usage error is 64, not 1; --help and --version stay 0\n");
}

const README = "polygon/README.md";
const TABLE_BEGIN = "<!-- verify:begin -->";
const TABLE_END = "<!-- verify:end -->";

/**
 * Assembles the block with the result of the verification.
 *
 * Written by the run, not by a human: the numbers in that document drifted apart
 * from the code twice, and the second time the neighbouring paragraph itself
 * explained why they were different — the explanation got updated, the number did
 * not.
 */
function renderTable(rows) {
  const width = Math.max(...rows.map((row) => row.id.length));
  const lines = rows.map((row) => {
    const name = `\`${row.id}\``.padEnd(width + 2);
    const body = row.byBody > 0 ? `, of them by body ${row.byBody}` : "";
    return `| ${name} | ${row.findings}${body} | ${row.expected} | ${row.matched ? "match" : "MISMATCH"} | ${row.code} |`;
  });
  return [
    TABLE_BEGIN,
    "",
    `Cells probed per combination: ${rows[0]?.cells ?? 0}. Combinations: ${rows.length}.`,
    "",
    "| Combination | Findings | Oracle expects | Verdict | Exit code |",
    "|---|---|---|---|---|",
    ...lines,
    "",
    TABLE_END,
  ].join("\n");
}

/** Replaces the block between the markers. @throws if the markers are absent */
async function writeReadmeTable(block) {
  const path = new URL(`../${README}`, import.meta.url);
  const text = await readFile(path, "utf8");
  const replaced = replaceBlock(text, block);
  await writeFile(path, replaced, "utf8");
}

/** Returns a description of the discrepancy, or undefined if everything matched. */
async function compareReadmeTable(block) {
  const path = new URL(`../${README}`, import.meta.url);
  const text = await readFile(path, "utf8");
  const current = extractBlock(text);
  if (current === block) {
    return undefined;
  }
  return (
    `the table in ${README} does not match this run. ` +
    `Update it: node polygon/verify.mjs --update-readme`
  );
}

function extractBlock(text) {
  const from = text.indexOf(TABLE_BEGIN);
  const to = text.indexOf(TABLE_END);
  if (from === -1 || to === -1) {
    fail(`${README} has no ${TABLE_BEGIN} / ${TABLE_END} markers around the verification table`);
  }
  return text.slice(from, to + TABLE_END.length);
}

function replaceBlock(text, block) {
  const current = extractBlock(text);
  return text.replace(current, block);
}

async function main() {
  if (!existsSync(CLI)) {
    fail(`${CLI} not found. Build the tool: pnpm run build`);
  }

  const configText = await readFile(CONFIG, "utf8");
  const baseUrl = readBaseUrl(configText);
  if (baseUrl.hostname !== "127.0.0.1") {
    fail(`baseUrl points at ${baseUrl.hostname}; the platform listens on 127.0.0.1 only`);
  }
  const tokenEnvNames = readTokenEnvNames(configText);

  const groundTruth = loadGroundTruth(await readFile(GROUND_TRUTH, "utf8"));
  // Completeness is checked before the run: a defect declared visible and expected
  // in no variant is either a forgotten variant or a wrong visibility mark.
  const gaps = checkCoverage(groundTruth);
  if (gaps.length > 0) {
    fail(`the ground truth is incomplete:\n  ${gaps.join("\n  ")}`);
  }
  const argv = process.argv.slice(2);
  // The reports are a debugging aid, not an artefact: kept only when asked.
  const keepReports = argv.includes("--keep-reports");
  // Checking the table in the README is a modifier of an ordinary run, not a mode of
  // its own: the numbers in the document must come from the same run as the verdict.
  const checkReadme = argv.includes("--check-readme");
  const updateReadme = argv.includes("--update-readme");
  const selected = argv.filter((argument) => !argument.startsWith("--"));
  if ((checkReadme || updateReadme) && selected.length > 0) {
    fail("checking the table requires a full run: drop the combination filter");
  }
  const combinations = groundTruth.variants.filter(
    (combination) => selected.length === 0 || selected.includes(combination.id),
  );
  if (combinations.length === 0) {
    fail(`no combination matched the filter: ${selected.join(", ")}`);
  }

  await assertDryRunSendsNothing(baseUrl);
  await assertReportPathIsCheckedFirst(baseUrl);
  await assertUsageErrorsHaveTheirOwnCode();

  // The tokens are random on every launch: they are not in the files and must not be.
  const tokens = Object.fromEntries(
    tokenEnvNames.map((name) => [name, randomBytes(24).toString("hex")]),
  );
  const reportDir = await mkdtemp(join(tmpdir(), "barbican-polygon-"));

  let mismatched = 0;
  /** The rows for the table in the README: the run writes them, not a human. */
  const rows = [];

  for (const combination of combinations) {
    const flags = Object.fromEntries(
      Object.entries(combination.selector).map(([name, on]) => [name, on ? "1" : "0"]),
    );
    const environment = {
      ...process.env,
      ...tokens,
      ...flags,
      POLYGON_PORT: baseUrl.port,
    };

    const enabled = Object.entries(combination.selector)
      .filter(([, on]) => on)
      .map(([name]) => name);
    process.stdout.write(
      `\n=== ${combination.id} === flags: ${enabled.length === 0 ? "all off" : enabled.join(", ")}\n`,
    );

    const { child, readStderr } = startServer(environment);
    const health = await waitForHealth(baseUrl, child);
    if (health === undefined) {
      await stopServer(child);
      fail(`the platform did not come up on ${baseUrl.origin}:\n${readStderr()}`);
    }

    // A flag might not have arrived — because of a typo in the variable name, say.
    // Then the run would give zero findings and would look like a miss by the tool.
    for (const [name, on] of Object.entries(combination.selector)) {
      const field = FLAG_FIELDS[name];
      if (health.defects?.[field] !== on) {
        await stopServer(child);
        fail(`the platform came up with ${field}=${health.defects?.[field]}, expected ${on}`);
      }
    }

    const reportPath = join(reportDir, `${combination.id}.report.json`);
    const result = await runCli(reportPath, environment, combination.unsafeMethods === true);
    await stopServer(child);

    if (!existsSync(reportPath)) {
      process.stdout.write(
        `  MISMATCH: no report was produced, exit code ${result.code}\n${result.stderr}`,
      );
      mismatched += 1;
      continue;
    }
    const report = JSON.parse(await readFile(reportPath, "utf8"));

    // The comparison and the trustworthiness checks are shared by all polygons
    // (ADR-0012).
    const { problems: shared } = compareVariant(combination, report, result.code);
    const problems = [...shared];
    // Specific to this deployment: it is our own and must answer without failures.
    if (report.summary.failures > 0) {
      problems.push(`failed requests: ${report.summary.failures}`);
    }
    if (report.canariesChecked === 0) {
      problems.push("no canary was checked: authentication is unconfirmed");
    }

    process.stdout.write(
      `  cells probed: ${report.summary.observations}, ` +
        `canaries: ${report.canariesChecked}, ` +
        // `findings` counts the whole list — both matrix discrepancies and findings
        // by body. Adding `checkFindings` to it meant counting the latter twice: 88
        // on the screen against 76 rows in the report. The verification stayed green
        // through all of it, because it compares sets of keys, not numbers.
        `findings: ${report.summary.findings} ` +
        `(of them by body ${report.summary.checkFindings}) ` +
        `(oracle expects ${combination.findings.length})\n`,
    );

    rows.push({
      id: combination.id,
      cells: report.summary.observations,
      findings: report.summary.findings,
      byBody: report.summary.checkFindings,
      expected: combination.findings.length,
      code: result.code,
      matched: problems.length === 0,
    });

    if (problems.length === 0) {
      process.stdout.write(`  MATCHES the ground truth, exit code ${result.code}\n`);
    } else {
      mismatched += 1;
      for (const problem of problems) {
        process.stdout.write(`  MISMATCH: ${problem}\n`);
      }
      process.stdout.write(`  tool output:\n${result.stderr.replace(/^/gm, "    ")}`);
    }
  }

  process.stdout.write(`\nTotal: ${combinations.length} combinations, ${mismatched} mismatches.\n`);

  if (updateReadme) {
    await writeReadmeTable(renderTable(rows));
    process.stdout.write(`\nThe table in ${README} was updated from this run.\n`);
  } else if (checkReadme) {
    const stale = await compareReadmeTable(renderTable(rows));
    if (stale !== undefined) {
      mismatched += 1;
      process.stdout.write(`\nMISMATCH: ${stale}\n`);
    } else {
      process.stdout.write(`\nThe table in ${README} matches this run.\n`);
    }
  }

  /**
   * The reports go with the run unless asked for.
   *
   * They were kept always, and nothing ever removed them: 209 directories and
   * 214 MB had accumulated on the author's machine by the audit of 14 August.
   * On a disposable CI runner that is invisible, which is why it went unnoticed
   * for months. What leaks is exactly the class of file `.gitignore` describes
   * as possibly carrying a customer's personal data — and against a real
   * platform the contents are not synthetic.
   *
   * `--keep-reports` when they are wanted; the path is printed either way.
   */
  if (keepReports) {
    process.stdout.write(`The reports are kept in ${reportDir}\n`);
  } else {
    await rm(reportDir, { recursive: true, force: true });
  }

  process.exitCode = mismatched === 0 ? 0 : 1;
}

await main();

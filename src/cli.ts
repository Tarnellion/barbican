#!/usr/bin/env node

/**
 * The CLI entry point.
 *
 * Security limits are not implemented here, only configured: the mandatory host
 * allowlist, the ban on unsafe methods, throttling and the refusal to follow
 * redirects live in the HTTP client and hold whatever the CLI passes in.
 */

import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, chmod, readFile, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as signalNumbers } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { styleText } from "node:util";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { createCredentialProvider } from "./adapters/credentials.js";
import { createEndpointListParser } from "./adapters/endpoint-list.js";
import type { RunIdentity } from "./adapters/http.js";
import { createHttpClient, runIdentity } from "./adapters/http.js";
import { createOpenApiParser } from "./adapters/openapi.js";
import type { SpecParser } from "./adapters/ports.js";
import { createPostmanCollectionParser } from "./adapters/postman.js";
import { createSignalExtractor } from "./adapters/signals.js";
import type { ThrottleLimits } from "./adapters/throttle.js";
import { createThrottle } from "./adapters/throttle.js";
import type { Check, Endpoint, RunScope, Severity } from "./core/index.js";
import {
  buildAccessMatrix,
  CheckRegistry,
  createIdenticalResponseCheck,
  describeChecks,
  describeMatrix,
  expandPolicy,
  resourceApplies,
  runChecks,
} from "./core/index.js";
import type { RunConfig } from "./io/config.js";
import {
  applyBodySignals,
  assertContextsCannotWrite,
  assertReferencesResolve,
  configJsonSchema,
  parseRunConfig,
  resolveContextValues,
  resolveTokens,
  toAccounts,
} from "./io/config.js";
import { findUnauthenticated } from "./report/authenticity.js";
import type { CanaryOutcome, RunReport } from "./report/build.js";
import { buildReport, runVerdict, WARNINGS } from "./report/build.js";
import type { ObservationStream } from "./report/write.js";
import {
  declarationDigest,
  OBSERVATION_STREAM_FORMAT,
  observationStreamPath,
  openObservationStream,
  readObservationStream,
  reportChunks,
} from "./report/write.js";
import type { CellRecord } from "./runner.js";
import {
  assertCanariesUsable,
  collectObservations,
  planEndpoints,
  probeCanaries,
  UndiscerningCanaryError,
} from "./runner.js";

// The version is read from package.json rather than duplicated in a constant:
// once they drift apart, the duplicate makes the CLI lie about its own version
// in run reports.
//
// `homepage` for the same reason, since 21 August 2026: it goes into the header
// the run names itself with, and the one thing an on-call engineer reading it at
// three in the morning wants is somewhere to go. A URL written out a second time
// here would be the project's address as of whenever this line was last touched.
const requireFromHere = createRequire(import.meta.url);
const { version, homepage } = requireFromHere("../package.json") as {
  readonly version: string;
  readonly homepage: string;
};

function paint(text: string, format: Parameters<typeof styleText>[0]): string {
  // Without a TTY, escape sequences only litter redirected output.
  // The stream is named, and that is the whole fix: `styleText` without it
  // validates `process.stdout`, while the decision above is made on
  // `process.stderr`. In the ordinary invocation — `barbican run -c … > report.json`
  // from a terminal — stderr is a TTY and stdout is not, so every colour this
  // file argues about was dropped on the floor. Found by the audit of
  // 20 August 2026 (H-3, L-4).
  return process.stderr.isTTY === true ? styleText(format, text, { stream: process.stderr }) : text;
}

/**
 * Why an endpoint is not probed, in two lengths.
 *
 * One map and not two: the summary counts the reasons and `--dry-run` explains
 * them one endpoint at a time, and a second list of the same keys goes stale the
 * first time a reason is added — silently, in the half nobody was editing.
 */
const SKIP_REASONS: Readonly<Record<string, { readonly short: string; readonly long: string }>> = {
  "path-parameters": {
    short: "have path parameters",
    long: "has path parameters and no resource declares values for them",
  },
  "unsafe-method": {
    short: "use an unsafe method",
    long: "a write method, and --unsafe-methods was not given",
  },
  excluded: { short: "excluded by hand", long: "named in exclude" },
  "escapes-target": {
    short: "path leaves the target",
    long: "the path leads outside the target address",
  },
};

/** Skips broken down: one number with no reasons reads as 'something was not tested'. */
function skipBreakdown(report: {
  readonly skipped: readonly { readonly reason: string }[];
}): string {
  const counts = new Map<string, number>();
  for (const item of report.skipped) {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  }
  const parts = [...counts].map(
    ([reason, count]) => `${SKIP_REASONS[reason]?.short ?? reason} ${count}`,
  );
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/**
 * The order the screen prints severity levels in, worst first.
 *
 * A `Record<Severity, …>` and not a list of names: both severity lines used to
 * spell out four levels by hand, and `info` — the level a registry check may
 * report — was on neither, while the report counted it and the run's verdict
 * knew about it. A finding existed that the operator's screen said nothing
 * about. A list that misses a level compiles; this table does not, so the next
 * level added to `Severity` cannot reach the report without reaching the screen.
 * Found by the audit of 14 August 2026 (B-16).
 */
const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** One severity line, built from the table above rather than from a list beside it. */
function bySeverityLine(label: string, counts: Readonly<Record<Severity, number>>): string {
  const levels = (Object.keys(SEVERITY_ORDER) as readonly Severity[])
    .slice()
    .sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]);
  return `${label}: ${levels.map((level) => `${level} ${counts[level]}`).join(", ")}`;
}

/**
 * How loudly each warning is said — and that is all this file decides about one.
 *
 * The sentences are `WARNINGS` in the report layer and are printed from there
 * verbatim. They used to be written out a second time here, while the comment on
 * `Report.warnings` claimed the console and the file showed "the same ones, from
 * the same constants": `WARNINGS` did not occur in this file at all, `noCanary`
 * and `nothingRefused` had already drifted apart in wording, and `findingsCapped`
 * reached no screen at any point — a run whose evidence rows were dropped by the
 * cap said so only in the file, while the terminal printed the uncapped row count
 * with nothing to say the file would not hold that many. Found by the adversarial
 * review of 18 August 2026.
 *
 * A `Record` over the keys of `WARNINGS` and not a list, for the reason
 * `SEVERITY_ORDER` above is one: a warning added to the report layer without a
 * colour here does not compile, so it cannot reach the file and miss the screen
 * the way `findingsCapped` did.
 *
 * Green appears nowhere in it. A warning is never good news, and the one thing
 * this screen must not do is make a caveat look like a clearance.
 */
const WARNING_STYLE: Readonly<Record<keyof typeof WARNINGS, "red" | "yellow">> = {
  // Both put every finding on the screen in doubt: one says the run may have
  // been talking to nobody, the other that a refusal was never seen.
  nothingRefused: "red",
  noCanary: "yellow",
  // Both are about reading the artifact afterwards, and neither changes a count
  // or the verdict.
  unnamedTarget: "yellow",
  findingsCapped: "yellow",
  // Yellow and not red: the findings on this screen stand, and what is unproved
  // is everything about the endpoints no request reached. That is a reservation
  // about the reach of the run, which is what yellow says here.
  endpointsNotProbed: "yellow",
};

type WarningKey = keyof typeof WARNINGS;

/** One warning, in its own words and this screen's colour. */
function warningLine(key: WarningKey): string {
  return paint(WARNINGS[key], WARNING_STYLE[key]);
}

/**
 * The same table read by sentence, for the warnings the report hands back as text.
 *
 * `Report.warnings` is a list of strings — it is a JSON document and can be
 * nothing else — so the colour has to be found from the sentence. Built from
 * `WARNING_STYLE` rather than written out again: a second table is the defect
 * this whole change is about.
 */
const WARNING_STYLE_BY_TEXT: ReadonlyMap<string, "red" | "yellow"> = new Map(
  (Object.keys(WARNING_STYLE) as readonly WarningKey[]).map((key) => [
    WARNINGS[key],
    WARNING_STYLE[key],
  ]),
);

/**
 * The headline of the screen, and the one line most readers stop at.
 *
 * It printed `No privilege escalation found` in green whenever
 * `byKind["privilege-escalation"]` was zero. On the polygon with
 * `POLYGON_DEFECT_LIST_NO_FILTER=1` that is a run with twelve cross-tenant leaks:
 * the green line, and four lines below it "Of those, found by body rather than
 * status: 12" — a sentence referring to the ones the green line had just called
 * absent. Literally true, since that counter holds matrix kinds only; and the
 * reader who stopped at the first green line took away the opposite of the run's
 * verdict, which was 1. Found by the adversarial review of 18 August 2026.
 *
 * The count is not deleted and the wording is not hedged into uselessness. The
 * argument is the one L-3 made about `nothingRefused` further down: a real result
 * must not be swallowed by a caveat, and a caveat must not be dressed as a
 * result. What was wrong here was only the second half — the **reassurance**. So:
 *
 * - green on a run that earned it, and only there: nothing found at all, and a
 *   verdict of 0. Not "zero escalations", which is one counter of several, and
 *   not the verdict alone, which is 0 on a run whose findings were all notes.
 * - the same fact in plain words otherwise, with what contradicts it named on the
 *   same line — the row count when something was found, and the run's own exit
 *   code when nothing was found and the run still cannot support the conclusion
 *   (no canary, cut short, credentials gone stale).
 *
 * Yellow and not red for the two: the findings have their own red lines below,
 * and a screen where everything is red says nothing by being red. What yellow
 * says here is "this line does not settle it", which is exactly the defect.
 */
function escalationLine(
  escalations: number,
  summary: { readonly findings: number },
  verdict: { readonly code: number },
  report: {
    readonly warnings: readonly string[];
    readonly coverage: {
      readonly resourcesNotFound: readonly string[];
      readonly notProbed: Readonly<Record<string, number>>;
    };
  },
): string {
  if (escalations > 0) {
    return paint(`Privilege escalation: ${escalations}`, "red");
  }
  const claim = "No privilege escalation found";
  // Five conditions, and the first version had two. Adversarial review of
  // 19 August 2026 built a run where every declared resource answered 404 to
  // everybody: no findings, verdict 0, and the green line printed unqualified
  // over a matrix whose whole isolation half had never been tested — with
  // `nothingRefused` in the report's own warnings, which this file paints red and
  // calls a sentence that puts every finding on the screen in doubt.
  //
  // So the counters are not enough: they say nothing was found, not that anything
  // was looked at. A run earns the bare sentence only when the report itself has
  // no reservation left — no warning, no resource that answered 404 to everyone,
  // and no endpoint the walk never reached.
  //
  // The last of those is the audit of 21 August 2026 (B-4), and the four
  // conditions before it could not see the run it built: eleven endpoints, nine
  // of them templated with no `resources` declared, so the walk covered two. No
  // request went to the nine, so they left no finding to be counted and nothing
  // in `resourcesNotFound` — which is about objects that were asked for and were
  // not there — and the bare green sentence printed over the object half of the
  // surface, where BOLA and IDOR live.
  //
  // `warnings` alone would carry it now that `endpointsNotProbed` exists. The
  // fact is named here as well, in the same shape `resourcesNotFound` already
  // sits in: this list is the screen's own account of what it has a reservation
  // about, and a headline whose only qualification is the report remembering to
  // warn is a headline `warningsFor` can clear by accident.
  const unreserved =
    report.warnings.length === 0 &&
    report.coverage.resourcesNotFound.length === 0 &&
    Object.keys(report.coverage.notProbed).length === 0;
  if (summary.findings === 0 && verdict.code === 0 && unreserved) {
    return paint(claim, "green");
  }
  if (summary.findings > 0) {
    return paint(
      `${claim} — but that is one kind of discrepancy out of several, and this run ` +
        `is not clean: ${summary.findings} finding ` +
        `${summary.findings === 1 ? "row" : "rows"} of other kinds are counted on ` +
        `the lines below.`,
      "yellow",
    );
  }
  // The reason is not repeated here: it is the last line of this same screen, in
  // red, and it is what CI reads. Two copies of one sentence would be the defect
  // above this function in miniature.
  // Nothing found, and the run still cannot support the conclusion. Exit code 0
  // is possible here — a clean walk over resources that were not there — so the
  // sentence names what is unresolved rather than the code alone.
  const unproved =
    Object.keys(report.coverage.notProbed).length > 0
      ? "endpoints no request went to"
      : report.coverage.resourcesNotFound.length > 0
        ? "resources nothing answered for"
        : "a reservation about this run";
  const because =
    verdict.code === 0
      ? `the lines above carry ${unproved}`
      : `this run ends with exit code ${verdict.code}, and the last line says why`;
  return paint(`${claim}, and nothing else either — but nothing was proved: ${because}.`, "yellow");
}

/**
 * The accounts a canary is owed for, by name.
 *
 * An anonymous account — "check that nobody at all can get in here" — has nothing
 * to authenticate, and `runVerdict` excludes it from the rule that ends such a
 * run with exit 2. The same predicate the report calls `!anonymous`, which is
 * `tokenEnv` being set. Asked here so that the screen's warning fires on exactly
 * the runs the file's does: a warning printed under a wider condition than the
 * one it describes is the same disagreement in a subtler form.
 *
 * Names and not a count, because the rule became per account on 19 August: a run
 * where one account of four has a canary is not a run with canaries, and "not one
 * account declares a canary" was false about it while the exit code was still 2.
 * The preview's job is to say which line of the configuration to add.
 */
function accountsOwedACanary(config: RunConfig): readonly string[] {
  return config.accounts
    .filter((account) => account.tokenEnv !== undefined && account.canary === undefined)
    .map((account) => account.id);
}

/**
 * A file named on the command line, read with the flag that named it.
 *
 * `readFile` on a directory throws `EISDIR: illegal operation on a directory,
 * read` — which names neither the path nor the flag, while a run takes up to
 * four of them. The operator is told that one of their paths is wrong and not
 * which. The same shape as `assertReportPathIsWritable` does for `--report`, and
 * for the same reason: this is the last place the flag is still known. Found by
 * the audit of 14 August 2026 (G-10).
 *
 * @throws {Error} with the flag named, because a command line carries several paths
 */
async function readNamedFile(flag: string, path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(
      `${flag} cannot be read from "${path}": ${
        cause instanceof Error ? cause.message : String(cause)
      }. The system error names neither the flag nor the path, and a run takes up ` +
        `to four of them — --config, --spec, --endpoints, --postman — so check the ` +
        `one named here. A path pointing at a directory is the usual cause.`,
    );
  }
}

/**
 * A canary failure that is the run's own doing rather than the platform's.
 *
 * The names come from the client's errors and reach here through
 * `CanaryResult.failure`. Kept apart from a transport failure because the advice
 * is opposite: nothing to check on the deployment, something to change in the
 * invocation.
 */
const TERMINAL_FAILURES: ReadonlySet<string> = new Set([
  "RunBudgetExhaustedError",
  "CircuitOpenError",
]);

/**
 * Whether the report can be written, asked before anything is requested.
 *
 * Found by the audit of 14 August. The write sat 86 lines below the walk, so a
 * typo in `-r` cost the whole run: 152 requests against the deployment, then
 * `ENOENT`, no report on disk, nothing on stdout, and "Run aborted" — which is
 * false besides, since the run had finished and only the file had not. Throttling
 * is deliberately timid because traffic against someone else's system is
 * expensive; spending it twice for a wrong path is the same cost with none of
 * the caution.
 *
 * A check rather than a touch: creating the file here would leave an empty one
 * behind whenever the run stops for any other reason. The race it leaves — the
 * directory disappearing mid-run — is covered where the report is written, by
 * printing it instead of losing it.
 *
 * @throws {Error} with the flag named, because a command line carries several paths
 */
async function assertReportPathIsWritable(path: string): Promise<void> {
  const directory = dirname(resolve(path));
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      throw new Error(`"${directory}" is not a directory`);
    }
    await access(directory, constants.W_OK);
  } catch (cause) {
    throw new Error(
      `--report cannot be written to "${path}": ${
        cause instanceof Error ? cause.message : String(cause)
      }. Checked now rather than after the walk: the report is written at the end, ` +
        `and a path that fails then costs the whole run's traffic against the platform.`,
    );
  }

  const existing = await stat(path).catch(() => undefined);
  if (existing?.isDirectory() === true) {
    throw new Error(
      `--report points at the directory "${path}", not at a file. The report is ` +
        `one JSON document and needs a name to be written under.`,
    );
  }
}

/**
 * The digits an operator typed, and not everything `Number()` is willing to read.
 *
 * A limit is not merely a number here: `--rps` divides a second by it, and
 * `--max-requests` is the ceiling on traffic against somebody else's deployment.
 * Written as `Number(raw)` guarded by `Number.isInteger`, the flags accepted
 * `1e23` — an integer by both tests, and a `minimumGapMs` of 1e-20, which leaves
 * the sliding window admitting every request the instant it arrives. That is the
 * "no limits" mode the project says must not exist (ADR-0005 and the throttle's
 * own comment), reached by a form of writing rather than by a decision.
 * `0x10`, `0b101`, `5.0` and `" 5 "` passed the same way: each a limit the
 * command line did not say and the report then recorded as declared.
 *
 * So what is refused is the **notation**, not the magnitude. Decimal digits, and
 * a value `Number.isSafeInteger` vouches for. No ceiling is invented on top of
 * that: an operator raising a limit deliberately is doing their job, and
 * `--rps 100000` remains theirs to ask for. Above 2^53 the refusal is not about
 * taste either — integers stop being exact there, so the number enforced would
 * not be the number written.
 *
 * Found by the audit of 20 August 2026 (C-4/H-8).
 */
const DECIMAL_DIGITS = /^[0-9]+$/;

function positiveInteger(raw: string): number {
  if (!DECIMAL_DIGITS.test(raw)) {
    throw new InvalidArgumentError(
      "a positive integer in decimal digits is expected. Exponent, hex and binary " +
        "notation, a decimal point and surrounding spaces are refused rather than " +
        "read: Number() turns them into limits nobody typed, and --rps 1e23 is the " +
        "no-limits mode this tool must not have",
    );
  }
  const value = Number(raw);
  // A negative number cannot arrive — the grammar above has no sign — so this is
  // zero, and zero reads as "no limits" exactly the way the throttle refuses it.
  if (value <= 0) {
    throw new InvalidArgumentError(
      "a positive integer is expected: zero is not a limit, it is the absence of " +
        "one, and this tool has no mode without limits",
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new InvalidArgumentError(
      "a positive integer is expected, and this one is past 9007199254740991, " +
        "where integers stop being exact — the limit enforced would not be the " +
        "limit written",
    );
  }
  return value;
}

interface RunFlags {
  readonly config: string;
  readonly spec?: string;
  readonly endpoints?: string;
  readonly postman?: string;
  readonly report?: string;
  readonly unsafeMethods?: boolean;
  readonly dryRun?: boolean;
  /**
   * Whether the run names itself on the wire. On unless `--no-identify` is given.
   *
   * commander fills this in for every run, so the value is never really absent;
   * it is optional here because `describePlan` and the tests build a `RunFlags`
   * by hand, and a default that has to be repeated in three places is a default
   * that will disagree with itself. `flags.identify !== false` is the reading
   * everywhere.
   */
  readonly identify?: boolean;
  readonly checks?: string;
  readonly concurrency?: number;
  readonly rps?: number;
  readonly maxRequests?: number;
  /** Continue the walk the stream beside `--report` was left in the middle of. */
  readonly resume?: boolean;
}

/**
 * What a run would do, printed without touching the platform.
 *
 * Two things sent a cold read of 14 August guessing. The identifiers: with
 * `--spec` they come from `operationId`, and the reader recovered them by
 * running against the platform and reading `endpoints[]` out of the report —
 * a probe of someone else's deployment to answer a question about a local file.
 * And the skips: which endpoints a run will leave alone is a fair question to
 * ask before the run, not after.
 *
 * The plan comes from `planEndpoints`, the same function the run itself uses.
 * A preview computed separately would agree with reality only until one of the
 * two was edited.
 */
function describePlan(
  config: RunConfig,
  endpoints: readonly Endpoint[],
  flags: RunFlags,
  checks: readonly Check[],
  limits: ThrottleLimits | undefined,
  contextValues: Parameters<typeof toAccounts>[1],
  identity: RunIdentity | undefined,
  /** Cells a stream beside `--report` already holds, and which `--resume` will not probe. */
  alreadyWalked: number,
): number {
  const tenantBaseUrls = new Map(
    (config.tenants ?? [])
      .filter((tenant) => tenant.baseUrl !== undefined)
      .map((tenant) => [tenant.id, tenant.baseUrl ?? ""]),
  );
  const { probeable, skipped } = planEndpoints({
    endpoints,
    baseUrl: config.target.baseUrl,
    resources: config.resources,
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
    allowUnsafeMethods: flags.unsafeMethods === true,
    tenantBaseUrls,
  });

  const byId = new Map(skipped.map((entry) => [entry.endpointId, entry.reason]));
  const rows = endpoints.map((endpoint) => {
    const reason = byId.get(endpoint.id);
    const mark =
      reason === undefined
        ? paint("probe", "green")
        : `${paint("skip", "yellow")}: ${SKIP_REASONS[reason]?.long ?? reason}`;
    return `  ${endpoint.id}  (${endpoint.method} ${endpoint.path})  ${mark}`;
  });

  // An endpoint without parameters costs one request; one with parameters, a
  // request per resource that covers them. Counted the way the run counts it —
  // and counted once per endpoint rather than once per account × endpoint.
  //
  // The audit of 14 August measured the difference: at 1600 endpoints, 41
  // accounts and 320 resources the preview made 20 992 000 calls to
  // `resourceApplies` and took 5.48 s, while the real run of the same
  // configuration reached its first request in 0.606 s. A dry run that costs
  // nine times more than starting the thing it previews is not a pre-flight
  // check, and this is the flag people are told to use first on someone else's
  // deployment.
  const cost = new Map<string, number>(
    endpoints.map((endpoint) => [
      endpoint.id,
      Math.max(
        config.resources.filter((resource) => resourceApplies(endpoint, resource)).length,
        1,
      ),
    ]),
  );
  const costOf = (endpoint: Endpoint): number => cost.get(endpoint.id) ?? 1;

  // A row under conditions walks only the endpoints its context names — that is
  // why a context has to name them. An estimate that ignored this overstated the
  // matrix by roughly a factor of two, and a wrong number about traffic is worse
  // on someone else's deployment than no number at all.
  const contextEndpoints = new Map(
    config.contexts.map((context) => [context.id, new Set(context.endpointIds)]),
  );
  const { accounts } = toAccounts(config, contextValues);
  const cells = accounts.reduce((total, account) => {
    const named =
      account.contextId === undefined ? undefined : contextEndpoints.get(account.contextId);
    const reachable =
      named === undefined ? probeable : probeable.filter((one) => named.has(one.id));
    return total + reachable.reduce((sum, endpoint) => sum + costOf(endpoint), 0);
  }, 0);

  const withCanary = config.accounts.filter((account) => account.canary !== undefined).length;
  const withoutCanary = accountsOwedACanary(config);
  const budget = limits?.maxRequests;
  // Twice: the canaries are probed before the walk and again after it
  // (`probeCanaries` is called at both ends). Counting them once made the
  // preview call a ceiling sufficient that stops the second pass — and a run
  // whose authentication is never confirmed a second time reads as clean. The
  // rule this line stands on is three lines below: a number about traffic that
  // ignores the ceiling on traffic is worse than no number.
  //
  // The cells a resumed run will not probe again come off it for the same
  // reason. A preview that counted them would overstate the traffic by exactly
  // the amount the feature exists to save.
  const remaining = Math.max(cells - alreadyWalked, 0);
  const wanted = remaining + withCanary * 3;

  process.stderr.write(
    `${[
      `${paint("Dry run:", "green")} nothing was sent to ${config.target.baseUrl}.`,
      `Target: ${config.target.label ?? paint("unnamed", "yellow")}`,
      `Endpoints (${endpoints.length}):`,
      ...rows,
      `Matrix rows: ${accounts.length} (declared accounts ${config.accounts.length})`,
      `Cells a run would probe: ${remaining}, plus ${withCanary * 3} canary requests ` +
        `(${withCanary} accounts, probed before the walk and again after it, plus ` +
        `one request each with no credentials to show the canary tells them apart)`,
      // What --resume takes off the bill, named rather than left to be worked
      // out from a number that shrank.
      alreadyWalked === 0
        ? undefined
        : `Of the ${cells} cells in this matrix, ${alreadyWalked} are already in the ` +
          `stream and would not be probed again.`,
      // The budget is on the same command line and used to be left out of the
      // arithmetic: the preview promised 144 cells where the run made one
      // request and stopped. A number about traffic that ignores the ceiling on
      // traffic is worse than no number.
      budget !== undefined && wanted > budget
        ? paint(
            `Only ${budget} of those ${wanted} requests fit the budget: the run stops ` +
              `at --max-requests and reports truncated, so the tail of the matrix ` +
              `stays untested. Raise --max-requests or narrow the run.`,
            "yellow",
          )
        : undefined,
      // The most expensive pre-flight defect is the one the pre-flight check does
      // not mention. Without a canary the run cannot confirm it authenticated at
      // all and ends with exit 2 whatever the platform answered — after the whole
      // matrix has been walked.
      withoutCanary.length > 0
        ? paint(
            `No canary is declared for: ${withoutCanary.join(", ")}. The run will walk ` +
              `the whole matrix and then exit 2: nothing would confirm those accounts ` +
              `were authenticated, and every cell walked under one of them would say ` +
              `what an unauthenticated request says. Declare ` +
              `"canary: <endpointId>" on each account that has credentials.`,
            // The same colour the finished run's warning gets. They said the same
            // thing in two colours until 19 August, and a reader who sees red on
            // the preview and yellow on the run reads them as two different
            // conditions.
            WARNING_STYLE.noCanary,
          )
        : undefined,
      // A pipeline that publishes the report after a dry run publishes
      // yesterday's, and nothing said so. The path is still checked — that is
      // G-8 — it is just never written to.
      flags.report === undefined
        ? undefined
        : paint(
            `--report is not written by a dry run: ${flags.report} is left as it was. ` +
              `Anything reading it afterwards reads the previous run.`,
            "yellow",
          ),
      // Which checks will run, because `--checks` can leave one out and a check
      // left out is coverage left out. Named here for the same reason the
      // endpoint list is: the preview has to answer "what exactly will you do"
      // before the first request, not after.
      checks.length === 0
        ? paint("Checks: none will run — nothing will be compared by body.", "yellow")
        : `Checks: ${checks.map((check) => check.id).join(", ")}`,
      // What the platform's access log will hold, before the first line of it
      // exists. "What exactly are you going to touch" and "how will I recognise
      // it in my own records" are the same question asked by the same person,
      // and the second one is answerable here for free.
      identity === undefined
        ? paint(
            `The run will not name itself on the wire: --no-identify was given, so ` +
              `the requests are indistinguishable from an attack in the platform's ` +
              `logs. Agree with the owner how they are to be recognised.`,
            "yellow",
          )
        : `Named on the wire as: ${identity.value} (a fresh run= identifier each ` +
          `run, and the report carries the same one)`,
      `The identifiers above are what policy, resources, contexts and canaries refer to.`,
      // The same filter the run's summary applies twenty lines below. Without it
      // every warning this preview decided not to print left a blank line in the
      // middle of the plan — three of them on an ordinary configuration.
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n")}\n`,
  );

  return 0;
}

/**
 * Writes chunks to a stream, respecting backpressure.
 *
 * `Readable.from` plus `pipeline` rather than a loop of `write()`: the loop has
 * to wait for `drain` itself, and getting that wrong on a 60 MB report means
 * either an unbounded buffer or a truncated file.
 */
async function writeChunks(destination: NodeJS.WritableStream, chunks: Iterable<string>) {
  await pipeline(Readable.from(chunks), destination, { end: destination !== process.stdout });
}

/**
 * The report on disk, written through a temporary file beside it.
 *
 * Two properties, and the second is new because the first made it matter. The
 * file is written in chunks (see `src/report/write.ts`), so it is no longer
 * bounded by the largest string node can hold — and a write spread over time is
 * a write that can be interrupted halfway, which would have left a truncated
 * document where a good report used to be. The rename is atomic, so the path
 * either holds the previous run or this one.
 *
 * 0o600 twice over: on the temporary file, and again on the destination after
 * the rename. `mode` on an open applies to a file being **created**, so a report
 * written a second time into the same path used to keep whatever permissions it
 * had — the audit of 20 August 2026 (L-10). The file carries every request
 * address, every response header and the identifiers of accounts, resources and
 * tenants; the project keeps tokens and bodies out of it by construction and
 * then wrote it world-readable on a shared build agent.
 */
async function writeReportFile(path: string, report: object): Promise<void> {
  const staging = `${path}.partial`;
  // Removed first, then created exclusively. Without `wx` the open follows a
  // symlink sitting at the staging path — the report, with every address and
  // every account identifier in it, lands wherever the link points, and `mode`
  // is ignored because nothing is being created. Unlinking a symlink removes
  // the link and not its target, so the pair is safe where the second half
  // alone is not. An interrupted run leaves a staging file behind, and this is
  // also how the next run gets past it. Found by adversarial review, 21 August
  // 2026 (V-7).
  await rm(staging, { force: true });
  await writeChunks(
    createWriteStream(staging, { encoding: "utf8", flags: "wx", mode: 0o600 }),
    reportChunks(report),
  );
  await rename(staging, path);
  await chmod(path, 0o600);
}

async function run(flags: RunFlags): Promise<number> {
  const configText = await readNamedFile("--config", flags.config);
  const config = parseRunConfig(configText);

  /**
   * The warnings already said before the walk, so the summary does not repeat them.
   *
   * Two of the four are worth more early than late: they are about the run being
   * about to be wasted, and the summary arrives after the traffic has been spent.
   * The other two cannot be known until the report exists. Either way the words
   * are the report's, so this set holds the report's own strings and the summary
   * subtracts it from `report.warnings` — the screen ends up saying everything
   * the file says, once each.
   */
  const saidEarly = new Set<string>();
  const sayEarly = (key: WarningKey): void => {
    saidEarly.add(WARNINGS[key]);
    process.stderr.write(`${warningLine(key)}\n`);
  };

  // A warning, not a refusal: on your own polygon the label is not needed, while
  // on someone else's platform a report without it cannot go into a ticket — it
  // does not name the target.
  if (config.target.label === undefined) {
    sayEarly("unnamedTarget");
  }

  /**
   * Where the report goes when the command line did not say.
   *
   * It goes to stdout, and in the invocation this tool is written for — a step
   * in a pipeline — stdout is the build log: readable by everyone who can see
   * the build, kept for as long as the build is kept, and copied into whatever
   * collects logs. The same document written with `--report` is created `0600`
   * through a staging file, deliberately, because it holds every request
   * address, every account, tenant and resource identifier and a list of the
   * places this platform's authorization does not hold. The stronger of the two
   * paths was the one an operator had to ask for, and nothing anywhere said so.
   *
   * A warning and not a refusal: `barbican run … > report.json` is a legitimate
   * and common way to run this, and so is piping it into `jq`. What is not
   * legitimate is not knowing.
   *
   * Said before the walk for the same reason `assertReportPathIsWritable` is
   * checked there — this is the point at which the answer can still be changed
   * without spending somebody else's traffic twice. Not on `--dry-run`, which
   * produces no report to misplace.
   */
  if (flags.report === undefined && flags.dryRun !== true) {
    process.stderr.write(
      `${paint("The report has nowhere to go but stdout:", "yellow")} no --report was ` +
        `given. On a pipeline that is the build log — every request address, every ` +
        `account and resource identifier, and a map of where this platform's ` +
        `authorization does not hold, kept as long as the build is and readable by ` +
        `everyone who can see it. The same document under --report is written 0600. ` +
        `Redirect it or name a path.\n` +
        // The second half of the same sentence, and the one that costs traffic
        // rather than confidentiality. The stream lives beside the report, so
        // without a path there is nowhere to put it: nothing this walk observes
        // reaches disk until the last response is in, and anything that ends the
        // process before then — Ctrl-C, the OOM killer, a cancelled job — takes
        // every request with it. See ADR-0047.
        `${paint("Nothing is written to disk until the walk is over:", "yellow")} the ` +
        `observation stream lives beside --report, so there is none. A run ` +
        `interrupted or killed leaves no partial report and cannot be resumed — ` +
        `every request it made is spent again.\n`,
    );
  }
  if (flags.resume === true && flags.report === undefined) {
    throw new Error(
      "--resume needs --report: the stream a run is resumed from lives beside the " +
        "report, and without a path there is no stream to continue. Name the same " +
        "--report the interrupted run was given.",
    );
  }

  // Exactly one endpoint source: two would silently diverge, and none would give
  // a report with no findings, indistinguishable from a successful one.
  // The flag travels with the path: below this point only the path is left, and a
  // failure to read it could then name neither.
  const sources = [
    { flag: "--spec", path: flags.spec, create: createOpenApiParser },
    { flag: "--endpoints", path: flags.endpoints, create: createEndpointListParser },
    { flag: "--postman", path: flags.postman, create: createPostmanCollectionParser },
  ].filter(
    (entry): entry is { flag: string; path: string; create: () => SpecParser } =>
      entry.path !== undefined,
  );
  const [source] = sources;
  if (sources.length !== 1 || source === undefined) {
    throw new Error(
      "Give exactly one endpoint source: --spec (OpenAPI), " +
        "--endpoints (a hand-written list) or --postman (a Postman collection).",
    );
  }
  const sourceText = await readNamedFile(source.flag, source.path);
  const parsed = await source.create().parse(sourceText);
  // References are checked after the spec is parsed: before that there are no
  // endpoints yet.
  assertReferencesResolve(config, parsed);
  // The values of the context attributes: literals as they are, references from
  // the environment. Resolved before the method-override check, because what has
  // to be checked is what really goes over the wire, not what is written in the
  // file.
  //
  // And used by `--dry-run` as well, which built its accounts with an empty map:
  // any attribute written as `{ env: NAME }` then threw
  // `MissingContextValueError`, so the dry run refused a configuration the real
  // run executes and named a variable that was set the whole time. The command a
  // reader is told to try first on somebody else's deployment failed and blamed
  // them for it. Found by adversarial review on 17 August 2026.
  const contextValues = resolveContextValues(config, process.env);
  assertContextsCannotWrite(contextValues, { allowUnsafeMethods: flags.unsafeMethods === true });
  // responseMustDifferByTenant is a human's statement of expectation; endpoint
  // sources (a spec, a list, a collection) do not know about it and must not.
  const endpoints = applyBodySignals(parsed, config);
  // Patterns are expanded here, before the matrix is built: a pattern that matched
  // no endpoint must fail at startup instead of dropping the pairs into fallback.
  const policy = expandPolicy(config.policy, endpoints);

  // Before anything is sent: a path that fails at the end costs the whole run.
  if (flags.report !== undefined) {
    await assertReportPathIsWritable(flags.report);
  }

  /**
   * The gate on resuming, and everything that has to be true before a request.
   *
   * A resumed run presents itself as one walk: one `runId`, one `configDigest`,
   * one verdict over cells gathered by two processes. That is only honest while
   * the declaration is the same one, so the digest is compared here — before the
   * canaries, before the walk, before anything is sent. Resuming into a changed
   * declaration and calling the result one run is the worst thing this feature
   * could do, and it is the one thing it refuses outright.
   */
  const streamPath = flags.report === undefined ? undefined : observationStreamPath(flags.report);
  const declaration = declarationDigest({
    version,
    config: configText,
    sourceFlag: source.flag,
    source: sourceText,
    unsafeMethods: flags.unsafeMethods === true,
    identify: flags.identify !== false,
    contextValues,
  });
  let carried: readonly CellRecord[] = [];
  let carriedFrom: { readonly runId: string; readonly startedAt: string } | undefined;
  if (flags.resume === true && streamPath !== undefined) {
    const existing = await stat(streamPath).catch(() => undefined);
    if (existing === undefined) {
      throw new Error(
        `--resume was given and there is no stream at "${streamPath}". A completed run ` +
          `removes it, so either this walk already finished — read the report — or the ` +
          `path is not the one the interrupted run was given. Resuming from nothing ` +
          `would silently spend the whole matrix again, which is the cost this flag ` +
          `exists to avoid.`,
      );
    }
    const stream = await readObservationStream(streamPath);
    if (stream.header.declaration !== declaration) {
      throw new Error(
        `--resume refuses: the declaration has changed since "${streamPath}" was ` +
          `written (${stream.header.declaration} then, ${declaration} now). The ` +
          `configuration, the endpoint document, a value a condition takes from the ` +
          `environment, or --unsafe-methods or --no-identify — one of them is not what ` +
          `it was. Cells walked under one declaration and cells walked under another ` +
          `are not one run, and a report that presented them as one would carry a ` +
          `single digest and a single verdict over both. Start a fresh run, or restore ` +
          `what changed.`,
      );
    }
    if (stream.header.version !== version) {
      throw new Error(
        `--resume refuses: "${streamPath}" was written by barbican ` +
          `${String(stream.header.version)} and this is ${version}. What a status means, ` +
          `which cells exist and how a verdict is reached are all this build's to ` +
          `decide, and half a matrix decided by another build is not a run this one can ` +
          `answer for. Start a fresh run.`,
      );
    }
    carried = stream.records;
    carriedFrom = { runId: stream.header.runId, startedAt: stream.header.startedAt };
    if (Number.isNaN(Date.parse(carriedFrom.startedAt))) {
      throw new Error(
        `The observation stream "${streamPath}" carries no readable start time, and a ` +
          `resumed run reports the start of the walk it continues. Start a fresh run.`,
      );
    }
    process.stderr.write(
      `${paint("Resuming:", "green")} ${carried.length} cells are already in ` +
        `${streamPath} and will not be probed again${
          stream.incomplete ? ", and its last line was half-written — that run was killed" : ""
        }. The report will carry the interrupted run's identifier and start time.\n`,
    );
  }

  /**
   * The run's identifier, minted here rather than by the report.
   *
   * `buildReport` mints one too, and it runs after the last response has come
   * back — the wrong end of a run for a value that has to be on the **first**
   * request. So the CLI decides it before anything is sent and the report
   * carries the CLI's; `buildReport` keeps its own for a consumer of the library
   * assembling a report without having gone through this command. Where a run
   * happened, the identifier the platform saw is the one the artifact is filed
   * under, because a second identifier would let the owner of the target filter
   * the traffic out of their graphs and still not know which report it produced.
   *
   * A resumed run adopts the interrupted one's rather than minting a second.
   * Both halves of the walk then carry one identifier on the wire, and the one
   * report they produce is filed under it — which is the whole of what ADR-0045
   * bought. Two identifiers would leave the owner of the platform with two
   * populations of traffic and one document, and no way to join them.
   *
   * See ADR-0045.
   */
  const runId = carriedFrom?.runId ?? randomUUID();
  const identity = flags.identify === false ? undefined : runIdentity({ version, runId, homepage });

  // The registry is created explicitly and locally: there is no global state in
  // the core (ADR-0003). Assembled here, before the first request, and not next
  // to where the checks run — a typo in `--checks` discovered after the walk is
  // the same waste `--report` used to cost, and a `--dry-run` that says nothing
  // about it is a preview that hides the mistake it exists to surface.
  const registry = new CheckRegistry();
  registry.register(createIdenticalResponseCheck());
  const selected = registry.select(flags.checks);

  // Built here rather than beside the client: the preview needs the limits that
  // will actually be in force, and reading the defaults a second time would be a
  // duplicate that drifts. Pure construction — nothing is sent by making it.
  const throttle = createThrottle({
    ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
    ...(flags.rps === undefined ? {} : { requestsPerSecond: flags.rps }),
    ...(flags.maxRequests === undefined ? {} : { maxRequests: flags.maxRequests }),
  });

  // The canaries, before anything is sent and before the preview claims to have
  // validated everything. One of these on an excluded endpoint used to pass the
  // dry run and stop the real one.
  assertCanariesUsable({
    endpoints,
    canaries: config.accounts.flatMap((account) =>
      account.canary === undefined
        ? []
        : [{ accountId: account.id, endpointId: account.canary, roleId: account.role }],
    ),
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
    // The method check needs the flag, and the flag lives on the command line
    // rather than in the configuration: a canary on `POST /login` is a mistake
    // only while this run refuses write methods. Without it the preview printed
    // the endpoint as skipped for its method and counted three canary requests
    // against it in the same summary, and the run reached the platform's silence
    // for a reason that was never the platform's.
    allowUnsafeMethods: flags.unsafeMethods === true,
    // The last check needs the expanded policy: a canary the policy denies is a
    // contradiction the run would otherwise report as a platform defect.
    policy,
  });

  // Everything above this line is validation and parsing; nothing has reached the
  // network. That is what makes this the honest place to stop and show what a run
  // would do — on someone else's deployment the question "what exactly will you
  // touch" deserves an answer before the first request, not after.
  if (flags.dryRun === true) {
    return describePlan(
      config,
      endpoints,
      flags,
      selected,
      throttle.limits,
      contextValues,
      identity,
      carried.length,
    );
  }

  const credentials = createCredentialProvider(
    config.auth,
    resolveTokens(config, process.env),
    config.accountAuth,
  );

  const client = createHttpClient({
    allowedHosts: config.target.allowedHosts,
    throttle,
    allowUnsafeMethods: flags.unsafeMethods === true,
    // Into the client and not into each request the walk builds: the client is
    // the one seam every request of a run passes through, canaries included.
    ...(identity === undefined ? {} : { identity }),
    ...(config.bodySignals?.maxBodyBytes === undefined
      ? {}
      : {
          signalExtractor: createSignalExtractor({ maxBodyBytes: config.bodySignals.maxBodyBytes }),
        }),
  });

  // Accounts under declared conditions are separate matrix rows. The attributes
  // (headers, query parameters) do not go into the core: the label is enough there.
  const { accounts, attributes: contextAttributes } = toAccounts(config, contextValues);

  // Brands are often spread across subdomains; the address is chosen by the
  // resource's tenant, because what we ask for is someone else's data, and it
  // lives on someone else's host.
  const tenantBaseUrls = new Map(
    (config.tenants ?? [])
      .filter((tenant) => tenant.baseUrl !== undefined)
      .map((tenant) => [tenant.id, tenant.baseUrl ?? ""]),
  );

  const canaries = config.accounts
    .filter((account) => account.canary !== undefined)
    .map((account) => ({ accountId: account.id, endpointId: account.canary ?? "" }));

  let canariesChecked = 0;
  // The report's own type rather than a structural copy: a copy drifts, and a
  // field it has not heard of is dropped in silence.
  let canaryOutcomes: readonly CanaryOutcome[] = [];
  // Said before the walk when **any** credentialed account lacks a canary, not
  // only when the run has none at all: the condition here is the one the verdict
  // will apply, and a warning that fires on less than the verdict does is a
  // warning that lets a run end with an exit code nothing on screen predicted.
  if (accountsOwedACanary(config).length > 0) {
    sayEarly("noCanary");
  }
  if (canaries.length > 0) {
    const results = await probeCanaries({
      baseUrl: config.target.baseUrl,
      endpoints,
      canaries,
      credentials,
      client,
      exclude: config.exclude,
      allowUnsafeMethods: flags.unsafeMethods === true,
      // Canaries check authentication, not conditions: an account under conditions
      // presents the same credentials, so a second pass over it would confirm
      // nothing new while doubling the requests.
      accounts: accounts.filter((account) => account.contextId === undefined),
      tenantBaseUrls,
    });
    canariesChecked = results.length;
    canaryOutcomes = results;
    const broken = results.filter((result) => !result.authenticated);
    if (broken.length > 0) {
      const details = broken
        .map((r) =>
          r.status === 0
            ? `  ${r.accountId}: ${r.endpointId} did not answer (${r.failure ?? "TRANSPORT"})`
            : `  ${r.accountId}: ${r.endpointId} returned ${r.status}`,
        )
        .join("\n");

      // Three different facts, and the message used to name one. A cold read hit
      // a dead port and was told "401 reads as a denial", so it went looking for
      // a stale token; the audit then hit its own `--max-requests` and was told
      // to check the port, while the platform was up and had already answered.
      const stopped = broken.some((r) => TERMINAL_FAILURES.has(r.failure ?? ""));
      const unreachable = broken.some(
        (r) => r.status === 0 && !TERMINAL_FAILURES.has(r.failure ?? ""),
      );
      const refused = broken.some((r) => r.status !== 0);
      const why = [
        stopped
          ? `The run stopped itself before the canaries were through: the request ` +
            `budget ran out, or the circuit breaker tripped on a run of failures. ` +
            `Nothing here is about the platform or the tokens — raise ` +
            `--max-requests, or find out what the platform was answering.`
          : undefined,
        unreachable
          ? `The platform did not answer at all: nothing reached the application, so ` +
            `this says nothing about the tokens. Check the address, the port and that ` +
            `the deployment is up.`
          : undefined,
        refused
          ? `Continuing past a denial is not an option: 401 reads as a denial, and the ` +
            `report would come out clean.`
          : undefined,
      ]
        .filter((line) => line !== undefined)
        .join("\n");

      throw new Error(`The canaries did not pass, the run stopped:\n${details}\n${why}`);
    }

    // A canary that passed, on an endpoint that answers everybody, confirms
    // nothing — and confirming is its whole job. Checked after the failures
    // above, because a canary that did not pass has a more specific thing wrong
    // with it, and before the walk, because the answer does not change once the
    // walk starts and the traffic is somebody else's to pay for.
    const undiscerning = results.find(
      (result) => result.anonymousStatus !== undefined && result.anonymousStatus < 300,
    );
    if (undiscerning !== undefined) {
      throw new UndiscerningCanaryError(
        undiscerning.accountId,
        undiscerning.endpointId,
        undiscerning.anonymousStatus ?? 0,
      );
    }
  }

  // The start of the walk this report is about — the interrupted run's where
  // there is one. A resumed report whose `startedAt` named the second process
  // would put a duration next to observations timed hours before it.
  const startedAt =
    carriedFrom === undefined ? new Date() : new Date(Date.parse(carriedFrom.startedAt));

  /**
   * The walk on disk, opened before the first cell of it.
   *
   * Not before the canaries: a run stopped there has nothing to resume, and a
   * stream holding a header alone is a file the operator did not ask for. After
   * them, and from here on every finished cell is on disk within milliseconds of
   * the response.
   */
  let stream: ObservationStream | undefined;
  if (streamPath !== undefined) {
    const replaced = flags.resume !== true && (await stat(streamPath).catch(() => undefined));
    stream = await openObservationStream(
      streamPath,
      {
        format: OBSERVATION_STREAM_FORMAT,
        tool: "barbican",
        version,
        declaration,
        runId,
        startedAt: startedAt.toISOString(),
      },
      carriedFrom === undefined
        ? []
        : [
            ...carried.map((record) => ({ kind: "cell", ...record })),
            // A note that this file spans more than one process, for whoever
            // reads it afterwards. Ignored on the way back in — only `cell`
            // lines are.
            { kind: "resumed", at: new Date().toISOString(), cells: carried.length },
          ],
    );
    if (replaced !== undefined && replaced !== false) {
      process.stderr.write(
        `${paint("A stream from an earlier run was replaced:", "yellow")} ${streamPath} ` +
          `held ${replaced.size} bytes and --resume was not given, so that run can no ` +
          `longer be continued.\n`,
      );
    }
    process.stderr.write(
      `Streaming the walk to ${streamPath}: a run interrupted or killed leaves a ` +
        `partial report and can be continued with --resume. The file is removed when ` +
        `the walk completes.\n`,
    );
  }

  /**
   * The stop an operator or a scheduler asks for, and what is left on disk after.
   *
   * SIGINT is Ctrl-C — often because the owner of the platform asked for it —
   * and SIGTERM is how CI kills a job that ran past its timeout. Both used to
   * end the process where it stood, and everything the walk had observed went
   * with them: node's default is the right exit status and the wrong amount of
   * work saved.
   *
   * The handler does not change the status. It stops the walk, lets the report
   * be assembled from what was observed, and then re-raises the signal with the
   * default disposition restored — so a shell and a pipeline still see 130 and
   * 143, which is the contract `tests/invariants/cli-surface.test.ts` holds. A
   * second signal is taken as impatience and goes straight through.
   */
  const walking = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interruptedBy !== undefined) {
      void endBySignal(signal, onSignal);
      return;
    }
    interruptedBy = signal;
    process.stderr.write(
      `\n${paint(`Interrupted by ${signal}:`, "red")} the walk stops here. What was ` +
        `observed is being written out, and the report will say the tail was never ` +
        `probed — the absence of findings in it means nothing.\n`,
    );
    walking.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const { observations, skipped, failures, probed, truncated } = await collectObservations({
    baseUrl: config.target.baseUrl,
    endpoints,
    accounts,
    credentials,
    client,
    allowUnsafeMethods: flags.unsafeMethods === true,
    exclude: config.exclude,
    resources: config.resources,
    tenantBaseUrls,
    contextAttributes,
    abort: walking.signal,
    ...(carried.length === 0 ? {} : { resumed: carried }),
    ...(stream === undefined
      ? {}
      : {
          // The stream swallows its own failures: a disk that fills must cost
          // the safety net and not the walk, whose traffic is already spent.
          record: (record: CellRecord) => stream?.append({ kind: "cell", ...record }),
        }),
    // From the throttle's own merge of defaults and flags, so the walk and the
    // limiter cannot end up with two different numbers for the same limit. A
    // port implementation that declares no limits gets a walk of one: the walk
    // must never be the wider of the two.
    ...(throttle.limits === undefined ? {} : { concurrency: throttle.limits.concurrency }),
  });
  const finishedAt = new Date();
  await stream?.close();
  if (stream?.failure !== undefined) {
    process.stderr.write(
      `${paint("The walk could not be streamed to disk:", "yellow")} ${stream.failure}. ` +
        `The run itself was not affected and the report below is complete for what was ` +
        `walked — but ${streamPath ?? "the stream"} is not, so this run cannot be ` +
        `resumed from it.\n`,
    );
  }

  /**
   * The canaries again, now that the walk is over.
   *
   * Checked once at the start, they answer "were we authenticated when we
   * began". A token that dies in the middle turns every remaining cell into a
   * 401, which reads as a denial, agrees with a policy of denial and lands in
   * `cellsMatched` as "tested and agreed". At the conservative default of five
   * requests a second a matrix of any size takes longer than a short-lived token
   * lives, so this is the ordinary case rather than the exotic one.
   *
   * `findUnauthenticated` cannot catch it: it asks whether an account was
   * granted access nowhere, and the first half of the walk succeeded.
   *
   * Skipped when the run was already cut short — the verdict is 2 either way,
   * and the budget that ended the walk would end these requests too.
   */
  const staleCredentials: string[] = [];
  const unverifiedAfterWalk: string[] = [];
  if (canaries.length > 0 && !truncated) {
    const after = await probeCanaries({
      baseUrl: config.target.baseUrl,
      endpoints,
      canaries,
      credentials,
      client,
      exclude: config.exclude,
      allowUnsafeMethods: flags.unsafeMethods === true,
      accounts: accounts.filter((account) => account.contextId === undefined),
      tenantBaseUrls,
      // The control request belongs to the first pass: whether the endpoint
      // distinguishes is a property of the endpoint, and the walk does not change
      // it. Asking again spends a request on somebody else’s platform to learn
      // what is already known.
      controlRequests: false,
    });
    const passedBefore = new Set(
      canaryOutcomes.filter((one) => one.authenticated).map((one) => one.accountId),
    );
    for (const result of after) {
      // A terminal failure is our own ceiling, not a dead token: saying the
      // credentials went stale there would send the reader after the wrong thing.
      // It is not nothing either, and silence here is what the audit of 20 August
      // found: a ceiling of 14 requests, which the preview itself called enough,
      // ate the whole second pass and the run came back 0 with a dead token.
      const stopped = TERMINAL_FAILURES.has(result.failure ?? "");
      if (!passedBefore.has(result.accountId)) {
        continue;
      }
      if (stopped) {
        unverifiedAfterWalk.push(result.accountId);
      } else if (result.status === 0) {
        // Nothing came back at all, so nothing here is about the credentials.
        // The first pass tells these three apart — our own ceiling, a platform
        // that did not answer, a refusal — and the second told only two: a
        // deployment that died after the walk was reported as "the credentials
        // went stale", sending the reader after a token while the stand was
        // down. The walk itself is untouched in that case, which is why this is
        // the same reservation as a ceiling and not a finding about access.
        // Found by adversarial review, 21 August 2026 (V-6).
        unverifiedAfterWalk.push(result.accountId);
      } else if (!result.authenticated) {
        staleCredentials.push(result.accountId);
      }
    }
    if (unverifiedAfterWalk.length > 0) {
      process.stderr.write(
        `${paint("Authentication was not confirmed a second time:", "red")} ` +
          `${unverifiedAfterWalk.join(", ")}. The canaries could not be probed ` +
          `again — the run hit its own ceiling, or the platform stopped answering ` +
          `— so nothing says the tokens still worked at the end of the walk.\n`,
      );
    }
    if (staleCredentials.length > 0) {
      process.stderr.write(
        `${paint("Credentials went stale during the run:", "red")} ${staleCredentials.join(", ")}. ` +
          `Their canary passed before the walk and fails now, so every cell probed ` +
          `after that point recorded a refusal that says nothing about access. The ` +
          `results cannot be trusted.\n`,
      );
    }
  }

  // The matrix is built only from what was probed: a skip is a gap in coverage,
  // not a discrepancy per account. Otherwise one skip gives as many findings as
  // there are accounts.
  const matrix = buildAccessMatrix({
    endpoints: probed,
    accounts,
    resources: config.resources,
    observations,
    ...(config.tenants === undefined ? {} : { tenants: config.tenants }),
  });
  // One walk for both answers: the findings and the verdicts over every cell, the
  // matching ones included. A second pass would diverge, and the report would
  // claim 'tested and agreed' about a cell that landed in the findings.
  // See ADR-0020.
  //
  // One call, and not `describeCells` followed by `diffAccess`: those are two
  // walks, which is what stood here until the audit of 14 August found it — the
  // comment above promising a shared walk while the lines below took two.
  const { cells, diffs: findings } = describeMatrix(matrix, policy);

  // The registry is created explicitly and locally: there is no global state in
  // ADR-0003 speaks of "a registry assembled for a particular run", and there was
  // no way to assemble one: every registered check ran, always. The selection was
  // made above, before the first request. A check stays silent by itself when
  // nothing in the configuration concerns it.
  // Built in the core rather than by a mapping written out here. That mapping
  // named `id` and `standards`, `Check.description` existed all along, and
  // nothing pointed out that the third field had been left behind — so the one
  // sentence in the project saying what a check does never reached the report.
  // Found by the audit of 14 August 2026 (L-8).
  const checksRun = describeChecks(selected);
  // What a run touched and what it did not, so that a check can say "this clause
  // was covered enough" rather than only "here is what I found".
  const scope: RunScope = {
    probedEndpointIds: probed.map((endpoint) => endpoint.id),
    skipped: skipped.map((one) => ({ endpointId: one.endpointId, reason: one.reason })),
    truncated,
  };
  const context = { matrix, scope };
  // Each check reports its own reach. It used to be one function exported from
  // one check and called by name here, with its type imported into the report
  // layer — the arrangement ADR-0003 exists to prevent.
  // The same isolation `runChecks` gives `run`: a `coverage` that throws would
  // otherwise discard a finished walk at the step that only counts what it
  // looked at. Silence here rather than a finding: the finding for a broken
  // check is already made by `runChecks` a few lines below, and saying it twice
  // would print one breakage as two.
  const byCheck = selected.flatMap((check) => {
    try {
      return check.coverage?.(context) ?? [];
    } catch {
      return [];
    }
  });
  // Through `runChecks`, which settles each finding's severity from the check
  // that made it. Calling `run` directly here is what let the severity be
  // declared twice — once on the check and once as a literal inside it.
  const checks = runChecks(selected, context);
  const suspicions = findUnauthenticated(
    accounts,
    observations,
    policy,
    config.resources,
    config.tenants,
  );
  const unauthenticated = suspicions.map((s) => s.accountId);

  const built = buildReport({
    // The same rows the matrix has: a finding refers to an account under
    // conditions, and that account must be in the account list, or the reference
    // dangles.
    accounts,
    version,
    config,
    endpoints,
    probed,
    observations,
    skipped,
    failures,
    unauthenticated,
    canariesChecked,
    staleCredentials,
    unverifiedAfterWalk,
    canaries: canaryOutcomes,
    truncated,
    unsafeMethods: flags.unsafeMethods === true,
    findings,
    policy,
    checks,
    cells,
    checksRun,
    byCheck,
    // As throttling itself resolved them, not as the flags spelled them out: the
    // defaults live in the adapter, and a second source of them in the report
    // would drift silently.
    ...(throttle.limits === undefined ? {} : { throttle: throttle.limits }),
    startedAt,
    finishedAt,
  });

  /**
   * The identifier the platform saw, in the document the platform's owner gets.
   *
   * `buildReport` mints a `runId` of its own, and it has to: a report without
   * one cannot be told from the next report. But it runs at the end of the walk,
   * and the value has to exist before the first request or it cannot be on the
   * wire at all. So the run's own identifier wins here — which is the whole of
   * what makes marking the traffic useful, since a filter in a SIEM has to lead
   * back to *this* file. See ADR-0045.
   */
  const report: RunReport = { ...built, runId };

  let reportWritten = false;
  if (flags.report === undefined) {
    await writeChunks(process.stdout, reportChunks(report));
  } else {
    try {
      await writeReportFile(flags.report, report);
      reportWritten = true;
    } catch (cause) {
      // The path was checked before the first request, so getting here means the
      // directory went away underneath us or the disk filled. The run is already
      // paid for in traffic against someone else's deployment: losing the result
      // now would mean spending it twice.
      //
      // A second generator: the first one was consumed by the attempt above, and
      // a generator does not rewind.
      await writeChunks(process.stdout, reportChunks(report));
      process.stderr.write(
        `${paint("The report could not be written:", "red")} ${
          cause instanceof Error ? cause.message : String(cause)
        }\nIt has been printed to stdout instead — the run is done and its result ` +
          `is not worth losing to a filesystem error.\n`,
      );
    }
  }

  /**
   * The stream outlives only a walk that did not finish.
   *
   * A complete walk has the report, which is the artifact; leaving the stream
   * beside it would be a second copy of the same data, at the same sensitivity,
   * that nobody asked for and nothing would ever delete. An incomplete one keeps
   * it, because it is the only thing that makes the traffic already spent worth
   * anything.
   *
   * The failed-write branch above keeps it too: the report went to stdout, and a
   * pipeline that loses stdout still has this.
   */
  if (streamPath !== undefined && !truncated && reportWritten) {
    await rm(streamPath, { force: true }).catch(() => undefined);
  }

  const { summary } = report;
  const verdict = runVerdict(report);
  const escalations = summary.byKind["privilege-escalation"] ?? 0;
  if (truncated) {
    process.stderr.write(
      `${paint("The run was cut short:", "red")} ${
        interruptedBy === undefined
          ? "the request budget ran out or the circuit breaker tripped"
          : `${interruptedBy} stopped the walk`
      }. The tail of the matrix was never tested — the absence ` +
        `of findings there means nothing.\n${
          streamPath === undefined
            ? `Nothing was streamed to disk, so the cells that were walked cannot be ` +
              `carried into another run: give --report next time.\n`
            : `The ${observations.length} cells that were walked are in ${streamPath}. ` +
              `Continue where this stopped, without spending them again:\n  barbican run ` +
              `--config ${flags.config} --report ${flags.report ?? ""} --resume …\n`
        }`,
    );
  }
  if (unauthenticated.length > 0) {
    process.stderr.write(
      `${paint("No access anywhere:", "red")} ${suspicions
        .map(
          (s) => `${s.accountId} (${s.refused}/${s.expectedAllowed}, mostly ${s.dominantStatus})`,
        )
        .join(", ")}. ` +
        `Not a single endpoint declared accessible opened up — that is a sign of ` +
        `broken credentials or a wrong address, not of policy. The results cannot ` +
        `be trusted.\n`,
    );
  }
  const lines = [
    // Not 'pairs': a cell is the triple 'account × endpoint × resource', and
    // 6×8 ≠ 80. A reader checking the arithmetic decided the report was lying.
    `Cells probed: ${summary.observations} (matrix rows ${summary.accountRows}` +
      (summary.accountRows === summary.accounts
        ? ""
        : `, of them accounts ${summary.accounts} and the same accounts under contexts`) +
      `, endpoints ${summary.endpoints}, resources ${summary.resources})`,
    summary.skipped > 0
      ? `Endpoints not probed: ${summary.skipped}${skipBreakdown(report)}`
      : undefined,
    summary.failures > 0
      ? paint(`Requests that failed: ${summary.failures} (reasons in the report)`, "yellow")
      : undefined,
    // A resource nobody could reach settles nothing about isolation: a 404
    // satisfies a denial whether the object is protected or simply absent. Said
    // out loud, because the cells for it otherwise read as "tested and agreed".
    report.coverage.resourcesNotFound.length > 0
      ? paint(
          `Resources answered 404 to everyone: ${report.coverage.resourcesNotFound.join(", ")}. ` +
            `Their cells say nothing about isolation — a missing object refuses ` +
            `exactly like a protected one.`,
          "yellow",
        )
      : undefined,
    escalationLine(escalations, summary, verdict, report),
    `Other discrepancies: unexpected denials ${summary.byKind["unexpected-denial"] ?? 0}, ` +
      `not observed ${summary.byKind["not-observed"] ?? 0}, ` +
      `probe errors ${summary.byKind["probe-error"] ?? 0}`,
    // Where the reader starts: 17 findings in one list is not a report.
    summary.findings === 0 ? undefined : bySeverityLine("Rows by severity", summary.bySeverity),
    // The same by defects, right next to it. Otherwise 'critical 10' reads as ten
    // problems, while it is one missing filter across ten cells.
    summary.findings === 0
      ? undefined
      : bySeverityLine("Defects by severity", summary.defectsBySeverity),
    // The number of rows tells the size of the matrix, the number of signatures
    // the number of problems. 'At least', not 'exactly': two defects with the same
    // signature are indistinguishable from the outside, and the precision must not
    // be overstated.
    summary.findings === 0
      ? undefined
      : `Distinct defects: at least ${summary.defectGroups} (finding rows ${summary.findings})`,
    // Check findings are named on a line of their own: they were seen by
    // something other than the status, and mixing them with escalation would
    // erase that difference.
    summary.checkFindings > 0
      ? paint(`Of those, found by body rather than status: ${summary.checkFindings}`, "red")
      : undefined,
    // Everything the file warns about, said here in the file's own words and
    // under the file's own conditions — `report.warnings` is the list, not a
    // second set of `if`s over the same numbers. Two of them were already said
    // before the walk and are not repeated.
    //
    // Below the counts rather than among them, which is where `nothingRefused`
    // wanted to be all along: it ends "making every finding above false" and used
    // to be printed above the findings. And it is still not an exit code — a
    // genuinely wide-open platform is the worst finding there is, and hiding it
    // behind "cannot be trusted" would be the opposite mistake. See L-3.
    ...report.warnings
      .filter((text) => !saidEarly.has(text))
      // A sentence with no colour in the table cannot arrive — `WARNING_STYLE` is
      // a total map over the keys of `WARNINGS` — but the lookup is by string and
      // the type system cannot see that, and an unstyled warning must still be
      // printed rather than swallowed.
      .map((text) => paint(text, WARNING_STYLE_BY_TEXT.get(text) ?? "yellow")),
    // What the platform's own records will show this run as. The report has no
    // field for it, so this line is the only account of whether the run
    // announced itself — and the run identifier is worth repeating where the
    // operator is looking, since the report it is also written in may have gone
    // past on stdout.
    identity === undefined
      ? paint(
          "This run did not name itself on the wire: --no-identify was given, and " +
            "the platform's logs cannot tell it from an attack.",
          "yellow",
        )
      : `Named on the wire as: ${identity.value}`,
    flags.report === undefined ? "Report: printed to stdout" : `Report: ${flags.report}`,
    // The last line, and the one CI acts on. Without it the reader is left to
    // reconcile "Distinct defects: at least 1" with a zero exit code by himself,
    // and the honest conclusion from that pair is that the exit code is unreliable.
    paint(`Exit code ${verdict.code}: ${verdict.reason}`, verdict.code === 0 ? "green" : "red"),
  ].filter((line): line is string => line !== undefined);

  process.stderr.write(`${lines.join("\n")}\n`);

  // A run stopped by a signal ends the way a signal ends a process, and the
  // report it now leaves behind does not change that: 130 and 143 are what a
  // shell and a pipeline read, and the verdict's own code would be a different
  // statement in the same field.
  if (interruptedBy !== undefined) {
    return await endBySignal(interruptedBy, onSignal);
  }
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return verdict.code;
}

/**
 * Ends the process the way the signal would have, now that the work is saved.
 *
 * The handler is removed first, which restores the default disposition, and the
 * signal is then sent again — so `child_process` reports `signal: "SIGINT"` and
 * a shell turns that into 130, exactly as it did when nothing here handled the
 * signal at all. `process.exit(130)` would be a different fact in the same
 * field: an exit code says the program decided, a signal says it was stopped.
 *
 * stderr is drained before the raise. It is a pipe under CI and a pipe is
 * written asynchronously, so the summary this run just produced would otherwise
 * be cut off by its own exit.
 *
 * The wait afterwards never returns on any platform this runs on — the kernel
 * delivers a signal a process sends itself before the call comes back. The
 * number below it is the answer if some platform disagrees, and it is the same
 * number a shell would have printed.
 */
async function endBySignal(
  signal: NodeJS.Signals,
  handler: NodeJS.SignalsListener,
): Promise<number> {
  process.off("SIGINT", handler);
  process.off("SIGTERM", handler);
  await new Promise<void>((settle) => {
    process.stderr.write("", () => settle());
  });
  process.kill(process.pid, signal);
  await new Promise<void>((settle) => {
    setTimeout(settle, 1_000);
  });
  return 128 + (signalNumbers.signals[signal] ?? 0);
}

/**
 * A mistake in the command line, not a finding about the platform.
 *
 * commander exits 1 on an unknown option or a missing required one, and 1 is
 * this tool's way of saying "checked, and reality does not match what you
 * declared". So `--unsafe-metods` reported as a privilege escalation, and in CI
 * — the one place the exit code is the whole interface — it reported as one
 * silently: the message goes to stderr, which a pipeline usually does not read
 * when the code already says "failed for a known reason".
 *
 * 64 is `EX_USAGE` from `sysexits.h`: the conventional "the command line was
 * wrong" of Unix CLIs, and outside the 0/1/2 the CI contract uses. Found by the
 * audit of 14 August 2026.
 */
const USAGE_ERROR = 64;

/**
 * The exit code for something commander threw.
 *
 * `--help` and `--version` come through here too — commander treats printing
 * them as an exit — and they are not failures. It marks them with `exitCode: 0`,
 * which is the only thing that separates them from a usage error.
 */
function exitCodeFrom(error: CommanderError): number {
  return error.exitCode === 0 ? 0 : USAGE_ERROR;
}

const program = new Command();

program
  .name("barbican")
  .description("Tests RBAC and tenant isolation in the APIs of multi-tenant platforms")
  .version(version);

program
  .command("run")
  .description("Walk the role × endpoint matrix and compare it with the declared policy")
  .requiredOption("-c, --config <path>", "run configuration (YAML or JSON)")
  .option("-s, --spec <path>", "OpenAPI specification of the API under test")
  .option("-e, --endpoints <path>", "hand-written endpoint list, when there is no spec")
  .option("-p, --postman <path>", "Postman collection v2.1")
  .option("-r, --report <path>", "where to write the JSON report (stdout by default)")
  .option("--checks <ids>", "run only these checks, comma separated (all by default)")
  .option("--unsafe-methods", "allow methods that change state")
  // A negated flag, because the answer is yes by default. The party the marking
  // is for is the owner of the platform, who cannot otherwise tell this run from
  // the intrusion it is shaped like; the party helped by silence is the operator
  // measuring what an unannounced sweep looks like, and that is a deliberate
  // exercise which can say so. The same side the tool takes on write methods and
  // on a mandatory scope. See ADR-0045.
  .option("--no-identify", "do not name the run on the wire (a marked run may be met differently)")
  .option("--dry-run", "print what would be probed and stop, sending nothing")
  // Beside --report rather than taking a path of its own: the stream lives next
  // to the report and is named after it, so a second path here could only ever
  // be a way to point the two at different runs.
  .option("--resume", "continue the walk left in the stream beside --report")
  .option("--concurrency <n>", "concurrent requests", positiveInteger)
  .option("--rps <n>", "requests per second", positiveInteger)
  .option("--max-requests <n>", "per-run request budget", positiveInteger)
  .action(async (flags: RunFlags) => {
    try {
      process.exitCode = await run(flags);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${paint("Run aborted:", "red")} ${message}\n`);
      process.exitCode = 2;
    }
  });

program
  .command("schema")
  .description("Print the JSON Schema of the run configuration")
  .action(() => {
    // stdout, so it can be redirected into a file; everything else the CLI says
    // goes to stderr, and mixing the two would make the redirect produce invalid
    // JSON on the first warning.
    process.stdout.write(`${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  });

// `exitOverride` rather than letting commander call `process.exit()` itself:
// with the report going to stdout by default, a hard exit can truncate a write
// that has not drained. Setting `process.exitCode` lets Node finish and leave
// on its own.
//
// On every command, not only the root: commander does not pass the callback
// down to subcommands, and it is the subcommand that handles `barbican run
// --unsafe-metods` — that is, every usage error that matters here. Set on the
// list rather than in each chain, so a command added later cannot be forgotten.
program.exitOverride();
for (const command of program.commands) {
  command.exitOverride();
}

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = exitCodeFrom(error);
  } else {
    // Nothing else should reach here — the `run` action catches its own — but
    // an escape must not look like a clean run.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${paint("Aborted:", "red")} ${message}\n`);
    process.exitCode = 2;
  }
}

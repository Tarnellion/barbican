#!/usr/bin/env node

/**
 * The CLI entry point.
 *
 * Security limits are not implemented here, only configured: the mandatory host
 * allowlist, the ban on unsafe methods, throttling and the refusal to follow
 * redirects live in the HTTP client and hold whatever the CLI passes in.
 */

import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { styleText } from "node:util";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { createCredentialProvider } from "./adapters/credentials.js";
import { createEndpointListParser } from "./adapters/endpoint-list.js";
import { createHttpClient } from "./adapters/http.js";
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
import type { CanaryOutcome } from "./report/build.js";
import { buildReport, runVerdict } from "./report/build.js";
import {
  assertCanariesUsable,
  collectObservations,
  planEndpoints,
  probeCanaries,
} from "./runner.js";

// The version is read from package.json rather than duplicated in a constant:
// once they drift apart, the duplicate makes the CLI lie about its own version
// in run reports.
const requireFromHere = createRequire(import.meta.url);
const { version } = requireFromHere("../package.json") as { readonly version: string };

function paint(text: string, format: Parameters<typeof styleText>[0]): string {
  // Without a TTY, escape sequences only litter redirected output.
  return process.stderr.isTTY === true ? styleText(format, text) : text;
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

function positiveInteger(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError("a positive integer is expected");
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
  readonly checks?: string;
  readonly concurrency?: number;
  readonly rps?: number;
  readonly maxRequests?: number;
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
  const needCanary = config.accounts.some((account) => account.tokenEnv !== undefined);
  const budget = limits?.maxRequests;
  const wanted = cells + withCanary;

  process.stderr.write(
    `${[
      `${paint("Dry run:", "green")} nothing was sent to ${config.target.baseUrl}.`,
      `Target: ${config.target.label ?? paint("unnamed", "yellow")}`,
      `Endpoints (${endpoints.length}):`,
      ...rows,
      `Matrix rows: ${accounts.length} (declared accounts ${config.accounts.length})`,
      `Cells a run would probe: ${cells}, plus ${withCanary} canary requests`,
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
      withCanary === 0 && needCanary
        ? paint(
            `Not one account declares a canary. The run will walk the whole matrix ` +
              `and then exit 2: nothing would confirm the accounts were ` +
              `authenticated. Declare "canary: <endpointId>" on each account that ` +
              `has credentials.`,
            "red",
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
      `The identifiers above are what policy, resources, contexts and canaries refer to.`,
    ].join("\n")}\n`,
  );

  return 0;
}

async function run(flags: RunFlags): Promise<number> {
  const config = parseRunConfig(await readNamedFile("--config", flags.config));

  // A warning, not a refusal: on your own polygon the label is not needed, while
  // on someone else's platform a report without it cannot go into a ticket — it
  // does not name the target.
  if (config.target.label === undefined) {
    process.stderr.write(
      `${paint("The target is unnamed:", "yellow")} target has no label field. ` +
        `The report will not identify the system under test, and a reader cannot tell ` +
        `a run against a real environment from a run against a demo polygon.\n`,
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
  const parsed = await source.create().parse(await readNamedFile(source.flag, source.path));
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
    // The fourth check needs the expanded policy: a canary the policy denies is a
    // contradiction the run would otherwise report as a platform defect.
    policy,
  });

  // Everything above this line is validation and parsing; nothing has reached the
  // network. That is what makes this the honest place to stop and show what a run
  // would do — on someone else's deployment the question "what exactly will you
  // touch" deserves an answer before the first request, not after.
  if (flags.dryRun === true) {
    return describePlan(config, endpoints, flags, selected, throttle.limits, contextValues);
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
  if (canaries.length === 0) {
    process.stderr.write(
      `${paint("Authentication is unverified:", "yellow")} no account has a canary. ` +
        `If the tokens do not work, the run will report 'no escalations found' having ` +
        `tested nothing. The run will end with exit code 2.\n`,
    );
  } else {
    const results = await probeCanaries({
      baseUrl: config.target.baseUrl,
      endpoints,
      canaries,
      credentials,
      client,
      exclude: config.exclude,
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
  }

  const startedAt = new Date();
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
    // From the throttle's own merge of defaults and flags, so the walk and the
    // limiter cannot end up with two different numbers for the same limit. A
    // port implementation that declares no limits gets a walk of one: the walk
    // must never be the wider of the two.
    ...(throttle.limits === undefined ? {} : { concurrency: throttle.limits.concurrency }),
  });
  const finishedAt = new Date();

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
  if (canaries.length > 0 && !truncated) {
    const after = await probeCanaries({
      baseUrl: config.target.baseUrl,
      endpoints,
      canaries,
      credentials,
      client,
      exclude: config.exclude,
      accounts: accounts.filter((account) => account.contextId === undefined),
      tenantBaseUrls,
    });
    const passedBefore = new Set(
      canaryOutcomes.filter((one) => one.authenticated).map((one) => one.accountId),
    );
    for (const result of after) {
      // A terminal failure is our own ceiling, not a dead token: saying the
      // credentials went stale there would send the reader after the wrong thing.
      const stopped = TERMINAL_FAILURES.has(result.failure ?? "");
      if (passedBefore.has(result.accountId) && !result.authenticated && !stopped) {
        staleCredentials.push(result.accountId);
      }
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
  const byCheck = selected.flatMap((check) => check.coverage?.(context) ?? []);
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

  const report = buildReport({
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

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (flags.report === undefined) {
    process.stdout.write(json);
  } else {
    try {
      // 0o600, not the umask's answer. The file carries every request address,
      // every response header and the identifiers of accounts, resources and
      // tenants. The project keeps tokens and bodies out of it by construction
      // and then wrote it world-readable on a shared build agent.
      await writeFile(flags.report, json, { encoding: "utf8", mode: 0o600 });
    } catch (cause) {
      // The path was checked before the first request, so getting here means the
      // directory went away underneath us or the disk filled. The run is already
      // paid for in traffic against someone else's deployment: losing the result
      // now would mean spending it twice.
      process.stdout.write(json);
      process.stderr.write(
        `${paint("The report could not be written:", "red")} ${
          cause instanceof Error ? cause.message : String(cause)
        }\nIt has been printed to stdout instead — the run is done and its result ` +
          `is not worth losing to a filesystem error.\n`,
      );
    }
  }

  const { summary } = report;
  const verdict = runVerdict(report);
  const escalations = summary.byKind["privilege-escalation"] ?? 0;
  if (truncated) {
    process.stderr.write(
      `${paint("The run was cut short:", "red")} the request budget ran out or the ` +
        `circuit breaker tripped. The tail of the matrix was never tested — the absence ` +
        `of findings there means nothing.\n`,
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
    // Nothing was ever refused. The one question worth asking of a report full
    // of findings, asked by the tool instead of left to the reader: a platform
    // that answers 200 with the outcome in the body reads as "allowed"
    // everywhere, and every cell the policy denies becomes a privilege
    // escalation. Both readings are named because from status codes alone they
    // are the same picture — and both are worth stopping for. Not an exit code:
    // a genuinely wide-open platform is the worst finding there is, and hiding
    // it behind "cannot be trusted" would be the opposite mistake. See L-3.
    report.summary.observations > 0 && report.coverage.outcomes.denied === 0
      ? paint(
          `Not one of the ${report.summary.observations} requests was refused. ` +
            `Either nothing on this platform is protected, or it refuses with 200 ` +
            `and states the outcome in the body — which this tool reads as ` +
            `"allowed" everywhere, making every finding above false. Open one cell ` +
            `you are sure about before believing this report.`,
          "red",
        )
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
    escalations > 0
      ? paint(`Privilege escalation: ${escalations}`, "red")
      : paint("No privilege escalation found", "green"),
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
    flags.report === undefined ? undefined : `Report: ${flags.report}`,
    // The last line, and the one CI acts on. Without it the reader is left to
    // reconcile "Distinct defects: at least 1" with a zero exit code by himself,
    // and the honest conclusion from that pair is that the exit code is unreliable.
    paint(`Exit code ${verdict.code}: ${verdict.reason}`, verdict.code === 0 ? "green" : "red"),
  ].filter((line): line is string => line !== undefined);

  process.stderr.write(`${lines.join("\n")}\n`);
  return verdict.code;
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
  .option("--dry-run", "print what would be probed and stop, sending nothing")
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

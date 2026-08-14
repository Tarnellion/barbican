#!/usr/bin/env node

/**
 * The CLI entry point.
 *
 * Security limits are not implemented here, only configured: the mandatory host
 * allowlist, the ban on unsafe methods, throttling and the refusal to follow
 * redirects live in the HTTP client and hold whatever the CLI passes in.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { styleText } from "node:util";
import { Command, InvalidArgumentError } from "commander";
import { createCredentialProvider } from "./adapters/credentials.js";
import { createEndpointListParser } from "./adapters/endpoint-list.js";
import { createHttpClient } from "./adapters/http.js";
import { createOpenApiParser } from "./adapters/openapi.js";
import type { SpecParser } from "./adapters/ports.js";
import { createPostmanCollectionParser } from "./adapters/postman.js";
import { createSignalExtractor } from "./adapters/signals.js";
import { createThrottle } from "./adapters/throttle.js";
import type { Endpoint } from "./core/index.js";
import {
  buildAccessMatrix,
  CheckRegistry,
  createIdenticalResponseCheck,
  describeBodyComparison,
  describeCells,
  diffAccess,
  expandPolicy,
  resourceApplies,
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
import { collectObservations, planEndpoints, probeCanaries } from "./runner.js";

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
function describePlan(config: RunConfig, endpoints: readonly Endpoint[], flags: RunFlags): number {
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
  // request per resource that covers them. Counted the way the run counts it.
  const costOf = (endpoint: Endpoint): number =>
    Math.max(config.resources.filter((resource) => resourceApplies(endpoint, resource)).length, 1);

  // A row under conditions walks only the endpoints its context names — that is
  // why a context has to name them. An estimate that ignored this overstated the
  // matrix by roughly a factor of two, and a wrong number about traffic is worse
  // on someone else's deployment than no number at all.
  const contextEndpoints = new Map(
    config.contexts.map((context) => [context.id, new Set(context.endpointIds)]),
  );
  const { accounts } = toAccounts(config, new Map());
  const cells = accounts.reduce((total, account) => {
    const named =
      account.contextId === undefined ? undefined : contextEndpoints.get(account.contextId);
    const reachable =
      named === undefined ? probeable : probeable.filter((one) => named.has(one.id));
    return total + reachable.reduce((sum, endpoint) => sum + costOf(endpoint), 0);
  }, 0);

  const withCanary = config.accounts.filter((account) => account.canary !== undefined).length;

  process.stderr.write(
    `${[
      `${paint("Dry run:", "green")} nothing was sent to ${config.target.baseUrl}.`,
      `Target: ${config.target.label ?? paint("unnamed", "yellow")}`,
      `Endpoints (${endpoints.length}):`,
      ...rows,
      `Matrix rows: ${accounts.length} (declared accounts ${config.accounts.length})`,
      `Cells a run would probe: ${cells}, plus ${withCanary} canary requests`,
      `The identifiers above are what policy, resources, contexts and canaries refer to.`,
    ].join("\n")}\n`,
  );

  return 0;
}

async function run(flags: RunFlags): Promise<number> {
  const config = parseRunConfig(await readFile(flags.config, "utf8"));

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
  const sources = [
    { path: flags.spec, create: createOpenApiParser },
    { path: flags.endpoints, create: createEndpointListParser },
    { path: flags.postman, create: createPostmanCollectionParser },
  ].filter(
    (entry): entry is { path: string; create: () => SpecParser } => entry.path !== undefined,
  );
  const [source] = sources;
  if (sources.length !== 1 || source === undefined) {
    throw new Error(
      "Give exactly one endpoint source: --spec (OpenAPI), " +
        "--endpoints (a hand-written list) or --postman (a Postman collection).",
    );
  }
  const parsed = await source.create().parse(await readFile(source.path, "utf8"));
  // References are checked after the spec is parsed: before that there are no
  // endpoints yet.
  assertReferencesResolve(config, parsed);
  // The values of the context attributes: literals as they are, references from
  // the environment. Resolved before the method-override check, because what has
  // to be checked is what really goes over the wire, not what is written in the
  // file.
  const contextValues = resolveContextValues(config, process.env);
  assertContextsCannotWrite(contextValues, { allowUnsafeMethods: flags.unsafeMethods === true });
  // responseMustDifferByTenant is a human's statement of expectation; endpoint
  // sources (a spec, a list, a collection) do not know about it and must not.
  const endpoints = applyBodySignals(parsed, config);
  // Patterns are expanded here, before the matrix is built: a pattern that matched
  // no endpoint must fail at startup instead of dropping the pairs into fallback.
  const policy = expandPolicy(config.policy, endpoints);

  // Everything above this line is validation and parsing; nothing has reached the
  // network. That is what makes this the honest place to stop and show what a run
  // would do — on someone else's deployment the question "what exactly will you
  // touch" deserves an answer before the first request, not after.
  if (flags.dryRun === true) {
    return describePlan(config, endpoints, flags);
  }

  const credentials = createCredentialProvider(
    config.auth,
    resolveTokens(config, process.env),
    config.accountAuth,
  );

  const throttle = createThrottle({
    ...(flags.concurrency === undefined ? {} : { concurrency: flags.concurrency }),
    ...(flags.rps === undefined ? {} : { requestsPerSecond: flags.rps }),
    ...(flags.maxRequests === undefined ? {} : { maxRequests: flags.maxRequests }),
  });

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
  });
  const finishedAt = new Date();

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
  const cells = describeCells(matrix, policy);
  const findings = diffAccess(matrix, policy);

  // The registry is created explicitly and locally: there is no global state in
  // the core (ADR-0003). The check stays silent by itself if no endpoint carries
  // a responseMustDifferByTenant declaration.
  const registry = new CheckRegistry();
  registry.register(createIdenticalResponseCheck());
  const checksRun = registry.list().map((check) => check.id);
  // What the check compared and what it skipped as related. Recomputed next to
  // the check itself: the skip rule is described there, and a duplicate here
  // would drift apart from it.
  const bodyComparison = describeBodyComparison({ matrix });
  const checks = registry.list().flatMap((check) => check.run({ matrix }));
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
    canaries: canaryOutcomes,
    truncated,
    unsafeMethods: flags.unsafeMethods === true,
    findings,
    policy,
    checks,
    cells,
    checksRun,
    bodyComparison,
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
    await writeFile(flags.report, json, "utf8");
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
    escalations > 0
      ? paint(`Privilege escalation: ${escalations}`, "red")
      : paint("No privilege escalation found", "green"),
    `Other discrepancies: unexpected denials ${summary.byKind["unexpected-denial"] ?? 0}, ` +
      `not observed ${summary.byKind["not-observed"] ?? 0}, ` +
      `probe errors ${summary.byKind["probe-error"] ?? 0}`,
    // Where the reader starts: 17 findings in one list is not a report.
    summary.findings === 0
      ? undefined
      : `Rows by severity: critical ${summary.bySeverity.critical}, ` +
        `high ${summary.bySeverity.high}, medium ${summary.bySeverity.medium}, ` +
        `low ${summary.bySeverity.low}`,
    // The same by defects, right next to it. Otherwise 'critical 10' reads as ten
    // problems, while it is one missing filter across ten cells.
    summary.findings === 0
      ? undefined
      : `Defects by severity: critical ${summary.defectsBySeverity.critical}, ` +
        `high ${summary.defectsBySeverity.high}, medium ${summary.defectsBySeverity.medium}, ` +
        `low ${summary.defectsBySeverity.low}`,
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

await program.parseAsync();

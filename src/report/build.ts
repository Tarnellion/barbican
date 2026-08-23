/**
 * Building the report.
 *
 * JSON is the single source of truth (ADR-0002). Human-readable forms are
 * rendered from it in a separate step, not assembled as the run goes.
 *
 * The file was 3 012 lines doing five things, and ADR-0054 cut it into four
 * along the lines the code already drew — `shape.ts` (what a report is),
 * `findings.ts` (the two channels merged, and everything keyed by a cell),
 * `sections.ts` (who took part and what was reached) and `verdict.ts` (what the
 * run concluded), with `canonical.ts` for the serialisation the digests are
 * taken over. What is left here is `buildReport`: the order the four are called
 * in, which is the one thing none of them can state on its own.
 *
 * **This module stays the import path.** Everything the package published from
 * here it still publishes from here, by name, in the block below — so no import
 * anywhere else in the repository, and no import in anybody else's code, had to
 * change. A re-export list rather than `export *`: the four modules export more
 * to each other than the package ever promised a consumer, and `export *` would
 * put every one of those helpers on the surface, where the next release is
 * answerable for it.
 */

import { createHash, randomUUID } from "node:crypto";
import { groupDefects } from "../core/index.js";
import { clauseCoverage } from "../core/standards/coverage.js";
import { canonical, contentDigestOf } from "./canonical.js";
import {
  applyAcceptances,
  capRows,
  countByKind,
  countBySeverity,
  countGroupsBySeverity,
  judgedCells,
  mergeFindings,
  verdictCountsOf,
  withVerdicts,
} from "./findings.js";
import {
  clauseReservationsOf,
  countByContext,
  countByOutcome,
  countByReason,
  documentationUrl,
  namedScheme,
  probedEndpointIds,
  reportedAccount,
  reportedContext,
  reportedTarget,
  resourcesNeverFound,
  withContextAccounts,
} from "./sections.js";
import type { BuildReportOptions, ReportFinding, RunReport } from "./shape.js";
import { REPORT_SCHEMA_VERSION } from "./shape.js";
import type { VerdictInputs } from "./verdict.js";
import { runVerdict, warningsFor } from "./verdict.js";

export type { ContentDigestCheck } from "./canonical.js";
export { checkContentDigest, contentDigestOf } from "./canonical.js";
export { MAX_ROWS_PER_DEFECT } from "./findings.js";
export type {
  AcceptanceCounts,
  AcceptedMark,
  BuildReportOptions,
  CanaryOutcome,
  Coverage,
  ReportedAcceptance,
  ReportedAccount,
  ReportedAuthScheme,
  ReportedContext,
  ReportedObservation,
  ReportFinding,
  ReportSummary,
  RequestRecord,
  RunInputs,
  RunReport,
  RunVerdict,
  VerdictCounts,
} from "./shape.js";
export { REPORT_SCHEMA_VERSION } from "./shape.js";
export type { VerdictInputs } from "./verdict.js";
export { exitCodeFor, runVerdict, WARNINGS } from "./verdict.js";

export function buildReport(options: BuildReportOptions): RunReport {
  // The findings first: a verdict on a cell depends on them, and merging depends
  // on the raw observations rather than on the verdicts, so the order is forced.
  const merged = mergeFindings(
    options.findings,
    options.checks ?? [],
    options.observations,
    options.config.contexts,
    options.checksRun ?? [],
  );
  // Then the acceptances, before anything reads the findings. Everything
  // downstream sees the marked rows: the counters, the defect groups, the cap
  // and the verdict. Applying it later would mean two lists of findings in one
  // function, which is how `match: true` once came to stand on a cell that
  // carried a finding.
  const applied = applyAcceptances(merged, options.config.accepted, options.startedAt);
  const marked = applied.rows;
  const observations = withVerdicts(options, marked);
  const notObserved = options.findings.filter((finding) => finding.kind === "not-observed").length;
  // The other side of a paired finding sits in `evidence`: grouping does not see
  // it, and without it a group names one side of the leak out of two.
  const groups = groupDefects(
    marked
      // A defect group answers "how many distinct breakages of the platform".
      // A run-level finding — "this clause is covered by nothing" — is a
      // statement about the run, not about the platform, and grouping it by a
      // signature made of an endpoint it does not have would be a category
      // error. It still counts in `summary.findings`; what holds is
      // `sum(defects[].violations) + run-level findings === summary.findings`.
      .filter(
        (finding): finding is ReportFinding & { accountId: string; endpointId: string } =>
          finding.accountId !== undefined && finding.endpointId !== undefined,
      )
      .map((finding) => ({
        ...finding,
        // What the group prints as `acceptedKinds`. An expired acceptance does
        // not count: the finding is back in the verdict, and a group marked
        // accepted while it fails the build would be the mark lying.
        accepted: finding.accepted !== undefined && !finding.accepted.expired,
        ...(finding.relatedAccountId === undefined
          ? {}
          : { counterpartAccountId: finding.relatedAccountId }),
      })),
  );
  // After the grouping and before the file: the counts above answer for every
  // finding, the rows below are the evidence and evidence has a budget.
  const capped = capRows(marked);
  // Hoisted out of the literal below, because the clause rows need them while
  // `coverage` is still being written: `clauseReservationsOf` asks the same
  // questions of the accounts and of the surface that the warnings and the
  // verdict ask of the finished report, and it has to ask them of the same
  // values rather than of a second reading.
  const accounts = withContextAccounts(options).map((account) =>
    reportedAccount(account, options.config),
  );
  const canaries = options.canaries ?? [];
  const endpointsTotal = options.endpoints.length;
  const endpointsProbed =
    options.probed?.length ?? options.endpoints.length - options.skipped.length;
  const outcomes = countByOutcome(options.observations);
  const report: VerdictInputs = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: randomUUID(),
    configDigest: createHash("sha256").update(canonical(options.config)).digest("hex").slice(0, 16),
    tool: {
      name: "barbican",
      version: options.version,
      documentation: documentationUrl(options.version),
    },
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    target: reportedTarget(options.config.target),
    accounts,
    endpoints: options.endpoints,
    resources: options.config.resources,
    skipped: options.skipped,
    failures: options.failures,
    unauthenticated: options.unauthenticated,
    canariesChecked: options.canariesChecked,
    canaries,
    staleCredentials: options.staleCredentials ?? [],
    unverifiedAfterWalk: options.unverifiedAfterWalk ?? [],
    truncated: options.truncated,
    observations,
    // The rows, after the per-defect cap. Everything derived from findings —
    // `summary`, `defects`, the cell verdicts on the observations above — was
    // computed from `merged` before this line, so a capped file carries the same
    // verdict, the same counts and the same exit code as an uncapped one.
    findings: capped.rows,
    findingsOmitted: capped.omitted,
    accepted: applied.accepted,
    coverage: {
      endpointsTotal,
      endpointsProbed,
      cellsObserved: options.observations.length,
      cellsNotObserved: notObserved,
      notProbed: countByReason(options.skipped),
      // Declared, probed, **and with a check to ask the question**.
      //
      // The list was built from declarations and the walk and never from whether
      // anything ran, so a run with no checks selected named every declared
      // endpoint as compared while `checksRun` was empty beside it. That is the
      // field lying in the one direction it exists to prevent — its own comment
      // says so, and B-5 closed the other direction on 15 August. Being on this
      // list means the question was asked; with no check registered it was asked
      // nowhere. Found by adversarial review on 17 August 2026.
      bodiesComparedOn: ((probed, asked) =>
        asked
          ? options.endpoints
              .filter(
                (endpoint) =>
                  endpoint.responseMustDifferByTenant === true && probed.has(endpoint.id),
              )
              .map((endpoint) => endpoint.id)
          : [])(probedEndpointIds(options), (options.checksRun ?? []).length > 0),
      writeMethodsProbed: options.unsafeMethods ?? false,
      checksRun: options.checksRun ?? [],
      // Both channels on one list of clauses, with the denominator on every row.
      //
      // `cells` and not the observations, so that the cells nobody asked are in
      // the answer: an evidence pack built from what came back describes the
      // surface the run happened to touch. Absent from the input when the run
      // computed no verdicts, and then no row carries `matrixCells` at all —
      // the same silence `cellsMatched` keeps, and for the same reason.
      clauses: clauseCoverage({
        ...(options.cells === undefined ? {} : { cells: judgedCells(options.cells, observations) }),
        checksRun: options.checksRun ?? [],
        reservations: clauseReservationsOf({
          accounts,
          canaries,
          staleCredentials: options.staleCredentials ?? [],
          unverifiedAfterWalk: options.unverifiedAfterWalk ?? [],
          unauthenticated: options.unauthenticated,
          endpointsProbed,
          endpointsTotal,
          truncated: options.truncated,
          observed: options.observations.length,
          denied: outcomes.denied,
        }),
      }),
      byCheck: options.byCheck ?? [],
      contextsProbed: countByContext(options),
      resourcesNotFound: resourcesNeverFound(options.observations),
      outcomes,
      // Counted from the verdicts themselves, not by subtraction. Subtraction
      // lied: among the discrepancies there are `not-observed` ones that have no
      // observation at all, and the number came out too low. ADR-0020 promises
      // equality with the number of observations that carry `match: true` — now it
      // is one and the same number, not two. Found by adversarial review.
      //
      // The key is absent entirely when no verdicts were computed: a zero would
      // read as 'not a single cell agreed', that is, as a claim about the
      // platform, while what has to be said is 'we did not count this'.
      ...(options.cells === undefined
        ? {}
        : {
            cellsMatched: observations.filter((observation) => observation.match === true).length,
            // Cells, not rows of `findings`. One cell can carry several findings
            // at once — a discrepancy over the status code and a body one — and
            // `summary.findings` counts them separately, so the identity the
            // documentation offered the reader did not hold on any run with more
            // than one channel firing. Counting the cells here means the reader
            // adds two numbers instead of deduplicating a list by three fields.
            cellsWithFindings: observations.filter(
              (observation) => observation.findingKinds !== undefined,
            ).length,
          }),
    },
    inputs: {
      policy: options.policy,
      tenants: options.config.tenants ?? [],
      auth: namedScheme(options.config.auth),
      exclude: options.config.exclude,
      ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
      contexts: options.config.contexts.map(reportedContext),
    },
    defects: groups,
    summary: {
      endpoints: options.endpoints.length,
      accounts: options.config.accounts.length,
      accountRows: (options.accounts ?? options.config.accounts).length,
      resources: options.config.resources.length,
      observations: options.observations.length,
      skipped: options.skipped.length,
      failures: options.failures.length,
      // The length of the common list, not the number of matrix discrepancies.
      // The neighbouring counters already counted everything, and one number out
      // of five differed from the rest by exactly the findings by body. The same
      // class as the earlier bySeverity bug, in the same object — found by a
      // second cold read.
      findings: marked.length,
      byKind: countByKind(marked),
      bySeverity: countBySeverity(marked),
      defectGroups: groups.length,
      defectsBySeverity: countGroupsBySeverity(groups),
      checkFindings: marked.filter((finding) => finding.source === "check").length,
      // From the whole marked list, never from `capped.rows`: this is what the
      // verdict reads, and it is where an acceptance — and only an acceptance —
      // takes a row out. The counters above keep every row, which is what makes
      // `byKind` minus `accepted.byKind` reconcile with this map.
      verdictInputs: verdictCountsOf(marked),
      accepted: applied.counts,
    },
  };

  // Computed last, from the finished report, and put inside it. The alternative
  // was recomputing it in every consumer; the exit code exists precisely because
  // the arithmetic is not obvious from the counters.
  const concluded = {
    ...report,
    verdict: runVerdict(report),
    warnings: warningsFor(report, options.config),
  };
  // And the digest after even that, over everything above it. The verdict and
  // the warnings are the two sentences a reader is most likely to want changed,
  // so a digest taken before them would cover the file except where it matters.
  return { ...concluded, contentDigest: contentDigestOf(concluded) };
}

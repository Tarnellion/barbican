/**
 * The finding list: two channels merged into one, and everything keyed by a cell.
 *
 * Split out of `build.ts` by ADR-0054 along the one line the whole file agrees
 * on — `cellKey`. A matrix discrepancy and a check finding arrive by different
 * routes and are the same statement about the same cell, so merging them,
 * marking the ones an acceptance holds, counting them, capping the evidence, and
 * carrying the result back onto the observations and onto the judged cells are
 * one job done in one order. Splitting that order apart would put `cellKey` on
 * two sides of a seam, and the comment on it records what happens when the key
 * is written in more than one place.
 *
 * What is not here: who took part and what was reached (`sections.ts`), and what
 * the run concluded (`verdict.ts`).
 */

import { standardsForDiff } from "../core/checks/clauses.js";
import type { CheckRun, ResolvedFinding, StandardRef } from "../core/checks/types.js";
import type {
  Acceptance,
  AccessDiff,
  AccessObservation,
  CellVerdict,
  DefectGroup,
  DiffKind,
  Severity,
} from "../core/index.js";
import {
  citableDefectKey,
  defectSignature,
  indexAcceptances,
  isAcceptanceInForce,
  matchingAcceptance,
  SEVERITY_ORDER,
} from "../core/index.js";
import { byCodeUnits } from "../core/order.js";
import type { JudgedCell } from "../core/standards/coverage.js";
import type { RequestContextConfig } from "../io/config.js";
import { lookup, openRecord } from "../io/untrusted.js";
import type {
  AcceptanceCounts,
  BuildReportOptions,
  ReportedAcceptance,
  ReportedObservation,
  ReportFinding,
  RequestRecord,
  VerdictCounts,
} from "./shape.js";
import { nothingLeftUnnamed } from "./shape.js";

const EMPTY_BY_KIND: Readonly<Record<DiffKind, number>> = {
  "privilege-escalation": 0,
  "unexpected-denial": 0,
  "not-observed": 0,
  "probe-error": 0,
};

const EMPTY_BY_SEVERITY: Readonly<Record<Severity, number>> = {
  info: 0,
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
};

/**
 * Counts over **all** findings, check findings included.
 *
 * Only matrix discrepancies used to be counted, and the summary showed high: 5
 * where there were 11. A dashboard built on `bySeverity` lost six findings — among
 * them the most exploitable one: a leak from a list endpoint, visible only by the
 * body. Found by a cold read of the report by someone who did not know the project.
 */
export function countBySeverity(
  findings: readonly ReportFinding[],
): Readonly<Record<Severity, number>> {
  const counts = { ...EMPTY_BY_SEVERITY };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/**
 * Attaches to every finding the request that produced it.
 *
 * Joined on the triple 'account × endpoint × resource' — the same key a cell is
 * identified by everywhere in the project.
 */
/**
 * The key of a matrix cell: account, endpoint, resource.
 *
 * Written out by hand in five places, and the sixth had to agree with all five
 * for a verdict and a finding to meet on the same cell. A separator that cannot
 * occur in an identifier, so that `a|b` and `a` + `|b` are different keys.
 */
function cellKey(of: {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string;
}): string {
  return `${of.accountId}\u0000${of.endpointId}\u0000${of.resourceId ?? ""}`;
}

export function mergeFindings(
  diffs: readonly AccessDiff[],
  checks: readonly ResolvedFinding[],
  observations: readonly AccessObservation[],
  contexts: readonly RequestContextConfig[] = [],
  checksRun: readonly CheckRun[] = [],
): readonly ReportFinding[] {
  // The clauses a check answers for, by its id. Declared on the check since
  // ADR-0003 and read by nothing until L-4.
  const clausesOf = new Map(checksRun.map((check) => [check.id, check.standards]));
  const standardsOf = (checkId: string): readonly StandardRef[] => clausesOf.get(checkId) ?? [];
  // The headers of the declared conditions, keyed by the name of the conditions.
  // A human declared the values in the configuration, and there are no secrets
  // there and cannot be: credentials come only from the environment and never land
  // in the report under any circumstances.
  const headersOf = new Map(
    contexts
      .filter((context) => Object.keys(context.headers).length > 0)
      .map((c) => [c.id, c.headers]),
  );
  const byCell = new Map(observations.map((observation) => [cellKey(observation), observation]));
  function withRequest<
    T extends { accountId?: string; endpointId?: string; resourceId?: string; contextId?: string },
  >(finding: T): T & { request?: RequestRecord } {
    // A run-level finding names no cell, so there is no request to attach and
    // none is invented.
    if (finding.accountId === undefined || finding.endpointId === undefined) {
      return finding;
    }
    const observation = byCell.get(
      cellKey({
        accountId: finding.accountId,
        endpointId: finding.endpointId,
        ...(finding.resourceId === undefined ? {} : { resourceId: finding.resourceId }),
      }),
    );
    if (observation?.url === undefined || observation.method === undefined) {
      return finding;
    }
    // The context attributes are printed next to the address, or else reproducing
    // a finding made under conditions gives the **baseline** case: query
    // parameters are visible in the address, headers are visible nowhere, and the
    // line silently reproduces the wrong thing. Found by a cold read: 43% of the
    // findings were reproduced that way.
    const contextHeaders =
      finding.contextId === undefined ? undefined : headersOf.get(finding.contextId);
    return {
      ...finding,
      request: {
        method: observation.method,
        url: observation.url,
        as: observation.accountId,
        ...(contextHeaders === undefined ? {} : { contextHeaders }),
      },
      status: observation.status,
      // The spread, not `headers: observation.headers`. Since E-8 the field is
      // optional on an observation — nothing in the core reads it — and under
      // `exactOptionalPropertyTypes` an optional field means "absent or a
      // record", never "present and undefined". Writing the second one happens
      // to survive here because the literal has no contextual type to be checked
      // against, and a guarantee that rests on that is not one.
      ...(observation.headers === undefined ? {} : { headers: observation.headers }),
    };
  }

  /** The other side's request in a paired finding, if there was one. */
  function relatedRequestOf(check: ResolvedFinding): { relatedRequest?: RequestRecord } {
    // The field, not `evidence.otherAccountId`. That was a contract between two
    // layers held together by a key name: typed as "some scalar", documented
    // nowhere, and undiscoverable by whoever writes the next check.
    const other = check.relatedAccountId;
    if (other === undefined || check.endpointId === undefined) {
      return {};
    }
    // The whole cell, resource included. A pair is two accounts asking for the
    // **same object**, so the other side's cell differs from this one in the
    // account and in nothing else — and a key that stopped at the endpoint found
    // either nothing at all or whichever other cell of that account happened to
    // share the first two coordinates. The comment on the check mapping below
    // names `withVerdicts` and `withRequest` as the lookups that need the third
    // coordinate; this one was left off that list and off this key. Latent while
    // the only registered check pairs observations that name no resource
    // (`pairsOn` filters on `resourceId === undefined`), which is why it survived
    // ADR-0039. See ADR-0058.
    const observation = byCell.get(
      cellKey({
        accountId: other,
        endpointId: check.endpointId,
        ...(check.resourceId === undefined ? {} : { resourceId: check.resourceId }),
      }),
    );
    if (observation?.url === undefined || observation.method === undefined) {
      return {};
    }
    const contextHeaders =
      check.contextId === undefined ? undefined : headersOf.get(check.contextId);
    return {
      relatedRequest: {
        method: observation.method,
        url: observation.url,
        as: observation.accountId,
        ...(contextHeaders === undefined ? {} : { contextHeaders }),
      },
    };
  }

  const fromMatrix: readonly ReportFinding[] = diffs.map((diff) => {
    // Named field by field, like the check mapping below and for the reason the
    // spread that used to stand here proved.
    //
    // `ReportFinding` does not extend `AccessDiff` — it merges two sources and
    // re-declares what they share — so `{ ...diff }` carried whatever the core
    // put on a discrepancy, declared here or not. `basis` and `ruleIndex` went
    // that way: written on every matrix finding since cell verdicts existed,
    // present in every report, named by this interface nowhere, so a consumer
    // typed against it could not read the two fields `docs/report.md` devotes a
    // section to. A field added to `AccessDiff` tomorrow would publish itself the
    // same way. Found by adversarial review on 17 August 2026.
    //
    // The observation mapping keeps its spread on purpose: `ReportedObservation`
    // **extends** `AccessObservation`, so carrying every field is what that type
    // says it does. A spread is wrong where the target re-declares its fields and
    // right where it inherits them.
    const {
      accountId,
      endpointId,
      contextId,
      resourceId,
      relation,
      expected,
      actual,
      kind,
      basis,
      ruleIndex,
      severity,
      ...unnamed
    } = diff;
    nothingLeftUnnamed(unnamed);
    return withRequest({
      kind,
      source: "matrix" as const,
      severity,
      accountId,
      endpointId,
      // The clauses this discrepancy answers for, from the same declarations the
      // registered checks cite. Never empty, so no conditional spread: the
      // mapping answers for every kind, and a row with no clause on it is the
      // state M-11 was written from. See `standardsForDiff` and ADR-0041.
      standards: standardsForDiff(kind, relation),
      expected,
      ...(actual === undefined ? {} : { actual }),
      ...(contextId === undefined ? {} : { contextId }),
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(relation === undefined ? {} : { relation }),
      ...(basis === undefined ? {} : { basis }),
      ...(ruleIndex === undefined ? {} : { ruleIndex }),
    });
  });

  /**
   * A check finding that names neither an account nor an endpoint is dropped.
   *
   * The `Finding` type makes both optional, and everything downstream — the
   * request, the defect signature, the whole idea of a cell — used to be keyed
   * by them.
   *
   * The comment that used to stand here said such findings "stay visible only
   * through the counter". That was untrue: `summary.checkFindings` counts the
   * list **after** this filter, so they were visible nowhere at all — a
   * critical finding could arrive and the report would say `findings: 0`,
   * `checkFindings: 0`, verdict clean, while `coverage.checksRun` named the
   * check as having run. Found by the audit of 14 August.
   *
   * **The filter is gone as of 15 August.** A run-level finding — "this clause
   * is not covered by anything" — is the natural shape for the evidence pack,
   * and dropping it was never a property of the report but of one line here.
   * What it needed was for everything downstream to stop assuming a cell:
   * `withRequest` has nothing to attach and attaches nothing, the cell verdict
   * skips it, and the defect signature carries `—` in place of the endpoint. The
   * interim counter `coverage.checksWithUnusableFindings` is gone with it: a
   * field that could only ever be empty is its own kind of lie.
   */
  const fromChecks: readonly ReportFinding[] = checks.map((check) => {
    // Every field of the finding named, and the remainder asserted empty. This
    // is the mapping `contextId` was lost by; naming the fields is still right,
    // and what was missing is the compiler noticing the next one that appears.
    // See `nothingLeftUnnamed`.
    const {
      checkId,
      severity,
      title,
      accountId,
      endpointId,
      contextId,
      relatedAccountId,
      resourceId,
      relation,
      evidence,
      ...unnamed
    } = check;
    nothingLeftUnnamed(unnamed);
    const standards = standardsOf(checkId);
    return withRequest({
      kind: checkId,
      source: "check" as const,
      severity,
      // Both absent on a run-level finding, and both stay absent rather than
      // being filled with a placeholder: a reader who sees an endpoint id
      // believes there was a request.
      ...(accountId === undefined ? {} : { accountId }),
      ...(endpointId === undefined ? {} : { endpointId }),
      // The conditions are carried over like everything else. The fields were
      // copied by naming each one, and a new one was silently lost: a check
      // finding made under conditions looked like a baseline one, grouping
      // merged it with the baseline one, and `request` was printed without the
      // attributes. Found by a cold read.
      ...(contextId === undefined ? {} : { contextId }),
      // The third coordinate of the cell, and the relation that goes with it.
      // Absent on a check that judges a whole endpoint, which is every check in
      // the registry today; present the moment one judges an object, and then
      // `withVerdicts`, `withRequest` and `relatedRequestOf` find the
      // observation instead of missing it and printing the cell as agreed. See
      // ADR-0039, and ADR-0058 for the third name on that list — it was the one
      // lookup the coordinate never reached.
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(relation === undefined ? {} : { relation }),
      title,
      // Which clauses this finding answers for. Declared on the check since
      // ADR-0003 and read by nothing until now, so the traceability the plan
      // promises could not be built from a saved report.
      ...(standards.length === 0 ? {} : { standards }),
      ...(relatedAccountId === undefined ? {} : { relatedAccountId }),
      evidence,
      // The second request of the pair. Taken from the observations by the name
      // of the other side: the check knows nothing about transport and stores
      // no addresses.
      ...relatedRequestOf(check),
    });
  });

  // Severity first, then the cell, and the two channels interleave rather than
  // sitting in two blocks. The list used to be every matrix row and then every
  // check row — so a critical leak found by body sat below eighty low-severity
  // discrepancies, and a reader who stopped at the top of the file stopped at
  // the least important thing in it. `defects[]` beside it was sorted by
  // severity all along. Found by the audit of 14 August 2026 (B-9).
  //
  // The tie-breakers are what makes it a **stable** order: two runs of the same
  // matrix have to produce the same file, and severity alone leaves eighty rows
  // free to shuffle.
  //
  // Stable across machines, which is what the sentence above always meant and
  // what these four comparisons did not deliver: they were `localeCompare()`
  // with no locale, so the order came from the `LC_ALL` of whoever ran the tool
  // — `sv_SE` and `en_US` sorted the same rows differently. `MAX_ROWS_PER_DEFECT`
  // cuts the evidence below this line, so the two machines did not merely print
  // one file in two orders: they kept different rows. `byCodeUnits` is the one
  // rule the project compares by; see `src/core/order.ts` for why it is code
  // units and not a pinned locale. Found by the audit of 21 August 2026 (L-2).
  return [...fromMatrix, ...fromChecks].sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return (
      byCodeUnits(left.endpointId ?? "", right.endpointId ?? "") ||
      byCodeUnits(left.accountId ?? "", right.accountId ?? "") ||
      byCodeUnits(left.resourceId ?? "", right.resourceId ?? "") ||
      byCodeUnits(left.kind, right.kind)
    );
  });
}

/**
 * What the `accepted:` declarations did to a list of findings.
 *
 * One pass, because three answers have to agree: the mark on each row, the
 * counters in the summary, and the per-declaration `matched`. Computed
 * separately they would be three walks over one question, which is the shape
 * ADR-0020 made `describeMatrix` out of.
 *
 * The moment is the run's **start** and is passed in rather than read from a
 * clock here: this file is the report layer, and a function that asks the system
 * what time it is cannot be tested against a boundary. One moment for the whole
 * run, too — a walk that crosses midnight must not accept its first half and
 * report its second.
 */
export function applyAcceptances(
  findings: readonly ReportFinding[],
  declared: readonly Acceptance[],
  at: Date,
): {
  readonly rows: readonly ReportFinding[];
  readonly accepted: readonly ReportedAcceptance[];
  readonly counts: AcceptanceCounts;
} {
  const index = indexAcceptances(declared);
  const inForce = new Map(
    declared.map((acceptance) => [acceptance, isAcceptanceInForce(acceptance, at)]),
  );
  const matched = new Map<Acceptance, number>();
  // The same key space as `summary.byKind`, and guarded the same way — see
  // `countByKind`. A check id is a name this tool did not choose.
  const byKind = openRecord<number>();
  let held = 0;
  let expired = 0;

  const rows = findings.map((finding) => {
    // A run-level finding — "this clause is covered by nothing" — has no defect
    // coordinates, so there is nothing for a declaration to name. It is also not
    // the kind of statement an acceptance is for: it is about the run.
    if (finding.endpointId === undefined) {
      return finding;
    }
    const acceptance = matchingAcceptance(
      {
        endpointId: finding.endpointId,
        kind: finding.kind,
        ...(finding.relation === undefined ? {} : { relation: finding.relation }),
        ...(finding.contextId === undefined ? {} : { contextId: finding.contextId }),
      },
      index,
    );
    if (acceptance === undefined) {
      return finding;
    }
    matched.set(acceptance, (matched.get(acceptance) ?? 0) + 1);
    const lapsed = inForce.get(acceptance) !== true;
    if (lapsed) {
      expired += 1;
    } else {
      held += 1;
      byKind[finding.kind] = (lookup(byKind, finding.kind) ?? 0) + 1;
    }
    return {
      ...finding,
      accepted: {
        reason: acceptance.reason,
        until: acceptance.until,
        ...(acceptance.ticket === undefined ? {} : { ticket: acceptance.ticket }),
        expired: lapsed,
      },
    };
  });

  return {
    rows,
    accepted: declared.map((acceptance) => ({
      defect: citableDefectKey(acceptance),
      kind: acceptance.kind,
      reason: acceptance.reason,
      until: acceptance.until,
      ...(acceptance.ticket === undefined ? {} : { ticket: acceptance.ticket }),
      expired: inForce.get(acceptance) !== true,
      matched: matched.get(acceptance) ?? 0,
    })),
    counts: {
      declared: declared.length,
      findings: held,
      expired,
      unused: declared.filter((acceptance) => (matched.get(acceptance) ?? 0) === 0).length,
      byKind,
    },
  };
}

export function countGroupsBySeverity(
  groups: readonly DefectGroup[],
): Readonly<Record<Severity, number>> {
  const counts = { ...EMPTY_BY_SEVERITY };
  for (const group of groups) {
    counts[group.severity] += 1;
  }
  return counts;
}

/**
 * Findings by kind, over a key space the tool does not own.
 *
 * `kind` is a diff kind for a matrix row and a **check id** for the other
 * channel, and a check id comes from whoever registered the check. So this is
 * one of the records ADR-0024 is about: an object literal swallows a key named
 * `__proto__` — the assignment is a no-op and the count silently disappears —
 * and indexing one answers for `constructor`. `openRecord` and `lookup` are the
 * grammar, written once in `src/io/untrusted.ts`.
 *
 * `summary.accepted.byKind` beside it is built the same way, over the same key
 * space. Two records of one kind guarded differently is the shape that rule
 * exists against.
 */
export function countByKind(findings: readonly ReportFinding[]): Readonly<Record<string, number>> {
  const counts = openRecord<number>();
  Object.assign(counts, EMPTY_BY_KIND);
  for (const finding of findings) {
    counts[finding.kind] = (lookup(counts, finding.kind) ?? 0) + 1;
  }
  return counts;
}

/**
 * Puts the verdict next to the observation.
 *
 * An observation used to carry no verdict on principle, and 'it is clean here'
 * existed only as a total: to check a single cell, the reader of the report was
 * rewriting the core in his own language. See ADR-0020.
 */
export function withVerdicts(
  options: BuildReportOptions,
  findings: readonly ReportFinding[],
): readonly ReportedObservation[] {
  const cells = options.cells ?? [];
  if (cells.length === 0) {
    return options.observations;
  }
  const byCell = new Map(cells.map((cell) => [cellKey(cell), cell]));
  // Every kind recorded against the cell, from both channels at once.
  //
  // The walk is not the only thing that judges a cell. A check over response
  // bodies judges it too, and against a declaration made by the same human in the
  // same configuration: `responseMustDifferByTenant` is not a heuristic the tool
  // brought along. A cell where the bodies did not differ has not "agreed with
  // what was declared", whatever the status code was.
  const kindsOf = new Map<string, string[]>();
  for (const finding of findings) {
    // A run-level finding — "this clause is covered by nothing" — names no
    // cell, and a statement about the run cannot narrow the verdict on one.
    //
    // The comment that stood here called this branch unreachable, on the
    // grounds that `mergeFindings` dropped such a finding and counted it under
    // `coverage.checksWithUnusableFindings`. Both stopped being true on
    // 15 August: the filter is gone, the counter is gone, and the finding
    // reaches this loop. Noticed while closing B-12 — the same class as B-12
    // itself, a line about the code that the code stopped agreeing with.
    if (finding.accountId === undefined || finding.endpointId === undefined) {
      continue;
    }
    // Both sides of the finding, not only the one it is filed under.
    //
    // A leak found by body is a statement about a **pair** of cells: alice's
    // response and carol's were the same, and it is carol who received a
    // tenant's data that is not hers. The finding names alice in `accountId` and
    // carol in `relatedAccountId`, and only alice's cell was narrowed — so
    // carol's went into the file as `match: true`, "tested and agreed", and into
    // `coverage.cellsMatched`. On the reference run with every defect on, twelve
    // cells were printed that way.
    //
    // Twelve is the same number `docs/report.md` quotes for the defect ADR-0022
    // closed on 15 August, where the body channel did not reach this field at
    // all. That fix taught the loop to read check findings and left it reading
    // one end of them. Found by adversarial review on 17 August 2026.
    for (const accountId of [finding.accountId, finding.relatedAccountId]) {
      if (accountId === undefined) {
        continue;
      }
      const key = cellKey({
        accountId,
        endpointId: finding.endpointId,
        ...(finding.resourceId === undefined ? {} : { resourceId: finding.resourceId }),
      });
      const kinds = kindsOf.get(key);
      if (kinds === undefined) {
        kindsOf.set(key, [finding.kind]);
      } else if (!kinds.includes(finding.kind)) {
        kinds.push(finding.kind);
      }
    }
  }
  return options.observations.map((observation) => {
    const key = cellKey(observation);
    const cell = byCell.get(key);
    if (cell === undefined) {
      return observation;
    }
    // The verdict's fields named one at a time, and the remainder asserted
    // empty — see `nothingLeftUnnamed`. This mapping is where `basis` was lost.
    const {
      expected,
      basis,
      match,
      relation,
      ruleIndex,
      // Withheld, because the observation this row is built on already carries
      // each of them. `accountId`, `endpointId` and `resourceId` are the key
      // the two were joined on a line above; `contextId` travels on the account
      // the row names; and `actual` is `observation.outcome` under a second
      // name. Printing them again would put one fact in two places on one line,
      // free to disagree.
      accountId: _accountId,
      endpointId: _endpointId,
      resourceId: _resourceId,
      contextId: _contextId,
      actual: _actual,
      ...unnamed
    } = cell;
    nothingLeftUnnamed(unnamed);
    const kinds = kindsOf.get(key);
    return {
      ...observation,
      expected,
      // What declared the expectation. The core has computed it on every cell
      // since the absence of `ruleIndex` proved to be a poor answer, and this
      // mapping named four of the cell's fields and not this one — so on an
      // observation a missing `ruleIndex` was still the whole answer, and it
      // cannot be told from a field the tool failed to fill in. Findings have
      // carried it all along, which is what made the gap invisible: the two
      // halves of `docs/report.md`'s "Which rule gave the verdict" were true of
      // different rows. Found by the audit of 14 August 2026 (B-12).
      basis,
      // The walk's verdict **and** the checks. `match` used to be the walk alone,
      // so a cell could be `match: true` and carry a body finding at the same
      // time: twelve of them did on the reference run. A reader who started from
      // the observation closed it as works-as-designed, and both arithmetic
      // self-checks this report offers came out wrong. Found by the audit of
      // 14 August 2026.
      match: match && kinds === undefined,
      // Why it did not agree, next to the cell itself. Without this a body
      // finding leaves an unexplainable row behind: expectation `allowed`,
      // outcome `allowed`, `match: false`, and nothing on the line saying which
      // channel objected.
      ...(kinds === undefined ? {} : { findingKinds: [...kinds].sort(byCodeUnits) }),
      ...(relation === undefined ? {} : { relation }),
      ...(ruleIndex === undefined ? {} : { ruleIndex }),
    };
  });
}

/**
 * The cells of the matrix, reduced to what a clause row needs of each.
 *
 * From `options.cells` — the walk's own enumeration, which carries a verdict for
 * every cell including the ones no request reached — and **not** from the
 * observations, which have no row for a cell that was never asked. That absence
 * is the single most important number on a clause row: an evidence pack that
 * counts only what came back describes the surface it happened to touch.
 *
 * The narrowed match is taken from the published observations rather than from
 * `cell.match`, so that `upheld` here is the same "tested and agreed" as
 * `coverage.cellsMatched`. The walk is not the only channel that judges a cell:
 * a body check objects to cells the walk agreed with (ADR-0022), and a second
 * reading of `match` in this file would be the two-sources-of-verdict defect
 * `withVerdicts` exists to avoid.
 *
 * An `error` outcome concluded nothing whatever the verdict says about it, and
 * is counted as such before anything else looks at `match`.
 */
export function judgedCells(
  cells: readonly CellVerdict[],
  observations: readonly ReportedObservation[],
): readonly JudgedCell[] {
  const narrowed = new Map(
    observations
      .filter((observation) => observation.match !== undefined)
      .map((observation) => [cellKey(observation), observation.match === true]),
  );
  return cells.map((cell) => {
    const relation = cell.relation === undefined ? {} : { relation: cell.relation };
    if (cell.actual === undefined) {
      return { ...relation, verdict: "not-observed" as const };
    }
    if (cell.actual === "error") {
      return { ...relation, verdict: "probe-error" as const };
    }
    const upheld = narrowed.get(cellKey(cell)) ?? cell.match;
    return { ...relation, verdict: upheld ? ("upheld" as const) : ("breached" as const) };
  });
}

/**
 * How many evidence rows one defect may put in the file.
 *
 * The isolation check compares accounts pairwise, so on an endpoint that leaks
 * to everybody it produces one row per pair: quadratic in accounts, while the
 * one guard that bounds a run — `--max-requests`, 2000 by default — is linear in
 * them. Measured on 17 August 2026: 100 accounts on a single endpoint give 4 950
 * rows and a 1.65 MB file, 200 give 19 900 and 6.6 MB, and 2 000 accounts — one
 * request each, exactly the default budget — give 1 999 000 rows, at which point
 * `JSON.stringify` throws `RangeError: Invalid string length` and the whole run
 * is lost at its last step, to an error that names a string length rather than
 * anything the operator did.
 *
 * Those rows are also redundant, which is what makes a cap the right answer
 * rather than a compromise: the report already collapses all 4 950 of them into
 * **one** defect group, and the counts, the severities and the exit code are all
 * computed before this cap applies. What a reader loses is the 51st example of a
 * thing they have 50 examples of.
 *
 * Per defect and not over the whole list — see `defectSignature`. A first-N cap
 * over the flat list would let the endpoint that leaks to two thousand accounts
 * spend the whole budget and leave a rarer defect with no evidence at all, and
 * the rare one is the interesting one.
 *
 * **Fifty rather than a larger number** because the many-defects case is what
 * actually bounds a file, and it was measured too: 200 endpoints all leaking to
 * 50 accounts produce 245 000 rows across 200 defects, which is 4.5 MB at fifty
 * rows each and 13.9 MB at two hundred. With a single defect the constant barely
 * shows — 0.55 MB against 0.60 MB, because the observations dominate — so fifty
 * costs nothing where it does not matter and three times less where it does.
 * Fifty examples is also far past what anybody reads to see a pattern.
 *
 * Found by measuring for I-5 and I-6 on 17 August 2026; the audit of 14 August
 * had both as "nothing to measure against until somebody runs it at that size".
 * See ADR-0029.
 */
export const MAX_ROWS_PER_DEFECT = 50;

/**
 * Keeps at most `MAX_ROWS_PER_DEFECT` rows per defect, in the order they came.
 *
 * A finding that names no cell is always kept: it is a statement about the run
 * rather than about the platform, it has no defect signature to be capped
 * within, and there is one of each.
 */
export function capRows(findings: readonly ReportFinding[]): {
  readonly rows: readonly ReportFinding[];
  readonly omitted: number;
} {
  const seen = new Map<string, number>();
  const rows: ReportFinding[] = [];
  let omitted = 0;

  for (const finding of findings) {
    if (finding.accountId === undefined || finding.endpointId === undefined) {
      rows.push(finding);
      continue;
    }
    // The defect's signature **and the kind**. Since ADR-0030 the signature no
    // longer carries the kind, so one budget of fifty was shared by every kind on
    // an endpoint and the heavier one — findings are sorted by severity — spent
    // it first: a defect with three `unexpected-denial` rows arrived in the file
    // with none of them, under a warning promising that "each defect keeps its
    // own examples". Two changes of the same day, and the interaction was in
    // neither. Found by adversarial review on 17 August 2026.
    //
    // The three coordinates and nothing else. `defectSignature` reads exactly
    // them; the account and the severity were passed because the parameter used
    // to demand a whole finding, and it asks for `DefectCoordinates` since
    // ADR-0048 — the same shape an acceptance is written against.
    const signature = `${finding.kind}\u0000${defectSignature({
      endpointId: finding.endpointId,
      ...(finding.relation === undefined ? {} : { relation: finding.relation }),
      ...(finding.contextId === undefined ? {} : { contextId: finding.contextId }),
    })}`;
    const kept = seen.get(signature) ?? 0;
    if (kept >= MAX_ROWS_PER_DEFECT) {
      omitted += 1;
      continue;
    }
    seen.set(signature, kept + 1);
    rows.push(finding);
  }

  return { rows, omitted };
}

/**
 * The counts a verdict is made of, from the full set of findings.
 *
 * Separated by source here, where the source is known, so that `runVerdict` need
 * not filter rows that may have been capped — and need not read `byKind`, whose
 * one key space would let a check named after a matrix kind be counted as one.
 */
export function verdictCountsOf(findings: readonly ReportFinding[]): VerdictCounts {
  const matrixByKind: Record<DiffKind, number> = {
    "privilege-escalation": 0,
    "unexpected-denial": 0,
    "not-observed": 0,
    "probe-error": 0,
  };
  let failingCheckFindings = 0;

  for (const finding of findings) {
    // A finding an acceptance holds is out of the verdict and nowhere else: it
    // keeps its row, its severity, its place in `byKind` and its defect group.
    // An **expired** acceptance is not this — `expired` on the mark means the
    // day has passed, and the row counts again, which is the whole difference
    // between a deadline and a silencer. See ADR-0048.
    if (finding.accepted !== undefined && !finding.accepted.expired) {
      continue;
    }
    if (finding.source === "matrix") {
      matrixByKind[finding.kind as DiffKind] += 1;
    } else if (finding.severity !== "info") {
      failingCheckFindings += 1;
    }
  }

  return { matrixByKind, failingCheckFindings };
}

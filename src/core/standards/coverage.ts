/**
 * What a run can say about a clause when nothing went wrong under it.
 *
 * `coverage.checksRun` names the clauses a registered check answers for **even
 * when it found nothing** — that is the clause-to-coverage direction, and it is
 * what separates an evidence pack from a list of findings. The matrix channel
 * never had such a list. A clause exercised across nine hundred agreeing cells
 * reached a pack only if one of them broke, so the pack could say "here is what
 * failed under 8.2.2" and not "8.2.2 was exercised across the surface and
 * holds". ADR-0041 recorded that as a consequence it was not paying for on the
 * day; this module is the payment. See ADR-0052.
 *
 * ## The danger this module is built around
 *
 * It is the same class as a falsely clean run, and it is worse than saying
 * nothing: **claiming a clause exercised where the tool could not structurally
 * see anything.** A cell nobody asked. An endpoint skipped as an unsafe method
 * or for want of a resource to substitute into its template. A request that
 * failed. A platform that answers `200` with the refusal in the body, where
 * every conclusion the tool drew is about a document it cannot read.
 *
 * So the shape is built the other way round from a coverage percentage. Nothing
 * here is a ratio. Every row carries the cells that concluded **and** the cells
 * that did not, by reason, so the denominator is on the row rather than in the
 * reader's head; and every row carries the run-level reservations that make
 * "exercised" fall short of "holds across the surface".
 *
 * ## Two things deliberately not here
 *
 * **A clause the catalogue holds and this run never touched.** That question is
 * `findUnansweredClauses` next door, and it is a different one: it is answered
 * against a catalogue, and it is a statement about what the tool was asked to
 * cover rather than about what a run reached. Rows here come only from what
 * actually cited a clause during the run.
 *
 * **A denominator for the check channel.** A row that a check reached names the
 * check and stops. What that check examined is in `coverage.byCheck`, in the
 * check's own terms and its own counters (ADR-0025); inventing a cell count for
 * it here would be this record making a claim it cannot support.
 */

import { controlClausesForCell } from "../checks/clauses.js";
import type { CheckRun, StandardRef } from "../checks/types.js";
import { byCodeUnits } from "../order.js";
import type { ResourceRelation } from "../types.js";

/**
 * The ways a cell of the matrix concluded nothing.
 *
 * A closed vocabulary rather than free text, because these are keys of a record
 * a machine reads and a reader counts on. Every one of them is present on every
 * row, a zero included: a missing key would have to be read as a zero by
 * whoever thought to look for it, which is the reasoning `coverage.outcomes`
 * already stands on.
 */
export const INCONCLUSIVE_REASONS = ["not-observed", "probe-error"] as const;

export type InconclusiveReason = (typeof INCONCLUSIVE_REASONS)[number];

/**
 * Why the numbers on a row fall short of "the clause holds across the surface".
 *
 * Codes and not sentences, for the reason `CanaryOutcome.failure` is a code: a
 * bounded vocabulary travels into a pack, a table and a filter, and cannot
 * carry anything it was not meant to. What each one means is in
 * `docs/report.md`.
 */
export const CLAUSE_RESERVATIONS = [
  /**
   * Some account's credentials were never proved: no canary passed for it, its
   * token went stale during the walk, the second confirmation never happened,
   * or it was granted access nowhere at all. Every refusal recorded under such
   * an account says what an unauthenticated request says, so a cell that
   * "upheld" a denial upheld nothing.
   */
  "authentication-unproved",
  /** Fewer endpoints were probed than the source gave. The clause was not asked there. */
  "endpoints-not-probed",
  /**
   * Not one observation came back denied. Either the platform grants everything
   * or it refuses with `200` and the outcome in the body; from status codes
   * alone the two are the same picture, and in the second case the tool is
   * reading a document it cannot read. See `coverage.outcomes` and L-3.
   */
  "no-refusal-observed",
  /** The walk was cut short, so the tail of the matrix was never reached. */
  "run-truncated",
] as const;

export type ClauseReservation = (typeof CLAUSE_RESERVATIONS)[number];

/**
 * One cell of the matrix, reduced to the two things a clause row needs of it.
 *
 * Shaped here rather than taken from the report layer, because a check is core
 * and so is this: the core does not import from `src/report/`. The caller maps
 * its cell verdicts onto this, which is also where the **narrowed** match comes
 * from — a cell the walk agreed with and a body check objected to is not upheld,
 * and only the report knows both channels (ADR-0022).
 */
export interface JudgedCell {
  /** Absent when the cell names no resource — that is the function-level case. */
  readonly relation?: ResourceRelation;
  readonly verdict: "upheld" | "breached" | InconclusiveReason;
}

/** What the matrix channel reached under one clause, with its denominator. */
export interface ClauseCells {
  /**
   * Cells where the clause's question was asked and an answer came back. The
   * number "exercised" means, and the only one of these that may be read as
   * evidence about the platform.
   */
  readonly conclusive: number;
  /** Of those, the cells where the platform and the declaration agreed. */
  readonly upheld: number;
  /** Of those, the cells where they did not. */
  readonly breached: number;
  /**
   * Cells the clause is about where nothing was concluded, by reason.
   *
   * The other half of the denominator: `conclusive` plus these is the whole
   * reach of the clause in this run.
   */
  readonly inconclusive: Readonly<Record<InconclusiveReason, number>>;
}

/** One clause, and what this run did about it. */
export interface ClauseCoverage {
  readonly standard: string;
  readonly clause: string;
  /**
   * The registered checks that answer for this clause and ran, including the
   * ones that found nothing. What each of them examined is `coverage.byCheck`.
   */
  readonly checkIds: readonly string[];
  /**
   * The matrix channel's reach. Absent where the matrix does not reach this
   * clause at all — a defect class a check cites, or a run whose cell verdicts
   * were never computed. Absent rather than zeroed, for the reason
   * `coverage.cellsMatched` is absent on such a run: a zero is a claim about the
   * platform where what has to be said is "we did not count this".
   */
  readonly matrixCells?: ClauseCells;
  /**
   * Why "exercised" is not "holds across the surface".
   *
   * Repeated on every row rather than stated once in the file, for the reason
   * `UnansweredClause` carries its own reason on every row: a row is what
   * gets pulled out of a report and into a pack about one clause, and a
   * qualification left behind in another section is one that did not travel with
   * the claim.
   */
  readonly reservations: readonly ClauseReservation[];
}

/** The zeroed record, with every reason present. */
function noReasons(): Record<InconclusiveReason, number> {
  const counts = {} as Record<InconclusiveReason, number>;
  for (const reason of INCONCLUSIVE_REASONS) {
    counts[reason] = 0;
  }
  return counts;
}

interface Row {
  readonly checkIds: Set<string>;
  cells?: {
    conclusive: number;
    upheld: number;
    breached: number;
    readonly inconclusive: Record<InconclusiveReason, number>;
  };
}

/**
 * What this run did about every clause either channel reached.
 *
 * Rows are keyed by a standard and a clause held apart rather than glued into
 * one string, the same way `findUnansweredClauses` keys its answer set: a
 * separator would be a character both halves may legally contain, and that is
 * the collision `defectSignature` was caught by. Nothing is joined, so nothing
 * can collide.
 *
 * The order is by standard and then by clause, through `byCodeUnits`: two runs
 * of one matrix have to produce the same file on every machine (ADR-0036), and
 * the order a check happened to be registered in is not a property of the
 * platform.
 */
export function clauseCoverage(input: {
  /**
   * The cells of the matrix, every one of them — the ones that concluded and the
   * ones that did not. Omitted where the run computed no verdicts.
   */
  readonly cells?: readonly JudgedCell[];
  /** The checks that ran, the ones that found nothing included. */
  readonly checksRun?: readonly CheckRun[];
  readonly reservations?: readonly ClauseReservation[];
}): readonly ClauseCoverage[] {
  const rows = new Map<string, Map<string, Row>>();

  function rowFor(ref: StandardRef): Row {
    const clauses = rows.get(ref.standard) ?? new Map<string, Row>();
    rows.set(ref.standard, clauses);
    const row = clauses.get(ref.clause) ?? { checkIds: new Set<string>() };
    clauses.set(ref.clause, row);
    return row;
  }

  for (const cell of input.cells ?? []) {
    for (const ref of controlClausesForCell(cell.relation)) {
      const row = rowFor(ref);
      const counts = row.cells ?? {
        conclusive: 0,
        upheld: 0,
        breached: 0,
        inconclusive: noReasons(),
      };
      row.cells = counts;
      if (cell.verdict === "upheld" || cell.verdict === "breached") {
        counts.conclusive += 1;
        counts[cell.verdict] += 1;
      } else {
        counts.inconclusive[cell.verdict] += 1;
      }
    }
  }

  for (const check of input.checksRun ?? []) {
    for (const ref of check.standards) {
      rowFor(ref).checkIds.add(check.id);
    }
  }

  const reservations = [...(input.reservations ?? [])].sort(byCodeUnits);
  const coverage: ClauseCoverage[] = [];
  // Over the entries rather than the keys, so that neither a `??` nor a cast
  // stands between a key and the row it certainly has. A defensive branch here
  // would be one nothing can reach and nothing can test.
  const byStandard = [...rows.entries()].sort(([left], [right]) => byCodeUnits(left, right));
  for (const [standard, clauses] of byStandard) {
    const byClause = [...clauses.entries()].sort(([left], [right]) => byCodeUnits(left, right));
    for (const [clause, row] of byClause) {
      coverage.push({
        standard,
        clause,
        checkIds: [...row.checkIds].sort(byCodeUnits),
        ...(row.cells === undefined ? {} : { matrixCells: row.cells }),
        reservations,
      });
    }
  }
  return coverage;
}

/**
 * What in this tool can cite a catalogued clause at all — and which clauses
 * nothing can.
 *
 * `findUncoveredClauses` stood here and asked a narrower question than its name:
 * **which clauses no registered check declares.** It was written on the day the
 * catalogue arrived (ADR-0043) and the day the matrix channel learned to cite a
 * clause (ADR-0041) was the same one, so it never learned about the second
 * channel. Over the catalogue this repository ships it named thirteen clauses as
 * covered by nothing, and four of the thirteen — ASVS 8.1.1, 8.2.1, 8.2.2 and
 * API5 — are cited by `standardsForDiff` on findings the tool produces on every
 * run. Nine are the real answer.
 *
 * Four wrong rows in thirteen is not a rounding error in a list whose entire job
 * is to be believed. It fails twice over:
 *
 * - **The claim itself is false.** "ASVS 8.2.1 is covered by nothing" is said of
 *   the clause every function-level escalation this tool finds cites first.
 * - **The nine real gaps are hidden inside it.** CWE-862 and CWE-863 are absent
 *   for a reason no check will ever close — from outside a platform, a missing
 *   authorization check and a wrong one give the same answer — and that fact is
 *   worth reading. Filed beside four rows that are simply wrong, it is not.
 *
 * There was a third failure, in the gate rather than in the answer.
 * `tests/invariants/standard-refs.test.ts` pinned the thirteen by exact
 * equality, "so that a check added, a check's claims widened, or a clause added
 * all move it". A change to `standardsForDiff` moved nothing: the whole matrix
 * mapping could be deleted and the pinned list would not budge. The gate meant
 * to make a change of coverage visible was blind to the channel that produces
 * most of this tool's findings.
 *
 * ## The shape, and what it deliberately is not
 *
 * **There is no `covered` field anywhere.** A row carries the checks that
 * declare the clause and the discrepancy kinds whose mapping cites it, both
 * derived, and "answered" is those two lists being empty or not. A clause added
 * to the catalogue tomorrow with nothing behind it cannot be *declared* covered,
 * because there is nothing to declare it with. That is the whole of the
 * structural half; see ADR-0069 for what it does not hold.
 *
 * **The matrix channel is enumerated, not listed.** Which clauses it can cite is
 * asked of `standardsForDiff` over every `DiffKind` there is and every relation
 * a cell can have, `undefined` included. `DIFF_KINDS` is the list the union is
 * derived from, so a fifth kind is in the enumeration whether or not anybody
 * remembered this file.
 *
 * **A run is not in scope here.** Whether a clause was *exercised* is
 * `clauseCoverage` next door, answered against the cells of one walk. This
 * module is answered against a catalogue and a registry: it says what the tool
 * can ever speak to, which is the question a reader of an evidence pack brings
 * before opening the findings.
 */

import { standardsForDiff } from "../checks/clauses.js";
import type { Check } from "../checks/types.js";
import { byCodeUnits } from "../order.js";
import { DIFF_KINDS, type DiffKind, RESOURCE_RELATIONS } from "../types.js";
import type { StandardCatalog } from "./catalog.js";
import type { StandardClause } from "./types.js";

/** One catalogued clause and everything in this tool that can cite it. */
export interface ClauseAnswer {
  readonly standard: string;
  /**
   * The catalogue's own boundary for that standard, carried on the row.
   *
   * On the row and not fetched separately, because this is the sentence the
   * answer is false without: "8.2.3 is answered by nothing" is a fact about the
   * clauses catalogued here, not about ASVS. See `StandardDefinition.scope`.
   */
  readonly scope: string;
  readonly clause: StandardClause;
  /**
   * The registered checks that declare this clause, in code-unit order.
   *
   * A check that answers for a clause answers whether or not it finds anything —
   * that is the direction ADR-0025 took the filter off findings for.
   */
  readonly checkIds: readonly string[];
  /**
   * The kinds of matrix discrepancy whose mapping cites this clause, in
   * code-unit order.
   *
   * Not "the kinds seen in a run" — no run has happened. This is what
   * `standardsForDiff` would assign if such a discrepancy occurred, which is the
   * sense in which the matrix channel answers for a clause at all.
   */
  readonly diffKinds: readonly DiffKind[];
}

/** A catalogued clause that neither channel can cite. */
export interface UnansweredClause {
  readonly standard: string;
  /** The catalogue's own boundary, for the reason `ClauseAnswer.scope` carries it. */
  readonly scope: string;
  readonly clause: StandardClause;
}

/**
 * Every clause the matrix channel can cite, asked of the channel itself.
 *
 * Module-private on purpose. What a caller wants is the per-clause row below,
 * and a second exported way to reach the same fact is a second copy of it as
 * soon as one of them grows a special case.
 *
 * Every kind against every relation including `undefined`, because
 * `standardsForDiff` takes both axes and the answer differs on both: a cell that
 * names no resource cites function-level access, one that names a resource cites
 * object-level, and only a discrepancy that is an escalation adds a defect
 * class. Nothing here models those branches — they are called.
 */
function matrixClauses(): ReadonlyMap<string, ReadonlyMap<string, readonly DiffKind[]>> {
  const byStandard = new Map<string, Map<string, DiffKind[]>>();
  for (const kind of DIFF_KINDS) {
    for (const relation of [undefined, ...RESOURCE_RELATIONS]) {
      for (const ref of standardsForDiff(kind, relation)) {
        const clauses = byStandard.get(ref.standard) ?? new Map<string, DiffKind[]>();
        byStandard.set(ref.standard, clauses);
        const kinds = clauses.get(ref.clause) ?? [];
        clauses.set(ref.clause, kinds);
        if (!kinds.includes(kind)) {
          kinds.push(kind);
        }
      }
    }
  }
  return byStandard;
}

/**
 * Every catalogued clause, with the checks and the discrepancy kinds that answer
 * for it.
 *
 * One row per clause of every registered standard, in the order the catalogue
 * holds them — which is the order a reader of the standard meets them, and the
 * order `definitions()` was already built to preserve.
 *
 * The two coordinates of a clause are held apart in the lookup rather than glued
 * into one key. A separator between a standard and a clause would be a character
 * both halves may legally contain, which is the collision `defectSignature` was
 * caught by, where two different signatures joined by a hyphen became one string
 * and two breakages were reported as one. Nothing is joined, so nothing can
 * collide.
 */
export function clauseAnswers(
  catalog: StandardCatalog,
  checks: readonly Check[],
): readonly ClauseAnswer[] {
  const byCheck = new Map<string, Map<string, Set<string>>>();
  for (const check of checks) {
    for (const ref of check.standards) {
      const clauses = byCheck.get(ref.standard) ?? new Map<string, Set<string>>();
      byCheck.set(ref.standard, clauses);
      const ids = clauses.get(ref.clause) ?? new Set<string>();
      clauses.set(ref.clause, ids);
      ids.add(check.id);
    }
  }

  const byMatrix = matrixClauses();
  const answers: ClauseAnswer[] = [];
  for (const definition of catalog.definitions()) {
    for (const clause of definition.clauses) {
      answers.push({
        standard: definition.id,
        scope: definition.scope,
        clause,
        checkIds: [...(byCheck.get(definition.id)?.get(clause.id) ?? [])].sort(byCodeUnits),
        diffKinds: [...(byMatrix.get(definition.id)?.get(clause.id) ?? [])].sort(byCodeUnits),
      });
    }
  }
  return answers;
}

/**
 * The catalogued clauses neither channel can cite.
 *
 * The half an evidence pack cannot be complete without: a pack built from
 * findings alone lists what happened to be checked, and the question a reader
 * actually has is what was not. `clause.unansweredBecause` is where the reason
 * for each of these lives, and
 * `tests/invariants/a-clause-nothing-answers.test.ts` is what holds every row
 * here to carrying one.
 *
 * A filter over `clauseAnswers` rather than a second traversal, so that the two
 * answers cannot disagree about what "answered" means.
 *
 * Not wired into the report. What an unanswered clause looks like in the
 * artifact is a decision about `REPORT_SCHEMA_VERSION` and about the evidence
 * pack, both of which are being built on other tracks; see ADR-0069.
 */
export function findUnansweredClauses(
  catalog: StandardCatalog,
  checks: readonly Check[],
): readonly UnansweredClause[] {
  return clauseAnswers(catalog, checks)
    .filter((row) => row.checkIds.length === 0 && row.diffKinds.length === 0)
    .map(({ standard, scope, clause }) => ({ standard, scope, clause }));
}

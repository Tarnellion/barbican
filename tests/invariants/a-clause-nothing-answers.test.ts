/**
 * Every catalogued clause is answered by something, or says why nothing does.
 *
 * The gate for the honest half of Module 2. `findUncoveredClauses` stood where
 * `clauseAnswers` does and asked only about registered checks, so over the
 * bundled catalogue it named thirteen clauses as covered by nothing while four
 * of the thirteen — ASVS 8.1.1, 8.2.1, 8.2.2 and API5 — were cited by
 * `standardsForDiff` on findings this tool produces on every run. Nine is the
 * answer. The gate that pinned the thirteen could not have noticed: it read one
 * channel, so the entire matrix mapping could have been deleted without moving
 * the list by a row.
 *
 * ## What holds
 *
 * Three things, over the catalogue this repository ships and the checks it
 * exports.
 *
 * - **The unanswered list, pinned by exact equality.** A check added, a check's
 *   claims widened, a clause added to the catalogue, **or a change to
 *   `standardsForDiff`** all move it, and all four deserve to be read in a diff.
 *   The fourth is the one that was invisible before.
 * - **`unansweredBecause` and the derivation agree, in both directions.** A
 *   clause nothing answers and that gives no reason is red; so is a reason on a
 *   clause something does answer. The second direction is the one that goes
 *   stale on its own: a check written tomorrow to close CWE-863 leaves that
 *   clause's sentence behind, still saying nothing will ever answer it.
 * - **The derivation is not vacuous.** Both channels are shown reaching
 *   something, and the enumeration of the matrix channel is shown to be about
 *   the whole of `DIFF_KINDS` rather than about whichever kind was asked first.
 *
 * ## What it cannot see
 *
 * What a gate of this family holds at all is ADR-0065. This one is not a source
 * scan — it reads the exported surface — so its blind spots are the surface's,
 * and each was run before it was written down (ADR-0069 carries what was run).
 *
 * - **A check that is not exported from `src/index.ts`.** `CHECKS` is discovered
 *   by the naming pattern on the package surface, the same way
 *   `standard-refs.test.ts` discovers them. A check registered only by a
 *   consumer — which is the whole point of `CheckRegistry` — is invisible here,
 *   and so is the clause it answers. The consequence is one-directional: such a
 *   clause reads as unanswered, never as answered.
 * - **A private catalogue.** Only the bundled three are read. A standard
 *   registered at run time is held to nothing by this file; the reasoning and
 *   the alternative are in ADR-0069.
 * - **A reason that is present, non-blank and wrong.** Nothing here reads what
 *   the sentence says. A clause whose `unansweredBecause` is "we could not be
 *   bothered" passes every assertion below.
 * - **A clause the catalogue does not carry.** This gate is about the boundary
 *   the catalogue drew, never about whether that boundary is the right one. That
 *   `scope` sentence is a human judgement and is checked by a human reading it.
 * - **Whether a clause a channel *can* cite was ever exercised in a run.** A
 *   different question, answered against the cells of one walk by
 *   `clauseCoverage`, and the difference is deliberate: this file says what the
 *   tool can ever speak to, not what one run reached.
 *
 * See ADR-0069.
 */

import { describe, expect, it } from "vitest";
import type { Check } from "../../src/core/checks/types.js";
import * as api from "../../src/index.js";
import { clauseAnswers, createBundledCatalog, findUnansweredClauses } from "../../src/index.js";

/**
 * The check factories the package exports, discovered rather than listed — for
 * the reason `standard-refs.test.ts` gives: a second list beside
 * `src/core/checks/` is the same fact written twice, and this repository has
 * watched that shape go stale.
 */
const CHECKS: readonly Check[] = Object.entries(api)
  .filter(([name, value]) => /^create[A-Za-z0-9]*Check$/.test(name) && typeof value === "function")
  .map(([, make]) => (make as () => Check)());

const CATALOG = createBundledCatalog();

const ANSWERS = clauseAnswers(CATALOG, CHECKS);

function nameOf(row: { standard: string; clause: { id: string } }): string {
  return `${row.standard}/${row.clause.id}`;
}

describe("what answers a catalogued clause", () => {
  it("has a catalogue and checks to answer for", () => {
    // A gate that discovered nothing is green for the same reason a passing one
    // is. Sixteen clauses across three standards, and at least one check.
    expect(ANSWERS.length).toBe(16);
    expect(CHECKS.length).toBeGreaterThan(0);
  });

  /**
   * Both channels reach something, so neither half of the derivation is a branch
   * that never runs.
   *
   * The matrix half is the one that was missing entirely, and its absence was
   * invisible precisely because the answer it changes — four rows — still looked
   * like a plausible list.
   */
  it("reaches clauses down both channels", () => {
    expect(ANSWERS.filter((row) => row.checkIds.length > 0).map(nameOf)).toEqual([
      "OWASP-ASVS-5.0/8.4.1",
      "OWASP-API-2023/API1",
      "CWE/285",
    ]);
    expect(ANSWERS.filter((row) => row.diffKinds.length > 0).map(nameOf)).toEqual([
      "OWASP-ASVS-5.0/8.1.1",
      "OWASP-ASVS-5.0/8.2.1",
      "OWASP-ASVS-5.0/8.2.2",
      "OWASP-ASVS-5.0/8.4.1",
      "OWASP-API-2023/API1",
      "OWASP-API-2023/API5",
      "CWE/285",
    ]);
  });

  /**
   * The check channel answers for no clause the matrix channel does not already
   * answer for.
   *
   * Measured, not designed, and it is why the four wrong rows were survivable
   * for as long as they were: subtracting only the checks left a list that was
   * wrong in one direction and never in the other. Worth pinning, because the
   * day it stops being true is the day a check carries a clause on its own and
   * the pack's arithmetic changes shape.
   */
  it("has no clause that only a check reaches", () => {
    const checkOnly = ANSWERS.filter(
      (row) => row.checkIds.length > 0 && row.diffKinds.length === 0,
    );

    expect(checkOnly.map(nameOf)).toEqual([]);
  });

  /**
   * The matrix enumeration asks about every kind, not about the first one.
   *
   * `standardsForDiff` adds a defect class on `privilege-escalation` alone, so a
   * row citing only that kind and a row citing all four are the shapes that
   * distinguish an enumeration over `DIFF_KINDS` from one over a single kind. If
   * this ever collapses to one kind everywhere, the loop stopped looping.
   */
  it("asks the matrix channel about every kind there is", () => {
    const byClause = new Map(ANSWERS.map((row) => [nameOf(row), row.diffKinds]));

    expect(byClause.get("OWASP-ASVS-5.0/8.1.1")).toEqual([
      "not-observed",
      "privilege-escalation",
      "probe-error",
      "unexpected-denial",
    ]);
    expect(byClause.get("OWASP-API-2023/API5")).toEqual(["privilege-escalation"]);
  });
});

/**
 * What nothing answers, named.
 *
 * Pinned by exact equality rather than counted, for the reason the list it
 * replaces was: this is the current state of Module 2's coverage, and it is the
 * one fact about an evidence pack that must not change quietly. The nine are not
 * a backlog of oversights — each carries its own reason, and a gap that exists
 * for a reason is still a gap worth printing.
 */
describe("the catalogued clauses nothing in this tool answers", () => {
  it("are these, and the list moves only on purpose", () => {
    expect(findUnansweredClauses(CATALOG, CHECKS).map(nameOf)).toEqual([
      "OWASP-ASVS-5.0/8.1.3",
      "OWASP-ASVS-5.0/8.2.3",
      "OWASP-ASVS-5.0/8.3.1",
      "OWASP-ASVS-5.0/8.3.3",
      "OWASP-API-2023/API3",
      "CWE/284",
      "CWE/862",
      "CWE/863",
      "CWE/639",
    ]);
  });

  /**
   * And the four the previous gate got wrong are out of it.
   *
   * Spelled out rather than left to the list above, because this is the defect
   * itself: every one of these is cited by the matrix channel on every run, and
   * every one of them was printed as covered by nothing.
   */
  it("leaves out the four the check-only answer named wrongly", () => {
    const unanswered = findUnansweredClauses(CATALOG, CHECKS).map(nameOf);

    for (const clause of [
      "OWASP-ASVS-5.0/8.1.1",
      "OWASP-ASVS-5.0/8.2.1",
      "OWASP-ASVS-5.0/8.2.2",
      "OWASP-API-2023/API5",
    ]) {
      expect(unanswered).not.toContain(clause);
    }
  });

  /** The catalogue's own boundary travels on every row, or the row is a claim about ASVS. */
  it("carries the catalogue's boundary and the published source on every row", () => {
    for (const row of findUnansweredClauses(CATALOG, CHECKS)) {
      expect(row.scope.length).toBeGreaterThan(0);
      expect(row.clause.url).toMatch(/^https:\/\//);
    }
  });
});

/**
 * The declared reason and the derived answer are held to agree.
 *
 * `unansweredBecause` is the one thing on a catalogue entry that is a fact about
 * this tool rather than about somebody else's document, so it is the one thing
 * here that can drift. Both directions are red, and the second is the one that
 * rots quietly: a check written to close a clause leaves the old sentence behind
 * saying nothing ever will.
 */
describe("the reason a clause carries", () => {
  it("is on every clause nothing answers", () => {
    const silent = findUnansweredClauses(CATALOG, CHECKS)
      .filter((row) => row.clause.unansweredBecause === undefined)
      .map(nameOf);

    expect(silent).toEqual([]);
  });

  it("is on no clause something answers", () => {
    const stale = ANSWERS.filter(
      (row) =>
        row.clause.unansweredBecause !== undefined &&
        (row.checkIds.length > 0 || row.diffKinds.length > 0),
    ).map(nameOf);

    expect(stale).toEqual([]);
  });

  /**
   * And it is a sentence rather than a shrug.
   *
   * The door refuses a blank; nothing can refuse a reason that says nothing, and
   * this is as far as a machine gets. A length is not a judgement of the
   * sentence — see "what it cannot see" above.
   */
  it("says something", () => {
    for (const row of findUnansweredClauses(CATALOG, CHECKS)) {
      expect(row.clause.unansweredBecause?.length ?? 0).toBeGreaterThan(40);
    }
  });
});

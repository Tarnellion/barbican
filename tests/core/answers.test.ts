/**
 * What answers a catalogued clause, over a fixture catalogue rather than over
 * the one this repository ships.
 *
 * The gate that applies these functions to the bundled three and to the checks
 * this package exports is `tests/invariants/a-clause-nothing-answers.test.ts`.
 * This file is the mechanism: that both channels are subtracted, that the two
 * coordinates of a clause are never glued into one key, and that the row carries
 * what makes it readable on its own.
 *
 * The fixture standard is a house one, `HOUSE-RULES`, because a fixture built
 * out of the bundled catalogue would be a test that agrees with the data it is
 * testing. Its clause `R1` deliberately repeats in a second standard, which is
 * the collision the key shape exists against.
 */

import { describe, expect, it } from "vitest";
import type { Check, StandardRef } from "../../src/core/checks/types.js";
import { clauseAnswers, findUnansweredClauses, StandardCatalog } from "../../src/core/index.js";
import type { StandardClause, StandardDefinition } from "../../src/core/standards/types.js";

/** A check is a name and a list of references here; nothing below runs one. */
function check(id: string, standards: readonly StandardRef[]): Check {
  return {
    id,
    description: `the ${id} check`,
    severity: "high",
    standards,
    run: () => [],
  };
}

const R1: StandardClause = {
  id: "R1",
  title: "The first rule.",
  url: "https://example.test/rules#r1",
};
const R2: StandardClause = {
  id: "R2",
  title: "The second rule.",
  url: "https://example.test/rules#r2",
  unansweredBecause: "The second rule is about something this fixture cannot observe.",
};

const HOUSE_RULES: StandardDefinition = {
  id: "HOUSE-RULES",
  scope: "The two rules this fixture is about, and nothing else.",
  clauses: [R1, R2],
};

function withHouseRules(): StandardCatalog {
  const catalog = new StandardCatalog();
  catalog.register(HOUSE_RULES);
  return catalog;
}

describe("the clauses nothing answers", () => {
  it("is every catalogued clause when nothing is registered", () => {
    expect(findUnansweredClauses(withHouseRules(), []).map((row) => row.clause.id)).toEqual([
      "R1",
      "R2",
    ]);
  });

  it("drops the ones a check answers for, and keeps the rest", () => {
    const covers = check("covers", [{ standard: "HOUSE-RULES", clause: "R1" }]);

    expect(findUnansweredClauses(withHouseRules(), [covers]).map((row) => row.clause.id)).toEqual([
      "R2",
    ]);
  });

  /**
   * Coverage is counted per standard, and the two coordinates are never glued
   * into one key. A clause id is free to repeat across standards — `R1` here in
   * both — and a separator between the two would be a character either of them
   * may legally contain: the collision `defectSignature` was caught by, where
   * two different signatures joined by a hyphen became one string.
   */
  it("does not let a clause of one standard answer the same number in another", () => {
    const catalog = withHouseRules();
    catalog.register({ ...HOUSE_RULES, id: "OTHER-RULES" });
    const covers = check("covers", [{ standard: "HOUSE-RULES", clause: "R1" }]);

    expect(
      findUnansweredClauses(catalog, [covers]).map((row) => `${row.standard}:${row.clause.id}`),
    ).toEqual(["HOUSE-RULES:R2", "OTHER-RULES:R1", "OTHER-RULES:R2"]);
  });

  /** Two references to one standard are both counted, not only the first. */
  it("counts every reference a check makes to one standard", () => {
    const covers = check("covers", [
      { standard: "HOUSE-RULES", clause: "R1" },
      { standard: "HOUSE-RULES", clause: "R2" },
    ]);

    expect(findUnansweredClauses(withHouseRules(), [covers])).toEqual([]);
  });

  /**
   * The boundary travels on the row.
   *
   * Without it the answer is read as a statement about the standard, and it is
   * not one: ASVS 5.0 has seventeen chapters and this catalogue carries part of
   * one. A pack that lists unanswered clauses and does not say what it looked at
   * is the same false completeness in a new place.
   */
  it("carries the catalogue's own boundary with every answer", () => {
    const rows = findUnansweredClauses(withHouseRules(), []);

    expect(rows[0]?.scope).toBe(HOUSE_RULES.scope);
    // And the source of the real wording, which is all this repository carries
    // of the text itself.
    expect(rows[0]?.clause.url).toBe("https://example.test/rules#r1");
    // And the sentence saying why nothing answers it, which is the row's whole
    // point once it has been established that nothing does.
    expect(rows[1]?.clause.unansweredBecause).toBe(R2.unansweredBecause);
  });
});

describe("the full table of answers", () => {
  it("names the checks that answer a clause, in one order on every machine", () => {
    const catalog = withHouseRules();
    const rows = clauseAnswers(catalog, [
      check("zebra", [{ standard: "HOUSE-RULES", clause: "R1" }]),
      check("alpha", [{ standard: "HOUSE-RULES", clause: "R1" }]),
    ]);

    expect(rows.map((row) => row.checkIds)).toEqual([["alpha", "zebra"], []]);
  });

  /**
   * A clause of a standard the matrix channel knows nothing about gets no kinds,
   * which is what makes the fixture usable at all: `standardsForDiff` cites
   * `OWASP-ASVS-5.0`, `OWASP-API-2023` and `CWE`, and a house standard is none
   * of them.
   */
  it("gives a house standard no discrepancy kinds", () => {
    expect(clauseAnswers(withHouseRules(), []).map((row) => row.diffKinds)).toEqual([[], []]);
  });

  /**
   * One row per catalogued clause, in the order the catalogue holds them —
   * unlike `findUnansweredClauses`, which is that list with rows taken out.
   */
  it("has a row for every clause, answered or not", () => {
    const covers = check("covers", [{ standard: "HOUSE-RULES", clause: "R1" }]);

    expect(clauseAnswers(withHouseRules(), [covers]).map((row) => row.clause.id)).toEqual([
      "R1",
      "R2",
    ]);
  });

  /** A clause the registry cites and the catalogue does not carry is not invented here. */
  it("says nothing about a clause outside the catalogue", () => {
    const elsewhere = check("elsewhere", [{ standard: "HOUSE-RULES", clause: "R9" }]);

    expect(clauseAnswers(withHouseRules(), [elsewhere]).map((row) => row.clause.id)).toEqual([
      "R1",
      "R2",
    ]);
  });
});

/**
 * The catalogue of standard clauses.
 *
 * `StandardRef` was two free strings with no registry behind them, so a clause
 * number could be misspelt and nothing would say so, and "this clause is covered
 * by nothing" could not be said at all — not because the check was unwritten but
 * because there was nothing to iterate over. Both halves are tested here; the
 * gate that applies them to the checks this repository actually ships is in
 * `tests/invariants/standard-refs.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { Check, StandardRef } from "../../src/core/checks/types.js";
import {
  CWE_ACCESS_CONTROL,
  clauseAnswers,
  createBundledCatalog,
  DuplicateClauseError,
  DuplicateStandardError,
  findUnresolvedStandardRefs,
  IncompleteStandardError,
  OWASP_API_2023,
  OWASP_ASVS_5_0,
  StandardCatalog,
} from "../../src/core/index.js";
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
};

const HOUSE_RULES: StandardDefinition = {
  id: "HOUSE-RULES",
  scope: "The two rules this fixture is about, and nothing else.",
  clauses: [R1, R2],
};

describe("registering a standard", () => {
  it("keeps what it was given, and answers about the standard and the clause apart", () => {
    const catalog = new StandardCatalog();
    catalog.register(HOUSE_RULES);

    expect(catalog.has("HOUSE-RULES")).toBe(true);
    expect(catalog.has("OTHER-RULES")).toBe(false);
    expect(catalog.clause({ standard: "HOUSE-RULES", clause: "R1" })?.title).toBe(
      "The first rule.",
    );
    // The two ways of resolving to nothing. They look identical from here and
    // are told apart by `findUnresolvedStandardRefs`, because their cures are
    // opposite ones.
    expect(catalog.clause({ standard: "HOUSE-RULES", clause: "R9" })).toBeUndefined();
    expect(catalog.clause({ standard: "OTHER-RULES", clause: "R1" })).toBeUndefined();
  });

  it("hands back what was registered, in the order it was registered", () => {
    const catalog = new StandardCatalog();
    catalog.register(HOUSE_RULES);
    catalog.register({ ...HOUSE_RULES, id: "OTHER-RULES" });

    expect(catalog.definitions().map((one) => one.id)).toEqual(["HOUSE-RULES", "OTHER-RULES"]);
  });

  /**
   * Registering one twice is refused rather than obeyed.
   *
   * The same argument as `DuplicateCheckIdError` next door: the second
   * registration would replace the first, and a clause that quietly stopped
   * existing is a clause that quietly stopped being claimed — with `covered` and
   * `uncovered` both changing and nothing saying why.
   */
  it("refuses a standard that is already in the catalogue", () => {
    const catalog = new StandardCatalog();
    catalog.register(HOUSE_RULES);

    expect(() => {
      catalog.register({ ...HOUSE_RULES, clauses: [R1] });
    }).toThrow(DuplicateStandardError);
  });

  it("refuses a standard that declares one clause twice", () => {
    expect(() => {
      new StandardCatalog().register({
        ...HOUSE_RULES,
        clauses: [R1, R2, { ...R1, title: "The first rule, again." }],
      });
    }).toThrow(DuplicateClauseError);
  });

  /**
   * Every field is refused blank, and each one fails differently when it is not
   * there. A missing `url` leaves a paraphrase of a document this repository
   * does not carry, with nothing to check it against; a missing `scope` turns
   * "answered by nothing here" into a claim about a whole standard; a standard
   * with no clauses answers every question about coverage by having nothing to
   * be unanswered; and a blank `unansweredBecause` puts an empty cell where a
   * reader will read a reason. Absent is a state and blank is not — the field is
   * optional, and the door can only refuse the second, because a catalogue never
   * sees a check.
   */
  it.each([
    ["an identifier", { ...HOUSE_RULES, id: "  " }],
    ["a boundary", { ...HOUSE_RULES, scope: "" }],
    ["clauses", { ...HOUSE_RULES, clauses: [] }],
    ["a clause identifier", { ...HOUSE_RULES, clauses: [{ id: "", title: "t", url: "u" }] }],
    ["a clause summary", { ...HOUSE_RULES, clauses: [{ id: "R1", title: " ", url: "u" }] }],
    ["a clause source", { ...HOUSE_RULES, clauses: [{ id: "R1", title: "t", url: "" }] }],
    [
      "reason on a clause that declares one",
      { ...HOUSE_RULES, clauses: [{ id: "R1", title: "t", url: "u", unansweredBecause: " " }] },
    ],
  ])("refuses a standard with no %s", (_what, definition) => {
    expect(() => {
      new StandardCatalog().register(definition);
    }).toThrow(IncompleteStandardError);
  });
});

describe("the references a check declares", () => {
  const catalog = createBundledCatalog();

  it("resolve when the clause is catalogued", () => {
    const resolves = check("resolves", [
      { standard: "OWASP-ASVS-5.0", clause: "8.4.1" },
      { standard: "CWE", clause: "285" },
    ]);

    expect(findUnresolvedStandardRefs(catalog, [resolves])).toEqual([]);
  });

  /**
   * A misspelt clause number is the failure this whole module exists for. It
   * costs nothing at the time — the report simply carries a coverage row for a
   * requirement that does not exist — and nobody audits an evidence pack for
   * clauses it should not have mentioned.
   */
  it("name the typo as a typo, and say which check made it", () => {
    const typo = check("typo", [{ standard: "OWASP-ASVS-5.0", clause: "8.4.11" }]);

    expect(findUnresolvedStandardRefs(catalog, [typo])).toEqual([
      {
        checkId: "typo",
        standard: "OWASP-ASVS-5.0",
        clause: "8.4.11",
        reason: "unknown-clause",
      },
    ]);
  });

  /**
   * And a reference to a standard nobody registered reads differently, because
   * its cure is the opposite one. This is the ordinary state of a check citing
   * GLI-19 on a machine where the private catalogue was not registered: the
   * answer has to say "no such catalogue here", not "you misspelt it".
   */
  it("tell an unregistered standard from a misspelt clause", () => {
    const private_ = check("private", [{ standard: "GLI-19", clause: "4.2" }]);

    expect(findUnresolvedStandardRefs(catalog, [private_])?.[0]?.reason).toBe("unknown-standard");
  });

  it("are reported for every check, not only the first that fails", () => {
    const one = check("one", [{ standard: "CWE", clause: "999" }]);
    const two = check("two", [{ standard: "NOPE", clause: "1" }]);

    expect(findUnresolvedStandardRefs(catalog, [one, two]).map((row) => row.checkId)).toEqual([
      "one",
      "two",
    ]);
  });
});

/**
 * A second standard arrives by registration, not by editing this module.
 *
 * The requirement behind the whole shape: GLI-19 and the AGCO requirements are
 * not public, so their numbering and their text cannot be in a public
 * repository. They reach the catalogue through the same `register` the bundled
 * three come through, from a source this repository never sees, beside the
 * private checks that cite them — and the validation is then exactly as strict
 * there as it is here. Simulated below with a definition built in the test,
 * because the real one cannot be committed. See ADR-0043.
 */
describe("a standard this repository may not carry", () => {
  it("resolves once it is registered, and only then", () => {
    const catalog = createBundledCatalog();
    const private_ = check("private", [{ standard: "HOUSE-RULES", clause: "R1" }]);

    expect(findUnresolvedStandardRefs(catalog, [private_])).toHaveLength(1);

    catalog.register(HOUSE_RULES);

    expect(findUnresolvedStandardRefs(catalog, [private_])).toEqual([]);
    // And it takes part in the other answer on the same terms: registered, its
    // clauses are in `clauseAnswers` like anybody else's. `answers.test.ts` is
    // where that answer is examined; what matters here is that registration is
    // the only door either question goes through.
    expect(clauseAnswers(catalog, [private_]).some((row) => row.standard === "HOUSE-RULES")).toBe(
      true,
    );
  });

  it("gets a catalogue of its own each time, so one run cannot leak into the next", () => {
    createBundledCatalog().register(HOUSE_RULES);

    expect(createBundledCatalog().has("HOUSE-RULES")).toBe(false);
  });
});

describe("what this repository ships", () => {
  const catalog = createBundledCatalog();

  it("carries the three standards the tree already cites", () => {
    expect(catalog.definitions().map((one) => one.id)).toEqual([
      "OWASP-ASVS-5.0",
      "OWASP-API-2023",
      "CWE",
    ]);
  });

  /**
   * The clause numbers, pinned by exact equality.
   *
   * They are transcribed from published documents by hand, and the tables in
   * `docs/research/tenancy-models.md` section 6 are where they were read from.
   * Nothing in this repository can verify them against the standards themselves
   * — that is a human step, done once when a clause is added — so what a test
   * can do is make any later edit to the list deliberate rather than incidental.
   */
  it("carries the clause numbers it was built from", () => {
    expect(OWASP_ASVS_5_0.clauses.map((one) => one.id)).toEqual([
      "8.1.1",
      "8.1.3",
      "8.2.1",
      "8.2.2",
      "8.2.3",
      "8.3.1",
      "8.3.3",
      "8.4.1",
    ]);
    expect(OWASP_API_2023.clauses.map((one) => one.id)).toEqual(["API1", "API3", "API5"]);
    expect(CWE_ACCESS_CONTROL.clauses.map((one) => one.id)).toEqual([
      "284",
      "285",
      "862",
      "863",
      "639",
    ]);
  });

  /**
   * And carries none of the standards' own wording.
   *
   * The rule this catalogue is built under: identifiers, a line of our own, and
   * the address of the published text. A guard rather than a note, because the
   * cheap way to write the next entry is to paste the requirement.
   */
  it("summarises every clause in one line of its own, and sources every one", () => {
    for (const definition of catalog.definitions()) {
      for (const clause of definition.clauses) {
        expect(clause.title.length).toBeLessThan(140);
        expect(clause.title).not.toContain("\n");
        expect(clause.url.startsWith("https://")).toBe(true);
      }
    }
  });
});

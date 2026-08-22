/**
 * "The clause was exercised" as something the tool can say, and refuse to say.
 *
 * `coverage.checksRun` names the clauses a registered check answers for even
 * when it found nothing. The matrix channel had no such list, so a clause
 * exercised over nine hundred agreeing cells reached an evidence pack only if
 * one of them broke: the pack could say "here is what failed under 8.2.2" and
 * not "8.2.2 was exercised across the surface and holds". Recorded as a
 * consequence in ADR-0041 and as unclosed in `plan.md`; the second half of M-11.
 *
 * The danger this file is mostly about is the opposite one, and it is the same
 * class as a falsely clean run: claiming a clause exercised where the tool could
 * not structurally see anything. A cell nobody asked, an endpoint skipped, a
 * request that failed — none of those is an exercise of anything, and each has
 * to be visible next to the number that is.
 *
 * See ADR-0052.
 */

import { describe, expect, it } from "vitest";
import {
  ASVS_DOCUMENTED_RULES,
  ASVS_FUNCTION_LEVEL_ACCESS,
  ASVS_OBJECT_LEVEL_ACCESS,
  ASVS_TENANT_ISOLATION,
  CWE_IMPROPER_AUTHORIZATION,
  controlClausesForCell,
  standardsForDiff,
} from "../../src/core/checks/clauses.js";
import type { CheckRun, StandardRef } from "../../src/core/checks/types.js";
import type { ClauseCoverage, JudgedCell } from "../../src/core/standards/coverage.js";
import { clauseCoverage, INCONCLUSIVE_REASONS } from "../../src/core/standards/coverage.js";
import { RESOURCE_RELATIONS } from "../../src/core/types.js";

/** The row for one clause, or nothing when the run never reached it. */
function rowFor(rows: readonly ClauseCoverage[], ref: StandardRef): ClauseCoverage | undefined {
  return rows.find((row) => row.standard === ref.standard && row.clause === ref.clause);
}

const upheld: JudgedCell = { verdict: "upheld" };
const breached: JudgedCell = { verdict: "breached" };

describe("which clauses a cell is evidence about", () => {
  /**
   * The rule ADR-0041 wrote for a discrepancy, reached from one declaration by
   * both directions of the citation. A second copy of the table here would be
   * the drift ADR-0041's own gate reads `src/` to prevent.
   */
  it("is the same rule the finding side already used", () => {
    for (const relation of [undefined, ...RESOURCE_RELATIONS]) {
      expect(standardsForDiff("unexpected-denial", relation)).toEqual(
        controlClausesForCell(relation),
      );
    }
  });

  it("is the endpoint alone where the cell names no resource", () => {
    expect(controlClausesForCell(undefined)).toEqual([
      ASVS_DOCUMENTED_RULES,
      ASVS_FUNCTION_LEVEL_ACCESS,
    ]);
  });

  it("reaches the object clause and tenant isolation where the cell crosses a boundary", () => {
    expect(controlClausesForCell("foreign-tenant")).toEqual([
      ASVS_DOCUMENTED_RULES,
      ASVS_OBJECT_LEVEL_ACCESS,
      ASVS_TENANT_ISOLATION,
    ]);
    expect(controlClausesForCell("own")).toEqual([ASVS_DOCUMENTED_RULES, ASVS_OBJECT_LEVEL_ACCESS]);
  });
});

describe("the clause coverage of the matrix channel", () => {
  it("counts a cell under every control clause it is evidence about", () => {
    const rows = clauseCoverage({ cells: [{ verdict: "upheld", relation: "foreign-tenant" }] });

    for (const ref of [ASVS_DOCUMENTED_RULES, ASVS_OBJECT_LEVEL_ACCESS, ASVS_TENANT_ISOLATION]) {
      expect(rowFor(rows, ref)?.matrixCells?.upheld).toBe(1);
    }
    // And under nothing else. A cell inside one tenant says nothing about
    // isolation, and a function-level clause is not what an object cell shows.
    expect(rowFor(rows, ASVS_FUNCTION_LEVEL_ACCESS)).toBeUndefined();
  });

  /**
   * The identity a reader checks the row by. Without it "exercised: 900" is a
   * number with no denominator, which is the state this record exists to end.
   */
  it("splits the conclusive cells into the two ways they concluded", () => {
    const rows = clauseCoverage({ cells: [upheld, upheld, breached] });
    const cells = rowFor(rows, ASVS_DOCUMENTED_RULES)?.matrixCells;

    expect(cells).toEqual({
      conclusive: 3,
      upheld: 2,
      breached: 1,
      inconclusive: { "not-observed": 0, "probe-error": 0 },
    });
  });

  /**
   * The heart of it. A cell nobody asked and a request that failed are not
   * evidence for anything, and counting either as an exercise of the clause is
   * worse than saying nothing at all.
   */
  it("does not count a cell nothing was learned from as exercised", () => {
    const rows = clauseCoverage({
      cells: [{ verdict: "not-observed" }, { verdict: "probe-error" }, upheld],
    });
    const cells = rowFor(rows, ASVS_FUNCTION_LEVEL_ACCESS)?.matrixCells;

    expect(cells?.conclusive).toBe(1);
    expect(cells?.inconclusive).toEqual({ "not-observed": 1, "probe-error": 1 });
  });

  it("still names the clause a run learned nothing about", () => {
    // The clause has to appear with a zero rather than to be missing: an absent
    // row reads as "not applicable here", and what happened is "asked, and no
    // answer came".
    const rows = clauseCoverage({ cells: [{ verdict: "probe-error" }] });
    const cells = rowFor(rows, ASVS_FUNCTION_LEVEL_ACCESS)?.matrixCells;

    expect(cells?.conclusive).toBe(0);
    expect(cells?.upheld).toBe(0);
    expect(cells?.inconclusive["probe-error"]).toBe(1);
  });

  it("carries every reason with a zero, so a missing key is never read as none", () => {
    const rows = clauseCoverage({ cells: [upheld] });
    const reasons = Object.keys(
      rowFor(rows, ASVS_DOCUMENTED_RULES)?.matrixCells?.inconclusive ?? {},
    );

    expect(new Set(reasons)).toEqual(new Set(INCONCLUSIVE_REASONS));
    expect(reasons.length).toBe(INCONCLUSIVE_REASONS.length);
  });

  /**
   * The defect classes are deliberately absent from this direction. ADR-0041
   * refuses to credit anything but an escalation with API1/API5/CWE-285 on a
   * finding; claiming the tool "exercised CWE-285" on a clean cell would be the
   * same inflated claim with the arrow turned round.
   */
  it("claims no weakness class on the strength of a clean cell", () => {
    const rows = clauseCoverage({ cells: [upheld, breached, { verdict: "upheld" }] });

    expect(rowFor(rows, CWE_IMPROPER_AUTHORIZATION)).toBeUndefined();
  });
});

describe("the clause coverage of the registered checks", () => {
  const CHECK: CheckRun = {
    id: "identical-response-across-tenants",
    description: "bodies that must differ between tenants did not",
    standards: [ASVS_TENANT_ISOLATION, CWE_IMPROPER_AUTHORIZATION],
  };

  it("names the check against every clause it answers for", () => {
    const rows = clauseCoverage({ checksRun: [CHECK] });

    expect(rowFor(rows, CWE_IMPROPER_AUTHORIZATION)?.checkIds).toEqual([CHECK.id]);
    // No cell numbers on a row the matrix did not reach: a check's own reach is
    // in `coverage.byCheck`, in the check's terms, and inventing a denominator
    // here would be this record making a claim it cannot support.
    expect(rowFor(rows, CWE_IMPROPER_AUTHORIZATION)?.matrixCells).toBeUndefined();
  });

  it("puts both channels on one row where both reach the clause", () => {
    const rows = clauseCoverage({
      cells: [{ verdict: "upheld", relation: "foreign-tenant" }],
      checksRun: [CHECK],
    });
    const row = rowFor(rows, ASVS_TENANT_ISOLATION);

    expect(row?.checkIds).toEqual([CHECK.id]);
    expect(row?.matrixCells?.conclusive).toBe(1);
  });

  /**
   * Two runs of one matrix have to produce the same file (ADR-0036), and the
   * registration order of a check is not a property of the platform.
   */
  it("lists the checks and the rows in one order on every machine", () => {
    const second: CheckRun = { ...CHECK, id: "a-second-check" };
    const rows = clauseCoverage({ cells: [upheld], checksRun: [CHECK, second] });
    const coordinates = rows.map((row) => `${row.standard}/${row.clause}`);

    expect(coordinates).toEqual([...coordinates].sort());
    expect(rowFor(rows, ASVS_TENANT_ISOLATION)?.checkIds).toEqual([second.id, CHECK.id]);
  });
});

describe("the reservations on a clause row", () => {
  /**
   * On every row rather than once in the file, for the reason
   * `UncoveredClause.scope` is carried on every row of its own: a row is what
   * gets pulled out of the report and into a pack about one clause, and a
   * qualification that stayed behind in another section is a qualification that
   * did not travel with the claim.
   */
  it("travel with each row", () => {
    const rows = clauseCoverage({
      cells: [{ verdict: "upheld", relation: "foreign-tenant" }],
      reservations: ["endpoints-not-probed", "authentication-unproved"],
    });

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.reservations).toEqual(["authentication-unproved", "endpoints-not-probed"]);
    }
  });

  it("are empty on a run with nothing held back", () => {
    expect(clauseCoverage({ cells: [upheld] })[0]?.reservations).toEqual([]);
  });
});

describe("a run with nothing to report", () => {
  it("produces no rows rather than rows of zeros", () => {
    // Nothing ran and no clause was reached. A row here would be a claim about
    // a clause this run has no relationship with at all — which is what
    // `findUncoveredClauses` answers, against a catalogue, and this function
    // deliberately does not.
    expect(clauseCoverage({})).toEqual([]);
  });
});

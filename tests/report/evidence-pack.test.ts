/**
 * What an evidence pack is allowed to say.
 *
 * The structure is the easy half and is barely asserted below. What is under
 * test is the refusal, in the same direction `tests/report/clause-coverage.test.ts`
 * tests it one layer down: a pack must not let a reader take a clause nothing
 * answered for as a clause that passed, must not report anything as upheld on
 * the strength of a run that could not answer for itself, and must not lose a
 * qualification on the way from the report to the row.
 *
 * The fixtures are written by hand, per CLAUDE.md. A `PackableRun` produced by
 * `buildReport` and fed straight back in would make this a test that two
 * functions in this repository agree with each other, and the question here is
 * whether the answer is right. The door and the round trip from a real report
 * are `tests/report/pack-door.test.ts`.
 *
 * See ADR-0067.
 */

import { describe, expect, it } from "vitest";
import {
  API_OBJECT_LEVEL_AUTHORIZATION,
  ASVS_DOCUMENTED_RULES,
  ASVS_OBJECT_LEVEL_ACCESS,
  ASVS_TENANT_ISOLATION,
  CWE_IMPROPER_AUTHORIZATION,
} from "../../src/core/checks/clauses.js";
import { createBundledCatalog } from "../../src/core/standards/bundled.js";
import { StandardCatalog } from "../../src/core/standards/catalog.js";
import type {
  CitedClause,
  EvidencePack,
  PackableCells,
  PackableClauseRow,
  PackableFinding,
  PackableRun,
} from "../../src/report/pack.js";
import { CLAIMS, DISCLAIMERS, evidencePack, STANDINGS } from "../../src/report/pack.js";

function run(extra: Partial<PackableRun> = {}): PackableRun {
  return {
    runId: "0f5f2e5c-1b2a-4d2e-9a71-000000000001",
    configDigest: "1122334455667788",
    startedAt: "2026-08-25T10:00:00.000Z",
    finishedAt: "2026-08-25T10:04:00.000Z",
    tool: {
      name: "barbican",
      version: "0.6.0",
      documentation: "https://github.com/Tarnellion/barbican/blob/v0.6.0/docs/report.md",
    },
    target: { baseUrl: "http://127.0.0.1:8961", label: "a demonstration deployment" },
    verdict: { code: 0, reason: "no discrepancy with the declared policy" },
    surface: { endpointsTotal: 4, endpointsProbed: 4, cellsObserved: 12 },
    warnings: [],
    evidenceRowsOmitted: 0,
    clauses: [],
    findings: [],
    ...extra,
  };
}

function cells(counts: Partial<PackableCells> = {}): PackableCells {
  return {
    conclusive: 0,
    upheld: 0,
    breached: 0,
    inconclusive: { "not-observed": 0, "probe-error": 0 },
    ...counts,
  };
}

function row(
  ref: { readonly standard: string; readonly clause: string },
  extra: Partial<PackableClauseRow> = {},
): PackableClauseRow {
  return {
    standard: ref.standard,
    clause: ref.clause,
    checkIds: [],
    reservations: [],
    ...extra,
  };
}

function finding(extra: Partial<PackableFinding> = {}): PackableFinding {
  return {
    kind: "privilege-escalation",
    channel: "matrix",
    severity: "high",
    standards: [],
    heldByAcceptance: false,
    ...extra,
  };
}

function packOf(input: PackableRun): EvidencePack {
  return evidencePack({ run: input, catalog: createBundledCatalog() });
}

function rowOf(pack: EvidencePack, ref: { standard: string; clause: string }): CitedClause {
  const found = [...pack.clauses, ...pack.outsideCatalogue].find(
    (one) => one.standard === ref.standard && one.clause === ref.clause,
  );
  if (found === undefined) {
    throw new Error(`no row for ${ref.standard} ${ref.clause}`);
  }
  return found;
}

/** A run that agreed with its declaration everywhere the cells reached. */
const CLEAN: PackableRun = run({
  clauses: [
    row(ASVS_DOCUMENTED_RULES, { matrixCells: cells({ conclusive: 12, upheld: 12 }) }),
    row(ASVS_OBJECT_LEVEL_ACCESS, { matrixCells: cells({ conclusive: 8, upheld: 8 }) }),
  ],
});

describe("a clause nothing answered for", () => {
  it("is unanswered rather than absent", () => {
    const pack = packOf(CLEAN);

    // The whole catalogue is here, and that is the point of building it against
    // a catalogue at all: a pack built from what the run cited would list what
    // happened to be checked, and the question a reader has is what was not.
    expect(pack.clauses.length).toBe(16);
    expect(rowOf(pack, ASVS_TENANT_ISOLATION).claim).toBe("unanswered");
    expect(rowOf(pack, API_OBJECT_LEVEL_AUTHORIZATION).claim).toBe("unanswered");
  });

  /**
   * And the sentence says so in a way a reader cannot take for a pass.
   *
   * The three words asserted are the load-bearing ones. A row that said only
   * "not covered" would be read by somebody skimming a table of sixteen rows as
   * a gap in the tool rather than as a gap in the evidence.
   */
  it("says it is not a pass", () => {
    expect(CLAIMS.unanswered).toContain("Nothing in this run answers for this clause");
    expect(CLAIMS.unanswered).toContain("not the same as");
    expect(CLAIMS.unanswered).toContain("passed");
  });

  it("carries no reservations, because there is no claim to qualify", () => {
    const pack = packOf(
      run({
        clauses: [
          row(ASVS_DOCUMENTED_RULES, {
            matrixCells: cells({ conclusive: 2, upheld: 2 }),
            reservations: ["endpoints-not-probed"],
          }),
        ],
      }),
    );

    expect(rowOf(pack, ASVS_TENANT_ISOLATION).reservations).toEqual([]);
    expect(rowOf(pack, ASVS_DOCUMENTED_RULES).reservations).toEqual(["endpoints-not-probed"]);
  });

  /**
   * And a catalogue with nothing in it cannot make a pack agree with everything.
   *
   * The guard on the guard: every assertion above is about rows the catalogue
   * produced, so a pack built against an empty one would satisfy "no clause was
   * wrongly called a pass" by having no clause at all.
   */
  it("is what an empty catalogue cannot produce", () => {
    const pack = evidencePack({ run: CLEAN, catalog: new StandardCatalog() });

    expect(pack.clauses).toEqual([]);
    // The rows the run cited are still there, under the heading that says the
    // catalogue does not carry them.
    expect(pack.outsideCatalogue.map((one) => one.clause)).toEqual(["8.1.1", "8.2.2"]);
  });
});

describe("a clause the cells reached", () => {
  it("is upheld with its denominator on the row", () => {
    const upheld = rowOf(packOf(CLEAN), ASVS_DOCUMENTED_RULES);

    expect(upheld.claim).toBe("upheld");
    expect(upheld.cells).toEqual(cells({ conclusive: 12, upheld: 12 }));
  });

  /**
   * And the reservations come from the report rather than from a second reading.
   *
   * `clauseReservationsOf` computes them while `coverage` is being written,
   * because that is where the accounts, the canaries and the surface are. A pack
   * that recomputed them from the run's identity would be the second reading
   * this repository has watched drift twice — and it could not do it anyway: the
   * canaries are not in a pack's input.
   */
  it("carries the reservations the report wrote, verbatim", () => {
    const pack = packOf(
      run({
        clauses: [
          row(ASVS_DOCUMENTED_RULES, {
            matrixCells: cells({ conclusive: 12, upheld: 12 }),
            reservations: ["endpoints-not-probed", "no-refusal-observed"],
          }),
        ],
      }),
    );

    expect(rowOf(pack, ASVS_DOCUMENTED_RULES).reservations).toEqual([
      "endpoints-not-probed",
      "no-refusal-observed",
    ]);
  });

  /**
   * Including a code this build has never heard of.
   *
   * A report from another vintage may carry a fifth reservation, and dropping it
   * would silently strengthen the claim on the row — the one direction a pack
   * must never move in. The same decision `toComparableRun` makes about a
   * relation it does not recognise.
   */
  it("carries a reservation this build does not know", () => {
    const pack = packOf(
      run({
        clauses: [
          row(ASVS_DOCUMENTED_RULES, {
            matrixCells: cells({ conclusive: 3, upheld: 3 }),
            reservations: ["a-reason-from-a-later-build"],
          }),
        ],
      }),
    );

    expect(rowOf(pack, ASVS_DOCUMENTED_RULES).reservations).toEqual([
      "a-reason-from-a-later-build",
    ]);
  });

  it("says out loud that upheld is not a statement about the whole surface", () => {
    expect(CLAIMS.upheld).toContain("says nothing about the cells this run did not reach");
    expect(CLAIMS.upheld).toContain("reservations");
  });

  /**
   * And a clause reached with nothing concluded is not upheld.
   *
   * `conclusive: 0` with cells counted is the state ADR-0052 built the whole
   * denominator for: the clause was asked about and every cell failed to answer
   * or was never asked.
   */
  it("is inconclusive where no cell concluded", () => {
    const pack = packOf(
      run({
        clauses: [
          row(ASVS_DOCUMENTED_RULES, {
            matrixCells: cells({ inconclusive: { "not-observed": 6, "probe-error": 2 } }),
          }),
        ],
      }),
    );

    expect(rowOf(pack, ASVS_DOCUMENTED_RULES).claim).toBe("inconclusive");
  });
});

describe("a clause the platform broke", () => {
  it("is breached from the cells, without a finding row in the file", () => {
    const pack = packOf(
      run({
        verdict: { code: 1, reason: "privilege escalation: 3 cells" },
        clauses: [
          row(ASVS_DOCUMENTED_RULES, {
            matrixCells: cells({ conclusive: 12, upheld: 9, breached: 3 }),
          }),
        ],
      }),
    );

    expect(rowOf(pack, ASVS_DOCUMENTED_RULES).claim).toBe("breached");
  });

  /**
   * And from a finding alone, where no coverage row exists.
   *
   * The case that decides whether this module is worth anything. A defect class
   * — API1, API5, CWE-285 — never gets a `coverage.clauses` row, because
   * `controlClausesForCell` deliberately credits a cell with controls and not
   * with defect classes (ADR-0052). It reaches a pack only through the finding
   * that cites it, and a pack reading `coverage.clauses` alone would print
   * "API1: unanswered" over a run that had just found broken object-level
   * authorization.
   */
  it("is breached from a finding that cites it", () => {
    const pack = packOf(
      run({
        verdict: { code: 1, reason: "privilege escalation: 1 cell" },
        findings: [
          finding({
            standards: [API_OBJECT_LEVEL_AUTHORIZATION, CWE_IMPROPER_AUTHORIZATION],
          }),
        ],
      }),
    );

    expect(rowOf(pack, API_OBJECT_LEVEL_AUTHORIZATION).claim).toBe("breached");
    expect(rowOf(pack, CWE_IMPROPER_AUTHORIZATION).claim).toBe("breached");
    expect(rowOf(pack, API_OBJECT_LEVEL_AUTHORIZATION).evidence.disagreements).toBe(1);
  });

  /**
   * A finding on a cell that learned nothing is not a breach.
   *
   * `not-observed` and `probe-error` cite the level clause on purpose — "ASVS
   * 8.2.2 was left unproved on 140 cells" has to reach the clause it is about —
   * and reading either as a disagreement would have the pack accuse a platform
   * of a hole on the strength of a request that never arrived.
   */
  it("is not breached by a cell that concluded nothing", () => {
    const pack = packOf(
      run({
        clauses: [row(ASVS_OBJECT_LEVEL_ACCESS, { matrixCells: cells() })],
        findings: [
          finding({ kind: "probe-error", severity: "low", standards: [ASVS_OBJECT_LEVEL_ACCESS] }),
          finding({ kind: "not-observed", severity: "low", standards: [ASVS_OBJECT_LEVEL_ACCESS] }),
        ],
      }),
    );
    const found = rowOf(pack, ASVS_OBJECT_LEVEL_ACCESS);

    expect(found.claim).toBe("inconclusive");
    expect(found.evidence).toEqual({
      disagreements: 0,
      heldByAcceptance: 0,
      other: 2,
      lowerBound: false,
    });
  });

  /**
   * And a kind this build has never heard of is a disagreement.
   *
   * The asymmetry, in the one place it is a judgement call. A matrix finding
   * whose kind is not one of the two that conclude nothing is counted as a
   * disagreement even when this build cannot name it, because the alternative is
   * a pack that reads an unrecognised finding as nothing found and reports the
   * clause upheld over a row that says otherwise.
   */
  it("is breached by a matrix kind from a later build", () => {
    const pack = packOf(
      run({
        verdict: { code: 1, reason: "something this build has no word for" },
        clauses: [row(ASVS_DOCUMENTED_RULES, { matrixCells: cells({ conclusive: 4, upheld: 4 }) })],
        findings: [
          finding({ kind: "a-kind-from-a-later-build", standards: [ASVS_DOCUMENTED_RULES] }),
        ],
      }),
    );

    expect(rowOf(pack, ASVS_DOCUMENTED_RULES).claim).toBe("breached");
  });

  /**
   * An acceptance does not make it go away, and the pack says how many.
   *
   * The whole objection to a suppression mechanism is that the counters stop
   * meaning what they say (ADR-0048). A pack is the artifact where that would
   * cost the most: a critical finding somebody signed for is exactly the thing
   * an evidence pack must not quietly drop.
   */
  it("stays breached under an acceptance, and counts the held rows", () => {
    const pack = packOf(
      run({
        findings: [
          finding({ standards: [ASVS_DOCUMENTED_RULES], heldByAcceptance: true }),
          finding({ standards: [ASVS_DOCUMENTED_RULES], heldByAcceptance: false }),
        ],
      }),
    );
    const found = rowOf(pack, ASVS_DOCUMENTED_RULES);

    expect(found.claim).toBe("breached");
    expect(found.evidence.disagreements).toBe(2);
    expect(found.evidence.heldByAcceptance).toBe(1);
  });

  /** And the counts say when they are floors rather than totals. */
  it("marks its evidence counts as a lower bound where the file was capped", () => {
    const pack = packOf(
      run({
        evidenceRowsOmitted: 51,
        findings: [finding({ standards: [ASVS_DOCUMENTED_RULES] })],
      }),
    );

    expect(rowOf(pack, ASVS_DOCUMENTED_RULES).evidence.lowerBound).toBe(true);
    expect(rowOf(pack, ASVS_TENANT_ISOLATION).evidence.lowerBound).toBe(true);
  });
});

describe("a clause only a check answered for", () => {
  it("says a check ran and reported nothing, which is not the same as nothing there", () => {
    const pack = packOf(
      run({
        clauses: [row(ASVS_TENANT_ISOLATION, { checkIds: ["identical-response-across-tenants"] })],
      }),
    );
    const found = rowOf(pack, ASVS_TENANT_ISOLATION);

    expect(found.claim).toBe("answered-without-findings");
    expect(found.checkIds).toEqual(["identical-response-across-tenants"]);
    expect(CLAIMS[found.claim]).toContain("no denominator");
  });

  /**
   * A check speaking at `info` has not found a disagreement.
   *
   * The threshold is `runVerdict`'s: `info` is the level a check uses to say
   * something without failing a build, and every other level is the platform and
   * a declaration disagreeing. Two thresholds for one principle is what ADR-0014
   * was written against; there is one here.
   */
  it("is not breached by a check speaking at info", () => {
    const pack = packOf(
      run({
        clauses: [row(ASVS_TENANT_ISOLATION, { checkIds: ["a-check"] })],
        findings: [
          finding({
            kind: "a-check",
            channel: "check",
            severity: "info",
            standards: [ASVS_TENANT_ISOLATION],
          }),
        ],
      }),
    );
    const found = rowOf(pack, ASVS_TENANT_ISOLATION);

    expect(found.claim).toBe("answered-without-findings");
    expect(found.evidence.other).toBe(1);
  });

  it("is breached by a check speaking above it", () => {
    const pack = packOf(
      run({
        verdict: { code: 1, reason: "1 found by the response body rather than by status" },
        clauses: [row(ASVS_TENANT_ISOLATION, { checkIds: ["a-check"] })],
        findings: [
          finding({
            kind: "a-check",
            channel: "check",
            severity: "medium",
            standards: [ASVS_TENANT_ISOLATION],
          }),
        ],
      }),
    );

    expect(rowOf(pack, ASVS_TENANT_ISOLATION).claim).toBe("breached");
  });
});

/**
 * A run that exited 2 describes the network, the deployment or its own
 * credentials — not the platform.
 *
 * The asymmetry is the decision: such a run may still report what it found, and
 * may not report a clause as upheld. A privilege escalation seen before the
 * budget ran out is still a privilege escalation, and a 200 under a token that
 * may be dead is worse rather than better; a 403 under the same token is a
 * refusal that says what an unauthenticated request says.
 */
describe("a run that could not be trusted", () => {
  const UNTRUSTED: PackableRun = run({
    verdict: {
      code: 2,
      reason: "the run was cut short: the tail of the matrix was never probed",
    },
    clauses: [
      row(ASVS_DOCUMENTED_RULES, {
        matrixCells: cells({ conclusive: 12, upheld: 12 }),
        reservations: ["run-truncated"],
      }),
      row(ASVS_OBJECT_LEVEL_ACCESS, {
        matrixCells: cells({ conclusive: 6, upheld: 5, breached: 1 }),
        reservations: ["run-truncated"],
      }),
      row(ASVS_TENANT_ISOLATION, { checkIds: ["identical-response-across-tenants"] }),
    ],
  });

  it("reports nothing as upheld", () => {
    const pack = packOf(UNTRUSTED);

    expect(pack.standing).toBe("withheld");
    expect(rowOf(pack, ASVS_DOCUMENTED_RULES).claim).toBe("withheld");
    expect(rowOf(pack, ASVS_TENANT_ISOLATION).claim).toBe("withheld");
    expect(pack.clauses.map((one) => one.claim)).not.toContain("upheld");
    expect(pack.clauses.map((one) => one.claim)).not.toContain("answered-without-findings");
  });

  it("still reports what it found", () => {
    expect(rowOf(packOf(UNTRUSTED), ASVS_OBJECT_LEVEL_ACCESS).claim).toBe("breached");
  });

  /** And keeps the numbers, which are facts about the run whatever it is worth. */
  it("keeps the cells and the reservations on the withheld rows", () => {
    const found = rowOf(packOf(UNTRUSTED), ASVS_DOCUMENTED_RULES);

    expect(found.cells?.conclusive).toBe(12);
    expect(found.reservations).toEqual(["run-truncated"]);
  });

  it("says at the top of the pack why, and in the run's own words", () => {
    const pack = packOf(UNTRUSTED);

    expect(pack.notes[0]).toBe(STANDINGS.withheld);
    expect(pack.run.verdict.reason).toContain("cut short");
  });

  /**
   * A code that is neither 0, 1 nor 2 is withheld as well.
   *
   * A report from a build with a fourth exit code, or a file somebody edited.
   * Reading anything unrecognised as trustworthy is the failure this whole
   * module is built against, so the standing is granted to the two known good
   * codes and to nothing else.
   */
  it("withholds a verdict code this build does not know", () => {
    const pack = packOf(run({ verdict: { code: 7, reason: "from somewhere else" } }));

    expect(pack.standing).toBe("withheld");
  });
});

describe("a clause the catalogue does not carry", () => {
  /**
   * A standard whose numbering may not be published is registered at run time on
   * the machine that holds it (ADR-0043). A pack built somewhere else from that
   * machine's report has the citation and no definition to resolve it against —
   * and dropping the row would lose a finding, while printing it as a catalogued
   * clause would invent a title and a boundary the pack does not have.
   */
  it("is kept apart, with no title invented for it", () => {
    const pack = packOf(
      run({
        verdict: { code: 1, reason: "privilege escalation: 1 cell" },
        clauses: [row({ standard: "GLI-19", clause: "4.2" }, { checkIds: ["a-private-check"] })],
        findings: [finding({ standards: [{ standard: "GLI-19", clause: "3.1" }] })],
      }),
    );

    expect(pack.clauses.some((one) => one.standard === "GLI-19")).toBe(false);
    expect(pack.outsideCatalogue.map((one) => `${one.standard} ${one.clause}`)).toEqual([
      "GLI-19 3.1",
      "GLI-19 4.2",
    ]);
    expect(pack.outsideCatalogue[0]).not.toHaveProperty("title");
  });

  it("still gets a claim, by the same rules", () => {
    const pack = packOf(
      run({
        verdict: { code: 1, reason: "privilege escalation: 1 cell" },
        clauses: [row({ standard: "GLI-19", clause: "4.2" }, { checkIds: ["a-private-check"] })],
        findings: [finding({ standards: [{ standard: "GLI-19", clause: "3.1" }] })],
      }),
    );

    expect(pack.outsideCatalogue.map((one) => one.claim)).toEqual([
      "breached",
      "answered-without-findings",
    ]);
  });
});

describe("the pack as a document is drawn from it", () => {
  it("names the standard, the boundary and the address on every catalogued row", () => {
    const pack = packOf(CLEAN);

    for (const clause of pack.clauses) {
      expect(clause.title.length).toBeGreaterThan(0);
      expect(clause.url).toMatch(/^https:\/\//);
      // The catalogue's own boundary, on the row and not once at the top: "8.2.3
      // is covered by nothing" read against an unstated boundary is a claim
      // about the whole standard. `UncoveredClause.scope` carries it for the
      // same reason.
      expect(clause.scope.length).toBeGreaterThan(0);
    }
  });

  /** And no requirement's own wording is reproduced anywhere in it. */
  it("carries the three standing limits of the method", () => {
    const pack = packOf(CLEAN);

    expect(pack.notes).toEqual([
      STANDINGS.evidence,
      DISCLAIMERS.declaration,
      DISCLAIMERS.blackBox,
      DISCLAIMERS.catalogue,
    ]);
    // ADR-0006 is the one that governs every row: the tool compares a platform
    // against a declaration a human wrote, and a pack that read as an
    // independent audit of correctness would be claiming what the tool never
    // performed.
    expect(DISCLAIMERS.declaration).toContain("declared by a human");
    expect(DISCLAIMERS.declaration).toContain("not an audit of");
  });

  it("carries the run's own warnings, which no reservation code covers", () => {
    const unnamed = "The target is unnamed: target has no label field.";
    const pack = packOf(run({ warnings: [unnamed] }));

    expect(pack.run.warnings).toEqual([unnamed]);
  });

  /**
   * And it does not carry its own raw material.
   *
   * The clause rows and the finding rows are what the pack digests into claims.
   * A document that carried both them and the rows built from them would be
   * stating one fact twice, free to disagree — which is the shape this
   * repository keeps finding in its own history.
   */
  it("does not carry the report's clause rows or finding rows twice", () => {
    const pack = packOf(CLEAN);

    expect(pack.run).not.toHaveProperty("clauses");
    expect(pack.run).not.toHaveProperty("findings");
  });

  /**
   * The order is the catalogue's own, so that two runs of one report produce the
   * same document on every machine (ADR-0036).
   */
  it("is in the catalogue's order, and sorts what the catalogue does not hold", () => {
    const pack = packOf(
      run({
        clauses: [
          row({ standard: "Z-STANDARD", clause: "2" }, { checkIds: ["z"] }),
          row({ standard: "A-STANDARD", clause: "9" }, { checkIds: ["a"] }),
          row({ standard: "A-STANDARD", clause: "10" }, { checkIds: ["a"] }),
        ],
      }),
    );

    expect(pack.clauses.slice(0, 3).map((one) => one.clause)).toEqual(["8.1.1", "8.1.3", "8.2.1"]);
    expect(pack.clauses.map((one) => one.standard).slice(-5)).toEqual([
      "CWE",
      "CWE",
      "CWE",
      "CWE",
      "CWE",
    ]);
    // By code units and not by anything numeric: "10" before "9" is what
    // `byCodeUnits` gives, and one order on every machine is the property.
    expect(pack.outsideCatalogue.map((one) => `${one.standard} ${one.clause}`)).toEqual([
      "A-STANDARD 10",
      "A-STANDARD 9",
      "Z-STANDARD 2",
    ]);
  });

  /**
   * Every claim the rules can produce has a sentence, and every sentence is
   * reachable.
   *
   * The second half is what makes the first worth asserting: a table with a
   * seventh entry nothing can produce is a sentence nobody will ever read, and a
   * status with no sentence is a document with a blank cell where an assertion
   * belongs.
   */
  it("can produce every claim in the table, and no claim outside it", () => {
    const produced = new Set(
      [
        ...packOf(CLEAN).clauses,
        ...packOf(
          run({
            verdict: { code: 1, reason: "privilege escalation: 1 cell" },
            clauses: [
              row(ASVS_OBJECT_LEVEL_ACCESS, { matrixCells: cells() }),
              row(ASVS_TENANT_ISOLATION, { checkIds: ["a-check"] }),
            ],
            findings: [finding({ standards: [ASVS_DOCUMENTED_RULES] })],
          }),
        ).clauses,
        ...packOf(run({ verdict: { code: 2, reason: "not a single cell was probed" } })).clauses,
      ].map((one) => one.claim),
    );

    expect([...produced].sort()).toEqual(Object.keys(CLAIMS).sort());
  });
});

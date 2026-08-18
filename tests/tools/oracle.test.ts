/**
 * Tests for the shared oracle comparison module.
 *
 * The module is load-bearing: every claim of the form 'zero discrepancies'
 * rests on it. A comparison that cannot fail confirms anything.
 */

import { describe, expect, it } from "vitest";
import type { GroundTruth, Variant } from "../../tools/oracle/index.mjs";
import {
  cellKey,
  checkCoverage,
  compareVariant,
  GroundTruthError,
  loadGroundTruth,
} from "../../tools/oracle/index.mjs";

const MINIMAL: GroundTruth = {
  defects: {
    "missing-filter": { title: "no filter", visibility: "status" },
  },
  variants: [
    {
      id: "clean",
      selector: { FLAG: false },
      expectedExitCode: 0,
      expectedCells: 1,
      findings: [],
    },
    {
      id: "broken",
      selector: { FLAG: true },
      expectedExitCode: 1,
      expectedCells: 1,
      findings: [
        {
          account: "alice",
          endpoint: "orders.read",
          resource: "o-1",
          kind: "privilege-escalation",
          defects: ["missing-filter"],
        },
      ],
    },
  ],
};

function sourceOf(patch: (value: GroundTruth) => unknown): string {
  return JSON.stringify(patch(structuredClone(MINIMAL)));
}

describe("loadGroundTruth", () => {
  it("accepts a valid oracle", () => {
    expect(loadGroundTruth(JSON.stringify(MINIMAL)).variants).toHaveLength(2);
  });

  it("rejects unparseable JSON", () => {
    expect(() => loadGroundTruth("{not json")).toThrow(GroundTruthError);
  });

  /**
   * Visibility is mandatory: a defect without it cannot be told from a
   * forgotten one, and that is exactly the distinction ADR-0012 introduced.
   */
  it("rejects a defect with no declared visibility", () => {
    const source = sourceOf((value) => ({
      ...value,
      defects: { "missing-filter": { title: "no filter" } },
    }));

    expect(() => loadGroundTruth(source)).toThrow(/visibility/);
  });

  it("rejects an unknown visibility value", () => {
    const source = sourceOf((value) => ({
      ...value,
      defects: { "missing-filter": { visibility: "maybe" } },
    }));

    expect(() => loadGroundTruth(source)).toThrow(GroundTruthError);
  });

  /** An oracle referring to a defect that does not exist will confirm anything. */
  it("rejects a finding that refers to a non-existent defect", () => {
    const source = sourceOf((value) => ({
      ...value,
      variants: value.variants.map((variant) =>
        variant.id === "broken"
          ? { ...variant, findings: [{ ...variant.findings[0], defects: ["typo-in-the-id"] }] }
          : variant,
      ),
    }));

    expect(() => loadGroundTruth(source)).toThrow(/out of sync with itself/);
  });

  /**
   * A finding with no defect is either a forgotten defect or a mistake in the
   * oracle. Accepted silently, it makes the coverage check meaningless.
   */
  it("rejects a finding with no defect at all", () => {
    const source = sourceOf((value) => ({
      ...value,
      variants: value.variants.map((variant) =>
        variant.id === "broken"
          ? { ...variant, findings: [{ ...variant.findings[0], defects: [] }] }
          : variant,
      ),
    }));

    expect(() => loadGroundTruth(source)).toThrow(/has no defect/);
  });

  it("rejects a duplicate variant identifier", () => {
    const source = sourceOf((value) => ({
      ...value,
      variants: [value.variants[0], value.variants[0]],
    }));

    expect(() => loadGroundTruth(source)).toThrow(/more than once/);
  });

  it("rejects an empty list of variants", () => {
    expect(() => loadGroundTruth(sourceOf((value) => ({ ...value, variants: [] })))).toThrow(
      GroundTruthError,
    );
  });
});

describe("checkCoverage", () => {
  /**
   * Nested defects: the cells of one are a subset of the cells of another. The
   * shared cell is explained by both, and without this the narrower case would
   * look untestable. Found while migrating the platform's oracle: PARENT_LEAK
   * counted as uncovered because all of its cells belonged to ANCESTOR_LEAK too.
   */
  it("credits a defect that explains a cell on par with another", () => {
    const nested: GroundTruth = {
      defects: {
        "whole-chain": { visibility: "status" },
        "one-step": { visibility: "status" },
      },
      variants: [
        {
          id: "both",
          selector: {},
          expectedExitCode: 1,
          expectedCells: 1,
          findings: [
            {
              account: "a",
              endpoint: "e",
              kind: "privilege-escalation",
              defects: ["whole-chain", "one-step"],
            },
          ],
        },
      ],
    };

    expect(checkCoverage(nested)).toEqual([]);
  });

  it("stays silent when every visible defect is expected somewhere", () => {
    expect(checkCoverage(MINIMAL)).toEqual([]);
  });

  /** A forgotten variant and a wrong visibility mark look the same. */
  it("spots a visible defect expected in no variant at all", () => {
    const withOrphan: GroundTruth = {
      ...MINIMAL,
      defects: { ...MINIMAL.defects, forgotten: { visibility: "status" } },
    };

    expect(checkCoverage(withOrphan)).toEqual([
      expect.stringContaining("forgotten") as unknown as string,
    ]);
  });

  /** The reason for unreachability varies, the consequence does not: it must not be in the findings. */
  it("spots the contradiction: an unreachable defect is expected in the findings", () => {
    const contradictory: GroundTruth = {
      ...MINIMAL,
      defects: { "missing-filter": { visibility: "unsafe-method" } },
    };

    expect(checkCoverage(contradictory)[0]).toMatch(/unreachable/);
  });
});

describe("cellKey", () => {
  it("keys an oracle entry and a tool finding identically", () => {
    const fromOracle = cellKey({
      account: "alice",
      endpoint: "orders.read",
      resource: "o-1",
      kind: "privilege-escalation",
    });
    const fromReport = cellKey({
      accountId: "alice",
      endpointId: "orders.read",
      resourceId: "o-1",
      kind: "privilege-escalation",
    });

    expect(fromOracle).toBe(fromReport);
  });

  /** For a check finding the third coordinate is the second account of the pair, not a resource. */
  it("keys a check finding by the second account of the pair", () => {
    const fromOracle = cellKey({
      account: "alice",
      endpoint: "orders.list",
      other: "carol",
      kind: "identical-response-across-tenants",
    });
    const fromReport = cellKey({
      accountId: "alice",
      endpointId: "orders.list",
      evidence: { otherAccountId: "carol" },
      checkId: "identical-response-across-tenants",
    });

    expect(fromOracle).toBe(fromReport);
  });
});

describe("compareVariant", () => {
  const broken = MINIMAL.variants[1] as Variant;
  /**
   * A whole report rather than the two fields the key is built from.
   *
   * `compareVariant` now also checks the report against itself — the counters
   * against the body, the defect signatures against the findings' — because the
   * oracle was blind to everything but which cells were broken, and three
   * mutations that gutted the aggregation passed it. A stub with no summary
   * would make that half of the comparison vacuous here, which is the very shape
   * of problem it exists to catch.
   */
  const matching = {
    findings: [
      {
        accountId: "alice",
        endpointId: "orders.read",
        resourceId: "o-1",
        kind: "privilege-escalation",
        source: "matrix",
      },
    ],
    observations: [{ accountId: "alice", endpointId: "orders.read" }],
    defects: [
      {
        key: "orders.read any-resource baseline",
        endpointId: "orders.read",
        // `kinds`, since the signature stopped carrying the kind: a defect is
        // not the channel that found it, and a group names every way its cells
        // were found broken. See ADR-0030.
        kinds: ["privilege-escalation"],
        severity: "high",
        accountIds: ["alice"],
        resourceIds: ["o-1"],
        violations: 1,
      },
    ],
    summary: {
      findings: 1,
      observations: 1,
      checkFindings: 0,
      defectGroups: 1,
      bySeverity: { info: 0, low: 0, medium: 0, high: 1, critical: 0 },
      byKind: { "privilege-escalation": 1 },
    },
  };

  it("stays silent on a full match", () => {
    expect(compareVariant(broken, matching, 1).problems).toEqual([]);
  });

  it("spots a missing finding", () => {
    const result = compareVariant(broken, { findings: [], checks: [] }, 1);

    expect(result.missing).toHaveLength(1);
    expect(result.problems[0]).toMatch(/not found/);
  });

  it("spots a finding beyond the oracle", () => {
    const result = compareVariant(MINIMAL.variants[0] as Variant, matching, 0);

    expect(result.unexpected).toHaveLength(1);
    expect(result.problems[0]).toMatch(/beyond the ground truth/);
  });

  /**
   * A count of findings alone is not enough: a miss and an extra in equal
   * numbers cancel each other out, and the counter matches on a complete
   * mismatch.
   */
  it("spots the mutual cancellation a counter would miss", () => {
    const wrongCell = {
      findings: [
        {
          accountId: "bob",
          endpointId: "orders.read",
          resourceId: "o-1",
          kind: "privilege-escalation",
        },
      ],
      checks: [],
    };

    const result = compareVariant(broken, wrongCell, 1);

    expect(wrongCell.findings).toHaveLength(broken.findings.length);
    expect(result.missing).toHaveLength(1);
    expect(result.unexpected).toHaveLength(1);
  });

  it("spots a mismatched exit code", () => {
    expect(compareVariant(broken, matching, 0).problems[0]).toMatch(/exit code/);
  });

  /** There may be no findings simply because the run never reached them. */
  it("does not count a run cut short as a match", () => {
    const result = compareVariant(
      MINIMAL.variants[0] as Variant,
      {
        findings: [],
        checks: [],
        // One cell, because the variant declares one. Without it the size check
        // fires first and hides the problem each of these cases is about — which
        // is right for a real report and wrong for a fixture pretending to be one.
        observations: [{ accountId: "alice", endpointId: "orders.read" }],
        truncated: true,
      },
      0,
    );

    expect(result.problems[0]).toMatch(/cut short/);
  });

  /**
   * A check named in the report has to say what it asserts and which clauses it
   * answers for.
   *
   * Both fields were declared on `Check`, filled by the one check in the tree,
   * and dropped by the mapping that built `coverage.checksRun` — `standards`
   * until 15 August, `description` until 17 August (L-8). A reader of the saved
   * artifact got an identifier and nothing else, which is not an evidence pack.
   * The unit suite cannot see this: it is a property of what the binary writes,
   * so it is asserted where the binary's output is read.
   */
  it("does not count a run whose checks describe themselves to nobody", () => {
    const clean = MINIMAL.variants[0] as Variant;
    const withCheck = (check: Readonly<Record<string, unknown>>) => ({
      findings: [],
      // One cell, because the variant declares one — see the note above. The
      // summary counts it too, since the oracle checks the report against itself.
      observations: [{ accountId: "alice", endpointId: "orders.read" }],
      defects: [],
      summary: {
        findings: 0,
        observations: 1,
        checkFindings: 0,
        defectGroups: 0,
        bySeverity: {},
        byKind: {},
      },
      coverage: { checksRun: [check] },
    });

    expect(
      compareVariant(
        clean,
        withCheck({
          id: "identical-response-across-tenants",
          description: "digests matched across tenants",
          standards: [{ standard: "OWASP-API-2023", clause: "API1" }],
        }),
        0,
      ).problems,
    ).toEqual([]);

    expect(
      compareVariant(
        clean,
        withCheck({
          id: "identical-response-across-tenants",
          standards: [{ standard: "OWASP-API-2023", clause: "API1" }],
        }),
        0,
      ).problems.join("\n"),
    ).toMatch(/says nothing about what it asserts/);

    expect(
      compareVariant(
        clean,
        withCheck({ id: "identical-response-across-tenants", description: "" }),
        0,
      ).problems.join("\n"),
    ).toMatch(/names no clause[\s\S]*says nothing/);
  });

  it("does not count a run with unauthenticated accounts as a match", () => {
    const result = compareVariant(
      MINIMAL.variants[0] as Variant,
      {
        findings: [],
        checks: [],
        // One cell, because the variant declares one. Without it the size check
        // fires first and hides the problem each of these cases is about — which
        // is right for a real report and wrong for a fixture pretending to be one.
        observations: [{ accountId: "alice", endpointId: "orders.read" }],
        unauthenticated: ["alice"],
      },
      0,
    );

    expect(result.problems[0]).toMatch(/no access anywhere/);
  });
});

/**
 * The size of the matrix, which the comparison of findings cannot see.
 *
 * Everything else in `compareVariant` compares **sets of cells a finding is
 * expected on**, so a cell nobody expects a finding on is outside the comparison
 * entirely. On the reference platform that is some 34 cells of 144: the anonymous
 * account, `health`, `affiliate.stats`, and the accounts under `wide-scope` are
 * named in no variant's findings.
 *
 * Demonstrated on 18 August 2026 by adversarial review: one line dropping the
 * anonymous account from every run left `tsc` clean, 859 tests green, and this
 * gate reporting 28 combinations and 0 mismatches, with the matrix down from 144
 * cells to 128. The account whose entire purpose is the claim "this endpoint is
 * not public" stopped being asked, and the strongest gate in the project said
 * nothing.
 */
describe("the number of cells a variant must probe", () => {
  const clean = MINIMAL.variants[0] as Variant;

  it("is a mismatch when the matrix shrank, even with every finding still right", () => {
    const result = compareVariant(clean, { findings: [], observations: [] }, 0);

    expect(result.problems[0]).toMatch(/probed 0 cells, expected 1/);
    // And says why a finding comparison could not have caught it.
    expect(result.problems[0]).toMatch(/cannot see that/);
  });

  it("is a mismatch when the matrix grew", () => {
    const result = compareVariant(
      clean,
      {
        findings: [],
        observations: [
          { accountId: "a", endpointId: "e" },
          { accountId: "b", endpointId: "e" },
        ],
      },
      0,
    );

    expect(result.problems[0]).toMatch(/probed 2 cells, expected 1/);
  });

  /**
   * And the ground truth may not omit the number: a variant added without it
   * would be one the gate cannot measure, which is the state this closes.
   */
  it("must be declared by every variant", () => {
    const source = sourceOf((value) => ({
      ...value,
      variants: value.variants.map(({ expectedCells: _dropped, ...rest }) => rest),
    }));

    expect(() => loadGroundTruth(source)).toThrow(/expectedCells/);
  });

  it("must be a positive integer", () => {
    for (const bad of [0, -1, 1.5, "144"]) {
      const source = sourceOf((value) => ({
        ...value,
        variants: value.variants.map((variant) => ({ ...variant, expectedCells: bad })),
      }));

      expect(() => loadGroundTruth(source)).toThrow(GroundTruthError);
    }
  });
});

/**
 * The report's evidence rows are capped per defect, and its counts are not.
 *
 * The isolation check compares accounts pairwise, so on an endpoint that leaks
 * to everybody it emits one row per pair — quadratic in accounts, while the one
 * guard that bounds a run is linear in them: `--max-requests` defaults to 2 000,
 * and 2 000 accounts on a single endpoint is 2 000 requests and 1 999 000 rows.
 * Measured on 17 August 2026, at which size `JSON.stringify` throws `RangeError:
 * Invalid string length` — the walk finishes, the checks finish, and the run is
 * then lost at its last step to an error naming a string length.
 *
 * The rows are also redundant at that size: the report already collapses all of
 * them into one defect group. So the cap keeps the evidence a reader uses and
 * drops the part they never reach, and every number in the file is computed
 * before it applies. That last clause is what most of this file is about — a cap
 * that quietly changed `summary.findings` would turn an abridged report into a
 * false one.
 *
 * Found by measuring for I-5 and I-6, which the audit of 14 August 2026 left as
 * "nothing to measure against until somebody runs it at that size". See
 * ADR-0029.
 */

import { describe, expect, it } from "vitest";
import type { ResolvedFinding } from "../../src/core/checks/types.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { BuildReportOptions } from "../../src/report/build.js";
import { buildReport, MAX_ROWS_PER_DEFECT, WARNINGS } from "../../src/report/build.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: alice, role: user, tenant: t-a, tokenEnv: A }
  - { id: carol, role: user, tenant: t-b, tokenEnv: C }
policy: { fallback: allowed, rules: [] }
`);

const ENDPOINTS = [
  { id: "orders.list", method: "GET" as const, path: "/v1/orders" },
  { id: "cards.list", method: "GET" as const, path: "/v1/cards" },
];

/**
 * One leak, seen `count` times on one endpoint.
 *
 * Written out by hand rather than driven through the isolation check: what is
 * under test is what the report does with many rows of one shape, and a fixture
 * produced by the check would tie this file to the check's own arithmetic.
 */
function leaks(count: number, endpointId = "orders.list"): readonly ResolvedFinding[] {
  return Array.from({ length: count }, (_, index) => ({
    checkId: "identical-response-across-tenants",
    severity: "high" as const,
    title: `digest matched (${index})`,
    endpointId,
    accountId: "alice",
    relatedAccountId: "carol",
    evidence: { bodyDigestsEqual: true },
  }));
}

function build(checks: readonly ResolvedFinding[]) {
  const options: BuildReportOptions = {
    version: "test",
    config: CONFIG,
    endpoints: ENDPOINTS,
    observations: [
      {
        endpointId: "orders.list",
        accountId: "alice",
        status: 200,
        headers: {},
        outcome: "allowed",
        durationMs: 1,
      },
    ],
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 1,
    truncated: false,
    findings: [],
    checks,
    policy: { fallback: "allowed", rules: [] },
    startedAt: new Date(0),
    finishedAt: new Date(1),
  };
  return buildReport(options);
}

describe("a run whose evidence fits", () => {
  it("keeps every row and says nothing was left out", () => {
    const report = build(leaks(3));

    expect(report.findings).toHaveLength(3);
    expect(report.findingsOmitted).toBe(0);
    expect(report.warnings).not.toContain(WARNINGS.findingsCapped);
  });

  /** Exactly at the cap is still "it all fits" — an off-by-one here would warn
   * about an abridgement that did not happen. */
  it("keeps a defect that lands exactly on the cap", () => {
    const report = build(leaks(MAX_ROWS_PER_DEFECT));

    expect(report.findings).toHaveLength(MAX_ROWS_PER_DEFECT);
    expect(report.findingsOmitted).toBe(0);
  });
});

describe("a defect seen more times than the file will hold", () => {
  const produced = MAX_ROWS_PER_DEFECT * 4;
  const report = build(leaks(produced));

  it("writes the cap and counts the rest", () => {
    expect(report.findings).toHaveLength(MAX_ROWS_PER_DEFECT);
    expect(report.findingsOmitted).toBe(produced - MAX_ROWS_PER_DEFECT);
  });

  /**
   * The identity a reader needs to trust the two numbers together. Without it
   * `findings.length` reads as the count of what was found, and the file says
   * fewer problems than the run had.
   */
  it("leaves rows plus omitted equal to what was found", () => {
    expect(report.findings.length + report.findingsOmitted).toBe(report.summary.findings);
  });

  /** The whole point: the verdict is the one an uncapped file would carry. */
  it("counts every finding in the summary, not the ones it printed", () => {
    expect(report.summary.findings).toBe(produced);
    expect(report.summary.bySeverity.high).toBe(produced);
    expect(report.summary.byKind["identical-response-across-tenants"]).toBe(produced);
  });

  it("groups them into the one defect they are", () => {
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]?.violations).toBe(produced);
  });

  it("keeps the exit code an uncapped report would have given", () => {
    expect(report.verdict.code).toBe(1);
  });

  /**
   * And says so where a reader looking at the array will see it. The field alone
   * only helps somebody who already knows the cap exists.
   */
  it("warns that the file is abridged", () => {
    expect(report.warnings).toContain(WARNINGS.findingsCapped);
  });
});

/**
 * The cap must not reach the verdict. It did.
 *
 * `runVerdict` derived its counts by filtering `findings`, and on the day this
 * cap was written that array became the capped one — so the numerator was bounded
 * at fifty per defect while its denominator, `summary.observations`, was not.
 * **101 cells that all failed to answer exited 0.** Reachable inside the default
 * `--max-requests 2000`, and shipped in 0.3.0: the ADR asserted the verdict was
 * unchanged, `docs/report.md` promised the same in so many words, and neither was
 * true. Found by adversarial review on 17 August 2026, hours after the cap landed.
 *
 * The counts now travel in `summary.verdictInputs`, taken before the cap and
 * separated by source — `summary.byKind` could not serve, because it holds check
 * identifiers and matrix kinds in one key space (B-4).
 */
describe("a run where nothing answered, with more cells than the cap", () => {
  const failing = (count: number): readonly ResolvedFinding[] =>
    Array.from({ length: count }, (_, index) => ({
      checkId: "unused",
      severity: "high" as const,
      title: "unused",
      endpointId: "orders.list",
      accountId: `a-${index}`,
      evidence: {},
    }));

  it("is untrustworthy, whatever the cap left in the file", () => {
    const produced = MAX_ROWS_PER_DEFECT * 2 + 1;
    const observations = Array.from({ length: produced }, (_, index) => ({
      endpointId: "orders.list",
      accountId: `a-${index}`,
      status: 0,
      headers: {},
      outcome: "error" as const,
      durationMs: 1,
    }));
    const report = buildReport({
      version: "test",
      config: CONFIG,
      endpoints: ENDPOINTS,
      observations,
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 1,
      truncated: false,
      findings: observations.map((one) => ({
        accountId: one.accountId,
        endpointId: one.endpointId,
        expected: "allowed" as const,
        kind: "probe-error" as const,
        severity: "high" as const,
      })),
      policy: { fallback: "allowed", rules: [] },
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });

    // The cap did fire — this is the state the defect needed.
    expect(report.findingsOmitted).toBeGreaterThan(0);
    expect(report.findings.length).toBeLessThan(report.summary.findings);

    expect(report.summary.verdictInputs.matrixByKind["probe-error"]).toBe(produced);
    expect(report.verdict.code).toBe(2);
    expect(report.verdict.reason).toContain("failed to answer");
  });

  /** And the check channel is counted the same way, above `info`. */
  it("counts failing check findings before the cap too", () => {
    const report = build(failing(MAX_ROWS_PER_DEFECT * 3));

    expect(report.findingsOmitted).toBeGreaterThan(0);
    expect(report.summary.verdictInputs.failingCheckFindings).toBe(MAX_ROWS_PER_DEFECT * 3);
    expect(report.verdict.reason).toContain(String(MAX_ROWS_PER_DEFECT * 3));
  });
});

describe("the cap is spent per defect, not first-come", () => {
  /**
   * The reason it is keyed on the defect signature. Under a flat first-N cap the
   * endpoint that leaks to everybody spends the whole budget, and the second
   * defect — the rarer one, and so the more interesting — arrives in the file
   * with no evidence at all, listed in `defects` and citable from nothing.
   */
  it("leaves the rare defect its evidence", () => {
    const report = build([
      ...leaks(MAX_ROWS_PER_DEFECT * 10, "orders.list"),
      ...leaks(2, "cards.list"),
    ]);

    const rare = report.findings.filter((one) => one.endpointId === "cards.list");
    const loud = report.findings.filter((one) => one.endpointId === "orders.list");

    expect(rare).toHaveLength(2);
    expect(loud).toHaveLength(MAX_ROWS_PER_DEFECT);
    expect(report.defects).toHaveLength(2);
  });

  /**
   * And per kind within a defect, which is the same argument one level down.
   *
   * ADR-0030 took the kind out of the defect signature on the same day this cap
   * was written, so one budget of fifty came to be shared by every kind on an
   * endpoint — and findings are sorted by severity, so the heavier kind spent it
   * first. A defect with three `unexpected-denial` rows reached the file with
   * none of them, under a warning promising that each defect keeps its own
   * examples. Two changes of one day, and the interaction was in neither.
   */
  it("leaves the quieter kind its evidence on a loud endpoint", () => {
    const escalations = Array.from({ length: MAX_ROWS_PER_DEFECT * 2 }, (_, index) => ({
      accountId: `a-${index}`,
      endpointId: "orders.list",
      expected: "denied" as const,
      actual: "allowed" as const,
      kind: "privilege-escalation" as const,
      severity: "high" as const,
    }));
    const denials = [0, 1, 2].map((index) => ({
      accountId: `d-${index}`,
      endpointId: "orders.list",
      expected: "allowed" as const,
      actual: "denied" as const,
      kind: "unexpected-denial" as const,
      severity: "medium" as const,
    }));

    const report = buildReport({
      version: "test",
      config: CONFIG,
      endpoints: ENDPOINTS,
      observations: [],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 1,
      truncated: false,
      findings: [...escalations, ...denials],
      policy: { fallback: "denied", rules: [] },
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });

    const kinds = report.findings.map((one) => one.kind);

    expect(kinds.filter((one) => one === "privilege-escalation")).toHaveLength(MAX_ROWS_PER_DEFECT);
    expect(kinds.filter((one) => one === "unexpected-denial")).toHaveLength(3);
    // Still one defect: the grouping is unchanged, only the budget is per kind.
    expect(report.defects).toHaveLength(1);
    expect(report.defects[0]?.kinds).toEqual(["privilege-escalation", "unexpected-denial"]);
  });
});

/**
 * One verdict per cell, from both channels.
 *
 * Found by the audit of 14 August 2026. Two things judge a cell: the walk over
 * the matrix, by status code, and the checks over response bodies. Only the
 * first reached `match`, so a cell could be printed as agreed and appear in
 * `findings` at the same time — twelve of them did on the reference run with
 * every defect switched on. `docs/report.md` states the opposite in as many
 * words, and offers the reader two arithmetic self-checks that both came out
 * wrong.
 *
 * The direction of the fix is not arbitrary. `responseMustDifferByTenant` is a
 * declaration a human wrote in the same configuration as the policy, so a cell
 * where the bodies did not differ has not "agreed with what was declared".
 */

import { describe, expect, it } from "vitest";
import type { ResolvedFinding } from "../../src/core/checks/types.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { BuildReportOptions } from "../../src/report/build.js";
import { buildReport } from "../../src/report/build.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: alice, role: r, tenant: t-a, tokenEnv: T }
  - { id: carol, role: r, tenant: t-b, tokenEnv: T }
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], outcome: allowed }
`);

/**
 * A leak the status code cannot show: both accounts were legitimately allowed.
 *
 * The counterpart is in `relatedAccountId`, which is where a check puts it since
 * ADR-0025. It sat in `evidence.otherAccountId` here until 17 August — the
 * undocumented contract between layers that ADR replaced — so this fixture had
 * stopped being a finding the tool produces, and the assertion below that carol's
 * cell is clean was true of nothing.
 */
const LEAK: ResolvedFinding = {
  checkId: "identical-response-across-tenants",
  severity: "high",
  accountId: "alice",
  relatedAccountId: "carol",
  endpointId: "orders.list",
  title: "the same response for different tenants",
  evidence: { bodyDigestsEqual: true },
};

function optionsFor(overrides: Partial<BuildReportOptions> = {}): BuildReportOptions {
  return {
    version: "test",
    config: CONFIG,
    endpoints: [{ id: "orders.list", method: "GET", path: "/orders" }],
    observations: [
      {
        accountId: "alice",
        endpointId: "orders.list",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
      },
      {
        accountId: "carol",
        endpointId: "orders.list",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
      },
    ],
    // Both cells agree with the policy: access was declared allowed and allowed
    // is what happened. By status code there is nothing here.
    cells: [
      {
        accountId: "alice",
        endpointId: "orders.list",
        expected: "allowed",
        basis: "rule" as const,
        actual: "allowed",
        match: true,
      },
      {
        accountId: "carol",
        endpointId: "orders.list",
        expected: "allowed",
        basis: "rule" as const,
        actual: "allowed",
        match: true,
      },
    ],
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 2,
    truncated: false,
    findings: [],
    checks: [LEAK],
    policy: { fallback: "allowed", rules: [] },
    startedAt: new Date(0),
    finishedAt: new Date(1),
    ...overrides,
  };
}

function build(overrides: Partial<BuildReportOptions> = {}) {
  return buildReport(optionsFor(overrides));
}

describe("a cell that carries a finding is not printed as agreed", () => {
  /**
   * The whole finding in one line. Before the fix this expectation read
   * `toBe(true)` — the walk's verdict verbatim — while the same cell sat in
   * `findings` with a high-severity leak.
   */
  it("does not call a cell agreed when a check found something on it", () => {
    const alice = build().observations.find((o) => o.accountId === "alice");

    expect(alice?.match).toBe(false);
    // The row itself is untouched: the expectation was met, by status code
    // nothing happened here. That is exactly why the verdict needs a reason
    // beside it.
    expect(alice?.expected).toBe("allowed");
    expect(alice?.outcome).toBe("allowed");
    expect(alice?.status).toBe(200);
  });

  /**
   * Without this the row is unreadable: expectation `allowed`, outcome
   * `allowed`, status 200, and `match: false` with nothing saying why. A reader
   * would take it for a bug in the tool, which is a worse failure than the one
   * being fixed.
   */
  it("names the kinds recorded against the cell", () => {
    const alice = build().observations.find((o) => o.accountId === "alice");

    expect(alice?.findingKinds).toEqual(["identical-response-across-tenants"]);
  });

  /**
   * And the other side of the pair, which is the cell that actually received a
   * tenant's data that is not its own.
   *
   * A leak found by body is a statement about **two** cells. The loop read only
   * `accountId`, so carol's cell — the one holding alice's tenant's data — went
   * out as `match: true`, "tested and agreed", and into `coverage.cellsMatched`.
   * On the reference run with every defect on there were twelve such cells: the
   * same number `docs/report.md` quotes for the defect ADR-0022 closed on
   * 15 August, which taught this loop to read check findings and left it reading
   * one end of them. Found by adversarial review on 17 August 2026.
   */
  it("does not call the other side of a paired leak agreed either", () => {
    const carol = build().observations.find((o) => o.accountId === "carol");

    expect(carol?.match).toBe(false);
    expect(carol?.findingKinds).toEqual(["identical-response-across-tenants"]);
  });

  /** A cell nothing was found on keeps saying so. */
  it("leaves a genuinely clean cell alone", () => {
    const clean = build({
      checks: [],
    }).observations.find((o) => o.accountId === "carol");

    expect(clean?.match).toBe(true);
    expect(clean).not.toHaveProperty("findingKinds");
  });
});

describe("the arithmetic docs/report.md offers the reader", () => {
  /**
   * `cellsMatched + cellsWithFindings === cellsObserved`. The documented
   * identity used to be stated over `summary.findings`, and it failed twice
   * over: the verdict ignored the check channel, and findings are rows while
   * cells are cells.
   */
  it("adds up", () => {
    const coverage = build().coverage;

    // Two, not one: a leak found by body is a statement about a pair, and both
    // cells carry it. Until 17 August this read `cellsMatched: 1` — the identity
    // held, and the cell that received another tenant's data was on the wrong
    // side of it.
    expect(coverage.cellsObserved).toBe(2);
    expect(coverage.cellsMatched).toBe(0);
    expect(coverage.cellsWithFindings).toBe(2);
    expect((coverage.cellsMatched ?? 0) + (coverage.cellsWithFindings ?? 0)).toBe(
      coverage.cellsObserved,
    );
  });

  /**
   * Two findings, one cell. `summary.findings` counts two, and the identity
   * still has to hold — which is the reason the counter is over cells and not
   * a rename of the existing number.
   */
  it("counts a cell once however many findings it carries", () => {
    const second: ResolvedFinding = {
      ...LEAK,
      checkId: "response-count-differs",
      severity: "medium",
    };
    const built = build({ checks: [LEAK, second] });
    const alice = built.observations.find((o) => o.accountId === "alice");

    // Two findings over the same pair: two rows, two cells, and each cell counted
    // once however many rows name it — which is what this counter is for.
    expect(built.summary.findings).toBe(2);
    expect(built.coverage.cellsWithFindings).toBe(2);
    expect((built.coverage.cellsMatched ?? 0) + (built.coverage.cellsWithFindings ?? 0)).toBe(
      built.coverage.cellsObserved,
    );
    // Sorted, so the field is stable between runs and diffable between reports.
    expect(alice?.findingKinds).toEqual([
      "identical-response-across-tenants",
      "response-count-differs",
    ]);
  });

  /**
   * Half of an identity is worse than none of it: a reader who found one of the
   * two numbers would add it to `summary.findings` again.
   */
  it("withholds both numbers when no verdicts were counted", () => {
    // `cells` left out entirely rather than set to undefined: the option is
    // absent in a run that computed no verdicts, and that is the case under test.
    const { cells: _cells, ...withoutVerdicts } = optionsFor();
    const coverage = buildReport(withoutVerdicts).coverage;

    expect(coverage).not.toHaveProperty("cellsMatched");
    expect(coverage).not.toHaveProperty("cellsWithFindings");
  });
});

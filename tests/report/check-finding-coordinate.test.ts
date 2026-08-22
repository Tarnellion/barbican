/**
 * A check finding names the whole cell, or the report says the cell agreed.
 *
 * A cell is account × endpoint × resource × conditions. `Finding` carried the
 * first two and the fourth, so `withVerdicts` and `withRequest` — which look an
 * observation up by the whole key — missed on every finding about an object: the
 * cell came out `match: true` with a finding standing on it, counted in
 * `cellsMatched`, and the defect group carried an empty `resourceIds`.
 *
 * Third time this class was closed. ADR-0022 closed it for the walk, when twelve
 * cells of a reference run were printed as agreed while carrying a high-severity
 * leak; `relatedAccountId` closed it for the other side of a pair, which used to
 * travel in `evidence` as a convention nobody wrote down. The registry has one
 * check today and it judges whole endpoints, so this half stayed latent — until
 * the first check of Module 2 that judges an object, which is a BOLA read
 * against a body and is the obvious first one to write.
 *
 * See ADR-0039 and the audit of 20 August 2026 (D-3).
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
policy:
  fallback: allowed
  rules: []
resources:
  - { id: order-b, tenant: t-b, params: { orderId: "2001" } }
`);

/** A leak found by reading the body of one object, which the status cannot show. */
const BOLA: ResolvedFinding = {
  checkId: "identical-response-across-tenants",
  severity: "high",
  accountId: "alice",
  endpointId: "orders.read",
  resourceId: "order-b",
  relation: "foreign-tenant",
  title: "alice was served the body of somebody else's order",
  evidence: { bodyDigestsEqual: true },
};

function build(finding: ResolvedFinding) {
  const options: BuildReportOptions = {
    version: "test",
    config: CONFIG,
    endpoints: [{ id: "orders.read", method: "GET", path: "/orders/{orderId}" }],

    observations: [
      {
        accountId: "alice",
        endpointId: "orders.read",
        resourceId: "order-b",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
        url: "https://a.test/orders/2001",
        method: "GET",
      },
    ],
    // The status agreed with the policy: by the walk alone this cell is clean,
    // and the whole question is whether the check's finding reaches it.
    cells: [
      {
        accountId: "alice",
        endpointId: "orders.read",
        resourceId: "order-b",
        expected: "allowed",
        basis: "fallback" as const,
        actual: "allowed",
        match: true,
      },
    ],
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 1,
    canaries: [{ accountId: "alice", endpointId: "orders.read", status: 200, authenticated: true }],
    truncated: false,
    findings: [],
    checks: [finding],
    policy: { fallback: "allowed", rules: [] },
    startedAt: new Date(0),
    finishedAt: new Date(1),
  };
  return buildReport(options);
}

describe("a check finding about a resource", () => {
  it("takes the cell out of `match: true`", () => {
    const report = build(BOLA);
    const cell = report.observations.find((one) => one.resourceId === "order-b");

    expect(cell?.match).toBe(false);
    expect(cell?.findingKinds).toContain("identical-response-across-tenants");
  });

  /** The counters follow the cell, and a reader is told to add these two up. */
  it("is counted as a cell with a finding, not as a cell that agreed", () => {
    const report = build(BOLA);

    expect(report.coverage.cellsWithFindings).toBe(1);
    expect(report.coverage.cellsMatched).toBe(0);
  });

  it("keeps the resource on the finding row", () => {
    const report = build(BOLA);

    expect(report.findings[0]?.resourceId).toBe("order-b");
    expect(report.findings[0]?.relation).toBe("foreign-tenant");
  });

  /**
   * The defect group is keyed by endpoint × relation × conditions, so a finding
   * that cannot name its relation groups with the wrong things — and the group
   * that reaches a ticket names no resource to reproduce it with.
   */
  it("names the resource in the defect group", () => {
    const report = build(BOLA);

    expect(report.defects[0]?.resourceIds).toEqual(["order-b"]);
    expect(report.defects[0]?.relation).toBe("foreign-tenant");
  });

  /** And the request to reproduce it with is found, rather than left off. */
  it("carries the request the finding was made on", () => {
    const report = build(BOLA);

    expect(report.findings[0]?.request?.url).toBe("https://a.test/orders/2001");
  });

  /** A check that judges a whole endpoint still says nothing about a resource. */
  it("leaves an endpoint-level finding without a resource", () => {
    const { resourceId: _resource, relation: _relation, ...endpointLevel } = BOLA;
    const report = build(endpointLevel);

    expect(report.findings[0]?.resourceId).toBeUndefined();
  });
});

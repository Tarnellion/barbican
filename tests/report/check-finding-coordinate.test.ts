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

/**
 * The same leak, told as the pair it is: alice was served carol's order.
 *
 * `relatedAccountId` is the other side, and `relatedRequest` is what a reader
 * reproduces that side with. The finding still names `order-b` — one object, two
 * accounts asking for it.
 */
const PAIRED: ResolvedFinding = { ...BOLA, relatedAccountId: "carol" };

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

/**
 * The other side of the pair, declared and observed.
 *
 * A second account and a second object, because the question is which of carol's
 * cells `relatedRequest` is taken from — and with one cell each there is nothing
 * to take the wrong one from.
 */
const PAIR_CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: alice, role: r, tenant: t-a, tokenEnv: T_A }
  - { id: carol, role: r, tenant: t-b, tokenEnv: T_C }
policy:
  fallback: allowed
  rules: []
resources:
  - { id: order-a, tenant: t-a, params: { orderId: "1001" } }
  - { id: order-b, tenant: t-b, params: { orderId: "2001" } }
`);

function observed(accountId: string, resourceId: string | undefined, url: string) {
  return {
    accountId,
    endpointId: "orders.read",
    ...(resourceId === undefined ? {} : { resourceId }),
    status: 200,
    outcome: "allowed" as const,
    headers: {},
    durationMs: 1,
    url,
    method: "GET" as const,
  };
}

/**
 * A paired finding, with the other side observed on more than one cell.
 *
 * `others` is carol's half of the walk. The finding is about `order-b`, so
 * `relatedRequest` has to be carol's request for `order-b` — not for `order-a`,
 * and not the one that names no object at all.
 */
function buildPaired(others: readonly ReturnType<typeof observed>[]) {
  const options: BuildReportOptions = {
    version: "test",
    config: PAIR_CONFIG,
    endpoints: [{ id: "orders.read", method: "GET", path: "/orders/{orderId}" }],
    observations: [observed("alice", "order-b", "https://a.test/orders/2001"), ...others],
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 2,
    truncated: false,
    findings: [],
    checks: [PAIRED],
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

/**
 * The fourth place the whole cell has to be named, and the one left out.
 *
 * `withRequest` joins on account × endpoint × resource, and the comment beside
 * the check mapping lists who needs the third coordinate so that "`withVerdicts`
 * and `withRequest` find the observation instead of missing it".
 * `relatedRequestOf` — the other side of a paired finding — is not on that list
 * and was built without it: the key it asked `byCell` for named the account and
 * the endpoint and left the resource empty.
 *
 * Latent, and only just: the one check in the registry today pairs observations
 * that name no resource (`pairsOn` filters on `resourceId === undefined`), so
 * the key it produced happened to be the right one. The first object-level check
 * with a `relatedAccountId` — a BOLA read against a body, which is the obvious
 * first check of Module 2 — is where it stops being right.
 *
 * Fourth time this class is closed. ADR-0022 closed it for the walk, ADR-0039
 * for the finding's own coordinate, `relatedAccountId` for the field the other
 * side travels in; this is the one lookup none of the three reached.
 */
describe("the other side of a paired finding about a resource", () => {
  it("is the other account's request for the same object", () => {
    const report = buildPaired([observed("carol", "order-b", "https://a.test/orders/2001")]);

    expect(report.findings[0]?.relatedRequest?.url).toBe("https://a.test/orders/2001");
    expect(report.findings[0]?.relatedRequest?.as).toBe("carol");
  });

  /**
   * And not some other cell of the same account on the same endpoint.
   *
   * Three of carol's cells are in the list: her own object, the one the finding
   * is about, and one naming no object. A key that stops at the endpoint matches
   * the last of those, so the reader is handed an address that reproduces
   * nothing — the pair the check compared is not the pair the report prints.
   */
  it("is not a request from another cell of the same account and endpoint", () => {
    const report = buildPaired([
      observed("carol", "order-a", "https://a.test/orders/1001"),
      observed("carol", "order-b", "https://a.test/orders/2001"),
      observed("carol", undefined, "https://a.test/orders/9999"),
    ]);

    expect(report.findings[0]?.relatedRequest?.url).toBe("https://a.test/orders/2001");
  });

  /**
   * A paired finding that names no object keeps working the way it always did:
   * the resource is absent from the key because it is absent from the finding,
   * which is not the same as being dropped from it.
   */
  it("still finds the other side of an endpoint-level pair", () => {
    const { resourceId: _resource, relation: _relation, ...endpointLevel } = PAIRED;
    const options: BuildReportOptions = {
      version: "test",
      config: PAIR_CONFIG,
      endpoints: [{ id: "orders.read", method: "GET", path: "/orders" }],
      observations: [
        observed("alice", undefined, "https://a.test/orders"),
        observed("carol", undefined, "https://a.test/orders"),
      ],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 2,
      truncated: false,
      findings: [],
      checks: [endpointLevel],
      policy: { fallback: "allowed", rules: [] },
      startedAt: new Date(0),
      finishedAt: new Date(1),
    };

    expect(buildReport(options).findings[0]?.relatedRequest?.as).toBe("carol");
  });
});

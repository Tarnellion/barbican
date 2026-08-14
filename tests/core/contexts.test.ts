/**
 * Tests for request conditions — the minimal useful piece of ABAC (ADR-0019).
 *
 * What is checked is the main property: conditions are a dimension of the cell,
 * not a mark on the account. The role, the tenant and the resource in them are
 * the very same, and "access is granted" and "access is granted from this
 * country" are different claims.
 */

import { describe, expect, it } from "vitest";
import type { AccessMatrix } from "../../src/core/index.js";
import {
  describeCells,
  diffAccess,
  groupDefects,
  principalOf,
  relationOf,
} from "../../src/core/index.js";

const ENDPOINTS = [
  { id: "orders.list", method: "GET", path: "/v1/orders" },
  { id: "health", method: "GET", path: "/v1/health" },
] as const;

const POLICY = {
  fallback: "denied",
  rules: [
    { roles: ["user"], endpoints: ["orders.list"], outcome: "allowed" },
    { roles: "*", endpoints: ["orders.list"], context: "geo-blocked", outcome: "denied" },
  ],
} as const;

function matrix(
  observations: AccessMatrix["observations"],
  // One endpoint by default: `health` is not observed and would give
  // "not observed" on the base account, adding noise to the test's claim.
  endpoints: AccessMatrix["endpoints"] = [ENDPOINTS[0]],
): AccessMatrix {
  return {
    endpoints,
    accounts: [
      { id: "alice", roleId: "user", tenantId: "tenant-a" },
      {
        id: "alice@geo-blocked",
        roleId: "user",
        tenantId: "tenant-a",
        contextId: "geo-blocked",
        endpointIds: ["orders.list"],
      },
    ],
    resources: [],
    observations,
  };
}

describe("conditions as a dimension of the cell", () => {
  /**
   * The same role, the same tenant, the same endpoint — and a different
   * expected outcome. Without a dimension of their own these two cells are
   * indistinguishable, and a geo-bypass defect is inexpressible: "alice sees
   * her own orders" is true in both cases.
   */
  it("judges the same cell differently under different conditions", () => {
    const findings = diffAccess(
      matrix([
        {
          accountId: "alice",
          endpointId: "orders.list",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
        {
          accountId: "alice@geo-blocked",
          endpointId: "orders.list",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
      ]),
      POLICY,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.accountId).toBe("alice@geo-blocked");
    expect(findings[0]?.contextId).toBe("geo-blocked");
    expect(findings[0]?.kind).toBe("privilege-escalation");
  });

  /**
   * A rule without conditions applies in baseline conditions only. Otherwise
   * declaring new conditions would silently extend every previous expectation
   * to them: a platform that lawfully closes an endpoint for a prohibited
   * country would produce an unexpected denial on every cell.
   */
  it("does not carry baseline expectations over to declared conditions", () => {
    const findings = diffAccess(
      matrix([
        {
          accountId: "alice",
          endpointId: "orders.list",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
        {
          accountId: "alice@geo-blocked",
          endpointId: "orders.list",
          status: 451,
          outcome: "denied",
          headers: {},
          durationMs: 1,
        },
      ]),
      POLICY,
    );

    expect(findings).toEqual([]);
  });

  /**
   * Conditions are declared on specific endpoints, and on the rest the cell
   * does not exist. Otherwise an account under conditions would give "declared
   * but not observed" across the whole API surface — an invented hole in
   * coverage.
   */
  it("does not count an endpoint without declared conditions as missed", () => {
    const findings = diffAccess(
      matrix(
        [
          {
            accountId: "alice",
            endpointId: "orders.list",
            status: 200,
            outcome: "allowed",
            headers: {},
            durationMs: 1,
          },
          {
            accountId: "alice",
            endpointId: "health",
            status: 200,
            outcome: "allowed",
            headers: {},
            durationMs: 1,
          },
          {
            accountId: "alice@geo-blocked",
            endpointId: "orders.list",
            status: 451,
            outcome: "denied",
            headers: {},
            durationMs: 1,
          },
        ],
        [...ENDPOINTS],
      ),
      POLICY,
    );

    expect(findings.filter((finding) => finding.kind === "not-observed")).toEqual([]);
  });
});

describe("the identity of an account under conditions", () => {
  /**
   * Found by a cold read of the report. The resource's owner is written as
   * `alice` while the matrix row is called `alice@geo-blocked`, and matching by
   * the row gave `same-tenant` instead of `own`: severity rose from medium to
   * high, and the `own` defect group vanished from the report entirely.
   *
   * Conditions change the request, not who makes it.
   */
  it("does not cancel ownership of a resource", () => {
    const own = { id: "order-1", tenantId: "tenant-a", ownerAccountId: "alice", params: {} };
    const inContext = {
      id: "alice@geo-blocked",
      roleId: "user",
      tenantId: "tenant-a",
      contextId: "geo-blocked",
      baseAccountId: "alice",
    } as const;

    expect(relationOf(inContext, own)).toBe("own");
    expect(principalOf(inContext)).toBe("alice");
    // Without the reference to the base account — the former wrong behaviour.
    expect(relationOf({ id: "alice@geo-blocked", roleId: "user", tenantId: "tenant-a" }, own)).toBe(
      "same-tenant",
    );
  });
});

describe("verdicts per cell", () => {
  const observations = [
    {
      accountId: "alice",
      endpointId: "orders.list",
      status: 200,
      outcome: "allowed",
      headers: {},
      durationMs: 1,
    },
    {
      accountId: "alice@geo-blocked",
      endpointId: "orders.list",
      status: 200,
      outcome: "allowed",
      headers: {},
      durationMs: 1,
    },
  ] as const;

  /**
   * A cell with a resource is a branch of its own in the walk, and without it
   * the test would be empty: the mutation "a discrepancy with a resource is
   * declared matched" passed green, because the fixture had no resources at all.
   */
  const WITH_RESOURCE: AccessMatrix = {
    endpoints: [{ id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" }],
    accounts: [{ id: "alice", roleId: "user", tenantId: "tenant-a" }],
    resources: [
      { id: "own", tenantId: "tenant-a", ownerAccountId: "alice", params: { orderId: "1" } },
      { id: "neighbour", tenantId: "tenant-a", ownerAccountId: "bob", params: { orderId: "2" } },
    ],
    observations: [
      {
        accountId: "alice",
        endpointId: "orders.read",
        resourceId: "own",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
      },
      {
        accountId: "alice",
        endpointId: "orders.read",
        resourceId: "neighbour",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
      },
    ],
  };

  const RESOURCE_POLICY = {
    fallback: "denied",
    rules: [{ roles: ["user"], endpoints: ["orders.read"], scope: "own", outcome: "allowed" }],
  } as const;

  /**
   * The main invariant: the discrepancies are exactly the same cells with
   * `match: false`. Two independent walks would drift apart, and the report
   * would claim "tested and agreed" about a cell that landed in the findings.
   * See ADR-0020.
   */
  it("gives the same discrepancies as the diff on cells with a resource", () => {
    const cells = describeCells(WITH_RESOURCE, RESOURCE_POLICY);
    const findings = diffAccess(WITH_RESOURCE, RESOURCE_POLICY);

    expect(cells.map((cell) => [cell.resourceId, cell.match])).toEqual([
      ["own", true],
      ["neighbour", false],
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resourceId).toBe("neighbour");
  });

  it("gives the same discrepancies as the diff, cell for cell", () => {
    const built = matrix([...observations]);
    const cells = describeCells(built, POLICY);
    const findings = diffAccess(built, POLICY);

    const key = (c: { accountId: string; endpointId: string; resourceId?: string }) =>
      `${c.accountId} ${c.endpointId} ${c.resourceId ?? ""}`;
    expect(
      cells
        .filter((cell) => !cell.match)
        .map(key)
        .sort(),
    ).toEqual(findings.map(key).sort());
  });

  it("describes matched cells too, not only discrepancies", () => {
    const cells = describeCells(matrix([...observations]), POLICY);

    const matched = cells.find((cell) => cell.match);
    expect(matched?.accountId).toBe("alice");
    expect(matched?.expected).toBe("allowed");
    // The rule that declared the expectation is named on a matched cell too:
    // otherwise "tested" cannot be disputed without rereading the whole policy.
    expect(matched?.ruleIndex).toBe(0);
  });

  it("misses no cell of the matrix", () => {
    const cells = describeCells(matrix([...observations]), POLICY);

    // Two account rows x one endpoint: an account under conditions exists only
    // on the declared endpoints, so there are exactly two cells.
    expect(cells).toHaveLength(2);
  });
});

describe("defect grouping", () => {
  /**
   * The country check and the permission check are different mechanisms in the
   * platform: they break independently and are fixed in different places.
   * Collapsing them into one defect, the report would say "there is one
   * defect", and a fix would close half of it.
   */
  it("does not merge a discrepancy under conditions with the same one in baseline", () => {
    const groups = groupDefects([
      {
        accountId: "alice",
        endpointId: "orders.list",
        kind: "privilege-escalation",
        severity: "high",
      },
      {
        accountId: "alice@geo-blocked",
        endpointId: "orders.list",
        contextId: "geo-blocked",
        kind: "privilege-escalation",
        severity: "high",
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.contextId)).toEqual(
      expect.arrayContaining([undefined, "geo-blocked"]),
    );
  });
});

/**
 * The holding setup: before ADR-0013 and after.
 *
 * The first describe pins the behaviour **without a declared tree** — it stayed
 * the same deliberately, for compatibility, and that is exactly why it is
 * dangerous. The second shows that declaring the tree fixes it.
 */

import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy, TenantNode } from "../../src/core/index.js";
import {
  buildAccessMatrix,
  createTenantHierarchy,
  DuplicateTenantIdError,
  diffAccess,
  relationOf,
  TenantCycleError,
  UnknownParentTenantError,
} from "../../src/core/index.js";
import type { Account, Endpoint, Resource } from "../../src/core/types.js";

/** Holding H1 owns brands A and B. Holding H2 owns brand C. */
const TENANTS: readonly TenantNode[] = [
  { id: "holding-1" },
  { id: "brand-a", parentId: "holding-1" },
  { id: "brand-b", parentId: "holding-1" },
  { id: "holding-2" },
  { id: "brand-c", parentId: "holding-2" },
];

const RESOURCES: readonly Resource[] = [
  { id: "r-a", tenantId: "brand-a", params: { id: "1" } },
  { id: "r-b", tenantId: "brand-b", params: { id: "2" } },
  { id: "r-c", tenantId: "brand-c", params: { id: "3" } },
];

const ENDPOINTS: readonly Endpoint[] = [{ id: "report", method: "GET", path: "/v1/reports/{id}" }];

function observationsFor(accountId: string) {
  return RESOURCES.map((resource) => ({
    endpointId: "report",
    accountId,
    resourceId: resource.id,
    status: 200,
    headers: {},
    outcome: "allowed" as const,
    durationMs: 1,
  }));
}

describe("without a declared tree the behaviour is the old one — and dangerous for it", () => {
  /** The holding is attributed to one of its own brands: the model offers nothing else. */
  const holding: Account = { id: "holding-1", roleId: "holding", tenantId: "brand-a" };

  const policy: ResolvedAccessPolicy = {
    fallback: "denied",
    rules: [
      { roles: ["holding"], endpoints: ["report"], scope: "foreign-tenant", outcome: "allowed" },
    ],
  };

  const findings = diffAccess(
    buildAccessMatrix({
      endpoints: ENDPOINTS,
      accounts: [holding],
      resources: RESOURCES,
      observations: observationsFor("holding-1"),
    }),
    policy,
  );

  it("does not find a leak into a brand of another holding", () => {
    expect(findings.some((finding) => finding.resourceId === "r-c")).toBe(false);
  });

  it("but declares a lawful read of its own brand an escalation", () => {
    expect(findings.find((finding) => finding.resourceId === "r-a")?.kind).toBe(
      "privilege-escalation",
    );
  });
});

describe("with a declared tree", () => {
  const holding: Account = { id: "holding-1", roleId: "holding", tenantId: "holding-1" };

  it("tells its own brand, a foreign holding and the level above apart", () => {
    const hierarchy = createTenantHierarchy(TENANTS);
    const brandAccount: Account = { id: "op-a", roleId: "operator", tenantId: "brand-a" };

    const relations = RESOURCES.map((resource) => relationOf(holding, resource, hierarchy));
    expect(relations).toEqual(["descendant-tenant", "descendant-tenant", "foreign-tenant"]);

    // A brand reading the holding level is a case of its own, not a foreign tenant.
    expect(
      relationOf(brandAccount, { id: "h", tenantId: "holding-1", params: {} }, hierarchy),
    ).toBe("ancestor-tenant");
  });

  /**
   * Exactly what ADR-0013 was written for: both former mistakes disappear at
   * once, and the policy states the intent literally — "a holding is meant to
   * get its own brands, and only those".
   */
  it("finds a leak into a foreign holding and does not nitpick its own brand", () => {
    const policy: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        {
          roles: ["holding"],
          endpoints: ["report"],
          scope: "descendant-tenant",
          outcome: "allowed",
        },
      ],
    };

    const findings = diffAccess(
      buildAccessMatrix({
        endpoints: ENDPOINTS,
        accounts: [holding],
        resources: RESOURCES,
        observations: observationsFor("holding-1"),
        tenants: TENANTS,
      }),
      policy,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.resourceId).toBe("r-c");
    expect(findings[0]?.relation).toBe("foreign-tenant");
    expect(findings[0]?.kind).toBe("privilege-escalation");
  });

  /**
   * The contract: the relation is strict. It holds in two ways at once — an
   * early return and the fact that cycles are rejected at construction — so
   * removing the early return does not fail this test. The test states the
   * contract; it does not guard a particular line.
   */
  it("does not count a tenant as its own ancestor", () => {
    expect(createTenantHierarchy(TENANTS).isAncestor("brand-a", "brand-a")).toBe(false);
  });

  it("sees an ancestor several levels up", () => {
    const deep: readonly TenantNode[] = [
      { id: "platform" },
      { id: "holding-1", parentId: "platform" },
      { id: "brand-a", parentId: "holding-1" },
    ];

    expect(createTenantHierarchy(deep).isAncestor("platform", "brand-a")).toBe(true);
  });
});

describe("validating the tree at startup", () => {
  /**
   * A typo in the parent makes the tenant a root of its own:
   * `descendant-tenant` turns into `foreign-tenant`, the rule stops applying,
   * the finding vanishes. The same class as a stray space in a tenant name.
   */
  it("rejects an unknown parent", () => {
    expect(() =>
      createTenantHierarchy([{ id: "brand-a", parentId: "holding-l" }, { id: "holding-1" }]),
    ).toThrow(UnknownParentTenantError);
  });

  /** Without the check, climbing the tree during the diff would loop forever. */
  it("rejects a cycle", () => {
    expect(() =>
      createTenantHierarchy([
        { id: "a", parentId: "b" },
        { id: "b", parentId: "a" },
      ]),
    ).toThrow(TenantCycleError);
  });

  it("rejects a duplicate tenant identifier", () => {
    expect(() => createTenantHierarchy([{ id: "a" }, { id: "a" }])).toThrow(DuplicateTenantIdError);
  });

  it("rejects a tenant declared as its own parent", () => {
    expect(() => createTenantHierarchy([{ id: "a", parentId: "a" }])).toThrow(TenantCycleError);
  });
});

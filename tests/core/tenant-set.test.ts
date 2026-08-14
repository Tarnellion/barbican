/**
 * An account with a set of tenants: before ADR-0017 and after.
 *
 * The first describe is the experiment the ADR was written for: it walks
 * through **every** way of expressing such an account with a tree and shows
 * that each of them lies. The second shows that a set of memberships fixes both
 * symptoms at once.
 */

import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy, TenantNode } from "../../src/core/index.js";
import {
  assertIndependentMemberships,
  buildAccessMatrix,
  createTenantHierarchy,
  DuplicateMembershipError,
  diffAccess,
  relationOf,
  SubsumedMembershipError,
  tenantIdsOf,
} from "../../src/core/index.js";
import type { Account, Endpoint, Resource } from "../../src/core/types.js";

/**
 * A platform over two holdings, each with two brands.
 *
 * The second brand in each holding is not there for symmetry: without it "the
 * whole holding" and "one of its brands" would coincide, and the difference
 * between membership in a node and membership in a subtree would be
 * unobservable.
 */
const TENANTS: readonly TenantNode[] = [
  { id: "platform" },
  { id: "holding-1", parentId: "platform" },
  { id: "brand-a", parentId: "holding-1" },
  { id: "brand-b", parentId: "holding-1" },
  { id: "holding-2", parentId: "platform" },
  { id: "brand-c", parentId: "holding-2" },
  { id: "brand-d", parentId: "holding-2" },
];

const RESOURCES: readonly Resource[] = ["a", "b", "c", "d"].map((letter) => ({
  id: `r-${letter}`,
  tenantId: `brand-${letter}`,
  params: { id: letter },
}));

const ENDPOINTS: readonly Endpoint[] = [{ id: "report", method: "GET", path: "/v1/reports/{id}" }];

/**
 * The platform leaks: the support account is given all four brands.
 *
 * It is meant to get A and C — so a human declared. There must be exactly two
 * findings: B and D. The observations are written by hand, not derived from the
 * policy.
 */
const OBSERVATIONS = RESOURCES.map((resource) => ({
  endpointId: "report",
  accountId: "sam",
  resourceId: resource.id,
  status: 200,
  headers: {},
  outcome: "allowed" as const,
  durationMs: 1,
}));

function escalationsOn(account: Account, policy: ResolvedAccessPolicy): readonly string[] {
  return diffAccess(
    buildAccessMatrix({
      endpoints: ENDPOINTS,
      accounts: [account],
      resources: RESOURCES,
      observations: OBSERVATIONS,
      tenants: TENANTS,
    }),
    policy,
  )
    .filter((finding) => finding.kind === "privilege-escalation")
    .map((finding) => finding.resourceId ?? "")
    .sort();
}

function ruleWithScope(
  scope: ResolvedAccessPolicy["rules"][number]["scope"],
): ResolvedAccessPolicy {
  return {
    fallback: "denied",
    rules: [{ roles: ["support"], endpoints: ["report"], scope, outcome: "allowed" }],
  };
}

describe("a tree cannot express such an account in any of the three ways", () => {
  /**
   * Way one: seat it on one of its own brands and allow its own tenant.
   *
   * The leaks are found, but along with them a lawful read of the second brand
   * is declared a finding. The reader of the report cannot tell one from the
   * other: three findings of one kind, one of them invented.
   */
  it("seated on brand-a it gets a false finding on the lawful brand-c", () => {
    const sam: Account = { id: "sam", roleId: "support", tenantId: "brand-a" };
    expect(escalationsOn(sam, ruleWithScope("same-tenant"))).toEqual(["r-b", "r-c", "r-d"]);
  });

  /**
   * Way two — what is used in practice to remove the false finding: open up
   * `foreign-tenant`. The cure is worse than the disease: both real leaks
   * vanish, and the finding on the account's own brand stays, because the rule
   * covers foreign tenants only. The run both lies and looks substantial.
   */
  it("with foreign-tenant opened up both real leaks vanish", () => {
    const sam: Account = { id: "sam", roleId: "support", tenantId: "brand-a" };
    expect(escalationsOn(sam, ruleWithScope("foreign-tenant"))).toEqual(["r-a"]);
  });

  /**
   * Way three: seat it at the common root. Brands of different holdings have no
   * common ancestor other than the platform — and along with A and C the
   * account gets B and D. The run is clean while the leak is in place: this is
   * exactly "clean is not the same as tested".
   */
  it("seated at the common root it finds nothing", () => {
    const sam: Account = { id: "sam", roleId: "support", tenantId: "platform" };
    expect(escalationsOn(sam, ruleWithScope("descendant-tenant"))).toEqual([]);
  });
});

describe("with a declared set of memberships", () => {
  const sam: Account = { id: "sam", roleId: "support", tenantIds: ["brand-a", "brand-c"] };

  it("finds exactly two leaks and does not nitpick its own brands", () => {
    expect(escalationsOn(sam, ruleWithScope("same-tenant"))).toEqual(["r-b", "r-d"]);
  });

  it("computes the relation for every membership", () => {
    const hierarchy = createTenantHierarchy(TENANTS);
    expect(RESOURCES.map((resource) => relationOf(sam, resource, hierarchy))).toEqual([
      "same-tenant",
      "foreign-tenant",
      "same-tenant",
      "foreign-tenant",
    ]);
  });

  /**
   * Ownership is a relation inside a tenant, and a set does not change that: a
   * resource of one's own tenant whose owner is the account itself stays `own`.
   */
  it("keeps own for its own resource in any of the memberships", () => {
    const own: Resource = {
      id: "r-own",
      tenantId: "brand-c",
      ownerAccountId: "sam",
      params: { id: "own" },
    };
    expect(relationOf(sam, own, createTenantHierarchy(TENANTS))).toBe("own");
  });

  /**
   * Kinship is computed for every membership, and the nearest relation wins. An
   * account of a holding and of a brand in another branch sees its own holding
   * top-down and the level of the other holding bottom-up, and those are two
   * different verdicts.
   */
  it("tells down from up across different memberships", () => {
    const hierarchy = createTenantHierarchy(TENANTS);
    const mixed: Account = { id: "mix", roleId: "ops", tenantIds: ["holding-1", "brand-c"] };

    expect(relationOf(mixed, { id: "x", tenantId: "brand-b", params: {} }, hierarchy)).toBe(
      "descendant-tenant",
    );
    expect(relationOf(mixed, { id: "y", tenantId: "holding-2", params: {} }, hierarchy)).toBe(
      "ancestor-tenant",
    );
    expect(relationOf(mixed, { id: "z", tenantId: "platform", params: {} }, hierarchy)).toBe(
      "ancestor-tenant",
    );
  });

  /**
   * Compatibility: a set of one must behave like `tenantId`. The claim is
   * checked across every relation at once, not on a single one.
   */
  it("with one membership it answers as an account with a single tenant does", () => {
    const hierarchy = createTenantHierarchy(TENANTS);
    const single: Account = { id: "one", roleId: "support", tenantId: "brand-a" };
    const asSet: Account = { id: "one", roleId: "support", tenantIds: ["brand-a"] };
    const probes: readonly Resource[] = [
      { id: "p1", tenantId: "brand-a", params: {} },
      { id: "p2", tenantId: "brand-a", ownerAccountId: "one", params: {} },
      { id: "p3", tenantId: "holding-1", params: {} },
      { id: "p4", tenantId: "brand-c", params: {} },
    ];

    expect(probes.map((resource) => relationOf(asSet, resource, hierarchy))).toEqual(
      probes.map((resource) => relationOf(single, resource, hierarchy)),
    );
  });

  it("lists the memberships as one list, and gives an empty one outside of tenants", () => {
    expect(tenantIdsOf(sam)).toEqual(["brand-a", "brand-c"]);
    expect(tenantIdsOf({ id: "anon", roleId: "anonymous" })).toEqual([]);
  });
});

describe("validating the set at startup", () => {
  const hierarchy = createTenantHierarchy(TENANTS);

  /**
   * A nested membership changes the relation silently: the brand's resources
   * stop being `descendant-tenant` and become `same-tenant`, the rule written
   * for the top-down view stops applying, the cell falls through to `fallback`.
   * The check stands at startup for exactly this reason: in the report the
   * shift gives no sign of itself.
   */
  it("rejects a membership covered by another membership", () => {
    expect(() =>
      assertIndependentMemberships("Account 'sam'", ["holding-1", "brand-a"], hierarchy),
    ).toThrow(SubsumedMembershipError);
  });

  it("rejects a repeat inside the set", () => {
    expect(() =>
      assertIndependentMemberships("Account 'sam'", ["brand-a", "brand-a"], hierarchy),
    ).toThrow(DuplicateMembershipError);
  });

  it("accepts a set of unrelated tenants", () => {
    expect(() =>
      assertIndependentMemberships("Account 'sam'", ["brand-a", "brand-c"], hierarchy),
    ).not.toThrow();
  });

  /**
   * Without a declared tree nobody has any kinship, so nesting cannot happen,
   * while a repeat is still caught — it is a typo under any model.
   */
  it("without a tree it catches only a repeat", () => {
    const flat = createTenantHierarchy([{ id: "brand-a" }, { id: "brand-c" }]);
    expect(() =>
      assertIndependentMemberships("Account 'sam'", ["brand-a", "brand-c"], flat),
    ).not.toThrow();
  });
});

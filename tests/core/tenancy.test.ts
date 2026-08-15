/**
 * Tests for resource ownership and the three-dimensional matrix.
 *
 * Before this, `tenantId` was decoration: read from the configuration and used
 * neither in the request, nor in the policy, nor in the diff. What is checked
 * here is the reason the project calls itself a tenant isolation checker.
 */

import { describe, expect, it } from "vitest";
import type {
  AccessObservation,
  Account,
  Endpoint,
  ResolvedAccessPolicy,
  Resource,
} from "../../src/core/index.js";
import {
  ANY,
  buildAccessMatrix,
  createTenantHierarchy,
  diffAccess,
  relationOf,
  resolveExpected,
  severityOf,
} from "../../src/core/index.js";

const playerA: Account = { id: "player-a", roleId: "player", tenantId: "tenant-a" };
const playerA2: Account = { id: "player-a2", roleId: "player", tenantId: "tenant-a" };
const playerB: Account = { id: "player-b", roleId: "player", tenantId: "tenant-b" };
const adminA: Account = { id: "admin-a", roleId: "admin", tenantId: "tenant-a" };

const ownedByA: Resource = {
  id: "profile-a",
  tenantId: "tenant-a",
  ownerAccountId: "player-a",
  params: { playerId: "1001" },
};
const ownedByB: Resource = {
  id: "profile-b",
  tenantId: "tenant-b",
  ownerAccountId: "player-b",
  params: { playerId: "2002" },
};

const profile: Endpoint = { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" };

describe("relationOf", () => {
  it("an own resource", () => {
    expect(relationOf(playerA, ownedByA)).toBe("own");
  });

  it("another account's resource in the same tenant — BOLA inside a tenant lands here", () => {
    expect(relationOf(playerA2, ownedByA)).toBe("same-tenant");
  });

  it("a resource of a foreign tenant", () => {
    expect(relationOf(playerB, ownedByA)).toBe("foreign-tenant");
  });

  // The distinction matters: an administrator is usually meant to get
  // everything in their own tenant and nothing in a foreign one, and a single
  // "not mine" flag cannot express that.
  it("an administrator sees another account's resource in their tenant as same-tenant", () => {
    expect(relationOf(adminA, ownedByA)).toBe("same-tenant");
  });

  it("an ownerless resource in one's own tenant is same-tenant", () => {
    const shared: Resource = { id: "s", tenantId: "tenant-a", params: {} };

    expect(relationOf(playerA, shared)).toBe("same-tenant");
  });
});

/**
 * An account outside of tenants is an anonymous one. It has no `tenantId` field
 * at all, and that is a statement rather than an omission: a reserved name like
 * `none` would sit in the same value space as real ones, and on a platform with
 * such a tenant the anonymous account would silently become its neighbor.
 */
describe("relationOf for an account outside of tenants", () => {
  const outsider: Account = { id: "anon", roleId: "anonymous" };

  it("every resource is foreign to it", () => {
    expect(relationOf(outsider, ownedByA)).toBe("foreign-tenant");
    expect(relationOf(outsider, ownedByB)).toBe("foreign-tenant");
  });

  // Ownership is a relation inside a tenant. Even when declared as the owner,
  // an account outside of tenants does not get the resource as its own:
  // otherwise a typo in `owner` would grant an anonymous account access
  // declared lawful.
  it("does not become an owner even when declared in owner", () => {
    const claimed: Resource = {
      id: "claimed",
      tenantId: "tenant-a",
      ownerAccountId: "anon",
      params: {},
    };

    expect(relationOf(outsider, claimed)).toBe("foreign-tenant");
  });

  // Kinship is computed over the tree, and such an account has no node.
  it("is kin to no node of the tree", () => {
    const hierarchy = createTenantHierarchy([
      { id: "holding-1" },
      { id: "tenant-a", parentId: "holding-1" },
    ]);
    const holdingLevel: Resource = { id: "h", tenantId: "holding-1", params: {} };

    expect(relationOf(outsider, holdingLevel, hierarchy)).toBe("foreign-tenant");
    expect(relationOf(outsider, ownedByA, hierarchy)).toBe("foreign-tenant");
  });

  // A sixth value was deliberately not introduced, and the price of that
  // decision is checked here: a rule with `scope: foreign-tenant` keeps
  // covering the anonymous account, and its access to someone else's data
  // stays critical rather than dropping to high.
  it("stays under rules with scope: foreign-tenant and keeps critical", () => {
    const policy: ResolvedAccessPolicy = {
      fallback: "allowed",
      rules: [{ roles: ANY, endpoints: ANY, scope: "foreign-tenant", outcome: "denied" }],
    };
    const relation = relationOf(outsider, ownedByA);

    expect(resolveExpected(policy, "anonymous", "profile.read", relation)).toBe("denied");
    expect(severityOf("privilege-escalation", relation)).toBe("critical");
  });
});

describe("the scope of a rule", () => {
  const policy: ResolvedAccessPolicy = {
    fallback: "denied",
    rules: [
      { roles: ["player"], endpoints: ["profile.read"], scope: "own", outcome: "allowed" },
      { roles: ["admin"], endpoints: ANY, scope: "same-tenant", outcome: "allowed" },
    ],
  };

  it("a rule applies only under its own relation", () => {
    expect(resolveExpected(policy, "player", "profile.read", "own")).toBe("allowed");
    expect(resolveExpected(policy, "player", "profile.read", "same-tenant")).toBe("denied");
    expect(resolveExpected(policy, "player", "profile.read", "foreign-tenant")).toBe("denied");
  });

  it("an administrator gets their own tenant and not a foreign one", () => {
    expect(resolveExpected(policy, "admin", "profile.read", "same-tenant")).toBe("allowed");
    expect(resolveExpected(policy, "admin", "profile.read", "foreign-tenant")).toBe("denied");
  });

  it("a rule without a scope applies under any relation and with no resource", () => {
    const wide: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: ANY, endpoints: ["ping"], outcome: "allowed" }],
    };

    expect(resolveExpected(wide, "player", "ping")).toBe("allowed");
    expect(resolveExpected(wide, "player", "ping", "foreign-tenant")).toBe("allowed");
  });
});

describe("the diff over triples", () => {
  const policy: ResolvedAccessPolicy = {
    fallback: "denied",
    rules: [{ roles: ["player"], endpoints: ["profile.read"], scope: "own", outcome: "allowed" }],
  };

  function observe(accountId: string, resourceId: string, outcome: "allowed" | "denied") {
    return {
      accountId,
      endpointId: "profile.read",
      resourceId,
      status: outcome === "allowed" ? 200 : 403,
      headers: {},
      outcome,
      durationMs: 1,
    } satisfies AccessObservation;
  }

  const accounts = [playerA, playerB];
  const resources = [ownedByA, ownedByB];

  it("finds nothing when isolation holds", () => {
    const matrix = buildAccessMatrix({
      endpoints: [profile],
      accounts,
      resources,
      observations: [
        observe("player-a", "profile-a", "allowed"),
        observe("player-a", "profile-b", "denied"),
        observe("player-b", "profile-a", "denied"),
        observe("player-b", "profile-b", "allowed"),
      ],
    });

    expect(diffAccess(matrix, policy)).toEqual([]);
  });

  it("finds a cross-tenant leak and names the resource", () => {
    const matrix = buildAccessMatrix({
      endpoints: [profile],
      accounts,
      resources,
      observations: [
        observe("player-a", "profile-a", "allowed"),
        // A player of tenant A reached a resource of tenant B.
        observe("player-a", "profile-b", "allowed"),
        observe("player-b", "profile-a", "denied"),
        observe("player-b", "profile-b", "allowed"),
      ],
    });

    expect(diffAccess(matrix, policy)).toEqual([
      {
        accountId: "player-a",
        endpointId: "profile.read",
        resourceId: "profile-b",
        relation: "foreign-tenant",
        expected: "denied",
        basis: "fallback",
        actual: "allowed",
        kind: "privilege-escalation",
        // A leak into a foreign tenant is the only case that gets critical: it
        // is heavier than access to another account's resource inside one's own
        // tenant.
        severity: "critical",
      },
    ]);
  });

  it("tells a cross-tenant leak apart from BOLA inside a tenant", () => {
    const matrix = buildAccessMatrix({
      endpoints: [profile],
      accounts: [playerA, playerA2],
      resources: [ownedByA],
      observations: [
        observe("player-a", "profile-a", "allowed"),
        // Another player of the same tenant is BOLA, not a cross-tenant leak.
        observe("player-a2", "profile-a", "allowed"),
      ],
    });

    const findings = diffAccess(matrix, policy);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.relation).toBe("same-tenant");
    expect(findings[0]?.accountId).toBe("player-a2");
  });

  it("builds no cells for resources that do not cover the path parameters", () => {
    const unrelated: Resource = { id: "other", tenantId: "tenant-a", params: { orderId: "7" } };
    const matrix = buildAccessMatrix({
      endpoints: [profile],
      accounts: [playerA],
      resources: [ownedByA, unrelated],
      observations: [observe("player-a", "profile-a", "allowed")],
    });

    // `other` has no playerId — the cell with it does not exist, and there must
    // be no "not observed" either.
    expect(diffAccess(matrix, policy)).toEqual([]);
  });
});

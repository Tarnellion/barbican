/**
 * Tests for the tenant isolation check over signals.
 *
 * The fixtures are written by hand: observations with digests are given as
 * numbers right here. Generating them from a run would mean checking the tool
 * for consistency with itself.
 */

import { describe, expect, it } from "vitest";
import {
  createIdenticalResponseCheck,
  describeBodyComparison,
} from "../../src/core/checks/tenant-isolation.js";
import type { AccessMatrix, AccessObservation, Account, Endpoint } from "../../src/core/types.js";

const ACCOUNTS: readonly Account[] = [
  { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
  { id: "bob-a", roleId: "user", tenantId: "tenant-a" },
  { id: "carol-b", roleId: "user", tenantId: "tenant-b" },
];

const LIST: Endpoint = {
  id: "orders-list",
  method: "GET",
  path: "/v1/orders",
  responseMustDifferByTenant: true,
};

function observed(
  accountId: string,
  digest: number,
  overrides: Partial<AccessObservation> = {},
): AccessObservation {
  return {
    endpointId: "orders-list",
    accountId,
    status: 200,
    headers: {},
    outcome: "allowed",
    durationMs: 1,
    signals: { digest },
    ...overrides,
  };
}

function matrixOf(
  observations: readonly AccessObservation[],
  endpoint: Endpoint = LIST,
): AccessMatrix {
  return { endpoints: [endpoint], accounts: ACCOUNTS, resources: [], observations };
}

const check = createIdenticalResponseCheck();

describe("coverage of body comparison", () => {
  /**
   * The report's silence about a particular pair reads as "nothing matched".
   * On the reference platform a holding and a support account with a set of
   * memberships matched digests lawfully — they are related — and there was
   * nothing to tell "skipped" from "compared and differed". Found by a second
   * cold read.
   */
  it("counts compared pairs separately from pairs skipped as related", () => {
    const matrix: AccessMatrix = {
      endpoints: [LIST],
      accounts: [
        { id: "holding", roleId: "holding", tenantId: "holding-1" },
        { id: "op-a", roleId: "operator", tenantId: "brand-a" },
        { id: "op-c", roleId: "operator", tenantId: "brand-c" },
      ],
      resources: [],
      observations: [observed("holding", 1), observed("op-a", 1), observed("op-c", 2)],
      tenants: [
        { id: "holding-1" },
        { id: "brand-a", parentId: "holding-1" },
        { id: "holding-2" },
        { id: "brand-c", parentId: "holding-2" },
      ],
    };

    // holding x op-a are related and skipped. The other two pairs were compared.
    expect(describeBodyComparison({ matrix })).toEqual([
      { endpointId: "orders-list", comparedPairs: 2, skippedRelatedPairs: 1 },
    ]);
  });

  it("does not count endpoints for which no difference was declared", () => {
    const matrix: AccessMatrix = {
      endpoints: [{ id: "orders-list", method: "GET", path: "/v1/orders" }],
      accounts: ACCOUNTS,
      resources: [],
      observations: [observed("alice-a", 1), observed("carol-b", 1)],
    };

    expect(describeBodyComparison({ matrix })).toEqual([]);
  });
});

describe("mapping onto standards", () => {
  /**
   * A coverage claim is a claim too, and it must not be inflated. API3 (BOPLA)
   * is about the field level, while the check compares the whole response and
   * knows nothing about fields. CWE-285, not 862/863: from the outside "there
   * is no check" and "there is a check but it is wrong" are indistinguishable.
   */
  it("does not claim classes it cannot find", () => {
    const clauses = check.standards.map((ref) => `${ref.standard}:${ref.clause}`);

    expect(clauses).toEqual(["OWASP-API-2023:API1", "OWASP-ASVS-5.0:8.4.1", "CWE:285"]);
    expect(clauses).not.toContain("OWASP-API-2023:API3");
  });
});

describe("identical-response-across-tenants", () => {
  it("finds a matching digest across accounts of different tenants", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.endpointId).toBe("orders-list");
    expect(findings[0]?.evidence["otherTenant"]).toBe("tenant-b");
  });

  /**
   * The evidence must name what was checked. What was compared is digests —
   * 48 bits of salted SHA-256 — not bodies: bodies are not stored and there is
   * nothing to compare them with. The former `identicalBody` claimed a
   * byte-for-byte match the tool never observed; a report becomes the basis of
   * an incident, and the difference matters there. The test pins the field name
   * so the claim does not "grow" again.
   */
  it("names in the evidence exactly what was compared: digests", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)]),
    });

    expect(findings[0]?.evidence["bodyDigestsEqual"]).toBe(true);
    expect(findings[0]?.evidence).not.toHaveProperty("identicalBody");
    expect(findings[0]?.title).toContain("Response digest");
  });

  it("stays silent when the responses differ", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 222)]),
    });

    expect(findings).toEqual([]);
  });

  /** Inside one tenant an identical list is normal, not a leak. */
  it("stays silent on a match inside one tenant", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("bob-a", 111)]),
    });

    expect(findings).toEqual([]);
  });

  /**
   * Without a human declaration, `GET /v1/health` returning the same
   * `{"status":"ok"}` to everyone would become a finding, and real leaks would
   * drown in the noise.
   */
  it("stays silent on an endpoint for which no difference was declared", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)], {
        id: "orders-list",
        method: "GET",
        path: "/v1/orders",
      }),
    });

    expect(findings).toEqual([]);
  });

  /**
   * When a resource is given, both accounts read the same record: an identical
   * response is a consequence of access already visible by status, not a defect
   * of its own.
   */
  it("does not count a defect twice when the request went to a specific resource", () => {
    const findings = check.run({
      matrix: matrixOf([
        observed("alice-a", 111, { resourceId: "order-1" }),
        observed("carol-b", 111, { resourceId: "order-1" }),
      ]),
    });

    expect(findings).toEqual([]);
  });

  it("does not compare denials", () => {
    const findings = check.run({
      matrix: matrixOf([
        observed("alice-a", 111, { outcome: "denied", status: 403 }),
        observed("carol-b", 111, { outcome: "denied", status: 403 }),
      ]),
    });

    expect(findings).toEqual([]);
  });

  it("stays silent when the signal was not computed: there is nothing to judge", () => {
    const findings = check.run({
      matrix: matrixOf([
        observed("alice-a", 111, { signals: {} }),
        observed("carol-b", 111, { signals: {} }),
      ]),
    });

    expect(findings).toEqual([]);
  });

  /**
   * A holding sees the union of its brands. With a single brand the response
   * lawfully matches that brand's response — and without accounting for the
   * tree the check would declare a rollup on a healthy platform a leak. Found
   * by a run against the reference platform.
   */
  it("stays silent on a match between a holding and its own brand", () => {
    const matrix: AccessMatrix = {
      endpoints: [LIST],
      accounts: [
        { id: "holding", roleId: "holding", tenantId: "holding-1" },
        { id: "op-a", roleId: "operator", tenantId: "brand-a" },
      ],
      resources: [],
      observations: [observed("holding", 111), observed("op-a", 111)],
      tenants: [{ id: "holding-1" }, { id: "brand-a", parentId: "holding-1" }],
    };

    expect(check.run({ matrix })).toEqual([]);
  });

  /** No kinship — the match stays a finding. */
  it("does not stay silent on a match between brands of different holdings", () => {
    const matrix: AccessMatrix = {
      endpoints: [LIST],
      accounts: [
        { id: "op-a", roleId: "operator", tenantId: "brand-a" },
        { id: "op-c", roleId: "operator", tenantId: "brand-c" },
      ],
      resources: [],
      observations: [observed("op-a", 111), observed("op-c", 111)],
      tenants: [
        { id: "holding-1" },
        { id: "brand-a", parentId: "holding-1" },
        { id: "holding-2" },
        { id: "brand-c", parentId: "holding-2" },
      ],
    };

    expect(check.run({ matrix })).toHaveLength(1);
  });

  /**
   * An account outside of tenants (an anonymous one) has no kinship in the tree
   * and cannot have any, so a pair with it is compared: matching responses mean
   * a tenant's data is visible to someone who is not in it.
   */
  it("does not stay silent on a match with an account outside of tenants", () => {
    const matrix: AccessMatrix = {
      endpoints: [LIST],
      accounts: [
        { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
        { id: "anon", roleId: "anonymous" },
      ],
      resources: [],
      observations: [observed("alice-a", 111), observed("anon", 111)],
      tenants: [{ id: "tenant-a" }],
    };

    const findings = check.run({ matrix });

    expect(findings).toHaveLength(1);
    // The key is absent entirely: an empty place reads as "outside of tenants",
    // while a placeholder would read as the name of a tenant.
    expect(findings[0]?.evidence).not.toHaveProperty("otherTenant");
    expect(findings[0]?.evidence["tenant"]).toBe("tenant-a");
  });

  /** Neither of them has a tenant — it cannot differ between them. */
  it("stays silent on a match between two accounts outside of tenants", () => {
    const matrix: AccessMatrix = {
      endpoints: [LIST],
      accounts: [
        { id: "anon-1", roleId: "anonymous" },
        { id: "anon-2", roleId: "anonymous" },
      ],
      resources: [],
      observations: [observed("anon-1", 111), observed("anon-2", 111)],
    };

    expect(check.run({ matrix })).toEqual([]);
  });

  /**
   * An account with a set of memberships (ADR-0017) lawfully sees the rows of
   * each of its tenants. The pair "support over brands A and C against a user
   * of brand A" shares a tenant, and matching responses say nothing about
   * broken isolation — just as they said nothing about two neighbors inside a
   * tenant.
   */
  it("stays silent on overlapping sets of tenants", () => {
    const matrix: AccessMatrix = {
      endpoints: [LIST],
      accounts: [
        { id: "sam", roleId: "support", tenantIds: ["brand-a", "brand-c"] },
        { id: "op-a", roleId: "operator", tenantId: "brand-a" },
      ],
      resources: [],
      observations: [observed("sam", 111), observed("op-a", 111)],
      tenants: [{ id: "brand-a" }, { id: "brand-c" }],
    };

    expect(check.run({ matrix })).toEqual([]);
  });

  /** Kinship through even one membership is the same lawful case as a holding. */
  it("stays silent when one membership is related to the second account", () => {
    const matrix: AccessMatrix = {
      endpoints: [LIST],
      accounts: [
        { id: "sam", roleId: "support", tenantIds: ["brand-a", "brand-c"] },
        { id: "holding", roleId: "holding", tenantId: "holding-1" },
      ],
      resources: [],
      observations: [observed("sam", 111), observed("holding", 111)],
      tenants: [
        { id: "holding-1" },
        { id: "brand-a", parentId: "holding-1" },
        { id: "holding-2" },
        { id: "brand-c", parentId: "holding-2" },
      ],
    };

    expect(check.run({ matrix })).toEqual([]);
  });

  /** Neither a shared tenant nor kinship — the match stays a finding. */
  it("does not stay silent on non-overlapping sets", () => {
    const matrix: AccessMatrix = {
      endpoints: [LIST],
      accounts: [
        { id: "sam", roleId: "support", tenantIds: ["brand-a", "brand-c"] },
        { id: "op-b", roleId: "operator", tenantId: "brand-b" },
      ],
      resources: [],
      observations: [observed("sam", 111), observed("op-b", 111)],
      tenants: [{ id: "brand-a" }, { id: "brand-b" }, { id: "brand-c" }],
    };

    const findings = check.run({ matrix });

    expect(findings).toHaveLength(1);
    // The title names the tenants of the set; the evidence does not, because a
    // comma-joined string would sit in a field of real identifiers. Pairs are
    // ordered by account id, so the set is the second side here.
    expect(findings[0]?.title).toContain("tenants brand-a, brand-c");
    expect(findings[0]?.evidence["tenant"]).toBe("brand-b");
    expect(findings[0]?.evidence).not.toHaveProperty("otherTenant");
  });

  it("produces findings in a stable order", () => {
    const first = check.run({
      matrix: matrixOf([observed("carol-b", 111), observed("alice-a", 111)]),
    });
    const second = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)]),
    });

    expect(first).toEqual(second);
  });
});

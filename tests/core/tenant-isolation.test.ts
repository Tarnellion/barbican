/**
 * Tests for the tenant isolation check over signals.
 *
 * The fixtures are written by hand: observations with digests are given as
 * numbers right here. Generating them from a run would mean checking the tool
 * for consistency with itself.
 */

import { describe, expect, it } from "vitest";
import { createIdenticalResponseCheck } from "../../src/core/checks/tenant-isolation.js";
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

    // holding x op-a are related and skipped. The other two pairs were compared,
    // and one of them matched. Through the check's own `coverage`, which is how
    // the report gets it: a second exported entry point called by name was the
    // coupling L-4 removed.
    //
    // Written out in full rather than matched loosely: this is the one place the
    // whole counter set is pinned, so a counter that quietly stops being
    // reported has somewhere to fail.
    expect(createIdenticalResponseCheck().coverage?.({ matrix })).toEqual([
      {
        checkId: "identical-response-across-tenants",
        endpointId: "orders-list",
        counters: {
          comparedPairs: 2,
          matchedPairs: 0,
          differedPairs: 2,
          skippedBothEmptyPairs: 0,
          pairsWithoutDigest: 0,
          emptinessSignalsDeclared: 0,
          skippedRelatedPairs: 1,
        },
      },
    ]);
  });

  it("does not count endpoints for which no difference was declared", () => {
    const matrix: AccessMatrix = {
      endpoints: [{ id: "orders-list", method: "GET", path: "/v1/orders" }],
      accounts: ACCOUNTS,
      resources: [],
      observations: [observed("alice-a", 1), observed("carol-b", 1)],
    };

    expect(createIdenticalResponseCheck().coverage?.({ matrix })).toEqual([]);
  });
});

describe("request conditions are not compared across", () => {
  /**
   * The invariant ADR-0019 states, and the only thing that caught it breaking
   * was the oracle — as "15 extra findings" at the end of a ninety-second run
   * against a live platform. Found by the audit of 14 August (C-4).
   *
   * Why it holds: in such a pair two things differ at once, the tenant and the
   * condition attributes, so matching digests say nothing about either. What the
   * check asserts is "different tenants get different responses **all else being
   * equal**".
   */
  const underConditions: readonly Account[] = [
    { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
    { id: "carol-b@geo", roleId: "user", tenantId: "tenant-b", contextId: "geo" },
  ];

  function matrixWithConditions(): AccessMatrix {
    return {
      endpoints: [LIST],
      accounts: underConditions,
      resources: [],
      observations: [observed("alice-a", 777), observed("carol-b@geo", 777)],
    };
  }

  it("finds nothing between a baseline account and one under conditions", () => {
    expect(check.run({ matrix: matrixWithConditions() })).toEqual([]);
  });

  /** And says so in the coverage, or the silence reads as "nothing matched". */
  it("counts the pair as skipped for conditions rather than for kinship", () => {
    const coverage = check.coverage?.({ matrix: matrixWithConditions() }) ?? [];

    expect(coverage[0]?.counters).toMatchObject({
      comparedPairs: 0,
      skippedDifferentContextPairs: 1,
    });
  });

  /** The control: the same two digests under the same conditions do match. */
  it("still finds the leak when the conditions are equal", () => {
    const sameConditions: readonly Account[] = [
      { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
      { id: "carol-b", roleId: "user", tenantId: "tenant-b" },
    ];

    const findings = check.run({
      matrix: {
        endpoints: [LIST],
        accounts: sameConditions,
        resources: [],
        observations: [observed("alice-a", 777), observed("carol-b", 777)],
      },
    });

    expect(findings).toHaveLength(1);
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

  /**
   * The value, as opposed to the fact of equality. It was carried in `evidence`
   * while a note eighteen lines below in the same object said it was not, and it
   * was an exact duplicate of `signals.digest` on the observation for this cell.
   * Decided on 15 August in favour of the note: the salt is random, so in a
   * ticket the number cannot be compared with anything, and `evidence` is
   * documented as statuses, flags and identifiers.
   */
  it("does not carry the digest value itself, only the fact that two matched", () => {
    const observations = [observed("alice-a", 111), observed("carol-b", 111)];
    const findings = check.run({ matrix: matrixOf(observations) });

    expect(findings[0]?.evidence).not.toHaveProperty("digest");
    // Not lost, only kept where a per-cell measurement belongs.
    expect(observations[0]?.signals?.["digest"]).toBe(111);
  });

  /**
   * The audit of 14 August inverted the filter in `scalarsOf`, so the evidence
   * carried the digest instead of the declared scalars — and neither the unit
   * suite nor the oracle noticed. The oracle by construction: it compares which
   * cells are broken, never what the report says about them.
   *
   * The declared scalars are the whole reason evidence exists: "alice sees 4
   * records and carol sees 4" is an argument a developer can act on, "the
   * digests matched" is not. Inverting the filter replaces them with a
   * per-side copy of the digest — the one thing the reader already has under
   * `bodyDigestsEqual`, and the one thing that means nothing outside this run.
   */
  it("carries the scalars a human declared, per side", () => {
    const findings = check.run({
      matrix: matrixOf([
        observed("alice-a", 111, { signals: { digest: 111, orderCount: 4 } }),
        observed("carol-b", 111, { signals: { digest: 111, orderCount: 7 } }),
      ]),
    });

    expect(findings[0]?.evidence["own.orderCount"]).toBe(4);
    expect(findings[0]?.evidence["other.orderCount"]).toBe(7);
    // The digest is not repeated per side: `own.digest` and `other.digest` are
    // what the inverted filter produces instead of the scalars above.
    expect(findings[0]?.evidence).not.toHaveProperty("own.digest");
    expect(findings[0]?.evidence).not.toHaveProperty("other.digest");
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

/**
 * An empty response is evidence of nothing.
 *
 * Two tenants with no records answer `{"orders":[],"total":0}` byte for byte,
 * the digests match, and the check called it a leak. On a fresh deployment,
 * where half the tenants have nothing yet, that is a wall of findings and exit
 * 1 — the risk `plan.md` names first: a tool that finds things that do not exist
 * loses trust on the first run.
 *
 * The signal for it already exists and no more of the body is read to get it:
 * `count` at a path, declared by a human. A pair where every declared count is
 * zero on both sides carries no information about isolation, so it is not
 * compared — and the coverage says so, or the silence reads as "compared, and
 * they honestly differed".
 */
const LIST_WITH_COUNT: Endpoint = {
  ...LIST,
  signals: [{ name: "orderCount", kind: "count", path: "orders" }],
};

/** An observation carrying the declared count beside the digest. */
function counted(accountId: string, digest: number, orderCount: number): AccessObservation {
  return observed(accountId, digest, { signals: { digest, orderCount } });
}

describe("a pair where both sides are empty", () => {
  it("is not a finding", () => {
    const findings = check.run({
      matrix: matrixOf([counted("alice-a", 111, 0), counted("carol-b", 111, 0)], LIST_WITH_COUNT),
    });

    expect(findings).toEqual([]);
  });

  it("is counted in the coverage with a reason of its own", () => {
    const coverage = check.coverage?.({
      matrix: matrixOf([counted("alice-a", 111, 0), counted("carol-b", 111, 0)], LIST_WITH_COUNT),
    });

    expect(coverage?.[0]?.counters).toMatchObject({
      comparedPairs: 0,
      skippedBothEmptyPairs: 1,
      matchedPairs: 0,
    });
  });

  /**
   * The control, and the half that keeps the rule from becoming a way to hide a
   * leak: two tenants that both have records and got the same response is the
   * finding this check exists for.
   */
  it("still finds the leak when both sides have records", () => {
    const findings = check.run({
      matrix: matrixOf([counted("alice-a", 111, 4), counted("carol-b", 111, 4)], LIST_WITH_COUNT),
    });

    expect(findings).toHaveLength(1);
  });

  /**
   * And emptiness is a property of the pair, not of one side. If one account
   * sees nothing while the other sees four records under the same digest, the
   * digest is the thing that needs explaining — suppressing that would be the
   * blindness the body channel was opened to remove.
   */
  it("is still a finding when only one side is empty", () => {
    const findings = check.run({
      matrix: matrixOf([counted("alice-a", 111, 0), counted("carol-b", 111, 4)], LIST_WITH_COUNT),
    });

    expect(findings).toHaveLength(1);
  });

  /**
   * Where nothing says what "empty" means here, the check cannot tell one from
   * the other and does not pretend to. The number is in the coverage so a reader
   * can see the rule could not have fired on this endpoint at all.
   */
  it("cannot be told from a full one when no count was declared", () => {
    const coverage = check.coverage?.({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)]),
    });

    expect(coverage?.[0]?.counters).toMatchObject({
      emptinessSignalsDeclared: 0,
      comparedPairs: 1,
      matchedPairs: 1,
    });
  });
});

describe("the coverage counters tell the outcomes apart", () => {
  /**
   * `comparedPairs` grew by one whether the digests matched, differed, or were
   * never compared because both sides were empty. A reader of the report could
   * not tell "we compared and they honestly differed" from "we compared, the
   * difference sat in a request identifier, and the leak went past us".
   */
  it("counts a matched pair apart from a differing one", () => {
    const coverage = check.coverage?.({
      matrix: matrixOf([
        observed("alice-a", 111),
        observed("bob-a", 111),
        observed("carol-b", 222),
      ]),
    });

    // alice x bob share a tenant and are skipped. alice x carol and bob x carol
    // were compared, and both differed.
    expect(coverage?.[0]?.counters).toMatchObject({
      comparedPairs: 2,
      matchedPairs: 0,
      differedPairs: 2,
      skippedRelatedPairs: 1,
    });
  });

  it("counts a matched pair as matched", () => {
    const coverage = check.coverage?.({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)]),
    });

    expect(coverage?.[0]?.counters).toMatchObject({
      comparedPairs: 1,
      matchedPairs: 1,
      differedPairs: 0,
    });
  });

  /**
   * A pair the tool could not compare at all. A body over `maxBodyBytes` yields
   * no digest, and before this counter such a pair vanished from every number in
   * the report: the observation was filtered out before pairing, so
   * `comparedPairs` quietly did not grow and nothing said why. That is the same
   * silence D-5 closed on the observation, still open one layer above it.
   */
  it("counts a pair one side of which has no digest", () => {
    const coverage = check.coverage?.({
      matrix: matrixOf([
        observed("alice-a", 111),
        observed("carol-b", 0, { signals: { bodyOverLimit: true } }),
      ]),
    });

    expect(coverage?.[0]?.counters).toMatchObject({
      comparedPairs: 0,
      pairsWithoutDigest: 1,
    });
  });

  /** And the identity a reader can check on the spot. */
  it("keeps comparedPairs equal to matched plus differed", () => {
    const counters = check.coverage?.({
      matrix: matrixOf([
        observed("alice-a", 111),
        observed("bob-a", 333),
        observed("carol-b", 111),
      ]),
    })?.[0]?.counters;

    expect(counters?.["comparedPairs"]).toBe(
      (counters?.["matchedPairs"] ?? 0) + (counters?.["differedPairs"] ?? 0),
    );
  });
});

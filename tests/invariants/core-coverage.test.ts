/**
 * The core invariants that were held by a comment and not by a test.
 *
 * The mutation campaign of 20 August 2026 over `src/core` left 17.9 % of its
 * mutants alive. Gathered here is the part of that residue that carries meaning:
 * four parser defaults named in no test at all, two fields of a cell verdict,
 * two fields of an isolation finding, the defect signature and the order of the
 * groups, the integrity of the matrix over resources, and the third coordinate
 * of `findObservation`.
 *
 * Every test below was written against a specific edit to the source and was
 * confirmed red under it. That is the whole claim being made: not that the
 * behaviour is described somewhere, but that taking it away breaks something.
 */

import { describe, expect, it } from "vitest";
import {
  createEndpointListParser,
  DEFAULT_ENDPOINT_LIST_LIMITS,
  EndpointListParseError,
  EndpointListTooLargeError,
} from "../../src/adapters/endpoint-list.js";
import {
  createOpenApiParser,
  DEFAULT_SPEC_LIMITS,
  SpecTooLargeError,
} from "../../src/adapters/openapi.js";
import {
  createPostmanCollectionParser,
  DEFAULT_POSTMAN_LIMITS,
  PostmanCollectionTooLargeError,
} from "../../src/adapters/postman.js";
import type { GroupableFinding, ResolvedAccessPolicy } from "../../src/core/index.js";
import {
  buildAccessMatrix,
  createIdenticalResponseCheck,
  DuplicateIdError,
  defectSignature,
  describeCells,
  findObservation,
  groupDefects,
  indexObservations,
  UnknownReferenceError,
} from "../../src/core/index.js";
import type {
  AccessMatrix,
  AccessObservation,
  AccessOutcome,
  Account,
  Endpoint,
  Resource,
} from "../../src/core/types.js";

/**
 * The four numbers that bound a document the tool was handed.
 *
 * `tests/adapters/defaults.test.ts` opens with the reasoning for pinning a
 * default by exact equality, and holds five other values that way. These four
 * were mentioned in no test: raised to a gigabyte each, the whole suite stayed
 * green, and a document meant to exhaust the machine reading it would be read.
 *
 * Two assertions per limit, because they say different things. The equality
 * pins the number; the parse pins that the number is the one actually applied —
 * a default that no code path reads is a comment with a type annotation.
 */
describe("the parser limits nobody passes in", () => {
  /** A valid document, made oversized by padding that changes nothing else. */
  function padded(bytes: number, document: string): string {
    return `# ${"p".repeat(bytes)}\n${document}`;
  }

  const ENDPOINT_LIST = [
    "endpoints:",
    "  - id: orders.list",
    "    method: GET",
    "    path: /v1/orders",
  ].join("\n");

  const SPECIFICATION = [
    "openapi: 3.0.3",
    "info:",
    "  title: t",
    "  version: '1'",
    "paths:",
    "  /v1/orders:",
    "    get:",
    "      operationId: listOrders",
    "      responses:",
    "        '200':",
    "          description: ok",
  ].join("\n");

  const COLLECTION = JSON.stringify({
    info: {
      name: "c",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [{ name: "orders", request: { method: "GET", url: "https://example.test/v1/orders" } }],
  });

  /**
   * An endpoint list built entirely out of aliases to one anchor.
   *
   * Small as text, large once expanded — the shape `maxAliasCount` exists for.
   * The document is otherwise valid, so what the parser refuses is the
   * expansion and not the syntax; the second assertion below is what says so.
   */
  function aliased(entries: number): string {
    const lines = ["endpoints:", "  - id: e0", "    method: &m GET", "    path: &p /v1/orders"];
    for (let index = 1; index < entries; index += 1) {
      lines.push(`  - id: e${index}`, "    method: *m", "    path: *p");
    }
    return lines.join("\n");
  }

  it("bounds an endpoint list at a megabyte and a hundred alias expansions", () => {
    expect(DEFAULT_ENDPOINT_LIST_LIMITS).toEqual({ maxBytes: 1_000_000, maxAliasCount: 100 });
  });

  it("bounds a specification at five megabytes", () => {
    expect(DEFAULT_SPEC_LIMITS).toEqual({ maxBytes: 5_000_000, maxAliasCount: 100, maxDepth: 64 });
  });

  it("bounds a collection at five megabytes", () => {
    expect(DEFAULT_POSTMAN_LIMITS).toEqual({
      maxBytes: 5_000_000,
      maxAliasCount: 100,
      maxFolderDepth: 16,
    });
  });

  it("refuses an endpoint list over the default size", async () => {
    const parser = createEndpointListParser();

    await expect(parser.parse(padded(1_000_000, ENDPOINT_LIST))).rejects.toThrow(
      EndpointListTooLargeError,
    );
    await expect(parser.parse(ENDPOINT_LIST)).resolves.toHaveLength(1);
  });

  it("refuses an endpoint list that unfolds through more aliases than the default allows", async () => {
    await expect(createEndpointListParser().parse(aliased(200))).rejects.toThrow(
      EndpointListParseError,
    );
    // The same document with the limit lifted by hand: valid, and 200 endpoints
    // long. The refusal above is the expansion, not the document.
    await expect(
      createEndpointListParser({ maxAliasCount: 1_000_000 }).parse(aliased(200)),
    ).resolves.toHaveLength(200);
  });

  it("refuses a specification over the default size", async () => {
    const parser = createOpenApiParser();

    await expect(parser.parse(padded(5_000_000, SPECIFICATION))).rejects.toThrow(SpecTooLargeError);
    await expect(parser.parse(SPECIFICATION)).resolves.toHaveLength(1);
  });

  it("refuses a collection over the default size", async () => {
    const parser = createPostmanCollectionParser();

    await expect(parser.parse(padded(5_000_000, COLLECTION))).rejects.toThrow(
      PostmanCollectionTooLargeError,
    );
    await expect(parser.parse(COLLECTION)).resolves.toHaveLength(1);
  });
});

const ORDERS_READ: Endpoint = { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" };
const AUDIT_READ: Endpoint = { id: "audit.read", method: "GET", path: "/v1/audit/{entryId}" };

const ALICE: Account = { id: "alice", roleId: "user", tenantId: "tenant-a" };

const OWN_ORDER: Resource = {
  id: "order-a-1",
  tenantId: "tenant-a",
  ownerAccountId: "alice",
  params: { orderId: "1" },
};
const FOREIGN_ENTRY: Resource = {
  id: "entry-b-9",
  tenantId: "tenant-b",
  params: { entryId: "9" },
};

function observed(
  endpointId: string,
  resourceId: string | undefined,
  outcome: AccessOutcome,
): AccessObservation {
  return {
    accountId: "alice",
    endpointId,
    ...(resourceId === undefined ? {} : { resourceId }),
    status: outcome === "allowed" ? 200 : 403,
    outcome,
  };
}

/**
 * `basis` and `relation` on the verdict of a cell that agreed.
 *
 * Both fields are asserted densely on the rows of the findings, and on those
 * rows only. The cell verdict is the one place they were introduced for: ADR-0020
 * added it so that "it is clean here" could be quoted, and "clean because a rule
 * said so" is a different claim from "clean because nothing was declared and the
 * fallback closed it". Dropping either field from `verdictOf` left the suite
 * green.
 *
 * The matrix below is deliberately all matches: a discrepancy would be carried
 * by `record`, which is the half already covered.
 */
describe("the verdict on a cell that matched", () => {
  const POLICY: ResolvedAccessPolicy = {
    fallback: "denied",
    rules: [{ roles: ["user"], endpoints: ["orders.read"], scope: "own", outcome: "allowed" }],
  };

  const MATRIX = buildAccessMatrix({
    endpoints: [ORDERS_READ, AUDIT_READ],
    accounts: [ALICE],
    resources: [OWN_ORDER, FOREIGN_ENTRY],
    observations: [
      observed("orders.read", "order-a-1", "allowed"),
      observed("audit.read", "entry-b-9", "denied"),
    ],
  });

  it("names which of the two declared the expectation", () => {
    const cells = describeCells(MATRIX, POLICY);

    // Both agreed: neither of these cells reaches the findings, which is what
    // makes this the uncovered half.
    expect(cells.map((cell) => cell.match)).toEqual([true, true]);
    expect(cells.map((cell) => [cell.endpointId, cell.basis, cell.ruleIndex])).toEqual([
      ["orders.read", "rule", 0],
      ["audit.read", "fallback", undefined],
    ]);
  });

  it("carries the relation to the resource, and not only into a finding", () => {
    const cells = describeCells(MATRIX, POLICY);

    expect(cells.map((cell) => [cell.resourceId, cell.relation])).toEqual([
      ["order-a-1", "own"],
      ["entry-b-9", "foreign-tenant"],
    ]);
  });
});

/**
 * The two fields of an isolation finding that name the shape of the leak.
 *
 * `relatedAccountId` is the other side of the pair — without it the report says
 * a tenant's data is visible to somebody and leaves "to whom" to be joined by
 * hand. `contextId` is what keeps a leak seen under declared conditions from
 * merging into the same defect group as the baseline one. Both stopped being
 * filled in without a single test noticing.
 */
describe("the finding of the tenant isolation check", () => {
  const LIST: Endpoint = {
    id: "orders.list",
    method: "GET",
    path: "/v1/orders",
    responseMustDifferByTenant: true,
  };

  /** One digest for every account: the whole point is that they match. */
  function matrixOf(accounts: readonly Account[]): AccessMatrix {
    return {
      endpoints: [LIST],
      accounts,
      resources: [],
      observations: accounts.map((account) => ({
        endpointId: "orders.list",
        accountId: account.id,
        status: 200,
        outcome: "allowed" as const,
        signals: { digest: 4_242 },
      })),
    };
  }

  const BASELINE: readonly Account[] = [
    { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
    { id: "carol-b", roleId: "user", tenantId: "tenant-b" },
  ];

  /**
   * The same pair under one set of declared conditions. Conditions have to match
   * for the pair to be compared at all — a pair differing in two variables says
   * nothing about either — so the finding has one `contextId`, not two.
   */
  const CONDITIONED: readonly Account[] = [
    {
      id: "alice-a@device-unverified",
      roleId: "user",
      tenantId: "tenant-a",
      contextId: "device-unverified",
      baseAccountId: "alice-a",
    },
    {
      id: "carol-b@device-unverified",
      roleId: "user",
      tenantId: "tenant-b",
      contextId: "device-unverified",
      baseAccountId: "carol-b",
    },
  ];

  const check = createIdenticalResponseCheck();

  it("names the account on the other side of the pair", () => {
    const findings = check.run({ matrix: matrixOf(BASELINE) });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.accountId).toBe("alice-a");
    expect(findings[0]?.relatedAccountId).toBe("carol-b");
  });

  it("says which conditions the pair was seen under, and says nothing in the baseline", () => {
    const underConditions = check.run({ matrix: matrixOf(CONDITIONED) });
    const baseline = check.run({ matrix: matrixOf(BASELINE) });

    expect(underConditions[0]?.contextId).toBe("device-unverified");
    expect(baseline[0]?.contextId).toBeUndefined();
  });
});

function finding(overrides: Partial<GroupableFinding> = {}): GroupableFinding {
  return {
    accountId: "alice",
    endpointId: "orders.read",
    kind: "privilege-escalation",
    severity: "high",
    ...overrides,
  };
}

/**
 * The defect signature, the name a ticket cites, and the order of the groups.
 *
 * Three separate things in one file, and each of them survived a mutation. The
 * separator was documented as a character identifiers never contain, with a
 * comment saying a hyphen would admit a collision — and a hyphen passed the
 * suite. The citable key is what a human pastes into a ticket and no test read
 * its contents. The tie-breakers decide the order the report prints, and without
 * them that order comes from whatever order the findings arrived in.
 */
describe("the defect signature", () => {
  /**
   * The collision the comment beside `SEPARATOR` warns about, made concrete.
   *
   * Two different signatures, glued with a hyphen, become one string: a hyphen
   * is an ordinary character in an endpoint id and in the name of a set of
   * conditions alike, so nothing marks where one field ends and the next begins.
   * Grouped together, two breakages of the platform are reported as one, and one
   * of the two tickets is never written.
   */
  it("does not let two different signatures glue into one", () => {
    const withoutRelation = finding({ endpointId: "orders.read-own", contextId: "geo-eu" });
    const withRelation = finding({
      endpointId: "orders.read",
      relation: "own",
      contextId: "-geo-eu",
    });

    expect(defectSignature(withoutRelation)).not.toBe(defectSignature(withRelation));
    expect(groupDefects([withoutRelation, withRelation])).toHaveLength(2);
  });

  /**
   * The key names the signature, all three parts of it. Reduced to the endpoint,
   * two defects on one endpoint — one on a foreign resource, one under declared
   * conditions — get the same name, and a ticket citing it points at both.
   */
  it("names the endpoint, the relation and the conditions", () => {
    const [full] = groupDefects([
      finding({ relation: "foreign-tenant", contextId: "geo-eu", resourceId: "order-b-2" }),
    ]);
    const [bare] = groupDefects([finding({ endpointId: "orders.list" })]);

    expect(full?.key).toBe("orders.read foreign-tenant geo-eu");
    // The absent halves are named rather than left empty: a key with a hole in
    // it is not something to paste into a ticket.
    expect(bare?.key).toBe("orders.list any-resource baseline");
  });
});

/**
 * The order of the groups, one tie-breaker at a time.
 *
 * Severity decides first and is covered elsewhere. Below it come four
 * comparisons, and each test here is arranged so that only its own comparison
 * can produce the expected order: the input order and the later comparisons all
 * point the other way. `Array.prototype.sort` is stable, so a tie-breaker that
 * stops being applied hands the decision back to the order the findings arrived
 * in — that is, to the walk over the matrix, which is not something the report
 * should inherit.
 */
describe("the order of the defect groups", () => {
  function keysOf(findings: readonly GroupableFinding[]): readonly string[] {
    return groupDefects(findings).map((group) => group.key);
  }

  it("orders by endpoint before anything else", () => {
    expect(
      keysOf([finding({ endpointId: "ep.zulu" }), finding({ endpointId: "ep.alpha" })]),
    ).toEqual(["ep.alpha any-resource baseline", "ep.zulu any-resource baseline"]);
  });

  /**
   * The kinds are compared before the relation. Here the two disagree — by kind
   * the `same-tenant` group comes first, by relation the `own` one does — so the
   * expected order can only come from the kinds.
   */
  it("orders by the kinds it was seen through before the relation", () => {
    expect(
      keysOf([
        finding({ relation: "own", kind: "privilege-escalation" }),
        finding({ relation: "same-tenant", kind: "not-observed" }),
      ]),
    ).toEqual(["orders.read same-tenant baseline", "orders.read own baseline"]);
  });

  /**
   * The relation is compared before the conditions, and here those two disagree
   * as well: `own` precedes `same-tenant`, while `apac` precedes `emea`.
   */
  it("orders by the relation before the conditions", () => {
    expect(
      keysOf([
        finding({ relation: "same-tenant", contextId: "apac" }),
        finding({ relation: "own", contextId: "emea" }),
      ]),
    ).toEqual(["orders.read own emea", "orders.read same-tenant apac"]);
  });

  /** Nothing but the conditions is left to separate these two. */
  it("orders by the conditions last", () => {
    expect(keysOf([finding({ contextId: "emea" }), finding({ contextId: "apac" })])).toEqual([
      "orders.read any-resource apac",
      "orders.read any-resource emea",
    ]);
  });
});

/**
 * The integrity of the matrix over resources.
 *
 * Both checks exist for endpoints and for accounts and are tested there. For
 * resources they were written and never proved: a repeated `resource.id` and an
 * observation about a resource nobody declared both passed. The consequence is
 * the one the function's own doc comment names — a resource coordinate that two
 * different records answer to, and a cell built out of an identifier the run
 * never had.
 */
describe("the integrity of the matrix over resources", () => {
  const INPUT = {
    endpoints: [ORDERS_READ],
    accounts: [ALICE],
    resources: [OWN_ORDER],
    observations: [observed("orders.read", "order-a-1", "allowed")],
  };

  it("rejects a duplicate resource id whatever else differs", () => {
    expect(() => {
      buildAccessMatrix({
        ...INPUT,
        resources: [OWN_ORDER, { ...FOREIGN_ENTRY, id: "order-a-1" }],
      });
    }).toThrow(DuplicateIdError);
  });

  it("rejects an observation about a resource that was never declared", () => {
    expect(() => {
      buildAccessMatrix({
        ...INPUT,
        observations: [observed("orders.read", "order-b-2", "allowed")],
      });
    }).toThrow(UnknownReferenceError);
  });
});

/**
 * The third coordinate of `findObservation`.
 *
 * The function is exported from the package, and no test passed it a resource:
 * ignoring the argument and answering with the first observation of the pair
 * left the suite green. A consumer of the library asking about one resource
 * would be answered about another — and a resource is a coordinate of the cell,
 * so the answer is about a different cell entirely.
 */
describe("finding an observation by the resource", () => {
  const OTHER_ORDER: Resource = {
    id: "order-b-2",
    tenantId: "tenant-b",
    params: { orderId: "2" },
  };

  const index = indexObservations(
    buildAccessMatrix({
      endpoints: [ORDERS_READ],
      accounts: [ALICE],
      resources: [OWN_ORDER, OTHER_ORDER],
      observations: [
        observed("orders.read", "order-a-1", "allowed"),
        observed("orders.read", "order-b-2", "denied"),
      ],
    }),
  );

  it("answers about the resource it was asked about", () => {
    expect(findObservation(index, "alice", "orders.read", "order-a-1")?.outcome).toBe("allowed");
    expect(findObservation(index, "alice", "orders.read", "order-b-2")?.outcome).toBe("denied");
  });

  it("invents no observation for a resource that was not probed", () => {
    expect(findObservation(index, "alice", "orders.read", "order-c-3")).toBeUndefined();
    // The cell without a resource is a cell of its own, and nothing was observed
    // there: answering with one of the resource rows would be an outcome for a
    // request that was never made.
    expect(findObservation(index, "alice", "orders.read")).toBeUndefined();
  });
});

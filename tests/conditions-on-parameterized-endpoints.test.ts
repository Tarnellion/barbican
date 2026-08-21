/**
 * Request conditions on an endpoint addressed by identifier.
 *
 * The cell is account × endpoint × resource × request conditions (ADR-0019),
 * and the walk over the matrix has **two** branches: an endpoint without
 * parameters is one cell, an endpoint with them is one cell per applicable
 * resource. Every scenario in `tests/core/contexts.test.ts` goes through
 * `orders.list`, which has no parameters — so the resource branch never once
 * received a `contextId`, and the whole ABAC slice on parameterized endpoints
 * rested on the polygon oracle, which is a separate CI job and not part of
 * `pnpm run test`.
 *
 * What that cost: dropping `account.contextId` from the resource branch of
 * `walk` in `src/core/diff.ts` left all 994 tests green while the oracle went
 * red — a clean platform grew twelve invented `unexpected-denial` findings and
 * exit 1, because a row under conditions was judged by the baseline rules.
 * `orders.read` is exactly where a geo restriction is worth testing: it is the
 * object-level endpoint, the one BOLA lives on.
 *
 * The same question was put to the neighbours by the same method — replace the
 * value with `undefined` and see who falls over — and the conditions turned out
 * to reach the wire and the report untested as well. All three layers are
 * covered here, because they are one hole: a condition declared by a human has
 * to survive from the policy to the request and back into the file.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import type {
  ContextAttributes,
  HttpClient,
  HttpRequest,
  HttpResponse,
} from "../src/adapters/ports.js";
import type {
  AccessDiff,
  AccessMatrix,
  Account,
  Endpoint,
  ResolvedFinding,
  Resource,
} from "../src/core/index.js";
import { describeCells, diffAccess } from "../src/core/index.js";
import { parseRunConfig, toAccounts } from "../src/io/config.js";
import { safeHeaders } from "../src/io/untrusted.js";
import type { BuildReportOptions } from "../src/report/build.js";
import { buildReport } from "../src/report/build.js";
import { collectObservations } from "../src/runner.js";

/** The object-level endpoint: parameters in the path, so cells carry a resource. */
const ORDERS_READ: Endpoint = { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" };

const OWN_ORDER: Resource = {
  id: "order-a-1",
  tenantId: "tenant-a",
  ownerAccountId: "alice",
  params: { orderId: "A-1" },
};

/**
 * The baseline row and the same account under conditions.
 *
 * `baseAccountId` is what keeps the row the same principal: the order stays
 * `own` for it, and the credentials presented are alice's.
 */
const ALICE: Account = { id: "alice", roleId: "user", tenantId: "tenant-a" };

const ALICE_GEO: Account = {
  id: "alice@geo-blocked",
  roleId: "user",
  tenantId: "tenant-a",
  contextId: "geo-blocked",
  baseAccountId: "alice",
  endpointIds: ["orders.read"],
};

/**
 * Rule 0 is the baseline expectation, rule 1 the one under conditions.
 *
 * They disagree about the same cell on purpose — that disagreement is the only
 * thing that can tell the two verdicts apart, and it is what the resource
 * branch was throwing away.
 */
const POLICY = {
  fallback: "denied",
  rules: [
    { roles: ["user"], endpoints: ["orders.read"], scope: "own", outcome: "allowed" },
    { roles: "*", endpoints: ["orders.read"], context: "geo-blocked", outcome: "denied" },
  ],
} as const;

function observed(
  accountId: string,
  outcome: "allowed" | "denied",
): AccessMatrix["observations"][number] {
  return {
    accountId,
    endpointId: "orders.read",
    resourceId: "order-a-1",
    status: outcome === "allowed" ? 200 : 451,
    outcome,
    headers: {},
    durationMs: 1,
  };
}

/** The platform's answer to the row under conditions is the variable. */
function matrix(
  underConditions: "allowed" | "denied",
  accounts: readonly Account[] = [ALICE, ALICE_GEO],
): AccessMatrix {
  return {
    endpoints: [ORDERS_READ],
    accounts,
    resources: [OWN_ORDER],
    observations: [observed("alice", "allowed"), observed(accounts[1]?.id ?? "", underConditions)],
  };
}

describe("the verdict on a cell with a resource under declared conditions", () => {
  /**
   * The geo bypass, on the endpoint it matters on. The platform serves alice's
   * own order to a request from a prohibited jurisdiction: permissions are
   * intact — she does own the order — and the restriction is not.
   *
   * Judged by the baseline rules this cell is `allowed` and agrees with what
   * happened, so the finding disappears entirely. That is the defect
   * `POLYGON_DEFECT_GEO_BYPASS` exists for, and until now nothing but the
   * polygon could see it on a parameterized endpoint.
   */
  it("reports a bypass the baseline rules would have called correct", () => {
    const findings = diffAccess(matrix("allowed"), POLICY);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      accountId: "alice@geo-blocked",
      endpointId: "orders.read",
      resourceId: "order-a-1",
      contextId: "geo-blocked",
      // Conditions change the request, not who makes it: the order is still
      // hers, so the relation and the severity are the ones for `own`.
      relation: "own",
      expected: "denied",
      actual: "allowed",
      kind: "privilege-escalation",
      severity: "medium",
      ruleIndex: 1,
    });
  });

  /**
   * The other direction, and the one that fired on the oracle: a **healthy**
   * platform refuses the request from the prohibited jurisdiction, and the
   * baseline rule says her own order is allowed. Resolve the cell without its
   * conditions and every such cell becomes an invented `unexpected-denial` —
   * twelve of them on the reference polygon, and exit 1 on a clean run.
   */
  it("invents no denial where the platform enforced the restriction", () => {
    expect(diffAccess(matrix("denied"), POLICY)).toEqual([]);
  });

  /**
   * The two cells side by side. Same role, same tenant, same endpoint, same
   * resource, same relation — and a different expectation, declared by a
   * different rule. Without the fourth coordinate reaching this branch the two
   * rows are one claim written twice.
   */
  it("gives the row under conditions a different verdict from the baseline row", () => {
    const cells = describeCells(matrix("denied"), POLICY);

    expect(
      cells.map((cell) => [cell.accountId, cell.resourceId, cell.expected, cell.ruleIndex]),
    ).toEqual([
      ["alice", "order-a-1", "allowed", 0],
      ["alice@geo-blocked", "order-a-1", "denied", 1],
    ]);
    expect(cells.map((cell) => cell.contextId)).toEqual([undefined, "geo-blocked"]);
  });

  /**
   * Conditions are matched **exactly**, and that holds on a resource cell too:
   * a rule with no `context` is a rule about the baseline, and conditions
   * nobody wrote a rule for are answered by `fallback`.
   *
   * Otherwise declaring a second set of conditions would quietly extend every
   * expectation already written to it — decision 1 of ADR-0019, which was
   * tested on `orders.list` alone.
   */
  it("answers unconditioned conditions from the fallback, not from the baseline rule", () => {
    const unverified: Account = {
      id: "alice@device-unverified",
      roleId: "user",
      tenantId: "tenant-a",
      contextId: "device-unverified",
      baseAccountId: "alice",
      endpointIds: ["orders.read"],
    };
    const cells = describeCells(matrix("denied", [ALICE, unverified]), POLICY);

    expect(cells[1]).toMatchObject({
      accountId: "alice@device-unverified",
      resourceId: "order-a-1",
      contextId: "device-unverified",
      expected: "denied",
      basis: "fallback",
    });
    expect(cells[1]?.ruleIndex).toBeUndefined();
  });
});

describe("the attributes of the conditions on the wire", () => {
  function fakeClient(): { client: HttpClient; seen: HttpRequest[] } {
    const seen: HttpRequest[] = [];
    const response: HttpResponse = { status: 200, headers: {} };
    return {
      seen,
      client: {
        send(request) {
          seen.push(request);
          return Promise.resolve(response);
        },
      },
    };
  }

  const ATTRIBUTES: ReadonlyMap<string, ContextAttributes> = new Map([
    [
      "alice@geo-blocked",
      {
        contextId: "geo-blocked",
        headers: safeHeaders([["cf-ipcountry", "AQ"]]),
        query: { locale: "en" },
      },
    ],
  ]);

  async function walk(): Promise<{
    seen: readonly HttpRequest[];
    observations: Awaited<ReturnType<typeof collectObservations>>["observations"];
  }> {
    const { client, seen } = fakeClient();
    const { observations } = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [ORDERS_READ],
      accounts: [ALICE, ALICE_GEO],
      resources: [OWN_ORDER],
      credentials: createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        new Map([["alice", "alice-token"]]),
      ),
      client,
      contextAttributes: ATTRIBUTES,
    });
    return { seen, observations };
  }

  /**
   * A query attribute travels through the building of the address, not through
   * the headers, and a resource cell is where the two meet: the path is
   * substituted from the resource and the query is merged on top of it. Nothing
   * asserted this for any cell — `contextAttributes` was named by no test at
   * all — so `attributes?.query` could be dropped from the call and the run
   * would probe the baseline case twice while the report claimed the conditions
   * had been exercised.
   */
  it("puts a query attribute into the address of a substituted path", async () => {
    const { observations } = await walk();

    expect(observations.find((o) => o.accountId === "alice")?.url).toBe(
      "https://api.test/v1/orders/A-1",
    );
    expect(observations.find((o) => o.accountId === "alice@geo-blocked")?.url).toBe(
      "https://api.test/v1/orders/A-1?locale=en",
    );
  });

  /**
   * The header half of the same claim, plus the one thing that must **not**
   * change with the conditions: the credentials. A row under conditions is the
   * same principal presenting the same token — the request is what differs.
   */
  it("adds a header attribute to the conditioned request and to no other", async () => {
    const { seen } = await walk();
    const underConditions = seen.find((request) => request.url.includes("locale=en"));
    const baseline = seen.find((request) => !request.url.includes("locale=en"));

    expect(seen).toHaveLength(2);
    expect(underConditions?.headers["cf-ipcountry"]).toBe("AQ");
    expect(baseline?.headers["cf-ipcountry"]).toBeUndefined();
    expect(underConditions?.headers.authorization).toBe("Bearer alice-token");
    expect(baseline?.headers.authorization).toBe("Bearer alice-token");
  });
});

describe("the conditions on the way into the report", () => {
  const CONFIG = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE }
resources:
  - { id: order-a-1, tenant: tenant-a, owner: alice, params: { orderId: "A-1" } }
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.read], scope: own, outcome: allowed }
    - { roles: "*", endpoints: [orders.read], context: geo-blocked, outcome: denied }
contexts:
  - id: geo-blocked
    description: the request arrives from Antarctica
    headers: { cf-ipcountry: AQ }
    endpoints: [orders.read]
`);

  const DIFF: AccessDiff = {
    accountId: "alice@geo-blocked",
    endpointId: "orders.read",
    resourceId: "order-a-1",
    contextId: "geo-blocked",
    relation: "own",
    expected: "denied",
    actual: "allowed",
    kind: "privilege-escalation",
    basis: "rule",
    ruleIndex: 1,
    severity: "medium",
  };

  const CHECK_FINDING: ResolvedFinding = {
    checkId: "identical-response-across-tenants",
    severity: "high",
    title: "the responses of two tenants matched",
    accountId: "alice@geo-blocked",
    endpointId: "orders.read",
    contextId: "geo-blocked",
    evidence: { otherAccountId: "bob" },
  };

  function build(): ReturnType<typeof buildReport> {
    const options: BuildReportOptions = {
      version: "test",
      config: CONFIG,
      accounts: toAccounts(CONFIG).accounts,
      endpoints: [ORDERS_READ],
      observations: [
        {
          accountId: "alice@geo-blocked",
          endpointId: "orders.read",
          resourceId: "order-a-1",
          method: "GET",
          url: "https://api.test/v1/orders/A-1",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
      ],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 1,
      truncated: false,
      findings: [DIFF],
      checks: [CHECK_FINDING],
      policy: { fallback: "denied", rules: [] },
      startedAt: new Date(0),
      finishedAt: new Date(1),
    };
    return buildReport(options);
  }

  /**
   * The conditions are part of the defect signature (decision 6 of ADR-0019),
   * and the signature is built from the published finding. Lose `contextId`
   * here and the geo finding merges with the baseline one: the report says
   * there is one breakage where there are two mechanisms, and a fix closes
   * half of it.
   */
  it("names the conditions on a matrix finding made on a resource cell", () => {
    const finding = build().findings.find((f) => f.source === "matrix");

    expect(finding).toMatchObject({
      accountId: "alice@geo-blocked",
      resourceId: "order-a-1",
      contextId: "geo-blocked",
    });
  });

  /**
   * The line a reader reproduces the finding from. A header attribute is
   * visible nowhere in the address, so without it printed next to the request
   * the reproduction runs the **baseline** case and comes back clean.
   */
  it("prints the header attributes next to the request they were sent with", () => {
    const finding = build().findings.find((f) => f.source === "matrix");

    expect(finding?.request).toMatchObject({
      method: "GET",
      url: "https://api.test/v1/orders/A-1",
      as: "alice@geo-blocked",
      contextHeaders: { "cf-ipcountry": "AQ" },
    });
  });

  /**
   * The same field on the other kind of finding. It was dropped here once
   * already — the mapping named the fields one at a time and a new one was
   * simply not named — and `nothingLeftUnnamed` catches a field added to the
   * source, not a field the mapping stops carrying.
   */
  it("names the conditions on a check finding too", () => {
    const finding = build().findings.find((f) => f.source === "check");

    expect(finding).toMatchObject({
      kind: "identical-response-across-tenants",
      accountId: "alice@geo-blocked",
      contextId: "geo-blocked",
    });
  });
});

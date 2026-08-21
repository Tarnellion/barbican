/**
 * Run tests.
 *
 * The core compares intent against observations, but the observations
 * themselves are born here — and a mistake in reducing a status to a
 * conclusion about access would distort the whole report.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import type {
  CredentialProvider,
  HttpClient,
  HttpRequest,
  HttpResponse,
  SignedRequest,
} from "../src/adapters/ports.js";
import type { Account, Endpoint } from "../src/core/index.js";
import { expandPolicy } from "../src/core/index.js";
import { safeHeaders } from "../src/io/untrusted.js";
import {
  assertCanariesUsable,
  classifyStatus,
  collectObservations,
  DeniedCanaryError,
  ExcludedCanaryError,
  planEndpoints,
  probeCanaries,
  TemplatedCanaryError,
  UnknownCanaryEndpointError,
} from "../src/runner.js";

const accounts: readonly Account[] = [
  { id: "player-a", roleId: "player", tenantId: "tenant-a" },
  { id: "admin-a", roleId: "admin", tenantId: "tenant-a" },
];

function fakeClient(reply: (request: HttpRequest) => HttpResponse | Error): {
  client: HttpClient;
  seen: HttpRequest[];
} {
  const seen: HttpRequest[] = [];
  return {
    seen,
    client: {
      send(request) {
        seen.push(request);
        const result = reply(request);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
  };
}

describe("classifyStatus", () => {
  it("counts only 2xx as access granted", () => {
    expect(classifyStatus(200)).toBe("allowed");
    expect(classifyStatus(204)).toBe("allowed");
    expect(classifyStatus(299)).toBe("allowed");
  });

  it("counts 401, 403 and 451 as denials", () => {
    expect(classifyStatus(401)).toBe("denied");
    expect(classifyStatus(403)).toBe("denied");
    // "Unavailable for legal reasons" is a decision not to serve, not a
    // failure. That is how geo and jurisdiction restrictions answer; without
    // this line a healthy platform would give a wall of probe-error exactly
    // where it works.
    expect(classifyStatus(451)).toBe("denied");
  });

  it("sets 404 apart", () => {
    expect(classifyStatus(404)).toBe("not-found");
  });

  // Recording an ambiguous response as a denial means passing the absence of a
  // conclusion off as proof of protection.
  it("draws no conclusion about access from other statuses", () => {
    for (const status of [301, 302, 400, 405, 429, 500, 503]) {
      expect(classifyStatus(status)).toBe("error");
    }
  });
});

describe("request signing", () => {
  /**
   * Headers used to be computed once per account and reused across every cell.
   * A provider that signs the method and the path would have signed the first
   * cell and sent that signature to all of them: the platform would reject
   * everything but the first request, and the report would come out as "there
   * is no access anywhere" — indistinguishable from a healthy platform with
   * access closed.
   */
  it("gives the provider the address of every cell, not of the first one", async () => {
    const endpoints: readonly Endpoint[] = [
      { id: "users.list", method: "GET", path: "/v1/admin/users" },
      { id: "tickets.list", method: "GET", path: "/v1/support/tickets" },
    ];
    const asked: SignedRequest[] = [];
    const signing: CredentialProvider = {
      headersFor(accountId, request) {
        asked.push(request);
        return safeHeaders([
          ["x-signature", `${accountId}:${request.method}:${new URL(request.url).pathname}`],
        ]);
      },
    };

    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));
    await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: accounts.slice(0, 1),
      credentials: signing,
      client,
    });

    expect(asked.map((request) => request.url)).toEqual([
      "https://api.test/v1/admin/users",
      "https://api.test/v1/support/tickets",
    ]);
    expect(seen.map((request) => request.headers?.["x-signature"])).toEqual([
      "player-a:GET:/v1/admin/users",
      "player-a:GET:/v1/support/tickets",
    ]);
  });

  it("signs the canary request too", async () => {
    const asked: SignedRequest[] = [];
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));
    await probeCanaries({
      baseUrl: "https://api.test",
      endpoints: [{ id: "whoami", method: "GET", path: "/v1/me" }],
      canaries: [{ accountId: "player-a", endpointId: "whoami" }],
      credentials: {
        headersFor(_accountId, request) {
          asked.push(request);
          return {};
        },
      },
      client,
    });

    expect(asked).toEqual([{ method: "GET", url: "https://api.test/v1/me" }]);
  });

  /**
   * A cold read of 14 August ran against a stand that was not up, and the canary
   * answered "401 reads as a denial" — so the reader went looking for a stale
   * token instead of a wrong port. `status: 0` alone cannot tell the two apart;
   * the code can.
   *
   * A code and never the error text: this field is serialized into the report.
   */
  it("keeps the transport failure's code apart from a refusal", async () => {
    const refused = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8791"), {
        code: "ECONNREFUSED",
      }),
    });

    const results = await probeCanaries({
      baseUrl: "https://api.test",
      endpoints: [
        { id: "whoami", method: "GET", path: "/v1/me" },
        { id: "orders", method: "GET", path: "/v1/orders" },
      ],
      canaries: [
        { accountId: "player-a", endpointId: "whoami" },
        { accountId: "player-b", endpointId: "orders" },
      ],
      credentials: { headersFor: () => ({}) },
      client: {
        send: (request) => {
          if (request.url.endsWith("/v1/me")) {
            return Promise.reject(refused);
          }
          return Promise.resolve({ status: 401, headers: {} });
        },
      },
    });

    expect(results[0]).toMatchObject({ status: 0, authenticated: false, failure: "ECONNREFUSED" });
    // A refusal is a different fact and carries no code: the platform answered.
    expect(results[1]).toMatchObject({ status: 401, authenticated: false });
    expect(results[1]).not.toHaveProperty("failure");
  });

  // An error with no code at all still has to be distinguishable from a status.
  it("falls back to a placeholder when the failure carries no code", async () => {
    const results = await probeCanaries({
      baseUrl: "https://api.test",
      endpoints: [{ id: "whoami", method: "GET", path: "/v1/me" }],
      canaries: [{ accountId: "player-a", endpointId: "whoami" }],
      credentials: { headersFor: () => ({}) },
      client: { send: () => Promise.reject(new Error("something went wrong")) },
    });

    expect(results[0]).toMatchObject({ status: 0, failure: "TRANSPORT" });
  });
});

/**
 * The split into "will be probed" and "will not" is a function of its own so that
 * `--dry-run` prints the same answer the run acts on. A preview computed beside
 * the run would agree with it until one of the two was edited — and on someone
 * else's deployment a preview that lies about what will be touched is worse than
 * no preview at all.
 */
describe("planEndpoints", () => {
  const all: readonly Endpoint[] = [
    { id: "orders.list", method: "GET", path: "/v1/orders" },
    { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
    { id: "orders.cancel", method: "POST", path: "/v1/orders/{orderId}/cancel" },
    { id: "reset", method: "GET", path: "/v1/reset" },
  ];
  const resources = [{ id: "own", tenantId: "t", ownerId: "a", params: { orderId: "1" } }] as const;

  it("holds a write method back until the flag is given", () => {
    const plan = planEndpoints({ endpoints: all, baseUrl: "https://api.test", resources });

    expect(plan.skipped).toContainEqual({ endpointId: "orders.cancel", reason: "unsafe-method" });
    expect(plan.probeable.map((one) => one.id)).not.toContain("orders.cancel");
  });

  it("lets it through when it is", () => {
    const plan = planEndpoints({
      endpoints: all,
      baseUrl: "https://api.test",
      resources,
      allowUnsafeMethods: true,
    });

    expect(plan.probeable.map((one) => one.id)).toContain("orders.cancel");
  });

  // A GET is not obliged to be safe: the exclusion list is the answer to a read
  // that resets the database, and it outranks the method.
  it("puts an excluded endpoint ahead of every other reason", () => {
    const plan = planEndpoints({
      endpoints: all,
      baseUrl: "https://api.test",
      resources,
      exclude: ["reset", "orders.cancel"],
      allowUnsafeMethods: true,
    });

    expect(plan.skipped).toContainEqual({ endpointId: "reset", reason: "excluded" });
    expect(plan.skipped).toContainEqual({ endpointId: "orders.cancel", reason: "excluded" });
  });

  it("skips a parameterised path no resource fills in", () => {
    const plan = planEndpoints({ endpoints: all, baseUrl: "https://api.test" });

    expect(plan.skipped).toContainEqual({ endpointId: "orders.read", reason: "path-parameters" });
  });
});

describe("collectObservations", () => {
  const endpoints: readonly Endpoint[] = [
    { id: "users.list", method: "GET", path: "/v1/admin/users" },
    { id: "tickets.list", method: "GET", path: "/v1/support/tickets" },
  ];

  describe("signals over the body", () => {
    function collect(marked: readonly Endpoint[], response: HttpResponse) {
      const { client, seen } = fakeClient(() => response);
      return collectObservations({
        baseUrl: "https://api.test",
        endpoints: marked,
        accounts: accounts.slice(0, 1),
        credentials: createCredentialProvider(
          DEFAULT_AUTH_SCHEME,
          new Map([["player-a", "player-token"]]),
        ),
        client,
      }).then((result) => ({ result, seen }));
    }

    /** The body is read only where a human declared responseMustDifferByTenant. */
    it("asks for signals only on the marked endpoints", async () => {
      const marked: readonly Endpoint[] = [
        {
          id: "users.list",
          method: "GET",
          path: "/v1/admin/users",
          responseMustDifferByTenant: true,
        },
        { id: "tickets.list", method: "GET", path: "/v1/support/tickets" },
      ];

      const { seen } = await collect(marked, { status: 200, headers: {} });

      expect(seen[0]?.signals).toEqual([{ name: "digest", kind: "digest" }]);
      expect(seen[1]?.signals).toBeUndefined();
    });

    it("carries the computed signals into the observation", async () => {
      const marked: readonly Endpoint[] = [
        {
          id: "users.list",
          method: "GET",
          path: "/v1/admin/users",
          responseMustDifferByTenant: true,
        },
      ];

      const { result } = await collect(marked, {
        status: 200,
        headers: {},
        signals: { digest: 42 },
      });

      expect(result.observations[0]?.signals).toEqual({ digest: 42 });
    });

    /**
     * The digest is implied by the mark, and declared scalars are added to it.
     * The mark used to override the declaration: only the digest was requested.
     */
    it("adds the implied digest to the declared scalars", async () => {
      const marked: readonly Endpoint[] = [
        {
          id: "users.list",
          method: "GET",
          path: "/v1/admin/users",
          responseMustDifferByTenant: true,
          signals: [{ name: "n", kind: "count", path: "items" }],
        },
      ];

      const { seen } = await collect(marked, { status: 200, headers: {} });

      expect(seen[0]?.signals).toEqual([
        { name: "digest", kind: "digest" },
        { name: "n", kind: "count", path: "items" },
      ]);
    });

    it("reads the body for a declared scalar alone, without the mark", async () => {
      const marked: readonly Endpoint[] = [
        {
          id: "users.list",
          method: "GET",
          path: "/v1/admin/users",
          signals: [{ name: "n", kind: "count", path: "items" }],
        },
      ];

      const { seen } = await collect(marked, { status: 200, headers: {} });

      expect(seen[0]?.signals).toEqual([{ name: "n", kind: "count", path: "items" }]);
    });

    it("leaves the observation without signals when there is no mark", async () => {
      const { result } = await collect([{ id: "users.list", method: "GET", path: "/v1/x" }], {
        status: 200,
        headers: {},
      });

      expect(result.observations[0]?.signals).toBeUndefined();
    });
  });

  it("probes every account x endpoint pair", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts,
      credentials: createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        new Map([
          ["player-a", "player-token"],
          ["admin-a", "admin-token"],
        ]),
      ),
      client,
    });

    expect(result.observations).toHaveLength(4);
    expect(seen).toHaveLength(4);
    expect(seen.map((r) => r.url)).toEqual([
      "https://api.test/v1/admin/users",
      "https://api.test/v1/support/tickets",
      "https://api.test/v1/admin/users",
      "https://api.test/v1/support/tickets",
    ]);
  });

  it("presents the token of the account it makes the request as", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [endpoints[0] ?? { id: "x", method: "GET", path: "/x" }],
      accounts,
      credentials: createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        new Map([
          ["player-a", "player-token"],
          ["admin-a", "admin-token"],
        ]),
      ),
      client,
    });

    expect(seen[0]?.headers.authorization).toBe("Bearer player-token");
    expect(seen[1]?.headers.authorization).toBe("Bearer admin-token");
  });

  it("skips endpoints with path parameters and reports it", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [
        { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
        { id: "users.list", method: "GET", path: "/v1/admin/users" },
      ],
      accounts: [accounts[0] ?? { id: "x", roleId: "r", tenantId: "t" }],
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["player-a", "t"]])),
      client,
    });

    // What was not tested must not look like what was.
    expect(result.skipped).toEqual([{ endpointId: "profile.read", reason: "path-parameters" }]);
    expect(result.observations).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("records a failed request as no conclusion, not as a denial", async () => {
    const { client } = fakeClient(() => new Error("the connection was reset"));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [endpoints[0] ?? { id: "x", method: "GET", path: "/x" }],
      accounts: [accounts[0] ?? { id: "x", roleId: "r", tenantId: "t" }],
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["player-a", "t"]])),
      client,
    });

    expect(result.observations[0]?.outcome).toBe("error");
    expect(result.observations[0]?.status).toBe(0);
  });

  it("puts no token into the observations", async () => {
    const { client } = fakeClient(() => ({
      status: 200,
      headers: { "set-cookie": "[REDACTED]" },
    }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts,
      credentials: createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        new Map([
          ["player-a", "secret-player-token"],
          ["admin-a", "secret-admin-token"],
        ]),
      ),
      client,
    });

    expect(JSON.stringify(result)).not.toContain("secret-");
  });

  it("assembles a correct URL regardless of slashes", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test/base/",
      endpoints: [{ id: "x", method: "GET", path: "/v1/x" }],
      accounts: [accounts[0] ?? { id: "x", roleId: "r", tenantId: "t" }],
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["player-a", "t"]])),
      client,
    });

    expect(seen[0]?.url).toBe("https://api.test/base/v1/x");
  });
});

describe("what the tool does not touch", () => {
  const endpoints: readonly Endpoint[] = [
    { id: "users.list", method: "GET", path: "/v1/users" },
    { id: "users.create", method: "POST", path: "/v1/users" },
    { id: "db.reset", method: "GET", path: "/createdb" },
  ];
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];

  it("does not count refusing an unsafe method as a failure", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: one,
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]])),
      client,
    });

    // The tool working as intended must not look like a breakage in the report.
    expect(result.failures).toEqual([]);
    expect(result.skipped).toContainEqual({ endpointId: "users.create", reason: "unsafe-method" });
    expect(seen.map((r) => r.method)).not.toContain("POST");
  });

  it("probes an unsafe method when explicitly allowed", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: one,
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]])),
      client,
      allowUnsafeMethods: true,
    });

    expect(seen.map((r) => r.method)).toContain("POST");
  });

  it("does not touch an excluded endpoint even with a safe method", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: one,
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]])),
      client,
      exclude: ["db.reset"],
    });

    // A GET is not obliged to be safe in practice: /createdb resets the database.
    expect(result.skipped).toContainEqual({ endpointId: "db.reset", reason: "excluded" });
    expect(seen.map((r) => r.url)).not.toContain("https://api.test/createdb");
  });
});

describe("safeguards against an untrustworthy run", () => {
  const endpoints: readonly Endpoint[] = [
    { id: "me", method: "GET", path: "/v1/me" },
    { id: "users.list", method: "GET", path: "/v1/users" },
    { id: "profile", method: "GET", path: "/v1/players/{id}" },
  ];
  const two: readonly Account[] = [
    { id: "a", roleId: "player", tenantId: "t" },
    { id: "b", roleId: "admin", tenantId: "t" },
  ];
  const credentials = createCredentialProvider(
    DEFAULT_AUTH_SCHEME,
    new Map([
      ["a", "tok-a"],
      ["b", "tok-b"],
    ]),
  );

  it("reports the account as unauthenticated when the canary answers with a denial", async () => {
    const { client } = fakeClient((request) => ({
      status: request.headers.authorization === "Bearer tok-a" ? 401 : 200,
      headers: {},
    }));

    const results = await probeCanaries({
      baseUrl: "https://api.test",
      endpoints,
      canaries: [
        { accountId: "a", endpointId: "me" },
        { accountId: "b", endpointId: "me" },
      ],
      credentials,
      client,
    });

    expect(results).toEqual([
      { accountId: "a", endpointId: "me", status: 401, authenticated: false },
      { accountId: "b", endpointId: "me", status: 200, authenticated: true },
    ]);
  });

  it("rejects a canary on an unknown endpoint", async () => {
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));

    await expect(
      probeCanaries({
        baseUrl: "https://api.test",
        endpoints,
        canaries: [{ accountId: "a", endpointId: "no-such-endpoint" }],
        credentials,
        client,
      }),
    ).rejects.toThrow(UnknownCanaryEndpointError);
  });

  // The exclude list exists exactly for addresses that must not be touched —
  // a GET that resets the database. A canary must not be a way around it.
  it("rejects a canary on an excluded endpoint", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await expect(
      probeCanaries({
        baseUrl: "https://api.test",
        endpoints,
        canaries: [{ accountId: "a", endpointId: "me" }],
        credentials,
        client,
        exclude: ["me"],
      }),
    ).rejects.toThrow(ExcludedCanaryError);
    expect(seen).toEqual([]);
  });

  /**
   * A canary the policy denies is two statements by the same person that cannot
   * both be true.
   *
   * A canary is chosen because the account demonstrably reaches the endpoint —
   * the run stops if it does not — and the policy says the role may not. Left
   * alone, the walk probes the same endpoint, gets the same 200, and files a
   * `privilege-escalation` against a platform that did nothing wrong: a finding
   * that was inevitable before the first request, sitting beside findings that
   * were not, and costing them the trust a reader spends on the list.
   *
   * Found on 18 August 2026 by a subagent writing the guide's section on roles —
   * in its own example, which is where the contradiction is easiest to make.
   */
  it("rejects a canary the policy denies to that account's role", () => {
    const policy = expandPolicy({ fallback: "denied", rules: [] }, endpoints);

    expect(() =>
      assertCanariesUsable({
        endpoints,
        canaries: [{ accountId: "a", endpointId: "me", roleId: "customer" }],
        policy,
      }),
    ).toThrow(DeniedCanaryError);
    // The message names both halves of the contradiction, or it is not actionable.
    expect(() =>
      assertCanariesUsable({
        endpoints,
        canaries: [{ accountId: "a", endpointId: "me", roleId: "customer" }],
        policy,
      }),
    ).toThrow(/customer[\s\S]*privilege escalation|privilege escalation[\s\S]*customer/);
  });

  it("accepts a canary the policy allows", () => {
    const policy = expandPolicy(
      {
        fallback: "denied",
        rules: [{ roles: ["customer"], endpoints: ["me"], outcome: "allowed" }],
      },
      endpoints,
    );

    expect(() =>
      assertCanariesUsable({
        endpoints,
        canaries: [{ accountId: "a", endpointId: "me", roleId: "customer" }],
        policy,
      }),
    ).not.toThrow();
  });

  /** And a caller with no policy to compare against still gets the other three. */
  it("keeps the first three checks when no policy is given", () => {
    expect(() =>
      assertCanariesUsable({
        endpoints,
        canaries: [{ accountId: "a", endpointId: "me", roleId: "customer" }],
      }),
    ).not.toThrow();
    expect(() =>
      assertCanariesUsable({
        endpoints,
        canaries: [{ accountId: "a", endpointId: "nope" }],
      }),
    ).toThrow(UnknownCanaryEndpointError);
  });

  it("rejects a canary on an endpoint with a path parameter", async () => {
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));

    await expect(
      probeCanaries({
        baseUrl: "https://api.test",
        endpoints,
        canaries: [{ accountId: "a", endpointId: "profile" }],
        credentials,
        client,
      }),
    ).rejects.toThrow(TemplatedCanaryError);
  });

  it("returns the list of endpoints actually probed", async () => {
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: [two[0] ?? { id: "a", roleId: "r", tenantId: "t" }],
      credentials,
      client,
    });

    // profile was skipped over a path parameter and must not enter the matrix.
    expect(result.probed.map((e) => e.id)).toEqual(["me", "users.list"]);
  });
});

// Found by adversarial review: `new URL(path, base)` gives priority to the
// absolute address, so a path from the specification overrode the base URL
// entirely. The host name did not change, so the allowlist let it through —
// and the token went out in the clear to a port chosen by the system under test.
describe("a path from the specification does not control the address", () => {
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "token"]]));

  async function probe(path: string) {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));
    const result = await collectObservations({
      baseUrl: "https://api.example.test/v1",
      endpoints: [{ id: "e", method: "GET", path }],
      accounts: one,
      credentials,
      client,
    });
    return { seen, result };
  }

  it("rejects an absolute address with a different scheme and port", async () => {
    const { seen, result } = await probe("http://api.example.test:9999/exfil");

    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "e", reason: "escapes-target" }]);
  });

  it("rejects an absolute address pointing at another host", async () => {
    const { seen, result } = await probe("https://evil.test/x");

    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "e", reason: "escapes-target" }]);
  });

  it("refuses a backslash instead of normalising it away", async () => {
    const { seen, result } = await probe("/\\evil.test/x");

    // This used to assert that the route "stays inside the target": the leading
    // backslash was trimmed and the address came out `/v1/evil.test/x`. Trimming
    // the leading one was the whole of it, and a backslash in the middle is a
    // path separator to the URL parser — `/v1/reports\..\..\danger` arrived at
    // `/danger`, past an exclusion list that works on ids. The character is
    // refused now, at the seam where the address is built. See
    // `isAddressablePath` and ADR-0032.
    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "e", reason: "escapes-target" }]);
  });

  it("an ordinary path is assembled as before", async () => {
    const { seen } = await probe("/users");

    expect(seen[0]?.url).toBe("https://api.example.test/v1/users");
  });
});

describe("requests to resources", () => {
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));
  const profile: Endpoint = { id: "profile", method: "GET", path: "/v1/players/{playerId}" };

  it("substitutes a resource's values into the path and probes each one once", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      resources: [
        { id: "r1", tenantId: "t", params: { playerId: "1001" } },
        { id: "r2", tenantId: "t", params: { playerId: "2002" } },
      ],
    });

    expect(seen.map((r) => r.url)).toEqual([
      "https://api.test/v1/players/1001",
      "https://api.test/v1/players/2002",
    ]);
    expect(result.observations.map((o) => o.resourceId)).toEqual(["r1", "r2"]);
  });

  it("encodes the value instead of inserting it as-is", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { playerId: "a b" } }],
    });

    expect(seen[0]?.url).toBe("https://api.test/v1/players/a%20b");
  });

  /**
   * A separator no longer relies on being escaped. `..%2Fadmin` is one segment
   * here and `../admin` to a router that decodes before it matches — the cell
   * then fails instead of quietly addressing a neighbour. See ADR-0035.
   */
  it("fails the cell rather than encoding a separator", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { playerId: "../admin" } }],
    });

    expect(seen).toHaveLength(0);
    expect(result.failures[0]?.reason).toContain("../admin");
  });

  it("adds query string parameters", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "report", method: "GET", path: "/v1/report" }],
      accounts: one,
      credentials,
      client,
      // Found while scouting crAPI: the identifier sometimes sits in the query
      // rather than the path. Such an endpoint has no parameters in its
      // template, so the binding is explicit.
      resources: [
        { id: "r", tenantId: "t", params: {}, query: { report_id: "1" }, endpointIds: ["report"] },
      ],
    });

    expect(seen[0]?.url).toBe("https://api.test/v1/report?report_id=1");
  });

  it("skips a parameterized endpoint when no resource has those parameters", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "other", tenantId: "t", params: { orderId: "7" } }],
    });

    expect(result.skipped).toEqual([{ endpointId: "profile", reason: "path-parameters" }]);
    expect(seen).toEqual([]);
  });

  it("does not bind a resource to an endpoint without parameters", async () => {
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "ping", method: "GET", path: "/ping" }],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { playerId: "1" } }],
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.resourceId).toBeUndefined();
  });
});

describe("a resource's value does not divert the request", () => {
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));
  const profile: Endpoint = { id: "p", method: "GET", path: "/v1/players/{playerId}" };

  async function probeWith(params: Record<string, string>) {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));
    const result = await collectObservations({
      baseUrl: "https://api.test/api",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params }],
    });
    return { seen, result };
  }

  /**
   * The mechanism is subtler than it looks: encodeURIComponent encodes the slash
   * but NOT the dots, so a bare `..` climbs exactly one level up. When the
   * parameter sits at the start of the path, that is enough to leave the declared
   * base path. The scope check ran over the template, before substitution, and
   * did not see this.
   *
   * The refusal moved earlier after the audit of 14 August: such a value is now
   * rejected while the address is being assembled, rather than caught by the
   * scope guard afterwards. The guard only ever saw the case where there was a
   * base path to climb out of — with a `baseUrl` of bare origin there is nothing
   * above `/`, and the same value instead addressed a **neighbouring endpoint**
   * inside the target, which no scope check can catch. Either way the request
   * does not go out, and that is what this asserts.
   */
  it("does not let a value with .. divert the request", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test/api",
      endpoints: [{ id: "p", method: "GET", path: "/{playerId}/orders" }],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { playerId: ".." } }],
    });

    expect(seen).toEqual([]);
    expect(result.failures[0]?.reason).toContain("path navigation rather than an identifier");
  });

  /**
   * The case the scope guard cannot reach, and the one the audit actually found:
   * a bare origin as the target, `.` as the value. Nothing leaves the base path —
   * there is nothing above `/` — and the request lands on the collection endpoint
   * next door, the one `exclude` was there to protect.
   */
  it("does not let a value of . address the neighbouring endpoint", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" }],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { orderId: "." } }],
    });

    // Before the fix this sent GET /v1/orders/ and recorded its answer as the
    // verdict for orders.read.
    expect(seen).toEqual([]);
    expect(result.failures[0]?.reason).toContain("path navigation rather than an identifier");
  });

  it("a slash in the value stops the cell instead of being escaped", async () => {
    const { seen, result } = await probeWith({ playerId: "../.." });

    expect(seen).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
  });

  it("encodes an ordinary value and stays inside the base path", async () => {
    const { seen } = await probeWith({ playerId: "1001" });

    expect(seen[0]?.url).toBe("https://api.test/api/v1/players/1001");
  });

  // Parameter names come from an untrusted specification, and the prototype
  // answers to {constructor} on any object.
  it("does not pick up a resource by a name from the prototype chain", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "x", method: "GET", path: "/v1/x/{constructor}" }],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { playerId: "1001" } }],
    });

    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "x", reason: "path-parameters" }]);
  });
});

describe("a resource with parameters the endpoint does not have", () => {
  it("substitutes an empty string for a name the resource lacks", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    // The resource is bound by an explicit list but does not cover every path
    // parameter: a missing name gives an empty segment, not junk from the
    // prototype.
    await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "p", method: "GET", path: "/v1/{a}/{b}" }],
      accounts: [{ id: "a", roleId: "r", tenantId: "t" }],
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]])),
      client,
      resources: [{ id: "r", tenantId: "t", params: { a: "1", b: "2" }, endpointIds: ["p"] }],
    });

    expect(seen[0]?.url).toBe("https://api.test/v1/1/2");
  });
});

describe("a run cut short", () => {
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));
  const two: readonly Endpoint[] = [
    { id: "e1", method: "GET", path: "/1" },
    { id: "e2", method: "GET", path: "/2" },
  ];

  // An exhausted request ceiling cuts the walk short in the middle of the
  // matrix: the tail is untested, and without this flag a "clean" verdict is
  // indistinguishable from a real one.
  it("is flagged when the budget runs out", async () => {
    const budget = Object.assign(new Error("the budget is exhausted"), {
      name: "RunBudgetExhaustedError",
    });
    let call = 0;
    const { client } = fakeClient(() => {
      call += 1;
      return call === 1 ? { status: 200, headers: {} } : budget;
    });

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: two,
      accounts: one,
      credentials,
      client,
    });

    expect(result.truncated).toBe(true);
  });

  it("is not flagged on an ordinary request failure", async () => {
    const { client } = fakeClient(() => new Error("the connection was reset"));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: two,
      accounts: one,
      credentials,
      client,
    });

    expect(result.truncated).toBe(false);
  });

  it("the canary does not throw when the request fails", async () => {
    const { client } = fakeClient(() => new Error("the deployment does not answer"));

    const results = await probeCanaries({
      baseUrl: "https://api.test",
      endpoints: two,
      canaries: [{ accountId: "a", endpointId: "e1" }],
      credentials,
      client,
    });

    expect(results[0]).toEqual({
      accountId: "a",
      endpointId: "e1",
      status: 0,
      authenticated: false,
      // The error here carries no code, so the placeholder stands in — but the
      // field is present, and that is what tells "did not answer" from "refused".
      failure: "TRANSPORT",
    });
  });
});

/**
 * Configuration parsing tests.
 *
 * Special attention goes to keeping tokens out of the configuration itself:
 * it is serialized into the report, and a token leaked there would outlive
 * the run.
 */

import { describe, expect, it } from "vitest";
import {
  DuplicateMembershipError,
  RESOURCE_RELATIONS,
  SubsumedMembershipError,
  TenantCycleError,
  UnknownParentTenantError,
} from "../../src/core/index.js";
import {
  AuthSchemeWithoutTokenError,
  applyBodySignals,
  assertReferencesResolve,
  CompareSubtreeWithoutComparisonError,
  ConfigParseError,
  ConfigTooDeepError,
  ConfigTooLargeError,
  ConfigValidationError,
  CredentialsInUrlError,
  DuplicateAccountIdError,
  DuplicateCompareSubtreeError,
  DuplicateResourceIdError,
  DuplicateSignalNameError,
  HostOutsideScopeError,
  InvalidCredentialError,
  MissingCredentialError,
  parseRunConfig,
  ReservedSignalNameError,
  resolveTokens,
  SharedCredentialError,
  toAccounts,
  UnknownAuthSchemeError,
  UnknownEndpointReferenceError,
  UnknownResourceOwnerError,
  UnknownRoleReferenceError,
  UnknownTenantError,
  UnusablePathParameterError,
  UnusedAuthSchemeError,
  UnusedResourceError,
} from "../../src/io/config.js";

const VALID = `
target:
  baseUrl: https://staging.example.test/api
  allowedHosts: [staging.example.test]

accounts:
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: TOKEN_PLAYER_A }
  - { id: admin-a,  role: admin,  tenant: tenant-a, tokenEnv: TOKEN_ADMIN_A }

policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [profile.read], outcome: allowed }
    - { roles: [admin], endpoints: "*", outcome: allowed }
`;

/**
 * Size and depth, which this path alone lacked.
 *
 * The three endpoint sources have had them since they were written; here only
 * the alias count was in place — the billion-laughs defence. A configuration is
 * a file an operator may receive from somebody else along with a report to
 * reproduce, and "the parser ran out of stack" is not a refusal anyone can act
 * on. Found by the audit of 14 August 2026 (D-7), whose wording overstates it.
 */
describe("the limits on a run configuration", () => {
  const valid = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`;

  it("refuses a document past the size limit, naming both numbers", () => {
    const padded = `${valid}\n# ${"x".repeat(1_000_001)}\n`;

    expect(() => parseRunConfig(padded)).toThrow(ConfigTooLargeError);
    // Both numbers, so the operator knows by how much rather than only that.
    expect(() => parseRunConfig(padded)).toThrow(/bytes, the limit is 1000000/);
  });

  it("refuses a document nested past the depth limit", () => {
    let nested = "x";
    for (let i = 0; i < 40; i += 1) {
      nested = `{ a: ${nested} }`;
    }

    expect(() => parseRunConfig(`${valid}\nextra: ${nested}\n`)).toThrow(ConfigTooDeepError);
  });

  it("accepts what a human actually writes", () => {
    expect(() => parseRunConfig(valid)).not.toThrow();
  });
});

describe("parsing a valid configuration", () => {
  it("reads the target, the accounts and the policy", () => {
    const config = parseRunConfig(VALID);

    expect(config.target.baseUrl).toBe("https://staging.example.test/api");
    expect(config.target.allowedHosts).toEqual(["staging.example.test"]);
    expect(config.accounts).toHaveLength(2);
    expect(config.policy.fallback).toBe("denied");
    expect(config.policy.rules).toHaveLength(2);
  });

  it("accepts JSON on par with YAML", () => {
    const json = JSON.stringify({
      target: { baseUrl: "http://localhost:3000", allowedHosts: ["localhost"] },
      accounts: [{ id: "a", role: "player", tenant: "t", tokenEnv: "T" }],
      policy: { fallback: "denied", rules: [] },
    });

    expect(parseRunConfig(json).accounts).toHaveLength(1);
  });

  it("converts accounts to the core's domain type", () => {
    expect(toAccounts(parseRunConfig(VALID)).accounts).toEqual([
      { id: "player-a", roleId: "player", tenantId: "tenant-a" },
      { id: "admin-a", roleId: "admin", tenantId: "tenant-a" },
    ]);
  });
});

describe("the scope of the check", () => {
  it("rejects a baseUrl whose host is not declared", () => {
    const config = VALID.replace("staging.example.test/api", "other.example.test/api");

    expect(() => parseRunConfig(config)).toThrow(HostOutsideScopeError);
  });

  it("does not let a typo in the address widen the scope silently", () => {
    const config = `
target:
  baseUrl: https://stagng.example.test
  allowedHosts: [staging.example.test]
accounts: [{ id: a, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`;

    expect(() => parseRunConfig(config)).toThrow(HostOutsideScopeError);
  });

  it("requires a non-empty allowedHosts", () => {
    const config = VALID.replace("allowedHosts: [staging.example.test]", "allowedHosts: []");

    expect(() => parseRunConfig(config)).toThrow(ConfigValidationError);
  });

  it("rejects protocols other than http and https", () => {
    const config = VALID.replace("https://staging.example.test/api", "ftp://staging.example.test");

    expect(() => parseRunConfig(config)).toThrow(ConfigValidationError);
  });
});

describe("schema validation", () => {
  it("reports the path to the missing field", () => {
    const config = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: a, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`;

    expect(() => parseRunConfig(config)).toThrow(/accounts/);
  });

  it("requires at least one account: there is nobody to build the matrix from", () => {
    const config = VALID.replace(/accounts:[\s\S]*?policy:/, "accounts: []\npolicy:");

    expect(() => parseRunConfig(config)).toThrow(ConfigValidationError);
  });

  it("rejects an unknown outcome in the policy", () => {
    const config = VALID.replace("outcome: allowed", "outcome: maybe");

    expect(() => parseRunConfig(config)).toThrow(ConfigValidationError);
  });

  it("rejects a duplicate account id", () => {
    const config = VALID.replace("id: admin-a", "id: player-a");

    expect(() => parseRunConfig(config)).toThrow(DuplicateAccountIdError);
  });

  it("reports an unparseable document", () => {
    expect(() => parseRunConfig("target: [unclosed")).toThrow(ConfigParseError);
  });
});

describe("credentials", () => {
  it("takes tokens from the environment, not from the file", () => {
    const config = parseRunConfig(VALID);

    const tokens = resolveTokens(config, {
      TOKEN_PLAYER_A: "player-secret-token",
      TOKEN_ADMIN_A: "admin-secret-token",
    });

    expect(tokens.get("player-a")).toBe("player-secret-token");
    expect(tokens.get("admin-a")).toBe("admin-secret-token");
  });

  it("leaves no token in the configuration itself", () => {
    const config = parseRunConfig(VALID);
    resolveTokens(config, {
      TOKEN_PLAYER_A: "player-secret-token",
      TOKEN_ADMIN_A: "admin-secret-token",
    });

    // The configuration is serialized into the report: no token may be in it.
    expect(JSON.stringify(config)).not.toContain("player-secret-token");
    expect(JSON.stringify(config)).toContain("TOKEN_PLAYER_A");
  });

  it("fails at startup when the variable is not set", () => {
    const config = parseRunConfig(VALID);

    expect(() => resolveTokens(config, { TOKEN_PLAYER_A: "present" })).toThrow(
      MissingCredentialError,
    );
  });

  it("rejects a token unusable as an HTTP header value", () => {
    const config = parseRunConfig(VALID);

    // A value outside printable ASCII, and a line break, both break the header.
    // It has to fail at startup, not as dozens of identical failures in the
    // middle of the run. The fixture stays non-ASCII deliberately: replace it
    // with a Latin string and the check proves nothing.
    expect(() => resolveTokens(config, { TOKEN_PLAYER_A: "日本語", TOKEN_ADMIN_A: "ok" })).toThrow(
      InvalidCredentialError,
    );
    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "with\nnewline", TOKEN_ADMIN_A: "ok" }),
    ).toThrow(InvalidCredentialError);
  });

  it("treats an empty variable as absent", () => {
    const config = parseRunConfig(VALID);

    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "present", TOKEN_ADMIN_A: "   " }),
    ).toThrow(MissingCredentialError);
  });

  /**
   * Two accounts with one token.
   *
   * The one failure this tool cannot survive and could not see. Every claim it
   * makes is of the form "carol, from another tenant, cannot read this" — and if
   * carol's requests arrive as alice, the platform answers alice's own data with
   * alice's own rights. The canaries pass, every status is what the policy
   * expects, the report is clean, and the clean report is the tool comparing an
   * account with itself and calling the result isolation.
   *
   * The reference platform has refused it since it was written; the tool did not.
   * Found by the audit of 14 August 2026 (K-8).
   */
  it("refuses two accounts that present the same token", () => {
    const config = parseRunConfig(VALID);

    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "one-token", TOKEN_ADMIN_A: "one-token" }),
    ).toThrow(SharedCredentialError);
    // Both accounts and both variables are named: "somewhere two of your eight
    // accounts collide" is not something an operator can act on.
    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "one-token", TOKEN_ADMIN_A: "one-token" }),
    ).toThrow(/player-a[\s\S]*admin-a/);
    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "one-token", TOKEN_ADMIN_A: "one-token" }),
    ).toThrow(/TOKEN_PLAYER_A[\s\S]*TOKEN_ADMIN_A/);
  });

  /**
   * The same variable on two accounts is the same defect, reached by a typo
   * rather than by two copies of a value, and it deserves the fix in the message.
   */
  it("names the one variable when both accounts read from it", () => {
    const config = parseRunConfig(VALID.replace("TOKEN_ADMIN_A", "TOKEN_PLAYER_A"));

    expect(() => resolveTokens(config, { TOKEN_PLAYER_A: "one-token" })).toThrow(
      /Both read it from TOKEN_PLAYER_A/,
    );
  });

  /**
   * A trailing space is not a second credential.
   *
   * Raw values were compared until 17 August 2026, so `tok-alice` and
   * `"tok-alice "` looked like two tokens and were one: a header value may carry
   * surrounding whitespace and every parser drops it — the reference platform in
   * this repository does it in the regular expression that reads `Authorization`.
   * Both accounts authenticated as alice, both canaries passed, and the run
   * reported isolation proved by comparing an account with itself. Found by
   * adversarial review.
   */
  it("is not removed by whitespace around the token", () => {
    const config = parseRunConfig(VALID);

    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "one-token", TOKEN_ADMIN_A: "one-token " }),
    ).toThrow(SharedCredentialError);
    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: " one-token", TOKEN_ADMIN_A: "one-token\t" }),
    ).toThrow(SharedCredentialError);
  });

  /** And two genuinely different tokens still pass, whitespace or not. */
  it("lets two different tokens through", () => {
    const config = parseRunConfig(VALID);

    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "one-token ", TOKEN_ADMIN_A: " another-token" }),
    ).not.toThrow();
  });

  /**
   * The refusal must not become the leak it prevents.
   *
   * An error message is the one thing here that reaches a terminal, a CI log and
   * a pasted bug report, and the token is the single value in this project that
   * may reach none of them.
   */
  it("says none of the token in the refusal", () => {
    const config = parseRunConfig(VALID);
    const token = "s3cret-shared-token";

    try {
      resolveTokens(config, { TOKEN_PLAYER_A: token, TOKEN_ADMIN_A: token });
      expect.unreachable("the duplicate token was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(SharedCredentialError);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(token);
    }
  });

  /**
   * Anonymous accounts are not a collision.
   *
   * They name no variable and present nothing, so any number of them is
   * legitimate — that is how one asks whether an endpoint is open to everyone.
   * A guard keyed on "no token" would refuse the second one.
   */
  it("allows any number of accounts with no token at all", () => {
    const config = parseRunConfig(
      VALID.replace(", tokenEnv: TOKEN_PLAYER_A", "").replace(", tokenEnv: TOKEN_ADMIN_A", ""),
    );

    expect(resolveTokens(config, {}).size).toBe(0);
  });
});

describe("scope accepts every relation", () => {
  /**
   * Direct protection against the schema drifting from the type. That has
   * already happened: when the hierarchy came in, `ResourceRelation` grew to
   * five values while the hand-written zod enum stayed at three — and the
   * whole feature became unreachable through the CLI, though the core
   * understood it.
   *
   * The core unit tests did not catch this: they build the policy as a
   * TypeScript object, bypassing zod. Nothing checked the path
   * "YAML -> policy".
   */
  it.each(RESOURCE_RELATIONS)("accepts scope: %s", (relation) => {
    const config = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy:
  fallback: denied
  rules:
    - { roles: [r], endpoints: [e], scope: ${relation}, outcome: allowed }
`;

    expect(parseRunConfig(config).policy.rules[0]?.scope).toBe(relation);
  });
});

describe("the tenant tree", () => {
  const HOLDINGS = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: h1, role: holding, tenant: holding-1, tokenEnv: T1 }
tenants:
  - { id: holding-1 }
  - { id: brand-a, parent: holding-1 }
  - { id: holding-2 }
  - { id: brand-c, parent: holding-2 }
policy: { fallback: denied, rules: [] }
`;

  it("reads kinship from the expanded form", () => {
    expect(parseRunConfig(HOLDINGS).tenants).toEqual([
      { id: "holding-1" },
      { id: "brand-a", parentId: "holding-1" },
      { id: "holding-2" },
      { id: "brand-c", parentId: "holding-2" },
    ]);
  });

  /** The short form means a forest of roots — the behaviour before ADR-0013. */
  it("accepts the former short form", () => {
    const config = parseRunConfig(
      HOLDINGS.replace(/tenants:[\s\S]*?policy:/, "tenants: [holding-1]\npolicy:"),
    );

    expect(config.tenants).toEqual([{ id: "holding-1" }]);
  });

  /**
   * A typo in the parent makes the tenant a root of its own: "our own brand"
   * turns into "a foreign one", the rule stops applying, the finding vanishes.
   * It must fail at startup instead of silently changing the meaning.
   */
  it("rejects a typo in the parent before going to the network", () => {
    expect(() =>
      parseRunConfig(HOLDINGS.replace("parent: holding-1", "parent: holding-l")),
    ).toThrow(UnknownParentTenantError);
  });

  describe("a tenant with an address of its own", () => {
    const WITH_URLS = `
target: { baseUrl: "https://api.example.test", allowedHosts: [api.example.test, a.example.test] }
accounts:
  - { id: op, role: operator, tenant: brand-a, tokenEnv: T }
tenants:
  - { id: brand-a, baseUrl: "https://a.example.test" }
policy: { fallback: denied, rules: [] }
`;

    it("reads the brand's address", () => {
      expect(parseRunConfig(WITH_URLS).tenants).toEqual([
        { id: "brand-a", baseUrl: "https://a.example.test" },
      ]);
    });

    /** The scope is one per run: declaring a tenant does not widen it. */
    it("rejects a tenant address outside allowedHosts", () => {
      expect(() =>
        parseRunConfig(WITH_URLS.replace('https://a.example.test"', 'https://c.example.test"')),
      ).toThrow(HostOutsideScopeError);
    });

    it("rejects credentials in a tenant address", () => {
      expect(() =>
        parseRunConfig(WITH_URLS.replace('https://a.example.test"', 'https://u:p@a.example.test"')),
      ).toThrow(CredentialsInUrlError);
    });
  });

  it("rejects a cycle in the tree", () => {
    const cyclic = HOLDINGS.replace(
      "  - { id: holding-1 }",
      "  - { id: holding-1, parent: brand-a }",
    );

    expect(() => parseRunConfig(cyclic)).toThrow(TenantCycleError);
  });
});

describe("resources", () => {
  const WITH_RESOURCES = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: TOK_A }
resources:
  - { id: mine,    tenant: tenant-a, owner: player-a, params: { playerId: "1001" } }
  - { id: foreign, tenant: tenant-b, params: { playerId: "2002" } }
  - { id: byquery, tenant: tenant-a, query: { report_id: "1" } }
policy:
  fallback: denied
  rules:
    - { roles: [player], endpoints: [profile], scope: own, outcome: allowed }
`;

  it("reads resources with an owner, parameters and a query", () => {
    const config = parseRunConfig(WITH_RESOURCES);

    expect(config.resources).toEqual([
      {
        id: "mine",
        tenantId: "tenant-a",
        ownerAccountId: "player-a",
        params: { playerId: "1001" },
      },
      { id: "foreign", tenantId: "tenant-b", params: { playerId: "2002" } },
      { id: "byquery", tenantId: "tenant-a", params: {}, query: { report_id: "1" } },
    ]);
  });

  it("reads the scope of a rule", () => {
    expect(parseRunConfig(WITH_RESOURCES).policy.rules[0]?.scope).toBe("own");
  });

  it("rejects an unknown relation", () => {
    expect(() =>
      parseRunConfig(WITH_RESOURCES.replace("scope: own", "scope: not-a-relation")),
    ).toThrow(ConfigValidationError);
  });

  // Otherwise the relation "own or foreign" would become undefined silently.
  it("rejects a resource declared to belong to a non-existent account", () => {
    expect(() =>
      parseRunConfig(WITH_RESOURCES.replace("owner: player-a", "owner: no-such-account")),
    ).toThrow(UnknownResourceOwnerError);
  });

  // Found while building the reference platform: a duplicate resource reported
  // an account and sent the reader to the wrong section of the configuration.
  it("rejects a duplicate resource id and says it is about a resource", () => {
    const broken = () => parseRunConfig(WITH_RESOURCES.replace("id: foreign", "id: mine"));

    expect(broken).toThrow(DuplicateResourceIdError);
    expect(broken).toThrow(/A resource with id/);
  });

  /**
   * Found by the audit of 14 August. `params: { playerId: "." }` on the template
   * `/v1/players/{playerId}` produced a request to `/v1/players/` — the
   * collection endpoint next door, which that configuration had put in
   * `exclude`. Two guarantees fell together: the exclusion list, which is the
   * only defence against a GET that must not be issued, and the verdict, which
   * was computed for the parameterised endpoint out of the collection's answer.
   *
   * `encodeURIComponent` does not help — a dot is unreserved. Nor does the scope
   * guard, and it never could: nothing left the target, the request simply went
   * somewhere else inside it.
   */
  it.each([".", "..", ""])("rejects a path parameter value of %o", (value) => {
    const broken = () =>
      parseRunConfig(WITH_RESOURCES.replace('playerId: "1001"', `playerId: "${value}"`));

    expect(broken).toThrow(UnusablePathParameterError);
    expect(broken).toThrow(/which endpoint is addressed/);
  });

  // A value that merely contains dots is an identifier like any other: the slash
  // is encoded, and nothing navigates.
  it("refuses a value carrying a separator, whatever it looks like", () => {
    expect(() =>
      parseRunConfig(WITH_RESOURCES.replace('playerId: "1001"', 'playerId: "../.."')),
    ).toThrow();
  });

  it("with no resources the list is empty, not absent", () => {
    expect(parseRunConfig(VALID).resources).toEqual([]);
  });
});

describe("the anonymous account", () => {
  const ANON = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: anon,     role: guest }
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: TOK_A }
policy: { fallback: denied, rules: [] }
`;

  it("allows an account without a token variable", () => {
    const config = parseRunConfig(ANON);

    expect(config.accounts[0]?.tokenEnv).toBeUndefined();
  });

  // Without it the claim "this address must not be public" cannot be checked.
  it("requires no credentials for an anonymous account", () => {
    const tokens = resolveTokens(parseRunConfig(ANON), { TOK_A: "value" });

    expect(tokens.has("anon")).toBe(false);
    expect(tokens.get("player-a")).toBe("value");
  });

  /**
   * An anonymous account has no tenant, and the field is not filled with a
   * placeholder: a reserved name like `none` would sit in the same value space
   * as real names, and on a platform with a tenant called `none` the anonymous
   * account would become a neighbor inside it — silently.
   */
  it("leaves an account without a tenant with no tenantId field", () => {
    expect(toAccounts(parseRunConfig(ANON)).accounts).toEqual([
      { id: "anon", roleId: "guest" },
      { id: "player-a", roleId: "player", tenantId: "tenant-a" },
    ]);
    expect(toAccounts(parseRunConfig(ANON)).accounts[0]).not.toHaveProperty("tenantId");
  });

  // It is declared outside of tenants, not assigned to one of them: requiring
  // a line for it in the list would bring the sentinel back through a back door.
  it("needs no entry in tenants while keeping the check strict for the rest", () => {
    const strict = `${ANON}tenants: [tenant-a]\n`;

    expect(() => parseRunConfig(strict)).not.toThrow();
    expect(() => parseRunConfig(strict.replace("tenant: tenant-a", "tenant: tenant-b"))).toThrow(
      UnknownTenantError,
    );
  });
});

describe("checking endpoint references", () => {
  const endpoints = [
    { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
    { id: "me", method: "GET", path: "/v1/me" },
  ] as const;

  const base = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: u, role: player, tenant: t, tokenEnv: TOK, canary: me }
resources:
  - { id: mine, tenant: t, owner: u, params: { orderId: "1" }, endpoints: [orders.read] }
policy:
  fallback: denied
  rules:
    - { roles: [player], endpoints: [orders.read], scope: own, outcome: allowed }
`;

  it("lets valid references through", () => {
    expect(() => assertReferencesResolve(parseRunConfig(base), endpoints)).not.toThrow();
  });

  // Found by a run against crAPI: a typo in a resource silently lost four BOLA
  // findings, while the resource stayed in the report as declared.
  it("rejects a typo in a resource's reference", () => {
    const config = parseRunConfig(
      base.replace("endpoints: [orders.read]", "endpoints: [orders.raed]"),
    );

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownEndpointReferenceError);
  });

  // The same run, the opposite outcome: a typo in a rule FABRICATED findings —
  // a user reading their own order was declared a privilege escalation.
  it("rejects a typo in a policy rule", () => {
    const config = parseRunConfig(
      base.replace("endpoints: [orders.read], scope", "endpoints: [orders_read], scope"),
    );

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownEndpointReferenceError);
  });

  /**
   * The same class one field over, and the one that stayed open.
   *
   * A typo in a resource's **endpoint list** was already refused; a typo in a
   * **parameter name** was not. `resourceApplies` asks that every parameter in an
   * endpoint's path be an own property of `params`, so one wrong letter makes the
   * resource fit nothing and every cell declared for it is quietly not walked.
   * Measured on the reference platform: `orderId` → `orderid` takes a run from
   * 144 cells to 126 and privilege escalations from 10 to 7, with `warnings: []`,
   * `resourcesNotFound: []` and the resource still listed among the inputs.
   *
   * Refused at startup like every other declaration that matches nothing — a
   * policy pattern that fits no endpoint, an empty rule selector — because
   * staying silent about those is not allowed either. Found by adversarial review
   * on 18 August 2026.
   */
  it("rejects a misspelled parameter name, which fits no endpoint at all", () => {
    const config = parseRunConfig(base.replace("orderId:", "orderid:"));

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnusedResourceError);
    // The message names the parameters it has, since that is where the typo is.
    expect(() => assertReferencesResolve(config, endpoints)).toThrow(/"orderid"/);
  });

  /**
   * A resource carrying only a query is legitimate and must name its endpoints —
   * `resourceApplies` attaches a resource without path parameters to nothing
   * unless it does, which is deliberate: otherwise it would attach to every
   * endpoint in a row.
   */
  it("accepts a query-only resource that names an endpoint taking no parameter", () => {
    const config = parseRunConfig(
      base.replace(
        'params: { orderId: "1" }, endpoints: [orders.read]',
        "params: {}, endpoints: [me], query: { include: totals }",
      ),
    );

    expect(() => assertReferencesResolve(config, endpoints)).not.toThrow();
  });

  /**
   * And naming an endpoint whose path **does** take a parameter, without
   * supplying it, is the same hole in a different spelling: the resource fits
   * nothing, the cells are not walked, and the list of endpoints looks deliberate
   * enough to read as intent.
   */
  it("rejects a resource that names an endpoint whose parameter it does not carry", () => {
    const config = parseRunConfig(base.replace('params: { orderId: "1" },', "params: {},"));

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnusedResourceError);
  });

  /**
   * A role a rule names and no account carries.
   *
   * The last reference in a configuration that failed in silence, and the guide
   * said so out loud — "read a role selector twice; nothing else will". Measured
   * on the reference platform: `roles: [admin]` misspelled `admni` takes a clean
   * run from exit 0 with no findings to exit 1 with a privilege escalation
   * against `admin-a × admin.accounts` that is not there, `warnings: []`, and no
   * line saying a rule never applied. The `basis` of that finding is `fallback`
   * where a rule was meant to decide, so the report holds the evidence and
   * surfaces none of it.
   *
   * That direction fabricates a finding, which somebody eventually chases down.
   * The quieter one is a misspelled role on a rule with `outcome: denied`: the
   * expectation disappears and the cell agrees with the fallback instead.
   */
  it("rejects a rule written for a role no account declares", () => {
    const config = parseRunConfig(base.replace("roles: [player]", "roles: [palyer]"));

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownRoleReferenceError);
    // The message names what the accounts actually declare, since the set is
    // exactly that and nothing else defines it.
    expect(() => assertReferencesResolve(config, endpoints)).toThrow(/"player"/);
  });

  it("accepts the wildcard, which names no role and matches every one", () => {
    const config = parseRunConfig(base.replace("roles: [player]", 'roles: "*"'));

    expect(() => assertReferencesResolve(config, endpoints)).not.toThrow();
  });

  /**
   * And the reverse direction stays legitimate: an account whose role no rule
   * mentions is a declaration, not an oversight. Every cell of it falls through
   * to `fallback`, and with `fallback: denied` that is the statement "this role
   * may do nothing" — which is one of the more useful things to assert.
   */
  it("accepts an account whose role no rule mentions", () => {
    const config = parseRunConfig(
      base.replace(
        "  - { id: u, role: player, tenant: t, tokenEnv: TOK, canary: me }",
        "  - { id: u, role: player, tenant: t, tokenEnv: TOK, canary: me }\n" +
          "  - { id: g, role: guest, tenant: t, tokenEnv: TOK_G, canary: me }",
      ),
    );

    expect(() => assertReferencesResolve(config, endpoints)).not.toThrow();
  });

  it("rejects a query-only resource that names none", () => {
    const config = parseRunConfig(
      base.replace(
        'params: { orderId: "1" }, endpoints: [orders.read]',
        "params: {}, query: { include: totals }",
      ),
    );

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnusedResourceError);
  });

  it("rejects a typo in a canary", () => {
    const config = parseRunConfig(base.replace("canary: me", "canary: mee"));

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownEndpointReferenceError);
  });

  /**
   * G-9 of the audit of 14 August 2026. The rule index is zero-based — it is the
   * position in `policy.rules` and the same number the report carries as
   * `ruleIndex` — and it used to be printed as `Policy rule #1` for the second
   * rule. A reader counting rules in their own YAML lands on the wrong one.
   */
  it("names the offending rule by a position a reader can count to", () => {
    const twoRules = base.replace(
      "    - { roles: [player], endpoints: [orders.read], scope: own, outcome: allowed }",
      "    - { roles: [player], endpoints: [orders.read], scope: own, outcome: allowed }\n" +
        "    - { roles: [player], endpoints: [orders.raed], outcome: denied }",
    );

    expect(() => assertReferencesResolve(parseRunConfig(twoRules), endpoints)).toThrow(
      /policy\.rules\[1\] \(2nd from the top\)/,
    );
  });

  /**
   * A cold read of 14 August: the error explained why the mismatch mattered and
   * left the reader to guess what the right name was. With `--spec` the answer is
   * not guessable at all — the identifier is the `operationId`, and an operation
   * without one becomes `"GET /v1/admin/users"`. The reader reverse-engineered it
   * out of `endpoints[]` in the report.
   */
  it("lists the parsed identifiers, nearest first", () => {
    const many = [
      ...endpoints,
      { id: "orders.list", method: "GET", path: "/v1/orders" },
      { id: "admin.users", method: "GET", path: "/v1/admin/users" },
    ] as const;
    const config = parseRunConfig(
      base.replace("endpoints: [orders.read]", "endpoints: [orders.raed]"),
    );

    let message = "";
    try {
      assertReferencesResolve(config, many);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Parsed (4):");
    // A typo keeps the prefix, so the two `orders.*` come before the rest — on a
    // truncated list that is the difference between an answer and a hint.
    expect(message).toMatch(/Parsed \(4\): orders\.(read|list), orders\.(read|list), /);
    expect(message).toContain("admin.users");
  });

  // An empty list is a different fact and a worse one: the source yielded no
  // endpoints, and every reference is about to fail for an unrelated reason.
  it("says so when nothing was parsed at all", () => {
    let message = "";
    try {
      assertReferencesResolve(parseRunConfig(base), []);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Nothing was parsed from the endpoint source");
  });

  /**
   * A typo here fails silently and closed: the body is not read, the check
   * does not fire, the report looks clean. The same class as a typo in a
   * tenant name.
   */
  it("rejects a typo in a responseMustDifferByTenant declaration", () => {
    const config = parseRunConfig(
      `${base}bodySignals: { responseMustDifferByTenant: [orders.raed] }\n`,
    );

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownEndpointReferenceError);
  });

  it("lets a valid responseMustDifferByTenant declaration through", () => {
    const config = parseRunConfig(
      `${base}bodySignals: { responseMustDifferByTenant: [orders.read] }\n`,
    );

    expect(config.bodySignals?.responseMustDifferByTenant).toEqual(["orders.read"]);
    expect(() => assertReferencesResolve(config, endpoints)).not.toThrow();
  });

  describe("declared scalars", () => {
    const withSignals = `${base}bodySignals:
  responseMustDifferByTenant: [orders.read]
  signals:
    - { name: orderCount, kind: count, path: orders, endpoints: [orders.read] }
`;

    it("reads the declared signals", () => {
      const config = parseRunConfig(withSignals);

      expect(config.bodySignals?.signals).toEqual([
        { name: "orderCount", kind: "count", path: "orders", endpoints: ["orders.read"] },
      ]);
    });

    it("attaches them to the endpoint along with the declaration", () => {
      const config = parseRunConfig(withSignals);

      const marked = applyBodySignals(endpoints, config);
      const target = marked.find((endpoint) => endpoint.id === "orders.read");

      expect(target?.responseMustDifferByTenant).toBe(true);
      expect(target?.signals).toEqual([{ name: "orderCount", kind: "count", path: "orders" }]);
    });

    it("rejects a typo in a signal's endpoint", () => {
      const config = parseRunConfig(
        withSignals.replace("endpoints: [orders.read] }", "endpoints: [orders.raed] }"),
      );

      expect(() => assertReferencesResolve(config, endpoints)).toThrow(
        UnknownEndpointReferenceError,
      );
    });

    /** Names are keys in an observation: a repeat would silently overwrite the previous scalar. */
    it("rejects a duplicate signal name", () => {
      const config = parseRunConfig(
        `${withSignals}    - { name: orderCount, kind: present, path: next, endpoints: [orders.read] }\n`,
      );

      expect(() => assertReferencesResolve(config, endpoints)).toThrow(DuplicateSignalNameError);
    });

    /**
     * Found by the audit of 14 August, and the worst configuration-reachable
     * defect it found. A signal named `digest` took the place of the one the
     * tool computes itself: with `kind: present` eighteen cross-tenant findings
     * became zero and `coverage.checksRun` still named the check; with
     * `kind: count` sixteen findings appeared on a healthy platform.
     *
     * Refused at parsing rather than resolved somehow — an operator who wanted a
     * scalar of their own renames it, and nobody gets a report that lies without
     * saying so.
     */
    it("rejects the reserved name the tool computes for itself", () => {
      const declaration = `${base}bodySignals:
  responseMustDifferByTenant: [orders.read]
  signals:
    - { name: digest, kind: present, path: orders, endpoints: [orders.read] }
`;

      expect(() => parseRunConfig(declaration)).toThrow(ReservedSignalNameError);
    });

    /**
     * The second reserved name, for the same reason as the first. The extractor
     * sets this flag when a body was too large to read, and the check reads it
     * to tell "no comparison was made" from "the bodies differed"; a declared
     * scalar of this name would take its place. See D-5.
     */
    it("rejects the reserved name for the over-limit flag", () => {
      const declaration = `${base}bodySignals:
  responseMustDifferByTenant: [orders.read]
  signals:
    - { name: bodyOverLimit, kind: present, path: orders, endpoints: [orders.read] }
`;

      expect(() => parseRunConfig(declaration)).toThrow(ReservedSignalNameError);
    });

    /**
     * The third reserved name. The extractor sets it when a declared subtree
     * could not be reached, and the digest is withheld rather than falling back
     * to the whole body; a declared scalar of this name would take the flag's
     * place and the report would stop saying which silence it is. See ADR-0044.
     */
    it("rejects the reserved name for the missing-scope flag", () => {
      const declaration = `${base}bodySignals:
  responseMustDifferByTenant: [orders.read]
  signals:
    - { name: digestScopeMissing, kind: present, path: orders, endpoints: [orders.read] }
`;

      expect(() => parseRunConfig(declaration)).toThrow(ReservedSignalNameError);
    });

    // The refusal does not depend on the digest being computed on that same
    // endpoint: the name is reserved outright, not "reserved where the collision
    // would happen to occur today".
    it("rejects it on an endpoint the digest is not computed for", () => {
      const declaration = `${base}bodySignals:
  responseMustDifferByTenant: [me]
  signals:
    - { name: digest, kind: count, path: orders, endpoints: [orders.read] }
`;

      expect(() => parseRunConfig(declaration)).toThrow(ReservedSignalNameError);
    });
  });

  describe("applyBodySignals", () => {
    it("attaches the declaration only to the listed endpoints", () => {
      const config = parseRunConfig(
        `${base}bodySignals: { responseMustDifferByTenant: [orders.read] }\n`,
      );

      const marked = applyBodySignals(endpoints, config);

      expect(
        marked.find((endpoint) => endpoint.id === "orders.read")?.responseMustDifferByTenant,
      ).toBe(true);
      expect(
        marked.filter((endpoint) => endpoint.responseMustDifferByTenant === true),
      ).toHaveLength(1);
    });

    /** Without the section bodies are read nowhere — that is what "off by default" means. */
    it("touches nothing without a bodySignals section", () => {
      const marked = applyBodySignals(endpoints, parseRunConfig(base));

      expect(marked).toBe(endpoints);
      expect(marked.some((endpoint) => endpoint.responseMustDifferByTenant === true)).toBe(false);
    });
  });

  /**
   * The part of the body to compare, declared by a human.
   *
   * A digest over raw bytes is switched off by the envelope a real list endpoint
   * comes wrapped in: two responses carrying both tenants' records differ by one
   * `requestId`, so the digests differ and the leak is invisible. The path is
   * declared and never derived, like everything else in this model. See
   * ADR-0044.
   */
  describe("compareSubtree", () => {
    const declared = `${base}bodySignals:
  responseMustDifferByTenant: [orders.read]
  compareSubtree:
    - { endpoints: [orders.read], path: data.orders }
`;

    it("reaches the endpoint as a digest spec carrying the path", () => {
      const marked = applyBodySignals(endpoints, parseRunConfig(declared));
      const endpoint = marked.find((one) => one.id === "orders.read");

      expect(endpoint?.signals).toContainEqual({
        name: "digest",
        kind: "digest",
        path: "data.orders",
      });
    });

    it("touches an endpoint it does not name", () => {
      const marked = applyBodySignals(endpoints, parseRunConfig(declared));

      expect(marked.find((one) => one.id === "me")?.signals).toBeUndefined();
    });

    /**
     * A declaration that does nothing is worse than none: the operator believes
     * the envelope is being skipped, and the whole-body digest goes on being
     * compared. No digest is computed at all where the endpoint is not under
     * `responseMustDifferByTenant`, so the scope would have nothing to scope.
     */
    it("refuses a scope on an endpoint whose bodies are never compared", () => {
      const orphaned = `${base}bodySignals:
  responseMustDifferByTenant: [me]
  compareSubtree:
    - { endpoints: [orders.read], path: data.orders }
`;

      expect(() => parseRunConfig(orphaned)).toThrow(CompareSubtreeWithoutComparisonError);
    });

    /** Two scopes for one endpoint is two answers to one question. */
    it("refuses two scopes for the same endpoint", () => {
      const twice = `${base}bodySignals:
  responseMustDifferByTenant: [orders.read]
  compareSubtree:
    - { endpoints: [orders.read], path: data.orders }
    - { endpoints: [orders.read], path: data.items }
`;

      expect(() => parseRunConfig(twice)).toThrow(DuplicateCompareSubtreeError);
    });

    /** The grammar is the one `parseSignalPath` already states, called and not copied. */
    it("refuses a path with an empty segment", () => {
      const broken = declared.replace("path: data.orders", 'path: "data..orders"');

      expect(() => parseRunConfig(broken)).toThrow(ConfigValidationError);
    });

    /** The root is what the default already is; declaring it says nothing. */
    it("refuses an empty path", () => {
      const empty = declared.replace("path: data.orders", 'path: ""');

      expect(() => parseRunConfig(empty)).toThrow(ConfigValidationError);
    });

    /**
     * The typo, which fails the way the dangerous ones do: the scope lands on
     * nothing, whole bodies go on being compared, and nothing says so. Checked
     * against the endpoint list, so it is `assertReferencesResolve` and not the
     * parse gate — as with every other reference in the file.
     */
    it("refuses an endpoint nothing declares", () => {
      const typo = `${base}bodySignals:
  responseMustDifferByTenant: [orders.read, orders.raed]
  compareSubtree:
    - { endpoints: [orders.raed], path: data.orders }
`;

      expect(() => assertReferencesResolve(parseRunConfig(typo), endpoints)).toThrow(
        UnknownEndpointReferenceError,
      );
    });
  });

  it('does not nitpick a rule with "*"', () => {
    const config = parseRunConfig(
      base.replace("endpoints: [orders.read], scope: own", 'endpoints: "*"'),
    );

    expect(() => assertReferencesResolve(config, endpoints)).not.toThrow();
  });
});

describe("tenants", () => {
  const WITH_TENANTS = `
tenants: [tenant-a, tenant-b]
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: u, role: player, tenant: tenant-a, tokenEnv: TOK }
resources:
  - { id: mine, tenant: tenant-a, owner: u, params: { id: "1" } }
policy: { fallback: denied, rules: [] }
`;

  it("accepts declared tenants", () => {
    expect(() => parseRunConfig(WITH_TENANTS)).not.toThrow();
  });

  // The most dangerous case: a typo does not break the run, it HIDES a finding —
  // the resource moves into a foreign tenant, the rule with a scope stops
  // applying, the leak falls through to fallback and never reaches the report.
  it("rejects a typo in a resource's tenant", () => {
    expect(() =>
      parseRunConfig(WITH_TENANTS.replace("mine, tenant: tenant-a", "mine, tenant: tenant-c")),
    ).toThrow(UnknownTenantError);
  });

  it("rejects a typo in an account's tenant", () => {
    expect(() =>
      parseRunConfig(
        WITH_TENANTS.replace("tenant: tenant-a, tokenEnv", "tenant: tenant-x, tokenEnv"),
      ),
    ).toThrow(UnknownTenantError);
  });

  it('trims spaces: "tenant-a " and "tenant-a" are one tenant', () => {
    const config = parseRunConfig(
      WITH_TENANTS.replace("tenant: tenant-a, owner", 'tenant: "tenant-a ", owner'),
    );

    expect(config.resources[0]?.tenantId).toBe("tenant-a");
    expect(toAccounts(config).accounts[0]?.tenantId).toBe("tenant-a");
  });

  it("does not nitpick without a declared list: a foreign tenant's resource is lawful", () => {
    const withoutList = WITH_TENANTS.replace("tenants: [tenant-a, tenant-b]\n", "");

    expect(() =>
      parseRunConfig(withoutList.replace("mine, tenant: tenant-a", "mine, tenant: tenant-z")),
    ).not.toThrow();
  });
});

describe("per-account authentication schemes", () => {
  const MULTI = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }

auth: { kind: bearer }

authSchemes:
  operator-console: { kind: cookie, name: opsid }
  affiliate-cabinet: { kind: header, header: X-Affiliate-Key }

accounts:
  - { id: player-a, role: player, tenant: t, tokenEnv: TOK_PLAYER }
  - { id: operator-a, role: operator, tenant: t, tokenEnv: TOK_OPERATOR, authScheme: operator-console }
  - { id: affiliate-a, role: affiliate, tenant: t, tokenEnv: TOK_AFFILIATE, authScheme: affiliate-cabinet }

policy: { fallback: denied, rules: [] }
`;

  it("resolves scheme references and leaves other accounts on the default scheme", () => {
    const config = parseRunConfig(MULTI);

    expect(config.auth).toEqual({ kind: "bearer" });
    expect([...config.accountAuth]).toEqual([
      ["operator-a", { kind: "cookie", name: "opsid" }],
      ["affiliate-a", { kind: "header", header: "X-Affiliate-Key" }],
    ]);
  });

  it("with no overrides the map is empty, not absent", () => {
    // The CLI always passes it; an absent map would need a branch at the call.
    expect(parseRunConfig(VALID).accountAuth.size).toBe(0);
  });

  // The main claim: a typo in a reference must stop the run. Otherwise the
  // account would go out with the default scheme, get a solid wall of 401, and
  // a solid denial matches the policy everywhere access is not meant to be
  // granted — so the report would come out clean having checked nothing.
  it("fails on a typo in a scheme name", () => {
    expect(() =>
      parseRunConfig(MULTI.replace("authScheme: operator-console", "authScheme: operator-consol")),
    ).toThrow(UnknownAuthSchemeError);
  });

  it("fails on a reference when no schemes are declared at all", () => {
    const noSchemes = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: TOK, authScheme: operator-console }]
policy: { fallback: denied, rules: [] }
`;

    expect(() => parseRunConfig(noSchemes)).toThrow(UnknownAuthSchemeError);
  });

  it("does not resolve a reference through an inherited object property", () => {
    // `authSchemes` comes from an untrusted file: indexing a plain object would
    // return `constructor` instead of `undefined`, and the reference would
    // "resolve".
    const inherited = MULTI.replace("authScheme: operator-console", "authScheme: constructor");

    expect(() => parseRunConfig(inherited)).toThrow(UnknownAuthSchemeError);
  });

  it("fails on a scheme nobody uses", () => {
    // In practice this is a forgotten authScheme on an account: it goes out
    // with the default and says nothing. A dead declaration looks like a
    // checked claim.
    const forgotten = MULTI.replace(
      ", tokenEnv: TOK_AFFILIATE, authScheme: affiliate-cabinet",
      ", tokenEnv: TOK_AFFILIATE",
    );

    expect(() => parseRunConfig(forgotten)).toThrow(UnusedAuthSchemeError);
  });

  it("fails on a scheme for an account without a token", () => {
    // There is nothing to present with it, yet the reference "uses" the scheme —
    // and a genuinely forgotten authScheme would stop being visible.
    const anonymous = MULTI.replace("tokenEnv: TOK_OPERATOR, ", "");

    expect(() => parseRunConfig(anonymous)).toThrow(AuthSchemeWithoutTokenError);
  });

  it("rejects an invalid header name and names the scheme", () => {
    const broken = MULTI.replace("header: X-Affiliate-Key", 'header: "X Affiliate Key"');

    expect(() => parseRunConfig(broken)).toThrow(/affiliate-cabinet/);
  });

  it("rejects a secret value inside a scheme", () => {
    // The only source of a token is an environment variable (ADR-0008).
    // A silently dropped field would leave a secret in a file that gets
    // committed.
    const withSecret = MULTI.replace(
      "{ kind: cookie, name: opsid }",
      '{ kind: cookie, name: opsid, value: "s3cret" }',
    );

    expect(() => parseRunConfig(withSecret)).toThrow(ConfigValidationError);
  });
});

describe("an account with a set of tenants", () => {
  /** Support staff over brands of two different holdings — the case from ADR-0017. */
  const WITH_SET = `
tenants:
  - { id: holding-1 }
  - { id: holding-2 }
  - { id: brand-a, parent: holding-1 }
  - { id: brand-c, parent: holding-2 }
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: sam, role: support, tenants: [brand-a, brand-c], tokenEnv: TOK }
resources:
  - { id: r-a, tenant: brand-a, params: { id: "1" } }
policy: { fallback: denied, rules: [] }
`;

  it("carries the set through to the core's domain type as a set", () => {
    expect(toAccounts(parseRunConfig(WITH_SET)).accounts).toEqual([
      { id: "sam", roleId: "support", tenantIds: ["brand-a", "brand-c"] },
    ]);
  });

  it("trims spaces in the names of the set", () => {
    const config = parseRunConfig(WITH_SET.replace("[brand-a, brand-c]", '["brand-a ", brand-c]'));

    expect(toAccounts(config).accounts[0]?.tenantIds).toEqual(["brand-a", "brand-c"]);
  });

  // The same class as a typo in a single tenant: it does not break the run, it
  // hides a finding — the membership goes nowhere, the resource turns foreign.
  it("rejects a typo inside the set", () => {
    expect(() => parseRunConfig(WITH_SET.replace("brand-c]", "brand-x]"))).toThrow(
      UnknownTenantError,
    );
  });

  // A nested membership moves the brand's resources from descendant-tenant to
  // same-tenant, and the rule written for the top-down view silently stops
  // applying. The meaning changed, the report looks the same.
  it("rejects a set where one membership sits in the subtree of another", () => {
    expect(() =>
      parseRunConfig(WITH_SET.replace("[brand-a, brand-c]", "[holding-1, brand-a]")),
    ).toThrow(SubsumedMembershipError);
  });

  it("rejects a repeat inside the set", () => {
    expect(() =>
      parseRunConfig(WITH_SET.replace("[brand-a, brand-c]", "[brand-a, brand-a]")),
    ).toThrow(DuplicateMembershipError);
  });

  // Both fields at once is a contradiction: it is unclear what counts as the
  // membership.
  it("rejects tenant and tenants at the same time", () => {
    expect(() =>
      parseRunConfig(
        WITH_SET.replace(
          "tenants: [brand-a, brand-c]",
          "tenant: brand-a, tenants: [brand-a, brand-c]",
        ),
      ),
    ).toThrow(ConfigValidationError);
  });

  // A set of one is `tenant`. Two forms of the same meaning would drift apart
  // between reading the configuration and the report.
  it("rejects a set of a single tenant", () => {
    expect(() => parseRunConfig(WITH_SET.replace("[brand-a, brand-c]", "[brand-a]"))).toThrow(
      ConfigValidationError,
    );
  });
});

describe("credentials in the address", () => {
  it("rejects a login and a password in baseUrl", () => {
    const config = `
target: { baseUrl: "https://svc:S3cret@a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: TOK }]
policy: { fallback: denied, rules: [] }
`;

    // baseUrl is copied into the report verbatim, and the report goes to stdout.
    expect(() => parseRunConfig(config)).toThrow(CredentialsInUrlError);
  });

  it("understands an allowedHosts entry with a port", () => {
    const config = `
target: { baseUrl: "https://a.test:8443/v1", allowedHosts: ["a.test:8443"] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: TOK }]
policy: { fallback: denied, rules: [] }
`;

    expect(() => parseRunConfig(config)).not.toThrow();
  });
});

/**
 * Found by a cold read: the two loudest invariants of the project answered the
 * reader with raw zod. "The allowlist is mandatory" and "`fallback` has no
 * default on purpose" get whole paragraphs in the guide, while
 * `Invalid input: expected array, received undefined` reads as a bug in the
 * config rather than "you are about to scan someone else's system with no
 * scope drawn".
 */
describe("messages on mandatory fields", () => {
  it("explains why the allowlist is needed instead of reporting a type", () => {
    expect(() =>
      parseRunConfig(`
target: { baseUrl: "https://a.test" }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`),
    ).toThrow(/scanning someone else's system/);
  });

  it("explains why fallback has no default", () => {
    expect(() =>
      parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy: { rules: [] }
`),
    ).toThrow(/`fallback` has no default on purpose/);
  });
});

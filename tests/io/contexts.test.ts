/**
 * Tests for parsing request conditions.
 *
 * Every check here is about a silent substitution: conditions that rewrote a
 * credential header give a run made as a different account; conditions with no
 * rule give a heap of discrepancies nobody claimed; a typo in a name gives a
 * rule that applies to nothing. None of this looks like a failure.
 */

import { describe, expect, it } from "vitest";
import {
  assertContextsCannotWrite,
  ForbiddenContextHeaderError,
  ForbiddenContextQueryError,
  InvalidContextValueError,
  MethodOverrideInContextError,
  MissingContextValueError,
  parseRunConfig,
  resolveContextValues,
  toAccounts,
  UncarriableKeyError,
  UnknownContextReferenceError,
  UnusedContextError,
} from "../../src/io/config.js";

function config(body: string): string {
  return `
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE }
  - { id: bob, role: user, tenant: tenant-b, tokenEnv: T_BOB }
${body}`;
}

const GEO_RULE = `
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: geo-blocked, outcome: denied }
`;

describe("an account under conditions", () => {
  it("gives a matrix row of its own with the same tenant and role", () => {
    const parsed = parseRunConfig(
      config(`${GEO_RULE}
contexts:
  - { id: geo-blocked, headers: { cf-ipcountry: AQ }, endpoints: [orders.list] }
`),
    );

    const { accounts, attributes } = toAccounts(parsed);

    expect(accounts.map((account) => account.id)).toEqual([
      "alice",
      "bob",
      "alice@geo-blocked",
      "bob@geo-blocked",
    ]);
    expect(accounts[2]).toMatchObject({
      roleId: "user",
      tenantId: "tenant-a",
      contextId: "geo-blocked",
      endpointIds: ["orders.list"],
    });
    // Conditions do not change the account: it is the one presented, and
    // ownership of a resource is checked against it. Without the reference an
    // account's own resource stopped being its own.
    expect(accounts[2]?.baseAccountId).toBe("alice");
    expect(attributes.get("alice@geo-blocked")?.headers).toEqual({ "cf-ipcountry": "AQ" });
  });

  it("applies the conditions only to the named accounts", () => {
    const parsed = parseRunConfig(
      config(`${GEO_RULE}
contexts:
  - { id: geo-blocked, headers: { cf-ipcountry: AQ }, endpoints: [orders.list], accounts: [alice] }
`),
    );

    expect(toAccounts(parsed).accounts.map((account) => account.id)).toEqual([
      "alice",
      "bob",
      "alice@geo-blocked",
    ]);
  });
});

describe("conditions do not replace the basis of the request", () => {
  /**
   * Conditions that quietly rewrote `Authorization` would give a run where
   * some cells go out as a different account — and it would look like findings
   * about the platform.
   */
  it.each([
    ["authorization", "Bearer someone-elses"],
    ["Cookie", "session=someone-elses"],
    ["host", "evil.test"],
    ["content-length", "0"],
  ])("rejects the header %s", (header, value) => {
    expect(() =>
      parseRunConfig(
        config(`${GEO_RULE}
contexts:
  - id: geo-blocked
    headers: { "${header}": "${value}" }
    endpoints: [orders.list]
`),
      ),
    ).toThrow(ForbiddenContextHeaderError);
  });

  /**
   * The header name of an authentication scheme is declared by a human, so the
   * ban is computed from the parsed schemes, not from a line in the file.
   */
  it("rejects the header that presents credentials", () => {
    expect(() =>
      parseRunConfig(
        config(`
auth: { kind: header, header: X-API-Key }
${GEO_RULE}
contexts:
  - { id: geo-blocked, headers: { x-api-key: someone-elses }, endpoints: [orders.list] }
`),
      ),
    ).toThrow(ForbiddenContextHeaderError);
  });
});

describe("conditions with no expectations", () => {
  /**
   * An expectation under conditions is declared explicitly. With no rule, all
   * of their cells fall through to fallback, and the report fills up with
   * discrepancies nobody claimed.
   */
  it("rejects conditions no rule refers to", () => {
    expect(() =>
      parseRunConfig(
        config(`
policy: { fallback: denied, rules: [] }
contexts:
  - { id: geo-blocked, headers: { cf-ipcountry: AQ }, endpoints: [orders.list] }
`),
      ),
    ).toThrow(UnusedContextError);
  });

  /** A typo in a reference gives a rule that applies to no cell at all. */
  it("rejects a rule that refers to undeclared conditions", () => {
    expect(() =>
      parseRunConfig(
        config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: geo-blockd, outcome: denied }
contexts:
  - { id: geo-blocked, headers: { cf-ipcountry: AQ }, endpoints: [orders.list] }
`),
      ),
    ).toThrow(UnknownContextReferenceError);
  });
});

describe("the strict rule schema", () => {
  /**
   * Found by running the polygon against an old build: an unrecognized key was
   * silently dropped, and the rule "deny under these conditions" turned into
   * "deny always" — 19 findings on a healthy platform. The same typo in `scope`
   * widens the rule to every relation and, the other way round, hides a finding.
   */
  it("rejects an extra key in a rule instead of dropping it", () => {
    expect(() =>
      parseRunConfig(
        config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], scop: own, outcome: allowed }
`),
      ),
    ).toThrow();
  });
});

/**
 * Found by adversarial review, and it was the worst finding of the day: the
 * conditions made the platform **delete a resource** with unsafe methods
 * switched off. The `SAFE_METHODS` gate looks at the request method and does
 * not see the override, while the report wrote `writeMethodsProbed: false` —
 * that is, it claimed the opposite of what happened.
 */
describe("conditions cannot replace the meaning of a request", () => {
  /** The policy must name the conditions, otherwise the run fails before the check. */
  function withContext(id: string, attributes: string): string {
    return config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: ${id}, outcome: denied }
contexts:
  - id: ${id}
    ${attributes}
    endpoints: [orders.list]
`);
  }

  it.each([
    ["x-http-method-override", "method override header"],
    ["X-HTTP-Method", "the same one spelled differently"],
    ["x-method-override", "and a third spelling"],
    ["x-original-url", "address override: the request would miss the declared path"],
    ["x-rewrite-url", "the same one"],
    ["x-forwarded-host", "routing: changes the addressee, not the conditions"],
    ["x-forwarded-proto", "the same one"],
    ["proxy-authorization", "credentials"],
    ["upgrade", "a transport header"],
  ])("rejects the header %s (%s)", (header) => {
    expect(() => parseRunConfig(withContext("bad", `headers: { "${header}": something }`))).toThrow(
      ForbiddenContextHeaderError,
    );
  });

  /**
   * `__proto__` never becomes a key in a plain object literal: the header would
   * vanish silently, and a declaration that does nothing and does not complain
   * is exactly what this whole tool is written against.
   */
  it("rejects the key __proto__ instead of losing it silently", () => {
    expect(() => parseRunConfig(withContext("weird", 'headers: { __proto__: "value" }'))).toThrow(
      UncarriableKeyError,
    );
  });

  /** The geo attribute stays allowed: conditions were introduced for its sake. */
  it("leaves x-forwarded-for alone — it is the typical condition attribute", () => {
    expect(() =>
      parseRunConfig(withContext("geo", 'headers: { x-forwarded-for: "203.0.113.10" }')),
    ).not.toThrow();
  });

  it.each(["access_token", "api_key", "token", "jwt", "session"])(
    "rejects the query parameter %s: credentials are presented with it",
    (key) => {
      expect(() =>
        parseRunConfig(withContext("bad", `query: { "${key}": "looks like a token" }`)),
      ).toThrow(ForbiddenContextQueryError);
    },
  );

  it("rejects a header name that will not go out on the wire", () => {
    expect(() => parseRunConfig(withContext("bad", 'headers: { "x-bad name": ok }'))).toThrow(
      ForbiddenContextHeaderError,
    );
  });

  it("rejects a value that will not go out on the wire", () => {
    // A value outside printable ASCII: stays non-ASCII deliberately, a Latin
    // replacement would make the check prove nothing.
    expect(() => parseRunConfig(withContext("bad", 'headers: { x-note: "日本語" }'))).toThrow(
      ForbiddenContextHeaderError,
    );
  });

  /**
   * The quietest of the substitutions: the verdict is computed from the
   * declared resource while a different one is asked for — and a cross-tenant
   * leak lands in the report as "own resource, tested and agreed".
   */
  it("rejects a parameter by which resources identify themselves", () => {
    expect(() =>
      parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts: [{ id: alice, role: user, tenant: tenant-a, tokenEnv: T }]
resources:
  - { id: own, tenant: tenant-a, owner: alice, query: { id: "1001" }, endpoints: [orders.list] }
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: mobile, outcome: allowed }
contexts:
  - { id: mobile, query: { id: "2001" }, endpoints: [orders.list] }
`),
    ).toThrow(ForbiddenContextQueryError);
  });

  /**
   * The rule works on the **value**, not the name: method override has a dozen
   * names and will have more, while its value is always the same — the name of
   * a method. That catches a vendor header nobody has heard of too.
   */
  describe("method override is caught by the attribute's value", () => {
    const parsed = (attributes: string) =>
      resolveContextValues(parseRunConfig(withContext("proxy", attributes)), {});

    it("rejects a header whose value is the name of a method", () => {
      expect(() =>
        assertContextsCannotWrite(parsed("headers: { x-vendor-verb: DELETE }"), {
          allowUnsafeMethods: false,
        }),
      ).toThrow(MethodOverrideInContextError);
    });

    it("rejects a query parameter with the same value too", () => {
      expect(() =>
        assertContextsCannotWrite(parsed('query: { _method: "delete" }'), {
          allowUnsafeMethods: false,
        }),
      ).toThrow(MethodOverrideInContextError);
    });

    /** With explicit consent to write there is nothing to forbid: the human decided already. */
    it("stays silent when unsafe methods are allowed explicitly", () => {
      expect(() =>
        assertContextsCannotWrite(parsed("headers: { x-vendor-verb: DELETE }"), {
          allowUnsafeMethods: true,
        }),
      ).not.toThrow();
    });

    it("does not get in the way of an ordinary attribute value", () => {
      expect(() =>
        assertContextsCannotWrite(parsed("headers: { cf-ipcountry: AQ }"), {
          allowUnsafeMethods: false,
        }),
      ).not.toThrow();
    });
  });
});

/**
 * An attribute's value is printed in the report verbatim, and anyone who needs
 * a device signature or a partner key in the conditions had nowhere to go but
 * plain text in the configuration. The form `{ env: NAME }` repeats `tokenEnv`
 * on an account: the name goes into the report, the value lives in the
 * environment.
 */
describe("an attribute value from the environment", () => {
  const CONFIG = `
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts: [{ id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE }]
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: partner, outcome: allowed }
contexts:
  - id: partner
    headers: { x-partner-key: { env: PARTNER_KEY } }
    endpoints: [orders.list]
`;

  it("substitutes the value from the environment variable", () => {
    const values = resolveContextValues(parseRunConfig(CONFIG), { PARTNER_KEY: "s3cret" });

    expect(values.get("partner")?.headers["x-partner-key"]).toBe("s3cret");
  });

  it("the configuration keeps the variable name, not the value", () => {
    const config = parseRunConfig(CONFIG);

    expect(config.contexts[0]?.headers["x-partner-key"]).toEqual({ env: "PARTNER_KEY" });
  });

  it("rejects an unset variable instead of going out with an empty header", () => {
    expect(() => resolveContextValues(parseRunConfig(CONFIG), {})).toThrow(
      MissingContextValueError,
    );
  });

  it("rejects a value that cannot be sent", () => {
    expect(() =>
      resolveContextValues(parseRunConfig(CONFIG), { PARTNER_KEY: "a line\nbreak" }),
    ).toThrow(InvalidContextValueError);
  });

  /**
   * The method-override check runs over the resolved values: a declaration of
   * `{ env: VERB }` with `VERB=DELETE` would slip past it otherwise.
   */
  it("catches a method override that came from the environment", () => {
    const config = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts: [{ id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE }]
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: sneaky, outcome: allowed }
contexts:
  - id: sneaky
    headers: { x-vendor-verb: { env: VERB } }
    endpoints: [orders.list]
`);

    expect(() =>
      assertContextsCannotWrite(resolveContextValues(config, { VERB: "DELETE" }), {
        allowUnsafeMethods: false,
      }),
    ).toThrow(MethodOverrideInContextError);
  });

  /** A skipped resolution step must be audible, not travel on as an object. */
  it("refuses to build accounts when the values are not resolved", () => {
    expect(() => toAccounts(parseRunConfig(CONFIG))).toThrow(MissingContextValueError);
  });
});

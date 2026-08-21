/**
 * Every section of a run configuration refuses a key it does not know.
 *
 * The schemas are `z.strictObject` for a reason that is written out beside each
 * of them, and the reason is always the same shape: a dropped key does not break
 * a run, it changes what the run means. The declaration still reads as the
 * operator wrote it, the report still says `match: true`, and the difference
 * lives only in the parser.
 *
 * Until this file the strictness was held by one test — `schema/barbican.run.schema.json`
 * carries `additionalProperties: false` on every section, and
 * `tests/io/schema.test.ts` compares the checked-in copy against the generated
 * one. That comparison goes red on any of these schemas losing `strict`, which
 * is why the hole did not look like one. It is the wrong guard for the job: it
 * asserts nothing about what the parser does with a file, and the documented way
 * to make it green again is `pnpm run schema`. Whoever loosens a section while
 * chasing an unrelated failure regenerates the snapshot and moves on.
 *
 * So each test here spells out a typo somebody actually makes and asserts the
 * parser refuses it. Mutating a section back to `z.object` turns exactly the
 * test for that section red, and nothing else.
 */

import { describe, expect, it } from "vitest";
import { ConfigValidationError, parseRunConfig } from "../../src/io/config.js";

/** One account, one tenant, enough to be a valid document. */
function config(body: string): string {
  return `
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts:
  - { id: alice, role: player, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }
${body}`;
}

const POLICY = `
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [me], outcome: allowed }
`;

describe("the endpoint selector written as an object", () => {
  const rule = (selector: string): string =>
    config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [${selector}], outcome: denied }
`);

  it("accepts the form it documents", () => {
    expect(() => parseRunConfig(rule("{ method: GET, path: /v1/admin }"))).not.toThrow();
  });

  /**
   * `method` is optional, so a typo in it does not fail on a missing field — it
   * widens the selector from "GET under /v1/admin" to "every method under
   * /v1/admin". With `outcome: denied` that is the quiet direction: the
   * expectation spreads over endpoints nobody wrote it for, and a real
   * escalation on one of them agrees with it.
   */
  it("rejects a typo in the method instead of matching every method", () => {
    expect(() => parseRunConfig(rule("{ methods: GET, path: /v1/admin }"))).toThrow(
      ConfigValidationError,
    );
  });
});

/**
 * The authentication schemes, where a dropped key leaves a **secret in a file
 * that is meant to be committed**.
 *
 * There are no values in a scheme in any form: the only source is the
 * environment variable the account names (ADR-0008). A scheme that swallowed
 * `token` would pretend to work — the run authenticates by the environment as
 * before — while the literal sits in the repository, and nothing in the output
 * mentions it.
 *
 * The cookie branch has had this test since it was written; the other three
 * shared the comment and not the coverage.
 */
describe("a secret written into an authentication scheme", () => {
  it("rejects a token beside kind: bearer", () => {
    expect(() =>
      parseRunConfig(config(`auth: { kind: bearer, token: "s3cret" }${POLICY}`)),
    ).toThrow(ConfigValidationError);
  });

  it("rejects a password beside kind: basic", () => {
    expect(() =>
      parseRunConfig(config(`auth: { kind: basic, password: "s3cret" }${POLICY}`)),
    ).toThrow(ConfigValidationError);
  });

  it("rejects a value beside kind: header", () => {
    const withScheme = `
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts:
  - { id: alice, role: player, tenant: tenant-a, tokenEnv: T_ALICE, authScheme: affiliate }
authSchemes:
  affiliate: { kind: header, header: X-Affiliate-Key, value: "s3cret" }
${POLICY}`;

    expect(() => parseRunConfig(withScheme)).toThrow(ConfigValidationError);
  });
});

/**
 * The `{ env: NAME }` form of a context attribute.
 *
 * It exists so that a device signature or a partner key travels as a **name**
 * into the report and as a value only through the environment. An operator who
 * hedges by writing both forms at once has said two different things about one
 * attribute; the strict object makes him pick one. Dropped, the literal is the
 * half that disappears — silently, and while the report shows the attribute as
 * declared.
 */
describe("the environment-variable form of a context attribute", () => {
  const withAttribute = (value: string): string =>
    config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [me], context: partner, outcome: allowed }
contexts:
  - { id: partner, headers: { x-partner-key: ${value} }, endpoints: [me] }
`);

  it("accepts the name of a variable on its own", () => {
    expect(() => parseRunConfig(withAttribute("{ env: PARTNER_KEY }"))).not.toThrow();
  });

  it("rejects a literal smuggled in beside the variable name", () => {
    expect(() =>
      parseRunConfig(withAttribute('{ env: PARTNER_KEY, value: "fallback-literal" }')),
    ).toThrow(ConfigValidationError);
  });
});

/**
 * The top level of the file, where a misspelled section name silently deletes
 * the whole section.
 *
 * `exclude` is the dangerous one. It is the list of endpoints not to touch even
 * with a safe method — the answer to a GET that is not safe in practice, like an
 * address that resets the database. An operator writes it precisely because he
 * knows what is behind those addresses; dropped, the tool goes and asks for them.
 */
describe("the top level of a run configuration", () => {
  it("rejects a misspelled section instead of running without it", () => {
    expect(() => parseRunConfig(config(`excludes: [danger.reset]${POLICY}`))).toThrow(
      ConfigValidationError,
    );
  });

  it("accepts the section spelled as it is documented", () => {
    expect(() => parseRunConfig(config(`exclude: [danger.reset]${POLICY}`))).not.toThrow();
  });
});

/**
 * `target`, whose only optional field is `label`.
 *
 * `name` is the word that comes to mind for it, and it is the wrong one. What
 * the label carries is the identification of the system under test: a `baseUrl`
 * of `http://127.0.0.1:8787` does not tell a production-like deployment from a
 * demo polygon, so without the label the reader of the report has no right to
 * file a ticket against the platform — the artefact does not name the platform.
 * Dropped, the report loses that line and looks complete without it.
 */
describe("the target section", () => {
  const target = (extra: string): string =>
    `
target: { baseUrl: "https://api.test", allowedHosts: [api.test], ${extra} }
accounts:
  - { id: alice, role: player, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }
${POLICY}`;

  it("accepts the label", () => {
    expect(() => parseRunConfig(target('label: "staging-eu"'))).not.toThrow();
  });

  it("rejects another word for the label instead of losing it", () => {
    expect(() => parseRunConfig(target('name: "staging-eu"'))).toThrow(ConfigValidationError);
  });
});

/**
 * `accounts[]` — the section where the cost of a dropped key is a secret in the
 * repository.
 *
 * The account names an environment variable and never a token. `token` is a
 * shorter word than `tokenEnv` and the first one a hand reaches for, and the
 * account it produces still parses: it simply has no credentials. The run then
 * goes anonymous, every cell answers 401, and — with the policy declaring this
 * account denied — the report agrees with itself and exits 0. The value stays in
 * the file, which is a file written to be committed.
 *
 * Note what is **not** an unknown key here: `tenants` is a field of its own on an
 * account (ADR-0017), so the plural is legitimate in this section. That is
 * exactly what makes it a plausible slip one level down, in `resources[]`, where
 * it is not.
 */
describe("an account", () => {
  const account = (fields: string): string =>
    `
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts:
  - { id: alice, role: player, tenant: tenant-a, ${fields} }
${POLICY}`;

  it("rejects a token written where the variable name belongs", () => {
    expect(() => parseRunConfig(account('token: "s3cret"'))).toThrow(ConfigValidationError);
  });

  /**
   * The canary is what proves the account authenticated at all, and since
   * ADR-0033 every account with a `tokenEnv` needs one that passed or the run
   * exits 2. A dropped `canaries` turns a configuration that declares the check
   * into one that lacks it — and the exit-2 message then names an account whose
   * file plainly shows a canary written on it. The unknown key is the fact worth
   * printing, and only the strict object prints it.
   */
  it("rejects a canary written in the plural instead of losing the canary", () => {
    expect(() => parseRunConfig(account("tokenEnv: T_ALICE, canaries: [me]"))).toThrow(
      ConfigValidationError,
    );
  });

  it("keeps accepting the fields it does know", () => {
    expect(() => parseRunConfig(account("tokenEnv: T_ALICE, canary: me"))).not.toThrow();
    expect(() =>
      parseRunConfig(account("tokenEnv: T_ALICE, canary: me").replace("tenant: tenant-a, ", "")),
    ).not.toThrow();
  });
});

/**
 * `policy`, where the mistake is not a typo but a section put one level too deep.
 *
 * `exclude` is a real key of this format — at the top level. Written inside
 * `policy`, beside the rules it feels related to, it is an unknown key; dropped,
 * the exclusion list is empty and the tool issues requests to the addresses the
 * operator declared off-limits. The file says they are excluded and the run says
 * nothing at all.
 */
describe("the policy section", () => {
  it("rejects a top-level key nested inside it", () => {
    const misplaced = config(`
policy:
  fallback: denied
  rules: []
  exclude: [danger.reset]
`);

    expect(() => parseRunConfig(misplaced)).toThrow(ConfigValidationError);
  });
});

/**
 * `resources[]`, where a dropped key hides a finding rather than causing one.
 */
describe("a resource", () => {
  const resource = (fields: string): string =>
    config(`
resources:
  - { id: mine, ${fields} }
${POLICY}`);

  it("accepts the fields it documents", () => {
    expect(() =>
      parseRunConfig(resource('tenant: tenant-a, owner: alice, params: { id: "1" }')),
    ).not.toThrow();
  });

  /**
   * `owner` is what makes "this resource belongs to alice" true, and the whole
   * BOLA question is asked against it. Dropped, the resource belongs to nobody:
   * the relation of every account to it stops being `own`, a rule written with
   * `scope: own` no longer applies, and the cells fall through to the fallback.
   * A leak the run was built to find is compared against the wrong expectation.
   */
  it("rejects an owner written in the plural instead of losing the owner", () => {
    expect(() =>
      parseRunConfig(resource('tenant: tenant-a, owners: alice, params: { id: "1" }')),
    ).toThrow(ConfigValidationError);
  });

  /**
   * A resource belongs to exactly one tenant, and there is no plural form of the
   * field. An account has one (ADR-0017), which is where the slip comes from —
   * the idiom is copied down the file. Written beside a valid `tenant` it is
   * dropped in silence, and the operator reads a declaration the parser never
   * saw.
   */
  it("rejects a set of tenants on a resource, which has no such field", () => {
    expect(() =>
      parseRunConfig(
        resource('tenant: tenant-a, tenants: [tenant-a, tenant-b], params: { id: "1" }'),
      ),
    ).toThrow(ConfigValidationError);
  });
});

/**
 * `tenants[]` in its object form, where the dropped key is the kinship.
 *
 * A tenant whose `parent` went missing becomes a root of its own, and the
 * hierarchy flattens without saying so. Every relation computed against it
 * changes: what was a descendant of the holding turns foreign, a rule written
 * for the top-down view stops applying, and a cross-tenant leak lands in the
 * report as agreement with the fallback. The value of `parent` is already
 * checked against the declared names — this is about the key, which no check
 * downstream can miss the absence of.
 */
describe("a tenant in the object form", () => {
  const hierarchy = (child: string): string =>
    `
tenants:
  - { id: holding }
  - { id: tenant-a, ${child} }
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts:
  - { id: alice, role: player, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }
${POLICY}`;

  it("accepts a declared parent", () => {
    expect(() => parseRunConfig(hierarchy("parent: holding"))).not.toThrow();
  });

  it("rejects a typo in the parent key instead of flattening the tree", () => {
    expect(() => parseRunConfig(hierarchy("parents: holding"))).toThrow(ConfigValidationError);
  });

  /** The same for the tenant's own base address: dropped, requests go to the default one. */
  it("rejects a typo in the tenant's base address", () => {
    expect(() => parseRunConfig(hierarchy('baseUrls: "https://api.test/brand"'))).toThrow(
      ConfigValidationError,
    );
  });
});

/**
 * `contexts[]`, where a dropped key makes the comparison compare a thing with
 * itself.
 *
 * Request conditions are the minimal piece of ABAC the tool has: the same
 * account, the same role, the request tagged with attributes, and the outcomes
 * of the two declared sets compared (ADR-0019). A context whose `headers` went
 * missing carries no attributes at all — so the "under these conditions" cell is
 * the baseline cell, byte for byte. The two agree, always, and the report says
 * the platform behaves as declared under conditions that were never sent.
 */
describe("a request context", () => {
  const context = (fields: string): string =>
    config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [me], context: geo-blocked, outcome: denied }
contexts:
  - { id: geo-blocked, ${fields}, endpoints: [me] }
`);

  it("accepts the attributes it documents", () => {
    expect(() => parseRunConfig(context("headers: { cf-ipcountry: AQ }"))).not.toThrow();
  });

  it("rejects a typo in headers instead of sending no attributes", () => {
    expect(() => parseRunConfig(context("header: { cf-ipcountry: AQ }"))).toThrow(
      ConfigValidationError,
    );
  });

  /**
   * `accounts` bounds the conditions to the accounts named. Dropped, the bound
   * disappears and the conditions apply to every account — which multiplies the
   * matrix and puts requests on someone else's deployment that nobody asked for.
   */
  it("rejects a typo in the account bound instead of widening it to all", () => {
    expect(() =>
      parseRunConfig(context("headers: { cf-ipcountry: AQ }, account: [alice]")),
    ).toThrow(ConfigValidationError);
  });
});

/**
 * `bodySignals` — the one section that switches on reading response bodies, and
 * the one where a dropped key fails **closed and silent**.
 *
 * The body is not stored anywhere and by default is not read at all; this
 * section is the declared exception, narrowed to the endpoints where a match
 * between tenants is itself the finding (ADR-0011). It is the only check the
 * "bodies are not read" invariant was ever relaxed for, so a typo that turns it
 * off costs the whole channel — and costs it in the direction where the report
 * looks clean.
 */
describe("the bodySignals section", () => {
  const signals = (body: string): string =>
    config(`
bodySignals:
${body}${POLICY}`);

  it("accepts the section as it is documented", () => {
    expect(() =>
      parseRunConfig(signals("  responseMustDifferByTenant: [me]\n  maxBodyBytes: 4096\n")),
    ).not.toThrow();
  });

  /**
   * The plural does not fail on its own — the singular is required, so a file
   * carrying only the plural is refused either way. The reachable state is both
   * at once: the operator who hit that refusal added the singular and left the
   * misspelled line behind, or reached for it later to add endpoints to a
   * declaration that was already working. Those endpoints are then not covered,
   * and no line of the report says which ones were.
   */
  it("rejects the plural left beside the singular", () => {
    expect(() =>
      parseRunConfig(
        signals(
          "  responseMustDifferByTenant: [me]\n  responseMustDifferByTenants: [orders.read]\n",
        ),
      ),
    ).toThrow(ConfigValidationError);
  });

  /**
   * `maxBodyBytes` is the operator's cap on how much of someone else's response
   * is read in transit. Dropped, the cap silently reverts to the default, and a
   * run reads more than the file says it may.
   */
  it("rejects a typo in the byte cap instead of falling back to the default", () => {
    expect(() =>
      parseRunConfig(signals("  responseMustDifferByTenant: [me]\n  maxBodyBtyes: 4096\n")),
    ).toThrow(ConfigValidationError);
  });

  /** The declared scalars, in the singular: the whole list vanishes with the key. */
  it("rejects a typo in the scalar list instead of declaring nothing", () => {
    expect(() =>
      parseRunConfig(
        signals(
          "  responseMustDifferByTenant: [me]\n" +
            "  signal:\n" +
            "    - { name: orderCount, kind: count, path: orders, endpoints: [me] }\n",
        ),
      ),
    ).toThrow(ConfigValidationError);
  });
});

/**
 * `bodySignals.signals[]`, a scalar declaration.
 *
 * All four of its fields are required, so a typo in any of them fails on the
 * missing field whether the object is strict or not. What strictness holds is
 * the other direction: a field transplanted from a section that does have it.
 * `accounts` is one — it bounds a context, and reads as though it would bound a
 * scalar. Dropped, the scalar is computed for every account while the file says
 * it was scoped to one, and triage starts from a number that answers a different
 * question than the one asked.
 */
describe("a declared scalar", () => {
  const signal = (fields: string): string =>
    config(`
bodySignals:
  responseMustDifferByTenant: [me]
  signals:
    - { name: orderCount, kind: count, path: orders, ${fields} }
${POLICY}`);

  it("accepts the fields a scalar is made of", () => {
    expect(() => parseRunConfig(signal("endpoints: [me]"))).not.toThrow();
  });

  it("rejects a bound a scalar does not have", () => {
    expect(() => parseRunConfig(signal("endpoints: [me], accounts: [alice]"))).toThrow(
      ConfigValidationError,
    );
  });
});

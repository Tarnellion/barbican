/**
 * Nothing a human declared goes missing between the configuration and the file.
 *
 * The report rebuilds accounts, request conditions and the target by naming
 * their fields one at a time. That is the right shape for a published format —
 * the report must not pass on what it does not mean to publish — and it is also
 * a mechanism with a record: `CheckRun.description` was left out by a mapping
 * that named `id` and `standards`, and `contextId` was left off a check finding
 * the same way. Both times the field existed, no line mentioned it, and nothing
 * anywhere said so. Found by the audit of 14 August 2026 (B-12).
 *
 * Two nets, because the ways to lose a field are two. A field added to
 * `AccountConfig` or `RequestContextConfig` and named by no half of the mapping
 * fails the **typecheck**, through the remainder `nothingLeftUnnamed` refuses;
 * a field the parser fills and the mapping drops fails **these tests**, which
 * compare what the configuration holds against what the file carries rather
 * than against a list written here. A list written here would be the same fact
 * twice, which is the class of defect the whole exercise is about.
 */

import { describe, expect, it } from "vitest";
import type { CellVerdict } from "../../src/core/index.js";
import { parseRunConfig, toAccounts } from "../../src/io/config.js";
import type { BuildReportOptions, ReportFinding, RunReport } from "../../src/report/build.js";
import { buildReport } from "../../src/report/build.js";

/**
 * An account declaring every field the configuration has for one, and a set of
 * conditions declaring every field it has for those.
 *
 * Written out in full on purpose: a fixture that leaves a field out cannot
 * notice the field being dropped.
 */
const CONFIG = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
authSchemes:
  api-key: { kind: header, header: x-api-key }
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: orders.list, authScheme: api-key }
  - { id: bob, role: user, tenant: tenant-b, tokenEnv: T_BOB }
  - { id: dana, role: support, tenants: [tenant-a, tenant-b], tokenEnv: T_DANA }
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], outcome: allowed }
    - { roles: "*", endpoints: [orders.list], context: geo-blocked, outcome: denied }
contexts:
  - id: geo-blocked
    description: the request arrives from Antarctica
    headers: { cf-ipcountry: AQ }
    query: { locale: en }
    endpoints: [orders.list]
    accounts: [alice]
`);

const ENDPOINTS = [
  { id: "orders.list", method: "GET" as const, path: "/v1/orders" },
  // Probed, and no verdict computed for it: the row that shows the grounds are
  // carried rather than invented.
  { id: "cards.list", method: "GET" as const, path: "/v1/cards" },
];

const CELLS: readonly CellVerdict[] = [
  {
    accountId: "alice",
    endpointId: "orders.list",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 0,
    actual: "allowed",
    match: true,
  },
  // The other half of the pair `basis` exists for: no rule matched, and the
  // fallback answered. Told apart from the first only by this field.
  {
    accountId: "bob",
    endpointId: "orders.list",
    expected: "denied",
    basis: "fallback",
    actual: "denied",
    match: true,
  },
];

function build(): RunReport {
  const options: BuildReportOptions = {
    version: "test",
    config: CONFIG,
    accounts: toAccounts(CONFIG).accounts,
    endpoints: ENDPOINTS,
    observations: [
      {
        accountId: "alice",
        endpointId: "orders.list",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
      },
      {
        accountId: "bob",
        endpointId: "orders.list",
        status: 403,
        outcome: "denied",
        headers: {},
        durationMs: 1,
      },
      {
        accountId: "alice",
        endpointId: "cards.list",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
      },
    ],
    cells: CELLS,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 2,
    truncated: false,
    findings: [],
    policy: { fallback: "denied", rules: [] },
    startedAt: new Date(0),
    finishedAt: new Date(1),
  };
  return buildReport(options);
}

/**
 * The keys that reach the file.
 *
 * Through `JSON.stringify`, because that is what the report is: a field set to
 * `undefined` is a key in the object and no key in the artifact, and the claim
 * being tested is about the artifact.
 */
function publishedKeys(value: unknown): readonly string[] {
  return Object.keys(JSON.parse(JSON.stringify(value)) as Record<string, unknown>).sort();
}

describe("what the report publishes about a declared account", () => {
  /**
   * The two withheld fields are named here and nowhere else, so that adding a
   * third means saying so in the mapping and in this line — instead of a field
   * quietly joining the ones nobody publishes.
   */
  const WITHHELD: readonly string[] = ["canary", "authScheme"];
  /**
   * Not in the declaration: the report derives both. Every account in the
   * fixture has credentials, so both are on every row — an anonymous account
   * gets `anonymous: true` and no `auth`, which is its own claim and is tested
   * where anonymity is.
   */
  const DERIVED: readonly string[] = ["anonymous", "auth"];

  /**
   * Every declared account, and one of them declares a **set** of tenants:
   * `tenants` is written unconditionally and would be dropped from the file
   * along with `tenant` on any account that has only one, so an account with a
   * set is the only row that can notice it going missing.
   */
  it("carries every field of every declaration but the two it withholds", () => {
    const published = build().accounts;
    const keysOf = (declared: object): readonly string[] =>
      [...Object.keys(declared).filter((key) => !WITHHELD.includes(key)), ...DERIVED].sort();

    expect(
      CONFIG.accounts.map((declared) => [
        declared.id,
        publishedKeys(published.find((account) => account.id === declared.id)),
      ]),
    ).toEqual(CONFIG.accounts.map((declared) => [declared.id, keysOf(declared)]));
  });

  it("carries the values and not only the keys", () => {
    const published = build().accounts.find((account) => account.id === "alice");

    expect(published).toMatchObject({
      id: "alice",
      role: "user",
      tenant: "tenant-a",
      tokenEnv: "T_ALICE",
      anonymous: false,
      // The scheme the reference resolves to, which is why the reference itself
      // is withheld: two spellings of one fact, free to disagree.
      auth: { kind: "header", header: "x-api-key" },
    });
  });

  /**
   * A row that exists only because conditions were declared says so. Without it
   * the `@` in the name is the only carrier of the structure, and it reads as a
   * user at a domain.
   */
  it("names the conditions a derived row exists under and the account it came from", () => {
    const derived = build().accounts.find((account) => account.id === "alice@geo-blocked");

    expect(derived).toMatchObject({ contextId: "geo-blocked", baseAccountId: "alice" });
    // The scheme comes from the original account rather than from a lookup by
    // this row's own id, which would find nothing and print the default.
    expect(derived?.auth).toEqual({ kind: "header", header: "x-api-key" });
  });
});

describe("what the report publishes about a declared set of conditions", () => {
  /**
   * All of it. 'access under context: geo-blocked' can be neither reproduced nor
   * disputed without the attributes, and there are no secrets among them: a
   * human wrote the values, and `{ env: NAME }` names a variable rather than
   * carrying one.
   */
  it("carries every field of the declaration", () => {
    const declared = CONFIG.contexts[0];
    const published = build().inputs.contexts[0];

    expect(publishedKeys(published)).toEqual(publishedKeys(declared));
    expect(published).toEqual(declared);
  });
});

describe("what the report publishes about the target", () => {
  it("carries every field of the declaration", () => {
    const published = build().target;

    expect(publishedKeys(published)).toEqual(publishedKeys(CONFIG.target));
    expect(published).toEqual(CONFIG.target);
  });
});

describe("the grounds for an expectation", () => {
  /**
   * `basis` was the third field lost the way B-12 describes, and the one that
   * had already been lost when the finding was written. The core computes it on
   * every cell — it exists because the absence of `ruleIndex` was a poor answer,
   * indistinguishable from a field the tool failed to fill in — and the mapping
   * onto an observation named four of the verdict's fields and not this one.
   * Findings carried it all along, which is what kept the gap out of sight.
   */
  it("reaches the observation and not only the finding", () => {
    const rows = build().observations;

    expect(rows.find((row) => row.accountId === "alice")?.basis).toBe("rule");
    expect(rows.find((row) => row.accountId === "bob")?.basis).toBe("fallback");
  });

  /**
   * The pair, on one row: `ruleIndex` alone cannot say whether the fallback
   * answered or the tool failed to write a number.
   */
  it("stands beside the rule it names, and alone where no rule matched", () => {
    const rows = build().observations;
    const byRule = rows.find((row) => row.accountId === "alice");
    const byFallback = rows.find((row) => row.accountId === "bob");

    expect(byRule).toMatchObject({ basis: "rule", ruleIndex: 0, expected: "allowed" });
    expect(byFallback).toMatchObject({ basis: "fallback", expected: "denied" });
    expect(byFallback).not.toHaveProperty("ruleIndex");
  });

  /**
   * A row no verdict was computed for gets no grounds invented for it. `basis`
   * arrives with `expected` or not at all: a row claiming a fallback nobody
   * consulted would be worse than a row that says nothing.
   */
  it("is absent from a row the walk never judged", () => {
    const unjudged = build().observations.find((row) => row.endpointId === "cards.list");

    expect(unjudged).toBeDefined();
    expect(unjudged).not.toHaveProperty("basis");
    expect(unjudged).not.toHaveProperty("expected");
  });
});

/**
 * The two fields a matrix finding has always carried and the type did not name.
 *
 * `docs/report.md` gives them a section — "Which rule gave the verdict" — and a
 * consumer typed against `ReportFinding` could read neither, because they arrive
 * through the spread from `AccessDiff` and the interface declared them nowhere.
 * The same shape as `AccessDiff.basis` one layer down, closed the same day.
 * Found by adversarial review on 17 August 2026.
 */
describe("the grounds on a finding", () => {
  it("are declared, so a consumer can name them", () => {
    const finding: ReportFinding = {
      kind: "privilege-escalation",
      source: "matrix",
      severity: "high",
      basis: "rule",
      ruleIndex: 11,
    };

    // The assertion is the annotation: this does not compile while the
    // declaration is missing, and a value comparison never names a type.
    const basis: "rule" | "fallback" | undefined = finding.basis;
    const ruleIndex: number | undefined = finding.ruleIndex;

    expect(basis).toBe("rule");
    expect(ruleIndex).toBe(11);
  });
});

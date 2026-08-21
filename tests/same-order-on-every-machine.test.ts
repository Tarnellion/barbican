/**
 * The order in the report, and `configDigest`, are the same on every machine.
 *
 * `localeCompare()` called with no argument compares by the locale the process
 * started in — whatever `LC_ALL` or `LANG` said. Ten such calls decided the
 * order of the finding rows, of the defect groups, of the pairs a check compares
 * and of the suggestions a configuration error lists; one more decided the order
 * of the entries `configDigest` is hashed from. The audit of 21 August 2026
 * (L-2) measured it: `LC_ALL=sv_SE` gave a different order and a different
 * digest than `en_US` over the same run.
 *
 * Two of those are not cosmetic. `docs/report.md` offers `configDigest` as the
 * way to tell "the platform changed" from "we changed the declaration", and a
 * digest that moves with the machine answers that question wrong. And
 * `MAX_ROWS_PER_DEFECT` cuts the evidence rows **after** the sort, so two
 * machines walking the same matrix keep different rows of the same defect.
 *
 * Worse than either, `canonical()` compared by two rules at once: its `Map`
 * branch went through `localeCompare`, its `Set` branch and its object-key
 * branch through the default `.sort()`, which is code units. One function, two
 * orders, and the digest built on top of it.
 *
 * ## How two locales are reached from one process
 *
 * The default locale is fixed when the process starts, so no environment
 * variable set inside a test can move it. What is substituted instead is the
 * comparison itself: `String.prototype.localeCompare` is made to delegate to a
 * real `Intl.Collator` for the named locale — which is the collation `LC_ALL`
 * would have selected. A path that consults no locale answers the same under
 * both; a path that consults one does not, and that is the whole finding.
 */

import { describe, expect, it } from "vitest";
import { createIdenticalResponseCheck } from "../src/core/checks/tenant-isolation.js";
import { groupDefects } from "../src/core/defects.js";
import type { AccessDiff, AccessMatrix, AccessObservation, Endpoint } from "../src/core/index.js";
import { buildAccessMatrix, diffAccess, expandPolicy } from "../src/core/index.js";
import { byCodeUnits } from "../src/core/order.js";
import { parseRunConfig, UnknownEndpointReferenceError } from "../src/io/config.js";
import type { RunReport } from "../src/report/build.js";
import { buildReport } from "../src/report/build.js";

/**
 * Two identifiers the collations of Sweden and the United States disagree about.
 *
 * `ö` is a letter of its own in Swedish and sorts after `z`; in `en-US` it is an
 * `o` with a mark on it and sorts before `z`. By code units it is U+00F6, after
 * every ASCII letter — so the three rules give two different answers and the
 * fixture can tell them apart.
 */
const Z_ID = "acct-az";
const O_ID = "acct-aö";

/**
 * Runs `work` with string comparison bound to one locale.
 *
 * The prototype is restored in `finally` rather than after the call: a build
 * that throws would otherwise leave every later test in this process comparing
 * strings in Swedish.
 */
function underCollation<T>(locale: string, work: () => T): T {
  const original = String.prototype.localeCompare;
  const collator = new Intl.Collator(locale);
  const patched = function (this: string, that: string): number {
    return collator.compare(String(this), String(that));
  };
  String.prototype.localeCompare = patched;
  try {
    return work();
  } finally {
    String.prototype.localeCompare = original;
  }
}

/** Both locales, and the machine's own, which is a third answer to compare. */
function acrossLocales<T>(work: () => T): readonly T[] {
  return [underCollation("sv-SE", work), underCollation("en-US", work), work()];
}

/**
 * The first result, with the rest asserted equal to it.
 *
 * `expect(a).toEqual(b)` on a pair would leave the machine's own locale — the
 * third run — unchecked, and that is the one an operator actually gets.
 */
function oneAnswer<T>(work: () => T): T {
  const [first, ...rest] = acrossLocales(work);
  for (const other of rest) {
    expect(other).toEqual(first);
  }
  return first as T;
}

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
authSchemes:
  key-z: { kind: header, header: x-key-z }
  key-o: { kind: header, header: x-key-o }
accounts:
  - { id: "${Z_ID}", role: user, tenant: tenant-a, tokenEnv: T_Z, authScheme: key-z }
  - { id: "${O_ID}", role: user, tenant: tenant-b, tokenEnv: T_O, authScheme: key-o }
policy: { fallback: denied, rules: [] }
`);

const ENDPOINTS: readonly Endpoint[] = [
  { id: "orders-az", method: "GET", path: "/v1/orders-az" },
  { id: "orders-aö", method: "GET", path: "/v1/orders-ao" },
];

const ACCOUNTS = [
  { id: Z_ID, roleId: "user", tenantId: "tenant-a" },
  { id: O_ID, roleId: "user", tenantId: "tenant-b" },
];

/** Everything answered 200 against a policy that declares everything denied. */
const OBSERVATIONS: readonly AccessObservation[] = ACCOUNTS.flatMap((account) =>
  ENDPOINTS.map((endpoint) => ({
    accountId: account.id,
    endpointId: endpoint.id,
    status: 200,
    headers: {},
    outcome: "allowed" as const,
    durationMs: 1,
  })),
);

/**
 * A report built the way the CLI builds one, with its one unstable field pinned.
 *
 * `runId` is a fresh UUID on every call by design — it identifies the run, not
 * the result — so it is the one thing two builds of the same matrix are meant to
 * differ in.
 */
function report(): RunReport {
  const matrix: AccessMatrix = buildAccessMatrix({
    endpoints: ENDPOINTS,
    accounts: ACCOUNTS,
    observations: OBSERVATIONS,
  });
  const policy = expandPolicy({ fallback: "denied", rules: [] }, ENDPOINTS);
  const built = buildReport({
    version: "test",
    config: CONFIG,
    endpoints: ENDPOINTS,
    observations: OBSERVATIONS,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: ACCOUNTS.length,
    canaries: ACCOUNTS.map((account) => ({
      accountId: account.id,
      endpointId: "orders-az",
      status: 200,
      authenticated: true,
    })),
    truncated: false,
    findings: diffAccess(matrix, policy),
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1),
  });
  return { ...built, runId: "pinned" };
}

describe("the fixture", () => {
  /**
   * A fixture the locales agree about would make every assertion below pass
   * against the unfixed code. This is the measurement the audit reported, in one
   * line: the two collations answer differently about these two identifiers, and
   * neither of them answers what code units do.
   */
  it("carries identifiers the two collations order differently", () => {
    const sweden = Math.sign(new Intl.Collator("sv-SE").compare(Z_ID, O_ID));
    const america = Math.sign(new Intl.Collator("en-US").compare(Z_ID, O_ID));

    expect(sweden).not.toBe(america);
    expect(Math.sign(byCodeUnits(Z_ID, O_ID))).toBe(sweden);
    expect(Math.sign(byCodeUnits(Z_ID, O_ID))).not.toBe(america);
  });
});

describe("byCodeUnits", () => {
  /**
   * The rule the whole file rests on, stated where it can be read.
   *
   * The default `.sort()` compares the string conversions with `<` and `>`, and
   * takes no locale — that is what `canonical()`'s other two branches were doing
   * all along. This function is the same comparison written down, which is why
   * an array sorted either way comes out the same and a plain `.sort()` added
   * tomorrow cannot disagree with it.
   */
  it("is what the default sort already does", () => {
    const ids = [O_ID, Z_ID, "acct-aZ", "acct-a_b", "acct-a-b", "acct-ab"];

    expect([...ids].sort(byCodeUnits)).toEqual([...ids].sort());
  });

  /**
   * Zero for a pair that is the same string, which is what makes it a comparator
   * rather than a strict ordering: `.sort()` is free to keep equal elements
   * where it found them, and a comparator that never returns zero would make the
   * arrangement of duplicates depend on the engine instead.
   */
  it("calls a string equal to itself", () => {
    expect(byCodeUnits(O_ID, O_ID)).toBe(0);
  });

  it("answers the same whatever the machine's locale", () => {
    const ids = [O_ID, Z_ID, "acct-aZ", "acct-ab"];

    expect(oneAnswer(() => [...ids].sort(byCodeUnits))).toEqual([...ids].sort());
  });
});

describe("a report of one run", () => {
  /**
   * The whole document, not a field of it. The order of the finding rows is only
   * the half that was measured; a locale reaching any other sort in this file
   * would show here too.
   */
  it("is the same file on a Swedish machine and an American one", () => {
    oneAnswer(report);
  });

  /** Named on its own because `docs/report.md` sells this one as an answer. */
  it("carries a configDigest that does not move with the machine", () => {
    oneAnswer(() => report().configDigest);
  });

  /**
   * The rows, spelled out. `MAX_ROWS_PER_DEFECT` cuts them after this sort, so
   * on a long-running defect the disagreement is not the order of the evidence
   * but which evidence the file keeps.
   */
  it("puts the finding rows in one order", () => {
    const rows = oneAnswer(() =>
      report().findings.map((finding) => `${finding.endpointId}/${finding.accountId}`),
    );

    expect(rows).toEqual([...rows].sort());
  });
});

describe("the defect groups", () => {
  const diffs: readonly AccessDiff[] = ENDPOINTS.flatMap((endpoint) =>
    ACCOUNTS.map((account) => ({
      accountId: account.id,
      endpointId: endpoint.id,
      expected: "denied" as const,
      actual: "allowed" as const,
      kind: "privilege-escalation" as const,
      severity: "high" as const,
    })),
  );

  it("come out in one order", () => {
    const groups = oneAnswer(() => groupDefects(diffs).map((group) => group.key));

    expect(groups.length).toBeGreaterThan(1);
  });

  it("list the accounts of a group in one order", () => {
    const accountIds = oneAnswer(() => groupDefects(diffs)[0]?.accountIds ?? []);

    expect(accountIds).toEqual([...accountIds].sort());
  });
});

describe("the tenant isolation check", () => {
  /** Two tenants, one digest: a leak, and the pair is named in the finding. */
  const matrix: AccessMatrix = {
    endpoints: [
      { id: "orders-list", method: "GET", path: "/v1/orders", responseMustDifferByTenant: true },
    ],
    accounts: ACCOUNTS,
    resources: [],
    observations: ACCOUNTS.map((account) => ({
      accountId: account.id,
      endpointId: "orders-list",
      status: 200,
      headers: {},
      outcome: "allowed" as const,
      durationMs: 1,
      signals: { digest: 7 },
    })),
  };

  it("names the sides of a pair in one order", () => {
    const findings = oneAnswer(() => createIdenticalResponseCheck().run({ matrix }));

    expect(findings).toHaveLength(1);
  });
});

describe("an error that suggests what was meant", () => {
  /**
   * The suggestion list is machine-readable in practice: it goes into CI output
   * that gets diffed. Nearest-prefix-first is the rule that matters, and the
   * alphabetical tie-break under it was the locale's.
   */
  it("lists the parsed identifiers in one order", () => {
    oneAnswer(
      () =>
        new UnknownEndpointReferenceError("a rule", "orders-a", [
          "orders-aö",
          "orders-az",
          "orders-aZ",
        ]).message,
    );
  });
});

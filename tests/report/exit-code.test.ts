/**
 * Exit code tests.
 *
 * Found by adversarial review: there were three ways to get a "clean" report
 * having checked nothing — a specification with no endpoints, a deployment
 * failing on everything, and an exhausted request budget. In all three the
 * exit code was 0, that is, it read as proof of protection.
 */

import { describe, expect, it } from "vitest";
import type { DiffKind } from "../../src/core/index.js";
import type { RunConfig } from "../../src/io/config.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { ReportFinding, RunReport } from "../../src/report/build.js";
import {
  buildReport,
  exitCodeFor,
  REPORT_SCHEMA_VERSION,
  runVerdict,
} from "../../src/report/build.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`);

function report(overrides: {
  observations?: number;
  escalations?: number;
  probeErrors?: number;
  unauthenticated?: readonly string[];
  truncated?: boolean;
  checks?: readonly ReportFinding[];
  denials?: number;
  canariesChecked?: number;
  staleCredentials?: readonly string[];
  accounts?: readonly {
    readonly id: string;
    readonly role: string;
    readonly anonymous?: boolean;
  }[];
}): RunReport {
  const observations = overrides.observations ?? 4;
  // The rows, not only the counters. This helper used to set `byKind` and leave
  // `findings` empty — a report `buildReport` cannot produce, and the reason
  // `runVerdict` reading counters instead of rows went unnoticed. Whatever the
  // caller asks for as a number exists here as a row. See B-4 and B-14.
  const matrixRows = (kind: DiffKind, howMany: number): readonly ReportFinding[] =>
    Array.from({ length: howMany }, (_, index) => ({
      kind,
      source: "matrix" as const,
      severity: "high" as const,
      accountId: `a${index}`,
      endpointId: `e${index}`,
    }));
  const findings: readonly ReportFinding[] = [
    ...matrixRows("privilege-escalation", overrides.escalations ?? 0),
    ...matrixRows("unexpected-denial", overrides.denials ?? 0),
    ...matrixRows("probe-error", overrides.probeErrors ?? 0),
    ...(overrides.checks ?? []),
  ];
  return {
    schemaVersion: "1",
    runId: "00000000-0000-4000-8000-000000000000",
    configDigest: "0000000000000000",
    coverage: {
      endpointsTotal: 0,
      endpointsProbed: 0,
      cellsObserved: observations,
      cellsNotObserved: 0,
      notProbed: {},
      bodiesComparedOn: [],
      writeMethodsProbed: false,
      checksRun: [],
      byCheck: [],
      contextsProbed: {},
      resourcesNotFound: [],
      outcomes: { allowed: 0, denied: 0, "not-found": 0, error: 0 },
      cellsMatched: 0,
    },
    tool: { name: "barbican", version: "test", documentation: "https://example.test" },
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-12T00:00:01.000Z",
    target: { baseUrl: "https://api.test", allowedHosts: ["api.test"] },
    accounts: overrides.accounts ?? [{ id: "u", role: "r", anonymous: false }],
    endpoints: [],
    resources: [],
    skipped: [],
    failures: [],
    unauthenticated: overrides.unauthenticated ?? [],
    canariesChecked: overrides.canariesChecked ?? 1,
    canaries: [],
    staleCredentials: overrides.staleCredentials ?? [],
    inputs: {
      policy: { fallback: "denied", rules: [] },
      tenants: [],
      auth: { kind: "bearer" },
      contexts: [],
      exclude: [],
    },
    truncated: overrides.truncated ?? false,
    observations: [],
    findings,
    defects: [],
    summary: {
      endpoints: 0,
      accounts: 0,
      accountRows: 0,
      resources: 0,
      observations,
      skipped: 0,
      failures: 0,
      findings: findings.length,
      // Counted from the rows, the way `buildReport` counts them. Built from
      // the override numbers instead, this map disagreed with `findings` — so a
      // check finding whose kind collides with a matrix one was absent here,
      // and a verdict reading the map rather than the rows looked correct.
      byKind: findings.reduce<Record<string, number>>(
        (counts, finding) => {
          counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
          return counts;
        },
        {
          "privilege-escalation": 0,
          "unexpected-denial": 0,
          "not-observed": 0,
          "probe-error": 0,
        },
      ),
      checkFindings: (overrides.checks ?? []).length,
      bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
      defectGroups: 0,
      defectsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
    },
  };
}

describe("the severity summary", () => {
  /**
   * Only matrix discrepancies were counted, and the summary showed high: 5
   * where there were 11. A dashboard built on `bySeverity` lost six findings —
   * among them the most exploitable one: a list leak visible only by body.
   * Found by a cold read of the report by a person who did not know the project.
   */
  it("counts check findings too, not only matrix discrepancies", () => {
    const built = buildReport({
      version: "test",
      config: CONFIG,
      endpoints: [],
      observations: [],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 0,
      truncated: false,
      findings: [],
      policy: { fallback: "denied", rules: [] },
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "the same response for different tenants",
          accountId: "alice",
          endpointId: "orders.list",
          evidence: {},
        },
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "the same response for different tenants",
          accountId: "bob",
          endpointId: "orders.list",
          evidence: {},
        },
      ],
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });

    expect(built.summary.bySeverity.high).toBe(2);
  });
});

describe("coverage and run identification", () => {
  function build(overrides: Record<string, unknown> = {}) {
    return buildReport({
      version: "test",
      config: CONFIG,
      endpoints: [
        { id: "a", method: "GET", path: "/a", responseMustDifferByTenant: true },
        { id: "b", method: "POST", path: "/b" },
      ],
      probed: [{ id: "a", method: "GET", path: "/a" }],
      observations: [],
      skipped: [{ endpointId: "b", reason: "unsafe-method" }],
      failures: [],
      unauthenticated: [],
      canariesChecked: 0,
      truncated: false,
      findings: [],
      policy: { fallback: "denied", rules: [] },
      startedAt: new Date(0),
      finishedAt: new Date(1),
      ...overrides,
    });
  }

  /**
   * Without a denominator "six endpoints probed" means nothing: it could be
   * the whole API surface, or a twentieth of it.
   */
  it("names the denominator, not only the numerator", () => {
    const coverage = build().coverage;

    expect(coverage.endpointsTotal).toBe(2);
    expect(coverage.endpointsProbed).toBe(1);
    expect(coverage.notProbed).toEqual({ "unsafe-method": 1 });
  });

  /**
   * The absence of a finding on an endpoint where bodies were not compared
   * means "no comparison was made", not "nothing matched". There is no other
   * way to see the difference.
   */
  it("names by name where bodies were compared", () => {
    expect(build().coverage.bodiesComparedOn).toEqual(["a"]);
  });

  /**
   * And only where a request went. The list used to be filtered out of every
   * endpoint the source gave, while the check runs on observations — which exist
   * only for the ones that were probed. So an endpoint carrying
   * `responseMustDifferByTenant` and then skipped was named here as compared:
   * the field lying in the one direction it exists to prevent. Found by the
   * audit of 14 August (B-5).
   */
  it("does not name an endpoint that was never probed", () => {
    const built = build({
      endpoints: [
        { id: "a", method: "GET", path: "/a", responseMustDifferByTenant: true },
        { id: "b", method: "POST", path: "/b", responseMustDifferByTenant: true },
      ],
      probed: [{ id: "a", method: "GET", path: "/a", responseMustDifferByTenant: true }],
      skipped: [{ endpointId: "b", reason: "unsafe-method" }],
    });

    expect(built.coverage.bodiesComparedOn).toEqual(["a"]);
  });

  /**
   * A caller that does not say which endpoints were probed gets the same answer
   * by subtraction — the fallback `endpointsProbed` already uses.
   */
  it("falls back to the endpoints minus the skipped ones", () => {
    const built = build({
      endpoints: [
        { id: "a", method: "GET", path: "/a", responseMustDifferByTenant: true },
        { id: "b", method: "POST", path: "/b", responseMustDifferByTenant: true },
      ],
      probed: undefined,
      skipped: [{ endpointId: "b", reason: "unsafe-method" }],
    });

    expect(built.coverage.bodiesComparedOn).toEqual(["a"]);
  });

  /**
   * Found by the audit of 14 August, closed on 15 August with L-4. A check
   * finding naming neither an account nor an endpoint was dropped, behind a
   * comment claiming a counter kept it visible; the counter counted the list
   * **after** the drop, so a critical finding left no trace at all —
   * `findings: 0`, `checkFindings: 0`, verdict clean, and `checksRun` naming the
   * check as having run.
   *
   * A run-level finding is the natural shape for the evidence pack — "this
   * clause is covered by nothing" — and it is now carried like any other.
   */
  it("carries a finding that names no cell", () => {
    const built = build({
      checks: [
        {
          checkId: "evidence-coverage-insufficient",
          severity: "critical",
          title: "the clause is not covered by any probe",
          evidence: {},
        },
      ],
      checksRun: [
        {
          id: "evidence-coverage-insufficient",
          standards: [{ standard: "OWASP-ASVS-5.0", clause: "1.2.3" }],
        },
      ],
    });
    const finding = built.findings.find((one) => one.kind === "evidence-coverage-insufficient");

    expect(built.summary.findings).toBe(1);
    expect(built.summary.checkFindings).toBe(1);
    // Nothing invented in place of the cell: an endpoint id here would tell the
    // reader a request was made.
    expect(finding).not.toHaveProperty("accountId");
    expect(finding).not.toHaveProperty("endpointId");
    expect(finding?.standards).toEqual([{ standard: "OWASP-ASVS-5.0", clause: "1.2.3" }]);
  });

  /**
   * A defect group answers "how many distinct breakages of the platform". A
   * statement about the run is not one, and a signature built from an endpoint
   * it does not have would be a category error.
   */
  it("does not group a finding that names no cell as a defect", () => {
    const built = build({
      checks: [
        {
          checkId: "evidence-coverage-insufficient",
          severity: "critical",
          title: "the clause is not covered by any probe",
          evidence: {},
        },
      ],
    });

    expect(built.summary.findings).toBe(1);
    expect(built.summary.defectGroups).toBe(0);
  });

  it("carries a finding that names its cell as before", () => {
    const built = build({
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "the same response for different tenants",
          accountId: "alice",
          endpointId: "a",
          evidence: {},
        },
      ],
    });

    expect(built.summary.checkFindings).toBe(1);
    expect(built.summary.defectGroups).toBe(1);
  });

  /**
   * Found by the audit of 14 August. A resource that is not there answers 404 to
   * everybody, `not-found` folds into `denied`, and where no rule grants anyone
   * access every one of its cells agrees with the policy. The tool's central
   * claim — "carol cannot read alice's order" — was proved by the order not
   * existing, and the report said "tested and agreed" about it.
   *
   * Where an owner is granted access this already surfaced as an unexpected
   * denial. This names the other half.
   */
  it("names resources every account was answered 404 for", () => {
    const observations = [
      {
        accountId: "u",
        endpointId: "a",
        resourceId: "ghost",
        status: 404,
        headers: {},
        outcome: "not-found" as const,
        durationMs: 1,
      },
      {
        accountId: "v",
        endpointId: "a",
        resourceId: "ghost",
        status: 404,
        headers: {},
        outcome: "not-found" as const,
        durationMs: 1,
      },
      {
        accountId: "u",
        endpointId: "a",
        resourceId: "real",
        status: 200,
        headers: {},
        outcome: "allowed" as const,
        durationMs: 1,
      },
      {
        accountId: "v",
        endpointId: "a",
        resourceId: "real",
        status: 404,
        headers: {},
        outcome: "not-found" as const,
        durationMs: 1,
      },
    ];

    expect(build({ observations }).coverage.resourcesNotFound).toEqual(["ghost"]);
  });

  // One account reaching it is enough: the object is there, and every other 404
  // is then a statement about access rather than about existence.
  it("says nothing about a resource one account did reach", () => {
    const observations = [
      {
        accountId: "u",
        endpointId: "a",
        resourceId: "real",
        status: 200,
        headers: {},
        outcome: "allowed" as const,
        durationMs: 1,
      },
      {
        accountId: "v",
        endpointId: "a",
        resourceId: "real",
        status: 404,
        headers: {},
        outcome: "not-found" as const,
        durationMs: 1,
      },
    ];

    expect(build({ observations }).coverage.resourcesNotFound).toEqual([]);
  });

  // A request that failed proves nothing either way, so it must not turn a
  // resource nobody reached into a resource everybody missed.
  it("ignores cells that never produced an answer", () => {
    const observations = [
      {
        accountId: "u",
        endpointId: "a",
        resourceId: "ghost",
        status: 0,
        headers: {},
        outcome: "error" as const,
        durationMs: 1,
      },
      {
        accountId: "v",
        endpointId: "a",
        resourceId: "ghost",
        status: 0,
        headers: {},
        outcome: "error" as const,
        durationMs: 1,
      },
    ];

    expect(build({ observations }).coverage.resourcesNotFound).toEqual([]);
  });

  it("says whether write methods were performed", () => {
    expect(build().coverage.writeMethodsProbed).toBe(false);
    expect(build({ unsafeMethods: true }).coverage.writeMethodsProbed).toBe(true);
  });

  /** Otherwise two reports cannot be told apart or diffed. */
  it("gives different runs different identifiers", () => {
    expect(build().runId).not.toBe(build().runId);
  });

  /**
   * The fingerprint is computed over the parsed configuration: comments and
   * indentation do not affect the result of a run, while they would affect a
   * hash of the text.
   */
  it("gives the same fingerprint to the same configuration", () => {
    expect(build().configDigest).toBe(build().configDigest);
  });

  it("declares the version of the report shape", () => {
    expect(build().schemaVersion).toBe(REPORT_SCHEMA_VERSION);
  });

  /**
   * Found by the audit of 14 August. The report named its schema version and its
   * tool version and pointed at no explanation of either. Everything a receiver
   * needs to interpret it — what `basis` means, how "clean" differs from
   * "nothing was checked" — lives in `docs/report.md`, and the artifact did not
   * say so. Whoever gets the ticket has the JSON and nothing else.
   */
  it("says where its own shape is explained", () => {
    expect(build({ version: "0.2.0" }).tool.documentation).toBe(
      "https://github.com/Tarnellion/barbican/blob/v0.2.0/docs/report.md",
    );
  });

  // A development build has no tag to point at, and a link into nothing is worse
  // than a link into the newest text.
  it("points at main when the version is not a release", () => {
    expect(build({ version: "0.3.0-dev.1" }).tool.documentation).toContain("/blob/main/");
  });

  /**
   * A check that someone forgot to register, or that crashed, gave a report
   * indistinguishable from a clean one: its key shows up in `byKind` only once
   * it has found something. Found by a second cold read.
   */
  it("lists the checks that ran, including the ones that found nothing", () => {
    expect(build({ checksRun: ["identical-response-across-tenants"] }).coverage.checksRun).toEqual([
      "identical-response-across-tenants",
    ]);
  });

  /**
   * The counter counted only matrix discrepancies and diverged from its
   * neighbours by exactly the findings by body. The same class as the earlier
   * `bySeverity` bug, in the same object — and I missed it while fixing the
   * neighbour.
   */
  it("counts the whole list in findings, not only matrix discrepancies", () => {
    const built = build({
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "x",
          accountId: "alice",
          endpointId: "a",
          evidence: {},
        },
      ],
    });

    expect(built.summary.findings).toBe(built.findings.length);
    expect(built.summary.findings).toBe(
      Object.values(built.summary.bySeverity).reduce((a, b) => a + b, 0),
    );
  });

  /**
   * The second side of a leak lived only in the `evidence` of each row, and the
   * defect group named one side out of two: "tenant-a's data is visible to
   * somebody". Found by a cold read.
   */
  it("names both sides of a paired finding in the defect group", () => {
    const built = build({
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "the digest matched",
          accountId: "alice",
          endpointId: "a",
          // The field, since L-4. `evidence` keeps the key for a reader of
          // one finding, but the report no longer reads a contract out of it.
          relatedAccountId: "carol-b",
          evidence: { otherAccountId: "carol-b", bodyDigestsEqual: true },
        },
      ],
    });

    expect(built.defects[0]?.accountIds).toEqual(["alice", "carol-b"]);
  });

  /**
   * A leak by body has two requests, and only one was printed. On a platform
   * with per-tenant addresses the second one was assembled by the reader by
   * hand — and wrongly: another brand's host is a different host. Found by a
   * third cold read.
   */
  it("prints both requests of a paired finding", () => {
    const built = build({
      observations: [
        {
          accountId: "alice",
          endpointId: "a",
          method: "GET",
          url: "https://brand-a.test/a",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
        {
          accountId: "carol",
          endpointId: "a",
          method: "GET",
          url: "https://brand-b.test/a",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
      ],
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "the digest matched",
          accountId: "alice",
          endpointId: "a",
          relatedAccountId: "carol",
          evidence: { otherAccountId: "carol", bodyDigestsEqual: true },
        },
      ],
    });

    const finding = built.findings.find((f) => f.source === "check");
    expect(finding?.request?.url).toBe("https://brand-a.test/a");
    expect(finding?.relatedRequest?.url).toBe("https://brand-b.test/a");
  });

  /**
   * "It is clean here" existed only as subtraction: to check a single cell the
   * reader of the report rewrote the core in their own language. ADR-0020.
   */
  it("puts the verdict next to the observation", () => {
    const built = build({
      observations: [
        {
          accountId: "alice",
          endpointId: "a",
          method: "GET",
          url: "https://api.test/a",
          status: 403,
          outcome: "denied",
          headers: {},
          durationMs: 1,
        },
      ],
      cells: [
        {
          accountId: "alice",
          endpointId: "a",
          expected: "denied",
          match: true,
          actual: "denied",
          ruleIndex: 3,
          relation: "foreign-tenant",
        },
      ],
    });

    expect(built.observations[0]).toMatchObject({
      expected: "denied",
      match: true,
      ruleIndex: 3,
      relation: "foreign-tenant",
    });
  });

  /** The number of matched cells must agree with the summary — checkable on the spot. */
  it("leaves an observation without a verdict when it has no cell", () => {
    const built = build({
      observations: [
        {
          accountId: "alice",
          endpointId: "a",
          method: "GET",
          url: "https://api.test/a",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
      ],
      cells: [{ accountId: "somebody-else", endpointId: "a", expected: "denied", match: false }],
    });

    expect(built.observations[0]).not.toHaveProperty("match");
  });

  /**
   * A row under conditions whose base account is not in the configuration is a
   * state that must not happen. Printing it as an account would mean inventing
   * a role and a tenant, so the row simply does not enter the list.
   */
  it("does not print a row under conditions whose base account is unknown", () => {
    const built = build({
      accounts: [
        { id: "u", roleId: "r", tenantId: "t" },
        {
          id: "ghost@geo",
          roleId: "r",
          tenantId: "t",
          contextId: "geo",
          baseAccountId: "ghost",
        },
      ],
    });

    expect(built.accounts.map((account) => account.id)).toEqual(["u"]);
  });

  /** An unpaired finding has no second request, and there is nothing to invent one from. */
  it("invents no second request where there was no pair", () => {
    const built = build({
      checks: [
        {
          checkId: "some-check",
          severity: "low",
          title: "no counterpart",
          accountId: "alice",
          endpointId: "a",
          evidence: { anything: "at all" },
        },
      ],
    });

    expect(built.findings.find((f) => f.source === "check")).not.toHaveProperty("relatedRequest");
  });

  /** The variable name is not a secret, and without it there is nothing to reproduce with. */
  it("names the environment variable holding the token, but not its value", () => {
    const account = build().accounts[0];

    expect(account?.tokenEnv).toBe("T");
    expect(JSON.stringify(build())).not.toContain("secret-value");
  });

  /** Otherwise the invariant "throttling is always on" has to be taken on trust. */
  it("prints the request limits that were in force", () => {
    expect(
      build({ throttle: { concurrency: 2, requestsPerSecond: 5, maxRequests: 2000 } }).inputs
        .throttle,
    ).toEqual({ concurrency: 2, requestsPerSecond: 5, maxRequests: 2000 });
  });

  /**
   * Without an explicit mark the report's only positive conclusion — "the
   * anonymous account was denied everywhere" — is unprovable: an account whose
   * token was passed wrongly would look exactly the same.
   */
  it("marks an account without credentials as anonymous", () => {
    const withAnon = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: u, role: r, tenant: t, tokenEnv: T }
  - { id: anon, role: anonymous }
policy: { fallback: denied, rules: [] }
`);

    const accounts = build({ config: withAnon }).accounts;

    expect(accounts.find((a) => a.id === "u")?.anonymous).toBe(false);
    expect(accounts.find((a) => a.id === "anon")?.anonymous).toBe(true);
  });

  it("counts them by conclusion, with every key present", () => {
    const built = build({
      observations: [
        {
          accountId: "alice",
          endpointId: "a",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
        {
          accountId: "alice",
          endpointId: "b",
          status: 403,
          outcome: "denied",
          headers: {},
          durationMs: 1,
        },
      ],
    });

    // A zero key is the point of the field: `denied: 0` is the signature, and a
    // missing key would have to be read as a zero by whoever thought to look.
    expect(built.coverage.outcomes).toEqual({
      allowed: 1,
      denied: 1,
      "not-found": 0,
      error: 0,
    });
  });

  /**
   * The signature itself. It does not settle which of the two readings is right
   * and cannot: from status codes alone "refuses with 200" and "grants
   * everything" are the same picture. Both are worth stopping for.
   */
  it("says denied: 0 when nothing was refused", () => {
    const built = build({
      observations: [
        {
          accountId: "alice",
          endpointId: "a",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
      ],
    });

    expect(built.coverage.outcomes.denied).toBe(0);
    expect(built.summary.observations).toBe(1);
  });
});

describe("accounts under request conditions", () => {
  const WITH_CONTEXT = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [a], context: geo, outcome: denied }
contexts:
  - { id: geo, headers: { cf-ipcountry: AQ }, endpoints: [a] }
`);

  function build() {
    return buildReport({
      version: "test",
      config: WITH_CONTEXT,
      endpoints: [{ id: "a", method: "GET", path: "/a" }],
      observations: [
        {
          accountId: "u@geo",
          endpointId: "a",
          status: 451,
          outcome: "denied",
          headers: {},
          durationMs: 1,
        },
      ],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 0,
      truncated: false,
      findings: [],
      policy: { fallback: "denied", rules: [] },
      accounts: [
        { id: "u", roleId: "r", tenantId: "t" },
        { id: "u@geo", roleId: "r", tenantId: "t", contextId: "geo", baseAccountId: "u" },
      ],
      cells: [
        {
          accountId: "u@geo",
          endpointId: "a",
          contextId: "geo",
          expected: "denied",
          basis: "fallback" as const,
          actual: "denied",
          match: true,
        },
      ],
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
  }

  /**
   * A finding refers to an account under conditions. Without a row in the list
   * of accounts the reference dangles: the reader sees `u@geo`, looks for it
   * and finds nothing.
   */
  it("lists an account under conditions on par with the base one", () => {
    const accounts = build().accounts;

    expect(accounts.map((account) => account.id)).toEqual(["u", "u@geo"]);
    expect(accounts[1]).toMatchObject({
      contextId: "geo",
      baseAccountId: "u",
      role: "r",
      tenant: "t",
    });
  });

  /** The attributes are printed: otherwise a finding under conditions cannot be reproduced. */
  it("prints the declared conditions together with their attributes", () => {
    expect(build().inputs.contexts).toEqual([
      {
        id: "geo",
        headers: { "cf-ipcountry": "AQ" },
        query: {},
        endpointIds: ["a"],
        accountIds: [],
      },
    ]);
  });

  /**
   * A zero here means "the conditions are declared but not tested": their
   * endpoints may have gone into skipped, and the absence of findings would
   * read as "everything is in order under these conditions".
   */
  it("counts the observed cells for each set of conditions", () => {
    expect(build().coverage.contextsProbed).toEqual({ geo: 1 });
  });

  /**
   * "Tested and agreed" existed only as subtraction the reader did themselves.
   * As a number it is checkable: its sum with the discrepancies gives the
   * observations.
   */
  it("names the number of matched cells instead of leaving it to subtraction", () => {
    const built = build();

    // ADR-0020 promises this equality, and it used to fail: the count was done
    // by subtraction that included `not-observed` too — cells with no
    // observation at all. Found by adversarial review.
    expect(built.coverage.cellsMatched).toBe(
      built.observations.filter((observation) => observation.match === true).length,
    );
    expect(built.coverage.cellsMatched).toBe(1);
  });

  /**
   * A zero would read as "not a single cell agreed" — a claim about the
   * platform. What needs saying is "we did not count this".
   */
  it("does not print the number of matched cells when no verdicts were counted", () => {
    const built = buildReport({
      version: "test",
      config: WITH_CONTEXT,
      endpoints: [{ id: "a", method: "GET", path: "/a" }],
      observations: [],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 1,
      truncated: false,
      findings: [],
      policy: { fallback: "denied", rules: [] },
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });

    expect(built.coverage).not.toHaveProperty("cellsMatched");
  });

  /**
   * The one question worth asking of a report full of findings, answerable from
   * the report rather than by scanning the observations: **was anything ever
   * refused?**
   *
   * A platform answering `200 OK` with the outcome in the body reads as
   * "allowed" on every cell, so every cell the policy denies becomes a privilege
   * escalation and the whole report is wrong while looking like a catastrophe.
   * Measured on a six-cell demo of one: four false escalations, one false leak,
   * exit code 1. See L-3.
   */
  /** 9 accounts x 6 endpoints did not give 135 cells, and the arithmetic did not add up. */
  it("tells declared accounts apart from matrix rows", () => {
    const built = build();

    expect(built.summary.accounts).toBe(1);
    expect(built.summary.accountRows).toBe(2);
  });
});

describe("the configuration fingerprint", () => {
  const withScheme = (scheme: string) =>
    parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
auth: { kind: bearer }
authSchemes: { console: ${scheme} }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T, authScheme: console }]
policy: { fallback: denied, rules: [] }
`);

  const digestOf = (config: RunConfig) =>
    buildReport({
      version: "test",
      config,
      endpoints: [],
      observations: [],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 1,
      truncated: false,
      findings: [],
      policy: { fallback: "denied", rules: [] },
      startedAt: new Date(0),
      finishedAt: new Date(1),
    }).configDigest;

  /**
   * The whole point of the field: telling "the platform changed" from "we
   * changed the declaration". `accountAuth` is a `Map`, `JSON.stringify` renders
   * a `Map` as `{}`, and so the per-account authentication schemes did not enter
   * the digest at all — two runs presenting entirely different credentials had
   * the same fingerprint. Found by the audit of 14 August (H-11).
   */
  it("changes when the accounts authenticate differently", () => {
    const asHeader = digestOf(withScheme("{ kind: header, header: x-api-key }"));
    const asCookie = digestOf(withScheme("{ kind: cookie, name: sid }"));

    expect(asHeader).not.toBe(asCookie);
  });

  /**
   * And does not change when only the typing does. This was the audit's own
   * claim about this field and it was wrong when measured — `parseRunConfig`
   * already built its result in a fixed order — so the assertion pins a property
   * that held by accident and now holds by construction.
   */
  it("does not change when the YAML keys are in another order", () => {
    const one = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`);
    const other = parseRunConfig(`
accounts: [{ tokenEnv: T, tenant: t, role: r, id: u }]
policy: { rules: [], fallback: denied }
target: { allowedHosts: [a.test], baseUrl: "https://a.test" }
`);

    expect(digestOf(one)).toBe(digestOf(other));
  });

  /**
   * A policy is ordered — the last rule that matched wins — so two policies with
   * the same rules in a different order are two different declarations.
   */
  it("changes when the policy rules are reordered", () => {
    // The same two rules, and only the order differs — otherwise this passes
    // whether or not arrays keep their order, which is what the first version of
    // this test did.
    const allowA = '{ roles: "*", endpoints: [a], outcome: allowed }';
    const denyB = '{ roles: "*", endpoints: [b], outcome: denied }';
    const ordered = (first: string, second: string) =>
      parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy:
  fallback: denied
  rules:
    - ${first}
    - ${second}
`);

    expect(digestOf(ordered(allowA, denyB))).not.toBe(digestOf(ordered(denyB, allowA)));
  });
});

describe("exitCodeFor", () => {
  /**
   * A discrepancy is a discrepancy whichever way it points. Found by checking
   * the reference platform's oracle: a holding was denied its own brand — the
   * platform is broken, the declared access does not work — and the run
   * returned 0. See ADR-0014.
   */
  it("1 — an unexpected denial is a discrepancy too", () => {
    expect(exitCodeFor(report({ denials: 1 }))).toBe(1);
  });

  /**
   * A check finding is not visible by status, but it is the same discrepancy.
   * Without this a run that found a cross-tenant leak would look successful
   * in CI.
   */
  it("1 — a check finding of high severity", () => {
    const leak: ReportFinding = {
      kind: "identical-response-across-tenants",
      source: "check",
      severity: "high",
      accountId: "alice",
      endpointId: "orders.list",
      title: "the same response for different tenants",
    };

    expect(exitCodeFor(report({ checks: [leak] }))).toBe(1);
  });

  /**
   * One threshold for both channels, which is what ADR-0014 states and the code
   * did not do: a matrix discrepancy of any severity failed the run, a check
   * finding needed `high|critical`. So the same disagreement between platform
   * and declaration failed a build when the status showed it and passed when the
   * body did. Found by the audit of 14 August (B-3).
   */
  it("1 — a check finding of medium severity, like any other disagreement", () => {
    const finding: ReportFinding = {
      kind: "response-count-differs",
      source: "check",
      severity: "medium",
      accountId: "alice",
      endpointId: "orders.list",
      title: "two tenants saw the same number of records",
    };

    expect(exitCodeFor(report({ checks: [finding] }))).toBe(1);
    expect(exitCodeFor(report({ checks: [{ ...finding, severity: "low" }] }))).toBe(1);
  });

  /**
   * `summary.byKind` holds matrix kinds and check identifiers in one key space.
   * A check registered as `privilege-escalation` had its findings counted here
   * as matrix ones — registering one is refused now, but this function takes a
   * report from anywhere and a consumer assembling one by hand never passes the
   * registry. Found by the audit of 14 August (B-4).
   */
  it("does not take a check finding for a matrix escalation", () => {
    const disguised: ReportFinding = {
      kind: "privilege-escalation",
      source: "check",
      severity: "info",
      accountId: "alice",
      endpointId: "orders.list",
      title: "a note that happens to share a name",
    };

    // `info` from a check is a note and fails nothing. Read as a matrix
    // escalation it would fail the run and say "privilege escalation: 1 cell".
    expect(runVerdict(report({ checks: [disguised] })).reason).not.toContain(
      "privilege escalation",
    );
    expect(exitCodeFor(report({ checks: [disguised] }))).toBe(0);
  });

  it("0 — the check finding is informational only", () => {
    const note: ReportFinding = {
      kind: "whatever",
      source: "check",
      severity: "info",
      accountId: "alice",
      endpointId: "ping",
      title: "for information",
    };

    expect(exitCodeFor(report({ checks: [note] }))).toBe(0);
  });

  it("0 — tested and clean", () => {
    expect(exitCodeFor(report({}))).toBe(0);
  });

  it("1 — an escalation was found", () => {
    expect(exitCodeFor(report({ escalations: 1 }))).toBe(1);
  });

  it("2 — not a single observation was made", () => {
    // A specification with no endpoints: there are no findings because nothing
    // was checked.
    expect(exitCodeFor(report({ observations: 0 }))).toBe(2);
  });

  it("2 — every request failed", () => {
    // The deployment went down or the circuit breaker tripped: there is
    // nothing to judge.
    expect(exitCodeFor(report({ observations: 4, probeErrors: 4 }))).toBe(2);
  });

  // Found by adversarial review: the request ceiling cut the matrix short in
  // the middle of the run, an untested cross-tenant leak stayed unfound, and
  // the exit code was 0.
  it("2 — the run was cut short, the tail of the matrix untested", () => {
    expect(exitCodeFor(report({ truncated: true }))).toBe(2);
  });

  /**
   * The class "nothing was tested looks like everything is clean", found by
   * adversarial review. The deployment answered 401 to everything, the tokens
   * were stale, the policy consisted of denials only — and the `findUnauthenticated`
   * safeguard stayed silent by construction: nothing was declared allowed, so
   * there is nothing to say "it was denied everywhere" about. The report came
   * out clean with exit code 0.
   */
  it("2 — authentication was confirmed by no canary at all", () => {
    expect(exitCodeFor(report({ canariesChecked: 0 }))).toBe(2);
  });

  /**
   * An anonymous run — "check that nobody at all can get in here" — has
   * nothing to authenticate, and requiring a canary would forbid a lawful
   * scenario.
   */
  it("0 — a run of anonymous accounts only needs no canary", () => {
    expect(
      exitCodeFor(
        report({ canariesChecked: 0, accounts: [{ id: "anon", role: "guest", anonymous: true }] }),
      ),
    ).toBe(0);
  });

  /**
   * Found by the audit of 14 August. Canaries were probed once, before the walk,
   * so a token that expired in the middle turned every remaining cell into a 401
   * — which reads as a denial, agrees with a policy of denial, and lands in
   * `cellsMatched` as "tested and agreed". `findUnauthenticated` cannot see it:
   * it asks about accounts granted access nowhere, and the first half succeeded.
   */
  it("2 — the credentials went stale halfway through", () => {
    const verdict = runVerdict(report({ observations: 4, staleCredentials: ["alice"] }));

    expect(verdict.code).toBe(2);
    expect(verdict.reason).toContain("alice");
  });

  // Outranks a finding, exactly as truncation does: what was not tested is never
  // clean, and here the tail was tested by an account that had stopped counting.
  it("an expired token outranks an escalation", () => {
    expect(
      exitCodeFor(report({ observations: 4, escalations: 3, staleCredentials: ["alice"] })),
    ).toBe(2);
  });

  it("2 — authentication did not work", () => {
    expect(exitCodeFor(report({ unauthenticated: ["a"] }))).toBe(2);
  });

  it("an untrustworthy result outranks a finding", () => {
    // An escalation on an untested run is no reason to report exit code 1.
    expect(exitCodeFor(report({ escalations: 1, unauthenticated: ["a"] }))).toBe(2);
  });

  it("partial failures do not make a run untrustworthy", () => {
    // One failed cell out of four: the conclusions about the other three hold,
    // and the error itself is visible in failures and byKind.
    expect(exitCodeFor(report({ observations: 4, probeErrors: 1 }))).toBe(0);
  });

  /**
   * The former rule required **every** cell to fail: three errors out of four
   * gave exit code 0, that is, "tested, no discrepancies" about a matrix of
   * which one cell survived. Found by review.
   */
  it("2 — half the matrix or more failed", () => {
    expect(exitCodeFor(report({ observations: 4, probeErrors: 2 }))).toBe(2);
    expect(exitCodeFor(report({ observations: 4, probeErrors: 3 }))).toBe(2);
  });
});

/**
 * A cold read of 14 August: the summary printed "Distinct defects: at least 1"
 * and the run exited 0. Both were correct — a low-severity probe error does not
 * fail a run — and together they read as "a defect was found and the build is
 * green", from which the honest conclusion is that the exit code is unreliable.
 *
 * The verdict carries its own sentence so the two cannot be read apart. The
 * sentence is derived where the code is derived: two sets of rules for the same
 * decision agree until the day they do not.
 */
describe("the reason travelling with the exit code", () => {
  it("says out loud that the rows are notes when a run passes with findings", () => {
    const base = report({ observations: 4, probeErrors: 1 });
    const verdict = runVerdict({ ...base, summary: { ...base.summary, findings: 1 } });

    expect(verdict.code).toBe(0);
    expect(verdict.reason).toContain("no discrepancy that fails a run");
  });

  it("distinguishes a clean run from one that passed despite findings", () => {
    expect(runVerdict(report({ observations: 4 })).reason).toBe(
      "no discrepancy with the declared policy",
    );
  });

  it("names the count when an escalation fails the run", () => {
    const verdict = runVerdict(report({ observations: 4, escalations: 3 }));

    expect(verdict.code).toBe(1);
    expect(verdict.reason).toContain("3 cells");
  });

  it("names the numbers behind an untrustworthy verdict", () => {
    const verdict = runVerdict(report({ observations: 4, probeErrors: 2 }));

    expect(verdict.code).toBe(2);
    expect(verdict.reason).toContain("2 of 4 cells");
  });

  it("names the accounts that were granted access nowhere", () => {
    const verdict = runVerdict(report({ observations: 4, unauthenticated: ["alice", "bob"] }));

    expect(verdict.code).toBe(2);
    expect(verdict.reason).toContain("alice, bob");
  });

  // The code stays the single number CI acts on, and it must not drift from the
  // verdict it is now derived from.
  it("agrees with exitCodeFor in every case above", () => {
    const cases = [
      report({ observations: 4 }),
      report({ observations: 4, probeErrors: 1 }),
      report({ observations: 4, escalations: 3 }),
      report({ observations: 4, probeErrors: 2 }),
      report({ observations: 0 }),
      report({ observations: 4, truncated: true }),
    ];

    for (const one of cases) {
      expect(exitCodeFor(one)).toBe(runVerdict(one).code);
    }
  });
});

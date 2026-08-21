/**
 * A finding that is known, accepted, and still in the report.
 *
 * Before ADR-0048 the only way to stop a finding failing a build was to declare
 * the cell allowed, and that removes it from the artifact entirely: no row, no
 * defect group, `match: true`, exit 0. The claims worth holding are therefore
 * about what an acceptance does **not** do — it does not delete anything and it
 * does not move a counter — and about the two ways it stops holding: the day it
 * lapses, and the run where it covers nothing.
 *
 * The route is the whole of it: `parseRunConfig`, `buildAccessMatrix`,
 * `diffAccess`, `buildReport`. Asking `runVerdict` about a hand-written summary
 * would answer "given these counts, what is the verdict" and could not see
 * whether a run produces those counts at all — which is the mistake
 * `verdict-seams.test.ts` was written about.
 */

import { describe, expect, it } from "vitest";
import type { AccessObservation, Endpoint } from "../../src/core/index.js";
import { buildAccessMatrix, describeMatrix, expandPolicy } from "../../src/core/index.js";
import type { RunConfig } from "../../src/io/config.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { RunReport } from "../../src/report/build.js";
import { buildReport } from "../../src/report/build.js";

const ENDPOINTS: readonly Endpoint[] = [
  { id: "orders.get", method: "GET", path: "/v1/orders/{orderId}" },
];

/**
 * Carol reads an order of a tenant that is not hers, and the platform allows it.
 *
 * Written by hand, like every fixture here: observations derived from the policy
 * would make this a test that `diffAccess` agrees with itself.
 */
const WALKED: readonly AccessObservation[] = [
  {
    accountId: "alice",
    endpointId: "orders.get",
    resourceId: "order-1001",
    status: 200,
    outcome: "allowed",
  },
  {
    accountId: "carol",
    endpointId: "orders.get",
    resourceId: "order-1001",
    status: 200,
    outcome: "allowed",
  },
];

/** The defect the walk above produces, in the words `defects[].key` uses. */
const DEFECT = "orders.get foreign-tenant baseline";

function configWith(accepted: string): RunConfig {
  return parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: alice, role: user, tenant: t-a, tokenEnv: A, canary: orders.get }
  - { id: carol, role: user, tenant: t-b, tokenEnv: C, canary: orders.get }
tenants: [t-a, t-b]
resources:
  - { id: order-1001, tenant: t-a, owner: alice, params: { orderId: "1001" } }
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [orders.get], scope: own, outcome: allowed }
${accepted}`);
}

/** A run of the walk above, started on the given day. */
function run(config: RunConfig, startedAt: string): RunReport {
  const matrix = buildAccessMatrix({
    endpoints: ENDPOINTS,
    accounts: [
      { id: "alice", roleId: "user", tenantId: "t-a" },
      { id: "carol", roleId: "user", tenantId: "t-b" },
    ],
    resources: config.resources,
    observations: WALKED,
    tenants: config.tenants ?? [],
  });
  const policy = expandPolicy(config.policy, ENDPOINTS);
  const verdicts = describeMatrix(matrix, policy);

  return buildReport({
    version: "test",
    config,
    endpoints: ENDPOINTS,
    observations: WALKED,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 2,
    canaries: ["alice", "carol"].map((accountId) => ({
      accountId,
      endpointId: "orders.get",
      status: 200,
      anonymousStatus: 401,
      authenticated: true,
    })),
    truncated: false,
    findings: verdicts.diffs,
    cells: verdicts.cells,
    policy,
    startedAt: new Date(startedAt),
    finishedAt: new Date(startedAt),
  });
}

const ACCEPTING = `
accepted:
  - endpoint: orders.get
    relation: foreign-tenant
    kind: privilege-escalation
    reason: the order service has no tenant filter; PLAT-1234 replaces it
    until: 2026-11-30
    ticket: PLAT-1234
`;

const BEFORE = "2026-10-01T09:00:00.000Z";
const AFTER = "2026-12-01T09:00:00.000Z";

describe("the run this is all about", () => {
  /**
   * Without an acceptance the walk fails, and it fails on one critical row.
   *
   * A test of a suppression that never demonstrated the thing being suppressed
   * would agree with a `buildReport` that finds nothing at all.
   */
  it("finds a cross-tenant read and fails on it", () => {
    const report = run(configWith(""), BEFORE);

    expect(report.verdict.code).toBe(1);
    expect(report.summary.findings).toBe(1);
    expect(report.summary.bySeverity.critical).toBe(1);
    expect(report.defects.map((defect) => defect.key)).toEqual([DEFECT]);
    expect(report.summary.accepted).toEqual({
      declared: 0,
      findings: 0,
      expired: 0,
      unused: 0,
      byKind: {},
    });
  });
});

describe("an acceptance in force", () => {
  const report = run(configWith(ACCEPTING), BEFORE);

  it("takes the finding out of the verdict", () => {
    expect(report.verdict.code).toBe(0);
    expect(report.summary.verdictInputs.matrixByKind["privilege-escalation"]).toBe(0);
  });

  /**
   * The row is still there, with everything a ticket is filed from.
   *
   * This is the difference from declaring the cell allowed, and the whole reason
   * the feature is not a policy rule: an evidence pack has to be able to show a
   * regulator "found, and accepted, for this reason, until this date". A policy
   * rule shows "nothing was found", which is a different sentence about a
   * different platform.
   */
  it("leaves the finding in the report, marked", () => {
    expect(report.summary.findings).toBe(1);
    expect(report.summary.byKind["privilege-escalation"]).toBe(1);
    expect(report.summary.bySeverity.critical).toBe(1);

    const [finding] = report.findings;

    expect(finding?.severity).toBe("critical");
    expect(finding?.accepted).toEqual({
      reason: "the order service has no tenant filter; PLAT-1234 replaces it",
      until: "2026-11-30",
      ticket: "PLAT-1234",
      expired: false,
    });
  });

  /** And in the defect groups, which is the list a reader actually reads. */
  it("leaves the defect group, marked, at its own severity", () => {
    const [defect] = report.defects;

    expect(defect?.key).toBe(DEFECT);
    expect(defect?.severity).toBe("critical");
    expect(defect?.acceptedKinds).toEqual(["privilege-escalation"]);
    expect(report.summary.defectGroups).toBe(1);
    expect(report.summary.defectsBySeverity.critical).toBe(1);
  });

  /** The cell is not "tested and agreed": what changed is the verdict on the run. */
  it("does not turn the cell into a match", () => {
    const cell = report.observations.find((one) => one.accountId === "carol");

    expect(cell?.match).toBe(false);
    expect(cell?.findingKinds).toEqual(["privilege-escalation"]);
    expect(report.coverage.cellsMatched).toBe(1);
    expect(report.coverage.cellsWithFindings).toBe(1);
    expect((report.coverage.cellsMatched ?? 0) + (report.coverage.cellsWithFindings ?? 0)).toBe(
      report.coverage.cellsObserved,
    );
  });

  it("counts itself, and the count reconciles with byKind", () => {
    expect(report.summary.accepted).toEqual({
      declared: 1,
      findings: 1,
      expired: 0,
      unused: 0,
      byKind: { "privilege-escalation": 1 },
    });

    for (const kind of ["privilege-escalation", "unexpected-denial"] as const) {
      expect(
        (report.summary.byKind[kind] ?? 0) - (report.summary.accepted.byKind[kind] ?? 0),
        `byKind minus accepted must be what the verdict read for ${kind}`,
      ).toBe(report.summary.verdictInputs.matrixByKind[kind]);
    }
  });

  /**
   * The declaration and what it did, side by side.
   *
   * `defect` is printed rather than the three fields it was written from, so it
   * can be compared with `defects[].key` by eye — and by a reader who has the
   * JSON and nothing else.
   */
  it("publishes the declaration and how many rows it covered", () => {
    expect(report.accepted).toEqual([
      {
        defect: DEFECT,
        kind: "privilege-escalation",
        reason: "the order service has no tenant filter; PLAT-1234 replaces it",
        until: "2026-11-30",
        ticket: "PLAT-1234",
        expired: false,
        matched: 1,
      },
    ]);
  });

  /**
   * An exit code of 0 over a critical finding cannot explain itself.
   *
   * That is the argument `runVerdict`'s own comment makes for carrying a reason
   * at all, and this is the case where it is sharpest: the console prints one
   * green line, and without this clause it reads as "clean".
   */
  it("says so on the line CI prints", () => {
    expect(report.verdict.reason).toContain("acceptance");
    expect(report.verdict.reason).toContain("1");
  });
});

describe("an acceptance whose day has passed", () => {
  const report = run(configWith(ACCEPTING), AFTER);

  /** The point of the deadline: silence has a stated end. */
  it("gives the finding back to the verdict", () => {
    expect(report.verdict.code).toBe(1);
    expect(report.summary.verdictInputs.matrixByKind["privilege-escalation"]).toBe(1);
  });

  it("marks the row as lapsed rather than dropping the mark", () => {
    expect(report.findings[0]?.accepted).toEqual({
      reason: "the order service has no tenant filter; PLAT-1234 replaces it",
      until: "2026-11-30",
      ticket: "PLAT-1234",
      expired: true,
    });
    expect(report.defects[0]?.acceptedKinds).toBeUndefined();
  });

  it("counts it apart from the ones still in force", () => {
    expect(report.summary.accepted).toEqual({
      declared: 1,
      findings: 0,
      expired: 1,
      unused: 0,
      byKind: {},
    });
    expect(report.accepted[0]?.expired).toBe(true);
    expect(report.accepted[0]?.matched).toBe(1);
  });

  it("says why the run started failing again", () => {
    expect(report.verdict.reason).toContain("expired");
  });
});

describe("the records these counters live in", () => {
  /**
   * `byKind` is keyed by names this tool did not choose.
   *
   * A matrix row's `kind` is ours; a check finding's is the id whoever
   * registered the check picked, and `buildReport` takes check findings straight
   * from a caller. In a plain object literal the assignment `counts["__proto__"]
   * = 1` is a no-op, so the count disappears without a trace — the finding is in
   * `summary.findings` and in no bucket of `byKind`, which is a dashboard
   * quietly one short. `summary.accepted.byKind` is the same key space and is
   * built the same way; see `openRecord` and ADR-0024.
   *
   * Exotic on purpose. The rule exists because the name cannot be predicted, and
   * a rule nothing measures is one the next edit deletes for free.
   */
  it("carry a kind named __proto__ instead of swallowing it", () => {
    const config = configWith(`
accepted:
  - endpoint: orders.get
    kind: __proto__
    reason: a check id nobody would pick, and the reason the record has no prototype
    until: 2026-11-30
`);
    const report = buildReport({
      version: "test",
      config,
      endpoints: ENDPOINTS,
      observations: WALKED,
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 2,
      canaries: [
        { accountId: "alice", endpointId: "orders.get", status: 200, authenticated: true },
        { accountId: "carol", endpointId: "orders.get", status: 200, authenticated: true },
      ],
      truncated: false,
      findings: [],
      checks: [
        {
          checkId: "__proto__",
          severity: "high",
          title: "a check whose id is the one name a record cannot hold",
          accountId: "carol",
          endpointId: "orders.get",
          evidence: {},
        },
      ],
      policy: expandPolicy(config.policy, ENDPOINTS),
      startedAt: new Date(BEFORE),
      finishedAt: new Date(BEFORE),
    });

    expect(report.summary.findings).toBe(1);
    expect(Object.hasOwn(report.summary.byKind, "__proto__")).toBe(true);
    expect(report.summary.byKind["__proto__"]).toBe(1);
    expect(report.summary.accepted.findings).toBe(1);
    expect(Object.hasOwn(report.summary.accepted.byKind, "__proto__")).toBe(true);
    expect(report.summary.accepted.byKind["__proto__"]).toBe(1);
  });
});

describe("an acceptance that covered nothing", () => {
  /**
   * The platform was fixed, or the run never reached the cell.
   *
   * Both leave a line in the configuration that nobody removes, and a line
   * nobody removes is a suppression waiting for the defect to come back. The
   * report says so; it does not fail the run, because failing a build on a fix
   * is how the tool gets taken out of CI again.
   */
  const report = run(
    configWith(`
accepted:
  - endpoint: orders.get
    relation: same-tenant
    kind: privilege-escalation
    reason: a neighbour inside the tenant could read this until PLAT-7 landed
    until: 2026-11-30
`),
    BEFORE,
  );

  it("does not change the verdict on its own", () => {
    expect(report.verdict.code).toBe(1);
    expect(report.summary.verdictInputs.matrixByKind["privilege-escalation"]).toBe(1);
  });

  it("is named, with the number that says it covered nothing", () => {
    expect(report.accepted[0]?.matched).toBe(0);
    expect(report.summary.accepted.unused).toBe(1);
  });

  it("says so on the line CI prints", () => {
    expect(report.verdict.reason).toContain("matched nothing");
  });
});

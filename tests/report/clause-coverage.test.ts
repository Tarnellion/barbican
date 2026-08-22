/**
 * `coverage.clauses`: the second direction of traceability, in the artifact.
 *
 * A finding names the clauses it answers for; that direction has existed since
 * ADR-0041. The other one — from a clause to what exercised it, whether or not
 * anything broke — existed for registered checks only, in `coverage.checksRun`.
 * The matrix channel had no list at all, so a clause exercised across nine
 * hundred agreeing cells appeared in an evidence pack only when one of them
 * broke.
 *
 * What is under test here is mostly the refusal. The tool must not report a
 * clause as exercised on a surface it could not see: an endpoint it never
 * probed, a cell it never asked, a request that failed, a platform whose
 * refusals it cannot recognise. Each of those has to stand beside the number,
 * because a claim of coverage the reader cannot discount is worse than no claim.
 *
 * See ADR-0052; the second half of M-11.
 */

import { describe, expect, it } from "vitest";
import {
  ASVS_DOCUMENTED_RULES,
  ASVS_FUNCTION_LEVEL_ACCESS,
} from "../../src/core/checks/clauses.js";
import type { AccessObservation, Account, Endpoint } from "../../src/core/index.js";
import {
  buildAccessMatrix,
  createIdenticalResponseCheck,
  describeMatrix,
  expandPolicy,
} from "../../src/core/index.js";
import type { ClauseCoverage } from "../../src/core/standards/coverage.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { BuildReportOptions, RunReport } from "../../src/report/build.js";
import { buildReport } from "../../src/report/build.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
accounts: [{ id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }]
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
`);

const ACCOUNTS: readonly Account[] = [{ id: "alice", roleId: "user", tenantId: "tenant-a" }];

const ENDPOINTS: readonly Endpoint[] = [
  { id: "me", method: "GET", path: "/v1/me" },
  { id: "admin.accounts", method: "GET", path: "/v1/admin/accounts" },
  { id: "items.write", method: "POST", path: "/v1/items" },
];

function seen(
  endpointId: string,
  status: number,
  outcome: "allowed" | "denied" | "error",
): AccessObservation {
  return { accountId: "alice", endpointId, status, headers: {}, outcome, durationMs: 1 };
}

const AS_DECLARED: readonly AccessObservation[] = [
  seen("me", 200, "allowed"),
  seen("admin.accounts", 403, "denied"),
];

const HEALTHY_CANARY = [{ accountId: "alice", endpointId: "me", status: 200, authenticated: true }];

/** The run the CLI makes: the matrix over what was probed, the report over all of it. */
function reportOf(
  observations: readonly AccessObservation[],
  extra: Partial<BuildReportOptions> = {},
): RunReport {
  const skippedIds = new Set((extra.skipped ?? []).map((one) => one.endpointId));
  const probed = ENDPOINTS.filter((endpoint) => !skippedIds.has(endpoint.id));
  const matrix = buildAccessMatrix({ endpoints: probed, accounts: ACCOUNTS, observations });
  const policy = expandPolicy(
    { fallback: "denied", rules: [{ roles: ["user"], endpoints: ["me"], outcome: "allowed" }] },
    ENDPOINTS,
  );
  const walked = describeMatrix(matrix, policy);
  return buildReport({
    version: "test",
    config: CONFIG,
    accounts: ACCOUNTS,
    endpoints: ENDPOINTS,
    probed,
    observations,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 1,
    canaries: HEALTHY_CANARY,
    truncated: false,
    findings: walked.diffs,
    cells: walked.cells,
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1),
    ...extra,
  });
}

/**
 * A run that computed no cell verdicts, and one registered check that did run.
 *
 * The check is what keeps the case honest: without it the list would be empty
 * for want of anything at all, and the assertion would pass over a report that
 * had simply lost the field.
 */
function withoutVerdicts(): RunReport {
  const policy = expandPolicy({ fallback: "denied", rules: [] }, ENDPOINTS);
  const check = createIdenticalResponseCheck();
  return buildReport({
    version: "test",
    config: CONFIG,
    accounts: ACCOUNTS,
    endpoints: ENDPOINTS,
    probed: ENDPOINTS,
    observations: AS_DECLARED,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 1,
    canaries: HEALTHY_CANARY,
    truncated: false,
    findings: [],
    checksRun: [{ id: check.id, description: check.description, standards: check.standards }],
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1),
  });
}

function rowFor(report: RunReport, standard: string, clause: string): ClauseCoverage | undefined {
  return report.coverage.clauses.find((row) => row.standard === standard && row.clause === clause);
}

/** Every discrepancy is a declaration and a platform disagreeing — every cell cites it. */
function everyCell(report: RunReport): ClauseCoverage | undefined {
  return rowFor(report, ASVS_DOCUMENTED_RULES.standard, ASVS_DOCUMENTED_RULES.clause);
}

describe("the clauses the matrix channel exercised", () => {
  it("are in the report at all", () => {
    const report = reportOf(AS_DECLARED, {
      skipped: [{ endpointId: "items.write", reason: "unsafe-method" }],
    });

    expect(report.coverage.clauses.length).toBeGreaterThan(0);
    expect(
      rowFor(report, ASVS_FUNCTION_LEVEL_ACCESS.standard, ASVS_FUNCTION_LEVEL_ACCESS.clause),
    ).toBeDefined();
  });

  /**
   * The identity that makes the number checkable rather than asserted: every
   * cell cites 8.1.1, so what it upheld is what the report already counted as
   * "tested and agreed".
   */
  it("reconcile with the cell counters beside them", () => {
    const report = reportOf(AS_DECLARED, {
      skipped: [{ endpointId: "items.write", reason: "unsafe-method" }],
    });
    const cells = everyCell(report)?.matrixCells;

    expect(cells?.upheld).toBe(report.coverage.cellsMatched);
    expect((cells?.upheld ?? 0) + (cells?.breached ?? 0)).toBe(cells?.conclusive);
  });

  /**
   * A run whose verdicts were never computed says nothing about a clause. The
   * key is absent rather than zero, exactly as `cellsMatched` is: a zero would
   * be a claim about the platform where what has to be said is "we did not
   * count this".
   */
  it("carry no cell numbers when the run computed no verdicts", () => {
    const report = withoutVerdicts();

    expect(report.coverage.clauses.length).toBeGreaterThan(0);
    for (const row of report.coverage.clauses) {
      expect(row.matrixCells).toBeUndefined();
    }
  });
});

describe("what stops a clause from being reported as exercised", () => {
  it("a request that failed", () => {
    const report = reportOf([seen("me", 0, "error"), seen("admin.accounts", 403, "denied")]);
    const cells = everyCell(report)?.matrixCells;

    expect(cells?.inconclusive["probe-error"]).toBe(1);
    expect(cells?.conclusive).toBe(1);
  });

  it("a cell the run never reached", () => {
    const report = reportOf([seen("me", 200, "allowed")]);
    const cells = everyCell(report)?.matrixCells;

    expect(cells?.inconclusive["not-observed"]).toBeGreaterThan(0);
    // And it stays out of the number that says the clause was exercised.
    // Asserting only that the cell landed under a reason leaves the inflation
    // this row exists to prevent free to happen beside it — a cell counted as
    // both inconclusive and upheld satisfies the line above. Found by the
    // mutation that did exactly that.
    expect(cells?.conclusive).toBe(report.coverage.cellsObserved);
    expect(cells?.upheld).toBe(report.coverage.cellsMatched);
  });

  /**
   * The one the audit of 21 August found on the report as a whole (B-4), asked
   * of a clause: the object half of the surface is what a skipped template takes
   * away, and no clause row may read as covering it.
   */
  it("an endpoint that was never probed", () => {
    const report = reportOf(AS_DECLARED, {
      skipped: [{ endpointId: "items.write", reason: "unsafe-method" }],
    });

    expect(everyCell(report)?.reservations).toContain("endpoints-not-probed");
  });

  /**
   * A platform that answers 200 with the outcome in the body reads as "allowed"
   * everywhere, and `denied: 0` with observations present is the signature.
   * Whatever the cells say, they may be describing a platform whose refusals
   * this tool cannot see. See `docs/report.md` and L-3.
   */
  it("a platform whose refusals the tool cannot recognise", () => {
    const report = reportOf([seen("me", 200, "allowed"), seen("admin.accounts", 200, "allowed")]);

    expect(everyCell(report)?.reservations).toContain("no-refusal-observed");
  });

  it("credentials nothing confirmed", () => {
    const report = reportOf(AS_DECLARED, {
      canariesChecked: 0,
      canaries: [],
      skipped: [{ endpointId: "items.write", reason: "unsafe-method" }],
    });

    expect(everyCell(report)?.reservations).toContain("authentication-unproved");
  });

  it("credentials that went stale halfway", () => {
    const report = reportOf(AS_DECLARED, { staleCredentials: ["alice"] });

    expect(everyCell(report)?.reservations).toContain("authentication-unproved");
  });

  it("a second confirmation the run never made", () => {
    const report = reportOf(AS_DECLARED, { unverifiedAfterWalk: ["alice"] });

    expect(everyCell(report)?.reservations).toContain("authentication-unproved");
  });

  it("a walk that was cut short", () => {
    const report = reportOf(AS_DECLARED, { truncated: true });

    expect(everyCell(report)?.reservations).toContain("run-truncated");
  });

  /**
   * And a run with none of the five says so by carrying an empty list rather
   * than by omitting the field: a reader must not have to tell "no reservation"
   * from "this build does not compute them".
   */
  it("nothing, on a run that reached everything it was given", () => {
    const report = reportOf([...AS_DECLARED, seen("items.write", 403, "denied")], {
      unsafeMethods: true,
    });

    expect(everyCell(report)?.reservations).toEqual([]);
  });
});

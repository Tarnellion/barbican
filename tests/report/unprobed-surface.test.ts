/**
 * An endpoint nothing was sent to leaves a reservation behind.
 *
 * The audit of 21 August 2026 (B-4) ran eleven endpoints, nine of them templated
 * with no `resources` declared for their parameters. The run probed two. The
 * report said `endpointsProbed: 2`, `notProbed: {"path-parameters": 9}` — and
 * `warnings: []`, `summary.findings: 0`, exit code `0`, with the screen printing
 * "No privilege escalation found" in green over four fifths of the surface that
 * had never been asked a question.
 *
 * `warningsFor` did not read `coverage` at all. Every other counter it consults
 * answers "was anything found"; none of them answers "was anything looked at",
 * and `coverage` is the field that exists to. The report's own comment on
 * `Coverage` had said as much since it was written: "the absence of a finding on
 * what was not tested reads as 'clean'".
 *
 * What is lost is not an arbitrary slice. A templated path is the object half of
 * the surface — `/v1/items/{itemId}` — which is where BOLA and IDOR live, and it
 * is the half that disappears on the single most common mistake an operator
 * makes: declaring no `resources`, or declaring one whose `params` key is
 * misspelled. The run then tests the collection endpoints, agrees with the
 * policy about them, and reports a clean matrix.
 */

import { describe, expect, it } from "vitest";
import type { AccessObservation, Account, Endpoint } from "../../src/core/index.js";
import { buildAccessMatrix, diffAccess, expandPolicy } from "../../src/core/index.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { RunReport } from "../../src/report/build.js";
import { buildReport, exitCodeFor, WARNINGS } from "../../src/report/build.js";
import type { SkippedEndpoint } from "../../src/runner.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
accounts: [{ id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }]
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
`);

const ACCOUNTS: readonly Account[] = [{ id: "alice", roleId: "user", tenantId: "tenant-a" }];

/**
 * A collection, a refusal, and one endpoint that takes an object identifier.
 *
 * The third is the point: with no resource declaring a value for `{itemId}` it
 * is skipped, and it is the only endpoint on this list where an object could be
 * asked for out of turn.
 */
const ENDPOINTS: readonly Endpoint[] = [
  { id: "me", method: "GET", path: "/v1/me" },
  { id: "admin.accounts", method: "GET", path: "/v1/admin/accounts" },
  { id: "items.get", method: "GET", path: "/v1/items/{itemId}" },
];

function seen(
  endpointId: string,
  status: number,
  outcome: "allowed" | "denied",
): AccessObservation {
  return { accountId: "alice", endpointId, status, headers: {}, outcome, durationMs: 1 };
}

/**
 * The walk exactly as the policy declared it — over what was walked.
 *
 * `admin.accounts` refusing is not decoration: without one refusal anywhere the
 * run earns `nothingRefused` instead, and the case under test is the one where
 * the report has nothing at all to say.
 */
const AS_DECLARED: readonly AccessObservation[] = [
  seen("me", 200, "allowed"),
  seen("admin.accounts", 403, "denied"),
];

function reportOf(options: {
  readonly observations: readonly AccessObservation[];
  readonly skipped: readonly SkippedEndpoint[];
}): RunReport {
  // The matrix over what was probed and the report over the whole list, which is
  // the arrangement `src/cli.ts` uses and the reason this defect is invisible in
  // the counters: a skipped endpoint is a gap in coverage rather than a
  // discrepancy per account, so it contributes no finding to be noticed.
  const skippedIds = new Set(options.skipped.map((one) => one.endpointId));
  const probed = ENDPOINTS.filter((endpoint) => !skippedIds.has(endpoint.id));
  const matrix = buildAccessMatrix({
    endpoints: probed,
    accounts: ACCOUNTS,
    observations: options.observations,
  });
  const policy = expandPolicy(
    { fallback: "denied", rules: [{ roles: ["user"], endpoints: ["me"], outcome: "allowed" }] },
    ENDPOINTS,
  );
  return buildReport({
    version: "test",
    config: CONFIG,
    endpoints: ENDPOINTS,
    probed,
    observations: options.observations,
    skipped: options.skipped,
    failures: [],
    unauthenticated: [],
    canariesChecked: 1,
    canaries: [{ accountId: "alice", endpointId: "me", status: 200, authenticated: true }],
    truncated: false,
    findings: diffAccess(matrix, policy),
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1),
  });
}

/** The B-4 run: the object half of the surface skipped, everything else agreeing. */
const partial = (): RunReport =>
  reportOf({
    observations: AS_DECLARED,
    skipped: [{ endpointId: "items.get", reason: "path-parameters" }],
  });

describe("a run that did not reach every endpoint", () => {
  /**
   * The fixture is the audit's run in miniature, and this is what made it
   * dangerous: by every number the report prints, it passed.
   */
  it("is otherwise indistinguishable from a clean one", () => {
    const report = partial();

    expect(report.summary.findings).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
    expect(report.coverage.endpointsProbed).toBeLessThan(report.coverage.endpointsTotal);
    expect(report.coverage.notProbed).toEqual({ "path-parameters": 1 });
  });

  it("says so in the warnings", () => {
    expect(partial().warnings).toContain(WARNINGS.endpointsNotProbed);
  });

  /**
   * And says it about the endpoints rather than about the resources.
   *
   * `resourcesNotFound` is the neighbouring reservation and a different fact: it
   * covers objects that were asked for and were not there. An endpoint no
   * request went to leaves nothing in that list, which is why the green headline
   * cleared this run after that reservation had already been added.
   */
  it("is not covered by the reservation about resources", () => {
    expect(partial().coverage.resourcesNotFound).toEqual([]);
  });
});

describe("a run that reached every endpoint", () => {
  const whole = (): RunReport =>
    reportOf({
      observations: [...AS_DECLARED, seen("items.get", 403, "denied")],
      skipped: [],
    });

  /**
   * The other half of the guard. A warning that fires on every run is not a
   * warning — it is a footer, and a reader learns to skip it. This run walked the
   * whole list, so the reservation must not be there.
   */
  it("carries no reservation about coverage", () => {
    const report = whole();

    expect(report.coverage.endpointsProbed).toBe(report.coverage.endpointsTotal);
    expect(report.warnings).not.toContain(WARNINGS.endpointsNotProbed);
  });

  /** And earns a clean file, so the assertion above is not passing on an error. */
  it("is clean", () => {
    expect(whole().warnings).toEqual([]);
    expect(exitCodeFor(whole())).toBe(0);
  });
});

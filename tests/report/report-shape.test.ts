/**
 * The shape of the report is a gate, not a paragraph in `docs/report.md`.
 *
 * `RunReport.schemaVersion` is `"2"`, and until this file there was no
 * machine-readable description of the shape that number names anywhere in the
 * repository. `schema/` holds the schema of the **configuration**; the report is
 * described in prose in `docs/report.md` and in the types shipped as
 * `dist/*.d.ts`, and neither of those fails a build.
 *
 * The only assertion about the version was a tautology:
 *
 *     expect(build().schemaVersion).toBe(REPORT_SCHEMA_VERSION)
 *
 * It compares the file against the constant that wrote it, so it agrees with
 * every possible report. Rename the field to `version` and the constant is
 * untouched, so the line still passes while every parser in the world breaks;
 * drop `coverage.cellsMatched`, change `verdict.code` from a number to a string,
 * split `summary.byKind` in two — the line passes through all of it, and the
 * report still announces itself as schema `2`. Schema 3 is coming with Module 2,
 * and at the changeover there would have been neither a way to tell a reader
 * what changed nor a test that noticed.
 *
 * So the gate is on the **shape**, not on the values. A skeleton — every key
 * path in the finished artifact and the JSON type at it, with the values thrown
 * away — is taken from a report `buildReport` actually produced and compared
 * against `report-shape.json`, committed beside this file. The fixture also
 * records which schema version it describes, and that is what makes the version
 * checkable rather than self-evident: the report has to say what an outside
 * record says it says.
 *
 * The two exits are the whole point. A change that only **adds** paths is
 * additive: a reader written against `"2"` still parses the file, and the author
 * declares it so by adding those paths to the fixture and leaving its version
 * alone. A path that disappears or changes type is incompatible: the author
 * bumps `REPORT_SCHEMA_VERSION` and moves the fixture's version with it. Either
 * way the decision lands in the diff a reviewer reads, which is the part that
 * did not exist before.
 *
 * Why a skeleton and not a hand-written JSON Schema next to the types: a schema
 * written by hand is a second source of truth for the same shape, and this
 * project has twice found the defect that arrangement produces — the console and
 * the file describing one run in two drifted sentences (`WARNINGS`), and the
 * configuration parser keeping its own copy of `RESOURCE_RELATIONS`. The
 * skeleton is extracted from the artifact, so it cannot describe a report that
 * was never built. And no dependency is added for any of it: a package enters
 * this tree only after vetting, and never for a test.
 *
 * Two things to know when reading `report-shape.json`:
 *
 * - Some records are keyed by data rather than by a type — `summary.byKind` by
 *   diff kinds and check ids, `coverage.notProbed` by reasons,
 *   `coverage.contextsProbed` by declared conditions, `findings[].evidence` by
 *   whatever a check put there. Those paths reflect the scenario below, so
 *   editing the scenario moves them. That is intended: they are still the shape
 *   a consumer parses, and a diff kind renamed out from under a dashboard is
 *   exactly the kind of change this file exists to stop being silent.
 * - An array contributes the **union** over its elements, not the shape of the
 *   first one. `findings[]` carries rows from both channels and the two carry
 *   different optional fields; taking the first row would have guarded whichever
 *   of them sorted highest and nothing else.
 *
 * The scenario is written by hand, for the reason every fixture in this
 * repository is: observations, verdicts and discrepancies derived from the
 * policy would make this a test that `buildReport` agrees with itself.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CheckCoverage, CheckRun, ResolvedFinding } from "../../src/core/checks/types.js";
import type {
  AccessDiff,
  AccessObservation,
  Account,
  CellVerdict,
  Endpoint,
  ResolvedAccessPolicy,
} from "../../src/core/index.js";
import { ANY } from "../../src/core/index.js";
import { byCodeUnits } from "../../src/core/order.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { BuildReportOptions, RunReport } from "../../src/report/build.js";
import { buildReport, REPORT_SCHEMA_VERSION } from "../../src/report/build.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = "tests/report/report-shape.json";

// ---------------------------------------------------------------------------
// The skeleton: key paths and the JSON types at them, with no values kept.
// ---------------------------------------------------------------------------

/** A key path in the artifact mapped to the JSON type found there. */
type Skeleton = Readonly<Record<string, string>>;

/**
 * What the fixture file holds: the shape, and the schema version it describes.
 *
 * The version is in the file rather than derived from the constant, so that
 * `REPORT_SCHEMA_VERSION` has something outside itself to agree with.
 */
interface ShapeFixture {
  readonly schemaVersion: string;
  readonly shape: Skeleton;
}

function record(into: Map<string, Set<string>>, path: string, type: string): void {
  // The root object itself has no name and nothing to say: a report is always an
  // object, and a path of `""` would be one entry that can never change.
  if (path === "") {
    return;
  }
  const seen = into.get(path);
  if (seen === undefined) {
    into.set(path, new Set([type]));
    return;
  }
  seen.add(type);
}

/**
 * Walks a parsed artifact, recording the type at every key path.
 *
 * Containers record themselves as well as their contents: without that, a field
 * turning from an object into an array would be invisible whenever the two
 * happen to hold the same leaves, and an empty `{}` or `[]` would leave no trace
 * at all.
 */
function walk(value: unknown, path: string, into: Map<string, Set<string>>): void {
  if (Array.isArray(value)) {
    record(into, path, "array");
    for (const item of value) {
      walk(item, `${path}[]`, into);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    record(into, path, "object");
    for (const [key, child] of Object.entries(value)) {
      walk(child, path === "" ? key : `${path}.${key}`, into);
    }
    return;
  }
  record(into, path, value === null ? "null" : typeof value);
}

/**
 * The skeleton of a report.
 *
 * Through `JSON.stringify` first, because the artifact is what is being
 * described: a field set to `undefined` is a key on the object and no key in the
 * file, and the claim under test is about the file. The same reason
 * `carried-fields.test.ts` asks its question that way.
 *
 * Nothing unstable survives this: `runId`, `configDigest`, `startedAt` and
 * `finishedAt` reach the fixture as the word `string` and never as a value.
 */
function skeletonOf(report: RunReport): Skeleton {
  const types = new Map<string, Set<string>>();
  walk(JSON.parse(JSON.stringify(report)) as unknown, "", types);
  const shape: Record<string, string> = {};
  for (const path of [...types.keys()].sort(byCodeUnits)) {
    shape[path] = [...(types.get(path) ?? [])].sort(byCodeUnits).join("|");
  }
  return shape;
}

// ---------------------------------------------------------------------------
// The drift, and the sentence that tells the author what to do about it.
// ---------------------------------------------------------------------------

interface Drift {
  /** Paths in the report that the fixture does not have. */
  readonly added: readonly string[];
  /** Paths the fixture has that the report no longer produces. */
  readonly gone: readonly string[];
  /** Paths both have, at different types. */
  readonly retyped: readonly string[];
}

const NO_DRIFT: Drift = { added: [], gone: [], retyped: [] };

function driftOf(expected: Skeleton, actual: Skeleton): Drift {
  const added: string[] = [];
  const gone: string[] = [];
  const retyped: string[] = [];
  for (const path of Object.keys(actual).sort(byCodeUnits)) {
    const was = expected[path];
    const now = actual[path] ?? "";
    if (was === undefined) {
      added.push(`${path}: ${now}`);
    } else if (was !== now) {
      retyped.push(`${path}: ${was} -> ${now}`);
    }
  }
  for (const path of Object.keys(expected).sort(byCodeUnits)) {
    if (actual[path] === undefined) {
      gone.push(`${path}: ${expected[path] ?? ""}`);
    }
  }
  return { added, gone, retyped };
}

const list = (title: string, entries: readonly string[]): string =>
  entries.length === 0 ? "" : `\n${title} (${entries.length}):\n  ${entries.join("\n  ")}`;

/**
 * What the author is being asked to decide.
 *
 * Both exits are named, and which one applies is stated rather than left to be
 * worked out: the whole failure of the assertion this file replaces was that
 * nobody was ever asked the question.
 */
function explain(drift: Drift): string {
  const breaking = drift.gone.length > 0 || drift.retyped.length > 0;
  return [
    `The shape of RunReport has changed, and ${FIXTURE_PATH} still describes`,
    ` schema version "${REPORT_SCHEMA_VERSION}" as it was.`,
    list("Paths that appeared", drift.added),
    list("Paths that are gone", drift.gone),
    list("Paths whose type changed", drift.retyped),
    "\n\nTwo ways out, and the choice is yours to make and to defend in review:",
    breaking
      ? "\n\nThis change is INCOMPATIBLE — a path is gone or has changed type, so a" +
        " reader written against the current schema version breaks on the new file." +
        ` Raise REPORT_SCHEMA_VERSION in src/report/build.ts, write the same value into` +
        ` "schemaVersion" in ${FIXTURE_PATH}, describe the change in the doc comment on` +
        " the constant the way the move from 1 to 2 is described there, and bring the" +
        ` paths above into "shape".`
      : "\n\nThis change looks ADDITIVE — every path that was there is still there at" +
        " the same type, and only new ones appeared, so a reader written against the" +
        ` current schema version still parses the file. Add the paths above to "shape"` +
        ` in ${FIXTURE_PATH} and leave its "schemaVersion" alone: that edit IS the` +
        " declaration that the change is additive.",
    "\n\nIf what changed is the scenario in this file rather than the report, the" +
      " fixture still has to follow it — the skeleton describes the artifact that" +
      " scenario produces.",
  ].join("");
}

// ---------------------------------------------------------------------------
// The scenario. Written by hand, and reaching as many sections as one run can.
// ---------------------------------------------------------------------------

/**
 * A configuration that declares one of everything the report publishes.
 *
 * A named authentication scheme, a tenant tree, an account with a set of
 * memberships, an anonymous account, an exclusion, resources with a query
 * string and without an owner, conditions with headers and conditions with a
 * query parameter, and an attribute that names an environment variable instead
 * of carrying a value.
 */
const CONFIG = parseRunConfig(`
target:
  baseUrl: https://api.test
  allowedHosts: [api.test]
  label: shape fixture (not a deployment)
auth: { kind: bearer }
authSchemes:
  operator-console: { kind: cookie, name: opsid }
tenants:
  - { id: holding-1 }
  - { id: tenant-a, parent: holding-1 }
  - { id: tenant-b }
accounts:
  - { id: alice-a, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: orders.list }
  - { id: carol-b, role: user, tenant: tenant-b, tokenEnv: T_CAROL, canary: orders.list }
  - id: admin-a
    role: admin
    tenant: tenant-a
    tokenEnv: T_ADMIN
    authScheme: operator-console
    canary: orders.list
  - { id: sara-ac, role: support, tenants: [tenant-a, tenant-b], tokenEnv: T_SARA, canary: orders.list }
  - { id: anonymous, role: anonymous }
exclude: [orders.purge]
resources:
  - id: order-a-1001
    tenant: tenant-a
    owner: alice-a
    params: { orderId: "A-1001" }
    query: { view: full }
  - { id: order-b-2001, tenant: tenant-b, owner: carol-b, params: { orderId: "B-2001" } }
  - { id: order-a-9999, tenant: tenant-a, params: { orderId: "A-9999" } }
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [health], outcome: allowed }
    - { roles: [user, admin, support], endpoints: [orders.list], outcome: allowed }
    - { roles: [user], endpoints: [orders.read], scope: own, outcome: allowed }
    - { roles: [admin], endpoints: [orders.read], scope: same-tenant, outcome: allowed }
    - { roles: "*", endpoints: [orders.list], context: geo-blocked, outcome: denied }
    - { roles: [user], endpoints: [orders.list], context: wide-scope, outcome: allowed }
contexts:
  - id: geo-blocked
    description: a request from a prohibited jurisdiction
    headers: { cf-ipcountry: AQ, x-device-signature: { env: DEVICE_SIGNATURE } }
    endpoints: [orders.list]
    accounts: [alice-a]
  - id: wide-scope
    description: an internal parameter that widens the listing
    query: { scope: all }
    endpoints: [orders.list]
    accounts: [carol-b]
`);

const ENDPOINTS: readonly Endpoint[] = [
  { id: "health", method: "GET", path: "/v1/health", operationId: "getHealth" },
  {
    id: "orders.list",
    method: "GET",
    path: "/v1/orders",
    responseMustDifferByTenant: true,
    signals: [{ name: "orderCount", kind: "count", path: "orders" }],
  },
  { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
  // The four endpoints left alone, one per reason `SkippedEndpoint` admits, so
  // that `coverage.notProbed` carries every key it can.
  { id: "orders.cancel", method: "POST", path: "/v1/orders/{orderId}/cancel" },
  { id: "orders.purge", method: "DELETE", path: "/v1/orders" },
  { id: "admin.users", method: "GET", path: "/v1/admin/users/{userId}" },
  { id: "reports.export", method: "GET", path: "/v1/reports" },
];

const PROBED: readonly Endpoint[] = ENDPOINTS.slice(0, 3);

/**
 * The matrix rows: the declared accounts, plus the rows the conditions derive.
 *
 * Written out rather than taken from `toAccounts`, so the conditions above can
 * keep an attribute that names an environment variable: resolving those is the
 * run's job, and this file builds a report rather than performing a run.
 */
const ACCOUNT_ROWS: readonly Account[] = [
  { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
  { id: "carol-b", roleId: "user", tenantId: "tenant-b" },
  { id: "admin-a", roleId: "admin", tenantId: "tenant-a" },
  { id: "sara-ac", roleId: "support", tenantIds: ["tenant-a", "tenant-b"] },
  { id: "anonymous", roleId: "anonymous" },
  {
    id: "alice-a@geo-blocked",
    roleId: "user",
    tenantId: "tenant-a",
    contextId: "geo-blocked",
    baseAccountId: "alice-a",
    endpointIds: ["orders.list"],
  },
  {
    id: "carol-b@wide-scope",
    roleId: "user",
    tenantId: "tenant-b",
    contextId: "wide-scope",
    baseAccountId: "carol-b",
    endpointIds: ["orders.list"],
  },
];

/** The policy with its patterns already expanded — the one that gave the verdicts. */
const POLICY: ResolvedAccessPolicy = {
  fallback: "denied",
  rules: [
    { roles: ANY, endpoints: ["health"], outcome: "allowed" },
    { roles: ["user", "admin", "support"], endpoints: ["orders.list"], outcome: "allowed" },
    { roles: ["user"], endpoints: ["orders.read"], scope: "own", outcome: "allowed" },
    { roles: ["admin"], endpoints: ["orders.read"], scope: "same-tenant", outcome: "allowed" },
    { roles: ANY, endpoints: ["orders.list"], context: "geo-blocked", outcome: "denied" },
    { roles: ["user"], endpoints: ["orders.list"], context: "wide-scope", outcome: "allowed" },
  ],
};

const at = (minute: number): string => `2026-08-21T09:${String(minute).padStart(2, "0")}:00.000Z`;

const OBSERVATIONS: readonly AccessObservation[] = [
  {
    accountId: "alice-a",
    endpointId: "health",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 11,
    at: at(1),
    method: "GET",
    url: "https://api.test/v1/health",
  },
  {
    accountId: "anonymous",
    endpointId: "health",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 9,
    at: at(2),
    method: "GET",
    url: "https://api.test/v1/health",
  },
  {
    accountId: "alice-a",
    endpointId: "orders.list",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 24,
    at: at(3),
    method: "GET",
    url: "https://api.test/v1/orders",
    // Scalars over the body, which is stored nowhere — ADR-0011.
    signals: { orderCount: 3, bodyDigestPresent: true },
  },
  {
    accountId: "carol-b",
    endpointId: "orders.list",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 22,
    at: at(4),
    method: "GET",
    url: "https://api.test/v1/orders",
    signals: { orderCount: 3, bodyDigestPresent: true },
  },
  {
    accountId: "admin-a",
    endpointId: "orders.list",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 19,
    at: at(5),
    method: "GET",
    url: "https://api.test/v1/orders",
  },
  {
    accountId: "anonymous",
    endpointId: "orders.list",
    status: 401,
    outcome: "denied",
    // The header that tells "the endpoint is closed" from "we knocked with the
    // wrong transport". See `ReportFinding.headers`.
    headers: { "www-authenticate": "Bearer" },
    durationMs: 8,
    at: at(6),
    method: "GET",
    url: "https://api.test/v1/orders",
  },
  {
    accountId: "alice-a@geo-blocked",
    endpointId: "orders.list",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 25,
    at: at(7),
    method: "GET",
    url: "https://api.test/v1/orders",
  },
  {
    accountId: "carol-b@wide-scope",
    endpointId: "orders.list",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 26,
    at: at(8),
    method: "GET",
    url: "https://api.test/v1/orders?scope=all",
  },
  {
    accountId: "alice-a",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 14,
    at: at(9),
    method: "GET",
    url: "https://api.test/v1/orders/A-1001?view=full",
  },
  {
    accountId: "alice-a",
    endpointId: "orders.read",
    resourceId: "order-b-2001",
    status: 200,
    outcome: "allowed",
    headers: { "content-type": "application/json" },
    durationMs: 15,
    at: at(10),
    method: "GET",
    url: "https://api.test/v1/orders/B-2001",
  },
  {
    accountId: "carol-b",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    status: 403,
    outcome: "denied",
    headers: { "content-type": "application/problem+json" },
    durationMs: 12,
    at: at(11),
    method: "GET",
    url: "https://api.test/v1/orders/A-1001?view=full",
  },
  {
    accountId: "admin-a",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    status: 403,
    outcome: "denied",
    headers: { "content-type": "application/problem+json" },
    durationMs: 13,
    at: at(12),
    method: "GET",
    url: "https://api.test/v1/orders/A-1001?view=full",
  },
  {
    accountId: "sara-ac",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    status: 0,
    outcome: "error",
    durationMs: 5000,
    at: at(13),
    method: "GET",
    url: "https://api.test/v1/orders/A-1001?view=full",
  },
  // Both accounts that asked were answered 404, which is what puts the resource
  // into `coverage.resourcesNotFound`.
  {
    accountId: "alice-a",
    endpointId: "orders.read",
    resourceId: "order-a-9999",
    status: 404,
    outcome: "not-found",
    headers: { "content-type": "application/problem+json" },
    durationMs: 10,
    at: at(14),
    method: "GET",
    url: "https://api.test/v1/orders/A-9999",
  },
  {
    accountId: "carol-b",
    endpointId: "orders.read",
    resourceId: "order-a-9999",
    status: 404,
    outcome: "not-found",
    headers: { "content-type": "application/problem+json" },
    durationMs: 10,
    at: at(15),
    method: "GET",
    url: "https://api.test/v1/orders/A-9999",
  },
];

/** A verdict for every observed cell, so `cellsMatched` and its twin are computed. */
const CELLS: readonly CellVerdict[] = [
  {
    accountId: "alice-a",
    endpointId: "health",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 0,
    actual: "allowed",
    match: true,
  },
  {
    accountId: "anonymous",
    endpointId: "health",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 0,
    actual: "allowed",
    match: true,
  },
  {
    accountId: "alice-a",
    endpointId: "orders.list",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 1,
    actual: "allowed",
    match: true,
  },
  {
    accountId: "carol-b",
    endpointId: "orders.list",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 1,
    actual: "allowed",
    match: true,
  },
  {
    accountId: "admin-a",
    endpointId: "orders.list",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 1,
    actual: "allowed",
    match: true,
  },
  {
    accountId: "anonymous",
    endpointId: "orders.list",
    expected: "denied",
    basis: "fallback",
    actual: "denied",
    match: true,
  },
  {
    accountId: "alice-a@geo-blocked",
    endpointId: "orders.list",
    contextId: "geo-blocked",
    expected: "denied",
    basis: "rule",
    ruleIndex: 4,
    actual: "allowed",
    match: false,
  },
  {
    accountId: "carol-b@wide-scope",
    endpointId: "orders.list",
    contextId: "wide-scope",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 5,
    actual: "allowed",
    match: true,
  },
  {
    accountId: "alice-a",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    relation: "own",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 2,
    actual: "allowed",
    match: true,
  },
  {
    accountId: "alice-a",
    endpointId: "orders.read",
    resourceId: "order-b-2001",
    relation: "foreign-tenant",
    expected: "denied",
    basis: "fallback",
    actual: "allowed",
    match: false,
  },
  {
    accountId: "carol-b",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    relation: "foreign-tenant",
    expected: "denied",
    basis: "fallback",
    actual: "denied",
    match: true,
  },
  {
    accountId: "admin-a",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    relation: "same-tenant",
    expected: "allowed",
    basis: "rule",
    ruleIndex: 3,
    actual: "denied",
    match: false,
  },
  {
    accountId: "sara-ac",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    relation: "same-tenant",
    expected: "denied",
    basis: "fallback",
    actual: "error",
    match: false,
  },
  {
    accountId: "alice-a",
    endpointId: "orders.read",
    resourceId: "order-a-9999",
    relation: "same-tenant",
    expected: "denied",
    basis: "fallback",
    actual: "not-found",
    match: true,
  },
  {
    accountId: "carol-b",
    endpointId: "orders.read",
    resourceId: "order-a-9999",
    relation: "foreign-tenant",
    expected: "denied",
    basis: "fallback",
    actual: "not-found",
    match: true,
  },
];

/** One discrepancy of every kind the matrix channel produces. */
const DIFFS: readonly AccessDiff[] = [
  {
    accountId: "alice-a@geo-blocked",
    endpointId: "orders.list",
    contextId: "geo-blocked",
    expected: "denied",
    actual: "allowed",
    kind: "privilege-escalation",
    basis: "rule",
    ruleIndex: 4,
    severity: "high",
  },
  {
    accountId: "alice-a",
    endpointId: "orders.read",
    resourceId: "order-b-2001",
    relation: "foreign-tenant",
    expected: "denied",
    actual: "allowed",
    kind: "privilege-escalation",
    basis: "fallback",
    severity: "critical",
  },
  {
    accountId: "admin-a",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    relation: "same-tenant",
    expected: "allowed",
    actual: "denied",
    kind: "unexpected-denial",
    basis: "rule",
    ruleIndex: 3,
    severity: "medium",
  },
  {
    accountId: "sara-ac",
    endpointId: "orders.read",
    resourceId: "order-a-1001",
    relation: "same-tenant",
    expected: "denied",
    actual: "error",
    kind: "probe-error",
    basis: "fallback",
    severity: "low",
  },
  // No `actual`: nothing was observed, which is the whole of what this kind says.
  {
    accountId: "admin-a",
    endpointId: "orders.read",
    resourceId: "order-b-2001",
    relation: "foreign-tenant",
    expected: "denied",
    kind: "not-observed",
    basis: "fallback",
    severity: "low",
  },
];

/**
 * The other channel: findings from registered checks.
 *
 * Three, because three shapes of check finding reach the file — a paired one
 * with a counterpart account, one made under declared conditions, and one that
 * names no cell at all, which is the shape Module 2's evidence pack needs and
 * which the report used to discard.
 */
const CHECK_FINDINGS: readonly ResolvedFinding[] = [
  {
    checkId: "identical-response-across-tenants",
    severity: "critical",
    title: "Two tenants were served identical response bodies",
    endpointId: "orders.list",
    accountId: "alice-a",
    relatedAccountId: "carol-b",
    evidence: { otherAccountId: "carol-b", digestMatched: true, comparedPairs: 1 },
  },
  {
    checkId: "identical-response-across-tenants",
    severity: "high",
    title: "The widened listing was identical across tenants",
    endpointId: "orders.list",
    accountId: "carol-b@wide-scope",
    contextId: "wide-scope",
    relatedAccountId: "alice-a",
    evidence: { otherAccountId: "alice-a", digestMatched: true, comparedPairs: 1 },
  },
  {
    checkId: "clause-coverage",
    severity: "info",
    title: "No check on this run answers for the clause",
    evidence: { standard: "OWASP-API-2023", clause: "API5" },
  },
];

const CHECKS_RUN: readonly CheckRun[] = [
  {
    id: "identical-response-across-tenants",
    description:
      "Compares irreversible scalars of the responses two tenants received on one endpoint.",
    standards: [
      { standard: "OWASP-API-2023", clause: "API1" },
      { standard: "ASVS-5.0", clause: "8.4.1" },
    ],
  },
  {
    id: "clause-coverage",
    description: "States which declared clauses no check on this run answers for.",
    standards: [{ standard: "OWASP-API-2023", clause: "API5" }],
  },
];

const BY_CHECK: readonly CheckCoverage[] = [
  {
    checkId: "identical-response-across-tenants",
    endpointId: "orders.list",
    counters: { comparedPairs: 3, skippedAsRelated: 1 },
  },
  { checkId: "clause-coverage", counters: { clausesDeclared: 3, clausesCovered: 2 } },
];

const OPTIONS: BuildReportOptions = {
  version: "0.0.0-shape-fixture",
  config: CONFIG,
  accounts: ACCOUNT_ROWS,
  endpoints: ENDPOINTS,
  probed: PROBED,
  observations: OBSERVATIONS,
  cells: CELLS,
  skipped: [
    { endpointId: "orders.cancel", reason: "unsafe-method" },
    { endpointId: "orders.purge", reason: "excluded" },
    { endpointId: "admin.users", reason: "path-parameters" },
    { endpointId: "reports.export", reason: "escapes-target" },
  ],
  failures: [
    {
      accountId: "sara-ac",
      endpointId: "orders.read",
      resourceId: "order-a-1001",
      reason: "ECONNRESET",
    },
  ],
  unauthenticated: ["anonymous"],
  canariesChecked: 3,
  canaries: [
    { accountId: "alice-a", endpointId: "orders.list", status: 200, authenticated: true },
    { accountId: "carol-b", endpointId: "orders.list", status: 200, authenticated: true },
    // A canary with no status at all: the transport failed, and the code says
    // which way rather than leaving `status: 0` to be guessed at.
    {
      accountId: "admin-a",
      endpointId: "orders.list",
      status: 0,
      authenticated: false,
      failure: "ECONNREFUSED",
    },
  ],
  staleCredentials: ["carol-b"],
  unverifiedAfterWalk: ["alice-a"],
  truncated: false,
  unsafeMethods: false,
  findings: DIFFS,
  checks: CHECK_FINDINGS,
  checksRun: CHECKS_RUN,
  byCheck: BY_CHECK,
  policy: POLICY,
  throttle: { concurrency: 2, requestsPerSecond: 5, maxRequests: 2000 },
  startedAt: new Date("2026-08-21T09:00:00.000Z"),
  finishedAt: new Date("2026-08-21T09:16:00.000Z"),
};

const FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, "report-shape.json"), "utf8"),
) as ShapeFixture;

describe("the shape of the report", () => {
  const skeleton = skeletonOf(buildReport(OPTIONS));

  /**
   * A guard that describes six fields agrees with almost any report. The
   * scenario above is written to reach findings from both channels, defects,
   * coverage, canaries, conditions and warnings at once, and this is what says
   * so — the number is a floor with room under it, not a count to keep level.
   */
  it("is described by a fixture that covers the report rather than a corner of it", () => {
    expect(Object.keys(FIXTURE.shape).length).toBeGreaterThan(150);
  });

  /**
   * The section this whole file exists for. Everything the scenario produces is
   * compared against the committed skeleton, and any difference asks the author
   * which of the two changes it is.
   */
  it("has not drifted from the fixture without the version being decided", () => {
    const drift = driftOf(FIXTURE.shape, skeleton);

    expect(drift, explain(drift)).toEqual(NO_DRIFT);
  });

  /**
   * The field, by the name a parser looks it up under.
   *
   * `expect(build().schemaVersion).toBe(REPORT_SCHEMA_VERSION)` survived the
   * field being renamed, because it read the field through the same name the
   * assertion was written with. Here the name comes from a file that does not
   * move when the code does.
   */
  it("carries the version under the key a reader looks for it at", () => {
    expect(skeleton.schemaVersion).toBe("string");
  });

  /**
   * And says the version the fixture says it says.
   *
   * Not a tautology: the fixture is an outside record of which shape carries
   * which number, so raising `REPORT_SCHEMA_VERSION` on its own fails here, and
   * raising the fixture's on its own fails here too. The pair moves together or
   * not at all.
   */
  it("announces the version the committed shape belongs to", () => {
    expect(buildReport(OPTIONS).schemaVersion).toBe(FIXTURE.schemaVersion);
    expect(REPORT_SCHEMA_VERSION).toBe(FIXTURE.schemaVersion);
  });
});

describe("the skeleton the gate compares", () => {
  /**
   * Values are never in it — least of all the ones that differ on every run.
   *
   * `runId`, `configDigest` and the two timestamps would otherwise make the
   * fixture fail on the second run and teach whoever hits it to distrust the
   * gate. They are in the skeleton by type and by nothing else.
   */
  it("keeps the unstable fields by type and never by value", () => {
    const report = buildReport(OPTIONS);
    const serialized = JSON.stringify(skeletonOf(report));

    expect(skeletonOf(report)).toMatchObject({
      runId: "string",
      configDigest: "string",
      startedAt: "string",
      finishedAt: "string",
    });
    for (const value of [report.runId, report.configDigest, report.startedAt, report.finishedAt]) {
      expect(serialized).not.toContain(value);
    }
  });

  /** Two runs of one scenario give one skeleton, or the gate is noise. */
  it("is the same for two reports built from the same scenario", () => {
    expect(skeletonOf(buildReport(OPTIONS))).toEqual(skeletonOf(buildReport(OPTIONS)));
  });

  /**
   * The three ways a shape can change, each of them seen.
   *
   * A gate is only worth the failures it produces, and these are the failures:
   * a renamed field reads as one path gone and another arrived, a retyped field
   * as neither, and a new field as an addition on its own. Asked of the
   * comparison rather than of a mutated `buildReport`, because the mutations
   * that prove the whole thing belong in a commit that is reverted, not in this
   * file.
   */
  it("tells an addition, a removal and a change of type apart", () => {
    const before: Skeleton = { "a.b": "string", "a.c": "number" };
    const renamed = driftOf(before, { "a.d": "string", "a.c": "number" });
    const retyped = driftOf(before, { "a.b": "string", "a.c": "string" });
    const added = driftOf(before, { "a.b": "string", "a.c": "number", "a.e": "boolean" });

    expect(renamed).toEqual({ added: ["a.d: string"], gone: ["a.b: string"], retyped: [] });
    expect(retyped).toEqual({ added: [], gone: [], retyped: ["a.c: number -> string"] });
    expect(added).toEqual({ added: ["a.e: boolean"], gone: [], retyped: [] });
  });

  /**
   * And says which of the two exits applies, in those words.
   *
   * The sentence is the deliverable here: the assertion this file replaces
   * failed not by being wrong but by never asking anybody anything.
   */
  it("names the additive exit for an addition and the version bump for a removal", () => {
    const additive = explain(driftOf({ "a.b": "string" }, { "a.b": "string", "a.c": "number" }));
    const breaking = explain(driftOf({ "a.b": "string" }, {}));

    expect(additive).toContain("ADDITIVE");
    expect(additive).toContain("a.c: number");
    expect(additive).not.toContain("INCOMPATIBLE");
    expect(breaking).toContain("INCOMPATIBLE");
    expect(breaking).toContain("REPORT_SCHEMA_VERSION");
    expect(breaking).toContain("a.b: string");
  });

  /**
   * An array is read as the union of its rows.
   *
   * `findings[]` holds rows from both channels, and they carry different
   * optional fields: taking the first row would have described whichever of
   * them sorted highest and left the other unguarded.
   */
  it("unions the rows of an array rather than describing the first one", () => {
    const types = new Map<string, Set<string>>();
    walk({ rows: [{ a: 1 }, { b: "x" }, { a: true }] }, "", types);

    expect([...(types.get("rows[].a") ?? [])].sort(byCodeUnits)).toEqual(["boolean", "number"]);
    expect([...(types.get("rows[].b") ?? [])]).toEqual(["string"]);
  });
});

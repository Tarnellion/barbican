/**
 * The screen a finished run leaves behind.
 *
 * Every defect this module's own comments recount is the same defect — a fact
 * that reached the report and never reached the screen — and the module was
 * outside the coverage gate until ADR-0063 while carrying them all: the headline
 * that cleared a run which had proved nothing, the severity table that left
 * `info` unnamed, `findingsCapped` printed nowhere, and the whole truncation
 * block, whose fifteen statements no test in this process had ever run. That
 * block is the one that tells an operator their walk can be continued instead of
 * paid for twice.
 *
 * The report is built by `buildReport` rather than written by hand: the screen's
 * claim is that it says what the file says, and a hand-made report would let the
 * two agree about a document neither of them produces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runIdentity } from "../../src/adapters/http.js";
import { paint, writeRunSummary } from "../../src/cli/screen.js";
import type { AccessObservation, Account, Endpoint } from "../../src/core/index.js";
import { buildAccessMatrix, diffAccess, expandPolicy } from "../../src/core/index.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { AuthenticitySuspicion } from "../../src/report/authenticity.js";
import type { RunReport } from "../../src/report/build.js";
import { buildReport, runVerdict, WARNINGS } from "../../src/report/build.js";
import type { SkippedEndpoint } from "../../src/runner.js";

let said: string[];

beforeEach(() => {
  said = [];
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    said.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
accounts:
  - { id: alice-a, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }
  - { id: carol-b, role: user, tenant: tenant-b, tokenEnv: T_CAROL, canary: me }
resources:
  - { id: order-a-1, tenant: tenant-a, owner: alice-a, params: { orderId: "A-1" } }
contexts:
  - id: geo-blocked
    description: a request from a prohibited jurisdiction
    headers: { cf-ipcountry: AQ }
    endpoints: [me]
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
    - { roles: [user], endpoints: [me], context: geo-blocked, outcome: allowed }
    - { roles: [user], endpoints: [orders.read], scope: own, outcome: allowed }
`);

/**
 * The same declaration with nothing said about `orders.read`.
 *
 * Used where the case is a resource that answered 404 to everybody: under the
 * declaration above alice owns the order and is meant to read it, so a 404 there
 * is a discrepancy and the headline takes the branch about findings instead of
 * the one about a reservation.
 */
const CLOSED = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
accounts:
  - { id: alice-a, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }
  - { id: carol-b, role: user, tenant: tenant-b, tokenEnv: T_CAROL, canary: me }
resources:
  - { id: order-a-1, tenant: tenant-a, owner: alice-a, params: { orderId: "A-1" } }
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
`);

const ACCOUNTS: readonly Account[] = [
  { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
  { id: "carol-b", roleId: "user", tenantId: "tenant-b" },
];

const ENDPOINTS: readonly Endpoint[] = [
  { id: "me", method: "GET", path: "/v1/me" },
  { id: "admin.accounts", method: "GET", path: "/v1/admin/accounts" },
  { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
];

const IDENTITY = runIdentity({
  version: "9.9.9",
  runId: "8b1f0a4e-0000-4000-8000-000000000000",
  homepage: "https://example.test/barbican",
});

function seen(
  accountId: string,
  endpointId: string,
  status: number,
  outcome: AccessObservation["outcome"],
  resourceId?: string,
): AccessObservation {
  return {
    accountId,
    endpointId,
    ...(resourceId === undefined ? {} : { resourceId }),
    status,
    headers: {},
    outcome,
    durationMs: 1,
  };
}

/** The walk exactly as the policy declared it, over everything the list holds. */
const AS_DECLARED: readonly AccessObservation[] = [
  seen("alice-a", "me", 200, "allowed"),
  seen("carol-b", "me", 200, "allowed"),
  seen("alice-a", "admin.accounts", 403, "denied"),
  seen("carol-b", "admin.accounts", 403, "denied"),
  seen("alice-a", "orders.read", 200, "allowed", "order-a-1"),
  seen("carol-b", "orders.read", 403, "denied", "order-a-1"),
];

/** The same walk with tenant B reading tenant A's order: one escalation. */
const WITH_A_LEAK: readonly AccessObservation[] = [
  ...AS_DECLARED.slice(0, 5),
  seen("carol-b", "orders.read", 200, "allowed", "order-a-1"),
];

const CANARIES = [
  { accountId: "alice-a", endpointId: "me", status: 200, authenticated: true },
  { accountId: "carol-b", endpointId: "me", status: 200, authenticated: true },
] as const;

function reportOf(
  over: {
    readonly observations?: readonly AccessObservation[];
    readonly skipped?: readonly SkippedEndpoint[];
    readonly failures?: readonly { readonly endpointId: string; readonly reason: string }[];
    readonly truncated?: boolean;
    readonly canaries?: readonly {
      readonly accountId: string;
      readonly endpointId: string;
      readonly status: number;
      readonly authenticated: boolean;
    }[];
    readonly config?: typeof CONFIG;
    readonly accounts?: readonly Account[];
  } = {},
): RunReport {
  const config = over.config ?? CONFIG;
  const accounts = over.accounts ?? ACCOUNTS;
  const observations = over.observations ?? AS_DECLARED;
  const skipped = over.skipped ?? [];
  const skippedIds = new Set(skipped.map((one) => one.endpointId));
  const probed = ENDPOINTS.filter((endpoint) => !skippedIds.has(endpoint.id));
  const policy = expandPolicy(config.policy, ENDPOINTS);
  const matrix = buildAccessMatrix({
    endpoints: probed,
    accounts,
    resources: config.resources,
    observations,
  });
  return buildReport({
    version: "9.9.9",
    config,
    endpoints: ENDPOINTS,
    accounts,
    probed,
    observations,
    skipped,
    failures: (over.failures ?? []) as never,
    unauthenticated: [],
    canariesChecked: (over.canaries ?? CANARIES).length,
    canaries: over.canaries ?? CANARIES,
    truncated: over.truncated ?? false,
    findings: diffAccess(matrix, policy),
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1_000),
  });
}

/** The summary as one string, which is how a reader meets it. */
function summarize(
  report: RunReport,
  over: Partial<Parameters<typeof writeRunSummary>[0]> = {},
): string {
  writeRunSummary({
    report,
    verdict: runVerdict(report),
    suspicions: [],
    truncated: false,
    interruptedBy: undefined,
    streamPath: undefined,
    observations: report.summary.observations,
    configPath: "barbican.run.yaml",
    reportPath: "out/run.json",
    identity: IDENTITY,
    saidEarly: new Set<string>(),
    ...over,
  });
  return said.join("");
}

describe("what the finished run says", () => {
  /**
   * Not 'pairs': a cell is the triple account × endpoint × resource, and a reader
   * who checked 6 × 8 ≠ 80 by hand decided the report was lying.
   */
  it("counts the cells and the coordinates they were built from", () => {
    expect(summarize(reportOf())).toContain(
      "Cells probed: 6 (matrix rows 2, endpoints 3, resources 1)",
    );
  });

  /** The last line, and the one CI acts on. */
  it("ends with the exit code and the reason for it", () => {
    expect(summarize(reportOf())).toMatch(/Exit code 0: /);
    expect(summarize(reportOf({ observations: WITH_A_LEAK }))).toMatch(/Exit code 1: /);
  });

  /**
   * Green only on a run that earned it. With a finding the same claim is made in
   * plain words with what contradicts it on the same line — the mistake found on
   * 18 August was the reassurance, not the count.
   */
  it("paints the headline green only where nothing was found and nothing is unresolved", () => {
    expect(summarize(reportOf())).toContain("No privilege escalation found\n");
    expect(summarize(reportOf({ observations: WITH_A_LEAK }))).toContain("Privilege escalation: 1");
  });

  /**
   * B-4: nine templated endpoints with no resources declared, the walk covering
   * two, and the green line printed over the object half of the surface. The
   * headline now names what is unresolved instead.
   */
  it("says nothing was proved when the walk did not reach every endpoint", () => {
    const screen = summarize(
      reportOf({
        observations: AS_DECLARED.slice(0, 4),
        skipped: [{ endpointId: "orders.read", reason: "path-parameters" }],
      }),
    );

    expect(screen).toContain("nothing was proved: the lines above carry endpoints no request");
    expect(screen).toContain("Endpoints not probed: 1 (have path parameters 1)");
  });

  /**
   * The other two reservations the headline can name: a resource nothing
   * answered for, and a run whose own exit code is not 0 while nothing was
   * found.
   */
  it("names a resource that answered 404 to everyone, and the run's own code", () => {
    const gone: readonly AccessObservation[] = [
      seen("alice-a", "me", 200, "allowed"),
      seen("carol-b", "me", 200, "allowed"),
      seen("alice-a", "admin.accounts", 403, "denied"),
      seen("carol-b", "admin.accounts", 403, "denied"),
      seen("alice-a", "orders.read", 404, "not-found", "order-a-1"),
      seen("carol-b", "orders.read", 404, "not-found", "order-a-1"),
    ];

    const screen = summarize(reportOf({ observations: gone, config: CLOSED }));

    expect(screen).toContain("Resources answered 404 to everyone: order-a-1");
    expect(screen).toMatch(/nothing was proved: (the lines above carry|this run ends)/);
  });

  /** Requests that never produced a status are their own line: they are not denials. */
  it("counts the requests that failed", () => {
    const screen = summarize(reportOf({ failures: [{ endpointId: "me", reason: "ECONNRESET" }] }));

    expect(screen).toContain("Requests that failed: 1 (reasons in the report)");
  });

  /**
   * Rows and defects, side by side. 'critical 10' alone reads as ten problems
   * while it is one missing filter across ten cells, and the two lines are what
   * keep those apart.
   */
  it("breaks the findings down by severity, as rows and as defects", () => {
    const screen = summarize(reportOf({ observations: WITH_A_LEAK }));

    expect(screen).toContain("Rows by severity: critical 1, high 0, medium 0, low 0, info 0");
    expect(screen).toContain("Defects by severity: critical 1, high 0, medium 0, low 0, info 0");
    expect(screen).toContain("Distinct defects: at least 1 (finding rows 1)");
  });

  it("says nothing about severity on a run with no findings", () => {
    expect(summarize(reportOf())).not.toContain("by severity");
  });

  /**
   * The report's own sentences, in the report's own words. Two of them are said
   * before the walk because they are about the run being about to be wasted, and
   * the summary subtracts exactly those.
   */
  it("prints the report's warnings, minus the ones already said", () => {
    const report = reportOf({ canaries: [] });
    const withoutFilter = summarize(report);
    said = [];
    const filtered = summarize(report, { saidEarly: new Set([WARNINGS.noCanary]) });

    expect(report.warnings).toContain(WARNINGS.noCanary);
    expect(withoutFilter).toContain(WARNINGS.noCanary);
    expect(filtered).not.toContain(WARNINGS.noCanary);
  });

  /**
   * The only account of what the platform's log will show. The report has no
   * field for it, so a run that did not announce itself says so here or nowhere.
   */
  it("says how the platform's log will show the run, or that it will not", () => {
    expect(summarize(reportOf())).toContain(`Named on the wire as: ${IDENTITY.value}`);
    said = [];
    expect(summarize(reportOf(), { identity: undefined })).toContain(
      "did not name itself on the wire",
    );
  });

  /**
   * A matrix row is not an account: the same account under declared conditions
   * is a row of its own, and 2 rows over 2 accounts reads as an error to anyone
   * checking the arithmetic. The clause naming the difference appears only where
   * there is one.
   */
  it("separates the matrix rows from the accounts when conditions add rows", () => {
    const underConditions: Account = {
      id: "alice-a@geo-blocked",
      roleId: "user",
      tenantId: "tenant-a",
      contextId: "geo-blocked",
      baseAccountId: "alice-a",
    };

    const screen = summarize(
      reportOf({
        accounts: [...ACCOUNTS, underConditions],
        observations: [...AS_DECLARED, seen("alice-a@geo-blocked", "me", 200, "allowed")],
      }),
    );

    expect(screen).toContain(
      "matrix rows 3, of them accounts 2 and the same accounts under contexts",
    );
  });

  /** One row is a row and two are rows: the line is read by a human. */
  it("counts finding rows in the plural only where there are several", () => {
    const oneRefusal = [
      ...AS_DECLARED.slice(0, 4),
      seen("alice-a", "orders.read", 403, "denied", "order-a-1"),
      AS_DECLARED[5] as AccessObservation,
    ];
    const twoRefusals = [
      seen("alice-a", "me", 403, "denied"),
      seen("carol-b", "me", 403, "denied"),
      ...AS_DECLARED.slice(2, 4),
      seen("alice-a", "orders.read", 403, "denied", "order-a-1"),
      AS_DECLARED[5] as AccessObservation,
    ];

    expect(summarize(reportOf({ observations: oneRefusal }))).toContain("1 finding row of other");
    said = [];
    expect(summarize(reportOf({ observations: twoRefusals }))).toContain("3 finding rows of other");
  });

  it("says where the report went", () => {
    expect(summarize(reportOf())).toContain("Report: out/run.json");
    said = [];
    expect(summarize(reportOf(), { reportPath: undefined })).toContain("Report: printed to stdout");
  });
});

describe("a run that was cut short", () => {
  /**
   * The traffic is already spent, and this is the only place the operator is told
   * it need not be spent again. The command is printed as it can be copied,
   * because the alternative is reconstructing it from two flags and a path.
   */
  it("offers the cells on disk to the next run, with the command to continue", () => {
    const screen = summarize(reportOf({ truncated: true }), {
      truncated: true,
      streamPath: "out/run.json.stream.ndjson",
    });

    expect(screen).toContain("the request budget ran out or the circuit breaker tripped");
    expect(screen).toContain("The 6 cells that were walked are in out/run.json.stream.ndjson");
    expect(screen).toContain(
      "barbican run --config barbican.run.yaml --report out/run.json --resume",
    );
  });

  /** Without `--report` there is no stream, and nothing to carry forward. */
  it("says when nothing was streamed, and why there was nowhere to stream it", () => {
    const screen = summarize(reportOf({ truncated: true }), {
      truncated: true,
      streamPath: undefined,
    });

    expect(screen).toContain("Nothing was streamed to disk");
    expect(screen).toContain("give --report next time");
  });

  /**
   * The command is printed from the two paths the run was given, and one of them
   * can be absent: a run without `--report` has no stream either, but the line is
   * built before that is known, and an empty path is better than the word
   * "undefined" in a command a reader is invited to copy.
   */
  it("prints the command with an empty report path when there was none", () => {
    const screen = summarize(reportOf({ truncated: true }), {
      truncated: true,
      streamPath: "out/run.json.stream.ndjson",
      reportPath: undefined,
    });

    expect(screen).toContain("--config barbican.run.yaml --report  --resume");
  });

  /** A signal is a different fact from a budget, and the line names which one. */
  it("names the signal that stopped the walk", () => {
    const screen = summarize(reportOf({ truncated: true }), {
      truncated: true,
      interruptedBy: "SIGINT",
      streamPath: "out/run.json.stream.ndjson",
    });

    expect(screen).toContain("SIGINT stopped the walk");
  });
});

describe("an account nothing opened up for", () => {
  /**
   * Not a finding about the platform: a run where no endpoint declared
   * accessible opened up is a run with broken credentials or a wrong address,
   * and every count below it is about requests that were never authorized.
   */
  it("is named before the counts, with the numbers behind the suspicion", () => {
    const suspicions: readonly AuthenticitySuspicion[] = [
      { accountId: "carol-b", refused: 3, expectedAllowed: 3, dominantStatus: 401 },
    ];

    const screen = summarize(reportOf(), { suspicions });

    expect(screen).toContain("No access anywhere: carol-b (3/3, mostly 401)");
    expect(screen.indexOf("No access anywhere")).toBeLessThan(screen.indexOf("Cells probed"));
  });
});

describe("colour", () => {
  /**
   * The stream is named on purpose: `styleText` without it validates
   * `process.stdout`, while the decision is made on `process.stderr`. In the
   * ordinary invocation — the report redirected from a terminal — stdout is not a
   * TTY and stderr is, so every colour this file argues about was dropped on the
   * floor (H-3, L-4).
   */
  it("is written to a terminal and left out of a redirect", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    expect(paint("stop", "red")).not.toBe("stop");
    expect(paint("stop", "red")).toContain("stop");

    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    expect(paint("stop", "red")).toBe("stop");
  });
});

/**
 * Every verdict, reached the way a run reaches it.
 *
 * `exit-code.test.ts` next door builds a `RunReport` from a literal and hands it
 * to `runVerdict`. That is the right shape for asking "given this report, what is
 * the verdict" — and it cannot answer the other half of the question, which is
 * whether a run can produce that report at all. A branch of `runVerdict` guarded
 * by a field `buildReport` never sets is dead code that tests green, and a state
 * `buildReport` does produce but no literal describes is a verdict nobody has
 * checked. Both were how B-4 hid: the helper set `byKind` and left `findings`
 * empty, which is a report `buildReport` cannot emit, and the verdict read the
 * counter rather than the rows.
 *
 * So this file goes through the three steps the CLI takes and nothing else —
 * `buildAccessMatrix`, `diffAccess`, `buildReport` — and asserts the verdict at
 * the end of them. One case per branch, in the order `runVerdict` tests them,
 * because the order is itself a decision: "the run was cut short" outranks "a
 * leak was found", since a leak found in the part that was walked says nothing
 * about the part that was not.
 *
 * Found by the audit of 14 August 2026 (B-14), whose first half closed on
 * 15 August with B-3 and B-4.
 */

import { describe, expect, it } from "vitest";
import type {
  AccessObservation,
  Account,
  Endpoint,
  ExpectedAccessPolicy,
} from "../../src/core/index.js";
import { buildAccessMatrix, diffAccess, expandPolicy } from "../../src/core/index.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { BuildReportOptions } from "../../src/report/build.js";
import { buildReport, exitCodeFor, runVerdict } from "../../src/report/build.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: alice, role: user, tenant: t-a, tokenEnv: A }
  - { id: carol, role: user, tenant: t-b, tokenEnv: C }
policy: { fallback: denied, rules: [] }
`);

const ACCOUNTS: readonly Account[] = [
  { id: "alice", roleId: "user", tenantId: "t-a" },
  { id: "carol", roleId: "user", tenantId: "t-b" },
];

const ORDERS: Endpoint = { id: "orders.list", method: "GET", path: "/v1/orders" };
const ADMIN: Endpoint = { id: "admin.users", method: "GET", path: "/v1/admin/users" };
const ENDPOINTS: readonly Endpoint[] = [ORDERS, ADMIN];

/** Everybody may read orders; nobody may read the admin list. */
const POLICY: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [{ roles: ["user"], endpoints: ["orders.list"], outcome: "allowed" }],
};

function seen(
  accountId: string,
  endpointId: string,
  status: number,
  outcome: AccessObservation["outcome"],
  signals?: Readonly<Record<string, number | boolean>>,
): AccessObservation {
  return {
    accountId,
    endpointId,
    status,
    headers: {},
    outcome,
    durationMs: 1,
    ...(signals === undefined ? {} : { signals }),
  };
}

/** The walk as the policy expects it: orders allowed, admin refused. */
const AS_DECLARED: readonly AccessObservation[] = [
  seen("alice", "orders.list", 200, "allowed"),
  seen("carol", "orders.list", 200, "allowed"),
  seen("alice", "admin.users", 403, "denied"),
  seen("carol", "admin.users", 403, "denied"),
];

/**
 * The three steps `src/cli.ts` takes between a walk and a verdict.
 *
 * The findings are produced by `diffAccess` over a real matrix rather than
 * passed in as literals: a discrepancy is a conclusion the core draws, and a
 * test that supplies it has stopped testing the seam and started describing it.
 */
function verdictOf(
  observations: readonly AccessObservation[],
  overrides: Partial<BuildReportOptions> = {},
) {
  const matrix = buildAccessMatrix({ endpoints: ENDPOINTS, accounts: ACCOUNTS, observations });
  const policy = expandPolicy(POLICY, ENDPOINTS);
  const report = buildReport({
    version: "test",
    config: CONFIG,
    endpoints: ENDPOINTS,
    observations,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: ACCOUNTS.length,
    // One per account, because the rule is per account: a fixture carrying a
    // count and an empty list is a report `buildReport` never produces, and it
    // is what hid the gap this file's last case now covers.
    canaries: ACCOUNTS.map((account) => ({
      accountId: account.id,
      endpointId: "orders.list",
      status: 200,
      authenticated: true,
    })),
    truncated: false,
    findings: diffAccess(matrix, policy),
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1),
    ...overrides,
  });
  return { report, verdict: runVerdict(report), code: exitCodeFor(report) };
}

describe("a walk that agrees with the policy", () => {
  it("is the only way to reach 0", () => {
    const { verdict, code } = verdictOf(AS_DECLARED);

    expect(code).toBe(0);
    expect(verdict.code).toBe(0);
  });

  /** And the report says so itself, rather than leaving it to whoever runs it. */
  it("carries the verdict in the artifact", () => {
    const { report } = verdictOf(AS_DECLARED);

    expect(report.verdict.code).toBe(0);
    expect(report.verdict.reason).toBeTruthy();
  });
});

describe("nothing was probed", () => {
  /**
   * The first branch, and it outranks every other: a report with no observations
   * has no evidence for any conclusion, including a clean one.
   */
  it("is 2, and says there is nothing to conclude from", () => {
    const { verdict, code } = verdictOf([]);

    expect(code).toBe(2);
    expect(verdict.reason).toContain("not a single cell");
  });
});

describe("the run was cut short", () => {
  /**
   * Ahead of the findings on purpose. A leak found in the part that was walked
   * says nothing about the part that was not, so "cut short" is the more
   * important fact even when there is a finding to report.
   */
  it("is 2 even where the walked part was clean", () => {
    const { verdict, code } = verdictOf(AS_DECLARED, { truncated: true });

    expect(code).toBe(2);
    expect(verdict.reason).toContain("cut short");
  });

  it("is 2 even where the walked part found an escalation", () => {
    const leaking = [...AS_DECLARED.slice(0, 3), seen("carol", "admin.users", 200, "allowed")];
    const { verdict } = verdictOf(leaking, { truncated: true });

    expect(verdict.code).toBe(2);
    expect(verdict.reason).toContain("cut short");
  });
});

describe("credentials that went stale during the walk", () => {
  it("is 2: every refusal after that point says nothing about access", () => {
    const { verdict, code } = verdictOf(AS_DECLARED, { staleCredentials: ["carol"] });

    expect(code).toBe(2);
    expect(verdict.reason).toContain("carol");
    expect(verdict.reason).toContain("stale");
  });
});

describe("an account that was granted access nowhere", () => {
  it("is 2, and blames the token rather than the policy", () => {
    const { verdict, code } = verdictOf(AS_DECLARED, { unauthenticated: ["carol"] });

    expect(code).toBe(2);
    expect(verdict.reason).toContain("carol");
  });
});

describe("no canary was checked", () => {
  /**
   * Nothing confirms the accounts were authenticated at all, so every refusal in
   * the run may be an unauthenticated request being refused for that reason.
   */
  it("is 2 while any account claims to present a credential", () => {
    const { verdict, code } = verdictOf(AS_DECLARED, { canariesChecked: 0, canaries: [] });

    expect(code).toBe(2);
    expect(verdict.reason).toContain("canary");
  });

  /**
   * The rule is per account, and it was per run until 19 August 2026.
   *
   * Adversarial review: alice has a working token and a canary, mallory carries a
   * dead one and no canary of its own. Every cell of mallory's answers 401, every
   * one of them is declared denied, so the matrix agrees with the policy — and
   * the run exited 0 stating "tested and clean" about the half of the matrix
   * whose credentials were never shown to work at all. `findUnauthenticated`
   * cannot reach it: a policy that declares nothing accessible to mallory gives
   * it `expectedAllowed: 0`.
   */
  it("is 2 when one account has a canary and another with credentials has none", () => {
    const { verdict, code } = verdictOf(AS_DECLARED, {
      canariesChecked: 1,
      canaries: [
        { accountId: "alice", endpointId: "orders.list", status: 200, authenticated: true },
      ],
    });

    expect(code).toBe(2);
    expect(verdict.reason).toContain("carol");
    expect(verdict.reason).not.toContain("alice");
  });

  /**
   * A report saved by 0.4.0 and handed back to `runVerdict`, which is exported.
   *
   * The rule used to read `canariesChecked`, so an object without `canaries`
   * answered; reading the outcomes made it a `TypeError` where an exit code was
   * expected. "Nothing confirmed" is the worse-case answer, and it is an answer.
   */
  it("answers 2 rather than throwing when the report has no canaries field", () => {
    const { report } = verdictOf(AS_DECLARED);
    const { canaries: _dropped, ...older } = report;

    expect(() => exitCodeFor(older as typeof report)).not.toThrow();
    expect(exitCodeFor(older as typeof report)).toBe(2);
  });

  /** A canary that answered with a refusal confirms nothing either. */
  it("is 2 when the only canary failed", () => {
    const { verdict, code } = verdictOf(AS_DECLARED, {
      canariesChecked: 2,
      canaries: ACCOUNTS.map((account) => ({
        accountId: account.id,
        endpointId: "orders.list",
        status: 401,
        authenticated: false,
      })),
    });

    expect(code).toBe(2);
    expect(verdict.reason).toContain("alice");
    expect(verdict.reason).toContain("carol");
  });
});

describe("a walk where too much failed to answer", () => {
  /**
   * Half the requests failing means the report describes the network rather than
   * the platform. Built from real observations: a `probe-error` is a conclusion
   * `diffAccess` draws from a status of 0, not a field anybody sets.
   */
  it("is 2, and says the report describes the network", () => {
    const half = [
      seen("alice", "orders.list", 200, "allowed"),
      seen("carol", "orders.list", 200, "allowed"),
      seen("alice", "admin.users", 0, "error"),
      seen("carol", "admin.users", 0, "error"),
    ];

    const { report, verdict, code } = verdictOf(half);

    expect(report.summary.byKind["probe-error"]).toBe(2);
    expect(code).toBe(2);
    expect(verdict.reason).toMatch(/failed to answer|network/);
  });
});

describe("a privilege escalation", () => {
  it("is 1, not 2: the run is trustworthy and the platform is not", () => {
    const leaking = [...AS_DECLARED.slice(0, 3), seen("carol", "admin.users", 200, "allowed")];

    const { report, verdict, code } = verdictOf(leaking);

    expect(report.summary.byKind["privilege-escalation"]).toBe(1);
    expect(code).toBe(1);
    expect(verdict.code).toBe(1);
  });
});

describe("an unexpected denial", () => {
  /** The other direction of the same comparison, and the same exit code. */
  it("is 1", () => {
    const refusing = [seen("alice", "orders.list", 403, "denied"), ...AS_DECLARED.slice(1)];

    const { report, code } = verdictOf(refusing);

    expect(report.summary.byKind["unexpected-denial"]).toBe(1);
    expect(code).toBe(1);
  });
});

describe("a leak only the body shows", () => {
  /**
   * The branch below the matrix ones: every status is what the policy expects,
   * and the finding comes from a check. Without this the run would exit 0 with
   * two tenants holding one another's data.
   */
  it("is 1, and says it was found by the body rather than by status", () => {
    const { report, verdict, code } = verdictOf(AS_DECLARED, {
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "the same response digest for two tenants",
          endpointId: "orders.list",
          accountId: "alice",
          relatedAccountId: "carol",
          evidence: { bodyDigestsEqual: true },
        },
      ],
    });

    expect(report.summary.checkFindings).toBe(1);
    expect(code).toBe(1);
    expect(verdict.reason).toContain("body");
  });
});

/**
 * The report says whether it is the file the run wrote.
 *
 * `runId`, `configDigest` and `tool.version` identify the run, the declaration
 * and the tool. None of them identifies the **artifact**: `createHash` occurred
 * once in `src/report/build.ts` and it hashed the configuration. So a report
 * could be opened in a text editor, have a row deleted from `findings` and a
 * sentence rewritten in `verdict.reason`, and nothing inside the file would
 * object — while the invariant "JSON is the single source of truth" carries the
 * edit into every HTML and PDF rendered from it.
 *
 * What is under test is the cheap half and only the cheap half: a digest the
 * file computes over itself. It catches a careless edit. It does not catch a
 * deliberate one, because whoever changed the row can run the same function —
 * see ADR-0051, which says so in the decision rather than in a footnote.
 *
 * **And every report here is built in this process.** That is the right scope
 * for the cases below — they are about the function — and it is exactly why none
 * of them noticed that the digest was false on all 58 reports of the polygon: the
 * CLI wrote one more field onto the finished document, and a report that never
 * leaves memory never meets that line. The proof on an actual artifact is in
 * `tests/cli.test.ts`, under "the digest on the artifact the command produced",
 * and it belongs there because it has to run the command. See ADR-0058.
 *
 * Found as M-19.
 */

import { describe, expect, it } from "vitest";
import type { AccessObservation, Account, Endpoint } from "../../src/core/index.js";
import { buildAccessMatrix, describeMatrix, expandPolicy } from "../../src/core/index.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { RunReport } from "../../src/report/build.js";
import { buildReport, checkContentDigest, contentDigestOf } from "../../src/report/build.js";
import { reportChunks } from "../../src/report/write.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }
  - { id: carol, role: user, tenant: tenant-b, tokenEnv: T_CAROL, canary: me }
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
`);

const ACCOUNTS: readonly Account[] = [
  { id: "alice", roleId: "user", tenantId: "tenant-a" },
  { id: "carol", roleId: "user", tenantId: "tenant-b" },
];

const ENDPOINTS: readonly Endpoint[] = [
  { id: "me", method: "GET", path: "/v1/me" },
  { id: "admin.accounts", method: "GET", path: "/v1/admin/accounts" },
];

function seen(
  accountId: string,
  endpointId: string,
  status: number,
  outcome: "allowed" | "denied",
): AccessObservation {
  return { accountId, endpointId, status, headers: {}, outcome, durationMs: 1 };
}

const AS_DECLARED: readonly AccessObservation[] = [
  seen("alice", "me", 200, "allowed"),
  seen("alice", "admin.accounts", 403, "denied"),
  seen("carol", "me", 200, "allowed"),
  seen("carol", "admin.accounts", 403, "denied"),
];

function reportOf(
  observations: readonly AccessObservation[],
  endpoints: readonly Endpoint[] = ENDPOINTS,
): RunReport {
  const matrix = buildAccessMatrix({ endpoints, accounts: ACCOUNTS, observations });
  const policy = expandPolicy(
    { fallback: "denied", rules: [{ roles: ["user"], endpoints: ["me"], outcome: "allowed" }] },
    endpoints,
  );
  const walked = describeMatrix(matrix, policy);
  return buildReport({
    version: "test",
    config: CONFIG,
    accounts: ACCOUNTS,
    endpoints,
    probed: endpoints,
    observations,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 2,
    canaries: [
      { accountId: "alice", endpointId: "me", status: 200, authenticated: true },
      { accountId: "carol", endpointId: "me", status: 200, authenticated: true },
    ],
    truncated: false,
    findings: walked.diffs,
    cells: walked.cells,
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1),
  });
}

/** The report as a reader gets it: parsed back out of the file. */
function asRead(report: RunReport): Record<string, unknown> {
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

describe("the digest a report carries of itself", () => {
  it("is there, and it is a whole sha256", () => {
    // Not truncated the way `configDigest` is. That one is a label two runs are
    // compared by; this one is a check value, and shortening a check value buys
    // nothing and costs collision resistance.
    expect(reportOf(AS_DECLARED).contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks out against the file the run wrote", () => {
    const verdict = checkContentDigest(asRead(reportOf(AS_DECLARED)));

    expect(verdict.ok).toBe(true);
    expect(verdict.declared).toBe(verdict.computed);
  });

  /**
   * And against the bytes, which are not produced by `JSON.stringify`.
   *
   * The report is serialised in chunks (ADR-0038), so what a reader parses is
   * what `reportChunks` emitted rather than what the object literal held. Every
   * other case here round-trips through `JSON.stringify`, and a digest that
   * verified there and nowhere else would fail on every real file while the
   * suite stayed green. `write.test.ts` asserts the two serialisations are equal
   * byte for byte; this asserts the consequence that matters here.
   */
  it("checks out against the bytes the writer produced", () => {
    const parsed = JSON.parse([...reportChunks(reportOf(AS_DECLARED))].join("")) as object;

    expect(checkContentDigest(parsed).ok).toBe(true);
  });

  /**
   * The field is not part of what it hashes.
   *
   * Otherwise the value would have to contain itself, and the only way to check
   * one would be to know what it used to be.
   */
  it("does not hash itself", () => {
    const file = asRead(reportOf(AS_DECLARED));

    expect(contentDigestOf({ ...file, contentDigest: "0".repeat(64) })).toBe(contentDigestOf(file));
  });

  /**
   * The order the keys sit in is the file's formatting, not its content — the
   * same argument `configDigest` is computed over the parsed configuration by.
   */
  it("does not move when the keys are written in another order", () => {
    const file = asRead(reportOf(AS_DECLARED));
    const reversed = Object.fromEntries(Object.entries(file).reverse());

    expect(checkContentDigest(reversed).ok).toBe(true);
  });

  /**
   * The three edits the field exists for. Each is one line in a text editor, and
   * each is the shape of somebody making a report say something it did not.
   */
  it("does not check out when a finding is deleted", () => {
    // A run with something in it to delete: carol reaching the admin endpoint is
    // the escalation, and the row for it is the one a careless editor removes.
    const file = asRead(
      reportOf([...AS_DECLARED.slice(0, 3), seen("carol", "admin.accounts", 200, "allowed")]),
    );
    const findings = file["findings"] as unknown[];
    expect(findings.length).toBeGreaterThan(0);

    expect(checkContentDigest({ ...file, findings: findings.slice(1) }).ok).toBe(false);
  });

  it("does not check out when the verdict is rewritten", () => {
    const file = asRead(reportOf(AS_DECLARED));

    expect(
      checkContentDigest({ ...file, verdict: { code: 0, reason: "all good, ship it" } }).ok,
    ).toBe(false);
  });

  it("does not check out when a counter deep inside the file is rewritten", () => {
    // Deep on purpose. A digest over the top-level keys alone would survive the
    // two edits above and fail here — and this is where a number that a
    // dashboard reads actually lives.
    const file = asRead(reportOf(AS_DECLARED));
    const observations = file["observations"] as Record<string, unknown>[];
    const first = observations[0] as Record<string, unknown>;

    expect(
      checkContentDigest({
        ...file,
        observations: [{ ...first, status: 499 }, ...observations.slice(1)],
      }).ok,
    ).toBe(false);
  });

  /**
   * A report written before the field existed, and the answer that is not "yes".
   *
   * A verifier that treated a missing digest as a pass would make the whole
   * exercise optional: strip the field and the file is unimpeachable again.
   */
  it("reports a file that carries no digest as unchecked rather than as sound", () => {
    const file = asRead(reportOf(AS_DECLARED));
    delete file["contentDigest"];
    const verdict = checkContentDigest(file);

    expect(verdict.declared).toBeUndefined();
    expect(verdict.ok).toBe(false);
    expect(verdict.computed).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * And it is the run's own answer that moves it, not the clock: two reports of
   * the same shape differing by one status differ here.
   */
  it("moves with what the platform answered", () => {
    const other = [...AS_DECLARED.slice(1), seen("alice", "me", 201, "allowed")];

    expect(reportOf(AS_DECLARED).contentDigest).not.toBe(reportOf(other).contentDigest);
  });

  /**
   * Large reports are the ordinary case for this tool, and the digest must not
   * put back the ceiling `src/report/write.ts` was rewritten to remove: a run of
   * 57 826 cells died on `RangeError: Invalid string length` at the last step
   * (ADR-0038). The digest consumes the canonical form in pieces for that
   * reason. This is the cheap end of that scale — enough to run in CI, not
   * enough to prove the ceiling is gone.
   */
  it("is computed over a report far larger than one screen", () => {
    const wide: Endpoint[] = [];
    const many: AccessObservation[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const id = `bulk.${index}`;
      wide.push({ id, method: "GET", path: `/v1/bulk/${index}` });
      many.push(seen("alice", id, 403, "denied"));
      many.push(seen("carol", id, 403, "denied"));
    }
    const file = asRead(reportOf(many, wide));

    expect(checkContentDigest(file).ok).toBe(true);
  });
});

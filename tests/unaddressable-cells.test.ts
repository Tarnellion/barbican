/**
 * A cell that could not even be addressed is a cell that gave no answer.
 *
 * It used to leave no observation at all: an entry in `failures` and nothing
 * else. So it produced no `probe-error`, and the untrustworthiness threshold —
 * "half or more of the requests failed, the report describes the network rather
 * than the platform" — could not see it. Four cells out of five failing this way
 * exited **0**, "checked, and clean", because the fifth was the whole
 * denominator. Found by the audit of 14 August 2026 (B-7).
 *
 * The whole seam is under test here, from the walk to the exit code, because
 * that is where the defect lived: each piece was defensible on its own.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import type { HttpClient } from "../src/adapters/ports.js";
import type { Account, Endpoint, Resource } from "../src/core/index.js";
import { buildAccessMatrix, diffAccess } from "../src/core/index.js";
import { parseRunConfig } from "../src/io/config.js";
import { buildReport, exitCodeFor, runVerdict } from "../src/report/build.js";
import { collectObservations } from "../src/runner.js";

const ACCOUNTS: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
const CREDENTIALS = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));

const ENDPOINT: Endpoint = { id: "player.read", method: "GET", path: "/v1/players/{playerId}" };

/**
 * Five resources, four of which name a segment that navigates instead of naming.
 *
 * `.` and `..` are refused while the address is assembled: they survive
 * `encodeURIComponent` and would send the request to a different endpoint inside
 * the target. See ADR-0024 and D-1.
 */
const RESOURCES: readonly Resource[] = [
  { id: "good", params: { playerId: "p-1" }, tenantId: "t" },
  { id: "dot-1", params: { playerId: "." }, tenantId: "t" },
  { id: "dot-2", params: { playerId: ".." }, tenantId: "t" },
  { id: "dot-3", params: { playerId: "." }, tenantId: "t" },
  { id: "dot-4", params: { playerId: ".." }, tenantId: "t" },
];

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: a, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: allowed, rules: [] }
`);

const client: HttpClient = {
  send: () => Promise.resolve({ status: 200, headers: {} }),
};

async function run() {
  const walked = await collectObservations({
    baseUrl: "https://a.test",
    endpoints: [ENDPOINT],
    accounts: ACCOUNTS,
    credentials: CREDENTIALS,
    resources: RESOURCES,
    client,
  });

  // The same two steps the CLI takes: `probe-error` is a **finding**, produced by
  // the diff over the observations, not a field the walk sets. A fixture passing
  // `findings: []` proves nothing about the verdict.
  const matrix = buildAccessMatrix({
    endpoints: [ENDPOINT],
    accounts: ACCOUNTS,
    resources: RESOURCES,
    observations: walked.observations,
  });
  const findings = diffAccess(matrix, { fallback: "allowed", rules: [] });

  const report = buildReport({
    version: "test",
    config: { ...CONFIG, resources: RESOURCES },
    endpoints: [ENDPOINT],
    observations: walked.observations,
    skipped: walked.skipped,
    failures: walked.failures,
    unauthenticated: [],
    canariesChecked: 1,
    truncated: walked.truncated,
    findings,
    policy: { fallback: "allowed", rules: [] },
    startedAt: new Date(0),
    finishedAt: new Date(1),
  });

  return { walked, report };
}

describe("four cells out of five that could not be addressed", () => {
  it("each leave a row saying no answer came", async () => {
    const { walked } = await run();

    expect(walked.failures).toHaveLength(4);
    // The row is the half that was missing. Status 0 is what this report already
    // means by "no answer".
    expect(walked.observations).toHaveLength(5);
    expect(walked.observations.filter((one) => one.status === 0)).toHaveLength(4);
  });

  /**
   * And no address, because there is none: the address is exactly what could not
   * be built. Inventing one would tell the reader a request went somewhere.
   */
  it("carry no url and no method", async () => {
    const { walked } = await run();
    const unaddressed = walked.observations.filter((one) => one.status === 0);

    for (const one of unaddressed) {
      expect(one).not.toHaveProperty("url");
      expect(one).not.toHaveProperty("method");
      expect(one.outcome).toBe("error");
    }
  });

  /** The failure keeps saying why, in words a human can act on. */
  it("say what was wrong with the value", async () => {
    const { walked } = await run();

    expect(walked.failures[0]?.reason).toMatch(/resource|segment|navigat/i);
  });

  /**
   * The point of all of it. Four fifths of the matrix produced no answer, and
   * the run must not report "checked, and clean".
   */
  it("make the run untrustworthy instead of clean", async () => {
    const { report } = await run();

    expect(exitCodeFor(report)).toBe(2);
    expect(runVerdict(report).reason).toContain("failed to answer");
  });
});

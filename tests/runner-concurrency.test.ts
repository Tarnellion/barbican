/**
 * The walk uses the concurrency it was given, and nothing more.
 *
 * `--concurrency` did nothing: `await client.send` sat inside two nested loops,
 * so exactly one request was ever in flight. 615 requests at 20 ms latency took
 * 13 766 ms at `--concurrency 1` and 13 754 ms at 128 — and the number was
 * documented, and written into the report, so the report asserted something
 * about the run that had not happened. Found by the audit of 14 August 2026
 * (I-1).
 *
 * What is pinned here is the pair, not the speed. A walk that ignores the limit
 * is the defect; a walk that exceeds it is worse than the defect, because the
 * limit is a promise about traffic on someone else's deployment.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import type { HttpClient } from "../src/adapters/ports.js";
import type { Account, Endpoint } from "../src/core/index.js";
import { collectObservations } from "../src/runner.js";

const accounts: readonly Account[] = [
  { id: "a1", roleId: "r", tenantId: "t" },
  { id: "a2", roleId: "r", tenantId: "t" },
  { id: "a3", roleId: "r", tenantId: "t" },
];

const endpoints: readonly Endpoint[] = Array.from({ length: 8 }, (_, i) => ({
  id: `e${i}`,
  method: "GET" as const,
  path: `/v1/e${i}`,
}));

const credentials = createCredentialProvider(
  DEFAULT_AUTH_SCHEME,
  new Map(accounts.map((account) => [account.id, `token-${account.id}`])),
);

/** A client that answers after a turn of the loop and remembers how many were in flight. */
function countingClient(): { client: HttpClient; peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    client: {
      async send() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Two turns, so that a walk which is in fact sequential cannot reach a
        // peak above one by accident of scheduling.
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return { status: 200, headers: {} };
      },
    },
  };
}

function walk(concurrency?: number) {
  const { client, peak } = countingClient();
  return collectObservations({
    baseUrl: "https://a.test",
    endpoints,
    accounts,
    credentials,
    client,
    ...(concurrency === undefined ? {} : { concurrency }),
  }).then((result) => ({ result, peak: peak() }));
}

describe("the walk and the concurrency limit", () => {
  /**
   * The finding itself. Before the fix this was 1 for every value.
   */
  it("keeps as many requests in flight as it was allowed", async () => {
    const { peak, result } = await walk(4);

    expect(peak).toBe(4);
    expect(result.observations).toHaveLength(24);
  });

  /**
   * The other half, and the more important one. The limit is a promise about
   * somebody else's deployment: a walk that overshoots it is worse than the
   * walk that ignored it.
   */
  it("never exceeds it", async () => {
    for (const concurrency of [1, 2, 3, 7, 25]) {
      const { peak, result } = await walk(concurrency);

      expect(peak).toBeLessThanOrEqual(concurrency);
      expect(result.observations).toHaveLength(24);
    }
  });

  /**
   * A port implementation that declares no limits, or a caller that passes
   * nothing, gets the old behaviour. The walk must never be the wider of the
   * two.
   */
  it("walks one at a time when it was told nothing", async () => {
    const { peak } = await walk();

    expect(peak).toBe(1);
  });
});

describe("the order of the observations", () => {
  /**
   * Two runs of the same matrix have to produce the same file. Otherwise a diff
   * between two reports is unreadable, and `configDigest` — which says the
   * input was identical — promises more than the artifact delivers.
   */
  it("does not depend on how many cells were in flight", async () => {
    const sequential = await walk(1);
    const key = (result: Awaited<ReturnType<typeof walk>>) =>
      result.result.observations.map((one) => `${one.accountId}|${one.endpointId}`);

    for (const concurrency of [2, 5, 16]) {
      expect(key(await walk(concurrency))).toEqual(key(sequential));
    }
  });
});

/**
 * A run cut short must reach the verdict — proven through the real client.
 *
 * The audit of 14 August found this closed on paper and open in the code. The
 * existing test in `runner.test.ts` hands a fake client an error named
 * `RunBudgetExhaustedError`, and the real client never produces one: everything
 * that leaves `createHttpClient` is wrapped in `RequestFailedError`, and the
 * runner matched terminality on the outer name. An exhausted budget therefore
 * left cells unprobed and reported `truncated: false`, exit 0.
 *
 * So these tests use `createHttpClient` and `createThrottle` themselves, against
 * a real loopback server. A fake client here would reproduce the same blind spot
 * exactly: it is the wrapping that was missed, and only the thing that wraps can
 * demonstrate it.
 *
 * The breaker cases matter for a second reason. `CircuitOpenError` is thrown
 * directly rather than wrapped, so it was recognised all along — and past five
 * consecutive failures it sets `truncated` for its own reasons. That is what made
 * the defect look absent: on any matrix with more than four cells left, the
 * breaker "rescued" the verdict, and only the last four cells of a run ever
 * showed the fault.
 */

import type { Server } from "node:http";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import { createHttpClient } from "../src/adapters/http.js";
import { createThrottle } from "../src/adapters/throttle.js";
import type { Account, Endpoint } from "../src/core/index.js";
import { collectObservations } from "../src/runner.js";
import type { TestClock } from "./fixtures/clock.js";
import { createTestClock } from "./fixtures/clock.js";

const ACCOUNTS: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
const CREDENTIALS = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));

function endpoints(count: number): readonly Endpoint[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `e${index}`,
    method: "GET" as const,
    path: `/${index}`,
  }));
}

async function startServer(status = 200): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not report a port");
  }
  return {
    port: address.port,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function walk(options: {
  readonly cells: number;
  readonly maxRequests: number;
  readonly status?: number;
  readonly retry?: { readonly maxAttempts: number; readonly baseDelayMs?: number };
  readonly clock?: TestClock;
}) {
  const server = await startServer(options.status);
  try {
    const client = createHttpClient({
      allowedHosts: ["127.0.0.1"],
      throttle: createThrottle({
        concurrency: 4,
        requestsPerSecond: 1000,
        maxRequests: options.maxRequests,
      }),
      // One attempt by default: the retries are a separate question, and three
      // of them per dead cell would make this test measure backoff. The test
      // that is about the retries passes its own.
      retry: options.retry ?? { maxAttempts: 1 },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });

    return await collectObservations({
      baseUrl: `http://127.0.0.1:${server.port}`,
      endpoints: endpoints(options.cells),
      accounts: ACCOUNTS,
      credentials: CREDENTIALS,
      client,
    });
  } finally {
    await server.close();
  }
}

describe("an exhausted request budget", () => {
  /**
   * Four cells left over is the case the breaker cannot mask: its threshold is
   * five consecutive failures. Before the fix this run reported `truncated:
   * false` and a clean verdict over a tail nobody probed.
   */
  it("marks the run truncated even when the breaker never trips", async () => {
    const result = await walk({ cells: 6, maxRequests: 2 });

    expect(result.truncated).toBe(true);
  });

  /**
   * And it stops there. The walk used to carry on to the end of the matrix, so
   * every remaining cell hit the exhausted budget and became a `probe-error`
   * row: at 18 040 cells that was 16 040 dead ones, 16 139 finding rows against
   * 109, and a 16.3 MB report against 12.8 MB for the complete run — a truncated
   * run costing more than a full one and saying less. Found by the audit of
   * 14 August (L-9).
   *
   * One failure, not four: the cell that met the exhausted budget. The rest were
   * never asked, `truncated` says the tail was not tested, and that is the
   * report's existing shape for exactly this.
   */
  it("stops walking instead of collecting a failure for every cell left", async () => {
    const result = await walk({ cells: 6, maxRequests: 2 });

    expect(result.failures).toHaveLength(1);
    // Two observed, one refused, three never reached.
    expect(result.observations.filter((one) => one.status > 0)).toHaveLength(2);
  });

  /**
   * A decision to stop is not a network condition.
   *
   * Every attempt past an exhausted budget was retried three times with two
   * backoffs, and none of them could ever succeed: `admit()` throws before it
   * increments the counter, so the budget cannot recover. Measured before the
   * fix — `--max-requests 149` took 32.1 s against 30.3 s for the whole run
   * while making three fewer requests. Found by the audit of 14 August (A-2).
   *
   * Asserted on the pauses the client asked for, not on how long the test took.
   * The first version measured wall time and passed with the retries put back:
   * the backoff carries jitter, so a timing threshold is a coin toss dressed as
   * a proof. A pause requested is a fact.
   */
  it("does not retry an exhausted budget", async () => {
    const clock = createTestClock();

    const result = await walk({
      cells: 6,
      maxRequests: 2,
      retry: { maxAttempts: 3, baseDelayMs: 2000 },
      clock,
    });

    expect(result.truncated).toBe(true);
    // Not one backoff. The budget cannot recover — `admit()` throws before it
    // increments the counter — so every one of them would be spent waiting for
    // something that cannot happen.
    expect(clock.sleeps).toEqual([]);
  });

  // A single leftover cell: the smallest tail there is, and the one that used to
  // be invisible.
  it("marks it on a tail of one", async () => {
    const result = await walk({ cells: 3, maxRequests: 2 });

    expect(result.truncated).toBe(true);
  });

  /**
   * The reason carried the wrapper's words — "the request failed after N
   * attempts" — which describes the symptom and blames the network. The budget
   * is the operator's own ceiling, and the message says so.
   */
  it("says the budget ran out rather than blaming the request", async () => {
    const result = await walk({ cells: 3, maxRequests: 2 });

    expect(result.failures[0]?.reason).toContain("budget is exhausted");
    expect(result.failures[0]?.reason).not.toContain("failed after");
  });

  // The complete walk is the control: without it a test that always reports
  // truncation would pass just as well.
  it("leaves a complete walk untruncated", async () => {
    const result = await walk({ cells: 3, maxRequests: 100 });

    expect(result.truncated).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.observations).toHaveLength(3);
  });
});

describe("a tripped circuit breaker", () => {
  // Recognised before the fix as well, because it is thrown rather than wrapped.
  // Kept so that the two paths cannot drift apart.
  it("marks the run truncated", async () => {
    const result = await walk({ cells: 12, maxRequests: 1000, status: 503 });

    expect(result.truncated).toBe(true);
  });
});

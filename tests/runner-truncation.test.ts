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
      // One attempt: the retries are a separate question, and three of them per
      // dead cell would make this test measure backoff.
      retry: { maxAttempts: 1 },
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
    expect(result.failures).toHaveLength(4);
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

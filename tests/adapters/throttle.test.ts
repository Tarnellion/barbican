/**
 * Throttling tests.
 *
 * They check actual behaviour rather than the presence of settings: how many
 * tasks really ran at once and which pauses were requested. A throttle that is
 * "configured" but lets a burst through will take down someone else's
 * deployment exactly as its absence would.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createThrottle,
  DEFAULT_THROTTLE_LIMITS,
  InvalidThrottleLimitsError,
  RunBudgetExhaustedError,
} from "../../src/adapters/throttle.js";
import { createTestClock } from "../fixtures/clock.js";

/** A task that finishes on an external command. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("the defaults", () => {
  it("are conservative", () => {
    expect(DEFAULT_THROTTLE_LIMITS).toEqual({
      concurrency: 2,
      requestsPerSecond: 5,
      maxRequests: 2000,
    });
  });

  it('reject zero and negative values: there is no "no limits" mode', () => {
    expect(() => createThrottle({ concurrency: 0 })).toThrow(InvalidThrottleLimitsError);
    expect(() => createThrottle({ requestsPerSecond: -1 })).toThrow(InvalidThrottleLimitsError);
    expect(() => createThrottle({ maxRequests: 0 })).toThrow(InvalidThrottleLimitsError);
    expect(() => createThrottle({ concurrency: Number.POSITIVE_INFINITY })).toThrow(
      InvalidThrottleLimitsError,
    );
  });
});

describe("the concurrency limit", () => {
  it("never exceeds the configured limit", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 3, requestsPerSecond: 1000 }, clock);

    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 12 }, () => deferred());

    const running = gates.map((gate) =>
      throttle.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      }),
    );

    // A full turn of the task queue: the admission chain hands out every slot.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    // Exactly as many slots are busy as are allowed — no more, no less.
    expect(active).toBe(3);
    expect(peak).toBe(3);

    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(running);

    // There must be no burst on release either.
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it("frees the slot even when the task threw", async () => {
    const throttle = createThrottle({ concurrency: 1, requestsPerSecond: 1000 });

    await expect(throttle.run(() => Promise.reject(new Error("request failure")))).rejects.toThrow(
      "request failure",
    );

    // The slot must be freed, otherwise the next call hangs forever.
    await expect(throttle.run(() => Promise.resolve("done"))).resolves.toBe("done");
  });
});

describe("the rate limit", () => {
  it("waits when the window is used up", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 10, requestsPerSecond: 3 }, clock);

    for (let i = 0; i < 3; i += 1) {
      await throttle.run(() => Promise.resolve());
    }
    expect(clock.sleeps).toEqual([]);

    // The fourth request must wait until the sliding second is over.
    await throttle.run(() => Promise.resolve());
    expect(clock.sleeps).toEqual([1000]);
  });

  it("does not slow down once the window has moved on", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 10, requestsPerSecond: 2 }, clock);

    await throttle.run(() => Promise.resolve());
    await throttle.run(() => Promise.resolve());
    await clock.sleep(1000);
    const before = clock.sleeps.length;

    await throttle.run(() => Promise.resolve());

    expect(clock.sleeps.length).toBe(before);
  });
});

describe("the per-run ceiling", () => {
  it("refuses once the budget is exhausted", async () => {
    const throttle = createThrottle({ concurrency: 5, requestsPerSecond: 1000, maxRequests: 3 });

    for (let i = 0; i < 3; i += 1) {
      await throttle.run(() => Promise.resolve(i));
    }

    await expect(throttle.run(() => Promise.resolve())).rejects.toThrow(RunBudgetExhaustedError);
  });

  it("does not run a task whose request was refused", async () => {
    const throttle = createThrottle({ concurrency: 5, requestsPerSecond: 1000, maxRequests: 1 });
    await throttle.run(() => Promise.resolve());

    let executed = false;
    await expect(
      throttle.run(() => {
        executed = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(RunBudgetExhaustedError);

    expect(executed).toBe(false);
  });
});

/**
 * The default numbers are printed in the README as a promise to the user: "the
 * tool runs across someone else's deployment this carefully". A silent drift
 * between the promise and the code is exactly the class this whole project is
 * written against, so the README table is checked by a test rather than by eye.
 */
describe("the defaults named in the README", () => {
  it('match the "How much traffic it makes" table', async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");

    expect(readme).toContain(`| Concurrent requests | ${DEFAULT_THROTTLE_LIMITS.concurrency} |`);
    expect(readme).toContain(
      `| Requests per second | ${DEFAULT_THROTTLE_LIMITS.requestsPerSecond} |`,
    );
    expect(readme).toContain(`| Requests per run | ${DEFAULT_THROTTLE_LIMITS.maxRequests} |`);
  });
});

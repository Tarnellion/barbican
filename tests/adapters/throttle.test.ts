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
  /**
   * The count in any sliding second, which is the declared limit.
   *
   * It used to be asserted as an exact list of pauses — nothing, nothing,
   * nothing, then a full second — which pinned the **shape** of the old
   * behaviour rather than the guarantee. Since I-8 the starts are spread instead
   * of clumped, and the guarantee is the same one it always was.
   */
  it("never lets more than the limit start inside a sliding second", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 10, requestsPerSecond: 3 }, clock);
    const starts: number[] = [];

    // Awaited one at a time, so nothing else can move the clock between a
    // start being granted and the task reading it. That is not true of
    // concurrent callers — see the test at the end of this block.
    for (let i = 0; i < 12; i += 1) {
      await throttle.run(() => {
        starts.push(clock.now());
        return Promise.resolve();
      });
    }

    const worstSecond = Math.max(
      ...starts.map((from) => starts.filter((one) => one >= from && one - from < 1000).length),
    );
    expect(worstSecond).toBeLessThanOrEqual(3);
    // Twelve at three a second is at least the four seconds it takes.
    expect(starts[11]).toBeGreaterThanOrEqual(3000);
  });

  /**
   * The shape, which is what I-8 changed. A window limiter bounds the count and
   * says nothing about clumping: three at once and then a second of silence
   * satisfies "three a second" while putting three requests on somebody's
   * deployment in the same instant. Measured against a server counting arrivals,
   * that clumping showed up as a worst second of 9 at `--rps 5`.
   */
  it("spreads the starts instead of releasing them in a burst", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 10, requestsPerSecond: 4 }, clock);
    const starts: number[] = [];

    for (let i = 0; i < 8; i += 1) {
      await throttle.run(() => {
        starts.push(clock.now());
        return Promise.resolve();
      });
    }

    const gaps = starts.slice(1).map((one, index) => one - (starts[index] ?? 0));
    // 1000 / 4. Not "roughly": the pause is computed, not sampled.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(250);
  });

  /**
   * Above 500 a second the spacing is off, and that is a decision rather than an
   * oversight: `--rps 5000` and `--rps 100000` both delivered ~850 admissions a
   * second while it was on, because a gap of "0.01 ms" is a sleep of one. A flag
   * that cannot reach what it declares is the defect I-1 was, in a new place.
   */
  it("stops spacing where a millisecond clock cannot express the gap", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 10, requestsPerSecond: 5000 }, clock);

    for (let i = 0; i < 20; i += 1) {
      await throttle.run(() => Promise.resolve());
    }

    // Twenty of five thousand: the window has nothing to say either, so the
    // clock must not have moved at all.
    expect(clock.sleeps).toEqual([]);
    expect(clock.now()).toBe(0);
  });

  it("does not slow down once the window has moved on", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 10, requestsPerSecond: 2 }, clock);

    await throttle.run(() => Promise.resolve());
    await throttle.run(() => Promise.resolve());
    await clock.sleep(1000);
    const before = clock.sleeps.length;

    await throttle.run(() => Promise.resolve());

    // A second has passed, so neither the window nor the spacing has anything
    // to hold back: an idle run must not pay for the previous one.
    expect(clock.sleeps.length).toBe(before);
  });

  /**
   * The rate limit under a walk that is now parallel.
   *
   * Both tests above hand over one task at a time. Since 15 August the walk
   * feeds the throttle as many cells at once as `--concurrency` allows, and
   * "does the sliding window still hold when the callers arrive together" had no
   * answer in the suite: the concurrency limit had one — twelve tasks at once —
   * the rate limit did not.
   *
   * Asserted on the pauses and not on a clock reading taken inside the task.
   * The first version of this test did the latter and appeared to catch four
   * admissions in a second where three were declared; instrumenting `admit`
   * showed it lets through exactly three per window. The reading was the
   * artifact: the clock is shared and moves in jumps, so by the time a task
   * admitted at 0 runs its body, another caller's `sleep` has already moved the
   * clock to 1000. What a task sees is not when it was let through.
   */
  it("holds when the callers arrive all at once", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 8, requestsPerSecond: 3 }, clock);
    let ran = 0;

    await Promise.all(
      Array.from({ length: 12 }, () =>
        throttle.run(() => {
          ran += 1;
          return Promise.resolve();
        }),
      ),
    );

    expect(ran).toBe(12);
    // Twelve at three a second is four seconds of walking, whichever way the
    // pauses are cut up. A burst let through on arrival would finish sooner.
    expect(clock.now()).toBeGreaterThanOrEqual(3000);
    expect(clock.sleeps.length).toBeGreaterThan(0);
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

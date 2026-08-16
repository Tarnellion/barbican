/**
 * Throttling of requests.
 *
 * A port, not an option: there is no "no limits" mode. The tool is run against
 * someone else's deployments, and taking down someone else's production with
 * load is the worst possible outcome of a run.
 *
 * Three limits at once: concurrency, the rate in a sliding one-second window,
 * and an overall ceiling on requests per run.
 */

import type { Throttle } from "./ports.js";

/**
 * The source of time.
 *
 * Taken outside so that pauses can be checked by facts rather than by waiting: a
 * test substitutes its own clock and measures the delays that were requested.
 */
export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

export interface ThrottleLimits {
  /** How many requests are performed at the same time. */
  readonly concurrency: number;
  /** How many requests are allowed within a sliding second. */
  readonly requestsPerSecond: number;
  /** The ceiling on requests for the whole run. */
  readonly maxRequests: number;
}

/** The defaults are deliberately slow: they are raised knowingly, for a specific deployment. */
export const DEFAULT_THROTTLE_LIMITS: ThrottleLimits = {
  concurrency: 2,
  requestsPerSecond: 5,
  maxRequests: 2000,
};

export class RunBudgetExhaustedError extends Error {
  constructor(maxRequests: number) {
    super(
      `The per-run request budget is exhausted (${maxRequests}). ` +
        `This is a guard against uncontrolled load, not a configuration error.`,
    );
    this.name = "RunBudgetExhaustedError";
  }
}

export class InvalidThrottleLimitsError extends Error {
  constructor(field: keyof ThrottleLimits, value: number) {
    super(`Limit "${field}" must be a positive number, got ${value}`);
    this.name = "InvalidThrottleLimitsError";
  }
}

const WINDOW_MS = 1000;

/**
 * Creates the throttle.
 *
 * Zero and negative limits are rejected: "zero" here would read as "no limits",
 * and such a mode must not exist.
 */
export function createThrottle(
  limits: Partial<ThrottleLimits> = {},
  clock: Clock = systemClock,
): Throttle {
  const effective: ThrottleLimits = { ...DEFAULT_THROTTLE_LIMITS, ...limits };
  for (const field of ["concurrency", "requestsPerSecond", "maxRequests"] as const) {
    const value = effective[field];
    if (!Number.isFinite(value) || value <= 0) {
      throw new InvalidThrottleLimitsError(field, value);
    }
  }

  let started = 0;
  let active = 0;
  const startTimes: number[] = [];
  const slotWaiters: Array<() => void> = [];
  /**
   * The smallest gap between two starts, and when the last one was.
   *
   * A sliding window alone bounds the count and says nothing about the shape:
   * with `--rps 5` it lets five go at once and then waits a second. Sequentially
   * that hardly showed, because the round trip spaced the requests by itself.
   * Since the walk became parallel it shows: a server counting arrivals saw a
   * worst second of 6 at concurrency 1, 7 at the default 2 and 9 at 8 — over a
   * limit of five, because five admitted at the same instant reach the socket
   * together and the compression lands them across a window boundary.
   *
   * The average is unchanged — this is the same `requestsPerSecond`, spread
   * instead of clumped — so nothing is lost on a run of any length. What a short
   * run loses is the burst: five requests at `--rps 5` now take 800 ms rather
   * than arriving at once. That is the intended reading of "the defaults are
   * deliberately timid". See I-8 and ADR-0026.
   */
  const minimumGapMs = WINDOW_MS / effective.requestsPerSecond;
  /**
   * Below this the clock cannot shape anything, so nothing is shaped.
   *
   * Two milliseconds is twice the resolution the throttle's clock works in. Under
   * that the rounding is of the same order as the gap itself, and the attempt
   * costs up to half the declared rate to buy nothing: measured, `--rps 5000` and
   * `--rps 100000` both delivered ~850 admissions a second, because a sleep of
   * "0.01 ms" is a sleep of one. That is the flag lying about what it does — the
   * defect I-1 was, in a new place — so above 500 a second the sliding window is
   * the only bound, exactly as it was before.
   */
  const paced = minimumGapMs >= 2;
  let lastStart = Number.NEGATIVE_INFINITY;

  // Admission decisions are made strictly in turn: otherwise two tasks could see
  // a free slot at the same time and both take it.
  let admissionChain: Promise<void> = Promise.resolve();

  function releaseSlot(): void {
    active -= 1;
    const next = slotWaiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  function trimWindow(now: number): void {
    while (startTimes.length > 0) {
      const oldest = startTimes[0];
      if (oldest === undefined || now - oldest < WINDOW_MS) {
        break;
      }
      startTimes.shift();
    }
  }

  async function awaitRateWindow(): Promise<void> {
    for (;;) {
      const now = clock.now();
      trimWindow(now);
      if (startTimes.length < effective.requestsPerSecond) {
        return;
      }
      const oldest = startTimes[0];
      if (oldest === undefined) {
        return;
      }
      await clock.sleep(Math.max(1, WINDOW_MS - (now - oldest)));
    }
  }

  /**
   * Holds back until `minimumGapMs` has passed since the previous start.
   *
   * After the window check, not instead of it: the window is the declared limit
   * and stays the authority. This only decides **when** inside it, and in the
   * steady state the two agree.
   */
  async function awaitPace(): Promise<void> {
    if (!paced) {
      return;
    }
    for (;;) {
      const waited = clock.now() - lastStart;
      if (waited >= minimumGapMs) {
        return;
      }
      await clock.sleep(Math.max(1, Math.ceil(minimumGapMs - waited)));
    }
  }

  async function admit(): Promise<void> {
    const previous = admissionChain;
    let release: () => void = () => undefined;
    admissionChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      if (started >= effective.maxRequests) {
        throw new RunBudgetExhaustedError(effective.maxRequests);
      }
      while (active >= effective.concurrency) {
        await new Promise<void>((resolve) => slotWaiters.push(resolve));
      }
      await awaitRateWindow();
      await awaitPace();

      started += 1;
      active += 1;
      lastStart = clock.now();
      startTimes.push(lastStart);
    } finally {
      release();
    }
  }

  return {
    // The limits in force are declared outward: the report needs to print them,
    // and computing the merge of defaults with flags a second time in the CLI
    // would mean introducing a duplicate that drifts from the real behaviour
    // silently.
    limits: effective,
    async run<T>(task: () => Promise<T>): Promise<T> {
      await admit();
      try {
        return await task();
      } finally {
        releaseSlot();
      }
    },
  };
}

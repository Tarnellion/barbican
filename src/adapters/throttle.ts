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

      started += 1;
      active += 1;
      startTimes.push(clock.now());
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

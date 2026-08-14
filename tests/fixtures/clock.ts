import type { Clock } from "../../src/adapters/throttle.js";

export interface TestClock extends Clock {
  /** The delays in the order they were requested. */
  readonly sleeps: readonly number[];
}

/**
 * A clock the test drives: time moves only by the pauses that were requested.
 *
 * It lets pauses be checked as facts rather than by waiting: the test does not
 * sleep, yet it sees how long the code intended to wait.
 */
export function createTestClock(): TestClock {
  let current = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    sleep: (milliseconds: number) => {
      sleeps.push(milliseconds);
      current += milliseconds;
      return Promise.resolve();
    },
  };
}

import type { Clock } from "../../src/adapters/throttle.js";

export interface TestClock extends Clock {
  /** Задержки в том порядке, в каком их запрашивали. */
  readonly sleeps: readonly number[];
}

/**
 * Часы под управлением теста: время двигается только запрошенными паузами.
 *
 * Позволяет проверять паузы фактами, а не ожиданием: тест не спит, но видит,
 * сколько кода собирался ждать.
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

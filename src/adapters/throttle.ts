/**
 * Троттлинг обращений.
 *
 * Порт, а не опция: режима «без лимитов» не существует. Инструмент запускают
 * против чужих стендов, и положить чужой прод нагрузкой — худший из возможных
 * исходов прогона.
 *
 * Три ограничения одновременно: конкурентность, частота в скользящем окне
 * в одну секунду и общий потолок обращений на прогон.
 */

import type { Throttle } from "./ports.js";

/**
 * Источник времени.
 *
 * Вынесен наружу, чтобы паузы можно было проверять фактами, а не ожиданием:
 * тест подставляет свои часы и измеряет запрошенные задержки.
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
  /** Сколько обращений выполняется одновременно. */
  readonly concurrency: number;
  /** Сколько обращений допускается за скользящую секунду. */
  readonly requestsPerSecond: number;
  /** Потолок обращений на весь прогон. */
  readonly maxRequests: number;
}

/** Дефолты намеренно медленные: их повышают осознанно, под конкретный стенд. */
export const DEFAULT_THROTTLE_LIMITS: ThrottleLimits = {
  concurrency: 2,
  requestsPerSecond: 5,
  maxRequests: 2000,
};

export class RunBudgetExhaustedError extends Error {
  constructor(maxRequests: number) {
    super(
      `Исчерпан потолок обращений на прогон (${maxRequests}). ` +
        `Это защита от бесконтрольной нагрузки, а не ошибка конфигурации.`,
    );
    this.name = "RunBudgetExhaustedError";
  }
}

export class InvalidThrottleLimitsError extends Error {
  constructor(field: keyof ThrottleLimits, value: number) {
    super(`Предел "${field}" должен быть положительным числом, получено ${value}`);
    this.name = "InvalidThrottleLimitsError";
  }
}

const WINDOW_MS = 1000;

/**
 * Создаёт троттл.
 *
 * Нулевые и отрицательные пределы отвергаются: «ноль» здесь читался бы как
 * «без ограничений», а такого режима быть не должно.
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

  // Решения о допуске принимаются строго по очереди: иначе две задачи могли бы
  // одновременно увидеть свободный слот и обе его занять.
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
    // Действующие лимиты объявляются наружу: отчёту нужно напечатать их,
    // а вычислять слияние умолчаний с флагами второй раз в CLI значило бы
    // завести дубль, который разойдётся с настоящим поведением молча.
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

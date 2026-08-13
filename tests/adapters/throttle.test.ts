/**
 * Тесты троттлинга.
 *
 * Проверяют не наличие настроек, а фактическое поведение: сколько задач реально
 * шло одновременно и какие паузы были запрошены. Троттл, который «настроен», но
 * пропускает всплеск, положит чужой стенд ровно так же, как его отсутствие.
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

/** Задача, которая завершается по внешней команде. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("дефолты", () => {
  it("консервативны", () => {
    expect(DEFAULT_THROTTLE_LIMITS).toEqual({
      concurrency: 2,
      requestsPerSecond: 5,
      maxRequests: 2000,
    });
  });

  it("отвергают ноль и отрицательные значения: режима «без лимитов» нет", () => {
    expect(() => createThrottle({ concurrency: 0 })).toThrow(InvalidThrottleLimitsError);
    expect(() => createThrottle({ requestsPerSecond: -1 })).toThrow(InvalidThrottleLimitsError);
    expect(() => createThrottle({ maxRequests: 0 })).toThrow(InvalidThrottleLimitsError);
    expect(() => createThrottle({ concurrency: Number.POSITIVE_INFINITY })).toThrow(
      InvalidThrottleLimitsError,
    );
  });
});

describe("ограничение конкурентности", () => {
  it("никогда не превышает заданный предел", async () => {
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

    // Полный оборот очереди задач: цепочка допуска успевает раздать все слоты.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    // Занято ровно столько, сколько разрешено, — ни больше, ни меньше.
    expect(active).toBe(3);
    expect(peak).toBe(3);

    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.all(running);

    // Всплеска на разблокировке тоже быть не должно.
    expect(peak).toBe(3);
    expect(active).toBe(0);
  });

  it("освобождает слот даже если задача упала", async () => {
    const throttle = createThrottle({ concurrency: 1, requestsPerSecond: 1000 });

    await expect(throttle.run(() => Promise.reject(new Error("сбой обращения")))).rejects.toThrow(
      "сбой обращения",
    );

    // Слот должен освободиться, иначе следующий вызов повиснет навсегда.
    await expect(throttle.run(() => Promise.resolve("готово"))).resolves.toBe("готово");
  });
});

describe("ограничение частоты", () => {
  it("выдерживает паузу, когда окно исчерпано", async () => {
    const clock = createTestClock();
    const throttle = createThrottle({ concurrency: 10, requestsPerSecond: 3 }, clock);

    for (let i = 0; i < 3; i += 1) {
      await throttle.run(() => Promise.resolve());
    }
    expect(clock.sleeps).toEqual([]);

    // Четвёртое обращение обязано подождать до конца скользящей секунды.
    await throttle.run(() => Promise.resolve());
    expect(clock.sleeps).toEqual([1000]);
  });

  it("не тормозит, когда окно успело сдвинуться", async () => {
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

describe("потолок на прогон", () => {
  it("отказывает после исчерпания бюджета", async () => {
    const throttle = createThrottle({ concurrency: 5, requestsPerSecond: 1000, maxRequests: 3 });

    for (let i = 0; i < 3; i += 1) {
      await throttle.run(() => Promise.resolve(i));
    }

    await expect(throttle.run(() => Promise.resolve())).rejects.toThrow(RunBudgetExhaustedError);
  });

  it("не выполняет задачу, обращение к которой отклонено", async () => {
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
 * Числа умолчаний напечатаны в README как обещание пользователю: «инструмент
 * бежит по чужому стенду вот так осторожно». Молчаливое расхождение обещания
 * с кодом — ровно тот класс, против которого написан весь проект, поэтому
 * таблица в README проверяется тестом, а не глазами.
 */
describe("умолчания названы в README", () => {
  it("совпадают с таблицей «How much traffic it makes»", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");

    expect(readme).toContain(`| Concurrent requests | ${DEFAULT_THROTTLE_LIMITS.concurrency} |`);
    expect(readme).toContain(
      `| Requests per second | ${DEFAULT_THROTTLE_LIMITS.requestsPerSecond} |`,
    );
    expect(readme).toContain(`| Requests per run | ${DEFAULT_THROTTLE_LIMITS.maxRequests} |`);
  });
});

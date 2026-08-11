/**
 * Smoke-тест: доказывает, что цепочка TypeScript → тесты → сборка работает
 * и что ядро импортируется как библиотека.
 *
 * Бизнес-логики здесь нет — она появится в сессии 2 вместе с фикстурами.
 */

import { describe, expect, it } from "vitest";
import type { Check } from "../src/core/index.js";
import { CheckRegistry, DuplicateCheckIdError, SAFE_METHODS } from "../src/core/index.js";

const stubCheck: Check = {
  id: "stub.noop",
  description: "Заглушка для проверки реестра",
  severity: "info",
  standards: [{ standard: "OWASP-API-2023", clause: "API1" }],
  run: () => [],
};

describe("реестр проверок", () => {
  it("регистрирует проверку и отдаёт её по id", () => {
    const registry = new CheckRegistry();
    registry.register(stubCheck);

    expect(registry.size).toBe(1);
    expect(registry.get("stub.noop")).toBe(stubCheck);
    expect(registry.list()).toEqual([stubCheck]);
  });

  it("отвергает повторную регистрацию того же id", () => {
    const registry = new CheckRegistry();
    registry.register(stubCheck);

    expect(() => {
      registry.register(stubCheck);
    }).toThrow(DuplicateCheckIdError);
  });

  it("не имеет общего состояния между экземплярами", () => {
    const first = new CheckRegistry();
    const second = new CheckRegistry();
    first.register(stubCheck);

    expect(second.size).toBe(0);
  });
});

describe("инварианты безопасности", () => {
  it("без явного флага безопасными считаются только GET и HEAD", () => {
    expect([...SAFE_METHODS]).toEqual(["GET", "HEAD"]);
  });
});

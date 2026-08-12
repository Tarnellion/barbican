/**
 * Тесты кода возврата.
 *
 * Найдено состязательной проверкой: существовало три способа получить «чистый»
 * отчёт, ничего не проверив — спецификация без эндпоинтов, стенд со сплошными
 * ошибками и исчерпанный бюджет обращений. Во всех код возврата был 0,
 * то есть читался как подтверждение защищённости.
 */

import { describe, expect, it } from "vitest";
import type { RunReport } from "../../src/report/build.js";
import { exitCodeFor } from "../../src/report/build.js";

function report(overrides: {
  observations?: number;
  escalations?: number;
  probeErrors?: number;
  unauthenticated?: readonly string[];
}): RunReport {
  const observations = overrides.observations ?? 4;
  return {
    tool: { name: "barbican", version: "test" },
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-12T00:00:01.000Z",
    target: { baseUrl: "https://api.test", allowedHosts: ["api.test"] },
    accounts: [],
    endpoints: [],
    resources: [],
    skipped: [],
    failures: [],
    unauthenticated: overrides.unauthenticated ?? [],
    canariesChecked: 0,
    observations: [],
    findings: [],
    summary: {
      endpoints: 0,
      accounts: 0,
      resources: 0,
      observations,
      skipped: 0,
      failures: 0,
      findings: 0,
      byKind: {
        "privilege-escalation": overrides.escalations ?? 0,
        "unexpected-denial": 0,
        "not-observed": 0,
        "probe-error": overrides.probeErrors ?? 0,
      },
    },
  };
}

describe("exitCodeFor", () => {
  it("0 — проверено и чисто", () => {
    expect(exitCodeFor(report({}))).toBe(0);
  });

  it("1 — найдена эскалация", () => {
    expect(exitCodeFor(report({ escalations: 1 }))).toBe(1);
  });

  it("2 — не сделано ни одного наблюдения", () => {
    // Спецификация без эндпоинтов: находок нет, потому что не было проверки.
    expect(exitCodeFor(report({ observations: 0 }))).toBe(2);
  });

  it("2 — все обращения сорвались", () => {
    // Стенд лёг или сработал circuit breaker: судить не о чем.
    expect(exitCodeFor(report({ observations: 4, probeErrors: 4 }))).toBe(2);
  });

  it("2 — аутентификация не сработала", () => {
    expect(exitCodeFor(report({ unauthenticated: ["a"] }))).toBe(2);
  });

  it("недостоверность важнее находки", () => {
    // Эскалация на непроверенном прогоне — не повод отчитаться кодом 1.
    expect(exitCodeFor(report({ escalations: 1, unauthenticated: ["a"] }))).toBe(2);
  });

  it("частичные сбои не делают прогон недостоверным", () => {
    expect(exitCodeFor(report({ observations: 4, probeErrors: 3 }))).toBe(0);
  });
});

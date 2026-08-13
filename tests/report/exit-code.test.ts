/**
 * Тесты кода возврата.
 *
 * Найдено состязательной проверкой: существовало три способа получить «чистый»
 * отчёт, ничего не проверив — спецификация без эндпоинтов, стенд со сплошными
 * ошибками и исчерпанный бюджет обращений. Во всех код возврата был 0,
 * то есть читался как подтверждение защищённости.
 */

import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/core/index.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { RunReport } from "../../src/report/build.js";
import { buildReport, exitCodeFor } from "../../src/report/build.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`);

function report(overrides: {
  observations?: number;
  escalations?: number;
  probeErrors?: number;
  unauthenticated?: readonly string[];
  truncated?: boolean;
  checks?: readonly Finding[];
  denials?: number;
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
    canaries: [],
    truncated: overrides.truncated ?? false,
    observations: [],
    findings: [],
    checks: overrides.checks ?? [],
    defects: [],
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
        "unexpected-denial": overrides.denials ?? 0,
        "not-observed": 0,
        "probe-error": overrides.probeErrors ?? 0,
      },
      checkFindings: (overrides.checks ?? []).length,
      bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
      defectGroups: 0,
    },
  };
}

describe("сводка по серьёзности", () => {
  /**
   * Считались только расхождения матрицы, и сводка показывала high: 5 там, где
   * их 11. Дашборд по `bySeverity` терял шесть находок — и в их числе самую
   * эксплуатируемую: списочную утечку, видимую только по телу.
   * Найдено холодным чтением отчёта человеком, не знающим проекта.
   */
  it("считает и находки проверок, а не только расхождения матрицы", () => {
    const leak: Finding = {
      checkId: "identical-response-across-tenants",
      severity: "high",
      title: "одинаковый ответ у разных тенантов",
      evidence: {},
    };

    const built = buildReport({
      version: "test",
      config: CONFIG,
      endpoints: [],
      observations: [],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 0,
      truncated: false,
      findings: [],
      checks: [leak, leak],
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });

    expect(built.summary.bySeverity.high).toBe(2);
  });
});

describe("exitCodeFor", () => {
  /**
   * Расхождение есть расхождение, куда бы оно ни было направлено. Найдено
   * проверкой оракула референс-платформы: холдингу закрыли его собственный
   * бренд — платформа сломана, объявленный доступ не работает, — и прогон
   * вернул 0. См. ADR-0014.
   */
  it("1 — неожиданный отказ тоже расхождение", () => {
    expect(exitCodeFor(report({ denials: 1 }))).toBe(1);
  });

  /**
   * Находка проверки видна не по статусу, но это такое же расхождение.
   * Без этого прогон с найденной межтенантной утечкой выглядел бы в CI успешным.
   */
  it("1 — находка проверки высокой серьёзности", () => {
    const leak: Finding = {
      checkId: "identical-response-across-tenants",
      severity: "high",
      title: "одинаковый ответ у разных тенантов",
      evidence: {},
    };

    expect(exitCodeFor(report({ checks: [leak] }))).toBe(1);
  });

  it("0 — находка проверки только информационная", () => {
    const note: Finding = {
      checkId: "whatever",
      severity: "info",
      title: "к сведению",
      evidence: {},
    };

    expect(exitCodeFor(report({ checks: [note] }))).toBe(0);
  });

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

  // Найдено состязательной проверкой: потолок обращений обрывал матрицу
  // посреди прогона, непроверенная межтенантная утечка оставалась ненайденной,
  // а код возврата был 0.
  it("2 — прогон оборван, хвост матрицы не проверен", () => {
    expect(exitCodeFor(report({ truncated: true }))).toBe(2);
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

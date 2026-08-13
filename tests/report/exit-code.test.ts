/**
 * Тесты кода возврата.
 *
 * Найдено состязательной проверкой: существовало три способа получить «чистый»
 * отчёт, ничего не проверив — спецификация без эндпоинтов, стенд со сплошными
 * ошибками и исчерпанный бюджет обращений. Во всех код возврата был 0,
 * то есть читался как подтверждение защищённости.
 */

import { describe, expect, it } from "vitest";
import { parseRunConfig } from "../../src/io/config.js";
import type { ReportFinding, RunReport } from "../../src/report/build.js";
import { buildReport, exitCodeFor, REPORT_SCHEMA_VERSION } from "../../src/report/build.js";

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
  checks?: readonly ReportFinding[];
  denials?: number;
}): RunReport {
  const observations = overrides.observations ?? 4;
  return {
    schemaVersion: "1",
    runId: "00000000-0000-4000-8000-000000000000",
    configDigest: "0000000000000000",
    coverage: {
      endpointsTotal: 0,
      endpointsProbed: 0,
      cellsObserved: observations,
      cellsNotObserved: 0,
      notProbed: {},
      bodiesComparedOn: [],
      writeMethodsProbed: false,
      checksRun: [],
      bodyComparison: [],
      contextsProbed: {},
      cellsMatched: 0,
    },
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
    inputs: {
      policy: { fallback: "denied", rules: [] },
      tenants: [],
      auth: { kind: "bearer" },
      contexts: [],
    },
    truncated: overrides.truncated ?? false,
    observations: [],
    findings: overrides.checks ?? [],
    defects: [],
    summary: {
      endpoints: 0,
      accounts: 0,
      accountRows: 0,
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
      defectsBySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
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
      policy: { fallback: "denied", rules: [] },
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "одинаковый ответ у разных тенантов",
          accountId: "alice",
          endpointId: "orders.list",
          evidence: {},
        },
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "одинаковый ответ у разных тенантов",
          accountId: "bob",
          endpointId: "orders.list",
          evidence: {},
        },
      ],
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });

    expect(built.summary.bySeverity.high).toBe(2);
  });
});

describe("покрытие и опознание прогона", () => {
  function build(overrides: Record<string, unknown> = {}) {
    return buildReport({
      version: "test",
      config: CONFIG,
      endpoints: [
        { id: "a", method: "GET", path: "/a", responseMustDifferByTenant: true },
        { id: "b", method: "POST", path: "/b" },
      ],
      probed: [{ id: "a", method: "GET", path: "/a" }],
      observations: [],
      skipped: [{ endpointId: "b", reason: "unsafe-method" }],
      failures: [],
      unauthenticated: [],
      canariesChecked: 0,
      truncated: false,
      findings: [],
      policy: { fallback: "denied", rules: [] },
      startedAt: new Date(0),
      finishedAt: new Date(1),
      ...overrides,
    });
  }

  /**
   * Без знаменателя «опрошено шесть эндпоинтов» не значит ничего: это может
   * быть вся поверхность API, а может двадцатая её часть.
   */
  it("называет знаменатель, а не только числитель", () => {
    const coverage = build().coverage;

    expect(coverage.endpointsTotal).toBe(2);
    expect(coverage.endpointsProbed).toBe(1);
    expect(coverage.notProbed).toEqual({ "unsafe-method": 1 });
  });

  /**
   * Отсутствие находки на ручке, где тела не сравнивались, означает
   * «не проверяли», а не «совпадений нет». Разницу иначе не увидеть.
   */
  it("называет поимённо, где сравнивались тела", () => {
    expect(build().coverage.bodiesComparedOn).toEqual(["a"]);
  });

  it("говорит, выполнялись ли методы записи", () => {
    expect(build().coverage.writeMethodsProbed).toBe(false);
    expect(build({ unsafeMethods: true }).coverage.writeMethodsProbed).toBe(true);
  });

  /** Два отчёта иначе не отличить друг от друга и не продиффать. */
  it("даёт разный идентификатор разным прогонам", () => {
    expect(build().runId).not.toBe(build().runId);
  });

  /**
   * Отпечаток считается по разобранной конфигурации: комментарии и отступы
   * на результат прогона не влияют, а на хеш текста влияли бы.
   */
  it("даёт одинаковый отпечаток одной и той же конфигурации", () => {
    expect(build().configDigest).toBe(build().configDigest);
  });

  it("объявляет версию формы отчёта", () => {
    expect(build().schemaVersion).toBe(REPORT_SCHEMA_VERSION);
  });

  /**
   * Проверка, которую забыли зарегистрировать или которая упала, давала отчёт,
   * неотличимый от чистого: её ключ появляется в `byKind` только при находке.
   * Найдено вторым холодным чтением.
   */
  it("перечисляет выполненные проверки, включая ничего не нашедшие", () => {
    expect(build({ checksRun: ["identical-response-across-tenants"] }).coverage.checksRun).toEqual([
      "identical-response-across-tenants",
    ]);
  });

  /**
   * Счётчик считал только матричные расхождения и расходился с соседними
   * ровно на находки по телу. Тот же класс, что прежняя ошибка `bySeverity`,
   * в том же объекте — и я её не заметил, чиня соседнюю.
   */
  it("считает в findings весь список, а не только матричные расхождения", () => {
    const built = build({
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "x",
          accountId: "alice",
          endpointId: "a",
          evidence: {},
        },
      ],
    });

    expect(built.summary.findings).toBe(built.findings.length);
    expect(built.summary.findings).toBe(
      Object.values(built.summary.bySeverity).reduce((a, b) => a + b, 0),
    );
  });

  /**
   * Вторая сторона утечки лежала только в `evidence` каждой строки, и группа
   * дефекта называла одну сторону из двух: «данные тенанта-a видны кому-то».
   * Найдено холодным чтением.
   */
  it("называет в группе дефекта обе стороны парной находки", () => {
    const built = build({
      checks: [
        {
          checkId: "identical-response-across-tenants",
          severity: "high",
          title: "совпал дайджест",
          accountId: "alice",
          endpointId: "a",
          evidence: { otherAccountId: "carol-b", bodyDigestsEqual: true },
        },
      ],
    });

    expect(built.defects[0]?.accountIds).toEqual(["alice", "carol-b"]);
  });

  /**
   * Без явной пометки единственный положительный вывод отчёта — «аноним всюду
   * получил отказ» — недоказуем: аккаунт с ошибочно поданным токеном выглядел
   * бы точно так же.
   */
  it("помечает аккаунт без учётных данных как анонимный", () => {
    const withAnon = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: u, role: r, tenant: t, tokenEnv: T }
  - { id: anon, role: anonymous }
policy: { fallback: denied, rules: [] }
`);

    const accounts = build({ config: withAnon }).accounts;

    expect(accounts.find((a) => a.id === "u")?.anonymous).toBe(false);
    expect(accounts.find((a) => a.id === "anon")?.anonymous).toBe(true);
  });
});

describe("аккаунты в условиях", () => {
  const WITH_CONTEXT = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [a], context: geo, outcome: denied }
contexts:
  - { id: geo, headers: { cf-ipcountry: AQ }, endpoints: [a] }
`);

  function build() {
    return buildReport({
      version: "test",
      config: WITH_CONTEXT,
      endpoints: [{ id: "a", method: "GET", path: "/a" }],
      observations: [
        {
          accountId: "u@geo",
          endpointId: "a",
          status: 451,
          outcome: "denied",
          headers: {},
          durationMs: 1,
        },
      ],
      skipped: [],
      failures: [],
      unauthenticated: [],
      canariesChecked: 0,
      truncated: false,
      findings: [],
      policy: { fallback: "denied", rules: [] },
      accounts: [
        { id: "u", roleId: "r", tenantId: "t" },
        { id: "u@geo", roleId: "r", tenantId: "t", contextId: "geo", baseAccountId: "u" },
      ],
      startedAt: new Date(0),
      finishedAt: new Date(1),
    });
  }

  /**
   * Находка ссылается на аккаунт в условиях. Без строки в списке аккаунтов
   * ссылка повисает: читатель видит `u@geo`, ищет его и не находит.
   */
  it("перечисляет аккаунт в условиях наравне с базовым", () => {
    const accounts = build().accounts;

    expect(accounts.map((account) => account.id)).toEqual(["u", "u@geo"]);
    expect(accounts[1]).toMatchObject({
      contextId: "geo",
      baseAccountId: "u",
      role: "r",
      tenant: "t",
    });
  });

  /** Атрибуты печатаются: иначе находку в условиях нечем воспроизвести. */
  it("печатает объявленные условия вместе с атрибутами", () => {
    expect(build().inputs.contexts).toEqual([
      {
        id: "geo",
        headers: { "cf-ipcountry": "AQ" },
        query: {},
        endpointIds: ["a"],
        accountIds: [],
      },
    ]);
  });

  /**
   * Ноль здесь означает «условия объявлены, но не проверены»: их ручки могли
   * уйти в skipped, а отсутствие находок читалось бы как «под этими условиями
   * всё в порядке».
   */
  it("считает пронаблюдённые ячейки по каждым условиям", () => {
    expect(build().coverage.contextsProbed).toEqual({ geo: 1 });
  });

  /**
   * «Проверено и совпало» существовало только как вычитание, которое читатель
   * делал сам. Числом оно проверяемо: сумма с расхождениями даёт наблюдения.
   */
  it("называет число совпавших ячеек, а не оставляет его вычитанием", () => {
    const built = build();

    expect(built.coverage.cellsMatched).toBe(1);
    const discrepancies = Object.values(built.summary.byKind).reduce((a, b) => a + b, 0);
    expect(built.coverage.cellsMatched + discrepancies).toBe(built.coverage.cellsObserved);
  });

  /** 9 аккаунтов × 6 ручек не давало 135 ячеек, и арифметика не сходилась. */
  it("различает объявленные аккаунты и строки матрицы", () => {
    const built = build();

    expect(built.summary.accounts).toBe(1);
    expect(built.summary.accountRows).toBe(2);
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
    const leak: ReportFinding = {
      kind: "identical-response-across-tenants",
      source: "check",
      severity: "high",
      accountId: "alice",
      endpointId: "orders.list",
      title: "одинаковый ответ у разных тенантов",
    };

    expect(exitCodeFor(report({ checks: [leak] }))).toBe(1);
  });

  it("0 — находка проверки только информационная", () => {
    const note: ReportFinding = {
      kind: "whatever",
      source: "check",
      severity: "info",
      accountId: "alice",
      endpointId: "ping",
      title: "к сведению",
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

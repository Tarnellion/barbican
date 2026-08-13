import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy } from "../../src/core/index.js";
import {
  ANY,
  buildAccessMatrix,
  diffAccess,
  resolveExpectedVerdict,
  severityOf,
} from "../../src/core/index.js";
import {
  accounts,
  cleanObservations,
  denialObservations,
  endpoints,
  escalationObservations,
  observe,
  policy,
} from "../fixtures/scenario.js";

function matrixWith(observations: Parameters<typeof buildAccessMatrix>[0]["observations"]) {
  return buildAccessMatrix({ endpoints, accounts, observations });
}

describe("серьёзность расхождения", () => {
  /**
   * Вычисляется из вида и отношения, а не объявляется человеком: человек
   * объявляет ожидание, серьёзность же есть свойство найденного расхождения.
   * Таблица — ADR-0014.
   */
  it.each([
    ["privilege-escalation" as const, "foreign-tenant" as const, "critical"],
    ["privilege-escalation" as const, "ancestor-tenant" as const, "high"],
    ["privilege-escalation" as const, "same-tenant" as const, "high"],
    ["privilege-escalation" as const, "descendant-tenant" as const, "high"],
    ["privilege-escalation" as const, undefined, "high"],
    ["privilege-escalation" as const, "own" as const, "medium"],
    ["unexpected-denial" as const, "foreign-tenant" as const, "medium"],
    ["not-observed" as const, undefined, "low"],
    ["probe-error" as const, undefined, "low"],
  ])("%s при отношении %s даёт %s", (kind, relation, expected) => {
    expect(severityOf(kind, relation)).toBe(expected);
  });
});

describe("ссылка на правило", () => {
  /**
   * Политика в отчёте есть, но искать среди десятка правил то, которое объявило
   * доступ запрещённым, — работа, которую инструмент может сделать сам.
   */
  it("называет правило, давшее ожидание", () => {
    const policy: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        { roles: ANY, endpoints: ["a"], outcome: "allowed" },
        { roles: ["player"], endpoints: ["a"], outcome: "denied" },
      ],
    };

    expect(resolveExpectedVerdict(policy, "player", "a")).toEqual({
      outcome: "denied",
      ruleIndex: 1,
    });
  });

  /**
   * Отсутствие номера — содержательный ответ «ни одно правило не подошло»,
   * а не пропуск поля.
   */
  it("не называет правила, когда сработал fallback", () => {
    const policy: ResolvedAccessPolicy = { fallback: "denied", rules: [] };

    expect(resolveExpectedVerdict(policy, "player", "a")).toEqual({ outcome: "denied" });
  });

  /** Побеждает последнее подошедшее — номер обязан указывать на него же. */
  it("указывает на последнее подошедшее правило, а не на первое", () => {
    const policy: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        { roles: ANY, endpoints: ANY, outcome: "allowed" },
        { roles: ANY, endpoints: ANY, outcome: "denied" },
      ],
    };

    expect(resolveExpectedVerdict(policy, "any", "any").ruleIndex).toBe(1);
  });
});

describe("diffAccess", () => {
  // Главный тест набора. Инструмент, находящий несуществующее, теряет доверие
  // быстрее, чем тот, который что-то пропускает.
  it("не находит ничего, когда платформа ведёт себя как объявлено", () => {
    expect(diffAccess(matrixWith(cleanObservations), policy)).toEqual([]);
  });

  it("находит эскалацию привилегий: ожидался отказ, доступ получен", () => {
    const diffs = diffAccess(matrixWith(escalationObservations), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        actual: "allowed",
        kind: "privilege-escalation",
        severity: "high",
      },
    ]);
  });

  it("находит неожиданный отказ: ожидался доступ, получен отказ", () => {
    const diffs = diffAccess(matrixWith(denialObservations), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.support.a",
        endpointId: "ep.tickets.list",
        expected: "allowed",
        actual: "denied",
        kind: "unexpected-denial",
        // Правило, объявившее доступ положенным. Находка называет его сама,
        // чтобы читателю не искать среди десятка правил.
        ruleIndex: 2,
        severity: "medium",
      },
    ]);
  });

  it("сообщает о непокрытой паре вместо того, чтобы додумать исход", () => {
    const partial = cleanObservations.filter(
      (o) => !(o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"),
    );

    const diffs = diffAccess(matrixWith(partial), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        kind: "not-observed",
        severity: "low",
      },
    ]);
  });

  it("не делает вывода о доступе, если обращение завершилось ошибкой", () => {
    const withError = cleanObservations.map((o) =>
      o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"
        ? observe(o.accountId, o.endpointId, "error")
        : o,
    );

    const diffs = diffAccess(matrixWith(withError), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        actual: "error",
        kind: "probe-error",
        severity: "low",
      },
    ]);
  });

  it("считает 404 отказом, а не отдельным расхождением", () => {
    const withNotFound = cleanObservations.map((o) =>
      o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"
        ? observe(o.accountId, o.endpointId, "not-found")
        : o,
    );

    expect(diffAccess(matrixWith(withNotFound), policy)).toEqual([]);
  });

  it("выдаёт расхождения в детерминированном порядке", () => {
    const broken = cleanObservations.map((o) =>
      o.endpointId === "ep.users.list" && o.accountId !== "acc.admin.a"
        ? observe(o.accountId, o.endpointId, "allowed")
        : o,
    );

    const first = diffAccess(matrixWith(broken), policy);
    const second = diffAccess(matrixWith(broken), policy);

    expect(first).toEqual(second);
    expect(first.map((d) => d.accountId)).toEqual([
      "acc.player.a",
      "acc.support.a",
      "acc.player.b",
    ]);
  });
});

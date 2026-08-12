/**
 * Тесты признака недостоверного прогона.
 *
 * Сценарий, ради которого всё это существует: токен протух, обращения вернули
 * 401, 401 прочиталось как отказ, отказ совпал с ожиданием — и отчёт сказал
 * «эскалаций не найдено», не проверив ничего.
 *
 * Первая версия проверки требовала 401 на всех обращениях подряд и на живом
 * стенде промолчала: хватило одного публичного эндпоинта. Здесь закреплено
 * именно то поведение, которого не хватило.
 */

import { describe, expect, it } from "vitest";
import type { AccessObservation, Account, ExpectedAccessPolicy } from "../../src/core/index.js";
import { ANY } from "../../src/core/index.js";
import { findUnauthenticated } from "../../src/report/authenticity.js";

const accounts: readonly Account[] = [
  { id: "user", roleId: "user", tenantId: "t" },
  { id: "admin", roleId: "admin", tenantId: "t" },
];

const policy: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [
    { roles: ANY, endpoints: ["me"], outcome: "allowed" },
    { roles: ["admin"], endpoints: ANY, outcome: "allowed" },
  ],
};

function observe(accountId: string, endpointId: string, status: number): AccessObservation {
  const outcome =
    status >= 200 && status < 300 ? "allowed" : status === 404 ? "not-found" : "denied";
  return { accountId, endpointId, status, headers: {}, outcome, durationMs: 1 };
}

describe("findUnauthenticated", () => {
  it("молчит, когда всё работает", () => {
    const observations = [
      observe("user", "me", 200),
      observe("user", "users.list", 403),
      observe("admin", "me", 200),
      observe("admin", "users.list", 200),
    ];

    expect(findUnauthenticated(accounts, observations, policy)).toEqual([]);
  });

  // Ровно тот случай, который проглядела первая версия: публичный эндпоинт
  // отвечает 200 всем, поэтому «все обращения вернули 401» не выполняется.
  it("замечает сломанную аутентификацию, даже если часть эндпоинтов открыта всем", () => {
    const observations = [observe("user", "me", 401), observe("user", "users.list", 200)];

    expect(findUnauthenticated(accounts, observations, policy)).toEqual([
      { accountId: "user", expectedAllowed: 1, refused: 1, dominantStatus: 401 },
    ]);
  });

  it("не поднимает тревогу на частичном отказе: это обычная находка", () => {
    const observations = [observe("admin", "me", 401), observe("admin", "users.list", 200)];

    // Половина объявленного доступна — значит вход состоялся, а расхождение
    // разбирается как «неожиданный отказ».
    expect(findUnauthenticated(accounts, observations, policy)).toEqual([]);
  });

  it("не судит об аккаунте, которому по политике ничего не положено", () => {
    const closed: ExpectedAccessPolicy = { fallback: "denied", rules: [] };
    const observations = [observe("user", "me", 401)];

    // Нет объявленного доступа — не с чем сравнивать, тревога была бы выдумкой.
    expect(findUnauthenticated(accounts, observations, closed)).toEqual([]);
  });

  // Разведка crAPI: identity-сервис отвечает 404 там, где workshop отвечает 401.
  // Сплошные 404 — ещё и типичный признак неверного baseUrl или префикса пути.
  it("замечает сплошные 404 так же, как сплошные 401", () => {
    const observations = [observe("user", "me", 404)];

    expect(findUnauthenticated(accounts, observations, policy)).toEqual([
      { accountId: "user", expectedAllowed: 1, refused: 1, dominantStatus: 404 },
    ]);
  });

  it("подсказывает преобладающий статус отказа", () => {
    const wide: ExpectedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: ANY, endpoints: ANY, outcome: "allowed" }],
    };
    const observations = [
      observe("user", "a", 404),
      observe("user", "b", 404),
      observe("user", "c", 401),
    ];

    expect(findUnauthenticated(accounts, observations, wide)).toEqual([
      { accountId: "user", expectedAllowed: 3, refused: 3, dominantStatus: 404 },
    ]);
  });
});

// Регрессия, внесённая переходом на трёхмерную матрицу: правила со `scope`
// не применялись без отношения, поэтому у политики в стиле ADR-0010 счётчик
// объявленного доступа оставался нулевым и предохранитель молчал всегда.
describe("политика с областью действия", () => {
  const scoped: ExpectedAccessPolicy = {
    fallback: "denied",
    rules: [{ roles: ANY, endpoints: ["profile"], scope: "own", outcome: "allowed" }],
  };
  const accounts: readonly Account[] = [{ id: "u", roleId: "player", tenantId: "t" }];
  const resources = [{ id: "mine", tenantId: "t", ownerAccountId: "u", params: { id: "1" } }];

  function observeResource(status: number): AccessObservation {
    return {
      accountId: "u",
      endpointId: "profile",
      resourceId: "mine",
      status,
      headers: {},
      outcome: status >= 200 && status < 300 ? "allowed" : "denied",
      durationMs: 1,
    };
  }

  it("замечает сломанную аутентификацию и при политике целиком на scope", () => {
    expect(findUnauthenticated(accounts, [observeResource(401)], scoped, resources)).toEqual([
      { accountId: "u", expectedAllowed: 1, refused: 1, dominantStatus: 401 },
    ]);
  });

  it("молчит, когда свой объект доступен", () => {
    expect(findUnauthenticated(accounts, [observeResource(200)], scoped, resources)).toEqual([]);
  });
});

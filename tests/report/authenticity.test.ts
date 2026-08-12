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
  return {
    accountId,
    endpointId,
    status,
    headers: {},
    outcome: status === 401 ? "denied" : "allowed",
    durationMs: 1,
  };
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
      { accountId: "user", expectedAllowed: 1, unauthorized: 1 },
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

  it("различает 401 и 403", () => {
    const observations = [observe("user", "me", 403)];

    // 403 — это «вошёл, но не положено», то есть аутентификация состоялась.
    expect(findUnauthenticated(accounts, observations, policy)).toEqual([]);
  });
});

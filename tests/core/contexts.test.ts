/**
 * Тесты условий обращения — минимального полезного куска ABAC (ADR-0019).
 *
 * Проверяется главное свойство: условия — отдельное измерение ячейки, а не
 * пометка на аккаунте. Роль, тенант и объект в них те же самые, и «доступ
 * положен» с «доступ положен из этой страны» — разные утверждения.
 */

import { describe, expect, it } from "vitest";
import type { AccessMatrix } from "../../src/core/index.js";
import { diffAccess, groupDefects } from "../../src/core/index.js";

const ENDPOINTS = [
  { id: "orders.list", method: "GET", path: "/v1/orders" },
  { id: "health", method: "GET", path: "/v1/health" },
] as const;

const POLICY = {
  fallback: "denied",
  rules: [
    { roles: ["user"], endpoints: ["orders.list"], outcome: "allowed" },
    { roles: "*", endpoints: ["orders.list"], context: "geo-blocked", outcome: "denied" },
  ],
} as const;

function matrix(
  observations: AccessMatrix["observations"],
  // По умолчанию одна ручка: `health` не наблюдается и дал бы «не пронаблюдено»
  // на базовом аккаунте, зашумив утверждение теста.
  endpoints: AccessMatrix["endpoints"] = [ENDPOINTS[0]],
): AccessMatrix {
  return {
    endpoints,
    accounts: [
      { id: "alice", roleId: "user", tenantId: "tenant-a" },
      {
        id: "alice@geo-blocked",
        roleId: "user",
        tenantId: "tenant-a",
        contextId: "geo-blocked",
        endpointIds: ["orders.list"],
      },
    ],
    resources: [],
    observations,
  };
}

describe("условия как измерение ячейки", () => {
  /**
   * Та же роль, тот же тенант, та же ручка — и разный ожидаемый исход.
   * Без отдельного измерения эти две ячейки неразличимы, и дефект гео-обхода
   * невыразим: «alice видит свои заказы» верно в обоих случаях.
   */
  it("судит одну и ту же ячейку по-разному в разных условиях", () => {
    const findings = diffAccess(
      matrix([
        {
          accountId: "alice",
          endpointId: "orders.list",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
        {
          accountId: "alice@geo-blocked",
          endpointId: "orders.list",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
      ]),
      POLICY,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.accountId).toBe("alice@geo-blocked");
    expect(findings[0]?.contextId).toBe("geo-blocked");
    expect(findings[0]?.kind).toBe("privilege-escalation");
  });

  /**
   * Правило без условий действует только в базовых. Иначе объявление новых
   * условий молча распространило бы на них все прежние ожидания: платформа,
   * законно закрывающая ручку из запрещённой страны, дала бы «неожиданный
   * отказ» на каждой ячейке.
   */
  it("не переносит ожидания базовых условий на объявленные", () => {
    const findings = diffAccess(
      matrix([
        {
          accountId: "alice",
          endpointId: "orders.list",
          status: 200,
          outcome: "allowed",
          headers: {},
          durationMs: 1,
        },
        {
          accountId: "alice@geo-blocked",
          endpointId: "orders.list",
          status: 451,
          outcome: "denied",
          headers: {},
          durationMs: 1,
        },
      ]),
      POLICY,
    );

    expect(findings).toEqual([]);
  });

  /**
   * Условия объявляются на конкретных ручках, и на остальных ячейки не бывает.
   * Иначе аккаунт в условиях дал бы «объявлено, но не пронаблюдено» на всей
   * поверхности API — выдуманную дыру в покрытии.
   */
  it("не считает пропущенной ручку, на которой условия не объявлены", () => {
    const findings = diffAccess(
      matrix(
        [
          {
            accountId: "alice",
            endpointId: "orders.list",
            status: 200,
            outcome: "allowed",
            headers: {},
            durationMs: 1,
          },
          {
            accountId: "alice",
            endpointId: "health",
            status: 200,
            outcome: "allowed",
            headers: {},
            durationMs: 1,
          },
          {
            accountId: "alice@geo-blocked",
            endpointId: "orders.list",
            status: 451,
            outcome: "denied",
            headers: {},
            durationMs: 1,
          },
        ],
        [...ENDPOINTS],
      ),
      POLICY,
    );

    expect(findings.filter((finding) => finding.kind === "not-observed")).toEqual([]);
  });
});

describe("группировка дефектов", () => {
  /**
   * Проверка страны и проверка прав — разные механизмы платформы: ломаются
   * независимо и чинятся в разных местах. Схлопнув их в один дефект,
   * отчёт сказал бы «дефект один», а починка закрыла бы половину.
   */
  it("не сливает расхождение в условиях с таким же в базовых", () => {
    const groups = groupDefects([
      {
        accountId: "alice",
        endpointId: "orders.list",
        kind: "privilege-escalation",
        severity: "high",
      },
      {
        accountId: "alice@geo-blocked",
        endpointId: "orders.list",
        contextId: "geo-blocked",
        kind: "privilege-escalation",
        severity: "high",
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.contextId)).toEqual(
      expect.arrayContaining([undefined, "geo-blocked"]),
    );
  });
});

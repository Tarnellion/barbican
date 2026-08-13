/**
 * Тесты условий обращения — минимального полезного куска ABAC (ADR-0019).
 *
 * Проверяется главное свойство: условия — отдельное измерение ячейки, а не
 * пометка на аккаунте. Роль, тенант и объект в них те же самые, и «доступ
 * положен» с «доступ положен из этой страны» — разные утверждения.
 */

import { describe, expect, it } from "vitest";
import type { AccessMatrix } from "../../src/core/index.js";
import {
  describeCells,
  diffAccess,
  groupDefects,
  principalOf,
  relationOf,
} from "../../src/core/index.js";

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

describe("тождество аккаунта в условиях", () => {
  /**
   * Найдено холодным чтением отчёта. Владельцем объекта записан `alice`,
   * а строка матрицы называется `alice@geo-blocked`, и сверка по строке
   * давала `same-tenant` вместо `own`: серьёзность поднималась с medium
   * до high, а группа дефектов `own` пропадала из отчёта целиком.
   *
   * Условия меняют обращение, а не того, кто его делает.
   */
  it("не отменяет владение объектом", () => {
    const own = { id: "order-1", tenantId: "tenant-a", ownerAccountId: "alice", params: {} };
    const inContext = {
      id: "alice@geo-blocked",
      roleId: "user",
      tenantId: "tenant-a",
      contextId: "geo-blocked",
      baseAccountId: "alice",
    } as const;

    expect(relationOf(inContext, own)).toBe("own");
    expect(principalOf(inContext)).toBe("alice");
    // Без ссылки на исходный аккаунт — прежнее неверное поведение.
    expect(relationOf({ id: "alice@geo-blocked", roleId: "user", tenantId: "tenant-a" }, own)).toBe(
      "same-tenant",
    );
  });
});

describe("вердикты по ячейкам", () => {
  const observations = [
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
  ] as const;

  /**
   * С объектом — отдельная ветка обхода, и без неё тест был бы пустым:
   * мутация «расхождение с объектом объявлено совпавшим» проходила зелёной,
   * потому что в фикстуре не было ни одного объекта.
   */
  const WITH_RESOURCE: AccessMatrix = {
    endpoints: [{ id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" }],
    accounts: [{ id: "alice", roleId: "user", tenantId: "tenant-a" }],
    resources: [
      { id: "own", tenantId: "tenant-a", ownerAccountId: "alice", params: { orderId: "1" } },
      { id: "neighbour", tenantId: "tenant-a", ownerAccountId: "bob", params: { orderId: "2" } },
    ],
    observations: [
      {
        accountId: "alice",
        endpointId: "orders.read",
        resourceId: "own",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
      },
      {
        accountId: "alice",
        endpointId: "orders.read",
        resourceId: "neighbour",
        status: 200,
        outcome: "allowed",
        headers: {},
        durationMs: 1,
      },
    ],
  };

  const RESOURCE_POLICY = {
    fallback: "denied",
    rules: [{ roles: ["user"], endpoints: ["orders.read"], scope: "own", outcome: "allowed" }],
  } as const;

  /**
   * Главный инвариант: расхождения — это ровно те же ячейки с `match: false`.
   * Два независимых прохода разошлись бы, и отчёт утверждал бы «проверено
   * и совпало» о ячейке, попавшей в находки. См. ADR-0020.
   */
  it("даёт те же расхождения, что и дифф, на ячейках с объектом", () => {
    const cells = describeCells(WITH_RESOURCE, RESOURCE_POLICY);
    const findings = diffAccess(WITH_RESOURCE, RESOURCE_POLICY);

    expect(cells.map((cell) => [cell.resourceId, cell.match])).toEqual([
      ["own", true],
      ["neighbour", false],
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.resourceId).toBe("neighbour");
  });

  it("даёт те же расхождения, что и дифф, ячейка в ячейку", () => {
    const built = matrix([...observations]);
    const cells = describeCells(built, POLICY);
    const findings = diffAccess(built, POLICY);

    const key = (c: { accountId: string; endpointId: string; resourceId?: string }) =>
      `${c.accountId} ${c.endpointId} ${c.resourceId ?? ""}`;
    expect(
      cells
        .filter((cell) => !cell.match)
        .map(key)
        .sort(),
    ).toEqual(findings.map(key).sort());
  });

  it("описывает и совпавшие ячейки, а не только расхождения", () => {
    const cells = describeCells(matrix([...observations]), POLICY);

    const matched = cells.find((cell) => cell.match);
    expect(matched?.accountId).toBe("alice");
    expect(matched?.expected).toBe("allowed");
    // Правило, объявившее ожидание, названо и у совпавшей ячейки: иначе
    // «проверено» нельзя оспорить, не перечитывая политику целиком.
    expect(matched?.ruleIndex).toBe(0);
  });

  it("не пропускает ни одной ячейки матрицы", () => {
    const cells = describeCells(matrix([...observations]), POLICY);

    // Две строки аккаунтов × одна ручка: аккаунт в условиях существует только
    // на объявленных, поэтому ячеек ровно две.
    expect(cells).toHaveLength(2);
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

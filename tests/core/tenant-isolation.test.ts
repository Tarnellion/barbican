/**
 * Тесты проверки изоляции тенантов по сигналам.
 *
 * Фикстуры написаны вручную: наблюдения с дайджестами задаются числами прямо
 * здесь. Сгенерировать их прогоном значило бы проверять согласованность
 * инструмента с самим собой.
 */

import { describe, expect, it } from "vitest";
import { createIdenticalResponseCheck } from "../../src/core/checks/tenant-isolation.js";
import type { AccessMatrix, AccessObservation, Account, Endpoint } from "../../src/core/types.js";

const ACCOUNTS: readonly Account[] = [
  { id: "alice-a", roleId: "user", tenantId: "tenant-a" },
  { id: "bob-a", roleId: "user", tenantId: "tenant-a" },
  { id: "carol-b", roleId: "user", tenantId: "tenant-b" },
];

const LIST: Endpoint = {
  id: "orders-list",
  method: "GET",
  path: "/v1/orders",
  tenantScoped: true,
};

function observed(
  accountId: string,
  digest: number,
  overrides: Partial<AccessObservation> = {},
): AccessObservation {
  return {
    endpointId: "orders-list",
    accountId,
    status: 200,
    headers: {},
    outcome: "allowed",
    durationMs: 1,
    signals: { digest },
    ...overrides,
  };
}

function matrixOf(
  observations: readonly AccessObservation[],
  endpoint: Endpoint = LIST,
): AccessMatrix {
  return { endpoints: [endpoint], accounts: ACCOUNTS, resources: [], observations };
}

const check = createIdenticalResponseCheck();

describe("маппинг на стандарты", () => {
  /**
   * Заявка о покрытии — тоже утверждение, и завышать её нельзя. API3 (BOPLA)
   * про уровень полей, а проверка сравнивает ответ целиком и о полях ничего
   * не знает. CWE-285, а не 862/863: снаружи «проверки нет» и «проверка есть,
   * но неверна» неотличимы.
   */
  it("не числится за классами, которые не умеет находить", () => {
    const clauses = check.standards.map((ref) => `${ref.standard}:${ref.clause}`);

    expect(clauses).toEqual(["OWASP-API-2023:API1", "OWASP-ASVS-5.0:8.4.1", "CWE:285"]);
    expect(clauses).not.toContain("OWASP-API-2023:API3");
  });
});

describe("identical-response-across-tenants", () => {
  it("находит одинаковый ответ у аккаунтов из разных тенантов", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.endpointId).toBe("orders-list");
    expect(findings[0]?.evidence["otherTenant"]).toBe("tenant-b");
  });

  it("молчит, когда ответы различаются", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 222)]),
    });

    expect(findings).toEqual([]);
  });

  /** Внутри одного тенанта одинаковый список — норма, а не утечка. */
  it("молчит на совпадении внутри одного тенанта", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("bob-a", 111)]),
    });

    expect(findings).toEqual([]);
  });

  /**
   * Без пометки человеком `GET /v1/health` с одинаковым для всех `{"status":"ok"}`
   * стал бы находкой, и настоящие утечки утонули бы в шуме.
   */
  it("молчит на эндпоинте без пометки tenantScoped", () => {
    const findings = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)], {
        id: "orders-list",
        method: "GET",
        path: "/v1/orders",
      }),
    });

    expect(findings).toEqual([]);
  });

  /**
   * Когда объект задан, оба аккаунта читают одну запись: одинаковый ответ —
   * следствие уже видимого по статусу доступа, а не отдельный дефект.
   */
  it("не считает дефект дважды, когда обращение шло к конкретному объекту", () => {
    const findings = check.run({
      matrix: matrixOf([
        observed("alice-a", 111, { resourceId: "order-1" }),
        observed("carol-b", 111, { resourceId: "order-1" }),
      ]),
    });

    expect(findings).toEqual([]);
  });

  it("не сравнивает отказы", () => {
    const findings = check.run({
      matrix: matrixOf([
        observed("alice-a", 111, { outcome: "denied", status: 403 }),
        observed("carol-b", 111, { outcome: "denied", status: 403 }),
      ]),
    });

    expect(findings).toEqual([]);
  });

  it("молчит, когда сигнал не вычислен: судить не о чем", () => {
    const findings = check.run({
      matrix: matrixOf([
        observed("alice-a", 111, { signals: {} }),
        observed("carol-b", 111, { signals: {} }),
      ]),
    });

    expect(findings).toEqual([]);
  });

  it("выдаёт находки в устойчивом порядке", () => {
    const first = check.run({
      matrix: matrixOf([observed("carol-b", 111), observed("alice-a", 111)]),
    });
    const second = check.run({
      matrix: matrixOf([observed("alice-a", 111), observed("carol-b", 111)]),
    });

    expect(first).toEqual(second);
  });
});

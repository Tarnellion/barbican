/**
 * Тесты группировки расхождений по сигнатуре.
 *
 * Задача пришла с прогонов: три BOLA в crAPI дали шесть строк, один
 * отсутствующий фильтр на референс-платформе — десять. Числа в отчёте
 * говорили о размере матрицы, а не о количестве проблем.
 */

import { describe, expect, it } from "vitest";
import { groupDefects } from "../../src/core/defects.js";
import type { AccessDiff } from "../../src/core/types.js";

function escalation(
  accountId: string,
  endpointId: string,
  overrides: Partial<AccessDiff> = {},
): AccessDiff {
  return {
    accountId,
    endpointId,
    expected: "denied",
    actual: "allowed",
    kind: "privilege-escalation",
    severity: "high",
    ...overrides,
  };
}

describe("groupDefects", () => {
  /** Ровно случай crAPI: один дефект, увиденный пользователем и админом. */
  it("сводит наблюдения одного дефекта с разных точек в одну сигнатуру", () => {
    const groups = groupDefects([
      escalation("user", "orders.read", { resourceId: "o-1", relation: "foreign-tenant" }),
      escalation("admin", "orders.read", { resourceId: "o-1", relation: "foreign-tenant" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.observations).toBe(2);
    expect(groups[0]?.accountIds).toEqual(["admin", "user"]);
  });

  /**
   * Разные отношения — разные дефекты: BOLA внутри тенанта и межтенантная
   * утечка живут на одной ручке, но ломаются независимо.
   */
  it("не смешивает разные отношения на одном эндпоинте", () => {
    const groups = groupDefects([
      escalation("a", "orders.read", { resourceId: "o-1", relation: "foreign-tenant" }),
      escalation("a", "orders.read", { resourceId: "o-2", relation: "same-tenant" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("не смешивает разные эндпоинты и разные виды расхождений", () => {
    const groups = groupDefects([
      escalation("a", "orders.read"),
      escalation("a", "users.list"),
      escalation("a", "orders.read", { kind: "unexpected-denial", severity: "medium" }),
    ]);

    expect(groups).toHaveLength(3);
  });

  /** Роль в сигнатуру не входит: открытая всем ручка — один дефект, не два. */
  it("собирает объекты и аккаунты группы", () => {
    const groups = groupDefects([
      escalation("a", "orders.read", { resourceId: "o-1", relation: "foreign-tenant" }),
      escalation("b", "orders.read", { resourceId: "o-2", relation: "foreign-tenant" }),
    ]);

    expect(groups[0]?.resourceIds).toEqual(["o-1", "o-2"]);
    expect(groups[0]?.accountIds).toEqual(["a", "b"]);
    expect(groups[0]?.observations).toBe(2);
  });

  it("берёт наибольшую серьёзность группы", () => {
    const groups = groupDefects([
      escalation("a", "orders.read", { relation: "foreign-tenant", severity: "high" }),
      escalation("b", "orders.read", { relation: "foreign-tenant", severity: "critical" }),
    ]);

    expect(groups[0]?.severity).toBe("critical");
  });

  it("ставит критические выше и не зависит от порядка входа", () => {
    const low = escalation("a", "aaa", { kind: "not-observed", severity: "low" });
    const critical = escalation("b", "zzz", { relation: "foreign-tenant", severity: "critical" });

    expect(groupDefects([low, critical]).map((group) => group.severity)).toEqual([
      "critical",
      "low",
    ]);
    expect(groupDefects([critical, low])).toEqual(groupDefects([low, critical]));
  });

  it("на пустом входе не выдумывает групп", () => {
    expect(groupDefects([])).toEqual([]);
  });
});

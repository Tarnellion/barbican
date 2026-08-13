/**
 * Тесты отбора эндпоинтов по шаблону.
 *
 * Задача висела с самой первой сессии: на сотне ручек перечисление по `id`
 * неподдерживаемо, а расходится оно с реальностью молча — непокрытая пара
 * уходит в `fallback`, и отчёт остаётся чистым.
 */

import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy } from "../../src/core/expected.js";
import { ANY, expandPolicy } from "../../src/core/expected.js";
import {
  endpointMatches,
  expandPattern,
  pathPatternToRegExp,
  UnmatchedPatternError,
} from "../../src/core/selectors.js";
import type { Endpoint } from "../../src/core/types.js";

const ENDPOINTS: readonly Endpoint[] = [
  { id: "admin.users", method: "GET", path: "/v1/admin/users" },
  { id: "admin.audit", method: "GET", path: "/v1/admin/audit/log" },
  { id: "admin.purge", method: "DELETE", path: "/v1/admin/users" },
  { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
  { id: "health", method: "GET", path: "/v1/health" },
];

describe("pathPatternToRegExp", () => {
  /**
   * Шаблонные пути несут фигурные скобки. Без экранирования `{orderId}` стало бы
   * квантификатором регулярного выражения, и шаблон совпал бы не с тем.
   */
  it("экранирует фигурные скобки шаблонного пути", () => {
    expect(pathPatternToRegExp("/v1/orders/{orderId}").test("/v1/orders/{orderId}")).toBe(true);
    expect(pathPatternToRegExp("/v1/orders/{orderId}").test("/v1/orders/x")).toBe(false);
  });

  it("одинарная звезда не пересекает границу сегмента", () => {
    const pattern = pathPatternToRegExp("/v1/admin/*");

    expect(pattern.test("/v1/admin/users")).toBe(true);
    expect(pattern.test("/v1/admin/audit/log")).toBe(false);
  });

  it("двойная звезда пересекает границы сегментов", () => {
    const pattern = pathPatternToRegExp("/v1/admin/**");

    expect(pattern.test("/v1/admin/users")).toBe(true);
    expect(pattern.test("/v1/admin/audit/log")).toBe(true);
  });

  it("совпадает целиком, а не подстрокой", () => {
    expect(pathPatternToRegExp("/v1/admin").test("/v1/admin/users")).toBe(false);
    expect(pathPatternToRegExp("admin").test("/v1/admin")).toBe(false);
  });
});

describe("endpointMatches", () => {
  const users = ENDPOINTS[0] as Endpoint;
  const purge = ENDPOINTS[2] as Endpoint;

  it("без метода подходит любой метод", () => {
    expect(endpointMatches(users, { path: "/v1/admin/*" })).toBe(true);
    expect(endpointMatches(purge, { path: "/v1/admin/*" })).toBe(true);
  });

  it("с методом различает одинаковые пути", () => {
    expect(endpointMatches(users, { method: "GET", path: "/v1/admin/users" })).toBe(true);
    expect(endpointMatches(purge, { method: "GET", path: "/v1/admin/users" })).toBe(false);
  });
});

describe("expandPattern", () => {
  it("раскрывает шаблон в идентификаторы", () => {
    expect(expandPattern({ path: "/v1/admin/**" }, ENDPOINTS)).toEqual([
      "admin.users",
      "admin.audit",
      "admin.purge",
    ]);
  });

  /**
   * Шаблон, не совпавший ни с чем, — тот же класс ошибки, что опечатка
   * в идентификаторе: правило не применится ни разу, пары уйдут в `fallback`,
   * и отчёт останется чистым. Молчать нельзя.
   */
  it("отвергает шаблон, не совпавший ни с одним эндпоинтом", () => {
    expect(() => expandPattern({ path: "/v1/админка/*" }, ENDPOINTS)).toThrow(
      UnmatchedPatternError,
    );
  });

  it("отвергает шаблон, совпавший по пути, но не по методу", () => {
    expect(() => expandPattern({ method: "POST", path: "/v1/health" }, ENDPOINTS)).toThrow(
      UnmatchedPatternError,
    );
  });
});

describe("expandPolicy", () => {
  it("заменяет шаблоны идентификаторами, оставляя явные как есть", () => {
    const expanded = expandPolicy(
      {
        fallback: "denied",
        rules: [
          {
            roles: ["admin"],
            endpoints: ["health", { method: "GET", path: "/v1/admin/**" }],
            outcome: "allowed",
          },
        ],
      },
      ENDPOINTS,
    );

    expect(expanded.rules[0]?.endpoints).toEqual(["health", "admin.users", "admin.audit"]);
  });

  it("не трогает правило со звёздочкой", () => {
    const expanded = expandPolicy(
      { fallback: "denied", rules: [{ roles: ANY, endpoints: ANY, outcome: "allowed" }] },
      ENDPOINTS,
    );

    expect(expanded.rules[0]?.endpoints).toBe(ANY);
  });

  /** Один эндпоинт мог подойти и по идентификатору, и под шаблон. */
  it("не дублирует эндпоинт, попавший дважды", () => {
    const expanded = expandPolicy(
      {
        fallback: "denied",
        rules: [
          {
            roles: ANY,
            endpoints: ["admin.users", { path: "/v1/admin/users" }],
            outcome: "denied",
          },
        ],
      },
      ENDPOINTS,
    );

    expect(expanded.rules[0]?.endpoints).toEqual(["admin.users", "admin.purge"]);
  });

  it("раскрытая политика годится там, где нужна раскрытая", () => {
    const expanded: ResolvedAccessPolicy = expandPolicy(
      {
        fallback: "denied",
        rules: [{ roles: ANY, endpoints: [{ path: "/v1/**" }], outcome: "allowed" }],
      },
      ENDPOINTS,
    );

    expect(expanded.rules[0]?.endpoints).toHaveLength(ENDPOINTS.length);
  });
});

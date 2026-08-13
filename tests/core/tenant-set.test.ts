/**
 * Аккаунт в наборе тенантов: до ADR-0017 и после.
 *
 * Первый describe — эксперимент, ради которого ADR писался: он перебирает **все**
 * способы выразить такой аккаунт деревом и показывает, что каждый из них лжёт.
 * Второй показывает, что набор членств чинит оба симптома разом.
 */

import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy, TenantNode } from "../../src/core/index.js";
import {
  assertIndependentMemberships,
  buildAccessMatrix,
  createTenantHierarchy,
  DuplicateMembershipError,
  diffAccess,
  relationOf,
  SubsumedMembershipError,
  tenantIdsOf,
} from "../../src/core/index.js";
import type { Account, Endpoint, Resource } from "../../src/core/types.js";

/**
 * Платформа над двумя холдингами, у каждого по два бренда.
 *
 * Второй бренд в каждом холдинге — не для симметрии: без него «весь холдинг»
 * и «один его бренд» совпали бы, и разница между членством в узле и членством
 * в поддереве была бы ненаблюдаемой.
 */
const TENANTS: readonly TenantNode[] = [
  { id: "platform" },
  { id: "holding-1", parentId: "platform" },
  { id: "brand-a", parentId: "holding-1" },
  { id: "brand-b", parentId: "holding-1" },
  { id: "holding-2", parentId: "platform" },
  { id: "brand-c", parentId: "holding-2" },
  { id: "brand-d", parentId: "holding-2" },
];

const RESOURCES: readonly Resource[] = ["a", "b", "c", "d"].map((letter) => ({
  id: `r-${letter}`,
  tenantId: `brand-${letter}`,
  params: { id: letter },
}));

const ENDPOINTS: readonly Endpoint[] = [{ id: "report", method: "GET", path: "/v1/reports/{id}" }];

/**
 * Платформа течёт: саппорту отдаются все четыре бренда.
 *
 * Ему положены A и C — так объявил человек. Находок обязано быть ровно две:
 * B и D. Наблюдения заданы вручную, а не выведены из политики.
 */
const OBSERVATIONS = RESOURCES.map((resource) => ({
  endpointId: "report",
  accountId: "sam",
  resourceId: resource.id,
  status: 200,
  headers: {},
  outcome: "allowed" as const,
  durationMs: 1,
}));

function escalationsOn(account: Account, policy: ResolvedAccessPolicy): readonly string[] {
  return diffAccess(
    buildAccessMatrix({
      endpoints: ENDPOINTS,
      accounts: [account],
      resources: RESOURCES,
      observations: OBSERVATIONS,
      tenants: TENANTS,
    }),
    policy,
  )
    .filter((finding) => finding.kind === "privilege-escalation")
    .map((finding) => finding.resourceId ?? "")
    .sort();
}

function ruleWithScope(
  scope: ResolvedAccessPolicy["rules"][number]["scope"],
): ResolvedAccessPolicy {
  return {
    fallback: "denied",
    rules: [{ roles: ["support"], endpoints: ["report"], scope, outcome: "allowed" }],
  };
}

describe("деревом такой аккаунт не выражается ни одним из трёх способов", () => {
  /**
   * Способ первый: посадить на один из своих брендов и разрешить своё.
   *
   * Утечки находятся, но вместе с ними находкой объявляется законное чтение
   * второго бренда. Читатель отчёта не может отличить одно от другого: три
   * находки одного вида, одна из них выдумана.
   */
  it("посаженный на brand-a получает ложную находку на законном brand-c", () => {
    const sam: Account = { id: "sam", roleId: "support", tenantId: "brand-a" };
    expect(escalationsOn(sam, ruleWithScope("same-tenant"))).toEqual(["r-b", "r-c", "r-d"]);
  });

  /**
   * Способ второй — то, чем ложную находку убирают на практике: открыть
   * `foreign-tenant`. Результат хуже болезни: обе настоящие утечки исчезают,
   * а находка на собственном бренде остаётся, потому что правило покрывает
   * только чужих. Прогон и лжёт, и выглядит содержательным.
   */
  it("с открытым foreign-tenant обе настоящие утечки исчезают", () => {
    const sam: Account = { id: "sam", roleId: "support", tenantId: "brand-a" };
    expect(escalationsOn(sam, ruleWithScope("foreign-tenant"))).toEqual(["r-a"]);
  });

  /**
   * Способ третий: посадить в общий корень. Общего предка у брендов разных
   * холдингов нет, кроме платформы, — и вместе с A и C аккаунт получает
   * B и D. Прогон чист, а утечка на месте: это и есть «чисто ≠ проверено».
   */
  it("посаженный в общий корень не находит ничего", () => {
    const sam: Account = { id: "sam", roleId: "support", tenantId: "platform" };
    expect(escalationsOn(sam, ruleWithScope("descendant-tenant"))).toEqual([]);
  });
});

describe("с объявленным набором членств", () => {
  const sam: Account = { id: "sam", roleId: "support", tenantIds: ["brand-a", "brand-c"] };

  it("находит ровно две утечки и не придирается к своим брендам", () => {
    expect(escalationsOn(sam, ruleWithScope("same-tenant"))).toEqual(["r-b", "r-d"]);
  });

  it("считает отношение по каждому членству", () => {
    const hierarchy = createTenantHierarchy(TENANTS);
    expect(RESOURCES.map((resource) => relationOf(sam, resource, hierarchy))).toEqual([
      "same-tenant",
      "foreign-tenant",
      "same-tenant",
      "foreign-tenant",
    ]);
  });

  /**
   * Владение — отношение внутри тенанта, и набор этого не меняет: объект своего
   * тенанта, владельцем которого числится сам аккаунт, остаётся `own`.
   */
  it("оставляет own своим объектом в любом из членств", () => {
    const own: Resource = {
      id: "r-own",
      tenantId: "brand-c",
      ownerAccountId: "sam",
      params: { id: "own" },
    };
    expect(relationOf(sam, own, createTenantHierarchy(TENANTS))).toBe("own");
  });

  /**
   * Родство считается по каждому членству, а выигрывает ближайшее отношение.
   * Аккаунт холдинга и бренда чужой ветви видит свой холдинг сверху вниз,
   * а уровень чужого холдинга — снизу вверх, и это два разных вердикта.
   */
  it("различает вниз и вверх по разным членствам", () => {
    const hierarchy = createTenantHierarchy(TENANTS);
    const mixed: Account = { id: "mix", roleId: "ops", tenantIds: ["holding-1", "brand-c"] };

    expect(relationOf(mixed, { id: "x", tenantId: "brand-b", params: {} }, hierarchy)).toBe(
      "descendant-tenant",
    );
    expect(relationOf(mixed, { id: "y", tenantId: "holding-2", params: {} }, hierarchy)).toBe(
      "ancestor-tenant",
    );
    expect(relationOf(mixed, { id: "z", tenantId: "platform", params: {} }, hierarchy)).toBe(
      "ancestor-tenant",
    );
  });

  /**
   * Совместимость: набор из одного элемента обязан вести себя как `tenantId`.
   * Утверждение проверяется на всех отношениях сразу, а не на одном.
   */
  it("на одном членстве отвечает так же, как аккаунт с одним тенантом", () => {
    const hierarchy = createTenantHierarchy(TENANTS);
    const single: Account = { id: "one", roleId: "support", tenantId: "brand-a" };
    const asSet: Account = { id: "one", roleId: "support", tenantIds: ["brand-a"] };
    const probes: readonly Resource[] = [
      { id: "p1", tenantId: "brand-a", params: {} },
      { id: "p2", tenantId: "brand-a", ownerAccountId: "one", params: {} },
      { id: "p3", tenantId: "holding-1", params: {} },
      { id: "p4", tenantId: "brand-c", params: {} },
    ];

    expect(probes.map((resource) => relationOf(asSet, resource, hierarchy))).toEqual(
      probes.map((resource) => relationOf(single, resource, hierarchy)),
    );
  });

  it("перечисляет членства одним списком, а вне тенантов даёт пустой", () => {
    expect(tenantIdsOf(sam)).toEqual(["brand-a", "brand-c"]);
    expect(tenantIdsOf({ id: "anon", roleId: "anonymous" })).toEqual([]);
  });
});

describe("проверка набора на старте", () => {
  const hierarchy = createTenantHierarchy(TENANTS);

  /**
   * Вложенное членство меняет отношение молча: объекты бренда перестают быть
   * `descendant-tenant` и становятся `same-tenant`, правило для взгляда сверху
   * вниз перестаёт применяться, ячейка уходит в `fallback`. Проверка стоит
   * на старте ровно потому, что в отчёте этот сдвиг ничем себя не выдаёт.
   */
  it("отвергает членство, покрытое другим членством", () => {
    expect(() =>
      assertIndependentMemberships("Аккаунт «sam»", ["holding-1", "brand-a"], hierarchy),
    ).toThrow(SubsumedMembershipError);
  });

  it("отвергает повтор в наборе", () => {
    expect(() =>
      assertIndependentMemberships("Аккаунт «sam»", ["brand-a", "brand-a"], hierarchy),
    ).toThrow(DuplicateMembershipError);
  });

  it("пропускает набор из несвязанных тенантов", () => {
    expect(() =>
      assertIndependentMemberships("Аккаунт «sam»", ["brand-a", "brand-c"], hierarchy),
    ).not.toThrow();
  });

  /**
   * Без объявленного дерева родства нет ни у кого, поэтому вложенности
   * не бывает, а повтор ловится всё равно — он опечатка при любой модели.
   */
  it("без дерева ловит только повтор", () => {
    const flat = createTenantHierarchy([{ id: "brand-a" }, { id: "brand-c" }]);
    expect(() =>
      assertIndependentMemberships("Аккаунт «sam»", ["brand-a", "brand-c"], flat),
    ).not.toThrow();
  });
});

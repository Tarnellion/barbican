/**
 * Холдинговый контур: до ADR-0013 и после.
 *
 * Первый describe закрепляет поведение **без объявленного дерева** — оно
 * осталось прежним намеренно, ради совместимости, и именно поэтому опасно.
 * Второй показывает, что объявление дерева его чинит.
 */

import { describe, expect, it } from "vitest";
import type { ExpectedAccessPolicy, TenantNode } from "../../src/core/index.js";
import {
  buildAccessMatrix,
  createTenantHierarchy,
  DuplicateTenantIdError,
  diffAccess,
  relationOf,
  TenantCycleError,
  UnknownParentTenantError,
} from "../../src/core/index.js";
import type { Account, Endpoint, Resource } from "../../src/core/types.js";

/** Холдинг H1 владеет брендами A и B. Холдинг H2 владеет брендом C. */
const TENANTS: readonly TenantNode[] = [
  { id: "holding-1" },
  { id: "brand-a", parentId: "holding-1" },
  { id: "brand-b", parentId: "holding-1" },
  { id: "holding-2" },
  { id: "brand-c", parentId: "holding-2" },
];

const RESOURCES: readonly Resource[] = [
  { id: "r-a", tenantId: "brand-a", params: { id: "1" } },
  { id: "r-b", tenantId: "brand-b", params: { id: "2" } },
  { id: "r-c", tenantId: "brand-c", params: { id: "3" } },
];

const ENDPOINTS: readonly Endpoint[] = [{ id: "report", method: "GET", path: "/v1/reports/{id}" }];

function observationsFor(accountId: string) {
  return RESOURCES.map((resource) => ({
    endpointId: "report",
    accountId,
    resourceId: resource.id,
    status: 200,
    headers: {},
    outcome: "allowed" as const,
    durationMs: 1,
  }));
}

describe("без объявленного дерева поведение прежнее — и потому опасное", () => {
  /** Холдинг приписан к одному из своих брендов: других вариантов модель не даёт. */
  const holding: Account = { id: "holding-1", roleId: "holding", tenantId: "brand-a" };

  const policy: ExpectedAccessPolicy = {
    fallback: "denied",
    rules: [
      { roles: ["holding"], endpoints: ["report"], scope: "foreign-tenant", outcome: "allowed" },
    ],
  };

  const findings = diffAccess(
    buildAccessMatrix({
      endpoints: ENDPOINTS,
      accounts: [holding],
      resources: RESOURCES,
      observations: observationsFor("holding-1"),
    }),
    policy,
  );

  it("не находит утечку в бренд чужого холдинга", () => {
    expect(findings.some((finding) => finding.resourceId === "r-c")).toBe(false);
  });

  it("зато объявляет эскалацией законное чтение своего бренда", () => {
    expect(findings.find((finding) => finding.resourceId === "r-a")?.kind).toBe(
      "privilege-escalation",
    );
  });
});

describe("с объявленным деревом", () => {
  const holding: Account = { id: "holding-1", roleId: "holding", tenantId: "holding-1" };

  it("различает свой бренд, чужой холдинг и уровень выше", () => {
    const hierarchy = createTenantHierarchy(TENANTS);
    const brandAccount: Account = { id: "op-a", roleId: "operator", tenantId: "brand-a" };

    const relations = RESOURCES.map((resource) => relationOf(holding, resource, hierarchy));
    expect(relations).toEqual(["descendant-tenant", "descendant-tenant", "foreign-tenant"]);

    // Бренд, читающий уровень холдинга, — отдельный случай, не «чужой тенант».
    expect(
      relationOf(brandAccount, { id: "h", tenantId: "holding-1", params: {} }, hierarchy),
    ).toBe("ancestor-tenant");
  });

  /**
   * Ровно то, ради чего писался ADR-0013: обе прежние ошибки исчезают
   * одновременно, и политика при этом выражает намерение буквально —
   * «холдингу положены его собственные бренды, и только они».
   */
  it("находит утечку в чужой холдинг и не придирается к своему бренду", () => {
    const policy: ExpectedAccessPolicy = {
      fallback: "denied",
      rules: [
        {
          roles: ["holding"],
          endpoints: ["report"],
          scope: "descendant-tenant",
          outcome: "allowed",
        },
      ],
    };

    const findings = diffAccess(
      buildAccessMatrix({
        endpoints: ENDPOINTS,
        accounts: [holding],
        resources: RESOURCES,
        observations: observationsFor("holding-1"),
        tenants: TENANTS,
      }),
      policy,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.resourceId).toBe("r-c");
    expect(findings[0]?.relation).toBe("foreign-tenant");
    expect(findings[0]?.kind).toBe("privilege-escalation");
  });

  /**
   * Контракт: отношение строгое. Держится двумя способами сразу — ранним
   * возвратом и тем, что циклы отвергнуты при построении, — поэтому снятие
   * раннего возврата этот тест не роняет. Тест утверждает контракт, а не
   * охраняет конкретную строку.
   */
  it("не считает тенанта собственным предком", () => {
    expect(createTenantHierarchy(TENANTS).isAncestor("brand-a", "brand-a")).toBe(false);
  });

  it("видит предка через несколько уровней", () => {
    const deep: readonly TenantNode[] = [
      { id: "platform" },
      { id: "holding-1", parentId: "platform" },
      { id: "brand-a", parentId: "holding-1" },
    ];

    expect(createTenantHierarchy(deep).isAncestor("platform", "brand-a")).toBe(true);
  });
});

describe("проверка дерева на старте", () => {
  /**
   * Опечатка в родителе делает тенанта отдельным корнем: `descendant-tenant`
   * превращается в `foreign-tenant`, правило перестаёт применяться, находка
   * исчезает. Тот же класс, что лишний пробел в имени тенанта.
   */
  it("отвергает неизвестного родителя", () => {
    expect(() =>
      createTenantHierarchy([{ id: "brand-a", parentId: "holding-l" }, { id: "holding-1" }]),
    ).toThrow(UnknownParentTenantError);
  });

  /** Без проверки подъём по дереву во время диффа зациклился бы. */
  it("отвергает цикл", () => {
    expect(() =>
      createTenantHierarchy([
        { id: "a", parentId: "b" },
        { id: "b", parentId: "a" },
      ]),
    ).toThrow(TenantCycleError);
  });

  it("отвергает повтор идентификатора тенанта", () => {
    expect(() => createTenantHierarchy([{ id: "a" }, { id: "a" }])).toThrow(DuplicateTenantIdError);
  });

  it("отвергает тенанта, объявленного своим же родителем", () => {
    expect(() => createTenantHierarchy([{ id: "a", parentId: "a" }])).toThrow(TenantCycleError);
  });
});

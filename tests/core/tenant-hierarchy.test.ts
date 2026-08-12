/**
 * Свидетельство известного ограничения: `tenantId` плоский.
 *
 * Тест закрепляет **нынешнее** поведение, а не желаемое. Он существует затем,
 * чтобы ограничение нельзя было изменить молча: когда появится иерархия
 * тенантов, этот тест обязан упасть и быть переписан осознанно.
 *
 * Разбор и последствия — docs/research/coverage-model.md.
 */

import { describe, expect, it } from "vitest";
import type { ExpectedAccessPolicy } from "../../src/core/index.js";
import { buildAccessMatrix, diffAccess } from "../../src/core/index.js";
import type { Account, Endpoint, Resource } from "../../src/core/types.js";

/**
 * Холдинг H1 владеет брендами A и B. Холдинг H2 владеет брендом C.
 *
 * Правильное поведение платформы: аккаунт холдинга H1 читает A и B и не читает C.
 * Выразить это нечем — у аккаунта ровно один `tenantId`, поэтому холдинг
 * приходится приписать к одному из своих брендов.
 */
const HOLDING: Account = { id: "holding-1", roleId: "holding", tenantId: "brand-a" };

const RESOURCES: readonly Resource[] = [
  { id: "r-a", tenantId: "brand-a", params: { id: "1" } },
  { id: "r-b", tenantId: "brand-b", params: { id: "2" } },
  { id: "r-c", tenantId: "brand-c", params: { id: "3" } },
];

const ENDPOINTS: readonly Endpoint[] = [{ id: "report", method: "GET", path: "/v1/reports/{id}" }];

/** Единственный способ дать холдингу доступ к своему же бренду B. */
const POLICY: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [
    { roles: ["holding"], endpoints: ["report"], scope: "foreign-tenant", outcome: "allowed" },
  ],
};

describe("плоский tenantId и холдинговый контур", () => {
  const observations = RESOURCES.map((resource) => ({
    endpointId: "report",
    accountId: HOLDING.id,
    resourceId: resource.id,
    status: 200,
    headers: {},
    outcome: "allowed" as const,
    durationMs: 1,
  }));

  const findings = diffAccess(
    buildAccessMatrix({
      endpoints: ENDPOINTS,
      accounts: [HOLDING],
      resources: RESOURCES,
      observations,
    }),
    POLICY,
  );

  /**
   * Пропуск опаснее ложного срабатывания: он выглядит как чистый прогон.
   * Бренд чужого холдинга неотличим от бренда своего — оба `foreign-tenant`.
   */
  it("не находит утечку в бренд чужого холдинга", () => {
    expect(findings.some((finding) => finding.resourceId === "r-c")).toBe(false);
  });

  /** Своё же чтение объявляется эскалацией: бренд A для холдинга `same-tenant`. */
  it("зато объявляет эскалацией законное чтение своего бренда", () => {
    const own = findings.find((finding) => finding.resourceId === "r-a");

    expect(own?.kind).toBe("privilege-escalation");
    expect(own?.relation).toBe("same-tenant");
  });

  it("обе ошибки случаются в одном прогоне", () => {
    expect(findings).toHaveLength(1);
  });
});

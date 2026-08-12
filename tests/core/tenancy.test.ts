/**
 * Тесты принадлежности объектов и трёхмерной матрицы.
 *
 * До этого `tenantId` был декорацией: читался из конфигурации и не участвовал
 * ни в запросе, ни в политике, ни в диффе. Здесь проверяется то, ради чего
 * проект называется инструментом проверки изоляции тенантов.
 */

import { describe, expect, it } from "vitest";
import type {
  AccessObservation,
  Account,
  Endpoint,
  ExpectedAccessPolicy,
  Resource,
} from "../../src/core/index.js";
import {
  ANY,
  buildAccessMatrix,
  diffAccess,
  relationOf,
  resolveExpected,
} from "../../src/core/index.js";

const playerA: Account = { id: "player-a", roleId: "player", tenantId: "tenant-a" };
const playerA2: Account = { id: "player-a2", roleId: "player", tenantId: "tenant-a" };
const playerB: Account = { id: "player-b", roleId: "player", tenantId: "tenant-b" };
const adminA: Account = { id: "admin-a", roleId: "admin", tenantId: "tenant-a" };

const ownedByA: Resource = {
  id: "profile-a",
  tenantId: "tenant-a",
  ownerAccountId: "player-a",
  params: { playerId: "1001" },
};
const ownedByB: Resource = {
  id: "profile-b",
  tenantId: "tenant-b",
  ownerAccountId: "player-b",
  params: { playerId: "2002" },
};

const profile: Endpoint = { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" };

describe("relationOf", () => {
  it("свой объект", () => {
    expect(relationOf(playerA, ownedByA)).toBe("own");
  });

  it("чужой объект своего тенанта — сюда попадает BOLA внутри тенанта", () => {
    expect(relationOf(playerA2, ownedByA)).toBe("same-tenant");
  });

  it("объект чужого тенанта", () => {
    expect(relationOf(playerB, ownedByA)).toBe("foreign-tenant");
  });

  // Разделение существенно: администратору обычно положено всё в своём тенанте
  // и ничего в чужом, и одним признаком «не своё» это не выразить.
  it("администратор своего тенанта видит чужой объект как same-tenant", () => {
    expect(relationOf(adminA, ownedByA)).toBe("same-tenant");
  });

  it("объект без владельца в своём тенанте — same-tenant", () => {
    const shared: Resource = { id: "s", tenantId: "tenant-a", params: {} };

    expect(relationOf(playerA, shared)).toBe("same-tenant");
  });
});

describe("область действия правила", () => {
  const policy: ExpectedAccessPolicy = {
    fallback: "denied",
    rules: [
      { roles: ["player"], endpoints: ["profile.read"], scope: "own", outcome: "allowed" },
      { roles: ["admin"], endpoints: ANY, scope: "same-tenant", outcome: "allowed" },
    ],
  };

  it("правило действует только при своём отношении", () => {
    expect(resolveExpected(policy, "player", "profile.read", "own")).toBe("allowed");
    expect(resolveExpected(policy, "player", "profile.read", "same-tenant")).toBe("denied");
    expect(resolveExpected(policy, "player", "profile.read", "foreign-tenant")).toBe("denied");
  });

  it("администратору положено своё в тенанте и не положено чужое", () => {
    expect(resolveExpected(policy, "admin", "profile.read", "same-tenant")).toBe("allowed");
    expect(resolveExpected(policy, "admin", "profile.read", "foreign-tenant")).toBe("denied");
  });

  it("правило без области действует при любом отношении и без объекта", () => {
    const wide: ExpectedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: ANY, endpoints: ["ping"], outcome: "allowed" }],
    };

    expect(resolveExpected(wide, "player", "ping")).toBe("allowed");
    expect(resolveExpected(wide, "player", "ping", "foreign-tenant")).toBe("allowed");
  });
});

describe("дифф по тройкам", () => {
  const policy: ExpectedAccessPolicy = {
    fallback: "denied",
    rules: [{ roles: ["player"], endpoints: ["profile.read"], scope: "own", outcome: "allowed" }],
  };

  function observe(accountId: string, resourceId: string, outcome: "allowed" | "denied") {
    return {
      accountId,
      endpointId: "profile.read",
      resourceId,
      status: outcome === "allowed" ? 200 : 403,
      headers: {},
      outcome,
      durationMs: 1,
    } satisfies AccessObservation;
  }

  const accounts = [playerA, playerB];
  const resources = [ownedByA, ownedByB];

  it("не находит ничего, когда изоляция соблюдена", () => {
    const matrix = buildAccessMatrix({
      endpoints: [profile],
      accounts,
      resources,
      observations: [
        observe("player-a", "profile-a", "allowed"),
        observe("player-a", "profile-b", "denied"),
        observe("player-b", "profile-a", "denied"),
        observe("player-b", "profile-b", "allowed"),
      ],
    });

    expect(diffAccess(matrix, policy)).toEqual([]);
  });

  it("находит утечку между тенантами и указывает объект", () => {
    const matrix = buildAccessMatrix({
      endpoints: [profile],
      accounts,
      resources,
      observations: [
        observe("player-a", "profile-a", "allowed"),
        // Игрок тенанта A дотянулся до объекта тенанта B.
        observe("player-a", "profile-b", "allowed"),
        observe("player-b", "profile-a", "denied"),
        observe("player-b", "profile-b", "allowed"),
      ],
    });

    expect(diffAccess(matrix, policy)).toEqual([
      {
        accountId: "player-a",
        endpointId: "profile.read",
        resourceId: "profile-b",
        relation: "foreign-tenant",
        expected: "denied",
        actual: "allowed",
        kind: "privilege-escalation",
      },
    ]);
  });

  it("различает утечку между тенантами и BOLA внутри тенанта", () => {
    const matrix = buildAccessMatrix({
      endpoints: [profile],
      accounts: [playerA, playerA2],
      resources: [ownedByA],
      observations: [
        observe("player-a", "profile-a", "allowed"),
        // Другой игрок того же тенанта — это BOLA, а не межтенантная утечка.
        observe("player-a2", "profile-a", "allowed"),
      ],
    });

    const findings = diffAccess(matrix, policy);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.relation).toBe("same-tenant");
    expect(findings[0]?.accountId).toBe("player-a2");
  });

  it("не строит ячеек для объектов, не покрывающих параметры пути", () => {
    const unrelated: Resource = { id: "other", tenantId: "tenant-a", params: { orderId: "7" } };
    const matrix = buildAccessMatrix({
      endpoints: [profile],
      accounts: [playerA],
      resources: [ownedByA, unrelated],
      observations: [observe("player-a", "profile-a", "allowed")],
    });

    // У `other` нет playerId — ячейки с ним не существует, и «не наблюдалось»
    // тоже быть не должно.
    expect(diffAccess(matrix, policy)).toEqual([]);
  });
});

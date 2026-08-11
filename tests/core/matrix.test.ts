import { describe, expect, it } from "vitest";
import {
  buildAccessMatrix,
  ConflictingObservationError,
  DuplicateIdError,
  findObservation,
  indexObservations,
  UnknownReferenceError,
} from "../../src/core/index.js";
import { accounts, cleanObservations, endpoints, observe } from "../fixtures/scenario.js";

const input = { endpoints, accounts, observations: cleanObservations };

describe("buildAccessMatrix", () => {
  it("собирает матрицу из корректного входа", () => {
    const matrix = buildAccessMatrix(input);

    expect(matrix.endpoints).toHaveLength(4);
    expect(matrix.accounts).toHaveLength(4);
    expect(matrix.observations).toHaveLength(16);
  });

  it("отвергает дублирующийся id эндпоинта независимо от остальных полей", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        endpoints: [...endpoints, { id: "ep.profile.read", method: "HEAD", path: "/другой" }],
      });
    }).toThrow(DuplicateIdError);
  });

  it("отвергает дублирующийся id аккаунта независимо от роли и тенанта", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        accounts: [...accounts, { id: "acc.player.a", roleId: "admin", tenantId: "tenant-b" }],
      });
    }).toThrow(DuplicateIdError);
  });

  it("отвергает наблюдение о неизвестном аккаунте", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        observations: [...cleanObservations, observe("acc.ghost", "ep.profile.read", "allowed")],
      });
    }).toThrow(UnknownReferenceError);
  });

  it("отвергает наблюдение о неизвестном эндпоинте", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        observations: [...cleanObservations, observe("acc.player.a", "ep.ghost", "allowed")],
      });
    }).toThrow(UnknownReferenceError);
  });

  it("отвергает два наблюдения для одной пары: вердикт был бы неопределённым", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        observations: [...cleanObservations, observe("acc.player.a", "ep.profile.read", "denied")],
      });
    }).toThrow(ConflictingObservationError);
  });
});

describe("indexObservations", () => {
  it("находит наблюдение по паре «аккаунт × эндпоинт»", () => {
    const index = indexObservations(buildAccessMatrix(input));

    expect(findObservation(index, "acc.player.a", "ep.wallet.read")?.outcome).toBe("allowed");
    expect(findObservation(index, "acc.support.a", "ep.wallet.read")?.outcome).toBe("denied");
  });

  it("возвращает undefined для непокрытой пары, а не выдумывает исход", () => {
    const index = indexObservations(
      buildAccessMatrix({
        ...input,
        observations: [observe("acc.player.a", "ep.profile.read", "allowed")],
      }),
    );

    expect(findObservation(index, "acc.player.a", "ep.users.list")).toBeUndefined();
    expect(findObservation(index, "acc.admin.a", "ep.profile.read")).toBeUndefined();
  });

  it("не путает аккаунты с похожими идентификаторами", () => {
    const index = indexObservations(
      buildAccessMatrix({
        endpoints: [{ id: "ep.x", method: "GET", path: "/x" }],
        accounts: [
          { id: "acc", roleId: "player", tenantId: "tenant-a" },
          { id: "acc.x", roleId: "player", tenantId: "tenant-b" },
        ],
        observations: [observe("acc", "ep.x", "allowed"), observe("acc.x", "ep.x", "denied")],
      }),
    );

    expect(findObservation(index, "acc", "ep.x")?.outcome).toBe("allowed");
    expect(findObservation(index, "acc.x", "ep.x")?.outcome).toBe("denied");
  });
});

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
  it("builds a matrix from valid input", () => {
    const matrix = buildAccessMatrix(input);

    expect(matrix.endpoints).toHaveLength(4);
    expect(matrix.accounts).toHaveLength(4);
    expect(matrix.observations).toHaveLength(16);
  });

  it("rejects a duplicate endpoint id regardless of the other fields", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        endpoints: [...endpoints, { id: "ep.profile.read", method: "HEAD", path: "/other" }],
      });
    }).toThrow(DuplicateIdError);
  });

  it("rejects a duplicate account id regardless of role and tenant", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        accounts: [...accounts, { id: "acc.player.a", roleId: "admin", tenantId: "tenant-b" }],
      });
    }).toThrow(DuplicateIdError);
  });

  it("rejects an observation about an unknown account", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        observations: [...cleanObservations, observe("acc.ghost", "ep.profile.read", "allowed")],
      });
    }).toThrow(UnknownReferenceError);
  });

  it("rejects an observation about an unknown endpoint", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        observations: [...cleanObservations, observe("acc.player.a", "ep.ghost", "allowed")],
      });
    }).toThrow(UnknownReferenceError);
  });

  it("rejects two observations for one pair: the verdict would be undefined", () => {
    expect(() => {
      buildAccessMatrix({
        ...input,
        observations: [...cleanObservations, observe("acc.player.a", "ep.profile.read", "denied")],
      });
    }).toThrow(ConflictingObservationError);
  });
});

describe("indexObservations", () => {
  it("finds an observation by the account x endpoint pair", () => {
    const index = indexObservations(buildAccessMatrix(input));

    expect(findObservation(index, "acc.player.a", "ep.wallet.read")?.outcome).toBe("allowed");
    expect(findObservation(index, "acc.support.a", "ep.wallet.read")?.outcome).toBe("denied");
  });

  it("returns undefined for an uncovered pair instead of inventing an outcome", () => {
    const index = indexObservations(
      buildAccessMatrix({
        ...input,
        observations: [observe("acc.player.a", "ep.profile.read", "allowed")],
      }),
    );

    expect(findObservation(index, "acc.player.a", "ep.users.list")).toBeUndefined();
    expect(findObservation(index, "acc.admin.a", "ep.profile.read")).toBeUndefined();
  });

  it("does not confuse accounts with similar identifiers", () => {
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

import { describe, expect, it } from "vitest";
import {
  buildAccessMatrix,
  ConflictingObservationError,
  DuplicateIdError,
  findObservation,
  indexObservations,
  resourceApplies,
  UnknownReferenceError,
} from "../../src/core/index.js";
import type { Endpoint, Resource } from "../../src/core/types.js";
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

describe("resourceApplies", () => {
  const parameterised: Endpoint = {
    id: "player.read",
    method: "GET",
    path: "/v1/players/{playerId}",
  };
  const other: Endpoint = { id: "other.read", method: "GET", path: "/v1/other/{otherId}" };

  /**
   * Both halves of the `&&`, and the second one is what nothing checked: every
   * test gave a resource whose parameters covered the path, and no polygon
   * resource declares `endpointIds`, so `&&` to `||` survived the whole suite
   * **and** the oracle. A resource listed for an endpoint whose parameters it
   * cannot fill would then be probed with an empty segment in the address.
   * Found by the audit of 14 August 2026 (C-5).
   */
  it("needs the endpoint on the list and the parameters covered, not either", () => {
    const listed: Resource = {
      id: "r",
      tenantId: "t",
      params: { playerId: "p-1" },
      endpointIds: ["player.read"],
    };

    expect(resourceApplies(parameterised, listed)).toBe(true);
    // On the list, parameters not covered.
    expect(resourceApplies(other, { ...listed, endpointIds: ["other.read"] })).toBe(false);
    // Parameters covered, not on the list.
    expect(resourceApplies(parameterised, { ...listed, endpointIds: ["other.read"] })).toBe(false);
  });

  /** Without a list, a resource attaches only to endpoints that have parameters. */
  it("does not attach a resource with no list to an endpoint with no parameters", () => {
    const flat: Endpoint = { id: "orders.list", method: "GET", path: "/v1/orders" };

    const unlisted: Resource = { id: "r", tenantId: "t", params: { playerId: "p-1" } };

    expect(resourceApplies(flat, unlisted)).toBe(false);
    expect(resourceApplies(parameterised, unlisted)).toBe(true);
  });
});

describe("the text of ConflictingObservationError", () => {
  /**
   * The message is the whole of what a human gets here, and the branch inside it
   * inverted without a single test failing: an error naming the wrong cell sends
   * the reader to the wrong row. Found by the audit of 14 August (C-7).
   */
  it("names the resource when there is one, and says nothing when there is not", () => {
    expect(new ConflictingObservationError("alice", "orders.read", "order-1").message).toContain(
      '"alice" × "orders.read" × "order-1"',
    );
    const withoutResource = new ConflictingObservationError("alice", "orders.list").message;
    expect(withoutResource).toContain('"alice" × "orders.list"');
    expect(withoutResource).not.toContain("×  ");
    expect(withoutResource).not.toContain("undefined");
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

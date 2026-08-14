import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy } from "../../src/core/index.js";
import {
  ANY,
  assertPolicyIsSound,
  EmptyRuleSelectorError,
  resolveExpected,
} from "../../src/core/index.js";
import { policy } from "../fixtures/scenario.js";

describe("resolveExpected", () => {
  it("returns the fallback when no rule matched", () => {
    const empty: ResolvedAccessPolicy = { fallback: "denied", rules: [] };

    expect(resolveExpected(empty, "player", "ep.anything")).toBe("denied");
    expect(resolveExpected({ ...empty, fallback: "allowed" }, "player", "ep.anything")).toBe(
      "allowed",
    );
  });

  it("applies a rule when the role and the endpoint match", () => {
    expect(resolveExpected(policy, "player", "ep.wallet.read")).toBe("allowed");
    expect(resolveExpected(policy, "support", "ep.wallet.read")).toBe("denied");
  });

  it("treats ANY as matching any value", () => {
    expect(resolveExpected(policy, "player", "ep.profile.read")).toBe("allowed");
    expect(resolveExpected(policy, "support", "ep.profile.read")).toBe("allowed");
    expect(resolveExpected(policy, "admin", "ep.users.list")).toBe("allowed");
  });

  it("lets the last matching rule win, not the first", () => {
    const narrowThenBroad: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        { roles: ["player"], endpoints: ["ep.x"], outcome: "allowed" },
        { roles: ANY, endpoints: ["ep.x"], outcome: "denied" },
      ],
    };

    expect(resolveExpected(narrowThenBroad, "player", "ep.x")).toBe("denied");

    const broadThenNarrow: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        { roles: ANY, endpoints: ["ep.x"], outcome: "denied" },
        { roles: ["player"], endpoints: ["ep.x"], outcome: "allowed" },
      ],
    };

    expect(resolveExpected(broadThenNarrow, "player", "ep.x")).toBe("allowed");
  });

  it("does not mix roles: a rule for one role does not apply to another", () => {
    expect(resolveExpected(policy, "support", "ep.users.list")).toBe("denied");
    expect(resolveExpected(policy, "player", "ep.tickets.list")).toBe("denied");
  });
});

describe("assertPolicyIsSound", () => {
  it("accepts a valid policy", () => {
    expect(() => {
      assertPolicyIsSound(policy);
    }).not.toThrow();
  });

  it("rejects an empty list of roles — such a rule would never fire", () => {
    const broken: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: [], endpoints: ANY, outcome: "allowed" }],
    };

    expect(() => {
      assertPolicyIsSound(broken);
    }).toThrow(EmptyRuleSelectorError);
  });

  it("rejects an empty list of endpoints", () => {
    const broken: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: ANY, endpoints: [], outcome: "allowed" }],
    };

    expect(() => {
      assertPolicyIsSound(broken);
    }).toThrow(EmptyRuleSelectorError);
  });
});

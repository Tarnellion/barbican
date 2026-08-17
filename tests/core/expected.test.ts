import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy } from "../../src/core/index.js";
import {
  ANY,
  assertPolicyIsSound,
  describePolicyRule,
  EmptyRuleSelectorError,
  indexPolicy,
  resolveExpected,
  resolveIndexedVerdict,
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

/**
 * The policy arranged for lookup by cell.
 *
 * Resolution used to read every rule of the policy for every cell of the matrix,
 * and the audit of 14 August measured what that cost: with the policy trimmed
 * from 440 rules to 2, `findUnauthenticated` went from 275 ms to 21 ms. The index
 * groups the rules by conditions and by endpoint so that a cell sees the few
 * rules that can decide it.
 *
 * What is tested here is the grouping, and every case below is one where a
 * plausible index gives the wrong rule. The rest of the meaning — a scope, a
 * role, the fallback — is tested through `resolveExpected` above and through the
 * diff, which now goes through the same index.
 */
describe("the policy index", () => {
  it("answers a cell exactly as the policy does", () => {
    const index = indexPolicy(policy);

    expect(resolveIndexedVerdict(index, "player", "ep.wallet.read")).toEqual({
      outcome: "allowed",
      basis: "rule",
      ruleIndex: 1,
    });
    expect(resolveIndexedVerdict(index, "support", "ep.wallet.read")).toEqual({
      outcome: "denied",
      basis: "fallback",
    });
  });

  /**
   * The rules that name an endpoint and the rules that name any are kept in two
   * lists, and the later of the two wins. Getting that comparison wrong is
   * invisible on a policy where one of the lists is empty — which most fixtures
   * are — so both directions are pinned here.
   */
  it("lets a rule for any endpoint override an earlier rule for this one", () => {
    const broadLast: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        { roles: ANY, endpoints: ["ep.x"], outcome: "allowed" },
        { roles: ANY, endpoints: ANY, outcome: "denied" },
      ],
    };

    expect(resolveIndexedVerdict(indexPolicy(broadLast), "player", "ep.x")).toEqual({
      outcome: "denied",
      basis: "rule",
      ruleIndex: 1,
    });
  });

  it("lets a rule for this endpoint override an earlier rule for any", () => {
    const broadFirst: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        { roles: ANY, endpoints: ANY, outcome: "denied" },
        { roles: ANY, endpoints: ["ep.x"], outcome: "allowed" },
      ],
    };

    expect(resolveIndexedVerdict(indexPolicy(broadFirst), "player", "ep.x")).toEqual({
      outcome: "allowed",
      basis: "rule",
      ruleIndex: 1,
    });
  });

  /**
   * Conditions are compared exactly, and absence means baseline rather than
   * "any" — the reasoning is on `ExpectedAccessRule.context`. Grouping by
   * conditions is where that could quietly become "any": a bucket that answered
   * for conditions nobody declared would extend every baseline expectation to
   * them.
   */
  it("does not answer for conditions no rule was declared under", () => {
    const underContext: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: ANY, endpoints: ["ep.x"], context: "geo-blocked", outcome: "allowed" }],
    };
    const index = indexPolicy(underContext);

    expect(resolveIndexedVerdict(index, "player", "ep.x", undefined, "geo-blocked").outcome).toBe(
      "allowed",
    );
    expect(resolveIndexedVerdict(index, "player", "ep.x", undefined, "kyc-pending")).toEqual({
      outcome: "denied",
      basis: "fallback",
    });
    expect(resolveIndexedVerdict(index, "player", "ep.x")).toEqual({
      outcome: "denied",
      basis: "fallback",
    });
  });

  /** A baseline rule stays baseline: it does not reach a cell under conditions. */
  it("does not stretch a baseline rule over a cell under conditions", () => {
    const index = indexPolicy(policy);

    expect(
      resolveIndexedVerdict(index, "player", "ep.wallet.read", undefined, "geo-blocked"),
    ).toEqual({ outcome: "denied", basis: "fallback" });
  });

  /**
   * One index, many cells: it is built once by the caller and asked about every
   * cell of the matrix. A structure that answered correctly only the first time
   * — anything left half-consumed inside it — would pass every test above.
   */
  it("gives the same answer however many times it is asked", () => {
    const index = indexPolicy(policy);
    const ask = () => [
      resolveIndexedVerdict(index, "player", "ep.profile.read"),
      resolveIndexedVerdict(index, "admin", "ep.users.list"),
      resolveIndexedVerdict(index, "support", "ep.users.list"),
    ];

    expect(ask()).toEqual(ask());
    expect(ask()).toEqual(ask());
  });

  /** The index groups the policy; it does not restate it. */
  it("cites the rule numbers of the policy it was built from", () => {
    const index = indexPolicy(policy);

    expect(resolveIndexedVerdict(index, "admin", "ep.tickets.list").ruleIndex).toBe(3);
    expect(resolveIndexedVerdict(index, "support", "ep.tickets.list").ruleIndex).toBe(2);
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

/**
 * How a rule is named to whoever has to go and fix it.
 *
 * G-9 of the audit of 14 August 2026: the index was zero-based and was printed as
 * an ordinal — a typo in the fourth rule reported "Policy rule #3". The reader
 * counts to the third rule, finds it correct, and stops trusting the tool.
 *
 * The number itself is not renumbered: the same index travels into the report as
 * `ruleIndex`, where a consumer reads `policy.rules[ruleIndex]` out of the
 * serialized configuration. Only the phrasing changes — a path plus a position.
 */
describe("naming a policy rule", () => {
  const withBrokenFourthRule = (): ResolvedAccessPolicy => ({
    fallback: "denied",
    rules: [
      { roles: ANY, endpoints: ["ep.a"], outcome: "allowed" },
      { roles: ANY, endpoints: ["ep.b"], outcome: "allowed" },
      { roles: ANY, endpoints: ["ep.c"], outcome: "allowed" },
      { roles: [], endpoints: ANY, outcome: "allowed" },
    ],
  });

  it("points at the fourth rule as the fourth, not as number three", () => {
    expect(() => {
      assertPolicyIsSound(withBrokenFourthRule());
    }).toThrow(/policy\.rules\[3\] \(4th from the top\)/);
  });

  it("never offers the index as a bare ordinal", () => {
    let message = "";
    try {
      assertPolicyIsSound(withBrokenFourthRule());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // "#3" for the fourth rule is the whole of the defect: a reader who counts
    // rules lands on a correct one and doubts the tool rather than the policy.
    expect(message).not.toMatch(/#\s*3\b/);
  });

  it("carries the number the report cites the rule by", () => {
    // The path is the index, unchanged. If these two ever disagree, a reader
    // holding a finding with `ruleIndex: 3` cannot match it to the message.
    const index = indexPolicy(policy);
    const cited = resolveIndexedVerdict(index, "admin", "ep.tickets.list").ruleIndex ?? -1;

    expect(describePolicyRule(cited)).toContain(`policy.rules[${cited}]`);
  });

  it("spells the position in English, teens included", () => {
    // 11 is not "11st". The suffix is picked from the last two digits, and a
    // policy of a dozen rules is the ordinary size rather than the exotic one.
    expect(describePolicyRule(0)).toContain("1st from the top");
    expect(describePolicyRule(1)).toContain("2nd from the top");
    expect(describePolicyRule(2)).toContain("3rd from the top");
    expect(describePolicyRule(10)).toContain("11th from the top");
    expect(describePolicyRule(20)).toContain("21st from the top");
  });
});

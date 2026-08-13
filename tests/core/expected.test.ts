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
  it("возвращает fallback, если ни одно правило не подошло", () => {
    const empty: ResolvedAccessPolicy = { fallback: "denied", rules: [] };

    expect(resolveExpected(empty, "player", "ep.anything")).toBe("denied");
    expect(resolveExpected({ ...empty, fallback: "allowed" }, "player", "ep.anything")).toBe(
      "allowed",
    );
  });

  it("применяет правило по совпадению роли и эндпоинта", () => {
    expect(resolveExpected(policy, "player", "ep.wallet.read")).toBe("allowed");
    expect(resolveExpected(policy, "support", "ep.wallet.read")).toBe("denied");
  });

  it("трактует ANY как совпадение с любым значением", () => {
    expect(resolveExpected(policy, "player", "ep.profile.read")).toBe("allowed");
    expect(resolveExpected(policy, "support", "ep.profile.read")).toBe("allowed");
    expect(resolveExpected(policy, "admin", "ep.users.list")).toBe("allowed");
  });

  it("отдаёт победу последнему подходящему правилу, а не первому", () => {
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

  it("не смешивает роли: правило для одной роли не действует на другую", () => {
    expect(resolveExpected(policy, "support", "ep.users.list")).toBe("denied");
    expect(resolveExpected(policy, "player", "ep.tickets.list")).toBe("denied");
  });
});

describe("assertPolicyIsSound", () => {
  it("пропускает корректную политику", () => {
    expect(() => {
      assertPolicyIsSound(policy);
    }).not.toThrow();
  });

  it("отвергает пустой список ролей — такое правило не сработает никогда", () => {
    const broken: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: [], endpoints: ANY, outcome: "allowed" }],
    };

    expect(() => {
      assertPolicyIsSound(broken);
    }).toThrow(EmptyRuleSelectorError);
  });

  it("отвергает пустой список эндпоинтов", () => {
    const broken: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: ANY, endpoints: [], outcome: "allowed" }],
    };

    expect(() => {
      assertPolicyIsSound(broken);
    }).toThrow(EmptyRuleSelectorError);
  });
});

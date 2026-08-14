import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy } from "../../src/core/index.js";
import {
  ANY,
  buildAccessMatrix,
  diffAccess,
  resolveExpectedVerdict,
  severityOf,
} from "../../src/core/index.js";
import {
  accounts,
  cleanObservations,
  denialObservations,
  endpoints,
  escalationObservations,
  observe,
  policy,
} from "../fixtures/scenario.js";

function matrixWith(observations: Parameters<typeof buildAccessMatrix>[0]["observations"]) {
  return buildAccessMatrix({ endpoints, accounts, observations });
}

describe("the severity of a discrepancy", () => {
  /**
   * It is computed from the kind and the relation, not declared by a human: a
   * human declares the expectation, while severity is a property of the
   * discrepancy that was found. The table is in ADR-0014.
   */
  it.each([
    ["privilege-escalation" as const, "foreign-tenant" as const, "critical"],
    ["privilege-escalation" as const, "ancestor-tenant" as const, "high"],
    ["privilege-escalation" as const, "same-tenant" as const, "high"],
    ["privilege-escalation" as const, "descendant-tenant" as const, "high"],
    ["privilege-escalation" as const, undefined, "high"],
    ["privilege-escalation" as const, "own" as const, "medium"],
    ["unexpected-denial" as const, "foreign-tenant" as const, "medium"],
    ["not-observed" as const, undefined, "low"],
    ["probe-error" as const, undefined, "low"],
  ])("%s under relation %s gives %s", (kind, relation, expected) => {
    expect(severityOf(kind, relation)).toBe(expected);
  });
});

describe("the reference to a rule", () => {
  /**
   * The policy is in the report, but hunting through a dozen rules for the one
   * that declared access forbidden is work the tool can do itself.
   */
  it("names the rule that gave the expectation", () => {
    const policy: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        { roles: ANY, endpoints: ["a"], outcome: "allowed" },
        { roles: ["player"], endpoints: ["a"], outcome: "denied" },
      ],
    };

    expect(resolveExpectedVerdict(policy, "player", "a")).toEqual({
      outcome: "denied",
      ruleIndex: 1,
    });
  });

  /**
   * A missing index is a meaningful answer — "no rule matched" — not an omitted
   * field.
   */
  it("names no rule when the fallback fired", () => {
    const policy: ResolvedAccessPolicy = { fallback: "denied", rules: [] };

    expect(resolveExpectedVerdict(policy, "player", "a")).toEqual({ outcome: "denied" });
  });

  /** The last rule that matched wins — the index must point at that one. */
  it("points at the last rule that matched, not the first", () => {
    const policy: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [
        { roles: ANY, endpoints: ANY, outcome: "allowed" },
        { roles: ANY, endpoints: ANY, outcome: "denied" },
      ],
    };

    expect(resolveExpectedVerdict(policy, "any", "any").ruleIndex).toBe(1);
  });
});

describe("diffAccess", () => {
  // The main test of the suite. A tool that finds things which do not exist
  // loses trust faster than one that misses something.
  it("finds nothing when the platform behaves as declared", () => {
    expect(diffAccess(matrixWith(cleanObservations), policy)).toEqual([]);
  });

  it("finds a privilege escalation: a denial was expected, access was granted", () => {
    const diffs = diffAccess(matrixWith(escalationObservations), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        actual: "allowed",
        kind: "privilege-escalation",
        severity: "high",
      },
    ]);
  });

  it("finds an unexpected denial: access was expected, a denial came back", () => {
    const diffs = diffAccess(matrixWith(denialObservations), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.support.a",
        endpointId: "ep.tickets.list",
        expected: "allowed",
        actual: "denied",
        kind: "unexpected-denial",
        // The rule that declared access granted. The finding names it itself so
        // the reader does not have to hunt through a dozen rules.
        ruleIndex: 2,
        severity: "medium",
      },
    ]);
  });

  it("reports an uncovered pair instead of inventing the outcome", () => {
    const partial = cleanObservations.filter(
      (o) => !(o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"),
    );

    const diffs = diffAccess(matrixWith(partial), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        kind: "not-observed",
        severity: "low",
      },
    ]);
  });

  it("draws no conclusion about access when the request ended in an error", () => {
    const withError = cleanObservations.map((o) =>
      o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"
        ? observe(o.accountId, o.endpointId, "error")
        : o,
    );

    const diffs = diffAccess(matrixWith(withError), policy);

    expect(diffs).toEqual([
      {
        accountId: "acc.player.a",
        endpointId: "ep.users.list",
        expected: "denied",
        actual: "error",
        kind: "probe-error",
        severity: "low",
      },
    ]);
  });

  it("treats a 404 as a denial, not as a discrepancy of its own", () => {
    const withNotFound = cleanObservations.map((o) =>
      o.accountId === "acc.player.a" && o.endpointId === "ep.users.list"
        ? observe(o.accountId, o.endpointId, "not-found")
        : o,
    );

    expect(diffAccess(matrixWith(withNotFound), policy)).toEqual([]);
  });

  it("produces discrepancies in a deterministic order", () => {
    const broken = cleanObservations.map((o) =>
      o.endpointId === "ep.users.list" && o.accountId !== "acc.admin.a"
        ? observe(o.accountId, o.endpointId, "allowed")
        : o,
    );

    const first = diffAccess(matrixWith(broken), policy);
    const second = diffAccess(matrixWith(broken), policy);

    expect(first).toEqual(second);
    expect(first.map((d) => d.accountId)).toEqual([
      "acc.player.a",
      "acc.support.a",
      "acc.player.b",
    ]);
  });
});

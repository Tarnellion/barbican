/**
 * The declared policy of expected access.
 *
 * The expectations are set by a human, not by the specification of the API under
 * test — the reasoning is in ADR-0006. Here is only the resolution of the policy
 * into a concrete expected outcome.
 */

import type { EndpointPattern } from "./selectors.js";
import { expandPattern } from "./selectors.js";
import type { Endpoint, ExpectedOutcome, ResourceRelation, RoleId } from "./types.js";

/** Matches any value of the field. */
export const ANY = "*";

export type Any = typeof ANY;

export interface ExpectedAccessRule {
  /** The roles the rule applies to, or `*`. */
  readonly roles: readonly RoleId[] | Any;
  /**
   * The endpoints the rule applies to, or `*`.
   *
   * An entry is either an identifier or a method-and-path pattern. Patterns are
   * expanded into identifiers by `expandPolicy` before the diff, so policy
   * resolution knows nothing about them.
   */
  readonly endpoints: readonly (string | EndpointPattern)[] | Any;
  /**
   * The account's relation to the resource under which the rule is in force.
   *
   * Absence means "under any relation", including requests without a resource.
   * That preserves the meaning of policies written before resources appeared
   * (ADR-0010).
   */
  readonly scope?: ResourceRelation | undefined;
  /**
   * The request conditions under which the rule is in force.
   *
   * The match is **exact**, and absence here means "baseline conditions", not
   * "any". Otherwise declaring new conditions would silently extend every
   * previous expectation to them: a platform that lawfully closes a bet from a
   * prohibited country would give an "unexpected denial" on every endpoint. An
   * expectation under conditions is declared explicitly — or `fallback` fires.
   */
  readonly context?: string | undefined;
  readonly outcome: ExpectedOutcome;
}

/**
 * A rule with its patterns already expanded.
 *
 * A separate type rather than a runtime check: an expanded policy is assignable
 * to a declared one but not the other way round, so the compiler will not let an
 * unexpanded one be passed where an expanded one is needed. Otherwise a pattern
 * that survived to the comparison would silently match nothing and send the
 * pairs into `fallback`.
 */
export interface ResolvedAccessRule extends Omit<ExpectedAccessRule, "endpoints"> {
  readonly endpoints: readonly string[] | Any;
}

export interface ResolvedAccessPolicy extends Omit<ExpectedAccessPolicy, "rules"> {
  readonly rules: readonly ResolvedAccessRule[];
}

export interface ExpectedAccessPolicy {
  /**
   * The outcome for pairs covered by no rule.
   *
   * There is no default value on purpose: a silent "everything is allowed" and a
   * silent "everything is denied" are equally dangerous when the verdict on
   * whether a vulnerability exists depends on it.
   */
  readonly fallback: ExpectedOutcome;
  readonly rules: readonly ExpectedAccessRule[];
}

export class EmptyRuleSelectorError extends Error {
  constructor(index: number, field: "roles" | "endpoints") {
    super(
      `Rule #${index}: field "${field}" is an empty list. ` +
        `Such a rule never applies; use "${ANY}" or delete it.`,
    );
    this.name = "EmptyRuleSelectorError";
  }
}

function matches(selector: readonly string[] | Any, value: string): boolean {
  return selector === ANY || selector.includes(value);
}

/**
 * Checks the policy for rules that cannot fire.
 *
 * An empty list in a selector is almost always a typo rather than an intent: the
 * rule silently does not apply, while the human believes something was declared.
 *
 * @throws {EmptyRuleSelectorError}
 */
export function assertPolicyIsSound(policy: ExpectedAccessPolicy): void {
  policy.rules.forEach((rule, index) => {
    if (rule.roles !== ANY && rule.roles.length === 0) {
      throw new EmptyRuleSelectorError(index, "roles");
    }
    if (rule.endpoints !== ANY && rule.endpoints.length === 0) {
      throw new EmptyRuleSelectorError(index, "endpoints");
    }
  });
}

/**
 * Resolves the policy into an expected outcome for a "role × endpoint" pair.
 *
 * The **last** matching rule wins: that makes it possible to state a broad rule
 * and narrow it with the ones that follow.
 */
/**
 * The expected outcome together with what produced it.
 *
 * The rule number is for the reader of the report: the policy is in the report,
 * but hunting through a dozen rules for the one that declared access forbidden
 * is work the tool can do itself.
 *
 * `basis` says which of the two answered, in a field rather than by the absence
 * of one. The audit of 14 August put the cost on it: 37 of 80 matrix findings
 * carried no `ruleIndex`, and 22 of 34 critical ones — so on most of the most
 * expensive findings the grounds for "access was not expected" were expressed by
 * a missing key, and "the fallback fired" could not be told from "the tool
 * failed to fill this in". That is the point where a ticket gets sent back.
 */
export interface ExpectedVerdict {
  readonly outcome: ExpectedOutcome;
  /** Which of the two declared this outcome: a rule of the policy, or `fallback`. */
  readonly basis: "rule" | "fallback";
  /** The rule's number in `policy.rules`. Absent when `fallback` fired. */
  readonly ruleIndex?: number;
}

export function resolveExpectedVerdict(
  policy: ResolvedAccessPolicy,
  roleId: RoleId,
  endpointId: string,
  relation?: ResourceRelation,
  contextId?: string,
): ExpectedVerdict {
  let verdict: ExpectedVerdict = { outcome: policy.fallback, basis: "fallback" };
  // The last match wins, so the loop runs to the end rather than stopping at the
  // first one: the number must point at the same rule as the outcome.
  for (const [index, rule] of policy.rules.entries()) {
    if (rule.scope !== undefined && rule.scope !== relation) {
      continue;
    }
    // Conditions are compared exactly, including "both are absent".
    if (rule.context !== contextId) {
      continue;
    }
    if (matches(rule.roles, roleId) && matches(rule.endpoints, endpointId)) {
      verdict = { outcome: rule.outcome, basis: "rule", ruleIndex: index };
    }
  }
  return verdict;
}

export function resolveExpected(
  policy: ResolvedAccessPolicy,
  roleId: RoleId,
  endpointId: string,
  relation?: ResourceRelation,
  contextId?: string,
): ExpectedOutcome {
  return resolveExpectedVerdict(policy, roleId, endpointId, relation, contextId).outcome;
}

/**
 * Expands the patterns in the rules into concrete identifiers.
 *
 * Called once, before the matrix is built. That keeps `resolveExpected` a
 * function of an identifier rather than of an endpoint, and the places tied to
 * it — the run's trustworthiness check among them — do not change at all.
 *
 * @throws {UnmatchedPatternError} if a pattern matched no endpoint.
 */
export function expandPolicy(
  policy: ExpectedAccessPolicy,
  endpoints: readonly Endpoint[],
): ResolvedAccessPolicy {
  return {
    ...policy,
    rules: policy.rules.map((rule) => {
      if (rule.endpoints === ANY) {
        return { ...rule, endpoints: ANY };
      }
      const ids = rule.endpoints.flatMap((entry) =>
        typeof entry === "string" ? [entry] : expandPattern(entry, endpoints),
      );
      // Duplicates are removed: one endpoint could match both by identifier and
      // by pattern. That does not affect the result, but the list in the report
      // becomes readable.
      return { ...rule, endpoints: [...new Set(ids)] };
    }),
  };
}

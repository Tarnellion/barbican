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

/**
 * A rule of the policy under the number the report cites it by.
 *
 * The rule itself, not a copy of its selectors: the index **groups** the policy,
 * it does not restate it. A restatement is a second description of the same
 * thing, and the one that is not read is the one that goes wrong — which is the
 * failure this file's own comments keep coming back to.
 */
export interface IndexedAccessRule {
  /** The rule's number in `policy.rules`. */
  readonly index: number;
  readonly rule: ResolvedAccessRule;
}

/**
 * The rules declared under one set of request conditions.
 *
 * Conditions are the outer key because they are compared exactly: a cell under
 * conditions nobody declared is answered by `fallback`, and an empty bucket says
 * that without looking at a single rule.
 */
export interface ContextRules {
  /** For an endpoint the policy names: the rules naming it, in declaration order. */
  readonly byEndpoint: ReadonlyMap<string, readonly IndexedAccessRule[]>;
  /** The rules that match any endpoint, in declaration order. */
  readonly anyEndpoint: readonly IndexedAccessRule[];
}

/**
 * The policy arranged for lookup by cell.
 *
 * Built once per policy and passed in, rather than cached inside the resolution:
 * a memo in the core would be mutable state, and the core has none by design.
 * The same decision was taken for `resourceApplies` — see the comment in
 * `walk` — and for the same reason: hoisting removes the work, caching only
 * hides it.
 *
 * The audit of 14 August measured the cost of not having this: the policy was
 * scanned in full for every cell, and trimming a policy from 440 rules to 2 took
 * `findUnauthenticated` from 275 ms to 21 ms.
 */
export interface PolicyIndex {
  readonly fallback: ExpectedOutcome;
  readonly byContext: ReadonlyMap<string | undefined, ContextRules>;
}

/**
 * Arranges the policy for repeated lookup. Pure: the policy is not touched.
 *
 * A `Map` keyed by conditions and by endpoint identifiers, not an object: both
 * keys come from a human's configuration, and an object literal answers for
 * `constructor` and swallows `__proto__` (ADR-0024).
 */
export function indexPolicy(policy: ResolvedAccessPolicy): PolicyIndex {
  interface Bucket {
    readonly byEndpoint: Map<string, IndexedAccessRule[]>;
    readonly anyEndpoint: IndexedAccessRule[];
  }
  const byContext = new Map<string | undefined, Bucket>();

  policy.rules.forEach((rule, index) => {
    let bucket = byContext.get(rule.context);
    if (bucket === undefined) {
      bucket = { byEndpoint: new Map(), anyEndpoint: [] };
      byContext.set(rule.context, bucket);
    }
    const indexed: IndexedAccessRule = { index, rule };

    if (rule.endpoints === ANY) {
      bucket.anyEndpoint.push(indexed);
      return;
    }

    // A rule that names one endpoint twice lands in its list twice, and that is
    // left alone: the same rule matched twice is the same verdict, and a guard
    // against it would be a branch no test can distinguish from its absence.
    for (const endpointId of rule.endpoints) {
      const candidates = bucket.byEndpoint.get(endpointId);
      if (candidates === undefined) {
        bucket.byEndpoint.set(endpointId, [indexed]);
      } else {
        candidates.push(indexed);
      }
    }
  });

  return { fallback: policy.fallback, byContext };
}

/**
 * The last rule of a list that applies to this role under this relation.
 *
 * The one place a rule's selectors are read in order to decide a cell: the index
 * has already picked the candidates by conditions and by endpoint, and what is
 * left is the scope and the role. The loop runs to the end rather than stopping
 * at the first hit — **the last match wins**, and an early exit would answer with
 * the wrong rule, citing in the report a rule that decided nothing.
 */
function lastMatch(
  candidates: readonly IndexedAccessRule[],
  roleId: RoleId,
  relation: ResourceRelation | undefined,
): IndexedAccessRule | undefined {
  let matched: IndexedAccessRule | undefined;
  for (const candidate of candidates) {
    const { rule } = candidate;
    if (rule.scope !== undefined && rule.scope !== relation) {
      continue;
    }
    if (!matches(rule.roles, roleId)) {
      continue;
    }
    matched = candidate;
  }
  return matched;
}

/**
 * Resolves a cell against an index built by {@link indexPolicy}.
 *
 * Two lists are consulted — the rules that name this endpoint and the rules that
 * name any — and the later of the two answers wins, which is the same "last rule
 * wins" read across the whole policy: the rule numbers are the positions in it.
 * They are kept apart rather than merged so that a policy of broad rules does not
 * cost a copy of them per endpoint; both lists are short, and the whole point is
 * that neither is the policy.
 */
export function resolveIndexedVerdict(
  index: PolicyIndex,
  roleId: RoleId,
  endpointId: string,
  relation?: ResourceRelation,
  contextId?: string,
): ExpectedVerdict {
  // Conditions are compared exactly, including "both are absent": conditions
  // nobody declared a rule under have no bucket at all, and the fallback is the
  // whole answer.
  const bucket = index.byContext.get(contextId);
  if (bucket !== undefined) {
    const named = bucket.byEndpoint.get(endpointId);
    const broad = lastMatch(bucket.anyEndpoint, roleId, relation);
    const exact = named === undefined ? undefined : lastMatch(named, roleId, relation);
    const matched =
      exact !== undefined && (broad === undefined || exact.index > broad.index) ? exact : broad;
    if (matched !== undefined) {
      return { outcome: matched.rule.outcome, basis: "rule", ruleIndex: matched.index };
    }
  }
  return { outcome: index.fallback, basis: "fallback" };
}

/**
 * The verdict on one cell, straight from the policy.
 *
 * Builds an index and throws it away, which is what a single question costs.
 * Asking about many cells — a walk over the matrix, a pass over the
 * observations — means calling {@link indexPolicy} once and
 * {@link resolveIndexedVerdict} per cell; the index is the same for every cell,
 * and rebuilding it inside the loop is the work this pair exists to remove.
 */
export function resolveExpectedVerdict(
  policy: ResolvedAccessPolicy,
  roleId: RoleId,
  endpointId: string,
  relation?: ResourceRelation,
  contextId?: string,
): ExpectedVerdict {
  return resolveIndexedVerdict(indexPolicy(policy), roleId, endpointId, relation, contextId);
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

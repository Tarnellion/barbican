/**
 * The sign of an untrustworthy run.
 *
 * A separate layer, because the conclusion requires knowing the policy: a 401 on
 * its own is indistinguishable from a lawful denial. It is dangerous only where
 * access is **declared**: if every endpoint the account is meant to have answered
 * 401, then we did not get in — not that access was taken away.
 *
 * The first version of the check lived in the run and required a 401 on every
 * request in a row. A run against a live deployment showed that this is not
 * enough: a single public endpoint was enough for the condition to fail, and
 * broken authentication went unnoticed.
 */

import type {
  AccessObservation,
  Account,
  ResolvedAccessPolicy,
  Resource,
  TenantNode,
} from "../core/index.js";
import {
  createTenantHierarchy,
  FLAT_HIERARCHY,
  relationOf,
  resolveExpected,
} from "../core/index.js";

export interface AuthenticitySuspicion {
  readonly accountId: string;
  /** How many endpoints the policy considers accessible to this account. */
  readonly expectedAllowed: number;
  /** Of those, how many refused access. */
  readonly refused: number;
  /** The most frequent status among the denials — a hint about where to look. */
  readonly dominantStatus: number;
}

/**
 * Finds accounts where **not a single** endpoint declared accessible granted
 * access.
 *
 * The check is deliberately not tied to 401. Reconnaissance of crAPI showed that
 * denials can be non-uniform even inside one product: the Java service answers
 * 404 where the Django service answers 401. And a wall of 404s is also a typical
 * sign of a wrong `baseUrl` or path prefix. In all of these cases the result is
 * equally untrustworthy, so we look at the bare fact: a human declared access,
 * and there is no access anywhere.
 *
 * The threshold is strict on purpose: partial denials are the ordinary
 * 'unexpected denial' finding, and raising an alarm over them would train the
 * reader to expect false alarms.
 */
export function findUnauthenticated(
  accounts: readonly Account[],
  observations: readonly AccessObservation[],
  policy: ResolvedAccessPolicy,
  resources: readonly Resource[] = [],
  /**
   * The tenant tree. Leaving it out repeats the regression that happened when
   * `scope` was introduced: the relation was computed wrongly, `expectedAllowed`
   * always came out zero, and the safeguard never fired once.
   */
  tenants?: readonly TenantNode[],
): readonly AuthenticitySuspicion[] {
  const hierarchy = tenants === undefined ? FLAT_HIERARCHY : createTenantHierarchy(tenants);
  const suspicions: AuthenticitySuspicion[] = [];
  const byId = new Map(resources.map((resource) => [resource.id, resource]));

  for (const account of accounts) {
    let expectedAllowed = 0;
    let refused = 0;
    const statusCounts = new Map<number, number>();

    for (const observation of observations) {
      if (observation.accountId !== account.id) {
        continue;
      }
      // The relation is required: rules with a `scope` do not apply at all without
      // it, and for a policy in the ADR-0010 style the counter would stay zero —
      // that is, the safeguard would stay silent on exactly the style that is
      // recommended.
      const resource =
        observation.resourceId === undefined ? undefined : byId.get(observation.resourceId);
      const relation =
        resource === undefined ? undefined : relationOf(account, resource, hierarchy);
      // The conditions are required for exactly the same reason as the relation a
      // line above: without them an account under conditions would be compared
      // against the baseline expectations. Where the conditions are declared as
      // denying, 'no access anywhere' is the declared result, not a sign of broken
      // credentials, and the safeguard would call a healthy run untrustworthy.
      if (
        resolveExpected(
          policy,
          account.roleId,
          observation.endpointId,
          relation,
          account.contextId,
        ) !== "allowed"
      ) {
        continue;
      }
      expectedAllowed += 1;
      if (observation.outcome !== "allowed") {
        refused += 1;
        statusCounts.set(observation.status, (statusCounts.get(observation.status) ?? 0) + 1);
      }
    }

    if (expectedAllowed > 0 && refused === expectedAllowed) {
      let dominantStatus = 0;
      let best = 0;
      for (const [status, count] of statusCounts) {
        if (count > best) {
          best = count;
          dominantStatus = status;
        }
      }
      suspicions.push({ accountId: account.id, expectedAllowed, refused, dominantStatus });
    }
  }

  return suspicions;
}

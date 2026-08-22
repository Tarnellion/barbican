/**
 * Tests for the untrustworthy-run signal.
 *
 * The scenario all of this exists for: the token went stale, the requests came
 * back 401, the 401 read as a denial, the denial matched the expectation — and
 * the report said 'no escalations found' having checked nothing.
 *
 * The first version of the check required a 401 on every single request and
 * stayed silent against a live deployment: one public endpoint was enough. What
 * is pinned here is exactly the behaviour that was missing.
 */

import { describe, expect, it } from "vitest";
import type { AccessObservation, Account, ResolvedAccessPolicy } from "../../src/core/index.js";
import { ANY } from "../../src/core/index.js";
import { findUnauthenticated } from "../../src/report/authenticity.js";

const accounts: readonly Account[] = [
  { id: "user", roleId: "user", tenantId: "t" },
  { id: "admin", roleId: "admin", tenantId: "t" },
];

const policy: ResolvedAccessPolicy = {
  fallback: "denied",
  rules: [
    { roles: ANY, endpoints: ["me"], outcome: "allowed" },
    { roles: ["admin"], endpoints: ANY, outcome: "allowed" },
  ],
};

function observe(accountId: string, endpointId: string, status: number): AccessObservation {
  const outcome =
    status >= 200 && status < 300 ? "allowed" : status === 404 ? "not-found" : "denied";
  return { accountId, endpointId, status, headers: {}, outcome, durationMs: 1 };
}

describe("findUnauthenticated", () => {
  it("stays silent when everything works", () => {
    const observations = [
      observe("user", "me", 200),
      observe("user", "users.list", 403),
      observe("admin", "me", 200),
      observe("admin", "users.list", 200),
    ];

    expect(findUnauthenticated(accounts, observations, policy)).toEqual([]);
  });

  // Exactly the case the first version missed: a public endpoint answers 200 to
  // everyone, so "every request came back 401" does not hold.
  it("spots broken authentication even when some endpoints are open to everyone", () => {
    const observations = [observe("user", "me", 401), observe("user", "users.list", 200)];

    expect(findUnauthenticated(accounts, observations, policy)).toEqual([
      { accountId: "user", expectedAllowed: 1, refused: 1, dominantStatus: 401 },
    ]);
  });

  it("raises no alarm on a partial denial: that is an ordinary finding", () => {
    const observations = [observe("admin", "me", 401), observe("admin", "users.list", 200)];

    // Half of what was declared is available, so the login did happen, and the
    // discrepancy is worked through as an 'unexpected denial'.
    expect(findUnauthenticated(accounts, observations, policy)).toEqual([]);
  });

  it("passes no judgement on an account the policy grants nothing to", () => {
    const closed: ResolvedAccessPolicy = { fallback: "denied", rules: [] };
    const observations = [observe("user", "me", 401)];

    // With no declared access there is nothing to compare against, and the
    // alarm would be invented.
    expect(findUnauthenticated(accounts, observations, closed)).toEqual([]);
  });

  // Scouting crAPI: the identity service answers 404 where the workshop answers
  // 401. A wall of 404s is also a typical sign of a wrong baseUrl or path prefix.
  it("spots a wall of 404s just as it spots a wall of 401s", () => {
    const observations = [observe("user", "me", 404)];

    expect(findUnauthenticated(accounts, observations, policy)).toEqual([
      { accountId: "user", expectedAllowed: 1, refused: 1, dominantStatus: 404 },
    ]);
  });

  it("reports the dominant denial status", () => {
    const wide: ResolvedAccessPolicy = {
      fallback: "denied",
      rules: [{ roles: ANY, endpoints: ANY, outcome: "allowed" }],
    };
    const observations = [
      observe("user", "a", 404),
      observe("user", "b", 404),
      observe("user", "c", 401),
    ];

    expect(findUnauthenticated(accounts, observations, wide)).toEqual([
      { accountId: "user", expectedAllowed: 3, refused: 3, dominantStatus: 404 },
    ]);
  });
});

/**
 * What the pass reads out of the observations besides their contents.
 *
 * Written when the inner loop stopped walking every observation and filtering by
 * account, and started reading a list grouped by account instead. The counts are
 * the same either way; the order within an account and the boundary between
 * accounts are the two things a grouping could quietly change, and neither was
 * pinned anywhere. A test that only counted would have agreed with a grouping
 * that sorted, or that let a neighbour's 401 through.
 */
describe("the observations one account is judged on", () => {
  const wide: ResolvedAccessPolicy = {
    fallback: "denied",
    rules: [{ roles: ANY, endpoints: ANY, outcome: "allowed" }],
  };

  /**
   * A tie goes to the status seen first, because `dominantStatus` is a hint
   * about where to look and the run order is the only thing it can be a hint
   * from. Asserted in both directions: one of them alone passes under a sort.
   */
  it.each([
    [401, 404],
    [404, 401],
  ])("breaks a tie in the dominant status towards the first seen (%i)", (first, second) => {
    const observations = [observe("user", "a", first), observe("user", "b", second)];

    expect(findUnauthenticated(accounts, observations, wide)).toEqual([
      { accountId: "user", expectedAllowed: 2, refused: 2, dominantStatus: first },
    ]);
  });

  it("are its own, and no one else's", () => {
    // Interleaved, so a grouping that took a neighbour's row would take it from
    // the middle rather than from an edge. `ghost` is in no account list at all:
    // its refusals belong to nobody and must count for nobody.
    const observations = [
      observe("user", "a", 401),
      observe("ghost", "a", 401),
      observe("admin", "a", 200),
      observe("user", "b", 401),
      observe("ghost", "b", 401),
      observe("admin", "b", 200),
    ];

    expect(findUnauthenticated(accounts, observations, wide)).toEqual([
      { accountId: "user", expectedAllowed: 2, refused: 2, dominantStatus: 401 },
    ]);
  });
});

// A regression introduced by the move to a three-dimensional matrix: rules with
// a `scope` did not apply without a relation, so on an ADR-0010 style policy the
// counter of declared access stayed at zero and the safeguard was always silent.
describe("a policy with a scope", () => {
  const scoped: ResolvedAccessPolicy = {
    fallback: "denied",
    rules: [{ roles: ANY, endpoints: ["profile"], scope: "own", outcome: "allowed" }],
  };
  const accounts: readonly Account[] = [{ id: "u", roleId: "player", tenantId: "t" }];
  const resources = [{ id: "mine", tenantId: "t", ownerAccountId: "u", params: { id: "1" } }];

  function observeResource(status: number): AccessObservation {
    return {
      accountId: "u",
      endpointId: "profile",
      resourceId: "mine",
      status,
      headers: {},
      outcome: status >= 200 && status < 300 ? "allowed" : "denied",
      durationMs: 1,
    };
  }

  it("spots broken authentication even on a policy built entirely on scope", () => {
    expect(findUnauthenticated(accounts, [observeResource(401)], scoped, resources)).toEqual([
      { accountId: "u", expectedAllowed: 1, refused: 1, dominantStatus: 401 },
    ]);
  });

  it("stays silent when the account's own resource is available", () => {
    expect(findUnauthenticated(accounts, [observeResource(200)], scoped, resources)).toEqual([]);
  });
});

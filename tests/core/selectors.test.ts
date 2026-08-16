/**
 * Tests for selecting endpoints by pattern.
 *
 * The task had been open since the very first session: on a hundred endpoints
 * listing them by `id` is unmaintainable, and it drifts from reality silently —
 * an uncovered pair falls through to `fallback`, and the report stays clean.
 */

import { describe, expect, it } from "vitest";
import type { ResolvedAccessPolicy } from "../../src/core/expected.js";
import { ANY, expandPolicy } from "../../src/core/expected.js";
import {
  endpointMatches,
  expandPattern,
  pathPatternToRegExp,
  UnmatchedPatternError,
} from "../../src/core/selectors.js";
import type { Endpoint } from "../../src/core/types.js";

const ENDPOINTS: readonly Endpoint[] = [
  { id: "admin.users", method: "GET", path: "/v1/admin/users" },
  { id: "admin.audit", method: "GET", path: "/v1/admin/audit/log" },
  { id: "admin.purge", method: "DELETE", path: "/v1/admin/users" },
  { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
  { id: "health", method: "GET", path: "/v1/health" },
];

describe("pathPatternToRegExp", () => {
  /**
   * Templated paths carry braces. Without escaping, `{orderId}` would become a
   * regular expression quantifier and the pattern would match the wrong thing.
   */
  it("escapes the braces of a templated path", () => {
    expect(pathPatternToRegExp("/v1/orders/{orderId}").test("/v1/orders/{orderId}")).toBe(true);
    expect(pathPatternToRegExp("/v1/orders/{orderId}").test("/v1/orders/x")).toBe(false);
  });

  it("a single star does not cross a segment boundary", () => {
    const pattern = pathPatternToRegExp("/v1/admin/*");

    expect(pattern.test("/v1/admin/users")).toBe(true);
    expect(pattern.test("/v1/admin/audit/log")).toBe(false);
  });

  it("a double star crosses segment boundaries", () => {
    const pattern = pathPatternToRegExp("/v1/admin/**");

    expect(pattern.test("/v1/admin/users")).toBe(true);
    expect(pattern.test("/v1/admin/audit/log")).toBe(true);
  });

  it("matches the whole path, not a substring", () => {
    expect(pathPatternToRegExp("/v1/admin").test("/v1/admin/users")).toBe(false);
    expect(pathPatternToRegExp("admin").test("/v1/admin")).toBe(false);
  });
});

describe("endpointMatches", () => {
  const users = ENDPOINTS[0] as Endpoint;
  const purge = ENDPOINTS[2] as Endpoint;

  it("with no method any method matches", () => {
    expect(endpointMatches(users, { path: "/v1/admin/*" })).toBe(true);
    expect(endpointMatches(purge, { path: "/v1/admin/*" })).toBe(true);
  });

  it("with a method it tells identical paths apart", () => {
    expect(endpointMatches(users, { method: "GET", path: "/v1/admin/users" })).toBe(true);
    expect(endpointMatches(purge, { method: "GET", path: "/v1/admin/users" })).toBe(false);
  });
});

describe("the text of UnmatchedPatternError", () => {
  /**
   * The message is the whole of what a human gets, and the branch inside it
   * inverted without a single test failing: a pattern reported with the wrong
   * method sends the reader looking for a rule they did not write. Found by the
   * audit of 14 August (C-7).
   */
  it("names the method when the pattern has one, and omits it when it does not", () => {
    expect(new UnmatchedPatternError({ method: "POST", path: "/v1/orders" }).message).toContain(
      'Pattern "POST /v1/orders"',
    );
    const withoutMethod = new UnmatchedPatternError({ path: "/v1/orders" }).message;
    expect(withoutMethod).toContain('Pattern "/v1/orders"');
    expect(withoutMethod).not.toContain("undefined");
  });
});

describe("expandPattern", () => {
  it("expands a pattern into identifiers", () => {
    expect(expandPattern({ path: "/v1/admin/**" }, ENDPOINTS)).toEqual([
      "admin.users",
      "admin.audit",
      "admin.purge",
    ]);
  });

  /**
   * A pattern that matched nothing is the same class of error as a typo in an
   * identifier: the rule never applies, the pairs fall through to `fallback`,
   * and the report stays clean. Staying silent is not an option.
   */
  it("rejects a pattern that matched no endpoint", () => {
    expect(() => expandPattern({ path: "/v1/no-such-area/*" }, ENDPOINTS)).toThrow(
      UnmatchedPatternError,
    );
  });

  it("rejects a pattern that matched by path but not by method", () => {
    expect(() => expandPattern({ method: "POST", path: "/v1/health" }, ENDPOINTS)).toThrow(
      UnmatchedPatternError,
    );
  });
});

describe("expandPolicy", () => {
  it("replaces patterns with identifiers and leaves explicit ones as they are", () => {
    const expanded = expandPolicy(
      {
        fallback: "denied",
        rules: [
          {
            roles: ["admin"],
            endpoints: ["health", { method: "GET", path: "/v1/admin/**" }],
            outcome: "allowed",
          },
        ],
      },
      ENDPOINTS,
    );

    expect(expanded.rules[0]?.endpoints).toEqual(["health", "admin.users", "admin.audit"]);
  });

  it("leaves a rule with a star alone", () => {
    const expanded = expandPolicy(
      { fallback: "denied", rules: [{ roles: ANY, endpoints: ANY, outcome: "allowed" }] },
      ENDPOINTS,
    );

    expect(expanded.rules[0]?.endpoints).toBe(ANY);
  });

  /** One endpoint could match both by identifier and by pattern. */
  it("does not duplicate an endpoint that matched twice", () => {
    const expanded = expandPolicy(
      {
        fallback: "denied",
        rules: [
          {
            roles: ANY,
            endpoints: ["admin.users", { path: "/v1/admin/users" }],
            outcome: "denied",
          },
        ],
      },
      ENDPOINTS,
    );

    expect(expanded.rules[0]?.endpoints).toEqual(["admin.users", "admin.purge"]);
  });

  it("an expanded policy fits where an expanded one is required", () => {
    const expanded: ResolvedAccessPolicy = expandPolicy(
      {
        fallback: "denied",
        rules: [{ roles: ANY, endpoints: [{ path: "/v1/**" }], outcome: "allowed" }],
      },
      ENDPOINTS,
    );

    expect(expanded.rules[0]?.endpoints).toHaveLength(ENDPOINTS.length);
  });
});

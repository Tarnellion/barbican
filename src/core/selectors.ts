/**
 * Selecting endpoints by a method-and-path pattern.
 *
 * Listing by `id` does not scale: on a platform with a hundred endpoints the
 * rule "an administrator is meant to have everything under /v1/admin" turns into
 * a list of thirty identifiers, which drifts from reality at the very first new
 * endpoint — and silently, because an uncovered pair falls through to
 * `fallback`.
 *
 * Patterns are expanded into concrete identifiers **before** the diff. That
 * keeps policy resolution as it was, and a pattern that matched nothing is
 * caught at startup: it is the same class of mistake as a typo in an identifier,
 * and staying silent about it is not allowed.
 */

import type { Endpoint, HttpMethod } from "./types.js";

/** A selection pattern. The method is optional: its absence means "any". */
export interface EndpointPattern {
  readonly method?: HttpMethod | undefined;
  /** The path pattern: `*` inside a segment, `**` across segments. */
  readonly path: string;
}

export class UnmatchedPatternError extends Error {
  constructor(pattern: EndpointPattern) {
    const method = pattern.method === undefined ? "" : `${pattern.method} `;
    super(
      `Pattern "${method}${pattern.path}" matched no endpoint. ` +
        `A rule with this pattern will never apply, and its cells will silently fall ` +
        `through to the fallback — the same effect as a typo in an identifier.`,
    );
    this.name = "UnmatchedPatternError";
  }
}

const REGEXP_SPECIAL = /[.+?^${}()|[\]\\]/g;

/**
 * Turns a path pattern into a regular expression.
 *
 * Everything special is escaped first — template paths contain curly braces
 * (`/v1/players/{playerId}`), and without escaping they would become a
 * quantifier. Only then are `*` and `**` expanded.
 */
export function pathPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(REGEXP_SPECIAL, "\\$&");
  // The double star is handled before the single one: otherwise `**` would fall
  // apart into two single ones and stop crossing segment boundaries.
  const body = escaped
    .split("**")
    .map((chunk) => chunk.split("*").join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/**
 * Whether the endpoint matches the pattern. The template path is compared, not
 * the substituted one.
 */
export function endpointMatches(endpoint: Endpoint, pattern: EndpointPattern): boolean {
  if (pattern.method !== undefined && pattern.method !== endpoint.method) {
    return false;
  }
  return pathPatternToRegExp(pattern.path).test(endpoint.path);
}

/**
 * Expands a pattern into identifiers.
 *
 * @throws {UnmatchedPatternError} if the pattern matched nothing.
 */
export function expandPattern(
  pattern: EndpointPattern,
  endpoints: readonly Endpoint[],
): readonly string[] {
  const matched = endpoints
    .filter((endpoint) => endpointMatches(endpoint, pattern))
    .map((endpoint) => endpoint.id);
  if (matched.length === 0) {
    throw new UnmatchedPatternError(pattern);
  }
  return matched;
}

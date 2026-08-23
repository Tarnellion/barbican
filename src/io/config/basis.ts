/**
 * Request attributes are added to a request; they do not replace its substance.
 *
 * Three layers, not one, and the first version of the rule was wrong with only
 * the first (ADR-0019): exact header names, families of them by prefix, and a
 * check by **value**, which is what catches a method override smuggled through
 * an attribute. All three tables are hardcoded here and are never taken from
 * user input — a list that guards the substance of a request, read out of the
 * same file as the conditions themselves, would be a door guarded with the key
 * hanging on its outside.
 *
 * The rule is asked twice: at the door, while a configuration is parsed, where
 * the context id and the declared schemes are known and the message can say
 * more; and at the seam where the request is assembled, which covers the doors
 * nobody has opened yet. See ADR-0037.
 */

import type { ContextValues } from "./types.js";

/**
 * Context attributes cannot replace credential and control headers.
 *
 * The list is hardcoded and never taken from user input. Conditions that quietly
 * rewrote `Authorization` would give a run where half the cells go out as a
 * different account — and it would look like findings about the platform.
 */
export class ForbiddenContextHeaderError extends Error {
  constructor(contextId: string, header: string, reason: string) {
    super(
      `Context "${contextId}" sets header "${header}": ${reason}. ` +
        `Context attributes are added to a request, they do not replace its substance.`,
    );
    this.name = "ForbiddenContextHeaderError";
  }
}

/**
 * A resource's query string carries what a context's may not.
 *
 * The two go into the request address by the same route, and only one of them
 * was guarded: `assertContextsCannotWrite` and `FORBIDDEN_QUERY_KEYS` read
 * contexts, the channel an operator fills in by hand, and never resources. A
 * credential named here is printed verbatim in `observations[].url`, and a write
 * method named here is performed by a platform that honours overrides while the
 * run believes it sent a read. Found by adversarial review on 17 August 2026.
 */
export class ForbiddenResourceQueryError extends Error {
  readonly resourceId: string;
  readonly key: string;

  constructor(resourceId: string, key: string, reason: string) {
    super(`Resource "${resourceId}" declares the query parameter "${key}": ${reason}`);
    this.name = "ForbiddenResourceQueryError";
    this.resourceId = resourceId;
    this.key = key;
  }
}

export class ForbiddenContextQueryError extends Error {
  constructor(contextId: string, key: string, reason: string) {
    super(
      `Context "${contextId}" sets query parameter "${key}": ${reason}. ` +
        `Context attributes are added to a request, they do not replace its substance.`,
    );
    this.name = "ForbiddenContextQueryError";
  }
}

export class MethodOverrideInContextError extends Error {
  /**
   * @param subject where the value was declared — `Context` or `Resource`. The
   * message names the section of the file the operator has to go and edit, and
   * the two are different sections; the seam checks both, so it cannot call
   * either one by the other's name.
   */
  constructor(contextId: string, where: string, value: string, subject = "Context") {
    super(
      `${subject} "${contextId}" sets ${where} to "${value}" — that is the name of an ` +
        `HTTP method. Platforms that honour method override (Rails, Laravel, Symfony, ` +
        `Spring, most API gateways) will perform a write for such a request even ` +
        `while a GET goes over the wire: the safe-method gate looks at the request ` +
        `method and cannot see that bypass. If writing is the intention, run with ` +
        `--unsafe-methods and the report will say so honestly.`,
    );
    this.name = "MethodOverrideInContextError";
  }
}

/**
 * Rejects context attributes that override the method of the request.
 *
 * The check goes **by value**, not by name, and that is the whole point. Method
 * override has a dozen names and will have more; its value, though, is always the
 * same one — the name of a method. The rule catches `x-http-method-override`, a
 * vendor header I have never heard of, and `_method` in the query string alike.
 *
 * It lives apart from configuration parsing because it depends on a run flag: with
 * `--unsafe-methods` the human has already agreed to writes, and there is nothing
 * to forbid.
 *
 * Found by adversarial review. The deployment deleted a resource on a request the
 * tool considered a read, while the report said `writeMethodsProbed: false`.
 *
 * @throws {MethodOverrideInContextError}
 */
export function assertContextsCannotWrite(
  contexts: ReadonlyMap<string, ContextValues>,
  options: { readonly allowUnsafeMethods: boolean },
): void {
  if (options.allowUnsafeMethods) {
    return;
  }
  // The **resolved** values are checked, not the declared ones: a value from an
  // environment variable is not yet known when the configuration is parsed, and
  // checking the declaration would let `x-vendor-verb: { env: VERB }` through with
  // `VERB=DELETE` in the environment.
  for (const [contextId, values] of contexts) {
    for (const [name, value] of Object.entries(values.headers)) {
      if (WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
        throw new MethodOverrideInContextError(contextId, `header "${name}"`, value);
      }
    }
    for (const [key, value] of Object.entries(values.query)) {
      if (WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
        throw new MethodOverrideInContextError(contextId, `query parameter "${key}"`, value);
      }
    }
  }
}

/**
 * The same three rules, asked at the seam where the request is assembled.
 *
 * `assertContextsCannotWrite` above and the checks in `normalizeContexts` read a
 * parsed configuration, which is one door of four. `collectObservations` takes
 * `contextAttributes` straight from a consumer of the library, and that door had
 * nothing between it and the wire: the audit of 20 August 2026 (A-1, E-02, E-03)
 * sent `?_method=DELETE` and `x-http-method-override: DELETE` through it with
 * `allowUnsafeMethods: false`, and put a credential from `resources[].query`
 * into the report.
 *
 * ADR-0032 moved the address grammar to the seam for this reason and moved only
 * that; this is the rest of the same move. The door keeps its checks: it knows
 * the context id, the declared auth schemes and the resource keys, so it says
 * more about what is wrong and says it before a single request goes out. What
 * cannot be said here is said there — but what is said here is said for every
 * door there will ever be.
 *
 * Cheap on purpose: two sets and a prefix list against the attributes of one
 * request, next to a network call.
 *
 * @throws {MethodOverrideInContextError} a value names a method that writes
 * @throws {ForbiddenContextHeaderError} a name decides the basis of the request
 * @throws {ForbiddenContextQueryError} a key presents credentials
 */
export function assertAttributesKeepTheBasis(
  /**
   * Where these values were declared, so the message names the line to go and
   * edit. A resource and a set of conditions are different sections of the file,
   * and calling a resource a context sends the reader to the wrong one — the
   * class of defect this project keeps finding in its own diagnostics.
   */
  subject: { readonly kind: "context" | "resource"; readonly id: string },
  attributes: {
    readonly headers: Readonly<Record<string, string>>;
    readonly query: Readonly<Record<string, string>>;
  },
  options: { readonly allowUnsafeMethods: boolean },
): void {
  const { kind, id: contextId } = subject;
  for (const [name, value] of Object.entries(attributes.headers)) {
    const lower = name.toLowerCase();
    const forbidden =
      FORBIDDEN_CONTEXT_HEADERS.get(lower) ??
      FORBIDDEN_HEADER_PREFIXES.find(([prefix]) => lower.startsWith(prefix))?.[1];
    if (forbidden !== undefined) {
      throw new ForbiddenContextHeaderError(contextId, name, forbidden);
    }
    if (!options.allowUnsafeMethods && WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
      throw new MethodOverrideInContextError(
        contextId,
        `header "${name}"`,
        value,
        kind === "resource" ? "Resource" : "Context",
      );
    }
  }
  for (const [key, value] of Object.entries(attributes.query)) {
    if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase())) {
      const why =
        "credentials are presented through this: the platform would serve the " +
        "request as a different account while the report names the original one";
      throw kind === "resource"
        ? new ForbiddenResourceQueryError(contextId, key, why)
        : new ForbiddenContextQueryError(contextId, key, why);
    }
    if (!options.allowUnsafeMethods && WRITE_METHOD_WORDS.has(value.trim().toUpperCase())) {
      throw new MethodOverrideInContextError(
        contextId,
        `query parameter "${key}"`,
        value,
        kind === "resource" ? "Resource" : "Context",
      );
    }
  }
}

/**
 * The headers conditions are not allowed to set.
 *
 * Hardcoded, not configurable: the list guards the substance of a request, and
 * taking it from the same file as the conditions themselves would mean guarding a
 * door with the key hanging on its outside. `authorization` and `cookie` are
 * credentials; `host` takes the request outside the scope while the address stays
 * unchanged; the rest break the exchange itself.
 */
export const FORBIDDEN_CONTEXT_HEADERS: ReadonlyMap<string, string> = new Map([
  ["authorization", "these are the account's credentials"],
  ["proxy-authorization", "these are credentials"],
  ["cookie", "these are the account's credentials"],
  ["host", "overriding the host takes the request outside the declared scope"],
  ["forwarded", "a routing header: it changes the recipient, not the conditions"],
  ["content-length", "a transport header, not an attribute of the request"],
  ["transfer-encoding", "a transport header, not an attribute of the request"],
  ["connection", "a transport header, not an attribute of the request"],
  ["te", "a transport header, not an attribute of the request"],
  ["upgrade", "a transport header, not an attribute of the request"],
  ["expect", "a transport header, not an attribute of the request"],
]);

/**
 * Families of headers that change the **meaning** of a request, not its conditions.
 *
 * Found by adversarial review, and the finding was of the worst kind: conditions
 * carrying `x-http-method-override: DELETE` made the platform delete a resource
 * while a GET went over the wire — and the report meanwhile said
 * `writeMethodsProbed: false`. The `SAFE_METHODS` gate looks at the method in the
 * request and does not see that bypass.
 *
 * By prefix, not by exact name: the override header has a dozen spellings
 * (`X-HTTP-Method`, `X-HTTP-Method-Override`, `X-Method-Override`), and a list of
 * exact names will fall behind the next framework. `x-forwarded-for` is allowed on
 * purpose — it is the typical attribute of geo conditions; only those
 * `x-forwarded-*` that change the recipient are forbidden.
 */
export const FORBIDDEN_HEADER_PREFIXES: readonly (readonly [string, string])[] = [
  ["x-http-method", "a method-override header: the platform will write behind a GET"],
  ["x-method", "a method-override header: the platform will write behind a GET"],
  ["x-original-", "a path-override header: the request would go past the declared path"],
  ["x-rewrite-", "a path-override header: the request would go past the declared path"],
  ["x-forwarded-host", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-proto", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-port", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-prefix", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-uri", "a routing header: it changes the recipient, not the conditions"],
];

/**
 * Words that name a write, for the check by **value**.
 *
 * Wider than `HttpMethod`: `CONNECT` is not in the domain and a platform
 * honouring an override does not care what this tool's type says. One source
 * because two places read it — the conditions an operator declares and the query
 * a resource declares — and a set written twice is the shape B-10 was about.
 *
 * The seven original words were the methods this tool knows. That is not the set
 * a platform will execute: adversarial review of 19 August 2026 got `MOVE`
 * through as a resource query and as an attribute value, and `MOVE` deletes the
 * source. The WebDAV and versioning methods are here now, with `PURGE` for the
 * caches that honour it.
 *
 * An enumeration, and this one is allowed to be an enumeration — unlike the
 * denylist of header names ADR-0005's addendum threw out. The difference is what
 * the set has to be complete against: header names that will ever carry a secret
 * are unbounded and belong to whoever wrote the platform, while a method a
 * platform can be talked into performing is a registered token — IANA's method
 * registry plus the handful of vendor verbs below. Where a name outside it does
 * turn out to perform a write, the entry to add is here, in the one set both
 * readers share.
 */
export const WRITE_METHOD_WORDS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
  // RFC 4918 (WebDAV): every one of these changes something on the target.
  "COPY",
  "LOCK",
  "MKCOL",
  "MOVE",
  "PROPPATCH",
  "UNLOCK",
  // RFC 3253 and RFC 5842: versioning and binding.
  "BASELINE-CONTROL",
  "BIND",
  "CHECKIN",
  "CHECKOUT",
  "LABEL",
  "MERGE",
  "MKACTIVITY",
  "MKWORKSPACE",
  "REBIND",
  "UNBIND",
  "UNCHECKOUT",
  "UPDATE",
  "VERSION-CONTROL",
  // The rest of the registry that writes, and the reason this list is written
  // out rather than described: the second adversarial review of 19 August took
  // the paragraph above at its word — "IANA's method registry" — and found six
  // registered methods missing from it. A claim about a registry has to be the
  // registry.
  "LINK",
  "MKCALENDAR",
  "MKREDIRECTREF",
  "ORDERPATCH",
  "UNLINK",
  "UPDATEREDIRECTREF",
  // RFC 3744: access control. A method that rewrites permissions on a run
  // checking permissions is the worst of the lot.
  "ACL",
  // Vendor, and common enough to matter: cache invalidation.
  "PURGE",
]);

/**
 * The query-string keys that present credentials.
 *
 * A token in the query string means a different account: the platform will serve
 * the request as that account, while the report will write the original
 * `baseAccountId`. Found by adversarial review: an `access_token` in the conditions
 * was served as someone else's account, and a whole half of the matrix went out as
 * somebody other than the one the report named. On top of that the value itself
 * would land in the report in the clear — request addresses are printed there.
 */
export const FORBIDDEN_QUERY_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "authorization",
  "id_token",
  "jwt",
  "session",
  "sessionid",
  "session_id",
  "token",
]);

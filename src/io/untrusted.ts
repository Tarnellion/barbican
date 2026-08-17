/**
 * Strings from outside, and the slots they are allowed into.
 *
 * The audit of 14 August 2026 counted eleven point fixes of one shape across
 * four files: a string arrives from a configuration, an environment variable or
 * a response, and is dropped into a slot with a grammar of its own — a header
 * name, a header value, a path segment, a key in a record. Each site checked
 * what it happened to remember to check.
 *
 * Two of them had already drifted: the same header-value rule was written twice
 * and the copies differed by one character, `*` against `+`. Two more were not
 * written at all, and `fetch` refused the request from inside the retry loop —
 * three attempts, then `RequestFailedError` saying "Cannot convert argument to a
 * ByteString", which names neither the header nor the value nor the account.
 *
 * The cure is the one the project already applies twice — `SignalValue` is a
 * number or a boolean, and `Account` is a union — and states as a principle: a
 * duplicate the compiler cannot check drifts apart sooner or later. Here the
 * grammars are written once, and the only way to obtain a value of the branded
 * type is to pass through the check. `HttpRequest.headers` then asks for
 * `HeaderValue`, so a raw `Record<string, string>` cannot reach the client from
 * anywhere — not from the CLI, and not from a consumer of the library, which is
 * the half that was open (D-6).
 */

import { isUsablePathSegment } from "../core/types.js";

/**
 * A string checked to be usable as an HTTP header value.
 *
 * The brand is not carried at runtime — it is a string. What it buys is that the
 * only way to get one is `headerValue`, and that is checked by the compiler at
 * every call site at once rather than by a reviewer at each.
 */
export type HeaderValue = string & { readonly __untrusted: "HeaderValue" };

/** A string checked to be usable as an HTTP header name. */
export type HeaderName = string & { readonly __untrusted: "HeaderName" };

/** A string checked to be usable as one segment of a URL path. */
export type PathSegment = string & { readonly __untrusted: "PathSegment" };

/**
 * A header name per RFC 9110: visible ASCII without separators.
 *
 * Written twice before — in `config.ts` and in `credentials.ts` — identically,
 * which is the state a duplicate is in right up until it is not.
 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A header value: visible ASCII and the tab, nothing else — `fetch` refuses the
 * rest.
 *
 * `*`, not `+`. The two copies of this rule disagreed on exactly that: an empty
 * value is legal in HTTP and legitimate for a declared request condition. Where
 * emptiness is itself wrong — a credential read out of the environment — it is
 * caught before this, and with an error that says which variable was empty
 * rather than "unfit as a header value".
 */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

export class UnusableHeaderNameError extends Error {
  override readonly name = "UnusableHeaderNameError";
  constructor(value: string) {
    super(
      `"${value}" is not usable as a header name. RFC 9110 allows visible ASCII ` +
        `without separators: letters, digits and !#$%&'*+-.^_\`|~`,
    );
  }
}

export class UnusableHeaderValueError extends Error {
  override readonly name = "UnusableHeaderValueError";
  /** The name, never the value: this is thrown on credentials as well. */
  constructor(headerName: string) {
    super(
      `the value of the "${headerName}" header cannot be sent: a header value ` +
        `admits visible ASCII and the tab character only`,
    );
  }
}

export class UnusablePathSegmentError extends Error {
  override readonly name = "UnusablePathSegmentError";
  constructor(value: string) {
    super(
      `"${value}" is not usable as a path segment: an empty segment, "." and ".." ` +
        `navigate rather than name, and would send the request to a different address`,
    );
  }
}

/**
 * The predicates, for callers with a better error to throw.
 *
 * Parsing a configuration knows which context or which account the string came
 * from, and "the header of context geo-blocked" beats "not usable as a header
 * name" by the whole distance between a message and a fix. What matters is that
 * the **rule** is here and in one place; who reports it is the caller's business.
 */
export function isHeaderName(value: string): boolean {
  return HEADER_NAME.test(value);
}

export function isHeaderValue(value: string): boolean {
  return HEADER_VALUE.test(value);
}

/** @throws {UnusableHeaderNameError} */
export function headerName(value: string): HeaderName {
  if (!isHeaderName(value)) {
    throw new UnusableHeaderNameError(value);
  }
  return value as HeaderName;
}

/**
 * @param forHeader the name, for the error message — the value is never printed
 * @throws {UnusableHeaderValueError}
 */
export function headerValue(value: string, forHeader: string): HeaderValue {
  if (!isHeaderValue(value)) {
    throw new UnusableHeaderValueError(forHeader);
  }
  return value as HeaderValue;
}

/**
 * One segment of a path, escaped.
 *
 * `encodeURIComponent` escapes the slash and not the dot, so a value of `.` or
 * `..` survives it and navigates: the request goes to a different endpoint
 * inside the target, the exclusion list is bypassed, and the verdict for one
 * endpoint is computed from another one's answer. The scope guard never
 * defended this and could not — nothing leaves the target. See D-1 and
 * `isUsablePathSegment`, which is in the core because the core builds cells out
 * of the same values.
 *
 * @throws {UnusablePathSegmentError}
 */
export function pathSegment(value: string): PathSegment {
  if (!isUsablePathSegment(value)) {
    throw new UnusablePathSegmentError(value);
  }
  return encodeURIComponent(value) as PathSegment;
}

/**
 * A path template, as an endpoint source hands it over.
 *
 * A template is a path and nothing else: no query, no fragment, and no segment
 * that navigates. `pathSegment` above guards the **values** a resource
 * substitutes into it (D-1); nothing guarded the template itself, and an
 * endpoint source is an untrusted document — ADR-0005 says so in its second
 * addendum, and three of the four sources take one.
 *
 * Two things came through. A query string travelled to the platform verbatim, so
 * `paths: "/v1/orders/{orderId}?_method=DELETE"` in a specification issued a GET
 * on the wire that a great many frameworks execute as a DELETE — with
 * `--unsafe-methods` absent, `writeMethodsProbed: false` in the report and exit
 * 0. `SAFE_METHODS` held to the letter and the guarantee it stands for did not.
 * The project already knew this attack: `assertContextsCannotWrite` checks it
 * **by value** for the one channel an operator fills in by hand, and left the
 * three fed by somebody else's document unguarded.
 *
 * And `..` navigated: `paths: "/v1/reports/../../createdb"` reached `/createdb`,
 * which the exclusion list cannot prevent because that list works on endpoint
 * ids and never sees the string. The verdict for one endpoint was then computed
 * from another one's answer.
 *
 * Both are refused here rather than in each source, because a grammar for a
 * string from outside is written once — ADR-0024, and this is the twelfth case
 * that rule exists to stop being a twelfth point fix. Found by adversarial
 * review on 17 August 2026.
 */
export class UnusablePathTemplateError extends Error {
  readonly template: string;

  constructor(template: string, reason: string) {
    super(
      `The endpoint path "${template}" ${reason}. A path template is a path: the ` +
        `values come from a declared resource, and everything else in the address ` +
        `is the tool's to build. Flatten the source before testing.`,
    );
    this.name = "UnusablePathTemplateError";
    this.template = template;
  }
}

/**
 * Whether a path template is one.
 *
 * Exported beside the constructor because the core reads it too: an endpoint is a
 * cell coordinate, and the same string reaches the matrix.
 */
export function isUsablePathTemplate(value: string): boolean {
  if (value.includes("?") || value.includes("#")) {
    return false;
  }
  // Percent-encoded forms as well: `%2e%2e` decodes to `..` in the target, and
  // the origin server is where that matters rather than here.
  const decoded = value.replace(/%2e/gi, ".").replace(/%2f/gi, "/");
  return !decoded.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * @throws {UnusablePathTemplateError}
 */
export function pathTemplate(value: string): string {
  if (value.includes("?") || value.includes("#")) {
    throw new UnusablePathTemplateError(
      value,
      "carries a query string or a fragment, which would travel to the platform " +
        "verbatim — a method override smuggled that way performs a write the run " +
        "never asked for",
    );
  }
  if (!isUsablePathTemplate(value)) {
    throw new UnusablePathTemplateError(
      value,
      "navigates with `.` or `..`, so the request would reach an endpoint other " +
        "than the one it names — past the exclusion list, which works on ids",
    );
  }
  return value;
}

/**
 * A record whose keys came from outside.
 *
 * `Object.create(null)` rather than `{}`. A plain object literal inherits
 * `Object.prototype`, so assigning to the key `__proto__` calls the prototype
 * setter instead of creating a property: the entry silently disappears, and the
 * object's prototype is replaced. Two places in this repository lost data that
 * way — a signal named `__proto__` vanished from every observation, and so did a
 * response header, eighteen lines below a comment promising that the name of a
 * header is always kept.
 *
 * No validation here on purpose: this is for keys and values the tool did not
 * choose. A target may answer with any header it likes, and refusing to record
 * one would hand it a way to blind the run.
 */
export function openRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Headers to be sent, every name and value checked.
 *
 * Both halves at once, because they fail differently: an unusable name is a
 * mistake in the configuration, an unusable value is usually a mistake in the
 * environment. Built on `openRecord`, so a header literally named `__proto__`
 * is carried rather than swallowed.
 *
 * @throws {UnusableHeaderNameError}
 * @throws {UnusableHeaderValueError}
 */
export function safeHeaders(
  entries: Iterable<readonly [string, string]>,
): Readonly<Record<string, HeaderValue>> {
  const headers = openRecord<HeaderValue>();
  for (const [name, value] of entries) {
    headers[headerName(name)] = headerValue(value, name);
  }
  return headers;
}

/**
 * A lookup by a key that came from outside.
 *
 * `record[key]` walks the prototype chain: `tokenEnv: constructor` returned
 * `Object.prototype.constructor` from a `process.env` copy, and the caller got
 * `TypeError: value.trim is not a function` where it expected
 * `MissingCredentialError`. The class was already recognised and closed once
 * elsewhere in `config.ts`, which is what makes it a class rather than a bug.
 */
export function lookup<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

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

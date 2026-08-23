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
 * Characters a URL parser does not read the way a split on `/` does.
 *
 * A backslash is a path separator for http and https — `new URL` says so and
 * this grammar's `split("/")` did not, so a template spelling `reports`, two
 * navigating segments and `danger` with backslashes between them was one
 * segment here and `/danger` on the wire. Tab, newline and carriage return are
 * worse than a separator: the parser **removes** them before it reads anything,
 * so a segment of dot, newline, dot becomes `..` after this function has
 * approved it. Both were found by adversarial review on 19 August 2026, against
 * the guard written on 17 August for the same class.
 *
 * Refused outright rather than folded into the split. Modelling somebody else's
 * normalisation is how this was wrong the first time; a path has no use for
 * either character, and refusing does not depend on getting the model right.
 * The rest of the C0 range and DEL come along: the parser percent-encodes them,
 * so they navigate nowhere, but a document carrying one is to be looked at
 * rather than walked.
 */
function isNeverInAPath(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  // A regular expression would say this in one line and Biome refuses it —
  // `noControlCharactersInRegex`, and for once the rule and the intent agree:
  // the class is easier to read as the question it is asking.
  return character === "\\" || code < 0x20 || code === 0x7f;
}

/** Whether the string carries any of them. */
function carriesNothingAddressable(value: string): boolean {
  return [...value].some(isNeverInAPath);
}

/**
 * The percent-encoded spellings of the three characters this grammar decides on.
 *
 * The target decodes them, and the target is where the navigation happens: this
 * side never sees a `/` in `%2f`. `%5c` joined the pair when the backslash did.
 */
function decodePathish(value: string): string {
  return value.replace(/%2e/gi, ".").replace(/%2f/gi, "/").replace(/%5c/gi, "\\");
}

/**
 * Whether a segment navigates, in any spelling the receiver will collapse.
 *
 * Three of them, and the first was the whole of this function until the second
 * adversarial review of 19 August 2026:
 *
 * - `.` and `..` written out, which everyone collapses;
 * - `%2e` in either case, which **`new URL` itself** collapses — the URL Standard
 *   calls `.%2e`, `%2e.` and `%2e%2e` double-dot path segments, so
 *   `reports/%2e%2e/danger` became `/danger` inside `joinUrl`, before any
 *   platform saw it. The seam had been written to read the string literally, on
 *   the reasoning that only the target decodes. The reasoning was wrong about the
 *   parser this tool itself calls;
 * - a `;` parameter after the dots. `..;` is not `..` to anybody here, and a
 *   servlet container strips `;params` from a segment **before** it normalises
 *   the path — the long-standing way past a path-prefix rule in Spring Security.
 *
 * The `%2e` decoding happens here rather than in `decodePathish` because it is
 * safe on both sides of the grammar: a value a resource substituted went through
 * `encodeURIComponent`, which turns a literal `%` into `%25`, so no legitimate
 * value can arrive spelled `%2e`. `%2f` and `%5c` are not decoded here for the
 * opposite reason — the parser leaves them alone, and reading them would refuse
 * an encoded identifier that navigates nowhere.
 */
function navigates(value: string): boolean {
  return value.split("/").some((segment) => {
    const withoutParameters = segment.split(";")[0] ?? "";
    const dots = withoutParameters.replace(/%2e/gi, ".");
    return dots === "." || dots === "..";
  });
}

/**
 * Whether the string is an address rather than a path.
 *
 * `new URL(path, base)` gives priority to an absolute address, which is why
 * `joinUrl` compares origins — and origin does not carry userinfo, so
 * `https://bob:s3cret@api.test/v1/x` as an OpenAPI `paths` key passed the
 * comparison and was printed into `observations[].url` in full. A
 * scheme-relative `//api.test/v1/x` went a stranger way: `joinUrl` strips the
 * leading slashes, so it became `/v1/api.test/v1/x` — a request the endpoint
 * does not name, reported as if it were the one it does.
 *
 * The OpenAPI parser did not refuse this at all, and the endpoint list and the
 * Postman parser each refused it in their own way — three readings of one rule,
 * which is what ADR-0024 is against. The grammar answers for all four doors now;
 * the Postman copy was dead the moment it was written and is gone, and the one
 * in the endpoint list is still live and says why beside itself (ADR-0061).
 */
function isAddress(value: string): boolean {
  return value.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

/**
 * One rule of the address grammar: what refuses a path, and what to tell whoever
 * handed one over.
 *
 * Two entry points need different halves of the same list. `isAddressablePath`
 * answers "is this addressable" for the seam; `pathTemplate` answers "which rule
 * refused, and why, in a sentence an operator can act on" for the doors. Until
 * 23 August 2026 each carried its own copy — five predicates conjoined in one,
 * the same five spelled out again as four `if` blocks in the other — in the file
 * whose opening paragraph is about a duplicate the compiler cannot check.
 *
 * What that costs is not symmetry. A sixth rule added to `pathTemplate` alone
 * would never reach `joinUrl`, which is the seam ADR-0032 moved the grammar to
 * and the only thing standing between a consumer of the library and the wire; a
 * sixth added to `isAddressablePath` alone would refuse a document with no
 * sentence saying which line of it to fix.
 *
 * A table of pairs rather than a shared list of predicates, because the messages
 * are the most valuable text in this file: several were written from a specific
 * audit finding, and a generic "unusable path" in their place would cost more
 * than the duplication ever did.
 */
interface AddressRule {
  /**
   * A handle, for the gate that holds this table to a witness per rule.
   *
   * The table is not exported: `src/index.ts` does `export * from` on this
   * module, so a new export here is a new promise in the published surface.
   * `tests/invariants/written-once.test.ts` reads the ids out of the source
   * instead, the way the response-header allowlist is read out of `http.ts`.
   */
  readonly id: string;
  /** Whether this rule refuses the path. */
  readonly refuses: (path: string) => boolean;
  /**
   * Why, as the sentence that follows `The endpoint path "…"`.
   *
   * Handed the string as the document spelled it rather than the decoded one.
   * One rule's advice differs between a character that is in the file and an
   * escape the platform will turn into one, and sending an operator to look for
   * a backslash that is not there is the wrong half of the answer.
   */
  readonly because: (raw: string) => string;
}

/**
 * The grammar, in the order refusals are reported.
 *
 * Order is behaviour: `pathTemplate` throws for the first rule that refuses, so
 * moving an entry changes which sentence an operator gets for a path that breaks
 * two rules at once. It is not behaviour for `isAddressablePath`, which asks all
 * of them and only counts how many said no.
 *
 * Behaviour, and held as behaviour since 23 August 2026:
 * `tests/invariants/written-once.test.ts` carries a pair of paths per adjacent
 * pair of entries. Before that the order was declared here and nothing checked
 * it — every witness in the gate broke exactly one rule, which is what makes
 * "which rule fired" readable and also what made a permutation invisible.
 *
 * Written out rather than composed. The gate counts the entries it can name, and
 * a spread from another array is entries it cannot; a rule with no witness
 * demanded of it is the thing this table exists to prevent.
 */
const ADDRESS_RULES: readonly AddressRule[] = [
  {
    id: "query-or-fragment",
    refuses: (path) => path.includes("?") || path.includes("#"),
    because: () =>
      "carries a query string or a fragment, which would travel to the platform " +
      "verbatim — a method override smuggled that way performs a write the run " +
      "never asked for",
  },
  {
    id: "unaddressable-character",
    refuses: carriesNothingAddressable,
    because: (raw) =>
      carriesNothingAddressable(raw)
        ? "carries a backslash or a control character, which a URL parser reads as " +
          "a separator or removes outright — either way the address stops being " +
          "the one this template spells"
        : // The document has neither character in it, and an operator told it does
          // goes looking for the wrong thing. It has the escape, and the platform
          // is where that becomes a separator.
          "carries `%5c` or an encoded control character, which the platform decodes " +
          "into a path separator this tool would never have written",
  },
  {
    id: "address",
    refuses: isAddress,
    because: () =>
      "is an address rather than a path: an absolute or scheme-relative URL in a " +
      "document decides where the request goes, and the credentials, the scheme " +
      "and the port are the tool's to choose",
  },
  {
    id: "navigates",
    refuses: navigates,
    because: () =>
      "navigates with `.` or `..`, so the request would reach an endpoint other " +
      "than the one it names — past the exclusion list, which works on ids. " +
      "`%2e` and a `;` parameter after the dots are the same navigation in " +
      "another spelling, and the receiver collapses them",
  },
];

/**
 * Whether a path is one this tool can turn into an address, taken literally.
 *
 * The seam, as opposed to the door. `isUsablePathTemplate` below reads the
 * percent-encoded spellings too, because a template comes from a document and
 * the platform will decode it; this one is applied where the address is actually
 * built — `joinUrl` in the runner — and there the values a resource substituted
 * have already been through `encodeURIComponent`. Decoding at that point would
 * read an escaped value back as the character it stands for and refuse a
 * legitimate identifier.
 *
 * Two strictnesses of one grammar, in one file, per ADR-0024 — and, since
 * ADR-0061, over one list. Why the seam exists at all: `pathTemplate` is called
 * by three adapters, and the fourth door — a consumer of the library handing
 * `Endpoint.path` straight to `collectObservations` — had no grammar between it
 * and the wire.
 */
export function isAddressablePath(value: string): boolean {
  return ADDRESS_RULES.every((rule) => !rule.refuses(value));
}

/**
 * Whether a path template is one.
 *
 * Exported beside the constructor because the core reads it too: an endpoint is a
 * cell coordinate, and the same string reaches the matrix.
 */
export function isUsablePathTemplate(value: string): boolean {
  return isAddressablePath(decodePathish(value));
}

/**
 * @throws {UnusablePathTemplateError}
 */
export function pathTemplate(value: string): string {
  // The decoded string for every rule at once. One of the four hand-written
  // branches this replaced read `value` here for the first half-hour of its
  // life: `%2f%2fhost/x` threw nothing while `isUsablePathTemplate` — one
  // function above, over the same string — answered false. Two readings of one
  // rule is the defect this whole file exists against, and a single `find` over
  // a single table is the spelling in which it cannot be written again.
  const decoded = decodePathish(value);
  const broken = ADDRESS_RULES.find((rule) => rule.refuses(decoded));
  if (broken !== undefined) {
    throw new UnusablePathTemplateError(value, broken.because(value));
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

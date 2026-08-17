/**
 * A Postman collection (v2.1) as a source of endpoints.
 *
 * A third source, on equal terms with an OpenAPI specification and a manual
 * list. Needed because a great many teams have no specification, while the
 * collection is maintained by hand and turns out to be the only complete
 * description of the API. Unlike a spec, it is not generated from the code under
 * test, so it does not inherit the problem of ADR-0006: a collection is a
 * declared human intent too.
 *
 * The limits are the same as those of the neighbouring adapters, and for the
 * same reasons (ADR-0005):
 *
 * 1. The input is the **text of the document**, not a path. The adapter knows
 *    nothing about the file system or the network at all, so it cannot become a
 *    path traversal or SSRF primitive: a string that looks like a path is parsed
 *    as a scalar and rejected.
 * 2. The size of the input is bounded before parsing, YAML alias expansion
 *    during it.
 * 3. The depth of folder nesting is bounded: the collection is untrusted, and
 *    the walk over it is recursive. The limit also cuts off the cycles that YAML
 *    anchors can build (`&a [*a]`) — the walk only increases the depth, so a
 *    cycle runs into the limit rather than spinning forever.
 * 4. The host from the collection is discarded entirely. Where the requests go
 *    is decided by the run's base URL and the allowlist, not by the document
 *    under test; no host name is left in an endpoint's `path` by construction.
 *
 * **Unknown keys are ignored, unknown items are not.** This is a divergence from
 * `endpoint-list.ts`, and it is deliberate. A manual list is written by a human
 * for barbican, so an unknown key there means an unfulfilled intent of the
 * author. A collection, on the other hand, is written for another tool, and
 * almost everything in it (`event`, `auth`, `response`, `body`,
 * `protocolProfileBehavior`) has nothing to do with us by construction — a
 * closed format would reject every real export. But an `item` that could be read
 * neither as a folder nor as a request is an error, not a reason to skip it: a
 * silently skipped request becomes an unchecked endpoint in a report that reads
 * as "no violations".
 */

import { parse as parseYaml } from "yaml";
import type { Endpoint, HttpMethod } from "../core/types.js";
import { HTTP_METHODS } from "../core/types.js";
import { pathTemplate } from "../io/untrusted.js";
import type { SpecParser } from "./ports.js";

export interface PostmanCollectionLimits {
  /** The size limit of the input text in bytes. */
  readonly maxBytes: number;
  /**
   * The limit on YAML alias expansion.
   *
   * A defence against billion laughs: the `yaml` library counts expansions and
   * aborts parsing itself, before the document unfolds in memory. JSON knows no
   * aliases, but it is parsed by the same parser, so the limit is needed here
   * too.
   */
  readonly maxAliasCount: number;
  /** The limit on the depth of folder nesting. */
  readonly maxFolderDepth: number;
}

export const DEFAULT_POSTMAN_LIMITS: PostmanCollectionLimits = {
  // Collections store saved example responses and grow noticeably larger than a
  // manual list — the limit is taken to be the one for specifications.
  maxBytes: 5_000_000,
  maxAliasCount: 100,
  maxFolderDepth: 16,
};

export class PostmanCollectionTooLargeError extends Error {
  constructor(actualBytes: number, maxBytes: number) {
    super(`The collection is ${actualBytes} bytes, the limit is ${maxBytes}`);
    this.name = "PostmanCollectionTooLargeError";
  }
}

export class PostmanCollectionTooDeepError extends Error {
  constructor(maxFolderDepth: number) {
    super(`Collection folder nesting exceeds the limit of ${maxFolderDepth}`);
    this.name = "PostmanCollectionTooDeepError";
  }
}

export class PostmanCollectionParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Could not parse the Postman collection: ${message}`, options);
    this.name = "PostmanCollectionParseError";
  }
}

export class UnsupportedPostmanSchemaError extends Error {
  readonly schema: string;

  constructor(schema: string) {
    super(
      `Collection schema "${schema}" is not supported: a Collection v2.0 or v2.1 export ` +
        `is required. The v1 format describes requests differently, and reading it as v2 ` +
        `means reading it wrong.`,
    );
    this.name = "UnsupportedPostmanSchemaError";
    this.schema = schema;
  }
}

/**
 * A collection with no requests is an error, not a degenerate case.
 *
 * Zero endpoints give a report saying "no discrepancies" while nothing at all
 * was checked. Such a result is indistinguishable from a successful one and is
 * therefore more dangerous than a failure.
 */
export class EmptyPostmanCollectionError extends Error {
  constructor() {
    super(
      "The collection contains no requests. A run over an empty list produces a report " +
        "with no findings, which reads as 'nothing is broken' while nothing was tested.",
    );
    this.name = "EmptyPostmanCollectionError";
  }
}

/** The field of the item the check stumbled on. */
export type PostmanItemField = "item" | "name" | "request" | "method" | "url" | "path";

export class InvalidPostmanItemError extends Error {
  /** The path to the item in the folder tree — the future endpoint id as well. */
  readonly location: string;
  readonly field: PostmanItemField;

  constructor(location: string, field: PostmanItemField, reason: string) {
    super(`Collection item "${location}": ${reason}`);
    this.name = "InvalidPostmanItemError";
    this.location = location;
    this.field = field;
  }
}

export class DuplicatePostmanEndpointIdError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(
      `Request "${id}" appears in the collection twice. The access policy references ` +
        `endpoints by id, and a duplicate would make its interpretation ambiguous. ` +
        `Rename one of the requests or put them in different folders.`,
    );
    this.name = "DuplicatePostmanEndpointIdError";
    this.id = id;
  }
}

const METHOD_NAMES = Object.keys(HTTP_METHODS).join(", ");

/** The schemas the adapter undertakes to read. */
const SUPPORTED_SCHEMA = /\/collection\/v2\.[01]\./;

/** The name of a path parameter. The same character set as for names in OpenAPI. */
const PARAMETER_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * A path in which curly braces occur only as `{name}`.
 *
 * An unclosed or empty brace means the variable could not be read. Letting it
 * through would mean sending the core a parameter with a name the author never
 * wrote — and such a parameter will be covered by no declared resource.
 */
const TEMPLATE_ONLY = /^(?:[^{}]|\{[A-Za-z0-9_.-]+\})*$/;

/** A Postman variable inside a path. */
const POSTMAN_VARIABLE = /\{\{([^{}]*)\}\}/g;

/** Leading Postman variables: `{{baseUrl}}`, `{{host}}{{basePath}}`. */
const LEADING_VARIABLES = /^(?:\{\{[^{}]*\}\})+/;

/** `scheme://authority`, `://authority` and `//authority` in one expression. */
const ORIGIN_PREFIX = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*)?:?\/\//;

/**
 * The base for checking that a path stays within the target.
 *
 * The real base URL is unknown to the adapter and is not needed: what matters is
 * not where exactly the path leads, but whether it is able to choose a host at
 * all. Comparing the origin against any base answers that question.
 */
const PLACEHOLDER_BASE = "http://target.invalid/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The method is upper-cased: in the domain it is always `GET`, never `get`. */
function toMethod(value: string): HttpMethod | undefined {
  const upper = value.trim().toUpperCase();
  return Object.hasOwn(HTTP_METHODS, upper) ? (upper as HttpMethod) : undefined;
}

function locationOf(trail: readonly string[]): string {
  return trail.length === 0 ? "<collection root>" : trail.join("/");
}

/**
 * Brings a path segment to the core's notation for parameters.
 *
 * The Postman variable `{{playerId}}` is not the same thing as the OpenAPI
 * parameter `{playerId}`, but for barbican it is one and the same fact: the
 * segment's value is deferred and must come from outside. So both notations, and
 * with them Postman's native `:playerId`, are reduced to `{playerId}`.
 *
 * Leaving `{{playerId}}` as it is was not possible. The core extracts parameters
 * with the expression `/\{([^}]+)\}/`, and on `{{playerId}}` it yields a
 * parameter named `{playerId` — a name the author never wrote and which no
 * declared resource will cover. Such an endpoint would drop out of the run,
 * while substitution in `runner.substitute` would assemble a garbage path from
 * it. Reducing it to `{playerId}` leaves exactly two honest outcomes: a resource
 * with this parameter is declared — and the endpoint is checked; it is not
 * declared — and the endpoint lands in the skips with the reason
 * `path-parameters`, that is, visible to the operator rather than lost.
 *
 * The flip side of the decision: a `{{baseUrl}}` in the middle of a path will
 * also become a parameter. That is true in substance — there is nothing to check
 * in a segment with an unknown value — and it is visible in the report, unlike a
 * silent substitution.
 */
function toTemplateSegment(segment: string): string {
  // `:playerId` is Postman's native notation for a path parameter. A segment
  // that starts with a colon but does not look like a name stays a literal: a
  // colon by itself is allowed in a path.
  if (segment.startsWith(":") && PARAMETER_NAME.test(segment.slice(1))) {
    return `{${segment.slice(1)}}`;
  }
  return segment.replace(POSTMAN_VARIABLE, "{$1}");
}

/**
 * Checks that the path is unable to choose a host.
 *
 * The rule is the same as in the run (`runner.joinUrl`): joining with the base
 * must stay on its origin. The check here duplicates the check there on purpose
 * — a path like `/https://evil.test/x` formally starts with a slash and gets
 * past simpler conditions.
 */
function assertStaysWithinTarget(path: string, location: string): void {
  const base = new URL(PLACEHOLDER_BASE);
  let resolved: URL;
  try {
    resolved = new URL(path.replace(/^[/\\]+/, ""), base);
  } catch (cause) {
    throw new InvalidPostmanItemError(
      location,
      "path",
      `path ${JSON.stringify(path)} could not be parsed as a URL: ${describe(cause)}`,
    );
  }
  if (resolved.origin !== base.origin) {
    throw new InvalidPostmanItemError(
      location,
      "path",
      `path ${JSON.stringify(path)} addresses ${resolved.origin}, not a path on the host under test`,
    );
  }
}

/**
 * Brings the path to the form in which the core accepts it.
 *
 * The leading slash is not checked here: every source of a path guarantees it
 * itself — segments are joined with `/`, a string path is completed, and a path
 * without a slash is not released from `raw` at all. A check that nothing can
 * violate would only create the appearance of protection.
 */
function normalizePath(path: string, location: string): string {
  // The array form of `url.path` reaches here whole. `pathFromRaw` already cuts a
  // query off the string form; this is the other door into the same address.
  const converted = pathTemplate(path.split("/").map(toTemplateSegment).join("/"));

  // `//host/x` is a scheme-relative URL: it addresses another host rather than a
  // path on the one under test. The scope of the check is set by the allowlist
  // and must not be widened by the form in which a path is written.
  if (converted.startsWith("//")) {
    throw new InvalidPostmanItemError(
      location,
      "path",
      `path "${converted}" addresses another host (a scheme-relative URL)`,
    );
  }
  if (!TEMPLATE_ONLY.test(converted)) {
    throw new InvalidPostmanItemError(
      location,
      "path",
      `path "${converted}" contains an unclosed or empty brace; a Postman variable is ` +
        `written as {{name}}, a path parameter as {name}`,
    );
  }
  assertStaysWithinTarget(converted, location);

  return converted;
}

/**
 * Extracts the path from `request.url.raw`.
 *
 * The host, the scheme and the port are discarded rather than checked: the
 * target of the run is set by the configuration, and the document must take no
 * part in choosing the addressee. The query string and the fragment are
 * discarded as well — an endpoint here is a template without values, and query
 * parameters are declared by a human (`Resource.query`).
 */
function pathFromRaw(raw: string, location: string): string {
  const withoutQuery = raw.trim().replace(/[?#][\s\S]*$/, "");
  const withoutVariables = withoutQuery.replace(LEADING_VARIABLES, "");

  let rest = withoutVariables;
  const origin = ORIGIN_PREFIX.exec(rest);
  if (origin !== null) {
    const afterOrigin = rest.slice(origin[0].length);
    const slash = afterOrigin.indexOf("/");
    rest = slash === -1 ? "" : afterOrigin.slice(slash);
  }

  if (rest === "") {
    return "/";
  }
  if (!rest.startsWith("/")) {
    throw new InvalidPostmanItemError(
      location,
      "url",
      `could not extract a path from ${JSON.stringify(raw)}: a slash was expected after ` +
        `the base. Set "url.path" or start the path with a slash.`,
    );
  }
  return rest;
}

/**
 * Assembles the path from `request.url.path`.
 *
 * Returns `undefined` if the field is missing or empty — then the path is taken
 * from `raw`.
 */
function pathFromSegments(segments: unknown, location: string): string | undefined {
  if (typeof segments === "string") {
    const trimmed = segments.trim();
    if (trimmed === "") {
      return undefined;
    }
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== "string") {
      throw new InvalidPostmanItemError(
        location,
        "path",
        `path segment ${JSON.stringify(segment)} is not a string`,
      );
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

function pathOf(url: unknown, location: string): string {
  if (typeof url === "string") {
    if (url.trim() === "") {
      throw new InvalidPostmanItemError(location, "url", '"request.url" is empty');
    }
    return normalizePath(pathFromRaw(url, location), location);
  }
  if (!isRecord(url)) {
    throw new InvalidPostmanItemError(
      location,
      "url",
      '"request.url" is missing or is neither a string nor an object',
    );
  }

  const fromSegments = pathFromSegments(url.path, location);
  if (fromSegments !== undefined) {
    return normalizePath(fromSegments, location);
  }

  const raw = url.raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    return normalizePath(pathFromRaw(raw, location), location);
  }
  throw new InvalidPostmanItemError(
    location,
    "path",
    '"request.url" has neither a non-empty "path" nor a "raw"',
  );
}

function toEndpoint(request: unknown, trail: readonly string[]): Endpoint {
  const location = locationOf(trail);

  // The short form `"request": "https://..."` is allowed by the schema and reads
  // as GET by default. Guessing the method in a tool that performs nothing but
  // GET and HEAD without an explicit flag is too expensive: it silently decides
  // for the author what exactly is being checked.
  if (!isRecord(request)) {
    throw new InvalidPostmanItemError(
      location,
      "request",
      '"request" must be an object with method and url fields',
    );
  }

  const rawMethod = request.method;
  if (typeof rawMethod !== "string") {
    throw new InvalidPostmanItemError(
      location,
      "method",
      `"request.method" is required and must be a string; allowed: ${METHOD_NAMES}`,
    );
  }
  const method = toMethod(rawMethod);
  if (method === undefined) {
    throw new InvalidPostmanItemError(
      location,
      "method",
      `method "${rawMethod}" is not supported; allowed: ${METHOD_NAMES}`,
    );
  }

  return { id: location, method, path: pathOf(request.url, location) };
}

/**
 * Walks the tree of items depth-first, preserving the order of declaration.
 *
 * The endpoint identifier is the folder path plus the request name. The `name`
 * alone is not enough: requests with the same name in different folders are an
 * everyday thing in a collection, while for the access policy these are two
 * different endpoints. Appending a sequence number to repeats would be worse
 * than a refusal: the number depends on the order of the items, and a
 * rearrangement in the collection would silently redirect a policy line to a
 * different request.
 */
function collectItems(
  items: readonly unknown[],
  trail: readonly string[],
  depth: number,
  limits: PostmanCollectionLimits,
  out: Endpoint[],
): void {
  if (depth > limits.maxFolderDepth) {
    throw new PostmanCollectionTooDeepError(limits.maxFolderDepth);
  }

  for (const item of items) {
    if (!isRecord(item)) {
      throw new InvalidPostmanItemError(
        locationOf(trail),
        "item",
        `item ${JSON.stringify(item)} must be an object with a name field`,
      );
    }

    const name = item.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new InvalidPostmanItemError(
        locationOf(trail),
        "name",
        "the item has no non-empty name, and an endpoint identifier is built from names",
      );
    }
    const nested = [...trail, name.trim()];

    const children = item.item;
    const request = item.request;
    if (children !== undefined && request !== undefined) {
      throw new InvalidPostmanItemError(
        locationOf(nested),
        "item",
        'the item has both "item" and "request" — whether it is a folder or a request cannot be determined',
      );
    }

    if (children !== undefined) {
      if (!Array.isArray(children)) {
        throw new InvalidPostmanItemError(locationOf(nested), "item", '"item" must be a list');
      }
      collectItems(children, nested, depth + 1, limits, out);
      continue;
    }

    if (request === undefined) {
      throw new InvalidPostmanItemError(
        locationOf(nested),
        "request",
        'the item has neither "item" (a folder) nor "request" (a request)',
      );
    }

    out.push(toEndpoint(request, nested));
  }
}

function assertUniqueIds(endpoints: readonly Endpoint[]): void {
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.id)) {
      throw new DuplicatePostmanEndpointIdError(endpoint.id);
    }
    seen.add(endpoint.id);
  }
}

/**
 * Creates the parser of Postman collections.
 *
 * The limits can be tightened but not switched off: the default values are
 * conservative, not advisory.
 */
export function createPostmanCollectionParser(
  limits: Partial<PostmanCollectionLimits> = {},
): SpecParser {
  const effective: PostmanCollectionLimits = { ...DEFAULT_POSTMAN_LIMITS, ...limits };

  return {
    // The asynchrony is a requirement of the `SpecParser` port. Here it also
    // turns any refusal into a rejected promise rather than a synchronous
    // exception.
    async parse(source: string): Promise<readonly Endpoint[]> {
      const bytes = Buffer.byteLength(source, "utf8");
      if (bytes > effective.maxBytes) {
        throw new PostmanCollectionTooLargeError(bytes, effective.maxBytes);
      }

      let document: unknown;
      try {
        // Collections are exported as JSON, and JSON is a subset of YAML 1.2, so
        // a separate parser is not needed, and `maxAliasCount` comes for free.
        document = parseYaml(source, { maxAliasCount: effective.maxAliasCount });
      } catch (cause) {
        throw new PostmanCollectionParseError(describe(cause), { cause });
      }

      if (!isRecord(document)) {
        throw new PostmanCollectionParseError('the document is not an object with an "item" key');
      }

      const info = document.info;
      if (
        isRecord(info) &&
        typeof info.schema === "string" &&
        !SUPPORTED_SCHEMA.test(info.schema)
      ) {
        throw new UnsupportedPostmanSchemaError(info.schema);
      }

      const items = document.item;
      if (!Array.isArray(items)) {
        throw new PostmanCollectionParseError('the "item" key is missing or is not a list');
      }

      const endpoints: Endpoint[] = [];
      collectItems(items, [], 0, effective, endpoints);
      if (endpoints.length === 0) {
        throw new EmptyPostmanCollectionError();
      }
      assertUniqueIds(endpoints);

      return endpoints;
    },
  };
}

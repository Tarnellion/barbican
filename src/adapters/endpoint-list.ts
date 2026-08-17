/**
 * A manual list of endpoints as a source for the check.
 *
 * Needed because far from every API has an OpenAPI specification, while access
 * has to be checked there too. The list is written by a human — that is a
 * declared intent, exactly like the access policy (ADR-0006), and not knowledge
 * derived from the implementation of the system under test.
 *
 * The limits are the same as those of the specification parser, and for the same
 * reasons (ADR-0005):
 *
 * 1. The input is the **text of the document**, not a path. The adapter knows
 *    nothing about the file system at all, so it cannot become a path traversal
 *    primitive: a string that looks like a path is parsed as a YAML scalar and
 *    rejected.
 * 2. YAML alias expansion is bounded: a document of a couple of kilobytes
 *    expands into gigabytes if it is not.
 * 3. The size of the input is bounded before parsing.
 *
 * The format is closed: unknown fields are rejected rather than ignored. A
 * silently dropped field is an unfulfilled intent of the list's author, and they
 * would learn about it only from the final report, where the check looks as if
 * it took place.
 *
 * The input format:
 *
 * ```yaml
 * endpoints:
 *   - { id: users.list, method: GET, path: /v1/users }
 *   - id: profile.read
 *     method: GET
 *     path: /v1/players/{playerId}
 * ```
 *
 * About curly braces: in flow style (`{ ... }`) a template path has to be
 * quoted — `path: "/v1/players/{playerId}"` — otherwise `{` opens a nested
 * mapping and the document will not parse. In block style, as above, quotes are
 * not needed. This is a property of YAML rather than of our check, but template
 * paths are the norm here, so it is stated explicitly.
 */

import { parse as parseYaml } from "yaml";
import type { Endpoint, HttpMethod } from "../core/types.js";
import { HTTP_METHODS } from "../core/types.js";
import type { SpecParser } from "./ports.js";

export interface EndpointListLimits {
  /** The size limit of the input text in bytes. */
  readonly maxBytes: number;
  /**
   * The limit on YAML alias expansion.
   *
   * A defence against billion laughs: the `yaml` library counts expansions and
   * aborts parsing itself, before the document unfolds in memory.
   */
  readonly maxAliasCount: number;
}

export const DEFAULT_ENDPOINT_LIST_LIMITS: EndpointListLimits = {
  maxBytes: 1_000_000,
  maxAliasCount: 100,
};

export class EndpointListTooLargeError extends Error {
  constructor(actualBytes: number, maxBytes: number) {
    super(`The endpoint list is ${actualBytes} bytes, the limit is ${maxBytes}`);
    this.name = "EndpointListTooLargeError";
  }
}

export class EndpointListParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Could not parse the endpoint list: ${message}`, options);
    this.name = "EndpointListParseError";
  }
}

/**
 * An empty list is an error, not a degenerate case.
 *
 * Zero endpoints give a report saying "no discrepancies" while nothing at all
 * was checked. Such a result is indistinguishable from a successful one and is
 * therefore more dangerous than a failure.
 */
export class EmptyEndpointListError extends Error {
  constructor() {
    super(
      "The endpoint list is empty. A run over an empty list produces a report with no " +
        "findings, which reads as 'nothing is broken' while nothing was tested at all.",
    );
    this.name = "EmptyEndpointListError";
  }
}

/** The field of the entry the check stumbled on. `entry` is the entry itself. */
export type EndpointField = "entry" | "id" | "method" | "path";

export class InvalidEndpointError extends Error {
  readonly index: number;
  readonly field: EndpointField;

  constructor(index: number, field: EndpointField, reason: string) {
    super(`Endpoint #${index}: ${reason}`);
    this.name = "InvalidEndpointError";
    this.index = index;
    this.field = field;
  }
}

export class DuplicateEndpointIdError extends Error {
  readonly id: string;

  constructor(id: string, firstIndex: number, secondIndex: number) {
    super(
      `Identifier "${id}" is declared twice: endpoints #${firstIndex} and #${secondIndex}. ` +
        `The access policy references endpoints by id, and a duplicate would make its ` +
        `interpretation ambiguous.`,
    );
    this.name = "DuplicateEndpointIdError";
    this.id = id;
  }
}

const METHOD_NAMES = Object.keys(HTTP_METHODS).join(", ");

/** The fields of a list entry. Everything else is rejected — see the module comment. */
const ENDPOINT_FIELDS: ReadonlySet<string> = new Set(["id", "method", "path"]);

/** The fields of the document. A closed set as well, for the same reason. */
const DOCUMENT_FIELDS: ReadonlySet<string> = new Set(["endpoints"]);

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

function toEndpoint(entry: unknown, index: number): Endpoint {
  if (!isRecord(entry)) {
    throw new InvalidEndpointError(
      index,
      "entry",
      `a list item must be an object with fields ${[...ENDPOINT_FIELDS].join(", ")}`,
    );
  }

  for (const key of Object.keys(entry)) {
    if (!ENDPOINT_FIELDS.has(key)) {
      throw new InvalidEndpointError(
        index,
        "entry",
        `unknown field "${key}"; only ${[...ENDPOINT_FIELDS].join(", ")} are allowed`,
      );
    }
  }

  const id = entry.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new InvalidEndpointError(index, "id", "id is required and must be a non-empty string");
  }

  const rawMethod = entry.method;
  if (typeof rawMethod !== "string") {
    throw new InvalidEndpointError(
      index,
      "method",
      `method is required and must be a string; allowed: ${METHOD_NAMES}`,
    );
  }
  const method = toMethod(rawMethod);
  if (method === undefined) {
    throw new InvalidEndpointError(
      index,
      "method",
      `method "${rawMethod}" is not supported; allowed: ${METHOD_NAMES}`,
    );
  }

  const path = entry.path;
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new InvalidEndpointError(
      index,
      "path",
      `path must be a string starting with a slash; got ${JSON.stringify(path)}`,
    );
  }
  // `//host/x` is a scheme-relative URL: it addresses another host rather than a
  // path on the one under test. The scope of the check is set by the allowlist
  // and must not be widened by the form in which a path is written.
  if (path.startsWith("//")) {
    throw new InvalidEndpointError(
      index,
      "path",
      `path "${path}" addresses another host (a scheme-relative URL), not a path on the target`,
    );
  }

  return { id, method, path };
}

function toEndpoints(document: unknown): readonly Endpoint[] {
  if (!isRecord(document)) {
    throw new EndpointListParseError('the document is not an object with an "endpoints" key');
  }

  for (const key of Object.keys(document)) {
    if (!DOCUMENT_FIELDS.has(key)) {
      throw new EndpointListParseError(`unknown document key "${key}"`);
    }
  }

  const list = document.endpoints;
  if (!Array.isArray(list)) {
    throw new EndpointListParseError('the "endpoints" key is missing or is not a list');
  }
  if (list.length === 0) {
    throw new EmptyEndpointListError();
  }

  const endpoints: Endpoint[] = [];
  const firstSeenAt = new Map<string, number>();

  for (const [index, entry] of list.entries()) {
    const endpoint = toEndpoint(entry, index);

    const firstIndex = firstSeenAt.get(endpoint.id);
    if (firstIndex !== undefined) {
      throw new DuplicateEndpointIdError(endpoint.id, firstIndex, index);
    }
    firstSeenAt.set(endpoint.id, index);

    endpoints.push(endpoint);
  }

  return endpoints;
}

/**
 * Creates the parser of a manual endpoint list.
 *
 * The limits can be tightened but not switched off: the default values are
 * conservative, not advisory.
 */
export function createEndpointListParser(limits: Partial<EndpointListLimits> = {}): SpecParser {
  const effective: EndpointListLimits = { ...DEFAULT_ENDPOINT_LIST_LIMITS, ...limits };

  return {
    // The asynchrony is a requirement of the `SpecParser` port. Here it also
    // turns any refusal into a rejected promise rather than a synchronous
    // exception.
    async parse(source: string): Promise<readonly Endpoint[]> {
      const bytes = Buffer.byteLength(source, "utf8");
      if (bytes > effective.maxBytes) {
        throw new EndpointListTooLargeError(bytes, effective.maxBytes);
      }

      let document: unknown;
      try {
        // JSON is a subset of YAML 1.2, so one parser covers both formats.
        document = parseYaml(source, { maxAliasCount: effective.maxAliasCount });
      } catch (cause) {
        throw new EndpointListParseError(describe(cause), { cause });
      }

      return toEndpoints(document);
    },
  };
}

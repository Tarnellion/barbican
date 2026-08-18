/**
 * Parsing an OpenAPI specification into a list of endpoints.
 *
 * Three barriers against an untrusted document. They close different problems —
 * that is verified by experiment, not deduced from general reasoning:
 *
 * 1. The parser knows no paths. It is given text rather than a path to a file,
 *    and the adapter itself opens nothing in the file system.
 *
 *    This is worth less than it reads. It used to say that a relative `$ref`
 *    "has nothing to count from", and that is not so: measured on 18 August 2026
 *    against swagger-parser 12.1.0, a document handed over as an object still
 *    resolves `./package.json` and `package.json` — the base is the process's
 *    working directory, not the document's location. An absolute path and a
 *    `file://` URL need no base at all, and with `resolve.external` on both are
 *    read and their contents land in the returned document. So barrier 1 keeps
 *    this adapter from naming a directory; it does not keep the library from
 *    reading a file.
 * 2. External `$ref`s are rejected with an explicit error before the document
 *    reaches swagger-parser. This is a defence not against SSRF but against
 *    **silent degradation**: with barrier 2 switched off, swagger-parser returns
 *    a result without an error, leaving the reference unresolved. The tool would
 *    carry on with an incomplete list of endpoints and report "no discrepancies"
 *    where the check never happened.
 * 3. `resolve.external = false` — the defence against SSRF proper. Over http it
 *    is **not currently the thing that provides it**; over the file system it is
 *    one of the two things that do, and the header said otherwise until 18 August
 *    2026. That sentence used to read
 *    "verified separately: with barrier 2 removed, a request to the address from
 *    the `$ref` still does not go out", which is true and proves nothing: no
 *    request goes out with the option **on** either. Measured on 17 August 2026
 *    over six configurations — the document as an object, as a file path, and as
 *    an object with a base path, each with the option both ways — and
 *    swagger-parser 12.1.0 never fetches an http `$ref` at all. With the option
 *    off the reference is left in place in silence, which is precisely the
 *    silent degradation barrier 2 exists to catch; with it on the call throws
 *    "Unable to resolve $ref pointer". Neither opens a socket, so over http
 *    nothing here is holding anything: the library has no working resolver, and
 *    the tripwire in the tests is there for the version that gains one.
 *
 *    The file system is the other way round, and the header claimed otherwise
 *    until 18 August 2026 — it credited barrier 1 with both halves, from a
 *    measurement that had covered http only. The library does read files, needs
 *    no base to read one named absolutely, and takes the working directory as
 *    the base for one named relatively.
 *
 *    What stops it is barriers 2 and 3, each on its own. Measured by taking them
 *    away one at a time, against a canary file in a temporary directory: with the
 *    rejection removed and `external: false` kept, the reference is left in place
 *    and nothing is read; with the rejection in place and `external: true`, it is
 *    refused before swagger-parser is called. So over the file system this option
 *    is not the dormant guard the http half makes it look like — it is one of the
 *    two things holding, which is why the test that asserts it is still passed
 *    says what it says.
 *
 *    The option stays, because a version that does resolve is exactly what it is
 *    for, and `tests/adapters/openapi.test.ts` carries a tripwire that fails on
 *    the day one arrives.
 *
 * The reasoning — ADR-0005. The tests that prove this are mandatory and must not
 * be skipped.
 */

import SwaggerParser from "@apidevtools/swagger-parser";
import { parse as parseYaml } from "yaml";
import type { Endpoint } from "../core/types.js";
import { HTTP_METHODS } from "../core/types.js";
import { pathTemplate } from "../io/untrusted.js";
import type { SpecParser } from "./ports.js";

export interface SpecParserLimits {
  /** The size limit of the input text in bytes. */
  readonly maxBytes: number;
  /**
   * The limit on YAML alias expansion.
   *
   * A defence against billion laughs: a document of a few kilobytes can expand
   * into gigabytes. The `yaml` library counts expansions and throws by itself.
   */
  readonly maxAliasCount: number;
  /** The limit on the document's nesting depth. */
  readonly maxDepth: number;
}

export const DEFAULT_SPEC_LIMITS: SpecParserLimits = {
  maxBytes: 5_000_000,
  maxAliasCount: 100,
  maxDepth: 64,
};

export class SpecTooLargeError extends Error {
  constructor(actualBytes: number, maxBytes: number) {
    super(`The specification document is ${actualBytes} bytes, the limit is ${maxBytes}`);
    this.name = "SpecTooLargeError";
  }
}

export class SpecTooDeepError extends Error {
  constructor(maxDepth: number) {
    super(`Document nesting exceeds the limit of ${maxDepth}`);
    this.name = "SpecTooDeepError";
  }
}

export class ExternalRefError extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super(
      `External reference "${ref}" is not resolved: this guards against SSRF and path ` +
        `traversal. Flatten the specification into a single file before testing.`,
    );
    this.name = "ExternalRefError";
    this.ref = ref;
  }
}

export class SpecParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Could not parse the specification: ${message}`, options);
    this.name = "SpecParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Checks the shape of the document: the depth and the absence of external `$ref`s.
 *
 * Nodes already walked once are not walked again: YAML aliases produce shared
 * subtrees, and a naive walk over them would itself become a source of
 * exponential blowup. Alias expansion is already bounded by `maxAliasCount`.
 */
export class UnsupportedYamlTagError extends Error {
  constructor(tag: string) {
    super(
      `The specification contains a node tagged ${tag}. OpenAPI cannot contain such ` +
        `a node: it is a JSON-compatible structure. Parsing stopped because such ` +
        `a node is invisible to the walk — an external reference under it would ` +
        `slip past the check, and a path list under it would yield zero endpoints ` +
        `without a single error, that is, a hundred percent coverage of nothing.`,
    );
    this.name = "UnsupportedYamlTagError";
  }
}

function assertSafeShape(root: unknown, limits: SpecParserLimits): void {
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > limits.maxDepth) {
      throw new SpecTooDeepError(limits.maxDepth);
    }
    if (!isRecord(node) || seen.has(node)) {
      return;
    }
    seen.add(node);

    // Nodes that do not occur in OpenAPI and that the walk does not see: the
    // YAML tags `!!omap`, `!!set`, `!!pairs` produce a Map and a Set, and
    // `Object.values` does not go over them. Found by adversarial review, and
    // the finding is a double one: an external `$ref` under such a tag drove
    // past the barrier, and `paths` under it gave **zero endpoints without a
    // single error** — coverage 1/1, that is, 100% of nothing. Psych emits such
    // documents as a matter of course.
    //
    // Rejected rather than walked deeper: OpenAPI is a JSON-compatible
    // structure, and an ordered map in it means either an export bug or an
    // attempt to hide a node from parsing. Both cases are a reason to stop.
    if (node instanceof Map || node instanceof Set) {
      throw new UnsupportedYamlTagError(node instanceof Map ? "!!omap" : "!!set");
    }

    const ref = node.$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) {
      throw new ExternalRefError(ref);
    }

    for (const value of Object.values(node)) {
      walk(value, depth + 1);
    }
  };

  walk(root, 0);
}

function toEndpoints(document: unknown): readonly Endpoint[] {
  if (!isRecord(document)) {
    throw new SpecParseError("the document is not an object");
  }

  const paths = document.paths;
  if (!isRecord(paths)) {
    return [];
  }

  const endpoints: Endpoint[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    // A specification is an untrusted document — ADR-0005, second addendum — and
    // this key travels into the request address unchanged. `?_method=DELETE`
    // written here issued a GET on the wire that a great many frameworks execute
    // as a DELETE, with `--unsafe-methods` absent and exit 0. The grammar is in
    // `pathTemplate`; refused rather than trimmed, because a specification whose
    // paths carry a query is not one this tool can reason about.
    pathTemplate(path);
    // The set comes from the core rather than being spelled out again here. A
    // list of its own read `HttpMethod` nowhere, so a method added to the domain
    // would have been skipped by this loop without a word: every operation of
    // that method absent from the matrix, and coverage reporting a hundred
    // percent — of what was parsed.
    for (const method of Object.values(HTTP_METHODS)) {
      // A path item names its operations in lower case; the domain in upper.
      const operation = item[method.toLowerCase()];
      if (!isRecord(operation)) {
        continue;
      }

      const rawId = operation.operationId;
      const operationId = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;

      endpoints.push(
        operationId === undefined
          ? { id: `${method} ${path}`, method, path }
          : { id: operationId, method, path, operationId },
      );
    }
  }
  return endpoints;
}

/**
 * Creates the specification parser.
 *
 * The limits can be tightened but not switched off: the default values are
 * conservative, not advisory.
 */
export function createOpenApiParser(limits: Partial<SpecParserLimits> = {}): SpecParser {
  const effective: SpecParserLimits = { ...DEFAULT_SPEC_LIMITS, ...limits };

  return {
    async parse(source: string): Promise<readonly Endpoint[]> {
      const bytes = Buffer.byteLength(source, "utf8");
      if (bytes > effective.maxBytes) {
        throw new SpecTooLargeError(bytes, effective.maxBytes);
      }

      let document: unknown;
      try {
        // JSON is a subset of YAML 1.2, so one parser covers both formats.
        document = parseYaml(source, { maxAliasCount: effective.maxAliasCount });
      } catch (cause) {
        throw new SpecParseError(describe(cause), { cause });
      }

      assertSafeShape(document, effective);

      let dereferenced: unknown;
      try {
        dereferenced = await SwaggerParser.dereference(
          document as Parameters<typeof SwaggerParser.dereference>[0],
          { resolve: { external: false } },
        );
      } catch (cause) {
        // ExternalRefError cannot get here: assertSafeShape ran above.
        throw new SpecParseError(describe(cause), { cause });
      }

      return toEndpoints(dereferenced);
    },
  };
}

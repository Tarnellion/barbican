/**
 * Tests for parsing a manual endpoint list.
 *
 * These check behaviour: which endpoints came out and what exactly was
 * rejected, not that "the function was called". They also prove the parser
 * does not touch the file system: a path to an existing file is plain text to
 * it, and the file's content never reaches the result.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEndpointListParser,
  DuplicateEndpointIdError,
  EmptyEndpointListError,
  EndpointListParseError,
  EndpointListTooLargeError,
  InvalidEndpointError,
} from "../../src/adapters/endpoint-list.js";

const parser = createEndpointListParser();

const MINIMAL_LIST = `
endpoints:
  - { id: users.list, method: GET, path: /v1/users }
  - { id: tickets.list, method: GET, path: /v1/support/tickets }
  - { id: profile.read, method: GET, path: "/v1/players/{playerId}" }
`;

describe("parsing a valid list", () => {
  it("extracts endpoints in declaration order", async () => {
    const endpoints = await parser.parse(MINIMAL_LIST);

    expect(endpoints).toEqual([
      { id: "users.list", method: "GET", path: "/v1/users" },
      { id: "tickets.list", method: "GET", path: "/v1/support/tickets" },
      { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
    ]);
  });

  // Templated paths are the norm for this tool, and a brace opens a flow
  // mapping in YAML. In block style it is safe, in flow style it has to be
  // quoted; the test pins both forms so the difference does not surface on
  // someone else's list.
  it("accepts a templated path in block style without quotes", async () => {
    const list = `
endpoints:
  - id: profile.read
    method: GET
    path: /v1/players/{playerId}
`;

    await expect(parser.parse(list)).resolves.toEqual([
      { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
    ]);
  });

  it("accepts JSON: it is a subset of YAML", async () => {
    const json = JSON.stringify({
      endpoints: [{ id: "ping", method: "GET", path: "/ping" }],
    });

    await expect(parser.parse(json)).resolves.toEqual([
      { id: "ping", method: "GET", path: "/ping" },
    ]);
  });

  it("accepts every method of the domain and upper-cases it", async () => {
    const list = `
endpoints:
  - { id: a, method: get, path: /a }
  - { id: b, method: Head, path: /b }
  - { id: c, method: post, path: /c }
  - { id: d, method: put, path: /d }
  - { id: e, method: patch, path: /e }
  - { id: f, method: delete, path: /f }
  - { id: g, method: options, path: /g }
`;

    const endpoints = await parser.parse(list);

    expect(endpoints.map((endpoint) => endpoint.method)).toEqual([
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ]);
  });

  it("adds no operationId: a manual list has none", async () => {
    const [endpoint] = await parser.parse("endpoints: [{ id: a, method: GET, path: /a }]");

    expect(endpoint).toBeDefined();
    expect(Object.keys(endpoint ?? {})).toEqual(["id", "method", "path"]);
  });

  it("expands aliases: validation runs over the expanded document", async () => {
    const list = `
endpoints:
  - &first { id: a, method: GET, path: /a }
  - *first
`;

    // The alias is expanded, so the id repeats — and the uniqueness check
    // catches it just as it catches a repeat typed by hand.
    await expect(parser.parse(list)).rejects.toThrow(DuplicateEndpointIdError);
  });
});

describe("a document of the wrong shape", () => {
  it("rejects empty input", async () => {
    await expect(parser.parse("")).rejects.toThrow(EndpointListParseError);
  });

  it("rejects a scalar instead of a document", async () => {
    await expect(parser.parse("just a string")).rejects.toThrow(EndpointListParseError);
  });

  it("rejects a list without the endpoints wrapper", async () => {
    await expect(parser.parse("- { id: a, method: GET, path: /a }")).rejects.toThrow(
      EndpointListParseError,
    );
  });

  it("rejects a document without an endpoints key", async () => {
    await expect(parser.parse("endpoints: null")).rejects.toThrow(
      /"endpoints" key is missing or is not a list/,
    );
  });

  it("rejects endpoints that is not a list", async () => {
    await expect(parser.parse("endpoints: { id: a }")).rejects.toThrow(EndpointListParseError);
  });

  // An unknown key is an intention of the author that will not be carried out:
  // they counted on behaviour that will not happen, and staying silent about
  // that is worse than refusing.
  it("rejects an unknown document key instead of ignoring it", async () => {
    const list = `
version: 2
endpoints:
  - { id: a, method: GET, path: /a }
`;

    await expect(parser.parse(list)).rejects.toThrow(/unknown document key "version"/);
  });

  it("rejects unparseable YAML", async () => {
    await expect(parser.parse("endpoints: [{ this: is unclosed")).rejects.toThrow(
      EndpointListParseError,
    );
  });

  it("rejects an empty list with an error of its own", async () => {
    await expect(parser.parse("endpoints: []")).rejects.toThrow(EmptyEndpointListError);
  });
});

describe("a list entry fails validation", () => {
  it("rejects an entry that is not an object", async () => {
    await expect(parser.parse("endpoints: [ /v1/users ]")).rejects.toMatchObject({
      name: "InvalidEndpointError",
      index: 0,
      field: "entry",
    });
  });

  it("rejects a nested list instead of an object", async () => {
    await expect(parser.parse("endpoints: [ [GET, /a] ]")).rejects.toThrow(InvalidEndpointError);
  });

  it("rejects an unknown field on an entry", async () => {
    const list = "endpoints: [{ id: a, method: GET, path: /a, tenant: acme }]";

    await expect(parser.parse(list)).rejects.toThrow(/unknown field "tenant"/);
  });

  // $ref is not supported here at all: nothing to resolve and nowhere to go.
  it("knows nothing of $ref and rejects it as an unknown field", async () => {
    const list = 'endpoints: [{ $ref: "http://127.0.0.1:1/evil.yaml" }]';

    await expect(parser.parse(list)).rejects.toThrow(/unknown field "\$ref"/);
  });

  it("rejects a missing id", async () => {
    await expect(parser.parse("endpoints: [{ method: GET, path: /a }]")).rejects.toMatchObject({
      index: 0,
      field: "id",
    });
  });

  it("rejects an empty and a blank id", async () => {
    await expect(parser.parse('endpoints: [{ id: "", method: GET, path: /a }]')).rejects.toThrow(
      InvalidEndpointError,
    );
    await expect(parser.parse('endpoints: [{ id: "  ", method: GET, path: /a }]')).rejects.toThrow(
      InvalidEndpointError,
    );
  });

  it("rejects an id that is not a string", async () => {
    await expect(parser.parse("endpoints: [{ id: 42, method: GET, path: /a }]")).rejects.toThrow(
      InvalidEndpointError,
    );
  });

  it("rejects a method outside the HttpMethod set", async () => {
    await expect(parser.parse("endpoints: [{ id: a, method: TRACE, path: /a }]")).rejects.toThrow(
      /method "TRACE" is not supported/,
    );
    await expect(parser.parse("endpoints: [{ id: a, method: CONNECT, path: /a }]")).rejects.toThrow(
      InvalidEndpointError,
    );
  });

  it("rejects a method that is not a string", async () => {
    await expect(
      parser.parse("endpoints: [{ id: a, method: 200, path: /a }]"),
    ).rejects.toMatchObject({ index: 0, field: "method" });
  });

  it("rejects a path without a leading slash", async () => {
    await expect(
      parser.parse("endpoints: [{ id: a, method: GET, path: v1/users }]"),
    ).rejects.toThrow(/must be a string starting with a slash/);
  });

  it("rejects an absolute URL instead of a path", async () => {
    const list = 'endpoints: [{ id: a, method: GET, path: "https://example.test/v1/users" }]';

    await expect(parser.parse(list)).rejects.toMatchObject({ index: 0, field: "path" });
  });

  // Joined with the base, `//host/x` would address someone else's host instead
  // of a path on the target: the scope must not widen through a notation.
  it("rejects a scheme-relative URL", async () => {
    const list = 'endpoints: [{ id: a, method: GET, path: "//evil.test/v1/users" }]';

    await expect(parser.parse(list)).rejects.toThrow(/addresses another host/);
  });

  it("rejects a missing path", async () => {
    await expect(parser.parse("endpoints: [{ id: a, method: GET }]")).rejects.toMatchObject({
      index: 0,
      field: "path",
    });
  });

  it("points at the index of the failing entry, not only at the error", async () => {
    const list = `
endpoints:
  - { id: a, method: GET, path: /a }
  - { id: b, method: GET, path: /b }
  - { id: c, method: WAT, path: /c }
`;

    await expect(parser.parse(list)).rejects.toMatchObject({ index: 2, field: "method" });
  });
});

describe("identifier uniqueness", () => {
  it("rejects a duplicate id and names both positions", async () => {
    const list = `
endpoints:
  - { id: users.list, method: GET, path: /v1/users }
  - { id: other, method: GET, path: /v1/other }
  - { id: users.list, method: HEAD, path: /v1/users }
`;

    const attempt = parser.parse(list);

    await expect(attempt).rejects.toThrow(DuplicateEndpointIdError);
    await expect(attempt).rejects.toMatchObject({ id: "users.list" });
    await expect(attempt).rejects.toThrow(/#0 and #2/);
  });

  it("tells ids apart by case: these are different endpoints", async () => {
    const list = `
endpoints:
  - { id: users.list, method: GET, path: /v1/users }
  - { id: Users.List, method: GET, path: /v1/Users }
`;

    await expect(parser.parse(list)).resolves.toHaveLength(2);
  });

  it("allows one path under different methods", async () => {
    const list = `
endpoints:
  - { id: users.list, method: GET, path: /v1/users }
  - { id: users.head, method: HEAD, path: /v1/users }
`;

    await expect(parser.parse(list)).resolves.toHaveLength(2);
  });
});

describe("limits on the input", () => {
  it("rejects a YAML bomb before it expands", async () => {
    const bomb = `
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
endpoints: [*d,*d,*d,*d,*d,*d,*d,*d,*d]
`;

    await expect(parser.parse(bomb)).rejects.toThrow(EndpointListParseError);
  });

  it("counts aliases against its own limit, not someone else's", async () => {
    const strict = createEndpointListParser({ maxAliasCount: 1 });
    const list = `
endpoints:
  - &first { id: a, method: GET, path: /a }
  - *first
  - *first
`;

    await expect(strict.parse(list)).rejects.toThrow(EndpointListParseError);
  });

  it("rejects a document over the limit and names the actual size", async () => {
    const small = createEndpointListParser({ maxBytes: 32 });

    const attempt = small.parse(MINIMAL_LIST);

    await expect(attempt).rejects.toThrow(EndpointListTooLargeError);
    await expect(attempt).rejects.toThrow(
      new RegExp(`${Buffer.byteLength(MINIMAL_LIST, "utf8")} bytes, the limit is 32`),
    );
  });

  it("measures the size in bytes, not in characters", async () => {
    // Characters outside ASCII take two bytes in UTF-8: a limit set in bytes
    // cannot be checked against the string length.
    const parserWithLimit = createEndpointListParser({ maxBytes: 20 });
    // A character outside ASCII: two bytes in UTF-8, one in length.
    const source = "é".repeat(11);

    await expect(parserWithLimit.parse(source)).rejects.toThrow(EndpointListTooLargeError);
  });

  it("lets through a document exactly at the limit", async () => {
    const source = "endpoints: [{ id: a, method: GET, path: /a }]";
    const exact = createEndpointListParser({ maxBytes: Buffer.byteLength(source, "utf8") });

    await expect(exact.parse(source)).resolves.toHaveLength(1);
  });
});

describe("the parser does not touch the file system", () => {
  let directory = "";
  let listPath = "";
  const CANARY = "canary-3d7be-must-not-leak";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "barbican-endpoints-"));
    listPath = join(directory, "endpoints.yaml");
    await writeFile(listPath, `endpoints:\n  - { id: ${CANARY}, method: GET, path: /a }\n`, "utf8");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // The input is the text of the document, not a path. A parser that could
  // open files would be a path traversal primitive.
  it("does not read a file whose path is passed as the source", async () => {
    const attempt = parser.parse(listPath);

    await expect(attempt).rejects.toThrow(EndpointListParseError);
    await expect(
      attempt.catch((error: unknown) => JSON.stringify(error) + String(error)),
    ).resolves.not.toContain(CANARY);
  });

  it("does not read a file whose path ended up in the path field", async () => {
    const list = `endpoints: [{ id: a, method: GET, path: "${listPath}" }]`;

    // The path stays a path: the file's content is not mixed into the result.
    await expect(parser.parse(list)).resolves.toEqual([{ id: "a", method: "GET", path: listPath }]);
  });
});

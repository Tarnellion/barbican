/**
 * Postman collection parsing tests.
 *
 * These check behaviour: which endpoints came out, what path each has and what
 * exactly was rejected — not that "the function was called". They also prove
 * the adapter touches neither the file system nor the network: a path to an
 * existing file is plain text to it, and an http server raised for the test
 * receives no request at all, even though its address sits in the collection.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPostmanCollectionParser,
  DEFAULT_POSTMAN_LIMITS,
  DuplicatePostmanEndpointIdError,
  EmptyPostmanCollectionError,
  InvalidPostmanItemError,
  PostmanCollectionParseError,
  PostmanCollectionTooDeepError,
  PostmanCollectionTooLargeError,
  UnsupportedPostmanSchemaError,
} from "../../src/adapters/postman.js";
import { pathParameterNames } from "../../src/core/path-parameters.js";

const parser = createPostmanCollectionParser();

const V21_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/** A request in the shape Postman exports it in. */
function request(method: string, segments: readonly string[], raw?: string) {
  return {
    method,
    url: {
      raw: raw ?? `{{baseUrl}}/${segments.join("/")}`,
      host: ["{{baseUrl}}"],
      path: [...segments],
    },
  };
}

const COLLECTION = JSON.stringify({
  info: { name: "Platform", schema: V21_SCHEMA },
  item: [
    { name: "Health", request: request("GET", ["healthz"]) },
    {
      name: "Players",
      item: [
        { name: "List", request: request("GET", ["v1", "players"]) },
        { name: "Card", request: request("GET", ["v1", "players", "{{playerId}}"]) },
        {
          name: "Wallet",
          item: [
            { name: "Balance", request: request("GET", ["v1", "players", ":playerId", "wallet"]) },
          ],
        },
      ],
    },
    {
      name: "Admin",
      item: [{ name: "List", request: request("DELETE", ["v1", "admin", "users"]) }],
    },
  ],
});

describe("parsing a valid collection", () => {
  it("walks folders depth-first and keeps declaration order", async () => {
    const endpoints = await parser.parse(COLLECTION);

    expect(endpoints).toEqual([
      { id: "Health", method: "GET", path: "/healthz" },
      { id: "Players/List", method: "GET", path: "/v1/players" },
      { id: "Players/Card", method: "GET", path: "/v1/players/{playerId}" },
      { id: "Players/Wallet/Balance", method: "GET", path: "/v1/players/{playerId}/wallet" },
      { id: "Admin/List", method: "DELETE", path: "/v1/admin/users" },
    ]);
  });

  // Requests with the same name in different folders are routine in a
  // collection; for the access policy they are two different endpoints.
  it("tells same-named requests apart by folder instead of merging them", async () => {
    const endpoints = await parser.parse(COLLECTION);
    const duplicates = endpoints.filter((endpoint) => endpoint.id.endsWith("/List"));

    expect(duplicates.map((endpoint) => endpoint.id)).toEqual(["Players/List", "Admin/List"]);
  });

  it("adds no operationId: a collection has none", async () => {
    const [endpoint] = await parser.parse(COLLECTION);

    expect(endpoint).toBeDefined();
    expect(Object.keys(endpoint ?? {})).toEqual(["id", "method", "path"]);
  });

  it("accepts every method of the domain and upper-cases it", async () => {
    const collection = JSON.stringify({
      item: ["get", "Head", "post", "put", "patch", "delete", "options"].map((method) => ({
        name: method,
        request: request(method, ["a"]),
      })),
    });

    const endpoints = await parser.parse(collection);

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

  it("accepts a collection without info: schema is optional", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Ping", request: request("GET", ["ping"]) }],
    });

    await expect(parser.parse(collection)).resolves.toEqual([
      { id: "Ping", method: "GET", path: "/ping" },
    ]);
  });

  it("accepts info without schema and info that is not an object", async () => {
    const item = [{ name: "Ping", request: request("GET", ["ping"]) }];

    await expect(parser.parse(JSON.stringify({ info: { name: "x" }, item }))).resolves.toHaveLength(
      1,
    );
    await expect(parser.parse(JSON.stringify({ info: "a string", item }))).resolves.toHaveLength(1);
  });

  it("accepts schema v2.0 on par with v2.1", async () => {
    const collection = JSON.stringify({
      info: {
        name: "x",
        schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json",
      },
      item: [{ name: "Ping", request: request("GET", ["ping"]) }],
    });

    await expect(parser.parse(collection)).resolves.toHaveLength(1);
  });

  it("ignores fields written for Postman rather than for us", async () => {
    const collection = JSON.stringify({
      info: { name: "x", schema: V21_SCHEMA, _postman_id: "abc" },
      variable: [{ key: "baseUrl", value: "https://api.example.test" }],
      event: [{ listen: "prerequest", script: { exec: ["pm.test()"] } }],
      item: [
        {
          name: "Ping",
          protocolProfileBehavior: { disableBodyPruning: true },
          response: [{ name: "200", code: 200 }],
          request: {
            method: "GET",
            header: [{ key: "accept", value: "application/json" }],
            body: { mode: "raw", raw: "{}" },
            auth: { type: "bearer" },
            description: "a liveness check",
            url: { raw: "{{baseUrl}}/ping", host: ["{{baseUrl}}"], path: ["ping"] },
          },
        },
      ],
    });

    await expect(parser.parse(collection)).resolves.toEqual([
      { id: "Ping", method: "GET", path: "/ping" },
    ]);
  });

  it("trims spaces in names: the id must not depend on them", async () => {
    const collection = JSON.stringify({
      item: [{ name: "  Folder  ", item: [{ name: " Ping ", request: request("GET", ["ping"]) }] }],
    });

    await expect(parser.parse(collection)).resolves.toEqual([
      { id: "Folder/Ping", method: "GET", path: "/ping" },
    ]);
  });
});

describe("Postman variables in the path", () => {
  // The core extracts parameters with `pathParameterNames`: on `{{playerId}}`
  // that would give a parameter named `{playerId`, which the author never wrote
  // and which no declared resource covers.
  it("reduces {{playerId}} to the parameter {playerId}", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Card", request: request("GET", ["v1", "players", "{{playerId}}"]) }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players/{playerId}");
  });

  it("reduces Postman's own :playerId form to {playerId}", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Card", request: request("GET", ["v1", "players", ":playerId"]) }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players/{playerId}");
  });

  // What is checked is the result as the core sees it: the parameter must be
  // extracted by the same rule the run and the diff look for it with. That used
  // to be a copy of the expression written out here, which made this test agree
  // with a spelling rather than with the core; it calls the core's own reader
  // now (ADR-0024's note of 23 August 2026).
  it("gives a parameter the core's own rule extracts", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "Bet",
          request: request("GET", ["v1", "{{tenantId}}", "bets", ":betId"]),
        },
      ],
    });

    const [endpoint] = await parser.parse(collection);
    const names = pathParameterNames(endpoint?.path ?? "");

    expect(names).toEqual(["tenantId", "betId"]);
  });

  it("accepts the already-final {playerId} form", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Card", request: request("GET", ["v1", "players", "{playerId}"]) }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players/{playerId}");
  });

  it("keeps a colon segment that does not look like a name as a literal", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Action", request: request("POST", ["v1", "orders:cancel", ":", ":a+b"]) }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/orders:cancel/:/:a+b");
  });

  it("rejects a variable whose name is not a parameter name", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Card", request: request("GET", ["v1", "{{ player id }}"]) }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/unclosed or empty brace/);
  });

  it("rejects an unclosed brace", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Card", request: request("GET", ["v1", "{playerId"]) }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({
      name: "InvalidPostmanItemError",
      location: "Card",
      field: "path",
    });
  });

  it("rejects an empty pair of braces", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Card", request: request("GET", ["v1", "{}"]) }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(InvalidPostmanItemError);
  });
});

describe("the path comes from url", () => {
  it("prefers path over the raw address", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "List",
          request: {
            method: "GET",
            url: { raw: "{{baseUrl}}/deprecated?x=1", path: ["v1", "players"] },
          },
        },
      ],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players");
  });

  it("takes raw when path is empty", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "List",
          request: { method: "GET", url: { raw: "{{baseUrl}}/v1/players", path: [] } },
        },
      ],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players");
  });

  it("accepts path as a string and adds the leading slash", async () => {
    const withSlash = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: "/v1/a" } } }],
    });
    const withoutSlash = JSON.stringify({
      item: [{ name: "b", request: { method: "GET", url: { path: "v1/b" } } }],
    });

    await expect(parser.parse(withSlash)).resolves.toEqual([
      { id: "a", method: "GET", path: "/v1/a" },
    ]);
    await expect(parser.parse(withoutSlash)).resolves.toEqual([
      { id: "b", method: "GET", path: "/v1/b" },
    ]);
  });

  it("takes raw when path is a blank string", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "a", request: { method: "GET", url: { path: "   ", raw: "{{baseUrl}}/v1/a" } } },
      ],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/a");
  });

  it("accepts url given entirely as a string", async () => {
    const collection = JSON.stringify({
      item: [{ name: "List", request: { method: "GET", url: "{{baseUrl}}/v1/players?page=2" } }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players");
  });

  it("drops the query string and the fragment", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "q", request: { method: "GET", url: { raw: "{{baseUrl}}/v1/a?b=1&c=2" } } },
        { name: "f", request: { method: "GET", url: { raw: "{{baseUrl}}/v1/b#fragment" } } },
      ],
    });

    const endpoints = await parser.parse(collection);

    expect(endpoints.map((endpoint) => endpoint.path)).toEqual(["/v1/a", "/v1/b"]);
  });

  it("treats an address without a path as a request to the root", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "var", request: { method: "GET", url: { raw: "{{baseUrl}}" } } },
        { name: "host", request: { method: "GET", url: { raw: "https://api.example.test" } } },
      ],
    });

    const endpoints = await parser.parse(collection);

    expect(endpoints.map((endpoint) => endpoint.path)).toEqual(["/", "/"]);
  });

  it("rejects an address no path can be extracted from", async () => {
    const collection = JSON.stringify({
      item: [{ name: "List", request: { method: "GET", url: { raw: "api.example.test/v1/a" } } }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({
      name: "InvalidPostmanItemError",
      field: "url",
    });
  });

  it("rejects an empty url string", async () => {
    const collection = JSON.stringify({
      item: [{ name: "List", request: { method: "GET", url: "   " } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/"request.url" is empty/);
  });

  it("rejects a url that is neither a string nor an object", async () => {
    const missing = JSON.stringify({ item: [{ name: "a", request: { method: "GET" } }] });
    const numeric = JSON.stringify({ item: [{ name: "b", request: { method: "GET", url: 42 } }] });

    await expect(parser.parse(missing)).rejects.toMatchObject({ field: "url" });
    await expect(parser.parse(numeric)).rejects.toMatchObject({ field: "url" });
  });

  it("rejects a url with neither path nor raw", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { host: ["{{baseUrl}}"] } } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(
      /neither a non-empty "path" nor a "raw"/,
    );
  });

  it("rejects a path segment that is not a string", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["v1", { value: "x" }] } } }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({ field: "path" });
  });
});

describe("the host in the collection does not decide the addressee", () => {
  // Where requests go is decided by the run's base URL and the allowlist. An
  // absolute address in the collection reduces to a path, and no host name is
  // left in the endpoint.
  it("drops the scheme and the host, keeping the path", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "abs", request: { method: "GET", url: { raw: "https://evil.test:9999/v1/a" } } },
        { name: "rel", request: { method: "GET", url: { raw: "//evil.test/v1/b" } } },
        { name: "var", request: { method: "GET", url: { raw: "{{scheme}}://{{host}}/v1/c" } } },
        { name: "many", request: { method: "GET", url: { raw: "{{host}}{{basePath}}/v1/d" } } },
      ],
    });

    const endpoints = await parser.parse(collection);

    expect(endpoints.map((endpoint) => endpoint.path)).toEqual([
      "/v1/a",
      "/v1/b",
      "/v1/c",
      "/v1/d",
    ]);
    for (const endpoint of endpoints) {
      expect(endpoint.path).not.toContain("evil.test");
    }
  });

  // Joined with the base, `//host/x` would address someone else's host instead
  // of a path on the target: the scope must not widen through a notation.
  it("rejects a scheme-relative URL assembled from segments", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["", "evil.test", "x"] } } }],
    });

    // The wording moved on 19 August 2026: the grammar refuses a scheme-relative
    // form for every source at once, so it now answers before this parser's own
    // host check does. Both are refusals; what this test is about is that the
    // collection cannot widen the scope through a notation.
    await expect(parser.parse(collection)).rejects.toThrow(/an address rather than a path/);
  });

  // Such a path starts with a slash and slips past a naive check, but
  // `new URL` gives priority to the absolute address — exactly the break an
  // adversarial review found in the run (ADR-0005).
  it("rejects a path that is itself an absolute address", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "a", request: { method: "GET", url: { path: ["https:", "", "evil.test", "x"] } } },
      ],
    });

    const attempt = parser.parse(collection);

    await expect(attempt).rejects.toMatchObject({ field: "path" });
    await expect(attempt).rejects.toThrow(/addresses https:\/\/evil\.test/);
  });

  it("rejects a path that does not parse as an address", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["https:", "", "["] } } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/could not be parsed as a URL/);
  });

  // A consequence of the check repeating the run's rule: the run strips the
  // leading slash before joining, and `orders:` in the first segment becomes a
  // scheme. The run would not perform such an endpoint anyway — it would land
  // in skips with the reason `escapes-target` — so refusing here is honest.
  // A colon in any other segment is harmless.
  it("rejects a colon in the first segment but not in the rest", async () => {
    const first = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["orders:cancel"] } } }],
    });
    const later = JSON.stringify({
      item: [{ name: "b", request: { method: "GET", url: { path: ["v1", "orders:cancel"] } } }],
    });

    await expect(parser.parse(first)).rejects.toThrow(/addresses null/);
    await expect(parser.parse(later)).resolves.toEqual([
      { id: "b", method: "GET", path: "/v1/orders:cancel" },
    ]);
  });
});

describe("a document of the wrong shape", () => {
  it("rejects empty input", async () => {
    await expect(parser.parse("")).rejects.toThrow(PostmanCollectionParseError);
  });

  it("rejects a scalar instead of a document", async () => {
    await expect(parser.parse("just a string")).rejects.toThrow(PostmanCollectionParseError);
  });

  it("rejects an unparseable document", async () => {
    await expect(parser.parse('{ "item": [')).rejects.toThrow(PostmanCollectionParseError);
  });

  it("rejects a document without an item key", async () => {
    await expect(parser.parse(JSON.stringify({ info: { name: "x" } }))).rejects.toThrow(
      /"item" key is missing or is not a list/,
    );
  });

  it("rejects an item that is not a list", async () => {
    await expect(parser.parse(JSON.stringify({ item: { name: "x" } }))).rejects.toThrow(
      PostmanCollectionParseError,
    );
  });

  // The v1 format describes requests differently: reading it as v2 means
  // reading it wrongly, not reading it partially.
  it("rejects schema v1 with an error of its own", async () => {
    const collection = JSON.stringify({
      info: {
        name: "x",
        schema: "https://schema.getpostman.com/json/collection/v1.0.0/collection",
      },
      item: [{ name: "a", request: request("GET", ["a"]) }],
    });

    const attempt = parser.parse(collection);

    await expect(attempt).rejects.toThrow(UnsupportedPostmanSchemaError);
    await expect(attempt).rejects.toMatchObject({
      schema: "https://schema.getpostman.com/json/collection/v1.0.0/collection",
    });
  });

  it("rejects a collection with no requests with an error of its own", async () => {
    await expect(parser.parse(JSON.stringify({ item: [] }))).rejects.toThrow(
      EmptyPostmanCollectionError,
    );
  });

  it("rejects a collection of nothing but empty folders", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Folder", item: [{ name: "Nested", item: [] }] }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(EmptyPostmanCollectionError);
  });
});

describe("a collection item fails validation", () => {
  it("rejects an item that is not an object", async () => {
    await expect(parser.parse(JSON.stringify({ item: ["/v1/users"] }))).rejects.toMatchObject({
      name: "InvalidPostmanItemError",
      location: "<collection root>",
      field: "item",
    });
  });

  it("rejects an item without a name", async () => {
    const missing = JSON.stringify({ item: [{ request: request("GET", ["a"]) }] });
    const blank = JSON.stringify({ item: [{ name: "  ", request: request("GET", ["a"]) }] });
    const numeric = JSON.stringify({ item: [{ name: 42, request: request("GET", ["a"]) }] });

    for (const collection of [missing, blank, numeric]) {
      await expect(parser.parse(collection)).rejects.toMatchObject({ field: "name" });
    }
  });

  // An item skipped silently is an unchecked endpoint in the report, and that
  // reads as "no violations".
  it("rejects an item that is neither a folder nor a request", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Neither one nor the other", description: "x" }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({
      location: "Neither one nor the other",
      field: "request",
    });
  });

  it("rejects an item that is a folder and a request at once", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Both", item: [], request: request("GET", ["a"]) }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/whether it is a folder or a request/);
  });

  it("rejects a folder whose item is not a list", async () => {
    const collection = JSON.stringify({ item: [{ name: "Folder", item: { name: "x" } }] });

    await expect(parser.parse(collection)).rejects.toThrow(/"item" must be a list/);
  });

  // The short form `"request": "https://..."` would mean GET by default;
  // guessing the method decides for the author what is being checked.
  it("rejects the short string form of a request", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Short", request: "https://api.example.test/v1/a" }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({ field: "request" });
  });

  it("rejects a missing method and a non-string method", async () => {
    const missing = JSON.stringify({ item: [{ name: "a", request: { url: "{{baseUrl}}/a" } }] });
    const numeric = JSON.stringify({
      item: [{ name: "b", request: { method: 200, url: "{{baseUrl}}/a" } }],
    });

    await expect(parser.parse(missing)).rejects.toMatchObject({ field: "method" });
    await expect(parser.parse(numeric)).rejects.toMatchObject({ field: "method" });
  });

  it("rejects a method outside the HttpMethod set", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: request("TRACE", ["a"]) }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/method "TRACE" is not supported/);
  });

  it("names the folder the failing item sits in", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "Ok", request: request("GET", ["ok"]) },
        {
          name: "Admin",
          item: [
            { name: "Also ok", request: request("GET", ["fine"]) },
            { name: "Broken", request: request("WAT", ["broken"]) },
          ],
        },
      ],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({
      location: "Admin/Broken",
      field: "method",
    });
  });
});

describe("identifier uniqueness", () => {
  it("rejects two requests with the same name in one folder", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "Players",
          item: [
            { name: "List", request: request("GET", ["v1", "players"]) },
            { name: "List", request: request("HEAD", ["v1", "players"]) },
          ],
        },
      ],
    });

    const attempt = parser.parse(collection);

    await expect(attempt).rejects.toThrow(DuplicatePostmanEndpointIdError);
    await expect(attempt).rejects.toMatchObject({ id: "Players/List" });
  });

  it("rejects an id collision assembled from different folders", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "a", item: [{ name: "b/c", request: request("GET", ["x"]) }] },
        { name: "a/b", item: [{ name: "c", request: request("GET", ["y"]) }] },
      ],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({ id: "a/b/c" });
  });

  it("tells ids apart by case: these are different endpoints", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "List", request: request("GET", ["v1", "players"]) },
        { name: "list", request: request("GET", ["v1", "Players"]) },
      ],
    });

    await expect(parser.parse(collection)).resolves.toHaveLength(2);
  });
});

describe("limits on the input", () => {
  it("rejects a YAML bomb before it expands", async () => {
    const bomb = `
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
item: [*d,*d,*d,*d,*d,*d,*d,*d,*d]
`;

    await expect(parser.parse(bomb)).rejects.toThrow(PostmanCollectionParseError);
  });

  it("counts aliases against its own limit, not someone else's", async () => {
    const strict = createPostmanCollectionParser({ maxAliasCount: 1 });
    const collection = `
item:
  - &first { name: a, request: { method: GET, url: "{{baseUrl}}/a" } }
  - *first
  - *first
`;

    await expect(strict.parse(collection)).rejects.toThrow(PostmanCollectionParseError);
  });

  it("rejects a document over the limit and names the actual size", async () => {
    const small = createPostmanCollectionParser({ maxBytes: 32 });

    const attempt = small.parse(COLLECTION);

    await expect(attempt).rejects.toThrow(PostmanCollectionTooLargeError);
    await expect(attempt).rejects.toThrow(
      new RegExp(`${Buffer.byteLength(COLLECTION, "utf8")} bytes, the limit is 32`),
    );
  });

  it("measures the size in bytes, not in characters", async () => {
    // Characters outside ASCII take two bytes in UTF-8: a limit set in bytes
    // cannot be checked against the string length.
    const limited = createPostmanCollectionParser({ maxBytes: 20 });

    // A character outside ASCII: two bytes in UTF-8, one in length.
    await expect(limited.parse("é".repeat(11))).rejects.toThrow(PostmanCollectionTooLargeError);
  });

  it("lets through a document exactly at the limit", async () => {
    const source = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: "{{baseUrl}}/a" } }],
    });
    const exact = createPostmanCollectionParser({ maxBytes: Buffer.byteLength(source, "utf8") });

    await expect(exact.parse(source)).resolves.toHaveLength(1);
  });

  it("rejects folder nesting deeper than the limit", async () => {
    let node: unknown = { name: "Request", request: request("GET", ["a"]) };
    for (let i = 0; i < DEFAULT_POSTMAN_LIMITS.maxFolderDepth + 5; i += 1) {
      node = { name: `Folder ${i}`, item: [node] };
    }

    await expect(parser.parse(JSON.stringify({ item: [node] }))).rejects.toThrow(
      PostmanCollectionTooDeepError,
    );
  });

  it("lets through nesting exactly at the limit", async () => {
    const shallow = createPostmanCollectionParser({ maxFolderDepth: 2 });
    const collection = JSON.stringify({
      item: [
        {
          name: "Outer",
          item: [{ name: "Inner", item: [{ name: "Request", request: request("GET", ["a"]) }] }],
        },
      ],
    });

    await expect(shallow.parse(collection)).resolves.toEqual([
      { id: "Outer/Inner/Request", method: "GET", path: "/a" },
    ]);
  });

  it("breaks a cycle built from YAML anchors instead of looping forever", async () => {
    // `&loop` refers to itself: a walk over such a structure without a depth
    // limit would never finish.
    const cyclic = `
item:
  - &loop
    name: Folder
    item:
      - *loop
`;

    await expect(parser.parse(cyclic)).rejects.toThrow(PostmanCollectionTooDeepError);
  });
});

describe("the parser does not touch the file system", () => {
  let directory = "";
  let collectionPath = "";
  const CANARY = "canary-9b41c-must-not-leak";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "barbican-postman-"));
    collectionPath = join(directory, "collection.json");
    await writeFile(
      collectionPath,
      JSON.stringify({ item: [{ name: CANARY, request: request("GET", ["a"]) }] }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // The input is the text of the document, not a path. A parser that could
  // open files would be a path traversal primitive.
  it("does not read a file whose path is passed as the source", async () => {
    const attempt = parser.parse(collectionPath);

    await expect(attempt).rejects.toThrow(PostmanCollectionParseError);
    await expect(
      attempt.catch((error: unknown) => JSON.stringify(error) + String(error)),
    ).resolves.not.toContain(CANARY);
  });

  /**
   * The security claim, in the form that means the same on every platform.
   *
   * Whatever the parser makes of the address — a Windows path is not a URL path
   * and collapses to `/` — the file at the other end must not have been opened,
   * so the canary is in neither the result nor the refusal. The assertion used
   * to require the address to survive verbatim as well, which is a different
   * claim and one that is simply false on Windows; the two are separated below.
   * Found by the Windows job added for K-7 on 17 August 2026, on its first run.
   */
  it("does not read a file whose path ended up in a request address", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { raw: `file://${collectionPath}` } } }],
    });

    const outcome = await parser
      .parse(collection)
      .then((endpoints) => JSON.stringify(endpoints))
      .catch((error: unknown) => JSON.stringify(error) + String(error));

    expect(outcome).not.toContain(CANARY);
  });

  /** And an address that is a path stays one, rather than being resolved. */
  it("carries a path-shaped address through without resolving it", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "a",
          request: { method: "GET", url: { raw: "file:///var/lib/barbican/secret.json" } },
        },
      ],
    });

    await expect(parser.parse(collection)).resolves.toEqual([
      { id: "a", method: "GET", path: "/var/lib/barbican/secret.json" },
    ]);
  });
});

describe("the parser does not touch the network", () => {
  let hits = 0;
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    hits = 0;
    server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"canary":true}');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not start the test server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  // The main claim is not "an error was thrown" but "nothing went out".
  it("performs no request to the addresses in the collection", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "abs", request: { method: "GET", url: { raw: `${baseUrl}/v1/a` } } },
        { name: "ref", request: { method: "GET", url: { raw: `${baseUrl}/spec.json` }, $ref: 1 } },
      ],
    });

    const endpoints = await parser.parse(collection);

    expect(endpoints.map((endpoint) => endpoint.path)).toEqual(["/v1/a", "/spec.json"]);
    expect(hits).toBe(0);
  });

  it("does not go to the address even when parsing failed with an error", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "WAT", url: { raw: `${baseUrl}/v1/a` } } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(InvalidPostmanItemError);
    expect(hits).toBe(0);
  });
});

/**
 * Nothing but the tool decides what the request address is.
 *
 * The rule is written in CLAUDE.md for one channel: a request-condition attribute
 * must not replace the basis of the request, checked by exact name, by family
 * prefix, and **by value** — the last of which is what catches a method override
 * smuggled through an attribute. `assertContextsCannotWrite` implements it, and
 * it reads `contexts` only: the one channel an operator fills in by hand.
 *
 * Three other channels reach the same address, and every one of them takes its
 * value from a document the tool was handed — a specification, an endpoint list,
 * a Postman collection — or from the resource declarations beside them. None was
 * guarded. Adversarial review, 17 August 2026:
 *
 * - `paths: "/v1/orders/{orderId}?_method=DELETE"` in a specification issued a
 *   GET on the wire that a great many frameworks execute as a DELETE. Without
 *   `--unsafe-methods`, with `writeMethodsProbed: false` in the report, exit 0.
 *   `SAFE_METHODS` held to the letter and the guarantee it stands for did not.
 * - `paths: "/v1/reports/../../createdb"` reached `/createdb` — past the
 *   exclusion list, which works on endpoint ids and never sees the string, and
 *   with the verdict for one endpoint computed from another one's answer.
 * - `resources[].query` had no guard at all, so a credential named there is
 *   printed verbatim in `observations[].url`, and a write method named there is
 *   performed by a platform that honours overrides.
 *
 * The grammar for a path template lives in `src/io/untrusted.ts` with the others,
 * per ADR-0024: a string from outside has its grammar written once, and this is
 * the case that rule exists to stop being a twelfth point fix.
 */

import { describe, expect, it } from "vitest";
import { createEndpointListParser } from "../src/adapters/endpoint-list.js";
import { createOpenApiParser } from "../src/adapters/openapi.js";
import { createPostmanCollectionParser } from "../src/adapters/postman.js";
import { ForbiddenResourceQueryError, parseRunConfig } from "../src/io/config.js";
import { isUsablePathTemplate, UnusablePathTemplateError } from "../src/io/untrusted.js";

const spec = (path: string) => `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  ${JSON.stringify(path)}:
    get:
      responses: { "200": { description: ok } }
`;

const collection = (segments: readonly string[]) =>
  JSON.stringify({
    item: [
      {
        name: "a",
        request: { method: "GET", url: { raw: "{{baseUrl}}/x", path: [...segments] } },
      },
    ],
  });

const list = (path: string) => `endpoints: [{ id: a, method: GET, path: ${JSON.stringify(path)} }]`;

describe("a query string in a path template", () => {
  /** The finding itself, on the source it was found through. */
  it("is refused by the OpenAPI parser", async () => {
    await expect(
      createOpenApiParser().parse(spec("/v1/orders/{orderId}?_method=DELETE")),
    ).rejects.toThrow(UnusablePathTemplateError);
  });

  it("is refused by the endpoint list", async () => {
    await expect(
      createEndpointListParser().parse(list("/v1/orders?_method=DELETE")),
    ).rejects.toThrow(/query string or a fragment/);
  });

  /**
   * The array form of `url.path`. The string form was already cut by
   * `pathFromRaw`, which is why this door stayed open — one of the two spellings
   * of the same field was handled and the other was not.
   */
  it("is refused by the Postman parser, in the form that was not already cut", async () => {
    await expect(
      createPostmanCollectionParser().parse(collection(["v1", "orders?_method=DELETE"])),
    ).rejects.toThrow(UnusablePathTemplateError);
  });

  /** A fragment goes the same way: everything after `#` is the tool's to decide. */
  it("refuses a fragment too", () => {
    expect(isUsablePathTemplate("/v1/orders#x")).toBe(false);
  });
});

describe("a path template that navigates", () => {
  /**
   * `..` reached `/createdb` on the reference platform — the endpoint the
   * exclusion list exists for, and one it cannot protect, because exclusions are
   * by id and this is a string.
   */
  it("is refused, so a verdict is never computed from another endpoint's answer", async () => {
    await expect(createOpenApiParser().parse(spec("/v1/reports/../../createdb"))).rejects.toThrow(
      /navigates/,
    );
  });

  it("is refused percent-encoded as well", () => {
    expect(isUsablePathTemplate("/v1/reports/%2e%2e/createdb")).toBe(false);
    expect(isUsablePathTemplate("/v1/reports/%2E%2E/createdb")).toBe(false);
  });

  /** A dot inside a segment is a filename, not navigation. */
  it("leaves an ordinary path alone", async () => {
    expect(isUsablePathTemplate("/v1/players/{playerId}/avatar.png")).toBe(true);
    await expect(createOpenApiParser().parse(spec("/v1/players/{playerId}"))).resolves.toHaveLength(
      1,
    );
  });
});

describe("a resource's query string", () => {
  const config = (query: string) => `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: alice, role: r, tenant: t-a, tokenEnv: A }]
resources:
  - { id: order-1, tenant: t-a, params: { orderId: "1" }, query: ${query} }
policy: { fallback: denied, rules: [] }
`;

  /**
   * The twin of `contexts[].query`, which has been guarded since request
   * conditions existed. This one reached the address by the same route with
   * nothing in the way, and the address is printed in the report as it was sent.
   */
  it("may not name a credential", () => {
    expect(() => parseRunConfig(config("{ access_token: SECRET-abcdef }"))).toThrow(
      ForbiddenResourceQueryError,
    );
    expect(() => parseRunConfig(config("{ access_token: SECRET-abcdef }"))).toThrow(/credentials/);
  });

  /** By value, which is the layer that catches an override under any key. */
  it("may not carry the name of a write method under any key", () => {
    expect(() => parseRunConfig(config("{ _method: DELETE }"))).toThrow(
      ForbiddenResourceQueryError,
    );
    // Whitespace and case are not a way around it: the platform trims too.
    expect(() => parseRunConfig(config('{ x_verb: " delete " }'))).toThrow(
      ForbiddenResourceQueryError,
    );
  });

  it("is otherwise carried as declared", () => {
    const parsed = parseRunConfig(config("{ include: totals }"));

    expect(parsed.resources?.[0]?.query).toEqual({ include: "totals" });
  });
});

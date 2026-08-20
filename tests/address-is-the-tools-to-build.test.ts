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
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import { createEndpointListParser } from "../src/adapters/endpoint-list.js";
import { createOpenApiParser } from "../src/adapters/openapi.js";
import type { HttpClient } from "../src/adapters/ports.js";
import { createPostmanCollectionParser } from "../src/adapters/postman.js";
import type { Account } from "../src/core/index.js";
import { ForbiddenResourceQueryError, parseRunConfig } from "../src/io/config.js";
import {
  isAddressablePath,
  isUsablePathTemplate,
  pathTemplate,
  UnusablePathTemplateError,
} from "../src/io/untrusted.js";
import { collectObservations } from "../src/runner.js";

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

describe("a path template that navigates with a backslash", () => {
  /**
   * The guard written on 17 August split the string on `/` and looked for `.`
   * and `..`. A URL parser splits http and https paths on `\` as well, so the
   * whole of this template was one segment to the guard and three to the
   * parser — and the request went to `/danger`, an endpoint the configuration
   * had excluded, with the verdict for `reports` computed from its answer.
   * Adversarial review, 19 August 2026.
   */
  const withBackslashes = "/v1/reports\\..\\..\\danger";

  it("is refused by the OpenAPI parser", async () => {
    await expect(createOpenApiParser().parse(spec(withBackslashes))).rejects.toThrow(
      /backslash or a control character/,
    );
  });

  it("is refused by the endpoint list", async () => {
    // The message and not the class: this parser wraps what the grammar throws
    // into `InvalidEndpointError`, which names the entry the operator has to fix.
    await expect(createEndpointListParser().parse(list(withBackslashes))).rejects.toThrow(
      /backslash or a control character/,
    );
  });

  it("is refused by the Postman parser", async () => {
    await expect(
      createPostmanCollectionParser().parse(collection(["v1", "reports\\..\\..\\danger"])),
    ).rejects.toThrow(UnusablePathTemplateError);
  });

  /**
   * The parser removes tab, newline and carriage return from the address before
   * it reads anything, so a segment of dot, newline, dot is `..` by the time the
   * request exists — after a guard that split on `/` had approved it.
   */
  it("is refused when the navigation is spelled with a control character", () => {
    expect(isUsablePathTemplate("/v1/reports/.\n./danger")).toBe(false);
    expect(isUsablePathTemplate("/v1/reports/.\t./danger")).toBe(false);
    expect(isUsablePathTemplate("/v1/reports/.\r./danger")).toBe(false);
  });

  /** Percent-encoded, for the same reason `%2e` is refused: the target decodes it. */
  it("is refused percent-encoded", () => {
    expect(isUsablePathTemplate("/v1/reports%5c..%5c..%5cdanger")).toBe(false);
    expect(isUsablePathTemplate("/v1/reports%5C..%5C..%5Cdanger")).toBe(false);
  });

  it("leaves an ordinary path alone", () => {
    expect(isUsablePathTemplate("/v1/reports/{reportId}")).toBe(true);
  });
});

describe("the seam where the address is built", () => {
  /**
   * The fourth door, and the one no adapter guards: a consumer of the library
   * hands `Endpoint[]` to `collectObservations` itself. `Endpoint.path` is a
   * plain string — the package is published as a library as well as a CLI, and
   * on 19 August every refusal written on 17 August was open through it.
   *
   * The grammar therefore also sits at `joinUrl`, which is the one place an
   * address is assembled, so all four doors pass through it.
   */
  const account: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));

  async function walk(path: string) {
    const seen: string[] = [];
    const client: HttpClient = {
      send(request) {
        seen.push(request.url);
        return Promise.resolve({ status: 200, headers: {} });
      },
    };
    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "e", method: "GET", path }],
      accounts: account,
      credentials,
      client,
      exclude: ["createdb"],
    });
    return { seen, result };
  }

  it("refuses a query string handed straight to the runner", async () => {
    const { seen, result } = await walk("/v1/orders/42?_method=DELETE");

    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "e", reason: "escapes-target" }]);
  });

  it("refuses a backslash handed straight to the runner", async () => {
    const { seen, result } = await walk("/v1/reports\\..\\..\\createdb");

    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "e", reason: "escapes-target" }]);
  });

  it("still walks an ordinary path", async () => {
    const { seen } = await walk("/v1/orders");

    expect(seen).toEqual(["https://api.test/v1/orders"]);
  });
});

describe("a write method this tool does not perform but a platform will", () => {
  const resourceQuery = (query: string) => `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: alice, role: r, tenant: t-a, tokenEnv: A }]
resources:
  - { id: order-1, tenant: t-a, params: { orderId: "1" }, query: ${query} }
policy: { fallback: denied, rules: [] }
`;

  /**
   * The check by value knew the seven methods this tool can issue. A platform
   * honouring an override is not limited to them: `MOVE` deletes the source, and
   * it went through as a resource query on 19 August 2026 with
   * `--unsafe-methods` absent.
   */
  it("is refused in a resource's query", () => {
    expect(() => parseRunConfig(resourceQuery("{ _method: MOVE }"))).toThrow(
      ForbiddenResourceQueryError,
    );
    expect(() => parseRunConfig(resourceQuery("{ _action: PURGE }"))).toThrow(
      ForbiddenResourceQueryError,
    );
    expect(() => parseRunConfig(resourceQuery("{ x: PROPPATCH }"))).toThrow(
      ForbiddenResourceQueryError,
    );
  });

  /**
   * The comment beside the set claims the IANA registry, and the second
   * adversarial pass of 19 August took it at its word: six registered methods
   * that write were missing. A claim about a registry has to be the registry.
   */
  it("is refused for every registered method that writes", () => {
    for (const method of [
      "LINK",
      "MKCALENDAR",
      "MKREDIRECTREF",
      "ORDERPATCH",
      "UNLINK",
      "UPDATEREDIRECTREF",
    ]) {
      expect(() => parseRunConfig(resourceQuery(`{ _method: ${method} }`))).toThrow(
        ForbiddenResourceQueryError,
      );
    }
  });

  it("leaves a value that is not a method alone", () => {
    expect(() => parseRunConfig(resourceQuery("{ sort: moved }"))).not.toThrow();
  });
});

/**
 * The second pass over the same guard, on 19 August 2026.
 *
 * The fixes above were attacked the same day they were written, and three of the
 * spellings below went through them. Two of the three are the same mistake as the
 * backslash — a string the receiver reads differently than a split on `/` does —
 * and the third is the door that was left ajar in the other direction: the
 * OpenAPI parser accepted an absolute URL where the endpoint list and the Postman
 * parser had each refused one in their own way.
 */
describe("navigation the receiver collapses and this tool did not", () => {
  /**
   * `new URL` **itself** collapses these: the URL Standard calls `.%2e`, `%2e.`
   * and `%2e%2e` double-dot path segments. The seam had been written to read the
   * string literally, on the reasoning that only the target decodes — and the
   * reasoning was wrong about the parser this tool calls on the next line.
   */
  it("is refused when the dots are percent-encoded, at the seam as well as the door", () => {
    for (const spelling of ["%2e%2e", ".%2e", "%2e.", "%2E%2E"]) {
      expect(isAddressablePath(`/v1/reports/${spelling}/danger`)).toBe(false);
      expect(isUsablePathTemplate(`/v1/reports/${spelling}/danger`)).toBe(false);
    }
  });

  /**
   * `..;` is `..` to a servlet container, which strips `;params` from a segment
   * before it normalises the path — the long-standing way past a path-prefix
   * rule in Spring Security.
   */
  it("is refused when a path parameter follows the dots", () => {
    expect(isAddressablePath("/v1/reports/..;/danger")).toBe(false);
    expect(isUsablePathTemplate("/v1/reports/..;jsessionid=x/danger")).toBe(false);
    // A `;` that is not hiding navigation is left alone: this is a grammar for
    // the address, not a style guide.
    expect(isAddressablePath("/v1/reports;v=2/danger")).toBe(true);
  });

  it("leaves an encoded value that navigates nowhere alone", () => {
    // What a resource value looks like after `encodeURIComponent`: refusing it
    // would break a legitimate identifier, and it reaches no other endpoint.
    expect(isAddressablePath("/v1/files/a%5Cb")).toBe(true);
    expect(isAddressablePath("/v1/files/%252e%252e")).toBe(true);
  });
});

describe("an address where a path belongs", () => {
  /**
   * `new URL(path, base)` gives priority to an absolute address, and the origin
   * comparison in `joinUrl` — the guard written for exactly this — does not carry
   * userinfo. So the credentials in the key travelled into `observations[].url`,
   * which is printed in the report verbatim.
   */
  it("is refused as an OpenAPI paths key", async () => {
    await expect(
      createOpenApiParser().parse(spec("https://bob:s3cret@api.test/v1/danger")),
    ).rejects.toThrow(/an address rather than a path/);
  });

  /**
   * The stranger half: `joinUrl` strips leading slashes, so this became
   * `/v1/api.test/v1/danger` — a request the endpoint does not name, reported as
   * if it were the one it does.
   */
  it("is refused scheme-relative", () => {
    expect(isUsablePathTemplate("//api.test/v1/danger")).toBe(false);
    expect(isAddressablePath("//api.test/v1/danger")).toBe(false);
  });

  it("leaves a path with a colon inside a segment alone", () => {
    // A colon later in the string is not a scheme: `/v1/a:b` is an ordinary path
    // and some platforms build identifiers that way.
    expect(isUsablePathTemplate("/v1/orders/a:b")).toBe(true);
  });
});

/**
 * The two entry points to one grammar answer the same question.
 *
 * `pathTemplate` throws where `isUsablePathTemplate` returns false, and they are
 * separate functions because one reports and the other is read by the core. For
 * half an hour on 19 August they disagreed: a branch added that afternoon tested
 * the raw string where the three around it tested the decoded one, so
 * `%2f%2fhost/x` threw nothing and was unusable at the same time.
 *
 * A corpus rather than one case: what is under test is that the two stay level as
 * branches are added, and a single example only pins the branch it was written
 * for.
 */
describe("the reporting half and the predicate half", () => {
  const CORPUS = [
    "/v1/orders",
    "/v1/orders/{orderId}",
    "/v1/players/{playerId}/avatar.png",
    "/v1/orders?_method=DELETE",
    "/v1/orders#fragment",
    "/v1/reports/../danger",
    "/v1/reports/%2e%2e/danger",
    "/v1/reports/..;/danger",
    "/v1/reports\\..\\danger",
    "/v1/reports%5c..%5cdanger",
    "//api.test/v1/danger",
    "%2f%2fapi.test/v1/danger",
    "https://bob:s3cret@api.test/v1/danger",
    "/v1/files/a%5Cb",
    "/v1/orders/a:b",
  ];

  it("agree on every spelling in the corpus", () => {
    for (const value of CORPUS) {
      let refused = false;
      try {
        pathTemplate(value);
      } catch {
        refused = true;
      }

      expect(refused, `pathTemplate and isUsablePathTemplate disagree on ${value}`).toBe(
        !isUsablePathTemplate(value),
      );
    }
  });

  /** And the corpus covers both answers, or the assertion above is trivially true. */
  it("cover both answers", () => {
    const usable = CORPUS.filter((value) => isUsablePathTemplate(value));

    expect(usable.length).toBeGreaterThan(2);
    expect(usable.length).toBeLessThan(CORPUS.length - 2);
  });
});

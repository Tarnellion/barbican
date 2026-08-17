/**
 * The method set has one home, and everything that reads it agrees with it.
 *
 * The audit of 14 August 2026 (B-10) counted five copies of the HTTP method set
 * and two the compiler never read: the OpenAPI parser's own lower-case list and
 * the `z.enum` in the run configuration's schema. Both would have failed the same
 * way. A method added to `HttpMethod` would simply not be in them, and nothing
 * would say so — in the parser every operation of that method would drop out of
 * the matrix while coverage went on reporting a hundred percent of what was
 * parsed; in the schema a rule naming the method would be refused as invalid, and
 * the endpoints it covered would fall through to the fallback instead.
 *
 * The copies are gone. `HTTP_METHODS` in the core is the one place, and
 * `Record<HttpMethod, …>` is what keeps it complete: `pnpm run typecheck` fails
 * on a method the domain has and that record does not. What the compiler cannot
 * hold is the plumbing on each side — that the OpenAPI parser lower-cases the
 * name it looks a path item up by, that `z.enum` was handed the values of the
 * record and not its keys. That is what is checked here.
 *
 * The methods are read off `HTTP_METHODS` rather than written out again. A list
 * here would be the sixth copy, and this file exists because of the fifth. The
 * hand-written part is the other half — `TRACE`, a method the domain
 * deliberately does not have, without which these tests would agree with any set
 * at all.
 */

import { describe, expect, it } from "vitest";
import { createEndpointListParser, InvalidEndpointError } from "../src/adapters/endpoint-list.js";
import { createOpenApiParser } from "../src/adapters/openapi.js";
import { createPostmanCollectionParser, InvalidPostmanItemError } from "../src/adapters/postman.js";
import { HTTP_METHODS } from "../src/core/types.js";
import { ConfigValidationError, parseRunConfig } from "../src/io/config.js";

const METHODS = Object.values(HTTP_METHODS);

/** A method the domain does not have, so that "accepts everything" cannot pass. */
const OUTSIDE = "TRACE";

const PATH = "/v1/things";

const V21_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

function specWith(methods: readonly string[]): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Platform", version: "1.0.0" },
    paths: {
      [PATH]: Object.fromEntries(
        methods.map((method) => [method.toLowerCase(), { operationId: `things.${method}` }]),
      ),
    },
  });
}

function listWith(methods: readonly string[]): string {
  return JSON.stringify({
    endpoints: methods.map((method) => ({ id: `things.${method}`, method, path: PATH })),
  });
}

function collectionWith(methods: readonly string[]): string {
  return JSON.stringify({
    info: { name: "Platform", schema: V21_SCHEMA },
    item: methods.map((method) => ({
      name: `things ${method}`,
      request: {
        method,
        url: { raw: `{{baseUrl}}${PATH}`, host: ["{{baseUrl}}"], path: ["v1", "things"] },
      },
    })),
  });
}

function configWith(methods: readonly string[]): string {
  const selectors = JSON.stringify(methods.map((method) => ({ method, path: PATH })));
  return `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: ${selectors}, outcome: allowed }
`;
}

describe("the one method set", () => {
  it("names more than one method, or the checks below prove nothing", () => {
    expect(METHODS.length).toBeGreaterThan(1);
    expect(METHODS).not.toContain(OUTSIDE);
  });

  it("is what the OpenAPI parser reads a path item by", async () => {
    const endpoints = await createOpenApiParser().parse(specWith(METHODS));

    // Every method of the domain, and in the domain's upper case: a path item
    // spells its operations in lower case, and the conversion between the two is
    // the step that used to be a second list.
    expect(endpoints.map((endpoint) => endpoint.method)).toEqual(METHODS);
  });

  it("is what the OpenAPI parser stops at: an operation outside it is not an endpoint", async () => {
    const endpoints = await createOpenApiParser().parse(specWith([OUTSIDE]));

    // Silently, and rightly so: a path item may carry `parameters`, `summary` and
    // other keys that are not operations, so an unknown key is not an error here.
    expect(endpoints).toEqual([]);
  });

  it("is what an endpoint list is accepted against", async () => {
    const endpoints = await createEndpointListParser().parse(listWith(METHODS));

    expect(endpoints.map((endpoint) => endpoint.method)).toEqual(METHODS);
    await expect(createEndpointListParser().parse(listWith([OUTSIDE]))).rejects.toThrow(
      InvalidEndpointError,
    );
  });

  it("is what a Postman collection is accepted against", async () => {
    const endpoints = await createPostmanCollectionParser().parse(collectionWith(METHODS));

    expect(endpoints.map((endpoint) => endpoint.method)).toEqual(METHODS);
    await expect(createPostmanCollectionParser().parse(collectionWith([OUTSIDE]))).rejects.toThrow(
      InvalidPostmanItemError,
    );
  });

  it("is what a policy rule may name a method from", () => {
    const rule = parseRunConfig(configWith(METHODS)).policy.rules[0];

    expect(rule?.endpoints).toEqual(METHODS.map((method) => ({ method, path: PATH })));
    // The other direction, and the one that hides a finding: a method the schema
    // refuses cannot be declared at all, so every cell it covers falls through to
    // the fallback.
    expect(() => parseRunConfig(configWith([OUTSIDE]))).toThrow(ConfigValidationError);
  });
});

/**
 * Brands spread across subdomains.
 *
 * The key claim to check on a multi-brand platform is "brand A's token does not
 * work on brand B's host". To state it at all, the request has to go to the
 * host of the **resource's** tenant, not the account's. See ADR-0013.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import type { HttpClient, HttpRequest } from "../src/adapters/ports.js";
import type { Account, Endpoint, Resource } from "../src/core/index.js";
import { collectObservations, probeCanaries } from "../src/runner.js";

const ACCOUNTS: readonly Account[] = [{ id: "op-a", roleId: "operator", tenantId: "brand-a" }];

const RESOURCES: readonly Resource[] = [
  { id: "r-a", tenantId: "brand-a", params: { id: "1" } },
  { id: "r-b", tenantId: "brand-b", params: { id: "2" } },
];

const ENDPOINTS: readonly Endpoint[] = [
  { id: "orders.read", method: "GET", path: "/v1/orders/{id}" },
  { id: "orders.list", method: "GET", path: "/v1/orders" },
];

const TENANT_URLS = new Map([
  ["brand-a", "https://a.example.test"],
  ["brand-b", "https://b.example.test"],
]);

function recordingClient(): { client: HttpClient; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return {
    seen,
    client: {
      send(request) {
        seen.push(request);
        return Promise.resolve({ status: 200, headers: {} });
      },
    },
  };
}

const credentials = createCredentialProvider(
  DEFAULT_AUTH_SCHEME,
  new Map([["op-a", "brand-a-token"]]),
);

describe("the address is chosen by the resource's tenant", () => {
  it("sends brand A's token to brand B's host when the resource belongs to B", async () => {
    const { client, seen } = recordingClient();

    await collectObservations({
      baseUrl: "https://api.example.test",
      endpoints: ENDPOINTS,
      accounts: ACCOUNTS,
      resources: RESOURCES,
      credentials,
      client,
      tenantBaseUrls: TENANT_URLS,
    });

    const byUrl = seen.map((request) => request.url);
    expect(byUrl).toContain("https://a.example.test/v1/orders/1");
    // Exactly what a per-tenant address was introduced for: the other brand is
    // probed on its own host while the token stays brand A's token.
    expect(byUrl).toContain("https://b.example.test/v1/orders/2");
    // The length first. The assertion below lives inside a loop, and over an
    // empty list a loop asserts nothing at all: a client that recorded no
    // request would have passed it. Found by the audit of 14 August (C-6).
    expect(seen).toHaveLength(3);
    for (const request of seen) {
      expect(request.headers.authorization).toBe("Bearer brand-a-token");
    }
  });

  /** With no resource the question is about the account's own scope, so its own host. */
  it("takes the account tenant's address when there is no resource", async () => {
    const { client, seen } = recordingClient();

    await collectObservations({
      baseUrl: "https://api.example.test",
      endpoints: [{ id: "orders.list", method: "GET", path: "/v1/orders" }],
      accounts: ACCOUNTS,
      credentials,
      client,
      tenantBaseUrls: TENANT_URLS,
    });

    expect(seen[0]?.url).toBe("https://a.example.test/v1/orders");
  });

  /**
   * An account outside of tenants (an anonymous one) has no address of its own
   * and cannot have one: there is nothing to choose it by. A placeholder tenant
   * here would mean a lookup by a name that does not exist — the same thing,
   * only implicit.
   */
  it("an account outside of tenants probes the common address, a resource its tenant's", async () => {
    const { client, seen } = recordingClient();
    const anonymous: readonly Account[] = [{ id: "anon", roleId: "anonymous" }];

    await collectObservations({
      baseUrl: "https://api.example.test",
      endpoints: ENDPOINTS,
      accounts: anonymous,
      resources: RESOURCES,
      credentials,
      client,
      tenantBaseUrls: TENANT_URLS,
    });

    const byUrl = seen.map((request) => request.url);
    // An endpoint with no resource: the account has no tenant, so the common
    // address is what is left.
    expect(byUrl).toContain("https://api.example.test/v1/orders");
    // An endpoint with a resource: the address is still chosen by the
    // resource's tenant.
    expect(byUrl).toContain("https://a.example.test/v1/orders/1");
    expect(byUrl).toContain("https://b.example.test/v1/orders/2");
  });

  it("the canary of an account outside of tenants goes to the common address", async () => {
    const { client, seen } = recordingClient();

    await probeCanaries({
      baseUrl: "https://api.example.test",
      endpoints: ENDPOINTS,
      canaries: [{ accountId: "anon", endpointId: "orders.list" }],
      credentials,
      client,
      accounts: [{ id: "anon", roleId: "anonymous" }],
      tenantBaseUrls: TENANT_URLS,
    });

    expect(seen[0]?.url).toBe("https://api.example.test/v1/orders");
  });

  it("with no declared addresses everything goes to the common one, as before", async () => {
    const { client, seen } = recordingClient();

    await collectObservations({
      baseUrl: "https://api.example.test",
      endpoints: ENDPOINTS,
      accounts: ACCOUNTS,
      resources: RESOURCES,
      credentials,
      client,
    });

    for (const request of seen) {
      expect(request.url.startsWith("https://api.example.test/")).toBe(true);
    }
  });

  /**
   * On a platform spread across hosts a canary must knock on its own brand's
   * host: a request to the common address would be denied, and the run would
   * stop on the false alarm "the token does not work".
   */
  it("the canary goes to its own brand's host", async () => {
    const { client, seen } = recordingClient();

    await probeCanaries({
      baseUrl: "https://api.example.test",
      endpoints: ENDPOINTS,
      canaries: [{ accountId: "op-a", endpointId: "orders.list" }],
      credentials,
      client,
      accounts: ACCOUNTS,
      tenantBaseUrls: TENANT_URLS,
    });

    expect(seen[0]?.url).toBe("https://a.example.test/v1/orders");
  });
});

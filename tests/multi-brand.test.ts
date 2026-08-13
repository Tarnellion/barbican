/**
 * Бренды, разнесённые по поддоменам.
 *
 * Ключевое проверяемое утверждение мультибрендовой платформы — «токен бренда A
 * не работает на хосте бренда B». Чтобы его вообще задать, обращение должно
 * уходить на хост тенанта **объекта**, а не аккаунта. См. ADR-0013.
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
  new Map([["op-a", "токен-бренда-a"]]),
);

describe("адрес выбирается по тенанту объекта", () => {
  it("шлёт токен бренда A на хост бренда B, когда объект принадлежит B", async () => {
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
    // Ровно то, ради чего вводился адрес на тенанта: чужой бренд опрашивается
    // на своём хосте, а токен при этом остаётся токеном бренда A.
    expect(byUrl).toContain("https://b.example.test/v1/orders/2");
    for (const request of seen) {
      expect(request.headers.authorization).toBe("Bearer токен-бренда-a");
    }
  });

  /** Объекта нет — вопрос о собственной области аккаунта, значит его же хост. */
  it("без объекта берёт адрес тенанта аккаунта", async () => {
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
   * У аккаунта вне тенантов (анонимного) своего адреса нет и быть не может:
   * выбирать его не по чему. Заглушка вместо тенанта здесь означала бы поиск
   * по несуществующему имени — то же самое, но неявно.
   */
  it("аккаунт вне тенантов опрашивает общий адрес, а объект — адрес своего тенанта", async () => {
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
    // Ручка без объекта: тенанта у аккаунта нет — остаётся общий адрес.
    expect(byUrl).toContain("https://api.example.test/v1/orders");
    // Ручка с объектом: адрес по-прежнему выбирается по тенанту объекта.
    expect(byUrl).toContain("https://a.example.test/v1/orders/1");
    expect(byUrl).toContain("https://b.example.test/v1/orders/2");
  });

  it("канарейка аккаунта вне тенантов идёт на общий адрес", async () => {
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

  it("без объявленных адресов всё уходит на общий, как раньше", async () => {
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
   * Канарейка на разнесённой платформе обязана стучаться на хост своего бренда:
   * обращение к общему адресу дало бы отказ, и прогон остановился бы ложной
   * тревогой «токен не работает».
   */
  it("канарейка идёт на хост своего бренда", async () => {
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

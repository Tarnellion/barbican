/**
 * Тесты прогона.
 *
 * Ядро сравнивает намерение с наблюдениями, но сами наблюдения рождаются здесь —
 * и ошибка в сведении статуса к выводу о доступе исказит весь отчёт.
 */

import { describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/adapters/ports.js";
import type { Account, Endpoint } from "../src/core/index.js";
import { classifyStatus, collectObservations } from "../src/runner.js";

const accounts: readonly Account[] = [
  { id: "player-a", roleId: "player", tenantId: "tenant-a" },
  { id: "admin-a", roleId: "admin", tenantId: "tenant-a" },
];

function fakeClient(reply: (request: HttpRequest) => HttpResponse | Error): {
  client: HttpClient;
  seen: HttpRequest[];
} {
  const seen: HttpRequest[] = [];
  return {
    seen,
    client: {
      send(request) {
        seen.push(request);
        const result = reply(request);
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    },
  };
}

describe("classifyStatus", () => {
  it("считает доступом только 2xx", () => {
    expect(classifyStatus(200)).toBe("allowed");
    expect(classifyStatus(204)).toBe("allowed");
    expect(classifyStatus(299)).toBe("allowed");
  });

  it("считает отказом только 401 и 403", () => {
    expect(classifyStatus(401)).toBe("denied");
    expect(classifyStatus(403)).toBe("denied");
  });

  it("выделяет 404 отдельно", () => {
    expect(classifyStatus(404)).toBe("not-found");
  });

  // Записать неоднозначный ответ как отказ — значит выдать отсутствие вывода
  // за доказательство защищённости.
  it("не делает вывода о доступе из прочих статусов", () => {
    for (const status of [301, 302, 400, 405, 429, 500, 503]) {
      expect(classifyStatus(status)).toBe("error");
    }
  });
});

describe("collectObservations", () => {
  const endpoints: readonly Endpoint[] = [
    { id: "users.list", method: "GET", path: "/v1/admin/users" },
    { id: "tickets.list", method: "GET", path: "/v1/support/tickets" },
  ];

  it("опрашивает каждую пару «аккаунт × эндпоинт»", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts,
      tokens: new Map([
        ["player-a", "токен-игрока"],
        ["admin-a", "токен-админа"],
      ]),
      client,
    });

    expect(result.observations).toHaveLength(4);
    expect(seen).toHaveLength(4);
    expect(seen.map((r) => r.url)).toEqual([
      "https://api.test/v1/admin/users",
      "https://api.test/v1/support/tickets",
      "https://api.test/v1/admin/users",
      "https://api.test/v1/support/tickets",
    ]);
  });

  it("подставляет токен того аккаунта, от имени которого обращается", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [endpoints[0] ?? { id: "x", method: "GET", path: "/x" }],
      accounts,
      tokens: new Map([
        ["player-a", "токен-игрока"],
        ["admin-a", "токен-админа"],
      ]),
      client,
    });

    expect(seen[0]?.headers["authorization"]).toBe("Bearer токен-игрока");
    expect(seen[1]?.headers["authorization"]).toBe("Bearer токен-админа");
  });

  it("пропускает эндпоинты с параметрами в пути и сообщает об этом", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [
        { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
        { id: "users.list", method: "GET", path: "/v1/admin/users" },
      ],
      accounts: [accounts[0] ?? { id: "x", roleId: "r", tenantId: "t" }],
      tokens: new Map([["player-a", "t"]]),
      client,
    });

    // Непроверенное не должно выглядеть как проверенное.
    expect(result.skipped).toEqual([{ endpointId: "profile.read", reason: "path-parameters" }]);
    expect(result.observations).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("записывает сорванное обращение как отсутствие вывода, а не как отказ", async () => {
    const { client } = fakeClient(() => new Error("соединение разорвано"));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [endpoints[0] ?? { id: "x", method: "GET", path: "/x" }],
      accounts: [accounts[0] ?? { id: "x", roleId: "r", tenantId: "t" }],
      tokens: new Map([["player-a", "t"]]),
      client,
    });

    expect(result.observations[0]?.outcome).toBe("error");
    expect(result.observations[0]?.status).toBe(0);
  });

  it("не кладёт токен в наблюдения", async () => {
    const { client } = fakeClient(() => ({
      status: 200,
      headers: { "set-cookie": "[REDACTED]" },
    }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts,
      tokens: new Map([
        ["player-a", "секретный-токен-игрока"],
        ["admin-a", "секретный-токен-админа"],
      ]),
      client,
    });

    expect(JSON.stringify(result)).not.toContain("секретный-токен");
  });

  it("собирает корректный URL независимо от косых черт", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test/base/",
      endpoints: [{ id: "x", method: "GET", path: "/v1/x" }],
      accounts: [accounts[0] ?? { id: "x", roleId: "r", tenantId: "t" }],
      tokens: new Map([["player-a", "t"]]),
      client,
    });

    expect(seen[0]?.url).toBe("https://api.test/base/v1/x");
  });
});

describe("что инструмент не трогает", () => {
  const endpoints: readonly Endpoint[] = [
    { id: "users.list", method: "GET", path: "/v1/users" },
    { id: "users.create", method: "POST", path: "/v1/users" },
    { id: "db.reset", method: "GET", path: "/createdb" },
  ];
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];

  it("не считает отказ от небезопасного метода сбоем", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: one,
      tokens: new Map([["a", "tok"]]),
      client,
    });

    // Штатная работа инструмента не должна выглядеть поломкой в отчёте.
    expect(result.failures).toEqual([]);
    expect(result.skipped).toContainEqual({ endpointId: "users.create", reason: "unsafe-method" });
    expect(seen.map((r) => r.method)).not.toContain("POST");
  });

  it("опрашивает небезопасный метод при явном разрешении", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: one,
      tokens: new Map([["a", "tok"]]),
      client,
      allowUnsafeMethods: true,
    });

    expect(seen.map((r) => r.method)).toContain("POST");
  });

  it("не трогает исключённый эндпоинт даже безопасным методом", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: one,
      tokens: new Map([["a", "tok"]]),
      client,
      exclude: ["db.reset"],
    });

    // GET не обязан быть безопасным на деле: /createdb сбрасывает базу.
    expect(result.skipped).toContainEqual({ endpointId: "db.reset", reason: "excluded" });
    expect(seen.map((r) => r.url)).not.toContain("https://api.test/createdb");
  });
});

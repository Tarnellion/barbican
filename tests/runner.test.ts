/**
 * Тесты прогона.
 *
 * Ядро сравнивает намерение с наблюдениями, но сами наблюдения рождаются здесь —
 * и ошибка в сведении статуса к выводу о доступе исказит весь отчёт.
 */

import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../src/adapters/credentials.js";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/adapters/ports.js";
import type { Account, Endpoint } from "../src/core/index.js";
import {
  classifyStatus,
  collectObservations,
  ExcludedCanaryError,
  probeCanaries,
  TemplatedCanaryError,
  UnknownCanaryEndpointError,
} from "../src/runner.js";

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
      credentials: createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        new Map([
          ["player-a", "токен-игрока"],
          ["admin-a", "токен-админа"],
        ]),
      ),
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
      credentials: createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        new Map([
          ["player-a", "токен-игрока"],
          ["admin-a", "токен-админа"],
        ]),
      ),
      client,
    });

    expect(seen[0]?.headers.authorization).toBe("Bearer токен-игрока");
    expect(seen[1]?.headers.authorization).toBe("Bearer токен-админа");
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
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["player-a", "t"]])),
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
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["player-a", "t"]])),
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
      credentials: createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        new Map([
          ["player-a", "секретный-токен-игрока"],
          ["admin-a", "секретный-токен-админа"],
        ]),
      ),
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
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["player-a", "t"]])),
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
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]])),
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
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]])),
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
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]])),
      client,
      exclude: ["db.reset"],
    });

    // GET не обязан быть безопасным на деле: /createdb сбрасывает базу.
    expect(result.skipped).toContainEqual({ endpointId: "db.reset", reason: "excluded" });
    expect(seen.map((r) => r.url)).not.toContain("https://api.test/createdb");
  });
});

describe("предохранители против недостоверного прогона", () => {
  const endpoints: readonly Endpoint[] = [
    { id: "me", method: "GET", path: "/v1/me" },
    { id: "users.list", method: "GET", path: "/v1/users" },
    { id: "profile", method: "GET", path: "/v1/players/{id}" },
  ];
  const two: readonly Account[] = [
    { id: "a", roleId: "player", tenantId: "t" },
    { id: "b", roleId: "admin", tenantId: "t" },
  ];
  const credentials = createCredentialProvider(
    DEFAULT_AUTH_SCHEME,
    new Map([
      ["a", "tok-a"],
      ["b", "tok-b"],
    ]),
  );

  it("сообщает, что аккаунт не аутентифицирован, когда канарейка отвечает отказом", async () => {
    const { client } = fakeClient((request) => ({
      status: request.headers.authorization === "Bearer tok-a" ? 401 : 200,
      headers: {},
    }));

    const results = await probeCanaries({
      baseUrl: "https://api.test",
      endpoints,
      canaries: [
        { accountId: "a", endpointId: "me" },
        { accountId: "b", endpointId: "me" },
      ],
      credentials,
      client,
    });

    expect(results).toEqual([
      { accountId: "a", endpointId: "me", status: 401, authenticated: false },
      { accountId: "b", endpointId: "me", status: 200, authenticated: true },
    ]);
  });

  it("отвергает канарейку на неизвестный эндпоинт", async () => {
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));

    await expect(
      probeCanaries({
        baseUrl: "https://api.test",
        endpoints,
        canaries: [{ accountId: "a", endpointId: "нет-такого" }],
        credentials,
        client,
      }),
    ).rejects.toThrow(UnknownCanaryEndpointError);
  });

  // Список исключений заводится ровно для адресов, которые трогать нельзя —
  // GET, сбрасывающий базу. Канарейка не должна быть лазейкой мимо него.
  it("отвергает канарейку на исключённый эндпоинт", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await expect(
      probeCanaries({
        baseUrl: "https://api.test",
        endpoints,
        canaries: [{ accountId: "a", endpointId: "me" }],
        credentials,
        client,
        exclude: ["me"],
      }),
    ).rejects.toThrow(ExcludedCanaryError);
    expect(seen).toEqual([]);
  });

  it("отвергает канарейку на эндпоинт с параметром в пути", async () => {
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));

    await expect(
      probeCanaries({
        baseUrl: "https://api.test",
        endpoints,
        canaries: [{ accountId: "a", endpointId: "profile" }],
        credentials,
        client,
      }),
    ).rejects.toThrow(TemplatedCanaryError);
  });

  it("возвращает список реально опрошенных эндпоинтов", async () => {
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints,
      accounts: [two[0] ?? { id: "a", roleId: "r", tenantId: "t" }],
      credentials,
      client,
    });

    // profile пропущен из-за параметра в пути и в матрицу попасть не должен.
    expect(result.probed.map((e) => e.id)).toEqual(["me", "users.list"]);
  });
});

// Найдено состязательной проверкой: `new URL(path, base)` отдаёт приоритет
// абсолютному адресу, поэтому путь из спецификации перебивал базовый URL целиком.
// Имя хоста при этом не менялось, и allowlist пропускал — токен уходил открытым
// текстом на порт, заданный проверяемой системой.
describe("путь из спецификации не управляет адресом", () => {
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "секрет"]]));

  async function probe(path: string) {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));
    const result = await collectObservations({
      baseUrl: "https://api.example.test/v1",
      endpoints: [{ id: "e", method: "GET", path }],
      accounts: one,
      credentials,
      client,
    });
    return { seen, result };
  }

  it("отвергает абсолютный адрес с чужой схемой и портом", async () => {
    const { seen, result } = await probe("http://api.example.test:9999/exfil");

    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "e", reason: "escapes-target" }]);
  });

  it("отвергает абсолютный адрес на другой хост", async () => {
    const { seen, result } = await probe("https://evil.test/x");

    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "e", reason: "escapes-target" }]);
  });

  it("не даёт обратному слэшу увести на чужой хост", async () => {
    const { seen } = await probe("/\\evil.test/x");

    // Обходной путь через обратный слэш остаётся внутри цели.
    expect(seen[0]?.url).toBe("https://api.example.test/v1/evil.test/x");
  });

  it("обычный путь собирается как прежде", async () => {
    const { seen } = await probe("/users");

    expect(seen[0]?.url).toBe("https://api.example.test/v1/users");
  });
});

describe("обращение к объектам", () => {
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));
  const profile: Endpoint = { id: "profile", method: "GET", path: "/v1/players/{playerId}" };

  it("подставляет значения объекта в путь и опрашивает каждый по разу", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      resources: [
        { id: "r1", tenantId: "t", params: { playerId: "1001" } },
        { id: "r2", tenantId: "t", params: { playerId: "2002" } },
      ],
    });

    expect(seen.map((r) => r.url)).toEqual([
      "https://api.test/v1/players/1001",
      "https://api.test/v1/players/2002",
    ]);
    expect(result.observations.map((o) => o.resourceId)).toEqual(["r1", "r2"]);
  });

  it("кодирует значение, а не вставляет как есть", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      // Иначе значение с косой чертой сместило бы путь на другой ресурс.
      resources: [{ id: "r", tenantId: "t", params: { playerId: "../admin" } }],
    });

    expect(seen[0]?.url).toBe("https://api.test/v1/players/..%2Fadmin");
  });

  it("добавляет параметры строки запроса", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "report", method: "GET", path: "/v1/report" }],
      accounts: one,
      credentials,
      client,
      // Найдено разведкой crAPI: идентификатор бывает в query, а не в пути.
      // У такого эндпоинта нет параметров в шаблоне, поэтому привязка явная.
      resources: [
        { id: "r", tenantId: "t", params: {}, query: { report_id: "1" }, endpointIds: ["report"] },
      ],
    });

    expect(seen[0]?.url).toBe("https://api.test/v1/report?report_id=1");
  });

  it("пропускает параметризованный эндпоинт, если объектов с такими параметрами нет", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "other", tenantId: "t", params: { orderId: "7" } }],
    });

    expect(result.skipped).toEqual([{ endpointId: "profile", reason: "path-parameters" }]);
    expect(seen).toEqual([]);
  });

  it("не привязывает объект к эндпоинту без параметров", async () => {
    const { client } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "ping", method: "GET", path: "/ping" }],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { playerId: "1" } }],
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.resourceId).toBeUndefined();
  });
});

describe("значение объекта не уводит обращение", () => {
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));
  const profile: Endpoint = { id: "p", method: "GET", path: "/v1/players/{playerId}" };

  async function probeWith(params: Record<string, string>) {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));
    const result = await collectObservations({
      baseUrl: "https://api.test/api",
      endpoints: [profile],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params }],
    });
    return { seen, result };
  }

  // Механизм тоньше, чем кажется: encodeURIComponent кодирует слэш, но НЕ точки,
  // поэтому одиночный `..` поднимает ровно на уровень вверх. Если параметр стоит
  // в начале пути, этого хватает, чтобы выйти за объявленный базовый путь.
  // Проверка области делалась над шаблоном, до подстановки, и этого не видела.
  it("не даёт значению с .. выйти за базовый путь", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test/api",
      endpoints: [{ id: "p", method: "GET", path: "/{playerId}/orders" }],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { playerId: ".." } }],
    });

    expect(seen).toEqual([]);
    expect(result.failures[0]?.reason).toContain("уводит обращение");
  });

  it("слэш в значении кодируется и обхода не даёт", async () => {
    const { seen } = await probeWith({ playerId: "../.." });

    expect(seen[0]?.url).toBe("https://api.test/api/v1/players/..%2F..");
  });

  it("кодирует обычное значение и остаётся внутри базового пути", async () => {
    const { seen } = await probeWith({ playerId: "1001" });

    expect(seen[0]?.url).toBe("https://api.test/api/v1/players/1001");
  });

  // Имена параметров берутся из недоверенной спецификации, а прототип
  // отвечает на {constructor} у любого объекта.
  it("не цепляет объект по имени из цепочки прототипов", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "x", method: "GET", path: "/v1/x/{constructor}" }],
      accounts: one,
      credentials,
      client,
      resources: [{ id: "r", tenantId: "t", params: { playerId: "1001" } }],
    });

    expect(seen).toEqual([]);
    expect(result.skipped).toEqual([{ endpointId: "x", reason: "path-parameters" }]);
  });
});

describe("объект с параметрами, которых нет у эндпоинта", () => {
  it("подставляет пустую строку для имени, которого нет в объекте", async () => {
    const { client, seen } = fakeClient(() => ({ status: 200, headers: {} }));

    // Объект привязан явным списком, но покрывает не все параметры пути:
    // недостающее имя даёт пустой сегмент, а не мусор из прототипа.
    await collectObservations({
      baseUrl: "https://api.test",
      endpoints: [{ id: "p", method: "GET", path: "/v1/{a}/{b}" }],
      accounts: [{ id: "a", roleId: "r", tenantId: "t" }],
      credentials: createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]])),
      client,
      resources: [{ id: "r", tenantId: "t", params: { a: "1", b: "2" }, endpointIds: ["p"] }],
    });

    expect(seen[0]?.url).toBe("https://api.test/v1/1/2");
  });
});

describe("обрыв прогона", () => {
  const one: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
  const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "tok"]]));
  const two: readonly Endpoint[] = [
    { id: "e1", method: "GET", path: "/1" },
    { id: "e2", method: "GET", path: "/2" },
  ];

  // Исчерпанный потолок обращений обрывает обход посреди матрицы: хвост
  // не проверен, и без этого признака вердикт «чисто» неотличим от настоящего.
  it("помечается признаком при исчерпании бюджета", async () => {
    const budget = Object.assign(new Error("бюджет исчерпан"), {
      name: "RunBudgetExhaustedError",
    });
    let call = 0;
    const { client } = fakeClient(() => {
      call += 1;
      return call === 1 ? { status: 200, headers: {} } : budget;
    });

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: two,
      accounts: one,
      credentials,
      client,
    });

    expect(result.truncated).toBe(true);
  });

  it("не помечается при обычном сбое обращения", async () => {
    const { client } = fakeClient(() => new Error("соединение разорвано"));

    const result = await collectObservations({
      baseUrl: "https://api.test",
      endpoints: two,
      accounts: one,
      credentials,
      client,
    });

    expect(result.truncated).toBe(false);
  });

  it("канарейка не падает, когда обращение сорвалось", async () => {
    const { client } = fakeClient(() => new Error("стенд не отвечает"));

    const results = await probeCanaries({
      baseUrl: "https://api.test",
      endpoints: two,
      canaries: [{ accountId: "a", endpointId: "e1" }],
      credentials,
      client,
    });

    expect(results[0]).toEqual({
      accountId: "a",
      endpointId: "e1",
      status: 0,
      authenticated: false,
    });
  });
});

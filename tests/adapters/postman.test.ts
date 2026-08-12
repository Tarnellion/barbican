/**
 * Тесты разбора коллекции Postman.
 *
 * Проверяется поведение: какие эндпоинты получились, какой у них путь и что
 * именно отвергнуто, — а не то, что «функция вызвалась». Отдельно доказывается,
 * что адаптер не ходит ни в файловую систему, ни в сеть: путь к существующему
 * файлу для него обычный текст, а поднятый на время теста http-сервер не
 * получает ни одного запроса, хотя его адрес стоит в коллекции.
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

const parser = createPostmanCollectionParser();

const V21_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/** Запрос в форме, в которой его экспортирует Postman. */
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
  info: { name: "Платформа", schema: V21_SCHEMA },
  item: [
    { name: "Здоровье", request: request("GET", ["healthz"]) },
    {
      name: "Игроки",
      item: [
        { name: "Список", request: request("GET", ["v1", "players"]) },
        { name: "Карточка", request: request("GET", ["v1", "players", "{{playerId}}"]) },
        {
          name: "Кошелёк",
          item: [
            { name: "Баланс", request: request("GET", ["v1", "players", ":playerId", "wallet"]) },
          ],
        },
      ],
    },
    {
      name: "Админка",
      item: [{ name: "Список", request: request("DELETE", ["v1", "admin", "users"]) }],
    },
  ],
});

describe("разбор корректной коллекции", () => {
  it("обходит папки вглубь и сохраняет порядок объявления", async () => {
    const endpoints = await parser.parse(COLLECTION);

    expect(endpoints).toEqual([
      { id: "Здоровье", method: "GET", path: "/healthz" },
      { id: "Игроки/Список", method: "GET", path: "/v1/players" },
      { id: "Игроки/Карточка", method: "GET", path: "/v1/players/{playerId}" },
      { id: "Игроки/Кошелёк/Баланс", method: "GET", path: "/v1/players/{playerId}/wallet" },
      { id: "Админка/Список", method: "DELETE", path: "/v1/admin/users" },
    ]);
  });

  // Одноимённые запросы в разных папках — обычное дело для коллекции, а для
  // политики доступа это два разных эндпоинта.
  it("различает одноимённые запросы по папке, а не сливает их", async () => {
    const endpoints = await parser.parse(COLLECTION);
    const duplicates = endpoints.filter((endpoint) => endpoint.id.endsWith("/Список"));

    expect(duplicates.map((endpoint) => endpoint.id)).toEqual(["Игроки/Список", "Админка/Список"]);
  });

  it("не добавляет operationId: в коллекции его нет", async () => {
    const [endpoint] = await parser.parse(COLLECTION);

    expect(endpoint).toBeDefined();
    expect(Object.keys(endpoint ?? {})).toEqual(["id", "method", "path"]);
  });

  it("принимает все методы домена и приводит регистр к верхнему", async () => {
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

  it("принимает коллекцию без info: schema необязательна", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Пинг", request: request("GET", ["ping"]) }],
    });

    await expect(parser.parse(collection)).resolves.toEqual([
      { id: "Пинг", method: "GET", path: "/ping" },
    ]);
  });

  it("принимает info без schema и info не-объектом", async () => {
    const item = [{ name: "Пинг", request: request("GET", ["ping"]) }];

    await expect(parser.parse(JSON.stringify({ info: { name: "x" }, item }))).resolves.toHaveLength(
      1,
    );
    await expect(parser.parse(JSON.stringify({ info: "строка", item }))).resolves.toHaveLength(1);
  });

  it("принимает схему v2.0 наравне с v2.1", async () => {
    const collection = JSON.stringify({
      info: {
        name: "x",
        schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json",
      },
      item: [{ name: "Пинг", request: request("GET", ["ping"]) }],
    });

    await expect(parser.parse(collection)).resolves.toHaveLength(1);
  });

  it("игнорирует поля, написанные для Postman, а не для нас", async () => {
    const collection = JSON.stringify({
      info: { name: "x", schema: V21_SCHEMA, _postman_id: "abc" },
      variable: [{ key: "baseUrl", value: "https://api.example.test" }],
      event: [{ listen: "prerequest", script: { exec: ["pm.test()"] } }],
      item: [
        {
          name: "Пинг",
          protocolProfileBehavior: { disableBodyPruning: true },
          response: [{ name: "200", code: 200 }],
          request: {
            method: "GET",
            header: [{ key: "accept", value: "application/json" }],
            body: { mode: "raw", raw: "{}" },
            auth: { type: "bearer" },
            description: "проверка живости",
            url: { raw: "{{baseUrl}}/ping", host: ["{{baseUrl}}"], path: ["ping"] },
          },
        },
      ],
    });

    await expect(parser.parse(collection)).resolves.toEqual([
      { id: "Пинг", method: "GET", path: "/ping" },
    ]);
  });

  it("обрезает пробелы в именах: id не должен зависеть от них", async () => {
    const collection = JSON.stringify({
      item: [{ name: "  Папка  ", item: [{ name: " Пинг ", request: request("GET", ["ping"]) }] }],
    });

    await expect(parser.parse(collection)).resolves.toEqual([
      { id: "Папка/Пинг", method: "GET", path: "/ping" },
    ]);
  });
});

describe("переменные Postman в пути", () => {
  // Ядро вычленяет параметры выражением /\{([^}]+)\}/: на `{{playerId}}` оно
  // дало бы параметр с именем `{playerId`, которого автор не писал и который
  // не покроет ни один объявленный объект.
  it("сводит {{playerId}} к параметру {playerId}", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Карточка", request: request("GET", ["v1", "players", "{{playerId}}"]) }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players/{playerId}");
  });

  it("сводит родную постмановскую запись :playerId к {playerId}", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Карточка", request: request("GET", ["v1", "players", ":playerId"]) }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players/{playerId}");
  });

  // Проверяется именно результат для ядра: параметр обязан вычленяться тем же
  // выражением, которым его ищут прогон и дифф.
  it("даёт параметр, который вычленяется правилом ядра", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "Ставка",
          request: request("GET", ["v1", "{{tenantId}}", "bets", ":betId"]),
        },
      ],
    });

    const [endpoint] = await parser.parse(collection);
    const names = [...(endpoint?.path ?? "").matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);

    expect(names).toEqual(["tenantId", "betId"]);
  });

  it("принимает уже готовую запись {playerId}", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Карточка", request: request("GET", ["v1", "players", "{playerId}"]) }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players/{playerId}");
  });

  it("оставляет литералом сегмент с двоеточием, не похожий на имя", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Действие", request: request("POST", ["v1", "orders:cancel", ":", ":a+b"]) }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/orders:cancel/:/:a+b");
  });

  it("отвергает переменную с именем, которое не является именем параметра", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Карточка", request: request("GET", ["v1", "{{ player id }}"]) }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/незакрытую или пустую фигурную скобку/);
  });

  it("отвергает незакрытую фигурную скобку", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Карточка", request: request("GET", ["v1", "{playerId"]) }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({
      name: "InvalidPostmanItemError",
      location: "Карточка",
      field: "path",
    });
  });

  it("отвергает пустую пару скобок", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Карточка", request: request("GET", ["v1", "{}"]) }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(InvalidPostmanItemError);
  });
});

describe("путь берётся из url", () => {
  it("предпочитает path сырому адресу", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "Список",
          request: {
            method: "GET",
            url: { raw: "{{baseUrl}}/устарело?x=1", path: ["v1", "players"] },
          },
        },
      ],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players");
  });

  it("берёт raw, когда path пуст", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "Список",
          request: { method: "GET", url: { raw: "{{baseUrl}}/v1/players", path: [] } },
        },
      ],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players");
  });

  it("принимает path строкой и дополняет ведущий слэш", async () => {
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

  it("берёт raw, когда path — пробельная строка", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "a", request: { method: "GET", url: { path: "   ", raw: "{{baseUrl}}/v1/a" } } },
      ],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/a");
  });

  it("принимает url целиком строкой", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Список", request: { method: "GET", url: "{{baseUrl}}/v1/players?page=2" } }],
    });

    const [endpoint] = await parser.parse(collection);

    expect(endpoint?.path).toBe("/v1/players");
  });

  it("отбрасывает строку запроса и фрагмент", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "q", request: { method: "GET", url: { raw: "{{baseUrl}}/v1/a?b=1&c=2" } } },
        { name: "f", request: { method: "GET", url: { raw: "{{baseUrl}}/v1/b#часть" } } },
      ],
    });

    const endpoints = await parser.parse(collection);

    expect(endpoints.map((endpoint) => endpoint.path)).toEqual(["/v1/a", "/v1/b"]);
  });

  it("считает адрес без пути обращением к корню", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "var", request: { method: "GET", url: { raw: "{{baseUrl}}" } } },
        { name: "host", request: { method: "GET", url: { raw: "https://api.example.test" } } },
      ],
    });

    const endpoints = await parser.parse(collection);

    expect(endpoints.map((endpoint) => endpoint.path)).toEqual(["/", "/"]);
  });

  it("отвергает адрес, из которого путь не выделяется", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Список", request: { method: "GET", url: { raw: "api.example.test/v1/a" } } }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({
      name: "InvalidPostmanItemError",
      field: "url",
    });
  });

  it("отвергает пустой url-строку", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Список", request: { method: "GET", url: "   " } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/"request.url" пуст/);
  });

  it("отвергает url, не являющийся ни строкой, ни объектом", async () => {
    const missing = JSON.stringify({ item: [{ name: "a", request: { method: "GET" } }] });
    const numeric = JSON.stringify({ item: [{ name: "b", request: { method: "GET", url: 42 } }] });

    await expect(parser.parse(missing)).rejects.toMatchObject({ field: "url" });
    await expect(parser.parse(numeric)).rejects.toMatchObject({ field: "url" });
  });

  it("отвергает url без path и без raw", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { host: ["{{baseUrl}}"] } } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/ни непустого "path", ни "raw"/);
  });

  it("отвергает сегмент пути, не являющийся строкой", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["v1", { value: "x" }] } } }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({ field: "path" });
  });
});

describe("хост из коллекции не влияет на адресата", () => {
  // Куда идут обращения, решают базовый URL прогона и allowlist. Абсолютный
  // адрес в коллекции сводится к пути, и имени хоста в эндпоинте не остаётся.
  it("отбрасывает схему и хост, оставляя путь", async () => {
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

  // `//host/x` при склейке с базой адресовал бы чужой хост, а не путь
  // на проверяемом: область проверки не должна расширяться формой записи.
  it("отвергает схемо-относительный URL, собранный из сегментов", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["", "evil.test", "x"] } } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/адресует другой хост/);
  });

  // Такой путь начинается со слэша и мимо простой проверки проходит, но
  // `new URL` отдаёт приоритет абсолютному адресу — ровно тот пробой, который
  // состязательная проверка нашла в прогоне (ADR-0005).
  it("отвергает путь, который сам является абсолютным адресом", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "a", request: { method: "GET", url: { path: ["https:", "", "evil.test", "x"] } } },
      ],
    });

    const attempt = parser.parse(collection);

    await expect(attempt).rejects.toMatchObject({ field: "path" });
    await expect(attempt).rejects.toThrow(/адресует https:\/\/evil\.test/);
  });

  it("отвергает путь, который не разбирается как адрес", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["https:", "", "["] } } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/не удалось разобрать как адрес/);
  });

  // Следствие того, что проверка повторяет правило прогона: прогон убирает
  // ведущий слэш перед склейкой, и `orders:` в первом сегменте становится
  // схемой. Такой эндпоинт прогон всё равно не выполнит — он попал бы в
  // пропуски с причиной `escapes-target`, — поэтому отказ здесь честнее.
  // Двоеточие в любом другом сегменте безвредно.
  it("отвергает двоеточие в первом сегменте, но не в остальных", async () => {
    const first = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["orders:cancel"] } } }],
    });
    const later = JSON.stringify({
      item: [{ name: "b", request: { method: "GET", url: { path: ["v1", "orders:cancel"] } } }],
    });

    await expect(parser.parse(first)).rejects.toThrow(/адресует null/);
    await expect(parser.parse(later)).resolves.toEqual([
      { id: "b", method: "GET", path: "/v1/orders:cancel" },
    ]);
  });
});

describe("документ не той формы", () => {
  it("отвергает пустой вход", async () => {
    await expect(parser.parse("")).rejects.toThrow(PostmanCollectionParseError);
  });

  it("отвергает скаляр вместо документа", async () => {
    await expect(parser.parse("просто строка")).rejects.toThrow(PostmanCollectionParseError);
  });

  it("отвергает неразбираемый документ", async () => {
    await expect(parser.parse('{ "item": [')).rejects.toThrow(PostmanCollectionParseError);
  });

  it("отвергает документ без ключа item", async () => {
    await expect(parser.parse(JSON.stringify({ info: { name: "x" } }))).rejects.toThrow(
      /"item" отсутствует или не является списком/,
    );
  });

  it("отвергает item, не являющийся списком", async () => {
    await expect(parser.parse(JSON.stringify({ item: { name: "x" } }))).rejects.toThrow(
      PostmanCollectionParseError,
    );
  });

  // Формат v1 описывает запросы иначе: прочитать его как v2 значит прочитать
  // неверно, а не прочитать частично.
  it("отвергает схему v1 отдельной ошибкой", async () => {
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

  it("отвергает коллекцию без запросов отдельной ошибкой", async () => {
    await expect(parser.parse(JSON.stringify({ item: [] }))).rejects.toThrow(
      EmptyPostmanCollectionError,
    );
  });

  it("отвергает коллекцию из одних пустых папок", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Папка", item: [{ name: "Вложенная", item: [] }] }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(EmptyPostmanCollectionError);
  });
});

describe("элемент коллекции не проходит проверку", () => {
  it("отвергает элемент, не являющийся объектом", async () => {
    await expect(parser.parse(JSON.stringify({ item: ["/v1/users"] }))).rejects.toMatchObject({
      name: "InvalidPostmanItemError",
      location: "<корень коллекции>",
      field: "item",
    });
  });

  it("отвергает элемент без имени", async () => {
    const missing = JSON.stringify({ item: [{ request: request("GET", ["a"]) }] });
    const blank = JSON.stringify({ item: [{ name: "  ", request: request("GET", ["a"]) }] });
    const numeric = JSON.stringify({ item: [{ name: 42, request: request("GET", ["a"]) }] });

    for (const collection of [missing, blank, numeric]) {
      await expect(parser.parse(collection)).rejects.toMatchObject({ field: "name" });
    }
  });

  // Молча пропущенный элемент — это непроверенный эндпоинт в отчёте, который
  // читается как «нарушений нет».
  it("отвергает элемент, который не папка и не запрос", async () => {
    const collection = JSON.stringify({ item: [{ name: "Ни то ни сё", description: "х" }] });

    await expect(parser.parse(collection)).rejects.toMatchObject({
      location: "Ни то ни сё",
      field: "request",
    });
  });

  it("отвергает элемент, который одновременно папка и запрос", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Оба", item: [], request: request("GET", ["a"]) }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/папка это или запрос/);
  });

  it("отвергает папку, у которой item не список", async () => {
    const collection = JSON.stringify({ item: [{ name: "Папка", item: { name: "x" } }] });

    await expect(parser.parse(collection)).rejects.toThrow(/"item" должен быть списком/);
  });

  // Сокращённая запись `"request": "https://..."` означала бы GET по умолчанию;
  // догадка о методе решает за автора, что именно проверяется.
  it("отвергает сокращённую запись запроса строкой", async () => {
    const collection = JSON.stringify({
      item: [{ name: "Кратко", request: "https://api.example.test/v1/a" }],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({ field: "request" });
  });

  it("отвергает отсутствующий и нестроковый метод", async () => {
    const missing = JSON.stringify({ item: [{ name: "a", request: { url: "{{baseUrl}}/a" } }] });
    const numeric = JSON.stringify({
      item: [{ name: "b", request: { method: 200, url: "{{baseUrl}}/a" } }],
    });

    await expect(parser.parse(missing)).rejects.toMatchObject({ field: "method" });
    await expect(parser.parse(numeric)).rejects.toMatchObject({ field: "method" });
  });

  it("отвергает метод вне набора HttpMethod", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: request("TRACE", ["a"]) }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(/метод "TRACE" не поддерживается/);
  });

  it("называет папку, в которой лежит сбойный элемент", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "Ок", request: request("GET", ["ok"]) },
        {
          name: "Админка",
          item: [
            { name: "Тоже ок", request: request("GET", ["fine"]) },
            { name: "Сбой", request: request("WAT", ["broken"]) },
          ],
        },
      ],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({
      location: "Админка/Сбой",
      field: "method",
    });
  });
});

describe("уникальность идентификаторов", () => {
  it("отвергает два запроса с одним именем в одной папке", async () => {
    const collection = JSON.stringify({
      item: [
        {
          name: "Игроки",
          item: [
            { name: "Список", request: request("GET", ["v1", "players"]) },
            { name: "Список", request: request("HEAD", ["v1", "players"]) },
          ],
        },
      ],
    });

    const attempt = parser.parse(collection);

    await expect(attempt).rejects.toThrow(DuplicatePostmanEndpointIdError);
    await expect(attempt).rejects.toMatchObject({ id: "Игроки/Список" });
  });

  it("отвергает совпадение id, собранное из разных папок", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "a", item: [{ name: "b/c", request: request("GET", ["x"]) }] },
        { name: "a/b", item: [{ name: "c", request: request("GET", ["y"]) }] },
      ],
    });

    await expect(parser.parse(collection)).rejects.toMatchObject({ id: "a/b/c" });
  });

  it("различает id по регистру: это разные эндпоинты", async () => {
    const collection = JSON.stringify({
      item: [
        { name: "Список", request: request("GET", ["v1", "players"]) },
        { name: "список", request: request("GET", ["v1", "Players"]) },
      ],
    });

    await expect(parser.parse(collection)).resolves.toHaveLength(2);
  });
});

describe("пределы на вход", () => {
  it("отвергает YAML-бомбу до того, как она развернётся", async () => {
    const bomb = `
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
item: [*d,*d,*d,*d,*d,*d,*d,*d,*d]
`;

    await expect(parser.parse(bomb)).rejects.toThrow(PostmanCollectionParseError);
  });

  it("считает алиасы по своему пределу, а не по чужому", async () => {
    const strict = createPostmanCollectionParser({ maxAliasCount: 1 });
    const collection = `
item:
  - &first { name: a, request: { method: GET, url: "{{baseUrl}}/a" } }
  - *first
  - *first
`;

    await expect(strict.parse(collection)).rejects.toThrow(PostmanCollectionParseError);
  });

  it("отвергает документ больше предела и называет фактический размер", async () => {
    const small = createPostmanCollectionParser({ maxBytes: 32 });

    const attempt = small.parse(COLLECTION);

    await expect(attempt).rejects.toThrow(PostmanCollectionTooLargeError);
    await expect(attempt).rejects.toThrow(
      new RegExp(`${Buffer.byteLength(COLLECTION, "utf8")} байт при пределе 32`),
    );
  });

  it("измеряет размер в байтах, а не в символах", async () => {
    // Кириллица в UTF-8 занимает два байта на символ: предел, заданный
    // в байтах, нельзя проверять длиной строки.
    const limited = createPostmanCollectionParser({ maxBytes: 20 });

    await expect(limited.parse("«".repeat(11))).rejects.toThrow(PostmanCollectionTooLargeError);
  });

  it("пропускает документ ровно на пределе", async () => {
    const source = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: "{{baseUrl}}/a" } }],
    });
    const exact = createPostmanCollectionParser({ maxBytes: Buffer.byteLength(source, "utf8") });

    await expect(exact.parse(source)).resolves.toHaveLength(1);
  });

  it("отвергает вложенность папок глубже предела", async () => {
    let node: unknown = { name: "Запрос", request: request("GET", ["a"]) };
    for (let i = 0; i < DEFAULT_POSTMAN_LIMITS.maxFolderDepth + 5; i += 1) {
      node = { name: `Папка ${i}`, item: [node] };
    }

    await expect(parser.parse(JSON.stringify({ item: [node] }))).rejects.toThrow(
      PostmanCollectionTooDeepError,
    );
  });

  it("пропускает вложенность ровно на пределе", async () => {
    const shallow = createPostmanCollectionParser({ maxFolderDepth: 2 });
    const collection = JSON.stringify({
      item: [
        {
          name: "Внешняя",
          item: [
            { name: "Внутренняя", item: [{ name: "Запрос", request: request("GET", ["a"]) }] },
          ],
        },
      ],
    });

    await expect(shallow.parse(collection)).resolves.toEqual([
      { id: "Внешняя/Внутренняя/Запрос", method: "GET", path: "/a" },
    ]);
  });

  it("обрывает цикл, построенный YAML-якорями, а не зацикливается", async () => {
    // `&loop` ссылается сам на себя: обход по такой структуре без предела
    // глубины не завершился бы никогда.
    const cyclic = `
item:
  - &loop
    name: Папка
    item:
      - *loop
`;

    await expect(parser.parse(cyclic)).rejects.toThrow(PostmanCollectionTooDeepError);
  });
});

describe("парсер не обращается к файловой системе", () => {
  let directory = "";
  let collectionPath = "";
  const CANARY = "canary-9b41c-не-должно-утечь";

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

  // На вход подаётся текст документа, а не путь. Парсер, который умеет
  // открывать файлы, был бы примитивом path traversal.
  it("не читает файл, путь к которому подан как источник", async () => {
    const attempt = parser.parse(collectionPath);

    await expect(attempt).rejects.toThrow(PostmanCollectionParseError);
    await expect(
      attempt.catch((error: unknown) => JSON.stringify(error) + String(error)),
    ).resolves.not.toContain(CANARY);
  });

  it("не читает файл, путь к которому оказался в адресе запроса", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { raw: `file://${collectionPath}` } } }],
    });

    // Путь остаётся просто путём: содержимое файла в результат не подмешивается.
    const endpoints = await parser.parse(collection);

    expect(endpoints).toEqual([{ id: "a", method: "GET", path: collectionPath }]);
    expect(JSON.stringify(endpoints)).not.toContain(CANARY);
  });
});

describe("парсер не обращается в сеть", () => {
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
      throw new Error("не удалось поднять тестовый сервер");
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

  // Главное утверждение — не «выбросилась ошибка», а «наружу не ушло ничего».
  it("не выполняет ни одного запроса к адресам из коллекции", async () => {
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

  it("не ходит по адресу, даже если разбор оборвался ошибкой", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "WAT", url: { raw: `${baseUrl}/v1/a` } } }],
    });

    await expect(parser.parse(collection)).rejects.toThrow(InvalidPostmanItemError);
    expect(hits).toBe(0);
  });
});

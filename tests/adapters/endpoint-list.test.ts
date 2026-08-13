/**
 * Тесты разбора ручного списка эндпоинтов.
 *
 * Проверяется поведение: какие эндпоинты получились и что именно отвергнуто,
 * а не то, что «функция вызвалась». Отдельно доказывается, что парсер не
 * обращается к файловой системе: путь к существующему файлу для него —
 * обычный текст, а содержимое файла в результат не попадает.
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

describe("разбор корректного списка", () => {
  it("извлекает эндпоинты в порядке объявления", async () => {
    const endpoints = await parser.parse(MINIMAL_LIST);

    expect(endpoints).toEqual([
      { id: "users.list", method: "GET", path: "/v1/users" },
      { id: "tickets.list", method: "GET", path: "/v1/support/tickets" },
      { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
    ]);
  });

  // Шаблонные пути — норма для этого инструмента, а фигурная скобка в YAML
  // открывает flow-отображение. В блочном стиле она безопасна, в потоковом
  // её приходится закавычивать; тест фиксирует оба варианта, чтобы разница
  // не всплыла на чужом списке.
  it("принимает шаблонный путь в блочном стиле без кавычек", async () => {
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

  it("принимает JSON: он подмножество YAML", async () => {
    const json = JSON.stringify({
      endpoints: [{ id: "ping", method: "GET", path: "/ping" }],
    });

    await expect(parser.parse(json)).resolves.toEqual([
      { id: "ping", method: "GET", path: "/ping" },
    ]);
  });

  it("принимает все методы домена и приводит регистр к верхнему", async () => {
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

  it("не добавляет operationId: в ручном списке его нет", async () => {
    const [endpoint] = await parser.parse("endpoints: [{ id: a, method: GET, path: /a }]");

    expect(endpoint).toBeDefined();
    expect(Object.keys(endpoint ?? {})).toEqual(["id", "method", "path"]);
  });

  it("разворачивает алиасы: проверка идёт по раскрытому документу", async () => {
    const list = `
endpoints:
  - &first { id: a, method: GET, path: /a }
  - *first
`;

    // Алиас раскрыт, значит id повторился — и уникальность ловит это так же,
    // как повтор, набранный руками.
    await expect(parser.parse(list)).rejects.toThrow(DuplicateEndpointIdError);
  });
});

describe("документ не той формы", () => {
  it("отвергает пустой вход", async () => {
    await expect(parser.parse("")).rejects.toThrow(EndpointListParseError);
  });

  it("отвергает скаляр вместо документа", async () => {
    await expect(parser.parse("просто строка")).rejects.toThrow(EndpointListParseError);
  });

  it("отвергает список без обёртки endpoints", async () => {
    await expect(parser.parse("- { id: a, method: GET, path: /a }")).rejects.toThrow(
      EndpointListParseError,
    );
  });

  it("отвергает документ без ключа endpoints", async () => {
    await expect(parser.parse("endpoints: null")).rejects.toThrow(
      /"endpoints" key is missing or is not a list/,
    );
  });

  it("отвергает endpoints, не являющийся списком", async () => {
    await expect(parser.parse("endpoints: { id: a }")).rejects.toThrow(EndpointListParseError);
  });

  // Неизвестный ключ — это невыполненное намерение автора: он рассчитывал
  // на поведение, которого не будет, и молчание об этом хуже отказа.
  it("отвергает неизвестный ключ документа, а не игнорирует его", async () => {
    const list = `
version: 2
endpoints:
  - { id: a, method: GET, path: /a }
`;

    await expect(parser.parse(list)).rejects.toThrow(/unknown document key "version"/);
  });

  it("отвергает неразбираемый YAML", async () => {
    await expect(parser.parse("endpoints: [{ это: не закрыт")).rejects.toThrow(
      EndpointListParseError,
    );
  });

  it("отвергает пустой список отдельной ошибкой", async () => {
    await expect(parser.parse("endpoints: []")).rejects.toThrow(EmptyEndpointListError);
  });
});

describe("элемент списка не проходит проверку", () => {
  it("отвергает элемент, не являющийся объектом", async () => {
    await expect(parser.parse("endpoints: [ /v1/users ]")).rejects.toMatchObject({
      name: "InvalidEndpointError",
      index: 0,
      field: "entry",
    });
  });

  it("отвергает вложенный список вместо объекта", async () => {
    await expect(parser.parse("endpoints: [ [GET, /a] ]")).rejects.toThrow(InvalidEndpointError);
  });

  it("отвергает неизвестное поле элемента", async () => {
    const list = "endpoints: [{ id: a, method: GET, path: /a, tenant: acme }]";

    await expect(parser.parse(list)).rejects.toThrow(/unknown field "tenant"/);
  });

  // $ref здесь не поддерживается вовсе: разрешать нечего и некуда ходить.
  it("не знает про $ref и отвергает его как неизвестное поле", async () => {
    const list = 'endpoints: [{ $ref: "http://127.0.0.1:1/evil.yaml" }]';

    await expect(parser.parse(list)).rejects.toThrow(/unknown field "\$ref"/);
  });

  it("отвергает отсутствующий id", async () => {
    await expect(parser.parse("endpoints: [{ method: GET, path: /a }]")).rejects.toMatchObject({
      index: 0,
      field: "id",
    });
  });

  it("отвергает пустой и пробельный id", async () => {
    await expect(parser.parse('endpoints: [{ id: "", method: GET, path: /a }]')).rejects.toThrow(
      InvalidEndpointError,
    );
    await expect(parser.parse('endpoints: [{ id: "  ", method: GET, path: /a }]')).rejects.toThrow(
      InvalidEndpointError,
    );
  });

  it("отвергает id, не являющийся строкой", async () => {
    await expect(parser.parse("endpoints: [{ id: 42, method: GET, path: /a }]")).rejects.toThrow(
      InvalidEndpointError,
    );
  });

  it("отвергает метод вне набора HttpMethod", async () => {
    await expect(parser.parse("endpoints: [{ id: a, method: TRACE, path: /a }]")).rejects.toThrow(
      /method "TRACE" is not supported/,
    );
    await expect(parser.parse("endpoints: [{ id: a, method: CONNECT, path: /a }]")).rejects.toThrow(
      InvalidEndpointError,
    );
  });

  it("отвергает метод, не являющийся строкой", async () => {
    await expect(
      parser.parse("endpoints: [{ id: a, method: 200, path: /a }]"),
    ).rejects.toMatchObject({ index: 0, field: "method" });
  });

  it("отвергает путь без ведущего слэша", async () => {
    await expect(
      parser.parse("endpoints: [{ id: a, method: GET, path: v1/users }]"),
    ).rejects.toThrow(/must be a string starting with a slash/);
  });

  it("отвергает абсолютный URL вместо пути", async () => {
    const list = 'endpoints: [{ id: a, method: GET, path: "https://example.test/v1/users" }]';

    await expect(parser.parse(list)).rejects.toMatchObject({ index: 0, field: "path" });
  });

  // `//host/x` при склейке с базой адресовал бы чужой хост, а не путь
  // на проверяемом: область проверки не должна расширяться формой записи.
  it("отвергает схемо-относительный URL", async () => {
    const list = 'endpoints: [{ id: a, method: GET, path: "//evil.test/v1/users" }]';

    await expect(parser.parse(list)).rejects.toThrow(/addresses another host/);
  });

  it("отвергает отсутствующий путь", async () => {
    await expect(parser.parse("endpoints: [{ id: a, method: GET }]")).rejects.toMatchObject({
      index: 0,
      field: "path",
    });
  });

  it("указывает номер сбойного элемента, а не только факт ошибки", async () => {
    const list = `
endpoints:
  - { id: a, method: GET, path: /a }
  - { id: b, method: GET, path: /b }
  - { id: c, method: WAT, path: /c }
`;

    await expect(parser.parse(list)).rejects.toMatchObject({ index: 2, field: "method" });
  });
});

describe("уникальность идентификаторов", () => {
  it("отвергает повторяющийся id и называет обе позиции", async () => {
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

  it("различает id по регистру: это разные эндпоинты", async () => {
    const list = `
endpoints:
  - { id: users.list, method: GET, path: /v1/users }
  - { id: Users.List, method: GET, path: /v1/Users }
`;

    await expect(parser.parse(list)).resolves.toHaveLength(2);
  });

  it("допускает один путь под разными методами", async () => {
    const list = `
endpoints:
  - { id: users.list, method: GET, path: /v1/users }
  - { id: users.head, method: HEAD, path: /v1/users }
`;

    await expect(parser.parse(list)).resolves.toHaveLength(2);
  });
});

describe("пределы на вход", () => {
  it("отвергает YAML-бомбу до того, как она развернётся", async () => {
    const bomb = `
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
endpoints: [*d,*d,*d,*d,*d,*d,*d,*d,*d]
`;

    await expect(parser.parse(bomb)).rejects.toThrow(EndpointListParseError);
  });

  it("считает алиасы по своему пределу, а не по чужому", async () => {
    const strict = createEndpointListParser({ maxAliasCount: 1 });
    const list = `
endpoints:
  - &first { id: a, method: GET, path: /a }
  - *first
  - *first
`;

    await expect(strict.parse(list)).rejects.toThrow(EndpointListParseError);
  });

  it("отвергает документ больше предела и называет фактический размер", async () => {
    const small = createEndpointListParser({ maxBytes: 32 });

    const attempt = small.parse(MINIMAL_LIST);

    await expect(attempt).rejects.toThrow(EndpointListTooLargeError);
    await expect(attempt).rejects.toThrow(
      new RegExp(`${Buffer.byteLength(MINIMAL_LIST, "utf8")} bytes, the limit is 32`),
    );
  });

  it("измеряет размер в байтах, а не в символах", async () => {
    // Кириллица в UTF-8 занимает два байта на символ: предел, заданный
    // в байтах, нельзя проверять длиной строки.
    const parserWithLimit = createEndpointListParser({ maxBytes: 20 });
    const source = "«".repeat(11);

    await expect(parserWithLimit.parse(source)).rejects.toThrow(EndpointListTooLargeError);
  });

  it("пропускает документ ровно на пределе", async () => {
    const source = "endpoints: [{ id: a, method: GET, path: /a }]";
    const exact = createEndpointListParser({ maxBytes: Buffer.byteLength(source, "utf8") });

    await expect(exact.parse(source)).resolves.toHaveLength(1);
  });
});

describe("парсер не обращается к файловой системе", () => {
  let directory = "";
  let listPath = "";
  const CANARY = "canary-3d7be-не-должно-утечь";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "barbican-endpoints-"));
    listPath = join(directory, "endpoints.yaml");
    await writeFile(listPath, `endpoints:\n  - { id: ${CANARY}, method: GET, path: /a }\n`, "utf8");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // На вход подаётся текст документа, а не путь. Парсер, который умеет
  // открывать файлы, был бы примитивом path traversal.
  it("не читает файл, путь к которому подан как источник", async () => {
    const attempt = parser.parse(listPath);

    await expect(attempt).rejects.toThrow(EndpointListParseError);
    await expect(
      attempt.catch((error: unknown) => JSON.stringify(error) + String(error)),
    ).resolves.not.toContain(CANARY);
  });

  it("не читает файл, путь к которому оказался в поле path", async () => {
    const list = `endpoints: [{ id: a, method: GET, path: "${listPath}" }]`;

    // Путь остаётся просто путём: содержимое файла в результат не подмешивается.
    await expect(parser.parse(list)).resolves.toEqual([{ id: "a", method: "GET", path: listPath }]);
  });
});

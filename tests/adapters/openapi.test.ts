/**
 * Тесты-доказательства для парсера спецификаций.
 *
 * Инвариант из ADR-0005: внешние `$ref` не разрешаются ни по http, ни по
 * файловой системе. Эти тесты не проверяют «выбросилась ли ошибка» — они
 * проверяют, что обращения наружу **не произошло**: http-сервер не получил
 * ни одного запроса, содержимое файла не попало в результат.
 *
 * Удалять или помечать `skip` нельзя.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenApiParser,
  DEFAULT_SPEC_LIMITS,
  ExternalRefError,
  SpecParseError,
  SpecTooDeepError,
  SpecTooLargeError,
  UnsupportedYamlTagError,
} from "../../src/adapters/openapi.js";

const parser = createOpenApiParser();

const MINIMAL_SPEC = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /v1/players/{playerId}:
    get:
      operationId: players.read
      responses: { "200": { description: ok } }
  /v1/admin/users:
    get:
      responses: { "200": { description: ok } }
    delete:
      responses: { "204": { description: ok } }
`;

describe("разбор корректной спецификации", () => {
  it("извлекает эндпоинты с методом и путём", async () => {
    const endpoints = await parser.parse(MINIMAL_SPEC);

    expect(endpoints).toEqual([
      {
        id: "players.read",
        method: "GET",
        path: "/v1/players/{playerId}",
        operationId: "players.read",
      },
      { id: "GET /v1/admin/users", method: "GET", path: "/v1/admin/users" },
      { id: "DELETE /v1/admin/users", method: "DELETE", path: "/v1/admin/users" },
    ]);
  });

  it("принимает JSON: он подмножество YAML", async () => {
    const json = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
    });

    const endpoints = await parser.parse(json);

    expect(endpoints).toEqual([{ id: "GET /ping", method: "GET", path: "/ping" }]);
  });

  it("разрешает внутренние ссылки", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    $ref: "#/components/pathItems/shared"
components:
  pathItems:
    shared:
      get:
        operationId: shared.read
        responses: { "200": { description: ok } }
`;

    const endpoints = await parser.parse(spec);

    expect(endpoints).toEqual([
      { id: "shared.read", method: "GET", path: "/a", operationId: "shared.read" },
    ]);
  });

  it("возвращает пустой список для валидной спецификации без путей", async () => {
    const spec = 'openapi: "3.0.0"\ninfo: { title: t, version: "1" }\npaths: {}';

    await expect(parser.parse(spec)).resolves.toEqual([]);
  });

  // Молча вернуть ноль эндпоинтов на невалидной спеке — значит выдать
  // «расхождений нет» там, где проверка вообще не состоялась.
  it("отвергает документ, не являющийся спецификацией, а не отдаёт пустой список", async () => {
    await expect(
      parser.parse('openapi: "3.0.0"\ninfo: { title: t, version: "1" }'),
    ).rejects.toThrow(SpecParseError);
    await expect(parser.parse("просто: строка")).rejects.toThrow(SpecParseError);
  });
});

describe("внешние $ref по http не разрешаются", () => {
  let hits = 0;
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    hits = 0;
    server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/yaml" });
      response.end("type: object\n");
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

  it("не выполняет ни одного запроса к адресу из $ref", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "${baseUrl}/evil.yaml"
`;

    await expect(parser.parse(spec)).rejects.toThrow(ExternalRefError);

    // Главное утверждение: наружу не ушло ничего.
    expect(hits).toBe(0);
  });

  it("не ходит и по ссылке в корне документа", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  $ref: "${baseUrl}/paths.yaml"
`;

    await expect(parser.parse(spec)).rejects.toThrow(ExternalRefError);
    expect(hits).toBe(0);
  });

  it("сообщает, какая именно ссылка отвергнута", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "${baseUrl}/evil.yaml"
`;

    await expect(parser.parse(spec)).rejects.toMatchObject({ ref: `${baseUrl}/evil.yaml` });
    expect(hits).toBe(0);
  });
});

describe("внешние $ref по файловой системе не разрешаются", () => {
  let directory = "";
  let secretPath = "";
  const CANARY = "canary-6f2a1b9c-не-должно-утечь";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "barbican-spec-"));
    secretPath = join(directory, "secret.yaml");
    await writeFile(secretPath, `type: object\ndescription: ${CANARY}\n`, "utf8");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("не читает файл по абсолютному пути и не пропускает его содержимое в результат", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "${secretPath}"
`;

    const attempt = parser.parse(spec);

    await expect(attempt).rejects.toThrow(ExternalRefError);
    await expect(attempt.catch((error: unknown) => JSON.stringify(error))).resolves.not.toContain(
      CANARY,
    );
  });

  it("не разрешает обход каталогов через ../", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "../../../../etc/passwd"
`;

    await expect(parser.parse(spec)).rejects.toThrow(ExternalRefError);
  });

  it("не разрешает file://", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "file://${secretPath}"
`;

    await expect(parser.parse(spec)).rejects.toThrow(ExternalRefError);
  });
});

describe("пределы на размер и форму документа", () => {
  it("отвергает YAML-бомбу до того, как она развернётся", async () => {
    const bomb = `
openapi: 3.0.0
info: { title: t, version: "1" }
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]
paths: {}
`;

    await expect(parser.parse(bomb)).rejects.toThrow(SpecParseError);
  });

  it("отвергает документ больше предела", async () => {
    const small = createOpenApiParser({ maxBytes: 64 });

    await expect(small.parse(MINIMAL_SPEC)).rejects.toThrow(SpecTooLargeError);
  });

  it("отвергает слишком глубокую вложенность", async () => {
    let nested = "1";
    for (let i = 0; i < DEFAULT_SPEC_LIMITS.maxDepth + 10; i += 1) {
      nested = `[${nested}]`;
    }

    await expect(parser.parse(`{"paths":{},"deep":${nested}}`)).rejects.toThrow(SpecTooDeepError);
  });

  it("не считает глубиной общие поддеревья от алиасов", async () => {
    const shared = `
openapi: 3.0.0
info: { title: t, version: "1" }
shared: &shared { type: object }
a: *shared
b: *shared
c: *shared
paths:
  /a:
    get:
      responses: { "200": { description: ok } }
`;

    await expect(parser.parse(shared)).resolves.toHaveLength(1);
  });

  it("сообщает о неразбираемом документе, а не падает", async () => {
    await expect(parser.parse("{ это: [не, закрыт")).rejects.toThrow(SpecParseError);
  });
});

/**
 * Найдено состязательной проверкой. Узлы с тегами `!!omap` и `!!set` парсер
 * даёт как Map и Set, а обход по `Object.values` в них не заходит: внешняя
 * ссылка под таким узлом проезжала мимо барьера, а `paths` под ним давал
 * **ноль эндпоинтов без единой ошибки** — сто процентов покрытия пустоты.
 * Psych такие документы эмитирует штатно, то есть случай не выдуманный.
 */
describe("узлы, невидимые обходу", () => {
  const parser = createOpenApiParser();

  it("отвергает внешнюю ссылку, спрятанную под !!omap", async () => {
    await expect(
      parser.parse(`
openapi: 3.0.0
info: { title: t, version: "1" }
components: !!omap
  - schemas:
      Order: { $ref: "http://127.0.0.1:9/x.yaml#/c" }
paths:
  /v1/orders:
    get: { operationId: orders.list, responses: { "200": { description: ok } } }
`),
    ).rejects.toThrow(UnsupportedYamlTagError);
  });

  it("отвергает ручки, спрятанные под !!omap, вместо тихого нуля", async () => {
    await expect(
      parser.parse(`
openapi: 3.0.0
info: { title: t, version: "1" }
paths: !!omap
  - /v1/admin/accounts:
      get: { operationId: admin.accounts, responses: { "200": { description: ok } } }
`),
    ).rejects.toThrow(UnsupportedYamlTagError);
  });

  it("отвергает и !!set", async () => {
    await expect(
      parser.parse(`
openapi: 3.0.0
info: { title: t, version: "1" }
components: !!set
  ? $ref
paths:
  /v1/orders:
    get: { operationId: orders.list, responses: { "200": { description: ok } } }
`),
    ).rejects.toThrow(UnsupportedYamlTagError);
  });
});

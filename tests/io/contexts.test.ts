/**
 * Тесты разбора условий обращения.
 *
 * Все проверки здесь про молчаливую подмену: условия, переписавшие учётный
 * заголовок, дают прогон не тем аккаунтом; условия без правила — ворох
 * расхождений, которых никто не заявлял; опечатка в имени — правило,
 * не применяющееся ни к чему. Ни одно из этого не выглядит как сбой.
 */

import { describe, expect, it } from "vitest";
import {
  assertContextsCannotWrite,
  ForbiddenContextHeaderError,
  ForbiddenContextQueryError,
  MethodOverrideInContextError,
  parseRunConfig,
  toAccounts,
  UncarriableKeyError,
  UnknownContextReferenceError,
  UnusedContextError,
} from "../../src/io/config.js";

function config(body: string): string {
  return `
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE }
  - { id: bob, role: user, tenant: tenant-b, tokenEnv: T_BOB }
${body}`;
}

const GEO_RULE = `
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: geo-blocked, outcome: denied }
`;

describe("аккаунт в условиях", () => {
  it("даёт отдельную строку матрицы с теми же тенантом и ролью", () => {
    const parsed = parseRunConfig(
      config(`${GEO_RULE}
contexts:
  - { id: geo-blocked, headers: { cf-ipcountry: AQ }, endpoints: [orders.list] }
`),
    );

    const { accounts, attributes } = toAccounts(parsed);

    expect(accounts.map((account) => account.id)).toEqual([
      "alice",
      "bob",
      "alice@geo-blocked",
      "bob@geo-blocked",
    ]);
    expect(accounts[2]).toMatchObject({
      roleId: "user",
      tenantId: "tenant-a",
      contextId: "geo-blocked",
      endpointIds: ["orders.list"],
    });
    // Условия аккаунта не меняют: предъявляется он сам, и владение объектом
    // сверяется по нему же. Без ссылки свой объект переставал быть своим.
    expect(accounts[2]?.baseAccountId).toBe("alice");
    expect(attributes.get("alice@geo-blocked")?.headers).toEqual({ "cf-ipcountry": "AQ" });
  });

  it("применяет условия только к названным аккаунтам", () => {
    const parsed = parseRunConfig(
      config(`${GEO_RULE}
contexts:
  - { id: geo-blocked, headers: { cf-ipcountry: AQ }, endpoints: [orders.list], accounts: [alice] }
`),
    );

    expect(toAccounts(parsed).accounts.map((account) => account.id)).toEqual([
      "alice",
      "bob",
      "alice@geo-blocked",
    ]);
  });
});

describe("условия не подменяют основу обращения", () => {
  /**
   * Условия, тихо переписавшие `Authorization`, дали бы прогон, где часть
   * ячеек ходит не тем аккаунтом, — а выглядело бы это как находки платформы.
   */
  it.each([
    ["authorization", "Bearer чужой"],
    ["Cookie", "session=чужая"],
    ["host", "evil.test"],
    ["content-length", "0"],
  ])("отвергает заголовок %s", (header, value) => {
    expect(() =>
      parseRunConfig(
        config(`${GEO_RULE}
contexts:
  - id: geo-blocked
    headers: { "${header}": "${value}" }
    endpoints: [orders.list]
`),
      ),
    ).toThrow(ForbiddenContextHeaderError);
  });

  /**
   * Имя заголовка учётной схемы объявлено человеком, поэтому запрет считается
   * от разобранных схем, а не от строки в файле.
   */
  it("отвергает заголовок, по которому предъявляются учётные данные", () => {
    expect(() =>
      parseRunConfig(
        config(`
auth: { kind: header, header: X-API-Key }
${GEO_RULE}
contexts:
  - { id: geo-blocked, headers: { x-api-key: чужой }, endpoints: [orders.list] }
`),
      ),
    ).toThrow(ForbiddenContextHeaderError);
  });
});

describe("условия без ожиданий", () => {
  /**
   * Ожидание в условиях объявляется явно. Без правила все ячейки условий уйдут
   * в fallback, и отчёт наполнится расхождениями, которых никто не заявлял.
   */
  it("отвергает условия, на которые не ссылается ни одно правило", () => {
    expect(() =>
      parseRunConfig(
        config(`
policy: { fallback: denied, rules: [] }
contexts:
  - { id: geo-blocked, headers: { cf-ipcountry: AQ }, endpoints: [orders.list] }
`),
      ),
    ).toThrow(UnusedContextError);
  });

  /** Опечатка в ссылке — правило, не применяющееся ни к одной ячейке. */
  it("отвергает правило, ссылающееся на необъявленные условия", () => {
    expect(() =>
      parseRunConfig(
        config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: geo-blockd, outcome: denied }
contexts:
  - { id: geo-blocked, headers: { cf-ipcountry: AQ }, endpoints: [orders.list] }
`),
      ),
    ).toThrow(UnknownContextReferenceError);
  });
});

describe("строгая схема правила", () => {
  /**
   * Найдено прогоном полигона против старой сборки: нераспознанный ключ молча
   * отбрасывался, и правило «запретить в этих условиях» превращалось
   * в «запретить всегда» — 19 находок на исправной платформе. Та же опечатка
   * в `scope` расширяет правило на все отношения и, наоборот, прячет находку.
   */
  it("отвергает лишний ключ в правиле вместо того, чтобы его отбросить", () => {
    expect(() =>
      parseRunConfig(
        config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], scop: own, outcome: allowed }
`),
      ),
    ).toThrow();
  });
});

/**
 * Найдено состязательной проверкой, и это была худшая находка дня: условия
 * заставили платформу **удалить объект** при выключенных небезопасных методах.
 * Гейт `SAFE_METHODS` смотрит на метод запроса и подмены не видит, а отчёт
 * при этом писал `writeMethodsProbed: false` — то есть утверждал обратное
 * произошедшему.
 */
describe("условия не могут подменить смысл обращения", () => {
  /** Политика обязана называть условия, иначе прогон падает раньше проверки. */
  function withContext(id: string, attributes: string): string {
    return config(`
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: ${id}, outcome: denied }
contexts:
  - id: ${id}
    ${attributes}
    endpoints: [orders.list]
`);
  }

  it.each([
    ["x-http-method-override", "заголовок подмены метода"],
    ["X-HTTP-Method", "он же в другом написании"],
    ["x-method-override", "и в третьем"],
    ["x-original-url", "подмена адреса: обращение уйдёт мимо объявленного пути"],
    ["x-rewrite-url", "она же"],
    ["x-forwarded-host", "маршрутизация: меняет адресата, а не условия"],
    ["x-forwarded-proto", "она же"],
    ["proxy-authorization", "учётные данные"],
    ["upgrade", "заголовок обмена"],
  ])("отвергает заголовок %s (%s)", (header) => {
    expect(() => parseRunConfig(withContext("bad", `headers: { "${header}": something }`))).toThrow(
      ForbiddenContextHeaderError,
    );
  });

  /**
   * `__proto__` в обычном объектном литерале ключом не становится: заголовок
   * молча исчезал бы, а объявление, которое ничего не делает и не жалуется, —
   * ровно то, против чего написан весь инструмент.
   */
  it("отвергает ключ __proto__, а не теряет его молча", () => {
    expect(() => parseRunConfig(withContext("weird", 'headers: { __proto__: "value" }'))).toThrow(
      UncarriableKeyError,
    );
  });

  /** Гео-атрибут остаётся разрешённым: ради него условия и заводились. */
  it("не трогает x-forwarded-for — это и есть типовой атрибут условий", () => {
    expect(() =>
      parseRunConfig(withContext("geo", 'headers: { x-forwarded-for: "203.0.113.10" }')),
    ).not.toThrow();
  });

  it.each(["access_token", "api_key", "token", "jwt", "session"])(
    "отвергает параметр запроса %s: им предъявляют учётные данные",
    (key) => {
      expect(() =>
        parseRunConfig(withContext("bad", `query: { "${key}": "похоже на токен" }`)),
      ).toThrow(ForbiddenContextQueryError);
    },
  );

  it("отвергает имя заголовка, которое не уйдёт по проводу", () => {
    expect(() => parseRunConfig(withContext("bad", 'headers: { "x-bad name": ok }'))).toThrow(
      ForbiddenContextHeaderError,
    );
  });

  it("отвергает значение, которое не уйдёт по проводу", () => {
    expect(() => parseRunConfig(withContext("bad", 'headers: { x-note: "кириллица" }'))).toThrow(
      ForbiddenContextHeaderError,
    );
  });

  /**
   * Самая тихая из подмен: вердикт считается по объявленному объекту,
   * а спрашивается другой — и межтенантная утечка ложится в отчёт как
   * «свой объект, проверено и совпало».
   */
  it("отвергает параметр, которым объекты задают себя", () => {
    expect(() =>
      parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test] }
accounts: [{ id: alice, role: user, tenant: tenant-a, tokenEnv: T }]
resources:
  - { id: own, tenant: tenant-a, owner: alice, query: { id: "1001" }, endpoints: [orders.list] }
policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [orders.list], context: mobile, outcome: allowed }
contexts:
  - { id: mobile, query: { id: "2001" }, endpoints: [orders.list] }
`),
    ).toThrow(ForbiddenContextQueryError);
  });

  /**
   * Правило по **значению**, а не по имени: имён у подмены метода десяток
   * и будет больше, а значение у неё всегда одно — имя метода. Так ловится
   * и вендорский заголовок, о котором никто не слышал.
   */
  describe("подмена метода ловится значением атрибута", () => {
    const parsed = (attributes: string) => parseRunConfig(withContext("proxy", attributes));

    it("отвергает заголовок, чьё значение — имя метода", () => {
      expect(() =>
        assertContextsCannotWrite(parsed("headers: { x-vendor-verb: DELETE }"), {
          allowUnsafeMethods: false,
        }),
      ).toThrow(MethodOverrideInContextError);
    });

    it("отвергает и параметр запроса с тем же значением", () => {
      expect(() =>
        assertContextsCannotWrite(parsed('query: { _method: "delete" }'), {
          allowUnsafeMethods: false,
        }),
      ).toThrow(MethodOverrideInContextError);
    });

    /** С явным согласием на запись запрещать нечего: человек уже решил. */
    it("молчит, когда небезопасные методы разрешены явно", () => {
      expect(() =>
        assertContextsCannotWrite(parsed("headers: { x-vendor-verb: DELETE }"), {
          allowUnsafeMethods: true,
        }),
      ).not.toThrow();
    });

    it("не мешает обычному значению атрибута", () => {
      expect(() =>
        assertContextsCannotWrite(parsed("headers: { cf-ipcountry: AQ }"), {
          allowUnsafeMethods: false,
        }),
      ).not.toThrow();
    });
  });
});

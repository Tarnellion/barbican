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
  ForbiddenContextHeaderError,
  parseRunConfig,
  toAccounts,
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

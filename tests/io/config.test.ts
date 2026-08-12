/**
 * Тесты разбора конфигурации.
 *
 * Отдельное внимание — тому, что токены не попадают в саму конфигурацию:
 * её сериализуют в отчёт, и утёкший туда токен пережил бы прогон.
 */

import { describe, expect, it } from "vitest";
import {
  assertReferencesResolve,
  ConfigParseError,
  ConfigValidationError,
  DuplicateAccountIdError,
  HostOutsideScopeError,
  InvalidCredentialError,
  MissingCredentialError,
  parseRunConfig,
  resolveTokens,
  toAccounts,
  UnknownEndpointReferenceError,
  UnknownResourceOwnerError,
} from "../../src/io/config.js";

const VALID = `
target:
  baseUrl: https://staging.example.test/api
  allowedHosts: [staging.example.test]

accounts:
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: TOKEN_PLAYER_A }
  - { id: admin-a,  role: admin,  tenant: tenant-a, tokenEnv: TOKEN_ADMIN_A }

policy:
  fallback: denied
  rules:
    - { roles: "*", endpoints: [profile.read], outcome: allowed }
    - { roles: [admin], endpoints: "*", outcome: allowed }
`;

describe("разбор корректной конфигурации", () => {
  it("читает цель, аккаунты и политику", () => {
    const config = parseRunConfig(VALID);

    expect(config.target.baseUrl).toBe("https://staging.example.test/api");
    expect(config.target.allowedHosts).toEqual(["staging.example.test"]);
    expect(config.accounts).toHaveLength(2);
    expect(config.policy.fallback).toBe("denied");
    expect(config.policy.rules).toHaveLength(2);
  });

  it("принимает JSON наравне с YAML", () => {
    const json = JSON.stringify({
      target: { baseUrl: "http://localhost:3000", allowedHosts: ["localhost"] },
      accounts: [{ id: "a", role: "player", tenant: "t", tokenEnv: "T" }],
      policy: { fallback: "denied", rules: [] },
    });

    expect(parseRunConfig(json).accounts).toHaveLength(1);
  });

  it("приводит аккаунты к доменному типу ядра", () => {
    expect(toAccounts(parseRunConfig(VALID))).toEqual([
      { id: "player-a", roleId: "player", tenantId: "tenant-a" },
      { id: "admin-a", roleId: "admin", tenantId: "tenant-a" },
    ]);
  });
});

describe("область проверки", () => {
  it("отвергает baseUrl, хост которого не объявлен", () => {
    const config = VALID.replace("staging.example.test/api", "other.example.test/api");

    expect(() => parseRunConfig(config)).toThrow(HostOutsideScopeError);
  });

  it("не даёт опечатке в адресе молча расширить область", () => {
    const config = `
target:
  baseUrl: https://stagng.example.test
  allowedHosts: [staging.example.test]
accounts: [{ id: a, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`;

    expect(() => parseRunConfig(config)).toThrow(HostOutsideScopeError);
  });

  it("требует непустой allowedHosts", () => {
    const config = VALID.replace("allowedHosts: [staging.example.test]", "allowedHosts: []");

    expect(() => parseRunConfig(config)).toThrow(ConfigValidationError);
  });

  it("отвергает протоколы кроме http и https", () => {
    const config = VALID.replace("https://staging.example.test/api", "ftp://staging.example.test");

    expect(() => parseRunConfig(config)).toThrow(ConfigValidationError);
  });
});

describe("проверка схемы", () => {
  it("сообщает путь до отсутствующего поля", () => {
    const config = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: a, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`;

    expect(() => parseRunConfig(config)).toThrow(/accounts/);
  });

  it("требует хотя бы один аккаунт: матрицу не построить ни от кого", () => {
    const config = VALID.replace(/accounts:[\s\S]*?policy:/, "accounts: []\npolicy:");

    expect(() => parseRunConfig(config)).toThrow(ConfigValidationError);
  });

  it("отвергает неизвестный исход в политике", () => {
    const config = VALID.replace("outcome: allowed", "outcome: maybe");

    expect(() => parseRunConfig(config)).toThrow(ConfigValidationError);
  });

  it("отвергает повторяющийся id аккаунта", () => {
    const config = VALID.replace("id: admin-a", "id: player-a");

    expect(() => parseRunConfig(config)).toThrow(DuplicateAccountIdError);
  });

  it("сообщает о неразбираемом документе", () => {
    expect(() => parseRunConfig("target: [не закрыт")).toThrow(ConfigParseError);
  });
});

describe("учётные данные", () => {
  it("берёт токены из окружения, а не из файла", () => {
    const config = parseRunConfig(VALID);

    const tokens = resolveTokens(config, {
      TOKEN_PLAYER_A: "player-secret-token",
      TOKEN_ADMIN_A: "admin-secret-token",
    });

    expect(tokens.get("player-a")).toBe("player-secret-token");
    expect(tokens.get("admin-a")).toBe("admin-secret-token");
  });

  it("не оставляет токен в самой конфигурации", () => {
    const config = parseRunConfig(VALID);
    resolveTokens(config, {
      TOKEN_PLAYER_A: "player-secret-token",
      TOKEN_ADMIN_A: "admin-secret-token",
    });

    // Конфигурация сериализуется в отчёт: токена в ней быть не должно.
    expect(JSON.stringify(config)).not.toContain("player-secret-token");
    expect(JSON.stringify(config)).toContain("TOKEN_PLAYER_A");
  });

  it("падает на старте, если переменная не задана", () => {
    const config = parseRunConfig(VALID);

    expect(() => resolveTokens(config, { TOKEN_PLAYER_A: "present" })).toThrow(
      MissingCredentialError,
    );
  });

  it("отвергает токен, непригодный как значение HTTP-заголовка", () => {
    const config = parseRunConfig(VALID);

    // Кириллица и переносы строк ломают заголовок. Падать надо на старте,
    // а не десятками одинаковых сбоев посреди прогона.
    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "кириллица", TOKEN_ADMIN_A: "ok" }),
    ).toThrow(InvalidCredentialError);
    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "with\nnewline", TOKEN_ADMIN_A: "ok" }),
    ).toThrow(InvalidCredentialError);
  });

  it("считает пустую переменную отсутствующей", () => {
    const config = parseRunConfig(VALID);

    expect(() =>
      resolveTokens(config, { TOKEN_PLAYER_A: "present", TOKEN_ADMIN_A: "   " }),
    ).toThrow(MissingCredentialError);
  });
});

describe("объекты обращения", () => {
  const WITH_RESOURCES = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: TOK_A }
resources:
  - { id: mine,    tenant: tenant-a, owner: player-a, params: { playerId: "1001" } }
  - { id: foreign, tenant: tenant-b, params: { playerId: "2002" } }
  - { id: byquery, tenant: tenant-a, query: { report_id: "1" } }
policy:
  fallback: denied
  rules:
    - { roles: [player], endpoints: [profile], scope: own, outcome: allowed }
`;

  it("читает объекты с владельцем, параметрами и запросом", () => {
    const config = parseRunConfig(WITH_RESOURCES);

    expect(config.resources).toEqual([
      {
        id: "mine",
        tenantId: "tenant-a",
        ownerAccountId: "player-a",
        params: { playerId: "1001" },
      },
      { id: "foreign", tenantId: "tenant-b", params: { playerId: "2002" } },
      { id: "byquery", tenantId: "tenant-a", params: {}, query: { report_id: "1" } },
    ]);
  });

  it("читает область действия правила", () => {
    expect(parseRunConfig(WITH_RESOURCES).policy.rules[0]?.scope).toBe("own");
  });

  it("отвергает неизвестное отношение", () => {
    expect(() => parseRunConfig(WITH_RESOURCES.replace("scope: own", "scope: чужое"))).toThrow(
      ConfigValidationError,
    );
  });

  // Иначе отношение «своё или чужое» стало бы неопределённым молча.
  it("отвергает объект, объявленный принадлежащим несуществующему аккаунту", () => {
    expect(() =>
      parseRunConfig(WITH_RESOURCES.replace("owner: player-a", "owner: нет-такого")),
    ).toThrow(UnknownResourceOwnerError);
  });

  it("отвергает повторяющийся id объекта", () => {
    expect(() => parseRunConfig(WITH_RESOURCES.replace("id: foreign", "id: mine"))).toThrow(
      DuplicateAccountIdError,
    );
  });

  it("без объектов список пуст, а не отсутствует", () => {
    expect(parseRunConfig(VALID).resources).toEqual([]);
  });
});

describe("анонимный аккаунт", () => {
  const ANON = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: anon,     role: guest,  tenant: public }
  - { id: player-a, role: player, tenant: tenant-a, tokenEnv: TOK_A }
policy: { fallback: denied, rules: [] }
`;

  it("допускает аккаунт без переменной с токеном", () => {
    const config = parseRunConfig(ANON);

    expect(config.accounts[0]?.tokenEnv).toBeUndefined();
  });

  // Без этого нельзя проверить утверждение «этот адрес не должен быть публичным».
  it("не требует учётных данных для анонимного аккаунта", () => {
    const tokens = resolveTokens(parseRunConfig(ANON), { TOK_A: "value" });

    expect(tokens.has("anon")).toBe(false);
    expect(tokens.get("player-a")).toBe("value");
  });
});

describe("сверка ссылок на эндпоинты", () => {
  const endpoints = [
    { id: "orders.read", method: "GET", path: "/v1/orders/{orderId}" },
    { id: "me", method: "GET", path: "/v1/me" },
  ] as const;

  const base = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: u, role: player, tenant: t, tokenEnv: TOK, canary: me }
resources:
  - { id: mine, tenant: t, owner: u, params: { orderId: "1" }, endpoints: [orders.read] }
policy:
  fallback: denied
  rules:
    - { roles: [player], endpoints: [orders.read], scope: own, outcome: allowed }
`;

  it("пропускает корректные ссылки", () => {
    expect(() => assertReferencesResolve(parseRunConfig(base), endpoints)).not.toThrow();
  });

  // Найдено прогоном против crAPI: опечатка в ресурсе молча теряла четыре
  // находки BOLA, а объект оставался в отчёте как объявленный.
  it("отвергает опечатку в ссылке объекта", () => {
    const config = parseRunConfig(
      base.replace("endpoints: [orders.read]", "endpoints: [orders.raed]"),
    );

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownEndpointReferenceError);
  });

  // Тот же прогон, обратный исход: опечатка в правиле ФАБРИКОВАЛА находки —
  // чтение пользователем своего заказа объявлялось эскалацией привилегий.
  it("отвергает опечатку в правиле политики", () => {
    const config = parseRunConfig(
      base.replace("endpoints: [orders.read], scope", "endpoints: [orders_read], scope"),
    );

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownEndpointReferenceError);
  });

  it("отвергает опечатку в канарейке", () => {
    const config = parseRunConfig(base.replace("canary: me", "canary: mee"));

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownEndpointReferenceError);
  });

  it("не придирается к правилу с «*»", () => {
    const config = parseRunConfig(
      base.replace("endpoints: [orders.read], scope: own", 'endpoints: "*"'),
    );

    expect(() => assertReferencesResolve(config, endpoints)).not.toThrow();
  });
});

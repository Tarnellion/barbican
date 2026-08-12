/**
 * Тесты разбора конфигурации.
 *
 * Отдельное внимание — тому, что токены не попадают в саму конфигурацию:
 * её сериализуют в отчёт, и утёкший туда токен пережил бы прогон.
 */

import { describe, expect, it } from "vitest";
import {
  ConfigParseError,
  ConfigValidationError,
  DuplicateAccountIdError,
  HostOutsideScopeError,
  InvalidCredentialError,
  MissingCredentialError,
  parseRunConfig,
  resolveTokens,
  toAccounts,
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

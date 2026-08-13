/**
 * Тесты разбора конфигурации.
 *
 * Отдельное внимание — тому, что токены не попадают в саму конфигурацию:
 * её сериализуют в отчёт, и утёкший туда токен пережил бы прогон.
 */

import { describe, expect, it } from "vitest";
import {
  DuplicateMembershipError,
  RESOURCE_RELATIONS,
  SubsumedMembershipError,
  TenantCycleError,
  UnknownParentTenantError,
} from "../../src/core/index.js";
import {
  AuthSchemeWithoutTokenError,
  applyBodySignals,
  assertReferencesResolve,
  ConfigParseError,
  ConfigValidationError,
  CredentialsInUrlError,
  DuplicateAccountIdError,
  DuplicateResourceIdError,
  DuplicateSignalNameError,
  HostOutsideScopeError,
  InvalidCredentialError,
  MissingCredentialError,
  parseRunConfig,
  resolveTokens,
  toAccounts,
  UnknownAuthSchemeError,
  UnknownEndpointReferenceError,
  UnknownResourceOwnerError,
  UnknownTenantError,
  UnusedAuthSchemeError,
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
    expect(toAccounts(parseRunConfig(VALID)).accounts).toEqual([
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

describe("scope принимает все отношения", () => {
  /**
   * Прямая защита от расхождения схемы с типом. Оно уже случилось: при вводе
   * иерархии `ResourceRelation` вырос до пяти значений, а рукописное
   * zod-перечисление осталось трёхзначным — и вся возможность оказалась
   * недостижима через CLI, хотя ядро её понимало.
   *
   * Юнит-тесты ядра этого не ловили: они собирают политику объектом на
   * TypeScript, минуя zod. Путь «YAML → политика» не проверялся ничем.
   */
  it.each(RESOURCE_RELATIONS)("принимает scope: %s", (relation) => {
    const config = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy:
  fallback: denied
  rules:
    - { roles: [r], endpoints: [e], scope: ${relation}, outcome: allowed }
`;

    expect(parseRunConfig(config).policy.rules[0]?.scope).toBe(relation);
  });
});

describe("дерево тенантов", () => {
  const HOLDINGS = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: h1, role: holding, tenant: holding-1, tokenEnv: T1 }
tenants:
  - { id: holding-1 }
  - { id: brand-a, parent: holding-1 }
  - { id: holding-2 }
  - { id: brand-c, parent: holding-2 }
policy: { fallback: denied, rules: [] }
`;

  it("читает родство из развёрнутой формы", () => {
    expect(parseRunConfig(HOLDINGS).tenants).toEqual([
      { id: "holding-1" },
      { id: "brand-a", parentId: "holding-1" },
      { id: "holding-2" },
      { id: "brand-c", parentId: "holding-2" },
    ]);
  });

  /** Краткая форма означает лес из корней — поведение до ADR-0013. */
  it("принимает прежнюю краткую форму", () => {
    const config = parseRunConfig(
      HOLDINGS.replace(/tenants:[\s\S]*?policy:/, "tenants: [holding-1]\npolicy:"),
    );

    expect(config.tenants).toEqual([{ id: "holding-1" }]);
  });

  /**
   * Опечатка в родителе делает тенанта отдельным корнем: «свой бренд»
   * превращается в «чужой», правило перестаёт применяться, находка исчезает.
   * Падать обязано на старте, а не молча менять смысл.
   */
  it("отвергает опечатку в родителе до выхода в сеть", () => {
    expect(() =>
      parseRunConfig(HOLDINGS.replace("parent: holding-1", "parent: holding-l")),
    ).toThrow(UnknownParentTenantError);
  });

  describe("свой адрес у тенанта", () => {
    const WITH_URLS = `
target: { baseUrl: "https://api.example.test", allowedHosts: [api.example.test, a.example.test] }
accounts:
  - { id: op, role: operator, tenant: brand-a, tokenEnv: T }
tenants:
  - { id: brand-a, baseUrl: "https://a.example.test" }
policy: { fallback: denied, rules: [] }
`;

    it("читает адрес бренда", () => {
      expect(parseRunConfig(WITH_URLS).tenants).toEqual([
        { id: "brand-a", baseUrl: "https://a.example.test" },
      ]);
    });

    /** Область проверки одна на прогон: объявление тенанта её не расширяет. */
    it("отвергает адрес тенанта вне allowedHosts", () => {
      expect(() =>
        parseRunConfig(WITH_URLS.replace('https://a.example.test"', 'https://c.example.test"')),
      ).toThrow(HostOutsideScopeError);
    });

    it("отвергает учётные данные в адресе тенанта", () => {
      expect(() =>
        parseRunConfig(WITH_URLS.replace('https://a.example.test"', 'https://u:p@a.example.test"')),
      ).toThrow(CredentialsInUrlError);
    });
  });

  it("отвергает цикл в дереве", () => {
    const cyclic = HOLDINGS.replace(
      "  - { id: holding-1 }",
      "  - { id: holding-1, parent: brand-a }",
    );

    expect(() => parseRunConfig(cyclic)).toThrow(TenantCycleError);
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

  // Найдено при сборке референс-платформы: дубль объекта сообщал про аккаунт
  // и отправлял читателя не в ту секцию конфигурации.
  it("отвергает повторяющийся id объекта и говорит именно об объекте", () => {
    const broken = () => parseRunConfig(WITH_RESOURCES.replace("id: foreign", "id: mine"));

    expect(broken).toThrow(DuplicateResourceIdError);
    expect(broken).toThrow(/Объект/);
  });

  it("без объектов список пуст, а не отсутствует", () => {
    expect(parseRunConfig(VALID).resources).toEqual([]);
  });
});

describe("анонимный аккаунт", () => {
  const ANON = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: anon,     role: guest }
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

  /**
   * Тенанта у анонима нет, и поле не подставляется заглушкой: служебное имя
   * вроде `none` лежало бы в одном пространстве значений с настоящими именами,
   * и платформа с тенантом `none` получила бы аноним в соседи — молча.
   */
  it("оставляет аккаунт без тенанта без поля tenantId", () => {
    expect(toAccounts(parseRunConfig(ANON)).accounts).toEqual([
      { id: "anon", roleId: "guest" },
      { id: "player-a", roleId: "player", tenantId: "tenant-a" },
    ]);
    expect(toAccounts(parseRunConfig(ANON)).accounts[0]).not.toHaveProperty("tenantId");
  });

  // Он объявлен вне тенантов, а не отнесён к какому-то из них: требовать для
  // него строки в перечне значило бы вернуть сентинел через чёрный ход.
  it("не требует записи в перечне tenants, оставляя сверку строгой для прочих", () => {
    const strict = `${ANON}tenants: [tenant-a]\n`;

    expect(() => parseRunConfig(strict)).not.toThrow();
    expect(() => parseRunConfig(strict.replace("tenant: tenant-a", "tenant: tenant-b"))).toThrow(
      UnknownTenantError,
    );
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

  /**
   * Опечатка здесь отказывает молча и закрыто: тело не читается, проверка
   * не срабатывает, отчёт выглядит чистым. Тот же класс, что опечатка в тенанте.
   */
  it("отвергает опечатку в объявлении responseMustDifferByTenant", () => {
    const config = parseRunConfig(
      `${base}bodySignals: { responseMustDifferByTenant: [orders.raed] }\n`,
    );

    expect(() => assertReferencesResolve(config, endpoints)).toThrow(UnknownEndpointReferenceError);
  });

  it("пропускает корректное объявление responseMustDifferByTenant", () => {
    const config = parseRunConfig(
      `${base}bodySignals: { responseMustDifferByTenant: [orders.read] }\n`,
    );

    expect(config.bodySignals?.responseMustDifferByTenant).toEqual(["orders.read"]);
    expect(() => assertReferencesResolve(config, endpoints)).not.toThrow();
  });

  describe("объявленные скаляры", () => {
    const withSignals = `${base}bodySignals:
  responseMustDifferByTenant: [orders.read]
  signals:
    - { name: orderCount, kind: count, path: orders, endpoints: [orders.read] }
`;

    it("читает объявленные сигналы", () => {
      const config = parseRunConfig(withSignals);

      expect(config.bodySignals?.signals).toEqual([
        { name: "orderCount", kind: "count", path: "orders", endpoints: ["orders.read"] },
      ]);
    });

    it("проставляет их эндпоинту вместе с объявлением", () => {
      const config = parseRunConfig(withSignals);

      const marked = applyBodySignals(endpoints, config);
      const target = marked.find((endpoint) => endpoint.id === "orders.read");

      expect(target?.responseMustDifferByTenant).toBe(true);
      expect(target?.signals).toEqual([{ name: "orderCount", kind: "count", path: "orders" }]);
    });

    it("отвергает опечатку в эндпоинте сигнала", () => {
      const config = parseRunConfig(
        withSignals.replace("endpoints: [orders.read] }", "endpoints: [orders.raed] }"),
      );

      expect(() => assertReferencesResolve(config, endpoints)).toThrow(
        UnknownEndpointReferenceError,
      );
    });

    /** Имена — ключи в наблюдении: повтор молча затирал бы предыдущий скаляр. */
    it("отвергает повторяющееся имя сигнала", () => {
      const config = parseRunConfig(
        `${withSignals}    - { name: orderCount, kind: present, path: next, endpoints: [orders.read] }\n`,
      );

      expect(() => assertReferencesResolve(config, endpoints)).toThrow(DuplicateSignalNameError);
    });
  });

  describe("applyBodySignals", () => {
    it("проставляет объявление только перечисленным эндпоинтам", () => {
      const config = parseRunConfig(
        `${base}bodySignals: { responseMustDifferByTenant: [orders.read] }\n`,
      );

      const marked = applyBodySignals(endpoints, config);

      expect(
        marked.find((endpoint) => endpoint.id === "orders.read")?.responseMustDifferByTenant,
      ).toBe(true);
      expect(
        marked.filter((endpoint) => endpoint.responseMustDifferByTenant === true),
      ).toHaveLength(1);
    });

    /** Без секции тела не читаются нигде — это и есть «выключено по умолчанию». */
    it("без секции bodySignals не трогает ничего", () => {
      const marked = applyBodySignals(endpoints, parseRunConfig(base));

      expect(marked).toBe(endpoints);
      expect(marked.some((endpoint) => endpoint.responseMustDifferByTenant === true)).toBe(false);
    });
  });

  it("не придирается к правилу с «*»", () => {
    const config = parseRunConfig(
      base.replace("endpoints: [orders.read], scope: own", 'endpoints: "*"'),
    );

    expect(() => assertReferencesResolve(config, endpoints)).not.toThrow();
  });
});

describe("тенанты", () => {
  const WITH_TENANTS = `
tenants: [tenant-a, tenant-b]
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: u, role: player, tenant: tenant-a, tokenEnv: TOK }
resources:
  - { id: mine, tenant: tenant-a, owner: u, params: { id: "1" } }
policy: { fallback: denied, rules: [] }
`;

  it("принимает объявленные тенанты", () => {
    expect(() => parseRunConfig(WITH_TENANTS)).not.toThrow();
  });

  // Самое опасное: опечатка не ломает прогон, а ПРЯЧЕТ находку — объект уезжает
  // в чужой тенант, правило со scope перестаёт применяться, утечка проваливается
  // в fallback и не попадает в отчёт вовсе.
  it("отвергает опечатку в тенанте объекта", () => {
    expect(() =>
      parseRunConfig(WITH_TENANTS.replace("mine, tenant: tenant-a", "mine, tenant: tenant-c")),
    ).toThrow(UnknownTenantError);
  });

  it("отвергает опечатку в тенанте аккаунта", () => {
    expect(() =>
      parseRunConfig(
        WITH_TENANTS.replace("tenant: tenant-a, tokenEnv", "tenant: tenant-x, tokenEnv"),
      ),
    ).toThrow(UnknownTenantError);
  });

  it("срезает пробелы: «tenant-a » и «tenant-a» — один тенант", () => {
    const config = parseRunConfig(
      WITH_TENANTS.replace("tenant: tenant-a, owner", 'tenant: "tenant-a ", owner'),
    );

    expect(config.resources[0]?.tenantId).toBe("tenant-a");
    expect(toAccounts(config).accounts[0]?.tenantId).toBe("tenant-a");
  });

  it("без объявленного перечня не придирается: объект чужого тенанта законен", () => {
    const withoutList = WITH_TENANTS.replace("tenants: [tenant-a, tenant-b]\n", "");

    expect(() =>
      parseRunConfig(withoutList.replace("mine, tenant: tenant-a", "mine, tenant: tenant-z")),
    ).not.toThrow();
  });
});

describe("схемы аутентификации на аккаунт", () => {
  const MULTI = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }

auth: { kind: bearer }

authSchemes:
  operator-console: { kind: cookie, name: opsid }
  affiliate-cabinet: { kind: header, header: X-Affiliate-Key }

accounts:
  - { id: player-a, role: player, tenant: t, tokenEnv: TOK_PLAYER }
  - { id: operator-a, role: operator, tenant: t, tokenEnv: TOK_OPERATOR, authScheme: operator-console }
  - { id: affiliate-a, role: affiliate, tenant: t, tokenEnv: TOK_AFFILIATE, authScheme: affiliate-cabinet }

policy: { fallback: denied, rules: [] }
`;

  it("разрешает ссылки в схемы, оставляя прочие аккаунты на схеме по умолчанию", () => {
    const config = parseRunConfig(MULTI);

    expect(config.auth).toEqual({ kind: "bearer" });
    expect([...config.accountAuth]).toEqual([
      ["operator-a", { kind: "cookie", name: "opsid" }],
      ["affiliate-a", { kind: "header", header: "X-Affiliate-Key" }],
    ]);
  });

  it("без переопределений карта пуста, а не отсутствует", () => {
    // CLI передаёт её всегда; отсутствие потребовало бы ветки на вызове.
    expect(parseRunConfig(VALID).accountAuth.size).toBe(0);
  });

  // Главное утверждение: опечатка в ссылке обязана остановить прогон.
  // Иначе аккаунт пошёл бы по схеме по умолчанию, получил бы сплошной 401,
  // а сплошной отказ совпадает с политикой там, где доступ не положен, —
  // и отчёт вышел бы чистым, ничего не проверив.
  it("падает на опечатке в имени схемы", () => {
    expect(() =>
      parseRunConfig(MULTI.replace("authScheme: operator-console", "authScheme: operator-consol")),
    ).toThrow(UnknownAuthSchemeError);
  });

  it("падает на ссылке, когда схем не объявлено вовсе", () => {
    const noSchemes = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: TOK, authScheme: operator-console }]
policy: { fallback: denied, rules: [] }
`;

    expect(() => parseRunConfig(noSchemes)).toThrow(UnknownAuthSchemeError);
  });

  it("не разрешает ссылку через унаследованное свойство объекта", () => {
    // `authSchemes` приходит из недоверенного файла: индексация обычного объекта
    // отдала бы `constructor` вместо `undefined`, и ссылка «разрешилась» бы.
    const inherited = MULTI.replace("authScheme: operator-console", "authScheme: constructor");

    expect(() => parseRunConfig(inherited)).toThrow(UnknownAuthSchemeError);
  });

  it("падает на схеме, которой никто не пользуется", () => {
    // Практически это забытый authScheme у аккаунта: он пойдёт по умолчанию
    // и промолчит. Мёртвое объявление выглядит проверенным утверждением.
    const forgotten = MULTI.replace(
      ", tokenEnv: TOK_AFFILIATE, authScheme: affiliate-cabinet",
      ", tokenEnv: TOK_AFFILIATE",
    );

    expect(() => parseRunConfig(forgotten)).toThrow(UnusedAuthSchemeError);
  });

  it("падает на схеме у аккаунта без токена", () => {
    // Предъявлять по схеме нечего, а ссылка при этом «использует» схему —
    // и настоящий забытый authScheme перестал бы быть виден.
    const anonymous = MULTI.replace("tokenEnv: TOK_OPERATOR, ", "");

    expect(() => parseRunConfig(anonymous)).toThrow(AuthSchemeWithoutTokenError);
  });

  it("отвергает негодное имя заголовка, называя схему", () => {
    const broken = MULTI.replace("header: X-Affiliate-Key", 'header: "X Affiliate Key"');

    expect(() => parseRunConfig(broken)).toThrow(/affiliate-cabinet/);
  });

  it("отвергает значение секрета в схеме", () => {
    // Единственный источник токена — переменная окружения (ADR-0008).
    // Молча отброшенное поле оставило бы секрет в файле, который коммитят.
    const withSecret = MULTI.replace(
      "{ kind: cookie, name: opsid }",
      '{ kind: cookie, name: opsid, value: "s3cret" }',
    );

    expect(() => parseRunConfig(withSecret)).toThrow(ConfigValidationError);
  });
});

describe("набор тенантов у аккаунта", () => {
  /** Саппорт на брендах двух разных холдингов — случай из ADR-0017. */
  const WITH_SET = `
tenants:
  - { id: holding-1 }
  - { id: holding-2 }
  - { id: brand-a, parent: holding-1 }
  - { id: brand-c, parent: holding-2 }
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: sam, role: support, tenants: [brand-a, brand-c], tokenEnv: TOK }
resources:
  - { id: r-a, tenant: brand-a, params: { id: "1" } }
policy: { fallback: denied, rules: [] }
`;

  it("доводит набор до доменного типа ядра набором", () => {
    expect(toAccounts(parseRunConfig(WITH_SET)).accounts).toEqual([
      { id: "sam", roleId: "support", tenantIds: ["brand-a", "brand-c"] },
    ]);
  });

  it("срезает пробелы в именах набора", () => {
    const config = parseRunConfig(WITH_SET.replace("[brand-a, brand-c]", '["brand-a ", brand-c]'));

    expect(toAccounts(config).accounts[0]?.tenantIds).toEqual(["brand-a", "brand-c"]);
  });

  // Тот же класс, что опечатка в одиночном тенанте: она не ломает прогон,
  // а прячет находку — членство уезжает в никуда, объект становится чужим.
  it("отвергает опечатку внутри набора", () => {
    expect(() => parseRunConfig(WITH_SET.replace("brand-c]", "brand-x]"))).toThrow(
      UnknownTenantError,
    );
  });

  // Вложенное членство переводит объекты бренда из descendant-tenant
  // в same-tenant, и правило для взгляда сверху вниз молча перестаёт
  // применяться. Смысл поменялся, отчёт на вид прежний.
  it("отвергает набор, где одно членство лежит в поддереве другого", () => {
    expect(() =>
      parseRunConfig(WITH_SET.replace("[brand-a, brand-c]", "[holding-1, brand-a]")),
    ).toThrow(SubsumedMembershipError);
  });

  it("отвергает повтор внутри набора", () => {
    expect(() =>
      parseRunConfig(WITH_SET.replace("[brand-a, brand-c]", "[brand-a, brand-a]")),
    ).toThrow(DuplicateMembershipError);
  });

  // Оба поля сразу — противоречие: непонятно, что считать членством.
  it("отвергает tenant и tenants одновременно", () => {
    expect(() =>
      parseRunConfig(
        WITH_SET.replace(
          "tenants: [brand-a, brand-c]",
          "tenant: brand-a, tenants: [brand-a, brand-c]",
        ),
      ),
    ).toThrow(ConfigValidationError);
  });

  // Набор из одного — это `tenant`. Две записи одного смысла разошлись бы
  // в чтении конфигурации и в отчёте.
  it("отвергает набор из одного тенанта", () => {
    expect(() => parseRunConfig(WITH_SET.replace("[brand-a, brand-c]", "[brand-a]"))).toThrow(
      ConfigValidationError,
    );
  });
});

describe("учётные данные в адресе", () => {
  it("отвергает логин и пароль в baseUrl", () => {
    const config = `
target: { baseUrl: "https://svc:S3cret@a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: TOK }]
policy: { fallback: denied, rules: [] }
`;

    // baseUrl копируется в отчёт дословно, а отчёт печатается в stdout.
    expect(() => parseRunConfig(config)).toThrow(CredentialsInUrlError);
  });

  it("понимает запись allowedHosts с портом", () => {
    const config = `
target: { baseUrl: "https://a.test:8443/v1", allowedHosts: ["a.test:8443"] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: TOK }]
policy: { fallback: denied, rules: [] }
`;

    expect(() => parseRunConfig(config)).not.toThrow();
  });
});

/**
 * Найдено холодным чтением: два самых громких инварианта проекта отвечали
 * читателю сырым zod по-английски. «Обязательный allowlist» и «умолчания
 * у fallback нет намеренно» расписаны в руководстве целыми абзацами,
 * а `Invalid input: expected array, received undefined` читается как баг
 * в конфиге, а не как «вы пытаетесь сканировать чужую систему без области».
 */
describe("сообщения на обязательных полях", () => {
  it("объясняет, зачем нужен allowlist, а не сообщает тип", () => {
    expect(() =>
      parseRunConfig(`
target: { baseUrl: "https://a.test" }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy: { fallback: denied, rules: [] }
`),
    ).toThrow(/сканирование чужой системы/);
  });

  it("объясняет, почему у fallback нет умолчания", () => {
    expect(() =>
      parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: T }]
policy: { rules: [] }
`),
    ).toThrow(/Умолчания у fallback нет намеренно/);
  });
});

/**
 * Тесты схем аутентификации.
 *
 * Проверяют ровно то, что уходит в заголовках: инструмент, который «настроен»
 * на нужную схему, но шлёт не то, даёт картину сплошных отказов и молчаливо
 * отчитывается, что доступа нигде нет.
 */

import { describe, expect, it } from "vitest";
import {
  createCredentialProvider,
  DEFAULT_AUTH_SCHEME,
  InvalidAuthSchemeError,
} from "../../src/adapters/credentials.js";

const tokens = new Map([["acc", "s3cret-token"]]);

describe("схемы аутентификации", () => {
  it("bearer кладёт токен в Authorization с префиксом", () => {
    const provider = createCredentialProvider({ kind: "bearer" }, tokens);

    expect(provider.headersFor("acc")).toEqual({ authorization: "Bearer s3cret-token" });
  });

  it("header кладёт токен в указанный заголовок целиком, без префикса", () => {
    const provider = createCredentialProvider({ kind: "header", header: "X-API-Key" }, tokens);

    expect(provider.headersFor("acc")).toEqual({ "x-api-key": "s3cret-token" });
  });

  it("cookie собирает пару имя-значение", () => {
    const provider = createCredentialProvider({ kind: "cookie", name: "session" }, tokens);

    expect(provider.headersFor("acc")).toEqual({ cookie: "session=s3cret-token" });
  });

  it("basic кодирует логин и пароль в base64", () => {
    const provider = createCredentialProvider({ kind: "basic" }, new Map([["acc", "user:pass"]]));

    expect(provider.headersFor("acc")).toEqual({
      authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
    });
  });

  it("по умолчанию используется bearer", () => {
    expect(DEFAULT_AUTH_SCHEME).toEqual({ kind: "bearer" });
  });
});

describe("анонимное обращение", () => {
  // Законный случай: так проверяют, не открыт ли эндпоинт вообще всем.
  it("аккаунт без токена обращается без заголовков", () => {
    const provider = createCredentialProvider({ kind: "bearer" }, tokens);

    expect(provider.headersFor("неизвестный")).toEqual({});
  });
});

describe("схема на аккаунт", () => {
  // Ради этого переопределение и заводилось: на мультибрендовой платформе
  // клиентское API, операторская админка и кабинет аффилиата аутентифицируются
  // по-разному, а прогон обязан охватывать их одним заходом.
  const many = new Map([
    ["player", "player-token"],
    ["operator", "operator-token"],
    ["affiliate", "affiliate-token"],
  ]);

  const provider = createCredentialProvider(
    DEFAULT_AUTH_SCHEME,
    many,
    new Map([
      ["operator", { kind: "cookie", name: "opsid" } as const],
      ["affiliate", { kind: "header", header: "X-Affiliate-Key" } as const],
    ]),
  );

  it("аккаунт со своей схемой идёт по ней", () => {
    expect(provider.headersFor("operator")).toEqual({ cookie: "opsid=operator-token" });
    expect(provider.headersFor("affiliate")).toEqual({ "x-affiliate-key": "affiliate-token" });
  });

  it("аккаунт без своей схемы идёт по схеме по умолчанию", () => {
    expect(provider.headersFor("player")).toEqual({ authorization: "Bearer player-token" });
  });

  it("переопределение не даёт заголовков аккаунту без токена", () => {
    // Иначе анонимный аккаунт перестал бы быть анонимным, и утверждение
    // «эта ручка не публична» проверялось бы не тем обращением.
    const anonymous = createCredentialProvider(
      DEFAULT_AUTH_SCHEME,
      new Map(),
      new Map([["ghost", { kind: "cookie", name: "opsid" } as const]]),
    );

    expect(anonymous.headersFor("ghost")).toEqual({});
  });
});

describe("проверка схемы", () => {
  it("отвергает имя заголовка с недопустимыми символами", () => {
    expect(() => createCredentialProvider({ kind: "header", header: "X Api Key" }, tokens)).toThrow(
      InvalidAuthSchemeError,
    );
    expect(() =>
      createCredentialProvider({ kind: "header", header: "X-Key:\nInjected" }, tokens),
    ).toThrow(InvalidAuthSchemeError);
  });

  it("отвергает имя куки с недопустимыми символами", () => {
    expect(() => createCredentialProvider({ kind: "cookie", name: "sess ion" }, tokens)).toThrow(
      InvalidAuthSchemeError,
    );
  });

  it("проверяет схему при создании, а не при первом запросе", () => {
    // Иначе ошибка конфигурации всплыла бы посреди прогона.
    expect(() => createCredentialProvider({ kind: "header", header: "" }, tokens)).toThrow(
      InvalidAuthSchemeError,
    );
  });

  it("проверяет и переопределения, а не только схему по умолчанию", () => {
    // Непроверенное переопределение всплыло бы на том обращении, до которого
    // прогон дойдёт в середине матрицы, — то есть уже после канареек.
    expect(() =>
      createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        tokens,
        new Map([["acc", { kind: "cookie", name: "sess ion" } as const]]),
      ),
    ).toThrow(InvalidAuthSchemeError);
  });

  it("называет аккаунт в сообщении о негодном переопределении", () => {
    expect(() =>
      createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        tokens,
        new Map([["acc", { kind: "header", header: "X Key" } as const]]),
      ),
    ).toThrow(/acc/);
  });
});

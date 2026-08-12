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
});

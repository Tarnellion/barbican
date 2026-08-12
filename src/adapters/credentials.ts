/**
 * Способы представиться проверяемой системе.
 *
 * Куки поддерживаются только в одну сторону: значение приходит из окружения,
 * из ответов оно не извлекается. Инвариант «тела и `set-cookie` не читаем»
 * это не трогает — мы лишь отправляем то, что нам дали.
 */

import type { CredentialProvider } from "./ports.js";

export type AuthScheme =
  /** `Authorization: Bearer <токен>` — самая частая схема для JWT. */
  | { readonly kind: "bearer" }
  /** Произвольный заголовок целиком, например `X-API-Key: <токен>`. */
  | { readonly kind: "header"; readonly header: string }
  /** `Cookie: <имя>=<значение>` — сессионные платформы. */
  | { readonly kind: "cookie"; readonly name: string }
  /** `Authorization: Basic <base64>`; в переменной лежит `логин:пароль`. */
  | { readonly kind: "basic" };

export const DEFAULT_AUTH_SCHEME: AuthScheme = { kind: "bearer" };

export class InvalidAuthSchemeError extends Error {
  constructor(reason: string) {
    super(`Некорректная схема аутентификации: ${reason}`);
    this.name = "InvalidAuthSchemeError";
  }
}

/** Имя заголовка по RFC 9110: только видимые ASCII без разделителей. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function assertSchemeIsSound(scheme: AuthScheme): void {
  if (scheme.kind === "header" && !HEADER_NAME.test(scheme.header)) {
    throw new InvalidAuthSchemeError(`"${scheme.header}" не является именем заголовка`);
  }
  if (scheme.kind === "cookie" && !HEADER_NAME.test(scheme.name)) {
    throw new InvalidAuthSchemeError(`"${scheme.name}" не является именем куки`);
  }
}

/**
 * Создаёт поставщик учётных данных.
 *
 * Токены передаются отдельной картой и не хранятся в конфигурации —
 * см. ADR-0008.
 */
export function createCredentialProvider(
  scheme: AuthScheme,
  tokens: ReadonlyMap<string, string>,
): CredentialProvider {
  assertSchemeIsSound(scheme);

  return {
    headersFor(accountId: string): Readonly<Record<string, string>> {
      const token = tokens.get(accountId);
      if (token === undefined) {
        // Анонимное обращение — законный случай: так проверяют,
        // не открыт ли эндпоинт вообще всем.
        return {};
      }

      switch (scheme.kind) {
        case "bearer":
          return { authorization: `Bearer ${token}` };
        case "header":
          return { [scheme.header.toLowerCase()]: token };
        case "cookie":
          return { cookie: `${scheme.name}=${token}` };
        case "basic":
          return { authorization: `Basic ${Buffer.from(token, "utf8").toString("base64")}` };
      }
    },
  };
}

/**
 * Способы представиться проверяемой системе.
 *
 * Схема — свойство **контура**, а не прогона: на мультибрендовой платформе
 * кабинет аффилиата, операторская админка и клиентское API аутентифицируются
 * по-разному, и прогон, охватывающий их разом, обязан уметь ходить в каждый
 * по-своему. Поэтому провайдер знает схему по умолчанию и переопределения
 * на аккаунт. См. ADR-0016.
 *
 * Куки поддерживаются только в одну сторону: значение приходит из окружения,
 * из ответов оно не извлекается. Инвариант «тела и `set-cookie` не читаем»
 * это не трогает — мы лишь отправляем то, что нам дали.
 */

import type { CredentialProvider } from "./ports.js";

/**
 * Подпись обращения встроенной схемой не выражается — и это решение, а не
 * недоделка: канонизация у каждой платформы своя, и общий формат, придуманный
 * без цели, дал бы конфигурацию, которая описывает подпись, но не совпадает
 * ни с одной настоящей. Своя схема реализуется поверх порта `CredentialProvider`,
 * который для этого и получает описание обращения. См. ADR-0018.
 */
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
  constructor(reason: string, where?: string) {
    super(`Invalid authentication scheme${where === undefined ? "" : ` (${where})`}: ${reason}`);
    this.name = "InvalidAuthSchemeError";
  }
}

/** Имя заголовка по RFC 9110: только видимые ASCII без разделителей. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Проверяет, что схему вообще можно отправить.
 *
 * Экспортируется, чтобы разбор конфигурации мог отвергнуть негодную схему там,
 * где известно её **имя**: «схема "operator-console"» полезнее для человека,
 * чем «схема аккаунта admin-a», — имя схемы он и правил.
 *
 * @throws {InvalidAuthSchemeError}
 */
export function assertAuthSchemeIsSound(scheme: AuthScheme, where?: string): void {
  if (scheme.kind === "header" && !HEADER_NAME.test(scheme.header)) {
    throw new InvalidAuthSchemeError(`"${scheme.header}" is not a header name`, where);
  }
  if (scheme.kind === "cookie" && !HEADER_NAME.test(scheme.name)) {
    throw new InvalidAuthSchemeError(`"${scheme.name}" is not a cookie name`, where);
  }
}

/** Заголовки, которыми предъявляется один токен по одной схеме. */
function headersFrom(scheme: AuthScheme, token: string): Readonly<Record<string, string>> {
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
}

/**
 * Создаёт поставщик учётных данных.
 *
 * Токены передаются отдельной картой и не хранятся в конфигурации —
 * см. ADR-0008.
 *
 * `schemesByAccount` переопределяет схему для названных аккаунтов; остальные
 * идут по `defaultScheme`. Карта, а не поле в аккаунте: провайдер о структуре
 * конфигурации не знает и знать не должен.
 *
 * @throws {InvalidAuthSchemeError} схема непригодна к отправке
 */
export function createCredentialProvider(
  defaultScheme: AuthScheme,
  tokens: ReadonlyMap<string, string>,
  schemesByAccount: ReadonlyMap<string, AuthScheme> = new Map(),
): CredentialProvider {
  assertAuthSchemeIsSound(defaultScheme);
  // Проверяются все, а не только применённые: негодная схема обязана падать
  // при создании провайдера, а не при первом обращении от того аккаунта,
  // до которого прогон дойдёт в середине матрицы.
  for (const [accountId, scheme] of schemesByAccount) {
    assertAuthSchemeIsSound(scheme, `account "${accountId}"`);
  }

  return {
    headersFor(accountId: string): Readonly<Record<string, string>> {
      const token = tokens.get(accountId);
      if (token === undefined) {
        // Анонимное обращение — законный случай: так проверяют,
        // не открыт ли эндпоинт вообще всем.
        return {};
      }

      return headersFrom(schemesByAccount.get(accountId) ?? defaultScheme, token);
    },
  };
}

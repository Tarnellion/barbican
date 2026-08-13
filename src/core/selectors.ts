/**
 * Отбор эндпоинтов по шаблону метода и пути.
 *
 * Перечисление по `id` не масштабируется: на платформе в сотню ручек правило
 * «администратору положено всё под /v1/admin» превращается в список из тридцати
 * идентификаторов, который расходится с реальностью при первой же новой ручке —
 * причём молча, потому что непокрытая пара падает в `fallback`.
 *
 * Шаблоны раскрываются в конкретные идентификаторы **до** диффа. Так разрешение
 * политики остаётся прежним, а шаблон, не совпавший ни с чем, ловится на старте:
 * это тот же класс ошибки, что опечатка в идентификаторе, и молчать о нём нельзя.
 */

import type { Endpoint, HttpMethod } from "./types.js";

/** Шаблон отбора. Метод необязателен: его отсутствие означает «любой». */
export interface EndpointPattern {
  readonly method?: HttpMethod | undefined;
  /** Шаблон пути: `*` внутри сегмента, `**` через сегменты. */
  readonly path: string;
}

export class UnmatchedPatternError extends Error {
  constructor(pattern: EndpointPattern) {
    const method = pattern.method === undefined ? "" : `${pattern.method} `;
    super(
      `Pattern "${method}${pattern.path}" matched no endpoint. ` +
        `A rule with this pattern will never apply, and its cells will silently fall ` +
        `through to the fallback — the same effect as a typo in an identifier.`,
    );
    this.name = "UnmatchedPatternError";
  }
}

const REGEXP_SPECIAL = /[.+?^${}()|[\]\\]/g;

/**
 * Превращает шаблон пути в регулярное выражение.
 *
 * Сначала экранируется всё специальное — в шаблонных путях есть фигурные скобки
 * (`/v1/players/{playerId}`), и без экранирования они стали бы квантификатором.
 * Только потом раскрываются `*` и `**`.
 */
export function pathPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(REGEXP_SPECIAL, "\\$&");
  // Двойная звезда обрабатывается раньше одинарной: иначе `**` распалось бы
  // на две одинарные и перестало пересекать границы сегментов.
  const body = escaped
    .split("**")
    .map((chunk) => chunk.split("*").join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/** Подходит ли эндпоинт под шаблон. Сверяется шаблонный путь, а не подставленный. */
export function endpointMatches(endpoint: Endpoint, pattern: EndpointPattern): boolean {
  if (pattern.method !== undefined && pattern.method !== endpoint.method) {
    return false;
  }
  return pathPatternToRegExp(pattern.path).test(endpoint.path);
}

/**
 * Раскрывает шаблон в идентификаторы.
 *
 * @throws {UnmatchedPatternError} если шаблон не совпал ни с чем.
 */
export function expandPattern(
  pattern: EndpointPattern,
  endpoints: readonly Endpoint[],
): readonly string[] {
  const matched = endpoints
    .filter((endpoint) => endpointMatches(endpoint, pattern))
    .map((endpoint) => endpoint.id);
  if (matched.length === 0) {
    throw new UnmatchedPatternError(pattern);
  }
  return matched;
}

/**
 * Ручной список эндпоинтов как источник для проверки.
 *
 * Нужен потому, что OpenAPI-спецификация есть далеко не у всякого API, а
 * проверять доступ надо и там. Список пишется человеком — это объявленное
 * намерение, ровно как и политика доступа (ADR-0006), а не знание, выведенное
 * из реализации проверяемой системы.
 *
 * Ограничения те же, что у парсера спецификаций, и по тем же причинам (ADR-0005):
 *
 * 1. На вход подаётся **текст документа**, а не путь. Адаптер не знает про
 *    файловую систему вовсе, поэтому не может стать примитивом path traversal:
 *    строка, похожая на путь, разбирается как YAML-скаляр и отвергается.
 * 2. Раскрытие YAML-алиасов ограничено: документ в пару килобайт разворачивается
 *    в гигабайты, если этого не сделать.
 * 3. Размер входа ограничен до разбора.
 *
 * Формат закрытый: неизвестные поля отвергаются, а не игнорируются. Молча
 * пропущенное поле — это невыполненное намерение автора списка, и узнать о нём
 * он смог бы только по итоговому отчёту, где проверка выглядит состоявшейся.
 *
 * Формат входа:
 *
 * ```yaml
 * endpoints:
 *   - { id: users.list, method: GET, path: /v1/users }
 *   - id: profile.read
 *     method: GET
 *     path: /v1/players/{playerId}
 * ```
 *
 * Про фигурные скобки: в потоковом стиле (`{ ... }`) шаблонный путь нужно
 * закавычивать — `path: "/v1/players/{playerId}"`, иначе `{` откроет
 * вложенное отображение и документ не разберётся. В блочном стиле, как выше,
 * кавычки не нужны. Это свойство YAML, а не нашей проверки, но шаблонные пути
 * здесь — норма, поэтому оговорено явно.
 */

import { parse as parseYaml } from "yaml";
import type { Endpoint, HttpMethod } from "../core/types.js";
import type { SpecParser } from "./ports.js";

export interface EndpointListLimits {
  /** Предельный размер входного текста в байтах. */
  readonly maxBytes: number;
  /**
   * Предел раскрытия YAML-алиасов.
   *
   * Защита от billion laughs: библиотека `yaml` считает раскрытия и прерывает
   * разбор сама, до того как документ развернётся в памяти.
   */
  readonly maxAliasCount: number;
}

export const DEFAULT_ENDPOINT_LIST_LIMITS: EndpointListLimits = {
  maxBytes: 1_000_000,
  maxAliasCount: 100,
};

export class EndpointListTooLargeError extends Error {
  constructor(actualBytes: number, maxBytes: number) {
    super(`Список эндпоинтов ${actualBytes} байт при пределе ${maxBytes}`);
    this.name = "EndpointListTooLargeError";
  }
}

export class EndpointListParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Не удалось разобрать список эндпоинтов: ${message}`, options);
    this.name = "EndpointListParseError";
  }
}

/**
 * Пустой список — ошибка, а не вырожденный случай.
 *
 * Ноль эндпоинтов даёт отчёт «расхождений нет» при том, что не проверено
 * ничего. Такой результат неотличим от успешного и потому опаснее сбоя.
 */
export class EmptyEndpointListError extends Error {
  constructor() {
    super(
      "Список эндпоинтов пуст. Прогон по пустому списку даёт отчёт без находок, " +
        "который читается как «нарушений нет», хотя не проверено ничего.",
    );
    this.name = "EmptyEndpointListError";
  }
}

/** Поле элемента, на котором споткнулась проверка. `entry` — сам элемент. */
export type EndpointField = "entry" | "id" | "method" | "path";

export class InvalidEndpointError extends Error {
  readonly index: number;
  readonly field: EndpointField;

  constructor(index: number, field: EndpointField, reason: string) {
    super(`Эндпоинт #${index}: ${reason}`);
    this.name = "InvalidEndpointError";
    this.index = index;
    this.field = field;
  }
}

export class DuplicateEndpointIdError extends Error {
  readonly id: string;

  constructor(id: string, firstIndex: number, secondIndex: number) {
    super(
      `Идентификатор "${id}" объявлен дважды: эндпоинты #${firstIndex} и #${secondIndex}. ` +
        `Политика доступа ссылается на эндпоинты по id, и дубль сделал бы её толкование неоднозначным.`,
    );
    this.name = "DuplicateEndpointIdError";
    this.id = id;
  }
}

/**
 * Допустимые методы.
 *
 * Запись через `Record<HttpMethod, ...>`, а не через массив: тип обязывает
 * перечислить все методы домена, поэтому расширение `HttpMethod` не пройдёт
 * мимо этого списка молча.
 */
const KNOWN_METHODS: Readonly<Record<HttpMethod, true>> = {
  GET: true,
  HEAD: true,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
  OPTIONS: true,
};

const METHOD_NAMES = Object.keys(KNOWN_METHODS).join(", ");

/** Поля элемента списка. Всё остальное отвергается — см. комментарий к модулю. */
const ENDPOINT_FIELDS: ReadonlySet<string> = new Set(["id", "method", "path"]);

/** Поля документа. Тоже закрытый набор, по той же причине. */
const DOCUMENT_FIELDS: ReadonlySet<string> = new Set(["endpoints"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Метод приводится к верхнему регистру: в домене он всегда `GET`, а не `get`. */
function toMethod(value: string): HttpMethod | undefined {
  const upper = value.trim().toUpperCase();
  return Object.hasOwn(KNOWN_METHODS, upper) ? (upper as HttpMethod) : undefined;
}

function toEndpoint(entry: unknown, index: number): Endpoint {
  if (!isRecord(entry)) {
    throw new InvalidEndpointError(
      index,
      "entry",
      `элемент списка должен быть объектом с полями ${[...ENDPOINT_FIELDS].join(", ")}`,
    );
  }

  for (const key of Object.keys(entry)) {
    if (!ENDPOINT_FIELDS.has(key)) {
      throw new InvalidEndpointError(
        index,
        "entry",
        `неизвестное поле "${key}"; допустимы только ${[...ENDPOINT_FIELDS].join(", ")}`,
      );
    }
  }

  const id = entry.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new InvalidEndpointError(index, "id", "id обязателен и должен быть непустой строкой");
  }

  const rawMethod = entry.method;
  if (typeof rawMethod !== "string") {
    throw new InvalidEndpointError(
      index,
      "method",
      `method обязателен и должен быть строкой; допустимы ${METHOD_NAMES}`,
    );
  }
  const method = toMethod(rawMethod);
  if (method === undefined) {
    throw new InvalidEndpointError(
      index,
      "method",
      `метод "${rawMethod}" не поддерживается; допустимы ${METHOD_NAMES}`,
    );
  }

  const path = entry.path;
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new InvalidEndpointError(
      index,
      "path",
      `path должен быть строкой, начинающейся со слэша; получено ${JSON.stringify(path)}`,
    );
  }
  // `//host/x` — схемо-относительный URL: он адресует другой хост, а не путь
  // на проверяемом. Область проверки задаётся allowlist'ом и не должна
  // расширяться формой записи пути.
  if (path.startsWith("//")) {
    throw new InvalidEndpointError(
      index,
      "path",
      `path "${path}" адресует другой хост (схемо-относительный URL), а не путь на проверяемом`,
    );
  }

  return { id, method, path };
}

function toEndpoints(document: unknown): readonly Endpoint[] {
  if (!isRecord(document)) {
    throw new EndpointListParseError('документ не является объектом с ключом "endpoints"');
  }

  for (const key of Object.keys(document)) {
    if (!DOCUMENT_FIELDS.has(key)) {
      throw new EndpointListParseError(`неизвестный ключ документа "${key}"`);
    }
  }

  const list = document.endpoints;
  if (!Array.isArray(list)) {
    throw new EndpointListParseError('ключ "endpoints" отсутствует или не является списком');
  }
  if (list.length === 0) {
    throw new EmptyEndpointListError();
  }

  const endpoints: Endpoint[] = [];
  const firstSeenAt = new Map<string, number>();

  for (const [index, entry] of list.entries()) {
    const endpoint = toEndpoint(entry, index);

    const firstIndex = firstSeenAt.get(endpoint.id);
    if (firstIndex !== undefined) {
      throw new DuplicateEndpointIdError(endpoint.id, firstIndex, index);
    }
    firstSeenAt.set(endpoint.id, index);

    endpoints.push(endpoint);
  }

  return endpoints;
}

/**
 * Создаёт парсер ручного списка эндпоинтов.
 *
 * Пределы можно ужесточить, но не отключить: значения по умолчанию —
 * консервативные, а не рекомендательные.
 */
export function createEndpointListParser(limits: Partial<EndpointListLimits> = {}): SpecParser {
  const effective: EndpointListLimits = { ...DEFAULT_ENDPOINT_LIST_LIMITS, ...limits };

  return {
    // Асинхронность — требование порта `SpecParser`. Здесь она заодно превращает
    // любой отказ в отклонённый промис, а не в синхронное исключение.
    async parse(source: string): Promise<readonly Endpoint[]> {
      const bytes = Buffer.byteLength(source, "utf8");
      if (bytes > effective.maxBytes) {
        throw new EndpointListTooLargeError(bytes, effective.maxBytes);
      }

      let document: unknown;
      try {
        // JSON — подмножество YAML 1.2, поэтому один парсер покрывает оба формата.
        document = parseYaml(source, { maxAliasCount: effective.maxAliasCount });
      } catch (cause) {
        throw new EndpointListParseError(describe(cause), { cause });
      }

      return toEndpoints(document);
    },
  };
}

/**
 * Коллекция Postman (v2.1) как источник эндпоинтов.
 *
 * Третий источник наравне с OpenAPI-спецификацией и ручным списком. Нужен
 * потому, что спецификации нет у множества команд, а коллекция ведётся руками
 * и оказывается единственным полным описанием API. В отличие от спеки, она не
 * порождается из проверяемого кода, поэтому и не наследует проблему ADR-0006:
 * коллекция — это тоже объявленное человеком намерение.
 *
 * Ограничения те же, что у соседних адаптеров, и по тем же причинам (ADR-0005):
 *
 * 1. На вход подаётся **текст документа**, а не путь. Адаптер не знает про
 *    файловую систему и сеть вовсе, поэтому не может стать примитивом path
 *    traversal или SSRF: строка, похожая на путь, разбирается как скаляр и
 *    отвергается.
 * 2. Размер входа ограничен до разбора, раскрытие YAML-алиасов — при разборе.
 * 3. Глубина вложенности папок ограничена: коллекция недоверенная, а обход по
 *    ней рекурсивный. Предел заодно обрывает циклы, которые YAML-якоря умеют
 *    строить (`&a [*a]`), — обход глубину только увеличивает, поэтому цикл
 *    упирается в предел, а не крутится вечно.
 * 4. Хост из коллекции отбрасывается целиком. Куда идут обращения, решают
 *    базовый URL прогона и allowlist, а не проверяемый документ; в `path`
 *    эндпоинта имени хоста не остаётся по построению.
 *
 * **Неизвестные ключи игнорируются, неизвестные элементы — нет.** Это
 * расхождение с `endpoint-list.ts`, и оно намеренное. Ручной список пишется
 * человеком для barbican, поэтому неизвестный ключ там означает невыполненное
 * намерение автора. Коллекция же пишется для другого инструмента, и почти всё
 * в ней (`event`, `auth`, `response`, `body`, `protocolProfileBehavior`) к нам
 * не относится по построению — закрытый формат отверг бы каждый реальный
 * экспорт. Зато элемент `item`, который не удалось прочитать ни как папку, ни
 * как запрос, — это ошибка, а не повод его пропустить: молча пропущенный
 * запрос становится непроверенным эндпоинтом в отчёте, который читается как
 * «нарушений нет».
 */

import { parse as parseYaml } from "yaml";
import type { Endpoint, HttpMethod } from "../core/types.js";
import type { SpecParser } from "./ports.js";

export interface PostmanCollectionLimits {
  /** Предельный размер входного текста в байтах. */
  readonly maxBytes: number;
  /**
   * Предел раскрытия YAML-алиасов.
   *
   * Защита от billion laughs: библиотека `yaml` считает раскрытия и прерывает
   * разбор сама, до того как документ развернётся в памяти. JSON алиасов не
   * знает, но разбирается тем же парсером, поэтому предел нужен и здесь.
   */
  readonly maxAliasCount: number;
  /** Предельная глубина вложенности папок. */
  readonly maxFolderDepth: number;
}

export const DEFAULT_POSTMAN_LIMITS: PostmanCollectionLimits = {
  // Коллекции хранят сохранённые примеры ответов и вырастают заметно больше
  // ручного списка — предел взят как у спецификаций.
  maxBytes: 5_000_000,
  maxAliasCount: 100,
  maxFolderDepth: 16,
};

export class PostmanCollectionTooLargeError extends Error {
  constructor(actualBytes: number, maxBytes: number) {
    super(`The collection is ${actualBytes} bytes, the limit is ${maxBytes}`);
    this.name = "PostmanCollectionTooLargeError";
  }
}

export class PostmanCollectionTooDeepError extends Error {
  constructor(maxFolderDepth: number) {
    super(`Collection folder nesting exceeds the limit of ${maxFolderDepth}`);
    this.name = "PostmanCollectionTooDeepError";
  }
}

export class PostmanCollectionParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Could not parse the Postman collection: ${message}`, options);
    this.name = "PostmanCollectionParseError";
  }
}

export class UnsupportedPostmanSchemaError extends Error {
  readonly schema: string;

  constructor(schema: string) {
    super(
      `Collection schema "${schema}" is not supported: a Collection v2.0 or v2.1 export ` +
        `is required. The v1 format describes requests differently, and reading it as v2 ` +
        `means reading it wrong.`,
    );
    this.name = "UnsupportedPostmanSchemaError";
    this.schema = schema;
  }
}

/**
 * Коллекция без запросов — ошибка, а не вырожденный случай.
 *
 * Ноль эндпоинтов даёт отчёт «расхождений нет» при том, что не проверено
 * ничего. Такой результат неотличим от успешного и потому опаснее сбоя.
 */
export class EmptyPostmanCollectionError extends Error {
  constructor() {
    super(
      "The collection contains no requests. A run over an empty list produces a report " +
        "with no findings, which reads as «nothing is broken» while nothing was tested.",
    );
    this.name = "EmptyPostmanCollectionError";
  }
}

/** Поле элемента, на котором споткнулась проверка. */
export type PostmanItemField = "item" | "name" | "request" | "method" | "url" | "path";

export class InvalidPostmanItemError extends Error {
  /** Путь до элемента в дереве папок — он же будущий id эндпоинта. */
  readonly location: string;
  readonly field: PostmanItemField;

  constructor(location: string, field: PostmanItemField, reason: string) {
    super(`Collection item "${location}": ${reason}`);
    this.name = "InvalidPostmanItemError";
    this.location = location;
    this.field = field;
  }
}

export class DuplicatePostmanEndpointIdError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(
      `Request "${id}" appears in the collection twice. The access policy references ` +
        `endpoints by id, and a duplicate would make its interpretation ambiguous. ` +
        `Rename one of the requests or put them in different folders.`,
    );
    this.name = "DuplicatePostmanEndpointIdError";
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

/** Схемы, которые адаптер берётся читать. */
const SUPPORTED_SCHEMA = /\/collection\/v2\.[01]\./;

/** Имя параметра пути. Тот же набор символов, что у имён в OpenAPI. */
const PARAMETER_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Путь, в котором фигурные скобки встречаются только как `{имя}`.
 *
 * Незакрытая или пустая скобка означает, что переменную не удалось прочитать.
 * Пропустить её означало бы отправить в ядро параметр с именем, которого автор
 * не писал, — а такой параметр не покроет ни один объявленный объект.
 */
const TEMPLATE_ONLY = /^(?:[^{}]|\{[A-Za-z0-9_.-]+\})*$/;

/** Переменная Postman внутри пути. */
const POSTMAN_VARIABLE = /\{\{([^{}]*)\}\}/g;

/** Ведущие переменные Postman: `{{baseUrl}}`, `{{host}}{{basePath}}`. */
const LEADING_VARIABLES = /^(?:\{\{[^{}]*\}\})+/;

/** `scheme://authority`, `://authority` и `//authority` одним выражением. */
const ORIGIN_PREFIX = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*)?:?\/\//;

/**
 * База для проверки того, что путь остаётся в пределах цели.
 *
 * Настоящий базовый URL адаптеру неизвестен и не нужен: важно не куда именно
 * ведёт путь, а способен ли он вообще выбрать хост. Сравнение origin с любой
 * базой отвечает на этот вопрос.
 */
const PLACEHOLDER_BASE = "http://target.invalid/";

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

function locationOf(trail: readonly string[]): string {
  return trail.length === 0 ? "<collection root>" : trail.join("/");
}

/**
 * Приводит сегмент пути к записи параметров ядра.
 *
 * Переменная Postman `{{playerId}}` — не то же самое, что параметр OpenAPI
 * `{playerId}`, но для barbican это один и тот же факт: значение сегмента
 * отложено и должно прийти извне. Поэтому обе записи, а вместе с ними и родная
 * постмановская `:playerId`, сводятся к `{playerId}`.
 *
 * Оставить `{{playerId}}` как есть было нельзя. Ядро вычленяет параметры
 * выражением `/\{([^}]+)\}/`, и на `{{playerId}}` оно даёт параметр с именем
 * `{playerId` — имя, которого автор не писал и которое не покроет ни один
 * объявленный объект. Такой эндпоинт выпал бы из прогона, а подстановка в
 * `runner.substitute` собрала бы из него мусорный путь. Сведение к `{playerId}`
 * оставляет ровно два честных исхода: объект с этим параметром объявлен — и
 * эндпоинт проверяется; не объявлен — и он попадает в пропуски с причиной
 * `path-parameters`, то есть виден оператору, а не потерян.
 *
 * Обратная сторона решения: `{{baseUrl}}` в середине пути тоже станет
 * параметром. Это верно по сути — сегмент с неизвестным значением проверять
 * нечем, — и заметно в отчёте, в отличие от молчаливой подстановки.
 */
function toTemplateSegment(segment: string): string {
  // `:playerId` — родная запись параметра пути в Postman. Сегмент, начинающийся
  // с двоеточия, но не похожий на имя, остаётся литералом: двоеточие само по
  // себе в пути допустимо.
  if (segment.startsWith(":") && PARAMETER_NAME.test(segment.slice(1))) {
    return `{${segment.slice(1)}}`;
  }
  return segment.replace(POSTMAN_VARIABLE, "{$1}");
}

/**
 * Проверяет, что путь не способен выбрать хост.
 *
 * Правило то же, что в прогоне (`runner.joinUrl`): склейка с базой обязана
 * остаться на её origin. Проверка здесь дублирует проверку там намеренно —
 * путь вида `/https://evil.test/x` формально начинается со слэша и мимо более
 * простых условий проходит.
 */
function assertStaysWithinTarget(path: string, location: string): void {
  const base = new URL(PLACEHOLDER_BASE);
  let resolved: URL;
  try {
    resolved = new URL(path.replace(/^[/\\]+/, ""), base);
  } catch (cause) {
    throw new InvalidPostmanItemError(
      location,
      "path",
      `path ${JSON.stringify(path)} could not be parsed as a URL: ${describe(cause)}`,
    );
  }
  if (resolved.origin !== base.origin) {
    throw new InvalidPostmanItemError(
      location,
      "path",
      `path ${JSON.stringify(path)} addresses ${resolved.origin}, not a path on the host under test`,
    );
  }
}

/**
 * Доводит путь до вида, в котором его принимает ядро.
 *
 * Ведущий слэш здесь не проверяется: каждый источник пути гарантирует его сам —
 * сегменты склеиваются через `/`, строковый путь дополняется, а из `raw` путь
 * без слэша не выпускается вовсе. Проверка, которую нечем нарушить, только
 * создавала бы видимость защиты.
 */
function normalizePath(path: string, location: string): string {
  const converted = path.split("/").map(toTemplateSegment).join("/");

  // `//host/x` — схемо-относительный URL: он адресует другой хост, а не путь
  // на проверяемом. Область проверки задаётся allowlist'ом и не должна
  // расширяться формой записи пути.
  if (converted.startsWith("//")) {
    throw new InvalidPostmanItemError(
      location,
      "path",
      `path "${converted}" addresses another host (a scheme-relative URL)`,
    );
  }
  if (!TEMPLATE_ONLY.test(converted)) {
    throw new InvalidPostmanItemError(
      location,
      "path",
      `path "${converted}" contains an unclosed or empty brace; a Postman variable is ` +
        `written as {{name}}, a path parameter as {name}`,
    );
  }
  assertStaysWithinTarget(converted, location);

  return converted;
}

/**
 * Выделяет путь из `request.url.raw`.
 *
 * Хост, схема и порт отбрасываются, а не сверяются: цель прогона задаётся
 * конфигурацией, и документ не должен участвовать в выборе адресата. Строка
 * запроса и фрагмент тоже отбрасываются — эндпоинт здесь шаблон без значений,
 * а параметры запроса объявляет человек (`Resource.query`).
 */
function pathFromRaw(raw: string, location: string): string {
  const withoutQuery = raw.trim().replace(/[?#][\s\S]*$/, "");
  const withoutVariables = withoutQuery.replace(LEADING_VARIABLES, "");

  let rest = withoutVariables;
  const origin = ORIGIN_PREFIX.exec(rest);
  if (origin !== null) {
    const afterOrigin = rest.slice(origin[0].length);
    const slash = afterOrigin.indexOf("/");
    rest = slash === -1 ? "" : afterOrigin.slice(slash);
  }

  if (rest === "") {
    return "/";
  }
  if (!rest.startsWith("/")) {
    throw new InvalidPostmanItemError(
      location,
      "url",
      `could not extract a path from ${JSON.stringify(raw)}: a slash was expected after ` +
        `the base. Set "url.path" or start the path with a slash.`,
    );
  }
  return rest;
}

/**
 * Собирает путь из `request.url.path`.
 *
 * Возвращает `undefined`, если поля нет или оно пусто, — тогда путь берётся
 * из `raw`.
 */
function pathFromSegments(segments: unknown, location: string): string | undefined {
  if (typeof segments === "string") {
    const trimmed = segments.trim();
    if (trimmed === "") {
      return undefined;
    }
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== "string") {
      throw new InvalidPostmanItemError(
        location,
        "path",
        `path segment ${JSON.stringify(segment)} is not a string`,
      );
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

function pathOf(url: unknown, location: string): string {
  if (typeof url === "string") {
    if (url.trim() === "") {
      throw new InvalidPostmanItemError(location, "url", '"request.url" is empty');
    }
    return normalizePath(pathFromRaw(url, location), location);
  }
  if (!isRecord(url)) {
    throw new InvalidPostmanItemError(
      location,
      "url",
      '"request.url" is missing or is neither a string nor an object',
    );
  }

  const fromSegments = pathFromSegments(url.path, location);
  if (fromSegments !== undefined) {
    return normalizePath(fromSegments, location);
  }

  const raw = url.raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    return normalizePath(pathFromRaw(raw, location), location);
  }
  throw new InvalidPostmanItemError(
    location,
    "path",
    '"request.url" has neither a non-empty "path" nor a "raw"',
  );
}

function toEndpoint(request: unknown, trail: readonly string[]): Endpoint {
  const location = locationOf(trail);

  // Сокращённая запись `"request": "https://..."` схемой допускается и читается
  // как GET по умолчанию. Догадка о методе в инструменте, который без явного
  // флага не выполняет ничего кроме GET и HEAD, слишком дорога: она тихо решает
  // за автора, что именно проверяется.
  if (!isRecord(request)) {
    throw new InvalidPostmanItemError(
      location,
      "request",
      '"request" must be an object with method and url fields',
    );
  }

  const rawMethod = request.method;
  if (typeof rawMethod !== "string") {
    throw new InvalidPostmanItemError(
      location,
      "method",
      `"request.method" is required and must be a string; allowed: ${METHOD_NAMES}`,
    );
  }
  const method = toMethod(rawMethod);
  if (method === undefined) {
    throw new InvalidPostmanItemError(
      location,
      "method",
      `method "${rawMethod}" is not supported; allowed: ${METHOD_NAMES}`,
    );
  }

  return { id: location, method, path: pathOf(request.url, location) };
}

/**
 * Обходит дерево элементов вглубь, сохраняя порядок объявления.
 *
 * Идентификатор эндпоинта — путь по папкам плюс имя запроса. Одного лишь
 * `name` не хватает: одноимённые запросы в разных папках — обычное дело для
 * коллекции, а для политики доступа это два разных эндпоинта. Дописывать к
 * повторам порядковый номер было бы хуже отказа: номер зависит от порядка
 * элементов, и перестановка в коллекции молча переадресовала бы строку
 * политики на другой запрос.
 */
function collectItems(
  items: readonly unknown[],
  trail: readonly string[],
  depth: number,
  limits: PostmanCollectionLimits,
  out: Endpoint[],
): void {
  if (depth > limits.maxFolderDepth) {
    throw new PostmanCollectionTooDeepError(limits.maxFolderDepth);
  }

  for (const item of items) {
    if (!isRecord(item)) {
      throw new InvalidPostmanItemError(
        locationOf(trail),
        "item",
        `item ${JSON.stringify(item)} must be an object with a name field`,
      );
    }

    const name = item.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new InvalidPostmanItemError(
        locationOf(trail),
        "name",
        "the item has no non-empty name, and an endpoint identifier is built from names",
      );
    }
    const nested = [...trail, name.trim()];

    const children = item.item;
    const request = item.request;
    if (children !== undefined && request !== undefined) {
      throw new InvalidPostmanItemError(
        locationOf(nested),
        "item",
        'the item has both "item" and "request" — whether it is a folder or a request cannot be determined',
      );
    }

    if (children !== undefined) {
      if (!Array.isArray(children)) {
        throw new InvalidPostmanItemError(locationOf(nested), "item", '"item" must be a list');
      }
      collectItems(children, nested, depth + 1, limits, out);
      continue;
    }

    if (request === undefined) {
      throw new InvalidPostmanItemError(
        locationOf(nested),
        "request",
        'the item has neither "item" (a folder) nor "request" (a request)',
      );
    }

    out.push(toEndpoint(request, nested));
  }
}

function assertUniqueIds(endpoints: readonly Endpoint[]): void {
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.id)) {
      throw new DuplicatePostmanEndpointIdError(endpoint.id);
    }
    seen.add(endpoint.id);
  }
}

/**
 * Создаёт парсер коллекций Postman.
 *
 * Пределы можно ужесточить, но не отключить: значения по умолчанию —
 * консервативные, а не рекомендательные.
 */
export function createPostmanCollectionParser(
  limits: Partial<PostmanCollectionLimits> = {},
): SpecParser {
  const effective: PostmanCollectionLimits = { ...DEFAULT_POSTMAN_LIMITS, ...limits };

  return {
    // Асинхронность — требование порта `SpecParser`. Здесь она заодно превращает
    // любой отказ в отклонённый промис, а не в синхронное исключение.
    async parse(source: string): Promise<readonly Endpoint[]> {
      const bytes = Buffer.byteLength(source, "utf8");
      if (bytes > effective.maxBytes) {
        throw new PostmanCollectionTooLargeError(bytes, effective.maxBytes);
      }

      let document: unknown;
      try {
        // Коллекции экспортируются в JSON, а JSON — подмножество YAML 1.2,
        // поэтому отдельный парсер не нужен, а `maxAliasCount` достаётся даром.
        document = parseYaml(source, { maxAliasCount: effective.maxAliasCount });
      } catch (cause) {
        throw new PostmanCollectionParseError(describe(cause), { cause });
      }

      if (!isRecord(document)) {
        throw new PostmanCollectionParseError('the document is not an object with an "item" key');
      }

      const info = document.info;
      if (
        isRecord(info) &&
        typeof info.schema === "string" &&
        !SUPPORTED_SCHEMA.test(info.schema)
      ) {
        throw new UnsupportedPostmanSchemaError(info.schema);
      }

      const items = document.item;
      if (!Array.isArray(items)) {
        throw new PostmanCollectionParseError('the "item" key is missing or is not a list');
      }

      const endpoints: Endpoint[] = [];
      collectItems(items, [], 0, effective, endpoints);
      if (endpoints.length === 0) {
        throw new EmptyPostmanCollectionError();
      }
      assertUniqueIds(endpoints);

      return endpoints;
    },
  };
}

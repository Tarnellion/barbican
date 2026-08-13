/**
 * Разбор OpenAPI-спецификации в список эндпоинтов.
 *
 * Три барьера против недоверенного документа. Они закрывают разные проблемы —
 * это проверено экспериментом, а не выведено из общих соображений:
 *
 * 1. Парсер не знает путей. На вход подаётся текст, а не путь к файлу, поэтому
 *    относительным `$ref` не от чего отсчитываться, а сам адаптер не открывает
 *    ничего в файловой системе.
 * 2. Внешние `$ref` отвергаются явной ошибкой до того, как документ попадёт
 *    в swagger-parser. Это защита не от SSRF, а от **тихой деградации**: при
 *    отключённом барьере 2 swagger-parser возвращает результат без ошибки,
 *    оставив ссылку неразрешённой. Инструмент продолжил бы работу на неполном
 *    списке эндпоинтов и выдал «расхождений нет» там, где проверка не состоялась.
 * 3. `resolve.external = false` — собственно защита от SSRF. Проверено отдельно:
 *    со снятым барьером 2 запрос к адресу из `$ref` всё равно не уходит.
 *
 * Обоснование — ADR-0005. Тесты-доказательства обязательны и не подлежат `skip`.
 */

import SwaggerParser from "@apidevtools/swagger-parser";
import { parse as parseYaml } from "yaml";
import type { Endpoint, HttpMethod } from "../core/types.js";
import type { SpecParser } from "./ports.js";

export interface SpecParserLimits {
  /** Предельный размер входного текста в байтах. */
  readonly maxBytes: number;
  /**
   * Предел раскрытия YAML-алиасов.
   *
   * Защита от billion laughs: документ в несколько килобайт способен развернуться
   * в гигабайты. Библиотека `yaml` считает раскрытия и бросает ошибку сама.
   */
  readonly maxAliasCount: number;
  /** Предельная глубина вложенности документа. */
  readonly maxDepth: number;
}

export const DEFAULT_SPEC_LIMITS: SpecParserLimits = {
  maxBytes: 5_000_000,
  maxAliasCount: 100,
  maxDepth: 64,
};

export class SpecTooLargeError extends Error {
  constructor(actualBytes: number, maxBytes: number) {
    super(`The specification document is ${actualBytes} bytes, the limit is ${maxBytes}`);
    this.name = "SpecTooLargeError";
  }
}

export class SpecTooDeepError extends Error {
  constructor(maxDepth: number) {
    super(`Document nesting exceeds the limit of ${maxDepth}`);
    this.name = "SpecTooDeepError";
  }
}

export class ExternalRefError extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super(
      `External reference "${ref}" is not resolved: this guards against SSRF and path ` +
        `traversal. Flatten the specification into a single file before testing.`,
    );
    this.name = "ExternalRefError";
    this.ref = ref;
  }
}

export class SpecParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Could not parse the specification: ${message}`, options);
    this.name = "SpecParseError";
  }
}

const HTTP_METHODS = ["get", "head", "post", "put", "patch", "delete", "options"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Проверяет форму документа: глубину и отсутствие внешних `$ref`.
 *
 * Узлы, пройденные однажды, повторно не обходятся: YAML-алиасы порождают общие
 * поддеревья, и наивный обход по ним сам стал бы источником экспоненциального
 * разрастания. Раскрытие алиасов при этом уже ограничено `maxAliasCount`.
 */
export class UnsupportedYamlTagError extends Error {
  constructor(tag: string) {
    super(
      `The specification contains a node tagged ${tag}. OpenAPI cannot contain such ` +
        `a node: it is a JSON-compatible structure. Parsing stopped because such ` +
        `a node is invisible to the walk — an external reference under it would ` +
        `slip past the check, and a path list under it would yield zero endpoints ` +
        `without a single error, that is, a hundred percent coverage of nothing.`,
    );
    this.name = "UnsupportedYamlTagError";
  }
}

function assertSafeShape(root: unknown, limits: SpecParserLimits): void {
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > limits.maxDepth) {
      throw new SpecTooDeepError(limits.maxDepth);
    }
    if (!isRecord(node) || seen.has(node)) {
      return;
    }
    seen.add(node);

    // Узлы, которых не бывает в OpenAPI и которые обход не видит: YAML-теги
    // `!!omap`, `!!set`, `!!pairs` дают Map и Set, а `Object.values` по ним
    // не идёт. Найдено состязательной проверкой, и находка двойная: внешний
    // `$ref` под таким тегом проезжал мимо барьера, а `paths` под ним давал
    // **ноль эндпоинтов без единой ошибки** — покрытие 1/1, то есть 100%
    // от пустоты. Psych такие документы эмитирует штатно.
    //
    // Отвергается, а не обходится глубже: OpenAPI — это JSON-совместимая
    // структура, и упорядоченная карта в ней означает либо ошибку выгрузки,
    // либо попытку спрятать узел от разбора. Оба случая — повод остановиться.
    if (node instanceof Map || node instanceof Set) {
      throw new UnsupportedYamlTagError(node instanceof Map ? "!!omap" : "!!set");
    }

    const ref = node.$ref;
    if (typeof ref === "string" && !ref.startsWith("#")) {
      throw new ExternalRefError(ref);
    }

    for (const value of Object.values(node)) {
      walk(value, depth + 1);
    }
  };

  walk(root, 0);
}

function toEndpoints(document: unknown): readonly Endpoint[] {
  if (!isRecord(document)) {
    throw new SpecParseError("the document is not an object");
  }

  const paths = document.paths;
  if (!isRecord(paths)) {
    return [];
  }

  const endpoints: Endpoint[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) {
        continue;
      }

      const upper = method.toUpperCase() as HttpMethod;
      const rawId = operation.operationId;
      const operationId = typeof rawId === "string" && rawId.length > 0 ? rawId : undefined;

      endpoints.push(
        operationId === undefined
          ? { id: `${upper} ${path}`, method: upper, path }
          : { id: operationId, method: upper, path, operationId },
      );
    }
  }
  return endpoints;
}

/**
 * Создаёт парсер спецификаций.
 *
 * Пределы можно ужесточить, но не отключить: значения по умолчанию —
 * консервативные, а не рекомендательные.
 */
export function createOpenApiParser(limits: Partial<SpecParserLimits> = {}): SpecParser {
  const effective: SpecParserLimits = { ...DEFAULT_SPEC_LIMITS, ...limits };

  return {
    async parse(source: string): Promise<readonly Endpoint[]> {
      const bytes = Buffer.byteLength(source, "utf8");
      if (bytes > effective.maxBytes) {
        throw new SpecTooLargeError(bytes, effective.maxBytes);
      }

      let document: unknown;
      try {
        // JSON — подмножество YAML 1.2, поэтому один парсер покрывает оба формата.
        document = parseYaml(source, { maxAliasCount: effective.maxAliasCount });
      } catch (cause) {
        throw new SpecParseError(describe(cause), { cause });
      }

      assertSafeShape(document, effective);

      let dereferenced: unknown;
      try {
        dereferenced = await SwaggerParser.dereference(
          document as Parameters<typeof SwaggerParser.dereference>[0],
          { resolve: { external: false } },
        );
      } catch (cause) {
        // ExternalRefError сюда попасть не может: assertSafeShape отработал выше.
        throw new SpecParseError(describe(cause), { cause });
      }

      return toEndpoints(dereferenced);
    },
  };
}

/**
 * Скалярные сигналы над телом ответа.
 *
 * Тело читается транзитно, в памяти этого модуля, и здесь же умирает. Наружу
 * уходят только необратимые свёртки — число или булево. Обоснование и границы
 * решения: ADR-0011.
 *
 * Правило, которое легко нарушить незаметно: `SignalValue` не должен получить
 * строковый вариант. Строка вмещает тело целиком, и гарантия «в отчёте нет PII»
 * из конструктивной превратилась бы в дисциплинарную.
 */

import { createHash, randomBytes } from "node:crypto";
import type { SignalSpec, SignalValue } from "./ports.js";

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/**
 * Сколько байт дайджеста оставляем.
 *
 * Шесть байт — 48 бит: помещается в безопасное целое JavaScript, что позволяет
 * держать `SignalValue` числовым. На прогоне в тысячу ответов вероятность
 * коллизии порядка 10⁻⁹.
 */
const DIGEST_BYTES = 6;

export class InvalidSignalSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSignalSpecError";
  }
}

/**
 * Разбирает путь на сегменты.
 *
 * Синтаксис намеренно минимален: сегменты через точку. Ни wildcard, ни выражений —
 * это вычислитель над данными с чужого стенда, и его поверхность должна быть
 * нулевой. Пустой путь означает корень.
 */
export function parseSignalPath(path: string): readonly string[] {
  if (path === "") {
    return [];
  }
  const segments = path.split(".");
  if (segments.some((segment) => segment === "")) {
    throw new InvalidSignalSpecError(`Path "${path}" contains an empty segment`);
  }
  return segments;
}

/**
 * Идёт по пути внутри разобранного тела.
 *
 * `Object.hasOwn`, а не проверка на `undefined`: тело приходит с чужого стенда,
 * и `{"constructor": …}` или `{"toString": …}` иначе находились бы через цепочку
 * прототипов. Та же ошибка уже была допущена в связывании объектов с эндпоинтами.
 */
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function resolvePath(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (Array.isArray(current)) {
      // Числовой сегмент индексирует список. Без этого `present` отвечал `false`
      // на поле, которое в ответе есть, — а неверный сигнал неотличим от
      // честного «поля нет». Целый класс BOPLA («в отчёте появилась колонка
      // с почтой») из-за этого не проверялся. Расширения `SignalValue` не нужно.
      if (!ARRAY_INDEX.test(segment)) {
        return undefined;
      }
      current = current[Number(segment)];
      continue;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Читает тело не более чем `maxBodyBytes`.
 *
 * При превышении возвращает `undefined`, а не префикс. Дайджест по префиксу
 * утверждал бы совпадение двух ответов, различающихся за границей отсечки, —
 * это хуже, чем отсутствие сигнала.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBodyBytes: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export interface SignalExtractor {
  /**
   * Вычисляет объявленные сигналы, читая тело.
   *
   * Возвращает только скаляры. Тело не возвращается, не запоминается
   * и не логируется ни при каком исходе.
   */
  extract(
    body: ReadableStream<Uint8Array> | null,
    specs: readonly SignalSpec[],
  ): Promise<Readonly<Record<string, SignalValue>>>;
}

export interface SignalExtractorOptions {
  readonly maxBodyBytes?: number;
  /**
   * Соль дайджеста. По умолчанию случайная на каждый прогон.
   *
   * Без соли дайджест ответа с предсказуемым телом (`{"error":"forbidden"}`
   * и подобных) подбирается перебором, и отчёт начинает подтверждать догадки
   * о содержимом. Параметр существует ради воспроизводимости тестов.
   */
  readonly salt?: Uint8Array;
}

export function createSignalExtractor(options: SignalExtractorOptions = {}): SignalExtractor {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new InvalidSignalSpecError("The body size cap must be a positive integer");
  }
  const salt = options.salt ?? randomBytes(32);

  // Пути разбираются заранее: ошибка в конфигурации должна падать на старте,
  // а не на середине прогона против чужого стенда.
  function segmentsFor(spec: SignalSpec): readonly string[] {
    return spec.kind === "digest" ? [] : parseSignalPath(spec.path);
  }

  return {
    async extract(
      body: ReadableStream<Uint8Array> | null,
      specs: readonly SignalSpec[],
    ): Promise<Readonly<Record<string, SignalValue>>> {
      const signals: Record<string, SignalValue> = {};
      if (specs.length === 0 || body === null) {
        await body?.cancel();
        return signals;
      }

      const paths = new Map(specs.map((spec) => [spec.name, segmentsFor(spec)]));

      const bytes = await readCapped(body, maxBodyBytes);
      if (bytes === undefined) {
        // Тело больше потолка: сигналы недоступны. Пустой набор, а не догадки.
        return signals;
      }

      const needsJson = specs.some((spec) => spec.kind !== "digest");
      let parsed: unknown;
      let parsedOk = false;
      if (needsJson) {
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
          parsedOk = true;
        } catch {
          // Не JSON — сигналы по путям недоступны. Дайджест по байтам работает.
          parsedOk = false;
        }
      }

      for (const spec of specs) {
        if (spec.kind === "digest") {
          const hash = createHash("sha256").update(salt).update(bytes).digest();
          let value = 0;
          for (let index = 0; index < DIGEST_BYTES; index += 1) {
            value = value * 256 + (hash[index] ?? 0);
          }
          signals[spec.name] = value;
          continue;
        }

        if (!parsedOk) {
          continue;
        }
        const target = resolvePath(parsed, paths.get(spec.name) ?? []);

        if (spec.kind === "present") {
          signals[spec.name] = target !== undefined;
          continue;
        }
        // count: не массив — сигнала нет. Ноль был бы утверждением о пустоте,
        // которого мы не делали.
        if (Array.isArray(target)) {
          signals[spec.name] = target.length;
        }
      }

      return signals;
    },
  };
}

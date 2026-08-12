/**
 * HTTP-клиент на встроенном global fetch.
 *
 * Отдельный undici не ставится: в Node 22 fetch и так работает поверх него,
 * а нам не нужны ни интерсепторы, ни пулы соединений.
 *
 * Ограничения, встроенные в конструкцию, а не оставленные на дисциплину вызова:
 *
 * - Тело ответа **не читается никогда**. Поток отменяется, чтобы освободить
 *   соединение. В теле данные клиента, и путь, по которому они попали бы
 *   в отчёт, отсутствует физически.
 * - Обязательный allowlist хостов. Пустой список — ошибка, а не «разрешить всё».
 * - Редиректы не выполняются (`redirect: "manual"`). Переход по 3xx на другой
 *   хост увёл бы запрос за пределы allowlist — это SSRF в обход проверки.
 * - Без явного разрешения выполняются только методы из `SAFE_METHODS`.
 * - Чувствительные заголовки ответа редактируются по хардкод-списку.
 */

import type { HttpMethod } from "../core/types.js";
import { SAFE_METHODS } from "../core/types.js";
import type { HttpClient, HttpRequest, HttpResponse, Throttle } from "./ports.js";
import type { Clock } from "./throttle.js";
import { systemClock } from "./throttle.js";

/**
 * Заголовки ответа, значения которых сохраняются. **Всё остальное редактируется.**
 *
 * Именно allowlist, а не denylist. Состязательная проверка показала, что список
 * запрещённых имён неверен структурно: мимо него проходили `x-auth-token`,
 * `authentication-info`, `x-amz-security-token` и `x-user-email` с почтой клиента.
 * Перечислить все имена, которые когда-либо понесут секрет, нельзя — а перечислить
 * те немногие, что нужны для вердикта о доступе, можно.
 *
 * Список задаётся здесь и никогда не берётся из пользовательского ввода.
 */
const VALUE_PRESERVED_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "allow",
  "retry-after",
  "www-authenticate",
]);

/**
 * `location` полезен для разбора 3xx, но его query и фрагмент несут токены:
 * OAuth-редирект возвращает `access_token` именно во фрагменте. Сохраняем
 * только адрес без параметров.
 */
function sanitizeLocation(value: string): string {
  try {
    const url = new URL(value, "https://placeholder.invalid");
    const path = `${url.origin === "https://placeholder.invalid" ? "" : url.origin}${url.pathname}`;
    return url.search === "" && url.hash === "" ? path : `${path}?[REDACTED]`;
  } catch {
    return REDACTED;
  }
}

const REDACTED = "[REDACTED]";

export interface RetryPolicy {
  /** Всего попыток, включая первую. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export interface BreakerPolicy {
  /** После скольких подряд неудачных ответов прогон останавливается. */
  readonly consecutiveFailures: number;
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = { consecutiveFailures: 5 };

export const DEFAULT_TIMEOUT_MS = 15_000;

export class EmptyScopeError extends Error {
  constructor() {
    super(
      "Не задан allowlist хостов. Инструмент не работает без явно очерченной области: " +
        "прогон против незаявленного хоста — это не проверка, а сканирование чужой системы.",
    );
    this.name = "EmptyScopeError";
  }
}

export class HostNotAllowedError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Хост "${host}" вне заданной области проверки`);
    this.name = "HostNotAllowedError";
    this.host = host;
  }
}

export class UnsupportedProtocolError extends Error {
  constructor(protocol: string) {
    super(`Протокол "${protocol}" не поддерживается: допустимы только http и https`);
    this.name = "UnsupportedProtocolError";
  }
}

export class UnsafeMethodError extends Error {
  readonly method: HttpMethod;

  constructor(method: HttpMethod) {
    super(
      `Метод ${method} изменяет состояние и запрещён по умолчанию. ` +
        `Разрешается только явным включением небезопасных методов.`,
    );
    this.name = "UnsafeMethodError";
    this.method = method;
  }
}

export class CircuitOpenError extends Error {
  constructor(failures: number) {
    super(
      `Прогон остановлен после ${failures} неудачных ответов подряд. ` +
        `Продолжать — значит добивать систему, которой и так плохо.`,
    );
    this.name = "CircuitOpenError";
  }
}

export class RequestFailedError extends Error {
  constructor(url: string, attempts: number, options?: { cause: unknown }) {
    super(`Обращение к "${url}" не удалось за ${attempts} попыток`, options);
    this.name = "RequestFailedError";
  }
}

export interface HttpClientOptions {
  /** Хосты, к которым разрешено обращаться. Пустой список отвергается. */
  readonly allowedHosts: readonly string[];
  readonly throttle: Throttle;
  readonly allowUnsafeMethods?: boolean;
  readonly retry?: Partial<RetryPolicy>;
  readonly breaker?: Partial<BreakerPolicy>;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
  /** Источник случайности для джиттера. Отдельно — чтобы тесты были воспроизводимы. */
  readonly random?: () => number;
}

const SAFE: ReadonlySet<string> = new Set<string>(SAFE_METHODS);

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Разбирает `Retry-After`: и в секундах, и в виде HTTP-даты. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds <= 0 ? 0 : seconds * 1000;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - now);
}

function toHttpResponse(response: Response): HttpResponse {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    // Имя сохраняется даже у отредактированных: факт присутствия заголовка —
    // сигнал для разбора прогона, а его значение — нет.
    if (VALUE_PRESERVED_HEADERS.has(key)) {
      headers[key] = value;
    } else if (key === "location") {
      headers[key] = sanitizeLocation(value);
    } else {
      headers[key] = REDACTED;
    }
  });
  return { status: response.status, headers };
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.trim().toLowerCase()));
  allowedHosts.delete("");
  if (allowedHosts.size === 0) {
    throw new EmptyScopeError();
  }

  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const breaker: BreakerPolicy = { ...DEFAULT_BREAKER_POLICY, ...options.breaker };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const allowUnsafeMethods = options.allowUnsafeMethods ?? false;

  let consecutiveFailures = 0;
  let circuitOpen = false;

  function assertRequestAllowed(request: HttpRequest): void {
    if (!allowUnsafeMethods && !SAFE.has(request.method)) {
      throw new UnsafeMethodError(request.method);
    }

    const url = new URL(request.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new UnsupportedProtocolError(url.protocol);
    }
    if (!allowedHosts.has(url.hostname.toLowerCase())) {
      throw new HostNotAllowedError(url.hostname);
    }
  }

  function backoffFor(attempt: number): number {
    const exponential = retry.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(retry.maxDelayMs, exponential);
    // Полный джиттер: без него параллельные попытки повторяются синхронно.
    return Math.round(capped * random());
  }

  async function attemptOnce(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      // Редирект не выполняется: 3xx на чужой хост обошёл бы allowlist.
      redirect: "manual",
      signal: composed,
    });

    const result = toHttpResponse(response);
    // Тело не читается: там PII. Поток отменяется, чтобы освободить соединение.
    await response.body?.cancel();
    return result;
  }

  return {
    async send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
      assertRequestAllowed(request);
      if (circuitOpen) {
        throw new CircuitOpenError(breaker.consecutiveFailures);
      }

      let lastCause: unknown;

      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        let response: HttpResponse | undefined;
        try {
          response = await options.throttle.run(() => attemptOnce(request, signal));
        } catch (cause) {
          lastCause = cause;
        }

        if (response !== undefined && !isRetryableStatus(response.status)) {
          consecutiveFailures = 0;
          return response;
        }

        consecutiveFailures += 1;
        if (consecutiveFailures >= breaker.consecutiveFailures) {
          circuitOpen = true;
          throw new CircuitOpenError(breaker.consecutiveFailures);
        }

        if (attempt === retry.maxAttempts) {
          if (response !== undefined) {
            return response;
          }
          break;
        }

        const advised =
          response === undefined
            ? undefined
            : parseRetryAfter(response.headers["retry-after"] ?? null, clock.now());
        // Указание сервера приоритетнее нашей формулы — но не выше нашего потолка.
        // Без ограничения огромный Retry-After снимал выдержку целиком: setTimeout
        // зажимает значения свыше 2^31-1 мс до одной миллисекунды, и три попытки
        // проходили за считанные миллисекунды вместо экспоненциального backoff.
        const retryAfter = advised === undefined ? undefined : Math.min(advised, retry.maxDelayMs);
        await clock.sleep(retryAfter ?? backoffFor(attempt));
      }

      throw new RequestFailedError(request.url, retry.maxAttempts, { cause: lastCause });
    },
  };
}

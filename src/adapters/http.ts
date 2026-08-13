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
import type { SignalExtractor } from "./signals.js";
import { createSignalExtractor } from "./signals.js";
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
  // Добавлены по итогам холодного чтения отчёта. Оба не несут учётных данных,
  // и оба редактировались зря — с прямым ущербом для разбора находки:
  //
  // `cache-control` меняет ОЦЕНКУ УЩЕРБА межтенантной утечки: ответ с чужими
  // данными и `public` размножается через CDN, и радиус поражения совсем иной.
  // `date` — единственная зацепка, чтобы сопоставить находку с логом сервера.
  "cache-control",
  "date",
  // Транспортный шум без секретов. Метка «отредактировано» на них создавала
  // ложное впечатление, что там было что-то чувствительное, и подрывала
  // доверие к списку целиком: если сюда попали эти, что ещё сюда попало?
  "connection",
  "keep-alive",
  "transfer-encoding",
  // Корреляция с логами платформы. Идентификаторы обращения — не учётные
  // данные: по ним ничего нельзя предъявить, зато без них находку нечем
  // сопоставить с записью на стороне платформы, а это первое, что спросит
  // команда, получившая тикет. Найдено третьим холодным чтением.
  "x-request-id",
  "x-correlation-id",
  "x-trace-id",
  "x-amzn-trace-id",
  "traceparent",
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
      "No host allowlist was given. The tool does not run without an explicitly drawn " +
        "scope: a run against an undeclared host is not testing, it is scanning " +
        "someone else's system.",
    );
    this.name = "EmptyScopeError";
  }
}

export class HostNotAllowedError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Host "${host}" is outside the declared scope`);
    this.name = "HostNotAllowedError";
    this.host = host;
  }
}

export class UnsupportedProtocolError extends Error {
  constructor(protocol: string) {
    super(`Protocol "${protocol}" is not supported: only http and https are allowed`);
    this.name = "UnsupportedProtocolError";
  }
}

export class UnsafeMethodError extends Error {
  readonly method: HttpMethod;

  constructor(method: HttpMethod) {
    super(
      `Method ${method} changes state and is forbidden by default. ` +
        `It is allowed only by explicitly enabling unsafe methods.`,
    );
    this.name = "UnsafeMethodError";
    this.method = method;
  }
}

export class CircuitOpenError extends Error {
  constructor(failures: number) {
    super(
      `The run stopped after ${failures} consecutive failed responses. ` +
        `Continuing would mean hammering a system that is already unwell.`,
    );
    this.name = "CircuitOpenError";
  }
}

/**
 * Убирает из адреса всё, что может нести секрет.
 *
 * Текст ошибки попадает в `failures[].reason`, то есть в JSON-отчёт. Полный URL
 * тащил туда query-параметры (`?api_key=…`) и учётные данные из userinfo.
 */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    const query = parsed.search === "" ? "" : "?[REDACTED]";
    return `${parsed.origin}${parsed.pathname}${query}`;
  } catch {
    return REDACTED;
  }
}

export class RequestFailedError extends Error {
  constructor(url: string, attempts: number, options?: { cause: unknown }) {
    super(`The request to "${safeUrl(url)}" failed after ${attempts} attempts`, options);
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
  /**
   * Вычислитель сигналов над телом. Тело читается только для тех обращений,
   * где сигналы объявлены явно; во всех остальных поток отменяется
   * непрочитанным, как было до ADR-0011.
   */
  readonly signalExtractor?: SignalExtractor;
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
  const signalExtractor = options.signalExtractor ?? createSignalExtractor();

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
    // Запись с портом сверяется вместе с портом, без порта — только по имени.
    // Так «api.test» по-прежнему разрешает любой порт, а «api.test:8443» —
    // ровно один, и уточнить область можно, не ломая уже написанные конфигурации.
    const hostname = url.hostname.toLowerCase();
    const hostWithPort = url.host.toLowerCase();
    if (!allowedHosts.has(hostname) && !allowedHosts.has(hostWithPort)) {
      throw new HostNotAllowedError(hostWithPort);
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

    const specs = request.signals ?? [];
    if (specs.length === 0) {
      // Тело не читается: там PII. Поток отменяется, чтобы освободить соединение.
      await response.body?.cancel();
      return result;
    }

    // Тело читается транзитно и остаётся внутри вычислителя. Наружу уходят
    // только скаляры: тип `SignalValue` физически не вмещает содержимое.
    const signals = await signalExtractor.extract(response.body, specs);
    return { ...result, signals };
  }

  return {
    async send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
      assertRequestAllowed(request);
      if (circuitOpen) {
        throw new CircuitOpenError(breaker.consecutiveFailures);
      }

      let lastCause: unknown;

      /**
       * Обращение считается неудачным один раз, а не на каждую попытку.
       *
       * Раньше счётчик рос внутри цикла повторов, и при дефолтах
       * (3 попытки, порог 5) прогон вставал после **двух** неудачных обращений
       * вместо пяти. Порог описан как «неудачных ответов подряд» — значит
       * считать надо ответы, а не наши собственные попытки их получить.
       */
      function markFailure(): void {
        consecutiveFailures += 1;
        if (consecutiveFailures >= breaker.consecutiveFailures) {
          circuitOpen = true;
        }
      }

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

        if (attempt === retry.maxAttempts) {
          markFailure();
          if (circuitOpen) {
            throw new CircuitOpenError(breaker.consecutiveFailures);
          }
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

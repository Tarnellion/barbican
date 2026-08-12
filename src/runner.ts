/**
 * Прогон: обход матрицы «аккаунт × эндпоинт» и сбор наблюдений.
 *
 * Не ядро — здесь ввод-вывод через порт `HttpClient`. И не адаптер — здесь нет
 * знания о конкретном транспорте. Это связывающий слой между ними.
 */

import type { HttpClient } from "./adapters/ports.js";
import type { AccessObservation, AccessOutcome, Account, Endpoint } from "./core/index.js";
import { SAFE_METHODS } from "./core/index.js";

/**
 * Эндпоинт, который не опрашивался, и почему.
 *
 * Пропуск по решению самого инструмента — не сбой. Раньше отказ от небезопасного
 * метода попадал в `failures`, и штатная работа выглядела в отчёте поломкой:
 * на реальном API каждый POST и PUT давал бы строку «сорвалось».
 */
export interface SkippedEndpoint {
  readonly endpointId: string;
  readonly reason: "path-parameters" | "unsafe-method" | "excluded";
}

/**
 * Сорванное обращение с причиной.
 *
 * Причина обязательна: `error` без объяснения не позволяет отличить лежащий
 * стенд от неверной конфигурации, и в отчёте такая запись бесполезна.
 */
export interface ProbeFailure {
  readonly accountId: string;
  readonly endpointId: string;
  readonly reason: string;
}

export interface CollectOptions {
  readonly baseUrl: string;
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  /** Токены по идентификатору аккаунта. В наблюдения не попадают. */
  readonly tokens: ReadonlyMap<string, string>;
  readonly client: HttpClient;
  readonly allowUnsafeMethods?: boolean;
  /**
   * Идентификаторы эндпоинтов, которые не трогать.
   *
   * `SAFE_METHODS` защищает от семантики метода, но не от эндпоинта, который её
   * нарушает: GET, сбрасывающий базу, остаётся GET. Такие адреса исключаются
   * поимённо — по-другому их не отличить.
   */
  readonly exclude?: readonly string[];
}

export interface CollectResult {
  readonly observations: readonly AccessObservation[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
  /**
   * Эндпоинты, которые действительно опрашивались.
   *
   * Матрица строится только из них: непройденный эндпоинт — это пробел покрытия,
   * уже перечисленный в `skipped`, а не расхождение на каждый аккаунт. Иначе один
   * пропуск порождает столько находок, сколько аккаунтов, и тонет настоящий сигнал.
   */
  readonly probed: readonly Endpoint[];
  /**
   * Аккаунты, у которых ВСЕ обращения вернули 401.
   *
   * Почти наверняка это неудачная аутентификация, а не результат политики.
   * Отличить важно: 401 трактуется как отказ, а отказ совпадает с ожиданием
   * там, где доступ и не положен, — и прогон, где мы никуда не вошли,
   * отрапортовал бы «эскалаций не найдено».
   */
  readonly unauthenticated: readonly string[];
}

const TEMPLATE_PARAMETER = /\{[^}]+\}/;

/**
 * Сводит статус ответа к выводу о доступе.
 *
 * Вывод делается только там, где он однозначен. Всё остальное — включая 3xx,
 * 4xx кроме перечисленных и 5xx — это `error`: «судить нельзя». Натянуть на них
 * `denied` означало бы записать отсутствие вывода как успешный отказ, а такие
 * записи потом читают как доказательство защищённости.
 */
export function classifyStatus(status: number): AccessOutcome {
  if (status >= 200 && status < 300) {
    return "allowed";
  }
  if (status === 401 || status === 403) {
    return "denied";
  }
  if (status === 404) {
    return "not-found";
  }
  return "error";
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(
    path.replace(/^\/+/, ""),
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

export interface CanaryResult {
  readonly accountId: string;
  readonly endpointId: string;
  readonly status: number;
  readonly authenticated: boolean;
}

export class UnknownCanaryEndpointError extends Error {
  constructor(accountId: string, endpointId: string) {
    super(`Канарейка аккаунта "${accountId}" ссылается на неизвестный эндпоинт "${endpointId}"`);
    this.name = "UnknownCanaryEndpointError";
  }
}

export class TemplatedCanaryError extends Error {
  constructor(accountId: string, endpointId: string) {
    super(
      `Канарейка аккаунта "${accountId}" указывает на "${endpointId}" с параметрами в пути. ` +
        `Подставить значение нечем — выберите эндпоинт без параметров.`,
    );
    this.name = "TemplatedCanaryError";
  }
}

/**
 * Проверяет, что аккаунты действительно аутентифицированы.
 *
 * Канарейка — эндпоинт, который аккаунту заведомо доступен. Если он отвечает
 * отказом, значит токен не работает, и продолжать бессмысленно: результат
 * такого прогона выглядит как «всё чисто», хотя не проверено ничего.
 */
export async function probeCanaries(options: {
  readonly baseUrl: string;
  readonly endpoints: readonly Endpoint[];
  readonly canaries: readonly { readonly accountId: string; readonly endpointId: string }[];
  readonly tokens: ReadonlyMap<string, string>;
  readonly client: HttpClient;
}): Promise<readonly CanaryResult[]> {
  const byId = new Map(options.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const results: CanaryResult[] = [];

  for (const canary of options.canaries) {
    const endpoint = byId.get(canary.endpointId);
    if (endpoint === undefined) {
      throw new UnknownCanaryEndpointError(canary.accountId, canary.endpointId);
    }
    if (TEMPLATE_PARAMETER.test(endpoint.path)) {
      throw new TemplatedCanaryError(canary.accountId, canary.endpointId);
    }

    const token = options.tokens.get(canary.accountId);
    let status = 0;
    try {
      const response = await options.client.send({
        method: endpoint.method,
        url: joinUrl(options.baseUrl, endpoint.path),
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
      status = response.status;
    } catch {
      status = 0;
    }

    results.push({
      accountId: canary.accountId,
      endpointId: canary.endpointId,
      status,
      authenticated: status >= 200 && status < 300,
    });
  }

  return results;
}

/**
 * Опрашивает каждую пару «аккаунт × эндпоинт».
 *
 * Эндпоинты с параметрами в пути пропускаются: подставить туда идентификатор
 * нечем, пока не решён вопрос сбора значений из ответов. Пропуск возвращается
 * явно, а не молчанием, — иначе непроверенное выглядело бы как проверенное.
 */
export async function collectObservations(options: CollectOptions): Promise<CollectResult> {
  const probeable: Endpoint[] = [];
  const skipped: SkippedEndpoint[] = [];
  const excluded = new Set(options.exclude ?? []);
  const safe = new Set<string>(SAFE_METHODS);

  for (const endpoint of options.endpoints) {
    if (excluded.has(endpoint.id)) {
      skipped.push({ endpointId: endpoint.id, reason: "excluded" });
    } else if (options.allowUnsafeMethods !== true && !safe.has(endpoint.method)) {
      skipped.push({ endpointId: endpoint.id, reason: "unsafe-method" });
    } else if (TEMPLATE_PARAMETER.test(endpoint.path)) {
      skipped.push({ endpointId: endpoint.id, reason: "path-parameters" });
    } else {
      probeable.push(endpoint);
    }
  }

  const observations: AccessObservation[] = [];
  const failures: ProbeFailure[] = [];

  for (const account of options.accounts) {
    const token = options.tokens.get(account.id);
    for (const endpoint of probeable) {
      const startedAt = Date.now();
      const request = {
        method: endpoint.method,
        url: joinUrl(options.baseUrl, endpoint.path),
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      };

      let status: number;
      let headers: Readonly<Record<string, string>>;
      try {
        const response = await options.client.send(request);
        status = response.status;
        headers = response.headers;
      } catch (cause) {
        // Сорванное обращение — это отсутствие вывода, а не отказ в доступе.
        status = 0;
        headers = {};
        failures.push({
          accountId: account.id,
          endpointId: endpoint.id,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }

      observations.push({
        accountId: account.id,
        endpointId: endpoint.id,
        status,
        headers,
        outcome: status === 0 ? "error" : classifyStatus(status),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  const unauthenticated: string[] = [];
  for (const account of options.accounts) {
    const own = observations.filter((o) => o.accountId === account.id);
    if (own.length > 0 && own.every((o) => o.status === 401)) {
      unauthenticated.push(account.id);
    }
  }

  return { observations, skipped, failures, probed: probeable, unauthenticated };
}

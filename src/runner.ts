/**
 * Прогон: обход матрицы «аккаунт × эндпоинт» и сбор наблюдений.
 *
 * Не ядро — здесь ввод-вывод через порт `HttpClient`. И не адаптер — здесь нет
 * знания о конкретном транспорте. Это связывающий слой между ними.
 */

import type { HttpClient } from "./adapters/ports.js";
import type { AccessObservation, AccessOutcome, Account, Endpoint } from "./core/index.js";

/** Эндпоинт, который не удалось опросить, и почему. */
export interface SkippedEndpoint {
  readonly endpointId: string;
  readonly reason: "path-parameters";
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
}

export interface CollectResult {
  readonly observations: readonly AccessObservation[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
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

  for (const endpoint of options.endpoints) {
    if (TEMPLATE_PARAMETER.test(endpoint.path)) {
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

  return { observations, skipped, failures };
}

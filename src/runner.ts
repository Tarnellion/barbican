/**
 * Прогон: обход матрицы «аккаунт × эндпоинт» и сбор наблюдений.
 *
 * Не ядро — здесь ввод-вывод через порт `HttpClient`. И не адаптер — здесь нет
 * знания о конкретном транспорте. Это связывающий слой между ними.
 */

import type { CredentialProvider, HttpClient } from "./adapters/ports.js";
import type {
  AccessObservation,
  AccessOutcome,
  Account,
  Endpoint,
  Resource,
} from "./core/index.js";
import { resourceApplies, SAFE_METHODS } from "./core/index.js";

/**
 * Эндпоинт, который не опрашивался, и почему.
 *
 * Пропуск по решению самого инструмента — не сбой. Раньше отказ от небезопасного
 * метода попадал в `failures`, и штатная работа выглядела в отчёте поломкой:
 * на реальном API каждый POST и PUT давал бы строку «сорвалось».
 */
export interface SkippedEndpoint {
  readonly endpointId: string;
  readonly reason: "path-parameters" | "unsafe-method" | "excluded" | "escapes-target";
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
  readonly resourceId?: string;
  readonly reason: string;
}

export interface CollectOptions {
  readonly baseUrl: string;
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  /** Как аккаунт представляется системе. Заголовки в наблюдения не попадают. */
  readonly credentials: CredentialProvider;
  readonly client: HttpClient;
  readonly allowUnsafeMethods?: boolean;
  /** Объекты обращения. Без них параметризованные эндпоинты не опрашиваются. */
  readonly resources?: readonly Resource[];
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
   * Прогон оборвался, не дойдя до конца матрицы.
   *
   * Исчерпанный потолок обращений или сработавший circuit breaker обрывают
   * обход посреди списка. Хвост остаётся непроверенным, но находок в нём нет
   * ровно потому, что до него не дошли, — и без этого признака вердикт
   * «чисто» неотличим от настоящего.
   */
  readonly truncated: boolean;
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

export class PathEscapesTargetError extends Error {
  readonly endpointPath: string;

  constructor(endpointPath: string, resolved: string, expectedOrigin: string) {
    super(
      `Путь "${endpointPath}" уводит обращение на "${resolved}" вместо "${expectedOrigin}". ` +
        `Путь эндпоинта берётся из спецификации проверяемой системы и доверенным ` +
        `не является: абсолютный адрес в нём позволил бы задать чужую схему и порт.`,
    );
    this.name = "PathEscapesTargetError";
    this.endpointPath = endpointPath;
  }
}

/**
 * Собирает адрес обращения.
 *
 * Origin результата сверяется с origin цели. Причина найдена состязательной
 * проверкой: `new URL(path, base)` отдаёт приоритет абсолютному адресу, поэтому
 * путь вида `http://тот-же-хост:9999/x` из спецификации перебивал базовый URL
 * целиком — понижал https до http и уводил на произвольный порт. Проверка
 * allowlist этого не ловила: она сверяла только имя хоста.
 *
 * Обратный слэш и `..` тоже отсекаются: сравнение origin делает форму записи
 * неважной.
 */
function joinUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const resolved = new URL(path.replace(/^[/\\]+/, ""), base);
  // Сверяется и origin, и префикс пути. Одного origin мало: `..` в значении
  // объекта уводил обращение выше объявленного базового пути, оставаясь
  // на том же хосте, — то есть на соседний API той же системы.
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new PathEscapesTargetError(
      path,
      `${resolved.origin}${resolved.pathname}`,
      `${base.origin}${base.pathname}`,
    );
  }
  return resolved.toString();
}

const PARAMETER_NAME = /\{([^}]+)\}/g;

/** Подставляет значения объекта в шаблон пути. */
function substitute(path: string, resource: Resource): string {
  return path.replace(PARAMETER_NAME, (_match, name: string) =>
    encodeURIComponent(Object.hasOwn(resource.params, name) ? (resource.params[name] ?? "") : ""),
  );
}

function withQuery(url: string, resource: Resource | undefined): string {
  const query = resource?.query;
  if (query === undefined || Object.keys(query).length === 0) {
    return url;
  }
  const parsed = new URL(url);
  for (const [name, value] of Object.entries(query)) {
    parsed.searchParams.set(name, value);
  }
  return parsed.toString();
}

/** Остаётся ли обращение по этому пути в пределах цели. */
export function staysWithinTarget(baseUrl: string, path: string): boolean {
  try {
    joinUrl(baseUrl, path);
    return true;
  } catch {
    return false;
  }
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

export class ExcludedCanaryError extends Error {
  constructor(accountId: string, endpointId: string) {
    super(
      `Канарейка аккаунта "${accountId}" указывает на исключённый эндпоинт "${endpointId}". ` +
        `Список исключений существует ровно для адресов, которые трогать нельзя, — ` +
        `канарейка не должна быть лазейкой мимо него.`,
    );
    this.name = "ExcludedCanaryError";
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
  readonly credentials: CredentialProvider;
  readonly client: HttpClient;
  readonly exclude?: readonly string[];
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
    if ((options.exclude ?? []).includes(canary.endpointId)) {
      throw new ExcludedCanaryError(canary.accountId, canary.endpointId);
    }

    let status = 0;
    try {
      const response = await options.client.send({
        method: endpoint.method,
        url: joinUrl(options.baseUrl, endpoint.path),
        headers: options.credentials.headersFor(canary.accountId),
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
    } else if (
      TEMPLATE_PARAMETER.test(endpoint.path) &&
      !(options.resources ?? []).some((resource) => resourceApplies(endpoint, resource))
    ) {
      // Параметры есть, а объекта с их значениями не объявлено — подставлять нечего.
      skipped.push({ endpointId: endpoint.id, reason: "path-parameters" });
    } else if (!staysWithinTarget(options.baseUrl, endpoint.path)) {
      // Путь уводит за пределы цели. Это свойство эндпоинта, а не сбой
      // обращения, поэтому пропуск, а не ошибка: один враждебный путь
      // в спецификации не должен обрывать весь прогон.
      skipped.push({ endpointId: endpoint.id, reason: "escapes-target" });
    } else {
      probeable.push(endpoint);
    }
  }

  const observations: AccessObservation[] = [];
  const failures: ProbeFailure[] = [];
  let truncated = false;

  // Эндпоинт без параметров опрашивается один раз; с параметрами — по разу
  // на каждый объект, который эти параметры покрывает.
  const cells: Array<{ endpoint: Endpoint; resource?: Resource }> = [];
  for (const endpoint of probeable) {
    const applicable = (options.resources ?? []).filter((resource) =>
      resourceApplies(endpoint, resource),
    );
    if (applicable.length === 0) {
      cells.push({ endpoint });
      continue;
    }
    for (const resource of applicable) {
      cells.push({ endpoint, resource });
    }
  }

  for (const account of options.accounts) {
    const authHeaders = options.credentials.headersFor(account.id);
    for (const { endpoint, resource } of cells) {
      const startedAt = Date.now();
      const path = resource === undefined ? endpoint.path : substitute(endpoint.path, resource);
      // Проверка области — над готовым путём, а не над шаблоном: значение объекта
      // с `..` уводило обращение выше объявленного базового пути, потому что
      // шаблон проверялся до подстановки.
      let url: string;
      try {
        url = withQuery(joinUrl(options.baseUrl, path), resource);
      } catch (cause) {
        failures.push({
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }
      const request = { method: endpoint.method, url, headers: authHeaders };

      let status: number;
      let headers: Readonly<Record<string, string>>;
      try {
        const response = await options.client.send(request);
        status = response.status;
        headers = response.headers;
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : "";
        if (name === "RunBudgetExhaustedError" || name === "CircuitOpenError") {
          truncated = true;
        }
        // Сорванное обращение — это отсутствие вывода, а не отказ в доступе.
        status = 0;
        headers = {};
        failures.push({
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }

      observations.push({
        accountId: account.id,
        endpointId: endpoint.id,
        ...(resource === undefined ? {} : { resourceId: resource.id }),
        status,
        headers,
        outcome: status === 0 ? "error" : classifyStatus(status),
        durationMs: Date.now() - startedAt,
      });
    }
  }

  return { observations, skipped, failures, probed: probeable, truncated };
}

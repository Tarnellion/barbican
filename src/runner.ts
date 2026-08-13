/**
 * Прогон: обход матрицы «аккаунт × эндпоинт» и сбор наблюдений.
 *
 * Не ядро — здесь ввод-вывод через порт `HttpClient`. И не адаптер — здесь нет
 * знания о конкретном транспорте. Это связывающий слой между ними.
 */

import type { ContextAttributes, CredentialProvider, HttpClient } from "./adapters/ports.js";
import type {
  AccessObservation,
  AccessOutcome,
  Account,
  Endpoint,
  Resource,
  SignalSpec,
  SignalValue,
  TenantId,
} from "./core/index.js";
import { principalOf, resourceApplies, SAFE_METHODS } from "./core/index.js";

/**
 * Что вычисляется над телом помеченного эндпоинта.
 *
 * Один дайджест: он отвечает на вопрос «получили ли два тенанта один и тот же
 * ответ», ради которого послабление и вводилось. Расширять набор без нужды
 * незачем — каждый лишний сигнал означает лишнее прочитанное тело.
 */
const DIGEST_SIGNALS = [
  { name: "digest", kind: "digest" },
] as const satisfies readonly SignalSpec[];

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
  /**
   * Базовый адрес для отдельных тенантов.
   *
   * Мультибрендовые платформы часто разносят бренды по поддоменам, и типовое
   * проверяемое утверждение — «токен бренда A не работает на хосте бренда B».
   * Адрес выбирается по тенанту **объекта**, а не аккаунта: спрашиваем-то мы
   * именно за чужие данные, и лежат они на чужом хосте. Когда объекта нет,
   * берётся тенант аккаунта — вопрос тогда о его собственной области.
   */
  readonly tenantBaseUrls?: ReadonlyMap<TenantId, string>;
  /**
   * Атрибуты аккаунтов в объявленных условиях: id аккаунта в условиях → что
   * добавить к обращению и чьи учётные данные предъявить.
   *
   * Ядро об этом не знает: ему хватает метки `contextId` на аккаунте. Здесь же
   * условия становятся заголовками и параметрами запроса. См. ADR-0019.
   */
  readonly contextAttributes?: ReadonlyMap<string, ContextAttributes>;
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
 *
 * 451 — отказ наравне с 401 и 403. Он неоднозначным не бывает: «недоступно
 * по юридическим причинам» есть решение не обслуживать, а не сбой и не
 * отсутствие объекта. Добавлен вместе с условиями обращения (ADR-0019): гео-
 * и юрисдикционные ограничения отвечают именно им, и без этой строки исправная
 * платформа давала бы стену `probe-error` там, где она как раз работает верно.
 */
export function classifyStatus(status: number): AccessOutcome {
  if (status >= 200 && status < 300) {
    return "allowed";
  }
  if (status === 401 || status === 403 || status === 451) {
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

/**
 * Базовый адрес для обращения: свой адрес тенанта, если объявлен, иначе общий.
 *
 * Отдельной функцией, потому что случай «тенанта нет вовсе» — аккаунт вне
 * тенантов, то есть аноним, — должен решаться одинаково и в канарейке,
 * и в основном прогоне. Заглушки вроде `?? ""` здесь недопустимы: пустая
 * строка снова стала бы именем тенанта, пусть и не совпадающим ни с чем.
 *
 * У аккаунта с набором членств (ADR-0017) `tenantId` не задан, и сюда приходит
 * `undefined`: своего единственного хоста у такого аккаунта нет, выбирать
 * из набора было бы гаданием, и обращение идёт на общий адрес. Обращения
 * за объектом это не касается — там адрес берётся по тенанту объекта.
 */
function baseUrlForTenant(
  tenantId: TenantId | undefined,
  tenantBaseUrls: ReadonlyMap<TenantId, string> | undefined,
  fallback: string,
): string {
  if (tenantId === undefined) {
    return fallback;
  }
  return tenantBaseUrls?.get(tenantId) ?? fallback;
}

const PARAMETER_NAME = /\{([^}]+)\}/g;

/** Подставляет значения объекта в шаблон пути. */
function substitute(path: string, resource: Resource): string {
  return path.replace(PARAMETER_NAME, (_match, name: string) =>
    encodeURIComponent(Object.hasOwn(resource.params, name) ? (resource.params[name] ?? "") : ""),
  );
}

function withQuery(
  url: string,
  resource: Resource | undefined,
  extra: Readonly<Record<string, string>> = {},
): string {
  const query = { ...resource?.query, ...extra };
  if (Object.keys(query).length === 0) {
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
  /** Аккаунты — чтобы знать тенант и выбрать его базовый адрес. */
  readonly accounts?: readonly Account[];
  readonly tenantBaseUrls?: ReadonlyMap<TenantId, string>;
}): Promise<readonly CanaryResult[]> {
  const byId = new Map(options.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  // Канарейка обязана стучаться на хост своего же бренда: на платформе,
  // разнесённой по поддоменам, обращение к чужому даст отказ, и прогон
  // остановится ложной тревогой «токен не работает».
  // Аккаунты вне тенантов (анонимные) в карту не попадают: своего адреса
  // у них нет, обращение идёт на базовый. Аккаунт с набором членств — тоже:
  // единственного «своего» хоста у него не существует, и канарейку такому
  // аккаунту выбирают на общем адресе.
  const tenantOf = new Map(
    (options.accounts ?? []).flatMap((account) =>
      account.tenantId === undefined ? [] : [[account.id, account.tenantId] as const],
    ),
  );
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

    const canaryUrl = joinUrl(
      baseUrlForTenant(tenantOf.get(canary.accountId), options.tenantBaseUrls, options.baseUrl),
      endpoint.path,
    );

    let status = 0;
    try {
      const response = await options.client.send({
        method: endpoint.method,
        url: canaryUrl,
        headers: options.credentials.headersFor(canary.accountId, {
          method: endpoint.method,
          url: canaryUrl,
        }),
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
    } else if (
      // Отсеивается только то, что уводит за пределы КАЖДОГО объявленного
      // адреса: иначе эндпоинт, законный для бренда на поддомене, пропускался бы
      // из-за несовпадения с адресом по умолчанию.
      ![options.baseUrl, ...(options.tenantBaseUrls?.values() ?? [])].some((base) =>
        staysWithinTarget(base, endpoint.path),
      )
    ) {
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
    const attributes = options.contextAttributes?.get(account.id);
    // Условия аккаунта не меняют: предъявляется он сам, а меняется обращение.
    // Источник один — `principalOf`: то же самое нужно отношению к объекту
    // и отчёту, а три разных «взять исходный аккаунт» разошлись бы молча.
    const credentialAccountId = principalOf(account);
    for (const { endpoint, resource } of cells) {
      // Аккаунт в условиях существует только на объявленных ручках.
      if (account.endpointIds !== undefined && !account.endpointIds.includes(endpoint.id)) {
        continue;
      }
      const startedAt = Date.now();
      const path = resource === undefined ? endpoint.path : substitute(endpoint.path, resource);
      const tenantId = resource?.tenantId ?? account.tenantId;
      const baseUrl = baseUrlForTenant(tenantId, options.tenantBaseUrls, options.baseUrl);
      // Проверка области — над готовым путём, а не над шаблоном: значение объекта
      // с `..` уводило обращение выше объявленного базового пути, потому что
      // шаблон проверялся до подстановки.
      let url: string;
      try {
        url = withQuery(joinUrl(baseUrl, path), resource, attributes?.query);
      } catch (cause) {
        failures.push({
          accountId: account.id,
          endpointId: endpoint.id,
          ...(resource === undefined ? {} : { resourceId: resource.id }),
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }
      // Тело читается только там, где человек объявил `responseMustDifferByTenant`:
      // где не объявлено, там поток отменяется непрочитанным. См. ADR-0011.
      // Дайджест подразумевается самим этим объявлением — сравнивать ответы между
      // тенантами больше нечем, — остальные скаляры объявлены человеком явно.
      // Пусто — тело не читается вовсе.
      const specs: readonly SignalSpec[] = [
        ...(endpoint.responseMustDifferByTenant === true ? DIGEST_SIGNALS : []),
        ...(endpoint.signals ?? []),
      ];
      // Заголовки берутся на каждое обращение, а не один раз на аккаунт:
      // подпись зависит от метода и адреса, и вынесенное из цикла значение
      // молча подписывало бы все ячейки первым запросом. См. ADR-0018.
      //
      // Атрибуты условий добавляются **после** учётных: подменить учётный
      // заголовок они не могут — это проверено при разборе конфигурации, —
      // и порядок здесь второй рубеж той же защиты, а не стилистика.
      const request = {
        method: endpoint.method,
        url,
        headers: {
          ...options.credentials.headersFor(credentialAccountId, {
            method: endpoint.method,
            url,
          }),
          ...attributes?.headers,
        },
        ...(specs.length === 0 ? {} : { signals: specs }),
      };

      let status: number;
      let headers: Readonly<Record<string, string>>;
      let signals: Readonly<Record<string, SignalValue>> | undefined;
      try {
        const response = await options.client.send(request);
        status = response.status;
        headers = response.headers;
        signals = response.signals;
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
        method: endpoint.method,
        url,
        ...(resource === undefined ? {} : { resourceId: resource.id }),
        status,
        headers,
        outcome: status === 0 ? "error" : classifyStatus(status),
        durationMs: Date.now() - startedAt,
        // Момент обращения, а не только длительность: иначе находку нечем
        // сопоставить с логом платформы.
        at: new Date(startedAt).toISOString(),
        ...(signals === undefined ? {} : { signals }),
      });
    }
  }

  return { observations, skipped, failures, probed: probeable, truncated };
}

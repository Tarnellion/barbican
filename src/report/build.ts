/**
 * Сборка отчёта.
 *
 * JSON — единственный источник истины (ADR-0002). Человекочитаемые формы
 * рендерятся из него отдельным шагом, а не собираются по ходу прогона.
 *
 * Токенов в отчёте нет по конструкции, а не по итогу вычистки: они живут
 * в отдельной карте и не входят ни в конфигурацию, ни в наблюдения. Заголовки
 * ответа приходят уже отредактированными из HTTP-клиента.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AuthScheme } from "../adapters/credentials.js";
import type {
  AccessDiff,
  AccessObservation,
  AccessOutcome,
  DefectGroup,
  DiffKind,
  Endpoint,
  ExpectedOutcome,
  Finding,
  HttpMethod,
  ResolvedAccessPolicy,
  Resource,
  ResourceRelation,
  Severity,
  TenantNode,
} from "../core/index.js";
import { groupDefects } from "../core/index.js";
import type { RunConfig } from "../io/config.js";
import type { ProbeFailure, SkippedEndpoint } from "../runner.js";

/**
 * Версия формы отчёта. Поднимается при несовместимом изменении структуры.
 */
export const REPORT_SCHEMA_VERSION = "1";

export interface ReportSummary {
  readonly endpoints: number;
  readonly accounts: number;
  readonly resources: number;
  readonly observations: number;
  readonly skipped: number;
  readonly failures: number;
  readonly findings: number;
  /**
   * По виду. Ключи — виды расхождений матрицы и идентификаторы проверок:
   * после слияния списков сюда попадает всё, и дашборд по нему полон.
   */
  readonly byKind: Readonly<Record<string, number>>;
  /** Расхождения по серьёзности — с чего читателю начинать. См. ADR-0014. */
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /**
   * По серьёзности, но считая **дефекты**, а не строки.
   *
   * `critical: 10` в `bySeverity` — это один отсутствующий фильтр, задевший
   * десять ячеек, а читается как десять проблем. Число рядом снимает вопрос.
   */
  readonly defectsBySeverity: Readonly<Record<Severity, number>>;
  /**
   * Различных сигнатур дефекта. **Нижняя граница** числа проблем: две разные
   * ошибки с одинаковой сигнатурой снаружи неразличимы. Верхняя граница —
   * `findings`.
   */
  readonly defectGroups: number;
  /** Находки проверок-плагинов. Считаются отдельно: у них своя природа. */
  readonly checkFindings: number;
}

/** Итог одной канарейки: кто, где и подтвердилась ли аутентификация. */
export interface CanaryOutcome {
  readonly accountId: string;
  readonly endpointId: string;
  readonly status: number;
  readonly authenticated: boolean;
}

/**
 * Находка с приложенным запросом.
 *
 * Ядро о адресах не знает и знать не должно — соединение делается здесь,
 * при сборке отчёта, по тройке «аккаунт × эндпоинт × объект».
 */
/**
 * Находка отчёта — одна на оба способа обнаружения.
 *
 * Раньше списков было два: расхождения матрицы в осях `kind`/`expected`/
 * `actual`/`relation` и находки проверок в осях `checkId`/`title`/`evidence`.
 * Одна и та же межтенантная утечка попадала в разный список в зависимости
 * от того, видна она по статусу или по телу, — то есть различие **способа
 * обнаружения** выдавалось за различие природы находки.
 *
 * Цена этого разделения была не эстетической. `bySeverity` считала только
 * первый список и показывала вдвое меньше; `byKind` не считал второй вовсе;
 * группировка по сигнатуре на проверки не распространялась, и шесть клонов
 * одной находки завышали картину вшестеро. Три симптома, одна причина.
 */
export interface ReportFinding {
  /** Вид расхождения либо идентификатор проверки. */
  readonly kind: string;
  /** Чем найдено: сравнением матрицы или проверкой из реестра. */
  readonly source: "matrix" | "check";
  readonly severity: Severity;
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string;
  readonly relation?: ResourceRelation;
  /** Только у расхождений матрицы. */
  readonly expected?: ExpectedOutcome;
  readonly actual?: AccessOutcome;
  /** Только у находок проверок: человекочитаемое описание и обоснование. */
  readonly title?: string;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
  /**
   * Чем воспроизвести и что ответила платформа.
   *
   * Код нужен прямо здесь: `actual: "allowed"` означает «2xx», а какой именно —
   * приходилось искать в наблюдениях и соединять вручную по тройке.
   */
  readonly request?: { readonly method: HttpMethod; readonly url: string };
  readonly status?: number;
}

/**
 * Вводные, на которых стоят выводы.
 *
 * Без них находку нельзя ни завести в тикет, ни оспорить: каждое `expected`
 * держится на политике, которой в отчёте не было, а `foreign-tenant` и
 * `ancestor-tenant` — на дереве тенантов, которое читателю приходилось
 * восстанавливать по узору отказов.
 */
export interface RunInputs {
  /** Политика с раскрытыми шаблонами — ровно та, что выносила вердикты. */
  readonly policy: ResolvedAccessPolicy;
  /** Дерево тенантов. Пусто, если иерархия не объявлена. */
  readonly tenants: readonly TenantNode[];
  /**
   * Чем инструмент представлялся: вид схемы и имя заголовка или куки.
   * Значений здесь нет и быть не может — они живут только в окружении.
   */
  readonly auth: AuthScheme;
}

/**
 * Что именно проверено, а что нет.
 *
 * Отвечает на вопрос, которого в отчёте не хватало больше всего: «шесть
 * эндпоинтов — это сколько процентов поверхности?». Без знаменателя число
 * опрошенного не значит ничего, а отсутствие находки на непроверенном
 * читается как «чисто».
 */
export interface Coverage {
  /** Сколько эндпоинтов дал источник — спецификация, список или коллекция. */
  readonly endpointsTotal: number;
  /** Сколько из них действительно опрашивались. */
  readonly endpointsProbed: number;
  readonly cellsObserved: number;
  /** Ячейки, объявленные политикой, но не пронаблюдённые. */
  readonly cellsNotObserved: number;
  /** Почему эндпоинты не опрашивались, по причинам. */
  readonly notProbed: Readonly<Record<string, number>>;
  /**
   * Ручки, на которых сравнивались тела.
   *
   * Названы поимённо намеренно: на всех остальных отсутствие находки означает
   * «не сравнивали», а не «совпадений нет». Разницу иначе не увидеть.
   */
  readonly bodiesComparedOn: readonly string[];
  /** Выполнялись ли методы, изменяющие состояние. */
  readonly writeMethodsProbed: boolean;
  /**
   * Проверки, которые действительно выполнялись.
   *
   * Перечисляются все, включая ничего не нашедшие. Иначе проверка, которую
   * забыли зарегистрировать или которая упала, даёт отчёт, неотличимый
   * от чистого: в `byKind` её ключ появляется только при находке.
   */
  readonly checksRun: readonly string[];
}

export interface RunReport {
  /**
   * Версия формы отчёта.
   *
   * Без неё парсер ломается молча при первом же изменении структуры —
   * а структура менялась уже трижды.
   */
  readonly schemaVersion: string;
  /** Идентификатор прогона: два отчёта иначе не отличить друг от друга. */
  readonly runId: string;
  /**
   * Отпечаток конфигурации.
   *
   * Считается по разобранной конфигурации, а не по тексту файла: комментарии
   * и форматирование на результат прогона не влияют, а на хеш влияли бы.
   * Нужен, чтобы отличить «платформа изменилась» от «мы поменяли объявление».
   */
  readonly configDigest: string;
  readonly tool: { readonly name: string; readonly version: string };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly target: {
    readonly baseUrl: string;
    readonly allowedHosts: readonly string[];
    /**
     * Опознание проверяемой системы, объявленное человеком.
     *
     * Отсутствие значимо: отчёт не называет платформу, и читатель не может
     * отличить прогон против прод-подобного стенда от прогона демо-полигона.
     * Заводить по такому артефакту тикет на платформу нельзя.
     */
    readonly label?: string;
  };
  readonly accounts: readonly {
    readonly id: string;
    readonly role: string;
    /** Набор членств, если аккаунт состоит сразу в нескольких тенантах. */
    readonly tenants?: readonly string[] | undefined;
    /** Объявлен без учётных данных: обращается анонимно. */
    readonly anonymous?: boolean;
    /**
     * Схема, которой аккаунт представлялся. Только вид и имена, без значений.
     * У анонимного аккаунта не значит ничего — предъявлять нечего.
     */
    readonly auth?: AuthScheme;
    /** Отсутствует у аккаунта вне тенантов: в JSON ключа просто нет. */
    readonly tenant?: string | undefined;
  }[];
  readonly endpoints: readonly Endpoint[];
  /**
   * Объекты обращения. Без них находка о нарушении изоляции непроверяема:
   * непонятно, к какому объекту относился доступ.
   */
  readonly resources: readonly Resource[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
  /**
   * Аккаунты, у которых все обращения вернули 401.
   *
   * Непустой список означает, что находкам верить нельзя: скорее всего
   * не сработала аутентификация, а не политика.
   */
  readonly unauthenticated: readonly string[];
  /**
   * Сколько канареек проверено перед прогоном.
   *
   * Ноль означает, что аутентификация не подтверждалась. В JSON это должно быть
   * видно: иначе отчёт непроверенного прогона побайтово совпадает с отчётом
   * успешного, и разница остаётся только в предупреждении на stderr.
   */
  readonly canariesChecked: number;
  /**
   * Результат каждой канарейки поимённо.
   *
   * Счётчик без вердикта бесполезен: отчёт с «проверено 7» и нулём находок
   * неотличим от отчёта, где канарейки молча провалились.
   */
  readonly canaries: readonly CanaryOutcome[];
  /** Прогон оборвался, не дойдя до конца матрицы. */
  readonly truncated: boolean;
  readonly observations: readonly AccessObservation[];
  readonly findings: readonly ReportFinding[];

  /** Вводные, на которых стоят выводы. */
  readonly inputs: RunInputs;
  /** Что проверено и что нет. */
  readonly coverage: Coverage;
  /**
   * Расхождения, сведённые к сигнатурам «эндпоинт × вид × отношение».
   *
   * Один дефект платформы задевает столько ячеек, сколько их есть; без
   * группировки отчёт сообщает размер матрицы, а не число проблем.
   */
  readonly defects: readonly DefectGroup[];
  readonly summary: ReportSummary;
}

export interface BuildReportOptions {
  readonly version: string;
  readonly config: RunConfig;
  readonly endpoints: readonly Endpoint[];
  /** Эндпоинты, которые действительно опрашивались. */
  readonly probed?: readonly Endpoint[];
  readonly observations: readonly AccessObservation[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
  readonly unauthenticated: readonly string[];
  readonly canariesChecked: number;
  readonly canaries?: readonly CanaryOutcome[];
  readonly truncated: boolean;
  /** Выполнялись ли методы, изменяющие состояние. */
  readonly unsafeMethods?: boolean;
  readonly findings: readonly AccessDiff[];
  /** Политика с раскрытыми шаблонами — та, что выносила вердикты. */
  readonly policy: ResolvedAccessPolicy;
  /** Находки проверок из реестра. Отсутствие означает «проверки не запускались». */
  readonly checks?: readonly Finding[];
  /** Идентификаторы выполненных проверок, включая ничего не нашедшие. */
  readonly checksRun?: readonly string[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

const EMPTY_BY_KIND: Readonly<Record<DiffKind, number>> = {
  "privilege-escalation": 0,
  "unexpected-denial": 0,
  "not-observed": 0,
  "probe-error": 0,
};

const EMPTY_BY_SEVERITY: Readonly<Record<Severity, number>> = {
  info: 0,
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
};

/**
 * Считает по **всем** находкам, включая находки проверок.
 *
 * Раньше считались только расхождения матрицы, и сводка показывала high: 5
 * там, где их 11. Дашборд, построенный на `bySeverity`, терял шесть находок —
 * и в их числе самую эксплуатируемую: списочную утечку, видимую только по телу.
 * Найдено холодным чтением отчёта человеком, не знающим проекта.
 */
function countBySeverity(findings: readonly ReportFinding[]): Readonly<Record<Severity, number>> {
  const counts = { ...EMPTY_BY_SEVERITY };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

/**
 * Приклеивает к каждой находке запрос, которым она получена.
 *
 * Соединение по тройке «аккаунт × эндпоинт × объект» — тому же ключу, которым
 * ячейка определяется везде в проекте.
 */
function mergeFindings(
  diffs: readonly AccessDiff[],
  checks: readonly Finding[],
  observations: readonly AccessObservation[],
): readonly ReportFinding[] {
  const byCell = new Map(
    observations.map((observation) => [
      `${observation.accountId}\u0000${observation.endpointId}\u0000${observation.resourceId ?? ""}`,
      observation,
    ]),
  );
  function withRequest<T extends { accountId: string; endpointId: string; resourceId?: string }>(
    finding: T,
  ): T & { request?: { method: HttpMethod; url: string } } {
    const observation = byCell.get(
      `${finding.accountId}\u0000${finding.endpointId}\u0000${finding.resourceId ?? ""}`,
    );
    if (observation?.url === undefined || observation.method === undefined) {
      return finding;
    }
    return {
      ...finding,
      request: { method: observation.method, url: observation.url },
      status: observation.status,
    };
  }

  const fromMatrix: readonly ReportFinding[] = diffs.map((diff) =>
    withRequest({ ...diff, source: "matrix" as const }),
  );

  // У находки проверки аккаунт и эндпоинт необязательны по типу `Finding`,
  // но проверка, не назвавшая ни того ни другого, бесполезна для разбора:
  // такие в общий список не попадают и остаются видны только счётчиком.
  const fromChecks: readonly ReportFinding[] = checks
    .filter(
      (check): check is Finding & { accountId: string; endpointId: string } =>
        check.accountId !== undefined && check.endpointId !== undefined,
    )
    .map((check) =>
      withRequest({
        kind: check.checkId,
        source: "check" as const,
        severity: check.severity,
        accountId: check.accountId,
        endpointId: check.endpointId,
        title: check.title,
        evidence: check.evidence,
      }),
    );

  return [...fromMatrix, ...fromChecks];
}

function countGroupsBySeverity(groups: readonly DefectGroup[]): Readonly<Record<Severity, number>> {
  const counts = { ...EMPTY_BY_SEVERITY };
  for (const group of groups) {
    counts[group.severity] += 1;
  }
  return counts;
}

function countByKind(findings: readonly ReportFinding[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = { ...EMPTY_BY_KIND };
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return counts;
}

function countByReason(skipped: readonly SkippedEndpoint[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of skipped) {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  }
  return counts;
}

export function buildReport(options: BuildReportOptions): RunReport {
  const merged = mergeFindings(options.findings, options.checks ?? [], options.observations);
  const notObserved = options.findings.filter((finding) => finding.kind === "not-observed").length;
  const groups = groupDefects(merged);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: randomUUID(),
    configDigest: createHash("sha256")
      .update(JSON.stringify(options.config))
      .digest("hex")
      .slice(0, 16),
    tool: { name: "barbican", version: options.version },
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    target: {
      baseUrl: options.config.target.baseUrl,
      allowedHosts: options.config.target.allowedHosts,
      ...(options.config.target.label === undefined ? {} : { label: options.config.target.label }),
    },
    // tokenEnv намеренно не переносится: имя переменной не секрет, но и смысла
    // в отчёте не несёт, а соблазн положить рядом значение убирает.
    accounts: options.config.accounts.map((account) => ({
      id: account.id,
      role: account.role,
      tenant: account.tenant,
      // Набор членств печатается наравне с одиночным тенантом. Без этого
      // аккаунт с набором выглядел в отчёте как аккаунт вовсе без тенанта,
      // то есть неотличимо от анонима — при том что вердикты по нему верны.
      tenants: account.tenants,
      // Аккаунт без учётных данных объявлен анонимным. Без явной пометки
      // единственный положительный вывод отчёта — «аноним всюду получил 401» —
      // недоказуем: аккаунт с ошибочно поданным токеном выглядел бы так же.
      anonymous: account.tokenEnv === undefined,
      // Каким контуром ходил аккаунт. У анонимного не пишется вовсе:
      // предъявлять ему нечего, и запись схемы там только путала. Без этого читатель не отличит «ручка
      // закрыта» от «мы стучались не тем транспортом»: и то и другое даёт 401.
      // Здесь только вид схемы и имя заголовка или куки — значений нет нигде.
      ...(account.tokenEnv === undefined
        ? {}
        : { auth: options.config.accountAuth.get(account.id) ?? options.config.auth }),
    })),
    endpoints: options.endpoints,
    resources: options.config.resources,
    skipped: options.skipped,
    failures: options.failures,
    unauthenticated: options.unauthenticated,
    canariesChecked: options.canariesChecked,
    canaries: options.canaries ?? [],
    truncated: options.truncated,
    observations: options.observations,
    findings: merged,
    coverage: {
      endpointsTotal: options.endpoints.length,
      endpointsProbed: options.probed?.length ?? options.endpoints.length - options.skipped.length,
      cellsObserved: options.observations.length,
      cellsNotObserved: notObserved,
      notProbed: countByReason(options.skipped),
      bodiesComparedOn: options.endpoints
        .filter((endpoint) => endpoint.responseMustDifferByTenant === true)
        .map((endpoint) => endpoint.id),
      writeMethodsProbed: options.unsafeMethods ?? false,
      checksRun: options.checksRun ?? [],
    },
    inputs: {
      policy: options.policy,
      tenants: options.config.tenants ?? [],
      auth: options.config.auth,
    },
    defects: groups,
    summary: {
      endpoints: options.endpoints.length,
      accounts: options.config.accounts.length,
      resources: options.config.resources.length,
      observations: options.observations.length,
      skipped: options.skipped.length,
      failures: options.failures.length,
      // Длина общего списка, а не число матричных расхождений. Соседние
      // счётчики уже считали всё, и одно число из пяти расходилось с остальными
      // ровно на находки по телу. Тот же класс, что прежняя ошибка bySeverity,
      // в том же объекте — найдено вторым холодным чтением.
      findings: merged.length,
      byKind: countByKind(merged),
      bySeverity: countBySeverity(merged),
      defectGroups: groups.length,
      defectsBySeverity: countGroupsBySeverity(groups),
      checkFindings: merged.filter((finding) => finding.source === "check").length,
    },
  };
}

/**
 * Код возврата процесса.
 *
 * Эскалация привилегий — единственное, что делает прогон проваленным:
 * остальные расхождения требуют внимания, но не означают дыры в доступе.
 */
/**
 * Код возврата процесса.
 *
 * 0 — проверено и чисто, 1 — найдена эскалация, 2 — прогон недостоверен.
 *
 * Различать 0 и 2 принципиально. Состязательная проверка показала три способа
 * получить «чистый» отчёт, ничего не проверив: спецификация без единого
 * эндпоинта, стенд, отвечающий сплошными ошибками, и исчерпанный бюджет
 * обращений. Во всех трёх случаях находок нет ровно потому, что не было
 * и проверки, — и код 0 читался бы как подтверждение защищённости.
 */
export function exitCodeFor(report: RunReport): number {
  if (report.summary.observations === 0) {
    return 2;
  }
  // Оборванный прогон не проверил хвост матрицы: находок там нет потому,
  // что до них не дошли. Найдено состязательной проверкой — исчерпанный
  // потолок обращений давал код 0 при непроверенной межтенантной утечке.
  if (report.truncated) {
    return 2;
  }
  if (report.unauthenticated.length > 0) {
    return 2;
  }
  if (report.summary.byKind["probe-error"] === report.summary.observations) {
    return 2;
  }
  // Расхождение есть расхождение, куда бы оно ни было направлено. Инструмент
  // не может определить, что именно неверно — платформа или объявление, — а раз
  // не может, то и молчать не вправе. Найдено проверкой оракула платформы:
  // холдингу закрыли его собственный бренд, и прогон вернул 0. См. ADR-0014.
  if (
    (report.summary.byKind["privilege-escalation"] ?? 0) > 0 ||
    (report.summary.byKind["unexpected-denial"] ?? 0) > 0
  ) {
    return 1;
  }
  // Находка проверки — такое же расхождение, как эскалация, просто увиденное
  // не по статусу. Молчать о ней кодом возврата значило бы, что прогон
  // с найденной межтенантной утечкой выглядит успешным в CI.
  return report.findings.some(
    (finding) =>
      finding.source === "check" &&
      (finding.severity === "high" || finding.severity === "critical"),
  )
    ? 1
    : 0;
}

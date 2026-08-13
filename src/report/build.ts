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
import type { ThrottleLimits } from "../adapters/throttle.js";
import type { BodyComparisonCoverage } from "../core/checks/tenant-isolation.js";
import type {
  AccessDiff,
  AccessObservation,
  AccessOutcome,
  Account,
  CellVerdict,
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
import { groupDefects, principalOf } from "../core/index.js";
import type { AccountConfig, RequestContextConfig, RunConfig } from "../io/config.js";
import type { ProbeFailure, SkippedEndpoint } from "../runner.js";

/**
 * Версия формы отчёта. Поднимается при несовместимом изменении структуры.
 */
export const REPORT_SCHEMA_VERSION = "1";

export interface ReportSummary {
  readonly endpoints: number;
  readonly accounts: number;
  /**
   * Строк матрицы: объявленные аккаунты плюс они же в объявленных условиях.
   *
   * Отдельное число, потому что `accounts` — про объявление, а ячейки считаются
   * по строкам. Читатель, проверявший арифметику по `accounts`, получал 9 × 6,
   * что с 135 ячейками не сходится никак. Найдено холодным чтением.
   */
  readonly accountRows: number;
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
  /**
   * Условия обращения. Отсутствие — базовые, без добавленных атрибутов.
   *
   * Без этого поля находка «доступ есть там, где не положен» не отличалась бы
   * от находки «доступ есть при подменённой стране»: аккаунт в отчёте разный,
   * но чем он отличается, читателю взять негде.
   */
  readonly contextId?: string;
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
  readonly request?: RequestRecord;
  /**
   * Второе обращение парной находки.
   *
   * У утечки по телу запросов было два, а печатался один: на платформе
   * с адресами по тенантам читатель собирал второй сам — и собирал неверно,
   * потому что хост у другого бренда другой. Найдено третьим холодным чтением.
   */
  readonly relatedRequest?: RequestRecord;
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
/**
 * Чем воспроизвести находку.
 *
 * Учётных заголовков здесь нет и быть не может: они приходят из окружения,
 * и место им только там. `contextHeaders` — объявленные человеком атрибуты
 * условий обращения, без которых строка воспроизводит базовый случай вместо
 * найденного.
 */
export interface RequestRecord {
  readonly method: HttpMethod;
  readonly url: string;
  readonly contextHeaders?: Readonly<Record<string, string>>;
}

/**
 * Наблюдение вместе с вердиктом по его ячейке.
 *
 * `match: true` — «проверено и совпало с объявленным»; это единственное место
 * отчёта, где положительный результат виден поячеечно, а не суммой.
 * Вердикт приходит из того же обхода, что и расхождения (ADR-0020).
 */
export interface ReportedObservation extends AccessObservation {
  readonly expected?: ExpectedOutcome;
  readonly match?: boolean;
  readonly relation?: ResourceRelation;
  readonly ruleIndex?: number;
}

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
  /**
   * Объявленные условия обращения вместе с атрибутами.
   *
   * Атрибуты печатаются: без них «доступ при context: geo-blocked» —
   * утверждение, которое нечем ни воспроизвести, ни оспорить. Значения задаёт
   * человек, и секретам там не место — ровно как в остальной конфигурации.
   */
  readonly contexts: readonly ReportedContext[];
  /**
   * Эндпоинты, исключённые оператором вручную.
   *
   * Молчание здесь читалось как «исключений не было»: оператор мог убрать
   * ручку из прогона, и отчёт об этом не говорил ничего.
   */
  readonly exclude: readonly string[];
  /**
   * Действовавшие лимиты обращений.
   *
   * Инвариант «троттлинг всегда включён» по отчёту иначе не проверить —
   * приходится верить на слово.
   */
  readonly throttle?: ThrottleLimits;
}

export interface ReportedContext {
  readonly id: string;
  readonly description?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly endpointIds: readonly string[];
  /** Аккаунты, к которым применялись. Пусто — ко всем. */
  readonly accountIds: readonly string[];
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
  /**
   * Что именно сравнивалось по телу на каждой объявленной ручке.
   *
   * `bodiesComparedOn` называет ручки, но молчание про конкретную пару читается
   * как «совпадений нет». На прогоне референс-платформы холдинг и саппорт
   * с набором членств совпали дайджестом законно — они в родстве, — и отличить
   * «пропустили» от «сравнили и разошлись» без этого числа было нечем.
   */
  readonly bodyComparison: readonly BodyComparisonCoverage[];
  /**
   * Сколько ячеек пронаблюдено в каждых объявленных условиях.
   *
   * Ноль здесь означает «условия объявлены, но не проверены»: их ручки могли
   * попасть в `skipped`, а отсутствие находок читалось бы как «под этими
   * условиями всё в порядке». Ключ есть у каждых объявленных условий,
   * в том числе с нулём, — молчания об условиях быть не должно.
   */
  readonly contextsProbed: Readonly<Record<string, number>>;
  /**
   * Ячеек пронаблюдено и совпало с ожиданием.
   *
   * `cellsObserved − findings` читатель считал сам, и «проверено и чисто»
   * существовало в отчёте только как вычитание. Числом оно проверяемо:
   * сумма с расхождениями обязана дать `cellsObserved`.
   */
  readonly cellsMatched?: number;
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
     * Имя переменной окружения с токеном — **имя, а не значение**.
     *
     * Без него находку нечем воспроизвести: «добавьте заголовок аутентификации
     * аккаунта alice-a» не говорит, где этот токен взять.
     */
    readonly tokenEnv?: string;
    /**
     * Исходный аккаунт, если строка — он же в условиях обращения.
     *
     * Без него суффикс `@` остаётся единственным носителем структуры, а
     * читается он как «пользователь в области» — то есть как другой аккаунт.
     */
    readonly baseAccountId?: string;
    /**
     * Условия обращения, в которых существует эта строка.
     *
     * Тот же аккаунт с теми же учётными данными: меняется не он, а обращение.
     * Отсутствие означает базовые условия.
     */
    readonly contextId?: string;
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
  readonly observations: readonly ReportedObservation[];
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
  /**
   * Строки матрицы, включая аккаунты в объявленных условиях.
   *
   * Готовый список от деривации, а не второй обход тех же правил: разойдясь,
   * они дали бы находку со ссылкой на аккаунт, которого в отчёте нет.
   */
  readonly accounts?: readonly Account[];
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
  /**
   * Вердикты по ячейкам — от того же обхода, что дал расхождения.
   *
   * Второй источник вердикта здесь был бы худшим из возможных: отчёт
   * утверждал бы «проверено и совпало» о ячейке, попавшей в находки.
   */
  readonly cells?: readonly CellVerdict[];
  /** Действовавшие лимиты обращений — как их разрешил троттлинг, а не флаги. */
  readonly throttle?: ThrottleLimits;
  /** Что сравнивалось по телу: пары сравнённые и пропущенные по родству. */
  readonly bodyComparison?: readonly BodyComparisonCoverage[];
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
  contexts: readonly RequestContextConfig[] = [],
): readonly ReportFinding[] {
  // Заголовки объявленных условий — по имени условий. Значения объявил человек
  // в конфигурации, секретов там нет и быть не может: учётные данные приходят
  // только из окружения и в отчёт не попадают ни при каких обстоятельствах.
  const headersOf = new Map(
    contexts
      .filter((context) => Object.keys(context.headers).length > 0)
      .map((c) => [c.id, c.headers]),
  );
  const byCell = new Map(
    observations.map((observation) => [
      `${observation.accountId}\u0000${observation.endpointId}\u0000${observation.resourceId ?? ""}`,
      observation,
    ]),
  );
  function withRequest<
    T extends { accountId: string; endpointId: string; resourceId?: string; contextId?: string },
  >(finding: T): T & { request?: RequestRecord } {
    const observation = byCell.get(
      `${finding.accountId}\u0000${finding.endpointId}\u0000${finding.resourceId ?? ""}`,
    );
    if (observation?.url === undefined || observation.method === undefined) {
      return finding;
    }
    // Атрибуты условий печатаются рядом с адресом, иначе воспроизведение
    // находки в условиях даёт **базовый** случай: параметры запроса видны
    // в адресе, а заголовки не видны нигде, и строка молча воспроизводит
    // не то. Найдено холодным чтением: так воспроизводились 43% находок.
    const contextHeaders =
      finding.contextId === undefined ? undefined : headersOf.get(finding.contextId);
    return {
      ...finding,
      request: {
        method: observation.method,
        url: observation.url,
        ...(contextHeaders === undefined ? {} : { contextHeaders }),
      },
      status: observation.status,
    };
  }

  /** Обращение второй стороны парной находки, если оно было. */
  function relatedRequestOf(check: Finding): { relatedRequest?: RequestRecord } {
    const other = check.evidence.otherAccountId;
    if (typeof other !== "string" || check.endpointId === undefined) {
      return {};
    }
    const observation = byCell.get(`${other}\u0000${check.endpointId}\u0000`);
    if (observation?.url === undefined || observation.method === undefined) {
      return {};
    }
    const contextHeaders =
      check.contextId === undefined ? undefined : headersOf.get(check.contextId);
    return {
      relatedRequest: {
        method: observation.method,
        url: observation.url,
        ...(contextHeaders === undefined ? {} : { contextHeaders }),
      },
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
        // Условия переносятся наравне с прочим. Поле перечислялось поимённо,
        // и новое молча терялось: находка проверки в условиях выглядела
        // базовой, группировка сливала её с базовой, а `request` печатался
        // без атрибутов. Найдено холодным чтением.
        ...(check.contextId === undefined ? {} : { contextId: check.contextId }),
        title: check.title,
        evidence: check.evidence,
        // Второе обращение пары. Берётся из наблюдений по имени второй стороны:
        // проверка о транспорте не знает и адреса не хранит.
        ...relatedRequestOf(check),
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

/**
 * Строки аккаунтов, включая аккаунты в условиях.
 *
 * Аккаунт в условиях — отдельная строка матрицы, и находка ссылается именно
 * на неё. Без такой строки в отчёте ссылка повисает: читатель видит
 * `alice-a@geo-blocked`, ищет его в списке аккаунтов и не находит.
 */
function withContextAccounts(
  options: BuildReportOptions,
): readonly (AccountConfig & { readonly contextId?: string; readonly baseAccountId?: string })[] {
  const base = options.config.accounts;
  const byId = new Map(base.map((account) => [account.id, account]));
  const derived: (AccountConfig & {
    readonly contextId: string;
    readonly baseAccountId: string;
  })[] = [];
  for (const account of options.accounts ?? []) {
    if (account.contextId === undefined) {
      continue;
    }
    const baseAccountId = principalOf(account);
    const source = byId.get(baseAccountId);
    if (source === undefined) {
      continue;
    }
    // Всё от исходного аккаунта — включая `tokenEnv`, от которого зависят
    // и признак анонимности, и то, какая схема будет напечатана.
    derived.push({ ...source, id: account.id, contextId: account.contextId, baseAccountId });
  }
  return [...base, ...derived];
}

/**
 * Ставит вердикт рядом с наблюдением.
 *
 * Прежде наблюдение вердиктов не выносило принципиально, и «здесь чисто»
 * существовало только суммой: чтобы проверить одну ячейку, читатель отчёта
 * переписывал ядро на своём языке. См. ADR-0020.
 */
function withVerdicts(options: BuildReportOptions): readonly ReportedObservation[] {
  const cells = options.cells ?? [];
  if (cells.length === 0) {
    return options.observations;
  }
  const byCell = new Map(
    cells.map((cell) => [
      `${cell.accountId}\u0000${cell.endpointId}\u0000${cell.resourceId ?? ""}`,
      cell,
    ]),
  );
  return options.observations.map((observation) => {
    const cell = byCell.get(
      `${observation.accountId}\u0000${observation.endpointId}\u0000${observation.resourceId ?? ""}`,
    );
    if (cell === undefined) {
      return observation;
    }
    return {
      ...observation,
      expected: cell.expected,
      match: cell.match,
      ...(cell.relation === undefined ? {} : { relation: cell.relation }),
      ...(cell.ruleIndex === undefined ? {} : { ruleIndex: cell.ruleIndex }),
    };
  });
}

/** Сколько ячеек пронаблюдено в каждых условиях, включая непроверенные. */
function countByContext(options: BuildReportOptions): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const context of options.config.contexts) {
    counts[context.id] = 0;
  }
  const contextOf = new Map(
    (options.accounts ?? [])
      .filter((account) => account.contextId !== undefined)
      .map((account) => [account.id, account.contextId]),
  );
  for (const observation of options.observations) {
    const contextId = contextOf.get(observation.accountId);
    if (contextId !== undefined) {
      counts[contextId] = (counts[contextId] ?? 0) + 1;
    }
  }
  return counts;
}

export function buildReport(options: BuildReportOptions): RunReport {
  const observations = withVerdicts(options);
  const merged = mergeFindings(
    options.findings,
    options.checks ?? [],
    options.observations,
    options.config.contexts,
  );
  const notObserved = options.findings.filter((finding) => finding.kind === "not-observed").length;
  // Вторая сторона парной находки лежит в `evidence`: группировка её не видит,
  // а без неё группа называет одну сторону утечки из двух.
  const groups = groupDefects(
    merged.map((finding) => {
      const other = finding.evidence?.otherAccountId;
      return typeof other === "string" ? { ...finding, counterpartAccountId: other } : finding;
    }),
  );
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
    accounts: withContextAccounts(options).map((account) => ({
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
      // Имя переменной, а не значение. Оно и так лежит в конфигурации, которую
      // положено коммитить, зато без него читатель отчёта не знает, каким
      // токеном воспроизводить находку. Найдено третьим холодным чтением.
      ...(account.tokenEnv === undefined ? {} : { tokenEnv: account.tokenEnv }),
      // Условия, в которых существует эта строка. Отсутствие — базовые.
      ...(account.contextId === undefined
        ? {}
        : { contextId: account.contextId, baseAccountId: account.baseAccountId }),
      // Каким контуром ходил аккаунт. У анонимного не пишется вовсе:
      // предъявлять ему нечего, и запись схемы там только путала. Без этого читатель не отличит «ручка
      // закрыта» от «мы стучались не тем транспортом»: и то и другое даёт 401.
      // Здесь только вид схемы и имя заголовка или куки — значений нет нигде.
      ...(account.tokenEnv === undefined
        ? {}
        : {
            // По исходному аккаунту: схема — свойство контура, а не строки
            // матрицы. Раньше строка в условиях искала схему по своему id,
            // не находила и печатала корневую — то есть поле врало ровно там,
            // где оно единственно и нужно: «ручка закрыта» против «стучались
            // не тем транспортом». Найдено холодным чтением.
            auth:
              options.config.accountAuth.get(account.baseAccountId ?? account.id) ??
              options.config.auth,
          }),
    })),
    endpoints: options.endpoints,
    resources: options.config.resources,
    skipped: options.skipped,
    failures: options.failures,
    unauthenticated: options.unauthenticated,
    canariesChecked: options.canariesChecked,
    canaries: options.canaries ?? [],
    truncated: options.truncated,
    observations,
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
      bodyComparison: options.bodyComparison ?? [],
      contextsProbed: countByContext(options),
      // Считается по самим вердиктам, а не вычитанием. Вычитание врало:
      // среди расхождений есть `not-observed`, у которых наблюдения нет вовсе,
      // и число занижалось. ADR-0020 обещает равенство с числом наблюдений,
      // у которых `match: true`, — теперь это одно и то же число, а не два.
      // Найдено состязательной проверкой.
      //
      // Ключа нет вовсе, когда вердиктов не считали: ноль читался бы как
      // «не совпало ни одной ячейки», то есть как утверждение о платформе,
      // а сказать нужно «мы этого не считали».
      ...(options.cells === undefined
        ? {}
        : {
            cellsMatched: observations.filter((observation) => observation.match === true).length,
          }),
    },
    inputs: {
      policy: options.policy,
      tenants: options.config.tenants ?? [],
      auth: options.config.auth,
      exclude: options.config.exclude,
      ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
      contexts: options.config.contexts.map((context) => ({
        id: context.id,
        ...(context.description === undefined ? {} : { description: context.description }),
        headers: context.headers,
        query: context.query,
        endpointIds: context.endpointIds,
        accountIds: context.accountIds,
      })),
    },
    defects: groups,
    summary: {
      endpoints: options.endpoints.length,
      accounts: options.config.accounts.length,
      accountRows: (options.accounts ?? options.config.accounts).length,
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
  // Ни одной канарейки — значит аутентификация не подтверждена ничем.
  // Предохранитель `findUnauthenticated` тут не помогает по построению: он
  // устроен как «объявлено доступным, но нигде не дали», а у политики из одних
  // запретов доступным не объявлено ничего, и он молчит.
  //
  // Найдено состязательной проверкой: стенд отвечал 401 на всё, токены были
  // протухшие, и отчёт вышел чистый с кодом 0 — да ещё и с `match: true`
  // на каждой из двенадцати ячеек. Это ровно тот случай, ради которого
  // двойка и существует: непроверенное не бывает чистым.
  //
  // Аккаунты без учётных данных из правила исключены: анонимному прогону —
  // «проверьте, что сюда нельзя вообще никому» — аутентифицировать нечего,
  // и требовать от него канарейку значило бы запретить законный сценарий.
  if (report.canariesChecked === 0 && report.accounts.some((account) => !account.anonymous)) {
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

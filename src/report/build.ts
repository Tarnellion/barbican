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

import type {
  AccessDiff,
  AccessObservation,
  DiffKind,
  Endpoint,
  Finding,
  Resource,
  Severity,
} from "../core/index.js";
import type { RunConfig } from "../io/config.js";
import type { ProbeFailure, SkippedEndpoint } from "../runner.js";

export interface ReportSummary {
  readonly endpoints: number;
  readonly accounts: number;
  readonly resources: number;
  readonly observations: number;
  readonly skipped: number;
  readonly failures: number;
  readonly findings: number;
  readonly byKind: Readonly<Record<DiffKind, number>>;
  /** Расхождения по серьёзности — с чего читателю начинать. См. ADR-0014. */
  readonly bySeverity: Readonly<Record<Severity, number>>;
  /** Находки проверок-плагинов. Считаются отдельно: у них своя природа. */
  readonly checkFindings: number;
}

export interface RunReport {
  readonly tool: { readonly name: string; readonly version: string };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly target: {
    readonly baseUrl: string;
    readonly allowedHosts: readonly string[];
  };
  readonly accounts: readonly {
    readonly id: string;
    readonly role: string;
    readonly tenant: string;
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
  /** Прогон оборвался, не дойдя до конца матрицы. */
  readonly truncated: boolean;
  readonly observations: readonly AccessObservation[];
  readonly findings: readonly AccessDiff[];
  /**
   * Находки проверок из реестра.
   *
   * Отдельно от `findings`: те — расхождения матрицы с объявленной политикой,
   * эти — выводы проверок, которым матрицы недостаточно. Смешать их значило бы
   * потерять различие между «доступ не совпал с намерением» и «ответ выглядит
   * так, будто фильтра нет».
   */
  readonly checks: readonly Finding[];
  readonly summary: ReportSummary;
}

export interface BuildReportOptions {
  readonly version: string;
  readonly config: RunConfig;
  readonly endpoints: readonly Endpoint[];
  readonly observations: readonly AccessObservation[];
  readonly skipped: readonly SkippedEndpoint[];
  readonly failures: readonly ProbeFailure[];
  readonly unauthenticated: readonly string[];
  readonly canariesChecked: number;
  readonly truncated: boolean;
  readonly findings: readonly AccessDiff[];
  /** Находки проверок из реестра. Отсутствие означает «проверки не запускались». */
  readonly checks?: readonly Finding[];
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

function countBySeverity(findings: readonly AccessDiff[]): Readonly<Record<Severity, number>> {
  const counts = { ...EMPTY_BY_SEVERITY };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

function countByKind(findings: readonly AccessDiff[]): Readonly<Record<DiffKind, number>> {
  const counts = { ...EMPTY_BY_KIND };
  for (const finding of findings) {
    counts[finding.kind] += 1;
  }
  return counts;
}

export function buildReport(options: BuildReportOptions): RunReport {
  return {
    tool: { name: "barbican", version: options.version },
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    target: {
      baseUrl: options.config.target.baseUrl,
      allowedHosts: options.config.target.allowedHosts,
    },
    // tokenEnv намеренно не переносится: имя переменной не секрет, но и смысла
    // в отчёте не несёт, а соблазн положить рядом значение убирает.
    accounts: options.config.accounts.map((account) => ({
      id: account.id,
      role: account.role,
      tenant: account.tenant,
    })),
    endpoints: options.endpoints,
    resources: options.config.resources,
    skipped: options.skipped,
    failures: options.failures,
    unauthenticated: options.unauthenticated,
    canariesChecked: options.canariesChecked,
    truncated: options.truncated,
    observations: options.observations,
    findings: options.findings,
    checks: options.checks ?? [],
    summary: {
      endpoints: options.endpoints.length,
      accounts: options.config.accounts.length,
      resources: options.config.resources.length,
      observations: options.observations.length,
      skipped: options.skipped.length,
      failures: options.failures.length,
      findings: options.findings.length,
      byKind: countByKind(options.findings),
      bySeverity: countBySeverity(options.findings),
      checkFindings: (options.checks ?? []).length,
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
    report.summary.byKind["privilege-escalation"] > 0 ||
    report.summary.byKind["unexpected-denial"] > 0
  ) {
    return 1;
  }
  // Находка проверки — такое же расхождение, как эскалация, просто увиденное
  // не по статусу. Молчать о ней кодом возврата значило бы, что прогон
  // с найденной межтенантной утечкой выглядит успешным в CI.
  return report.checks.some(
    (finding) => finding.severity === "high" || finding.severity === "critical",
  )
    ? 1
    : 0;
}

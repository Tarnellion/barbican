/**
 * Группировка расхождений по сигнатуре дефекта.
 *
 * Один дефект платформы даёт столько строк, сколько ячеек он задел. Прогон
 * против crAPI дал шесть строк на три BOLA — те же три дефекта, увиденные
 * с точки пользователя и с точки администратора. На референс-платформе один
 * отсутствующий фильтр даёт десять строк. Читать такой отчёт нельзя: числа
 * говорят о размере матрицы, а не о количестве проблем.
 */

import type { ResourceRelation, Severity } from "./types.js";

/**
 * Минимум, нужный для группировки.
 *
 * Структурный тип, а не `AccessDiff`: находки проверок группируются наравне
 * с расхождениями матрицы. У них нет ни `expected`, ни `actual`, но есть всё,
 * из чего складывается сигнатура, — и шесть клонов одной находки должны
 * схлопываться так же, как десять ячеек одного отсутствующего фильтра.
 */
export interface GroupableFinding {
  readonly accountId: string;
  /**
   * Вторая сторона находки, если она парная.
   *
   * У утечки по телу сторон две, а `accountId` называет одну. Группа
   * без второй читалась как «данные тенанта-a видны кому-то» — кому именно,
   * приходилось искать в `evidence` каждой строки. Найдено холодным чтением.
   */
  readonly counterpartAccountId?: string | undefined;
  readonly endpointId: string;
  readonly contextId?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly relation?: ResourceRelation | undefined;
  readonly kind: string;
  readonly severity: Severity;
}

/**
 * Сигнатура: эндпоинт, вид расхождения, отношение к объекту и условия обращения.
 *
 * Роль в сигнатуру намеренно не входит. Если ручку открыли и пользователю,
 * и администратору, дефект один — отсутствующая проверка, — а не два.
 *
 * Условия входят по той же причине, что и отношение: проверка страны и проверка
 * прав — разные механизмы платформы, ломаются независимо и чинятся в разных
 * местах, поэтому и дефекта здесь два, а не один.
 */
export interface DefectGroup {
  readonly endpointId: string;
  /** Условия обращения. Отсутствуют у расхождений в базовых условиях. */
  readonly contextId?: string;
  /** Вид расхождения либо идентификатор проверки. */
  readonly kind: string;
  /** Отсутствует у расхождений без объекта — доступ к функции целиком. */
  readonly relation?: ResourceRelation;
  /** Наибольшая серьёзность среди наблюдений группы. */
  readonly severity: Severity;
  /** Аккаунты, которых дефект касается — у парных находок обе стороны. */
  readonly accountIds: readonly string[];
  /** Объекты, на которых он наблюдался. Пусто у расхождений без объекта. */
  readonly resourceIds: readonly string[];
  /**
   * Сколько ячеек задето.
   *
   * Названо `violations`, а не `observations`: верхнеуровневый `observations`
   * означает «выполненных проб», и одно слово в двух смыслах читалось как
   * «дефект наблюдался на 10 пробах из скольких-то».
   */
  readonly violations: number;
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Разделитель ключа: символ, которого не бывает в идентификаторах.
 *
 * Записан escape-последовательностью, а не сырым байтом. Байт в исходнике
 * делал файл бинарным для `grep`: поиск по репозиторию молча пропускал его
 * целиком, а «совпадений нет» здесь читалось бы как «этого кода нет».
 */
const SEPARATOR = "\u0000";

function keyOf(diff: GroupableFinding): string {
  // Разделитель, которого не бывает в идентификаторах: склейка через дефис
  // допускала бы коллизию двух разных сигнатур в одну строку.
  return [diff.endpointId, diff.kind, diff.relation ?? "", diff.contextId ?? ""].join(SEPARATOR);
}

/**
 * Сводит расхождения к сигнатурам.
 *
 * **Это нижняя граница числа дефектов, а не точное значение.** Две разные
 * ошибки в платформе, дающие одинаковую сигнатуру, снаружи неразличимы:
 * «список моих заказов» и «список заказов моей группы» — разные запросы
 * с разными фильтрами, но ответ 200 там, где ожидался отказ, выглядит
 * одинаково. Верхняя граница — число самих наблюдений; истина между ними,
 * и инструмент её не знает.
 */
export function groupDefects(diffs: readonly GroupableFinding[]): readonly DefectGroup[] {
  const groups = new Map<
    string,
    {
      endpointId: string;
      kind: string;
      relation?: ResourceRelation;
      contextId?: string;
      severity: Severity;
      accounts: Set<string>;
      resources: Set<string>;
      violations: number;
    }
  >();

  for (const diff of diffs) {
    const key = keyOf(diff);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        endpointId: diff.endpointId,
        kind: diff.kind,
        ...(diff.relation === undefined ? {} : { relation: diff.relation }),
        ...(diff.contextId === undefined ? {} : { contextId: diff.contextId }),
        severity: diff.severity,
        accounts: new Set(
          diff.counterpartAccountId === undefined
            ? [diff.accountId]
            : [diff.accountId, diff.counterpartAccountId],
        ),
        resources: new Set(diff.resourceId === undefined ? [] : [diff.resourceId]),
        violations: 1,
      });
      continue;
    }
    existing.accounts.add(diff.accountId);
    if (diff.counterpartAccountId !== undefined) {
      existing.accounts.add(diff.counterpartAccountId);
    }
    if (diff.resourceId !== undefined) {
      existing.resources.add(diff.resourceId);
    }
    existing.violations += 1;
    if (SEVERITY_ORDER[diff.severity] < SEVERITY_ORDER[existing.severity]) {
      existing.severity = diff.severity;
    }
  }

  return [...groups.values()]
    .map((group) => ({
      endpointId: group.endpointId,
      kind: group.kind,
      ...(group.relation === undefined ? {} : { relation: group.relation }),
      ...(group.contextId === undefined ? {} : { contextId: group.contextId }),
      severity: group.severity,
      accountIds: [...group.accounts].sort(),
      resourceIds: [...group.resources].sort(),
      violations: group.violations,
    }))
    .sort((left, right) => {
      const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
      if (bySeverity !== 0) {
        return bySeverity;
      }
      return (
        left.endpointId.localeCompare(right.endpointId) ||
        left.kind.localeCompare(right.kind) ||
        (left.relation ?? "").localeCompare(right.relation ?? "") ||
        (left.contextId ?? "").localeCompare(right.contextId ?? "")
      );
    });
}

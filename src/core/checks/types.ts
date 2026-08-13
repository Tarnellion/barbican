/**
 * Интерфейс проверки.
 *
 * Проверки — плагины, а не хардкод: Модуль 2 (evidence-pack) добавляется
 * регистрацией новых проверок, а не переписыванием ядра.
 * См. docs/adr/0003-check-registry.md.
 */

import type { AccessMatrix, Severity } from "../types.js";

/**
 * Ссылка на пункт внешнего стандарта.
 *
 * Крючок для Модуля 2: маппинг проверок на пункты стандартов живёт
 * рядом с самой проверкой, а не в отдельной таблице, которая разъедется.
 */
export interface StandardRef {
  /** Идентификатор стандарта, например `OWASP-API-2023`. */
  readonly standard: string;
  /** Пункт внутри стандарта, например `API1`. */
  readonly clause: string;
}

/** Единичная находка проверки. */
export interface Finding {
  readonly checkId: string;
  readonly severity: Severity;
  readonly title: string;
  readonly endpointId?: string;
  readonly accountId?: string;
  /**
   * Условия обращения, в которых найдено.
   *
   * Обязательны здесь ровно по той же причине, что и у расхождений матрицы:
   * без них находка в условиях и такая же в базовых сливаются в одну группу
   * дефектов, а отчёт объявляет их одной поломкой платформы.
   */
  readonly contextId?: string;
  /**
   * Машиночитаемое обоснование находки.
   *
   * Только скаляры и только неконфиденциальные значения: статусы, флаги,
   * идентификаторы. Тела ответов и заголовки авторизации сюда не попадают.
   */
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Вход проверки.
 *
 * Только данные — проверка не ходит в сеть и не читает файлы.
 */
export interface CheckContext {
  readonly matrix: AccessMatrix;
}

export interface Check {
  readonly id: string;
  readonly description: string;
  readonly severity: Severity;
  readonly standards: readonly StandardRef[];
  /** Синхронная и чистая: одинаковый вход всегда даёт одинаковый выход. */
  run(context: CheckContext): readonly Finding[];
}

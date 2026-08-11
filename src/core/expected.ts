/**
 * Объявленная политика ожидаемого доступа.
 *
 * Ожидания задаёт человек, а не спецификация проверяемого API — обоснование
 * в ADR-0006. Здесь только разрешение политики в конкретный ожидаемый исход.
 */

import type { ExpectedOutcome, RoleId } from "./types.js";

/** Совпадает с любым значением поля. */
export const ANY = "*";

export type Any = typeof ANY;

export interface ExpectedAccessRule {
  /** Роли, к которым применимо правило, либо `*`. */
  readonly roles: readonly RoleId[] | Any;
  /** Идентификаторы эндпоинтов, к которым применимо правило, либо `*`. */
  readonly endpoints: readonly string[] | Any;
  readonly outcome: ExpectedOutcome;
}

export interface ExpectedAccessPolicy {
  /**
   * Исход для пар, не покрытых ни одним правилом.
   *
   * Значения по умолчанию нет намеренно: молчаливое «всё разрешено» или
   * «всё запрещено» одинаково опасно, когда от этого зависит вердикт
   * о наличии уязвимости.
   */
  readonly fallback: ExpectedOutcome;
  readonly rules: readonly ExpectedAccessRule[];
}

export class EmptyRuleSelectorError extends Error {
  constructor(index: number, field: "roles" | "endpoints") {
    super(
      `Правило #${index}: поле "${field}" — пустой список. ` +
        `Такое правило не применяется никогда; используйте "${ANY}" или удалите его.`,
    );
    this.name = "EmptyRuleSelectorError";
  }
}

function matches(selector: readonly string[] | Any, value: string): boolean {
  return selector === ANY || selector.includes(value);
}

/**
 * Проверяет политику на правила, которые не могут сработать.
 *
 * Пустой список в селекторе почти всегда опечатка, а не намерение: правило
 * молча не применяется, и человек считает, что что-то объявил.
 *
 * @throws {EmptyRuleSelectorError}
 */
export function assertPolicyIsSound(policy: ExpectedAccessPolicy): void {
  policy.rules.forEach((rule, index) => {
    if (rule.roles !== ANY && rule.roles.length === 0) {
      throw new EmptyRuleSelectorError(index, "roles");
    }
    if (rule.endpoints !== ANY && rule.endpoints.length === 0) {
      throw new EmptyRuleSelectorError(index, "endpoints");
    }
  });
}

/**
 * Разрешает политику в ожидаемый исход для пары «роль × эндпоинт».
 *
 * Выигрывает **последнее** подходящее правило: это позволяет задать широкое
 * правило и сузить его последующими.
 */
export function resolveExpected(
  policy: ExpectedAccessPolicy,
  roleId: RoleId,
  endpointId: string,
): ExpectedOutcome {
  let outcome = policy.fallback;
  for (const rule of policy.rules) {
    if (matches(rule.roles, roleId) && matches(rule.endpoints, endpointId)) {
      outcome = rule.outcome;
    }
  }
  return outcome;
}

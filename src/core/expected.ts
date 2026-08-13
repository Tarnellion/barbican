/**
 * Объявленная политика ожидаемого доступа.
 *
 * Ожидания задаёт человек, а не спецификация проверяемого API — обоснование
 * в ADR-0006. Здесь только разрешение политики в конкретный ожидаемый исход.
 */

import type { EndpointPattern } from "./selectors.js";
import { expandPattern } from "./selectors.js";
import type { Endpoint, ExpectedOutcome, ResourceRelation, RoleId } from "./types.js";

/** Совпадает с любым значением поля. */
export const ANY = "*";

export type Any = typeof ANY;

export interface ExpectedAccessRule {
  /** Роли, к которым применимо правило, либо `*`. */
  readonly roles: readonly RoleId[] | Any;
  /**
   * Эндпоинты, к которым применимо правило, либо `*`.
   *
   * Элемент — либо идентификатор, либо шаблон метода и пути. Шаблоны
   * раскрываются в идентификаторы `expandPolicy` до диффа, поэтому разрешение
   * политики про них ничего не знает.
   */
  readonly endpoints: readonly (string | EndpointPattern)[] | Any;
  /**
   * Отношение аккаунта к объекту, при котором правило действует.
   *
   * Отсутствие означает «при любом», включая обращения без объекта. Это
   * сохраняет смысл политик, написанных до появления ресурсов (ADR-0010).
   */
  readonly scope?: ResourceRelation | undefined;
  readonly outcome: ExpectedOutcome;
}

/**
 * Правило с уже раскрытыми шаблонами.
 *
 * Отдельный тип, а не проверка в рантайме: раскрытая политика присваивается
 * объявленной, но не наоборот, поэтому передать нераскрытую туда, где нужна
 * раскрытая, компилятор не даст. Иначе шаблон, доживший до сравнения, молча
 * не совпал бы ни с чем и увёл пары в `fallback`.
 */
export interface ResolvedAccessRule extends Omit<ExpectedAccessRule, "endpoints"> {
  readonly endpoints: readonly string[] | Any;
}

export interface ResolvedAccessPolicy extends Omit<ExpectedAccessPolicy, "rules"> {
  readonly rules: readonly ResolvedAccessRule[];
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
  policy: ResolvedAccessPolicy,
  roleId: RoleId,
  endpointId: string,
  relation?: ResourceRelation,
): ExpectedOutcome {
  let outcome = policy.fallback;
  for (const rule of policy.rules) {
    if (rule.scope !== undefined && rule.scope !== relation) {
      continue;
    }
    if (matches(rule.roles, roleId) && matches(rule.endpoints, endpointId)) {
      outcome = rule.outcome;
    }
  }
  return outcome;
}

/**
 * Раскрывает шаблоны в правилах в конкретные идентификаторы.
 *
 * Вызывается один раз, до построения матрицы. Так `resolveExpected` остаётся
 * функцией от идентификатора, а не от эндпоинта, и связанные с ней места —
 * в том числе проверка достоверности прогона — не меняются вовсе.
 *
 * @throws {UnmatchedPatternError} если шаблон не совпал ни с одним эндпоинтом.
 */
export function expandPolicy(
  policy: ExpectedAccessPolicy,
  endpoints: readonly Endpoint[],
): ResolvedAccessPolicy {
  return {
    ...policy,
    rules: policy.rules.map((rule) => {
      if (rule.endpoints === ANY) {
        return { ...rule, endpoints: ANY };
      }
      const ids = rule.endpoints.flatMap((entry) =>
        typeof entry === "string" ? [entry] : expandPattern(entry, endpoints),
      );
      // Дубли убираются: один эндпоинт мог подойти и по идентификатору,
      // и под шаблон. На результат это не влияет, но список в отчёте читается.
      return { ...rule, endpoints: [...new Set(ids)] };
    }),
  };
}

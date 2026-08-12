/**
 * Доменные типы ядра.
 *
 * Здесь только данные. Ни HTTP, ни файловой системы, ни глобального состояния —
 * см. docs/adr/0002-pure-core-and-json-source-of-truth.md.
 */

import type { TenantHierarchy, TenantNode } from "./tenancy.js";
import { FLAT_HIERARCHY } from "./tenancy.js";

/** Идентификатор тенанта в проверяемой платформе. */
export type TenantId = string;

/** Идентификатор роли в проверяемой платформе. */
export type RoleId = string;

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/**
 * Методы, выполняемые без явного флага `--unsafe-methods`.
 *
 * Инвариант безопасности: расширение этого списка меняет поведение инструмента
 * по умолчанию и требует записи в ADR.
 */
export const SAFE_METHODS = ["GET", "HEAD"] as const satisfies readonly HttpMethod[];

export type SafeMethod = (typeof SAFE_METHODS)[number];

/** Учётная запись, от имени которой выполняется обращение. */
export interface Account {
  readonly id: string;
  readonly roleId: RoleId;
  readonly tenantId: TenantId;
}

/** Эндпоинт как шаблон, без подставленных значений. */
export interface Endpoint {
  readonly id: string;
  readonly method: HttpMethod;
  /** Шаблон пути, например `/v1/players/{playerId}`. */
  readonly path: string;
  readonly operationId?: string;
  /**
   * Ответ обязан различаться между тенантами.
   *
   * Объявляется человеком и никогда не выводится: `GET /v1/health`, отдающий
   * всем одинаковое `{"status":"ok"}`, — законная одинаковость, а не утечка.
   * Без явной пометки отличить одно от другого нельзя. См. ADR-0011.
   */
  readonly tenantScoped?: boolean;
  /**
   * Дополнительные скаляры, вычисляемые над телом этого эндпоинта.
   *
   * Отдельно от `tenantScoped`: та пометка означает «ответ обязан различаться
   * между тенантами» и сама подразумевает дайджест, а здесь — то, что человек
   * объявил ради разбора находки, а не ради самой находки.
   */
  readonly signals?: readonly SignalSpec[];
}

/**
 * Значение сигнала над телом ответа.
 *
 * Строкового варианта нет намеренно: строка вмещает тело целиком, и запрет
 * на PII в отчёте из конструктивного стал бы дисциплинарным. Расширение типа
 * требует отдельного ADR — см. ADR-0011.
 */
export type SignalValue = number | boolean;

/** Что вычислять над телом. Объявляется человеком, не выводится. */
export type SignalSpec =
  | { readonly name: string; readonly kind: "digest" }
  | { readonly name: string; readonly kind: "count"; readonly path: string }
  | { readonly name: string; readonly kind: "present"; readonly path: string };

/**
 * Объект, к которому обращаются: значения параметров плюс владелец.
 *
 * Объявляется человеком, а не выуживается из ответов — обоснование в ADR-0010.
 * Утверждение «объект 1001 принадлежит игроку A» есть заявление о намерении,
 * ровно как и сама политика доступа.
 */
export interface Resource {
  readonly id: string;
  readonly tenantId: TenantId;
  /** Аккаунт-владелец. Отсутствует, если объект принадлежит тенанту целиком. */
  readonly ownerAccountId?: string;
  /** Значения для параметров пути по именам из шаблона. */
  readonly params: Readonly<Record<string, string>>;
  /** Параметры строки запроса. */
  readonly query?: Readonly<Record<string, string>>;
  /**
   * Эндпоинты, к которым относится объект.
   *
   * Нужно, когда идентификатор лежит в строке запроса, а не в пути: у такого
   * эндпоинта нет параметров в шаблоне, и связать его с объектом по совпадению
   * имён невозможно. Разведка crAPI показала, что так устроен целый BOLA
   * (`mechanic_report?report_id=N`).
   *
   * Отсутствие означает «по совпадению параметров пути».
   */
  readonly endpointIds?: readonly string[];
}

/**
 * Отношение аккаунта к объекту.
 *
 * Трёхзначно намеренно: администратору тенанта обычно положен доступ ко всем
 * объектам своего тенанта и не положен ни к одному чужому, и одним признаком
 * «не своё» это не выразить.
 */
/**
 * Все отношения одним списком — **источник истины**.
 *
 * Тип выводится отсюда, а не объявляется отдельно. Причина конкретная: схема
 * разбора конфигурации держала рукописный дубль этого перечня, он разошёлся
 * с типом при вводе иерархии, и `scope: descendant-tenant` отвергался на старте —
 * то есть возможность существовала в ядре и была недостижима через CLI.
 * Дубль, который нельзя проверить компилятором, рано или поздно расходится.
 */
export const RESOURCE_RELATIONS = [
  /** Владелец объекта — сам аккаунт. */
  "own",
  /** Тот же тенант, но другой владелец: сюда попадает BOLA внутри тенанта. */
  "same-tenant",
  /** Объект ниже по дереву: холдинг читает свой бренд. Обычно положено. */
  "descendant-tenant",
  /** Объект выше по дереву: бренд читает уровень холдинга. Обычно не положено. */
  "ancestor-tenant",
  /** Родства нет вовсе: чужой холдинг. Не положено никогда. */
  "foreign-tenant",
] as const;

export type ResourceRelation = (typeof RESOURCE_RELATIONS)[number];

/**
 * Определяет отношение аккаунта к объекту.
 *
 * Без дерева тенантов (`FLAT_HIERARCHY`) отвечает ровно так же, как до ADR-0013:
 * `descendant` и `ancestor` не возникают, любые разные тенанты — чужие.
 */
export function relationOf(
  account: Account,
  resource: Resource,
  hierarchy: TenantHierarchy = FLAT_HIERARCHY,
): ResourceRelation {
  if (account.tenantId === resource.tenantId) {
    return resource.ownerAccountId === account.id ? "own" : "same-tenant";
  }
  if (hierarchy.isAncestor(account.tenantId, resource.tenantId)) {
    return "descendant-tenant";
  }
  if (hierarchy.isAncestor(resource.tenantId, account.tenantId)) {
    return "ancestor-tenant";
  }
  return "foreign-tenant";
}

/** Чем закончилось обращение с точки зрения доступа. */
export type AccessOutcome = "allowed" | "denied" | "not-found" | "error";

/**
 * Наблюдённый результат одного обращения.
 *
 * Тело ответа отсутствует намеренно: там PII клиента. Вместо него — `signals`,
 * необратимые скаляры, вычисленные над телом и не позволяющие его восстановить.
 * Границы этого послабления заданы в ADR-0011; расширять `SignalValue` строкой
 * или объектом нельзя без отдельного ADR.
 */
export interface AccessObservation {
  readonly endpointId: string;
  readonly accountId: string;
  /** Объект обращения. Отсутствует у эндпоинтов без параметров. */
  readonly resourceId?: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly outcome: AccessOutcome;
  readonly durationMs: number;
  /**
   * Скаляры, вычисленные над телом. Само тело не сохраняется нигде — ADR-0011.
   */
  readonly signals?: Readonly<Record<string, SignalValue>>;
}

/** Фактическая матрица доступа: кто, куда и с каким результатом. */
export interface AccessMatrix {
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  readonly resources: readonly Resource[];
  readonly observations: readonly AccessObservation[];
  /**
   * Дерево тенантов. Отсутствие означает лес из корней без связей, то есть
   * поведение до ADR-0013.
   */
  readonly tenants?: readonly TenantNode[];
}

export type Severity = "info" | "low" | "medium" | "high" | "critical";

/**
 * Ожидаемый исход — бинарен.
 *
 * Фактический исход богаче (`not-found`, `error`), но декларировать «ожидаю 404»
 * бессмысленно: намерение состоит в том, доступ есть или его нет. Сведение
 * фактического к ожидаемому — задача диффа. См. ADR-0006.
 */
export type ExpectedOutcome = "allowed" | "denied";

/** Характер расхождения между намерением и реализацией. */
export type DiffKind =
  /** Ожидался отказ, доступ получен. Основная находка инструмента. */
  | "privilege-escalation"
  /** Ожидался доступ, получен отказ. Не уязвимость, но расхождение с намерением. */
  | "unexpected-denial"
  /** Пара «аккаунт × эндпоинт» не покрыта наблюдениями — вывод сделать нельзя. */
  | "not-observed"
  /** Обращение завершилось ошибкой: судить о доступе нельзя. */
  | "probe-error";

/** Расхождение между ожидаемым и фактическим доступом. */
export interface AccessDiff {
  readonly accountId: string;
  readonly endpointId: string;
  /** Объект обращения. Отсутствует у эндпоинтов без параметров. */
  readonly resourceId?: string;
  /** Отношение аккаунта к объекту. Отсутствует вместе с объектом. */
  readonly relation?: ResourceRelation;
  readonly expected: ExpectedOutcome;
  /** Отсутствует, если наблюдения для пары нет. */
  readonly actual?: AccessOutcome;
  readonly kind: DiffKind;
  /**
   * Вычисляется из вида расхождения и отношения, а не объявляется человеком.
   *
   * Человек объявляет ожидание — что положено, а что нет. Серьёзность же есть
   * свойство уже найденного расхождения: утечка в чужой тенант заведомо тяжелее
   * доступа к чужому объекту внутри своего. См. ADR-0014.
   */
  readonly severity: Severity;
}

/** Серьёзность расхождения. Таблица и обоснование — ADR-0014. */
export function severityOf(kind: DiffKind, relation?: ResourceRelation): Severity {
  if (kind === "not-observed" || kind === "probe-error") {
    return "low";
  }
  if (kind === "unexpected-denial") {
    return "medium";
  }
  if (relation === "foreign-tenant") {
    return "critical";
  }
  // Доступ к собственному объекту, объявленный запрещённым, — почти всегда
  // ошибка в политике, а не дыра в платформе. Ложная тревога уровня high здесь
  // обошлась бы дороже, чем понижение.
  if (relation === "own") {
    return "medium";
  }
  return "high";
}

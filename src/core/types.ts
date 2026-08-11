/**
 * Доменные типы ядра.
 *
 * Здесь только данные. Ни HTTP, ни файловой системы, ни глобального состояния —
 * см. docs/adr/0002-pure-core-and-json-source-of-truth.md.
 */

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
}

/** Чем закончилось обращение с точки зрения доступа. */
export type AccessOutcome = "allowed" | "denied" | "not-found" | "error";

/**
 * Наблюдённый результат одного обращения.
 *
 * Тело ответа отсутствует намеренно: по умолчанию не сохраняем — там PII клиента.
 * Если когда-нибудь понадобится, это должно быть отдельное опциональное поле
 * под явным флагом, а не молчаливое расширение этого типа.
 */
export interface AccessObservation {
  readonly endpointId: string;
  readonly accountId: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly outcome: AccessOutcome;
  readonly durationMs: number;
}

/** Фактическая матрица доступа: кто, куда и с каким результатом. */
export interface AccessMatrix {
  readonly endpoints: readonly Endpoint[];
  readonly accounts: readonly Account[];
  readonly observations: readonly AccessObservation[];
}

export type Severity = "info" | "low" | "medium" | "high" | "critical";

/** Расхождение между ожидаемым и фактическим доступом. */
export interface AccessDiff {
  readonly endpointId: string;
  readonly accountId: string;
  readonly expected: AccessOutcome;
  readonly actual: AccessOutcome;
}

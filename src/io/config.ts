/**
 * Разбор и проверка конфигурации прогона.
 *
 * Формат и его обоснование — ADR-0008. Ключевое: **учётные данные в файле
 * не хранятся**. Аккаунт называет имя переменной окружения, а не токен, поэтому
 * конфигурацию можно коммитить и ревьюить — ради чего декларация и заводилась.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Account, ExpectedAccessPolicy } from "../core/index.js";
import { ANY, assertPolicyIsSound } from "../core/index.js";

/** Тот же предел раскрытия алиасов, что и для спецификаций. */
const MAX_ALIAS_COUNT = 100;

const outcomeSchema = z.enum(["allowed", "denied"]);

const selectorSchema = z.union([z.literal(ANY), z.array(z.string().min(1)).min(1)]);

const ruleSchema = z.object({
  roles: selectorSchema,
  endpoints: selectorSchema,
  outcome: outcomeSchema,
});

const configSchema = z.object({
  target: z.object({
    baseUrl: z.url({ protocol: /^https?$/ }),
    allowedHosts: z.array(z.string().min(1)).min(1),
  }),
  accounts: z
    .array(
      z.object({
        id: z.string().min(1),
        role: z.string().min(1),
        tenant: z.string().min(1),
        tokenEnv: z.string().min(1),
      }),
    )
    .min(1),
  policy: z.object({
    fallback: outcomeSchema,
    rules: z.array(ruleSchema),
  }),
  /**
   * Эндпоинты, которые не трогать даже безопасным методом.
   *
   * Нужен, потому что GET не обязан быть безопасным на деле: адрес вида
   * `/createdb` сбрасывает базу, оставаясь GET.
   */
  exclude: z.array(z.string().min(1)).optional(),
});

export interface AccountConfig {
  readonly id: string;
  readonly role: string;
  readonly tenant: string;
  /** Имя переменной окружения с токеном. Не сам токен. */
  readonly tokenEnv: string;
}

export interface RunTarget {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
}

export interface RunConfig {
  readonly target: RunTarget;
  readonly accounts: readonly AccountConfig[];
  readonly policy: ExpectedAccessPolicy;
  readonly exclude: readonly string[];
}

export class ConfigParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Не удалось разобрать конфигурацию: ${message}`, options);
    this.name = "ConfigParseError";
  }
}

export class ConfigValidationError extends Error {
  constructor(details: string) {
    super(`Конфигурация не прошла проверку:\n${details}`);
    this.name = "ConfigValidationError";
  }
}

export class HostOutsideScopeError extends Error {
  constructor(host: string, allowedHosts: readonly string[]) {
    super(
      `Хост "${host}" из baseUrl не входит в allowedHosts (${allowedHosts.join(", ")}). ` +
        `Область проверки задаётся явно: опечатка в адресе не должна её расширять.`,
    );
    this.name = "HostOutsideScopeError";
  }
}

export class DuplicateAccountIdError extends Error {
  constructor(id: string) {
    super(`Аккаунт с id "${id}" объявлен больше одного раза`);
    this.name = "DuplicateAccountIdError";
  }
}

export class MissingCredentialError extends Error {
  readonly accountId: string;
  readonly variable: string;

  constructor(accountId: string, variable: string) {
    super(
      `Для аккаунта "${accountId}" не задана переменная окружения ${variable}. ` +
        `Токены передаются только через окружение и в конфигурации не хранятся.`,
    );
    this.name = "MissingCredentialError";
    this.accountId = accountId;
    this.variable = variable;
  }
}

/**
 * Разбирает и проверяет конфигурацию.
 *
 * @param source текст файла в YAML или JSON
 * @throws {ConfigParseError} документ не разбирается
 * @throws {ConfigValidationError} документ не соответствует схеме
 * @throws {HostOutsideScopeError} хост из baseUrl вне allowedHosts
 * @throws {DuplicateAccountIdError} повторяющийся id аккаунта
 */
export function parseRunConfig(source: string): RunConfig {
  let document: unknown;
  try {
    document = parseYaml(source, { maxAliasCount: MAX_ALIAS_COUNT });
  } catch (cause) {
    throw new ConfigParseError(cause instanceof Error ? cause.message : String(cause), { cause });
  }

  const parsed = configSchema.safeParse(document);
  if (!parsed.success) {
    throw new ConfigValidationError(z.prettifyError(parsed.error));
  }
  const config = parsed.data;

  const seen = new Set<string>();
  for (const account of config.accounts) {
    if (seen.has(account.id)) {
      throw new DuplicateAccountIdError(account.id);
    }
    seen.add(account.id);
  }

  // Проверяется здесь, а не при первом запросе: прогон должен падать до сети.
  const host = new URL(config.target.baseUrl).hostname.toLowerCase();
  const allowed = config.target.allowedHosts.map((entry) => entry.trim().toLowerCase());
  if (!allowed.includes(host)) {
    throw new HostOutsideScopeError(host, config.target.allowedHosts);
  }

  const policy: ExpectedAccessPolicy = config.policy;
  assertPolicyIsSound(policy);

  return {
    target: config.target,
    accounts: config.accounts,
    policy,
    exclude: config.exclude ?? [],
  };
}

/** Приводит аккаунты конфигурации к доменному типу ядра. */
export function toAccounts(config: RunConfig): readonly Account[] {
  return config.accounts.map((account) => ({
    id: account.id,
    roleId: account.role,
    tenantId: account.tenant,
  }));
}

export class InvalidCredentialError extends Error {
  readonly accountId: string;
  readonly variable: string;

  constructor(accountId: string, variable: string) {
    super(
      `Токен из ${variable} для аккаунта "${accountId}" содержит символы, недопустимые ` +
        `в значении HTTP-заголовка. Проверьте переменную: обычно это случайный перенос ` +
        `строки или скопированный текст с кириллицей.`,
    );
    this.name = "InvalidCredentialError";
    this.accountId = accountId;
    this.variable = variable;
  }
}

/** Значение заголовка допускает только видимый ASCII и табуляцию. */
const HEADER_SAFE = /^[\t\x20-\x7e]+$/;

/**
 * Достаёт токены из окружения.
 *
 * Возвращает отдельную карту, а не поле в конфигурации: так токен не может
 * случайно уехать в отчёт вместе с сериализованной конфигурацией.
 *
 * Пригодность для заголовка проверяется здесь, а не при первом запросе: иначе
 * одна опечатка в переменной обернулась бы десятками одинаковых сбоев посреди
 * прогона вместо одной внятной ошибки на старте.
 *
 * @throws {MissingCredentialError} переменная не задана или пуста
 * @throws {InvalidCredentialError} токен непригоден как значение заголовка
 */
export function resolveTokens(
  config: RunConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  for (const account of config.accounts) {
    const value = environment[account.tokenEnv];
    if (value === undefined || value.trim() === "") {
      throw new MissingCredentialError(account.id, account.tokenEnv);
    }
    if (!HEADER_SAFE.test(value)) {
      throw new InvalidCredentialError(account.id, account.tokenEnv);
    }
    tokens.set(account.id, value);
  }
  return tokens;
}

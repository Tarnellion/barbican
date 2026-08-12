/**
 * Разбор и проверка конфигурации прогона.
 *
 * Формат и его обоснование — ADR-0008. Ключевое: **учётные данные в файле
 * не хранятся**. Аккаунт называет имя переменной окружения, а не токен, поэтому
 * конфигурацию можно коммитить и ревьюить — ради чего декларация и заводилась.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AuthScheme } from "../adapters/credentials.js";
import { DEFAULT_AUTH_SCHEME } from "../adapters/credentials.js";
import type { Account, Endpoint, ExpectedAccessPolicy, Resource } from "../core/index.js";
import { ANY, assertPolicyIsSound } from "../core/index.js";

/** Тот же предел раскрытия алиасов, что и для спецификаций. */
const MAX_ALIAS_COUNT = 100;

const outcomeSchema = z.enum(["allowed", "denied"]);

const selectorSchema = z.union([z.literal(ANY), z.array(z.string().min(1)).min(1)]);

const relationSchema = z.enum(["own", "same-tenant", "foreign-tenant"]);

const ruleSchema = z.object({
  roles: selectorSchema,
  endpoints: selectorSchema,
  /** Отсутствие означает «при любом отношении», включая обращения без объекта. */
  scope: relationSchema.optional(),
  outcome: outcomeSchema,
});

const authSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bearer") }),
  z.object({ kind: z.literal("header"), header: z.string().min(1) }),
  z.object({ kind: z.literal("cookie"), name: z.string().min(1) }),
  z.object({ kind: z.literal("basic") }),
]);

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
        /**
         * Имя переменной окружения с токеном.
         *
         * Необязательно: аккаунт без него обращается анонимно. Без этого нельзя
         * проверить утверждение «этот адрес не должен быть публичным».
         */
        tokenEnv: z.string().min(1).optional(),
        /**
         * Эндпоинт, заведомо доступный этому аккаунту.
         *
         * Проверяется до основного прогона. Без него нельзя отличить «доступа
         * действительно нет» от «мы не аутентифицировались»: 401 читается как
         * отказ, отказ совпадает с ожиданием там, где доступ не положен, —
         * и прогон отрапортует «эскалаций не найдено», ничего не проверив.
         */
        canary: z.string().min(1).optional(),
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
  /** Объекты обращения и их владельцы — см. ADR-0010. */
  resources: z
    .array(
      z.object({
        id: z.string().min(1),
        tenant: z.string().min(1),
        owner: z.string().min(1).optional(),
        params: z.record(z.string().min(1), z.string()).optional(),
        query: z.record(z.string().min(1), z.string()).optional(),
        /**
         * Эндпоинты, к которым относится объект.
         *
         * Обязательно, когда идентификатор в строке запроса: у такого эндпоинта
         * нет параметров в пути, и связать его по совпадению имён невозможно.
         */
        endpoints: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .optional(),
  /**
   * Перечень тенантов.
   *
   * Необязателен, но если задан — имена тенантов у аккаунтов и объектов
   * сверяются с ним. Нужен потому, что опечатка в имени тенанта **прячет
   * находку**: объект уезжает в `foreign-tenant`, правило со `scope` перестаёт
   * применяться, и настоящая утечка проваливается в `fallback`.
   */
  tenants: z.array(z.string().min(1)).min(1).optional(),
  /** Схема аутентификации. По умолчанию Bearer — самый частый случай. */
  auth: authSchema.optional(),
});

export interface AccountConfig {
  readonly id: string;
  readonly role: string;
  readonly tenant: string;
  /** Имя переменной окружения с токеном. Не сам токен. Отсутствует у анонимных. */
  readonly tokenEnv?: string | undefined;
  /**
   * Эндпоинт, заведомо доступный этому аккаунту.
   *
   * `| undefined` явно: под `exactOptionalPropertyTypes` zod отдаёт именно
   * такой тип для необязательного поля.
   */
  readonly canary?: string | undefined;
}

export interface RunTarget {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
}

export interface RunConfig {
  readonly auth: AuthScheme;
  readonly target: RunTarget;
  readonly accounts: readonly AccountConfig[];
  readonly policy: ExpectedAccessPolicy;
  readonly exclude: readonly string[];
  readonly resources: readonly Resource[];
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

export class CredentialsInUrlError extends Error {
  constructor() {
    super(
      "В baseUrl указаны логин и пароль. Учётные данные передаются только через " +
        "переменные окружения: baseUrl копируется в отчёт дословно, а отчёт " +
        "по умолчанию печатается в stdout.",
    );
    this.name = "CredentialsInUrlError";
  }
}

export class DuplicateAccountIdError extends Error {
  constructor(id: string) {
    super(`Аккаунт с id "${id}" объявлен больше одного раза`);
    this.name = "DuplicateAccountIdError";
  }
}

export class UnknownResourceOwnerError extends Error {
  constructor(resourceId: string, owner: string) {
    super(
      `Ресурс "${resourceId}" объявлен принадлежащим аккаунту "${owner}", ` +
        `которого нет среди аккаунтов. Отношение «своё или чужое» стало бы неопределённым.`,
    );
    this.name = "UnknownResourceOwnerError";
  }
}

export class UnknownTenantError extends Error {
  constructor(where: string, tenant: string, known: readonly string[]) {
    super(
      `${where} относится к тенанту "${tenant}", которого нет среди объявленных ` +
        `(${known.join(", ")}). Опечатка здесь прячет находку: объект уезжает ` +
        `в «чужой тенант», правило со scope перестаёт применяться, и настоящая ` +
        `утечка проваливается в fallback.`,
    );
    this.name = "UnknownTenantError";
  }
}

export class UnknownEndpointReferenceError extends Error {
  constructor(where: string, endpointId: string) {
    super(
      `${where} ссылается на эндпоинт "${endpointId}", которого нет среди разобранных. ` +
        `Опечатка здесь не безобидна: правило молча перестаёт применяться, а объект — ` +
        `привязываться, и то и другое меняет вердикт, не оставляя следа в отчёте.`,
    );
    this.name = "UnknownEndpointReferenceError";
  }
}

/**
 * Сверяет ссылки на эндпоинты с фактически разобранным списком.
 *
 * Вызывается после разбора спецификации: раньше эндпоинтов ещё нет.
 *
 * Найдено прогоном против crAPI. Опечатка в одном символе давала два разных
 * плохих исхода. В ресурсе — четыре находки BOLA молча исчезали, а объект
 * оставался в отчёте как объявленный. В правиле политики — наоборот,
 * фабриковались находки: чтение пользователем **своего** заказа объявлялось
 * эскалацией привилегий, потому что правило, дающее доступ, перестало
 * применяться.
 *
 * Это тот же класс, который уже ловят `UnknownCanaryEndpointError`
 * и `EmptyRuleSelectorError`; здесь он был пропущен.
 *
 * @throws {UnknownEndpointReferenceError}
 */
export function assertReferencesResolve(config: RunConfig, endpoints: readonly Endpoint[]): void {
  const known = new Set(endpoints.map((endpoint) => endpoint.id));

  config.policy.rules.forEach((rule, index) => {
    if (rule.endpoints === ANY) {
      return;
    }
    for (const endpointId of rule.endpoints) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError(`Правило политики #${index}`, endpointId);
      }
    }
  });

  for (const resource of config.resources) {
    for (const endpointId of resource.endpointIds ?? []) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError(`Объект "${resource.id}"`, endpointId);
      }
    }
  }

  for (const account of config.accounts) {
    if (account.canary !== undefined && !known.has(account.canary)) {
      throw new UnknownEndpointReferenceError(`Канарейка аккаунта "${account.id}"`, account.canary);
    }
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

  // Пробелы по краям имени тенанта — всегда опечатка, и опечатка опасная:
  // «tenant-a » и «tenant-a» дают разные отношения и разный вердикт.
  const declaredTenants = config.tenants?.map((tenant) => tenant.trim());
  const accountTenants = config.accounts.map((account) => account.tenant.trim());
  if (declaredTenants !== undefined) {
    for (const [index, tenant] of accountTenants.entries()) {
      if (!declaredTenants.includes(tenant)) {
        throw new UnknownTenantError(
          `Аккаунт "${config.accounts[index]?.id ?? index}"`,
          tenant,
          declaredTenants,
        );
      }
    }
  }

  // Проверяется здесь, а не при первом запросе: прогон должен падать до сети.
  const target = new URL(config.target.baseUrl);
  if (target.username !== "" || target.password !== "") {
    throw new CredentialsInUrlError();
  }
  const allowed = config.target.allowedHosts.map((entry) => entry.trim().toLowerCase());
  // Запись с портом сверяется вместе с портом — та же логика, что в HTTP-клиенте.
  // Раньше конфигурация понимала только имя, и возможность клиента была
  // недостижима через CLI.
  if (
    !allowed.includes(target.hostname.toLowerCase()) &&
    !allowed.includes(target.host.toLowerCase())
  ) {
    throw new HostOutsideScopeError(target.host, config.target.allowedHosts);
  }

  const policy: ExpectedAccessPolicy = config.policy;
  assertPolicyIsSound(policy);

  const resources: Resource[] = [];
  const resourceIds = new Set<string>();
  for (const declared of config.resources ?? []) {
    if (resourceIds.has(declared.id)) {
      throw new DuplicateAccountIdError(declared.id);
    }
    resourceIds.add(declared.id);
    if (declared.owner !== undefined && !seen.has(declared.owner)) {
      throw new UnknownResourceOwnerError(declared.id, declared.owner);
    }
    const tenant = declared.tenant.trim();
    // Тенант объекта сверяется с объявленными, а при их отсутствии — с тенантами
    // аккаунтов. Второе слабее (объект чужого тенанта без аккаунта в нём —
    // законный случай), поэтому для строгой проверки заводится `tenants`.
    const knownTenants = declaredTenants ?? accountTenants;
    if (declaredTenants !== undefined && !knownTenants.includes(tenant)) {
      throw new UnknownTenantError(`Объект "${declared.id}"`, tenant, knownTenants);
    }
    resources.push({
      id: declared.id,
      tenantId: tenant,
      ...(declared.owner === undefined ? {} : { ownerAccountId: declared.owner }),
      params: declared.params ?? {},
      ...(declared.query === undefined ? {} : { query: declared.query }),
      ...(declared.endpoints === undefined ? {} : { endpointIds: declared.endpoints }),
    });
  }

  return {
    auth: config.auth ?? DEFAULT_AUTH_SCHEME,
    target: config.target,
    accounts: config.accounts,
    policy,
    exclude: config.exclude ?? [],
    resources,
  };
}

/** Приводит аккаунты конфигурации к доменному типу ядра. */
export function toAccounts(config: RunConfig): readonly Account[] {
  return config.accounts.map((account) => ({
    id: account.id,
    roleId: account.role,
    tenantId: account.tenant.trim(),
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
    if (account.tokenEnv === undefined) {
      // Анонимный аккаунт: учётных данных нет намеренно.
      continue;
    }
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

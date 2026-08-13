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
import { assertAuthSchemeIsSound, DEFAULT_AUTH_SCHEME } from "../adapters/credentials.js";
import type {
  Account,
  Endpoint,
  ExpectedAccessPolicy,
  Resource,
  TenantNode,
} from "../core/index.js";
import {
  ANY,
  assertIndependentMemberships,
  assertPolicyIsSound,
  createTenantHierarchy,
  FLAT_HIERARCHY,
  RESOURCE_RELATIONS,
} from "../core/index.js";

/** Тот же предел раскрытия алиасов, что и для спецификаций. */
const MAX_ALIAS_COUNT = 100;

const outcomeSchema = z.enum(["allowed", "denied"]);

const selectorSchema = z.union([z.literal(ANY), z.array(z.string().min(1)).min(1)]);

/**
 * Отбор эндпоинтов: идентификаторы вперемешку с шаблонами.
 *
 * Перечисление по `id` не масштабируется: на сотне ручек правило
 * «администратору положено всё под /v1/admin» становится списком, который
 * расходится с реальностью при первой же новой ручке — и молча.
 */
const endpointSelectorSchema = z.union([
  z.literal(ANY),
  z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).optional(),
          path: z.string().min(1),
        }),
      ]),
    )
    .min(1),
]);

// Перечень берётся из ядра, а не переписывается здесь: рукописный дубль уже
// разошёлся с типом и сделал иерархию тенантов недостижимой через CLI.
const relationSchema = z.enum(RESOURCE_RELATIONS);

const ruleSchema = z.object({
  roles: selectorSchema,
  endpoints: endpointSelectorSchema,
  /** Отсутствие означает «при любом отношении», включая обращения без объекта. */
  scope: relationSchema.optional(),
  outcome: outcomeSchema,
});

/**
 * Схема аутентификации.
 *
 * Объекты строгие намеренно: лишний ключ — ошибка, а не молча отброшенное поле.
 * Так `{ kind: bearer, token: "…" }` отвергается вместо того, чтобы притвориться
 * работающим, оставив секрет в файле, который положено коммитить. Значений
 * в схеме нет ни в каком виде: единственный источник — переменная окружения,
 * названная аккаунтом (ADR-0008).
 */
const authSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bearer") }),
  z.strictObject({ kind: z.literal("header"), header: z.string().min(1) }),
  z.strictObject({ kind: z.literal("cookie"), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal("basic") }),
]);

const configSchema = z.object({
  target: z.object({
    baseUrl: z.url({ protocol: /^https?$/ }),
    allowedHosts: z.array(z.string().min(1)).min(1),
  }),
  accounts: z
    .array(
      z
        .object({
          id: z.string().min(1),
          role: z.string().min(1),
          /**
           * Тенант аккаунта.
           *
           * Необязательно: аккаунт без него объявлен **вне тенантов**, и это
           * аноним. Служебного имени вроде `none` здесь быть не должно — оно
           * лежало бы в одном пространстве значений с настоящими именами, и
           * платформа с таким тенантом сломала бы классификацию молча.
           */
          tenant: z.string().min(1).optional(),
          /**
           * Несколько тенантов сразу — когда аккаунту положены тенанты,
           * не образующие поддерева (ADR-0017).
           *
           * Отдельный ключ, а не второе значение у `tenant`: «один тенант»
           * и «набор тенантов» — разные утверждения о проверяемой платформе,
           * и писать их одним словом значит поощрять оговорку. Меньше двух
           * элементов не принимается: набор из одного — это `tenant`, и две
           * записи одного смысла разошлись бы в чтении и в отчёте.
           */
          tenants: z
            .array(z.string().min(1))
            .min(2, "нужно не меньше двух тенантов: набор из одного — это поле tenant")
            .optional(),
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
          /**
           * Имя схемы аутентификации из `authSchemes`.
           *
           * Необязательно: без него аккаунт идёт по корневой `auth`. Здесь
           * **ссылка**, а не схема целиком, — параметры схемы (имя заголовка,
           * имя куки) принадлежат контуру, а не аккаунту, и повторённые
           * у каждого аккаунта они рано или поздно разойдутся опечаткой.
           * См. ADR-0017.
           */
          authScheme: z.string().min(1).optional(),
        })
        // Оба поля сразу — противоречие, а не уточнение: непонятно, какое
        // из них считать членством, и любое разрешение конфликта было бы
        // молчаливым выбором за человека.
        .refine((account) => account.tenant === undefined || account.tenants === undefined, {
          error:
            'у аккаунта заданы и "tenant", и "tenants". Это взаимоисключающие ' +
            "утверждения: один узел дерева либо набор узлов",
          path: ["tenants"],
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
  tenants: z
    .union([
      z.array(z.string().min(1)).min(1),
      z
        .array(
          z.object({
            id: z.string().min(1),
            /** Родитель. Отсутствие означает корень. См. ADR-0013. */
            parent: z.string().min(1).optional(),
            /**
             * Свой базовый адрес: бренды часто разнесены по поддоменам.
             * Хост обязан входить в `allowedHosts` — область проверки одна
             * на прогон, и объявление тенанта её не расширяет.
             */
            baseUrl: z.url({ protocol: /^https?$/ }).optional(),
          }),
        )
        .min(1),
    ])
    .optional(),
  /**
   * Схема аутентификации по умолчанию. Bearer, если не задана, — самый частый случай.
   *
   * Именно **по умолчанию**: аккаунт, не назвавший схему, идёт по ней. Прогон
   * против одного контура этим и ограничивается.
   */
  auth: authSchema.optional(),
  /**
   * Именованные схемы контуров.
   *
   * Контуров у мультибрендовой платформы несколько, и аутентифицируются они
   * по-разному: клиентское API по Bearer, операторская админка по сессионной
   * куке, кабинет аффилиата по ключу в своём заголовке. Имя объявляется один
   * раз здесь, аккаунт на него ссылается. См. ADR-0016.
   */
  authSchemes: z.record(z.string().min(1), authSchema).optional(),
  /**
   * Чтение тел ответов ради скалярных сигналов. Выключено, если секции нет.
   *
   * Тело читается **только** у перечисленных здесь эндпоинтов: там, где ответ
   * обязан различаться между тенантами, и совпадение — признак отсутствующего
   * фильтра. Совпадение этих двух списков не случайно: читать тело там, где
   * из этого не следует вывода, значит расширять поверхность риска впустую.
   * См. ADR-0011.
   */
  bodySignals: z
    .object({
      responseMustDifferByTenant: z.array(z.string().min(1)).min(1),
      maxBodyBytes: z.number().int().positive().optional(),
      /**
       * Дополнительные скаляры для отчёта.
       *
       * Находок сами по себе не порождают — они нужны человеку, разбирающему
       * находку дайджеста. «Совпали ответы у alice и carol» — сигнал тревоги,
       * но триаж начинается с вопроса «а сколько записей кто увидел».
       *
       * `digest` здесь не объявляется: его смысл задаётся объявлением
       * `responseMustDifferByTenant` и проверкой, которая его читает.
       * Дайджест без потребителя бесполезен.
       */
      signals: z
        .array(
          z.object({
            name: z.string().min(1),
            kind: z.enum(["count", "present"]),
            path: z.string(),
            endpoints: z.array(z.string().min(1)).min(1),
          }),
        )
        .min(1)
        .optional(),
    })
    .optional(),
});

export interface AccountConfig {
  readonly id: string;
  readonly role: string;
  /** Тенант. Отсутствует у аккаунта вне тенантов, то есть у анонимного. */
  readonly tenant?: string | undefined;
  /**
   * Набор тенантов — когда аккаунту положены узлы, не образующие поддерева.
   *
   * Взаимоисключающе с `tenant` и содержит не меньше двух имён: набор
   * из одного и есть `tenant`. См. ADR-0017.
   */
  readonly tenants?: readonly string[] | undefined;
  /** Имя переменной окружения с токеном. Не сам токен. Отсутствует у анонимных. */
  readonly tokenEnv?: string | undefined;
  /**
   * Эндпоинт, заведомо доступный этому аккаунту.
   *
   * `| undefined` явно: под `exactOptionalPropertyTypes` zod отдаёт именно
   * такой тип для необязательного поля.
   */
  readonly canary?: string | undefined;
  /** Имя схемы из `authSchemes`. Отсутствует у аккаунта, идущего по умолчанию. */
  readonly authScheme?: string | undefined;
}

export interface RunTarget {
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
}

/** Узел дерева тенантов плюс необязательный свой базовый адрес. */
export interface TenantConfig extends TenantNode {
  readonly baseUrl?: string;
}

export interface DeclaredSignal {
  readonly name: string;
  readonly kind: "count" | "present";
  readonly path: string;
  /** Эндпоинты, у которых этот скаляр вычисляется. */
  readonly endpoints: readonly string[];
}

export interface BodySignalsConfig {
  /**
   * Эндпоинты, ответ которых обязан различаться между тенантами.
   *
   * Это объявление оператора, а не свойство проверяемого API: инструмент
   * не выводит его ниоткуда и без него тело не читает вовсе.
   */
  readonly responseMustDifferByTenant: readonly string[];
  readonly maxBodyBytes?: number | undefined;
  readonly signals?: readonly DeclaredSignal[] | undefined;
}

export class DuplicateSignalNameError extends Error {
  constructor(name: string) {
    super(
      `Сигнал с именем "${name}" объявлен больше одного раза. Имена — ключи ` +
        `в наблюдении, и повторное имя молча затирало бы предыдущий скаляр.`,
    );
    this.name = "DuplicateSignalNameError";
  }
}

export interface RunConfig {
  /** Схема по умолчанию: по ней идёт аккаунт, не назвавший свою. */
  readonly auth: AuthScheme;
  /**
   * Схема на аккаунт: id аккаунта → разрешённая схема. Пусто, если
   * переопределений нет.
   *
   * Готовая карта, а не имена ссылок: ссылки разрешаются при разборе, чтобы
   * опечатка падала на старте, а не превращалась в прогон без аутентификации.
   */
  readonly accountAuth: ReadonlyMap<string, AuthScheme>;
  readonly target: RunTarget;
  readonly accounts: readonly AccountConfig[];
  readonly policy: ExpectedAccessPolicy;
  readonly exclude: readonly string[];
  readonly resources: readonly Resource[];
  readonly bodySignals?: BodySignalsConfig | undefined;
  /** Дерево тенантов. Отсутствие означает лес из корней без связей. */
  readonly tenants?: readonly TenantConfig[] | undefined;
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

/** Входит ли хост адреса в область проверки. Запись с портом сверяется с портом. */
function hostAllowed(url: URL, allowedHosts: readonly string[]): boolean {
  const allowed = allowedHosts.map((entry) => entry.trim().toLowerCase());
  return allowed.includes(url.hostname.toLowerCase()) || allowed.includes(url.host.toLowerCase());
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
  constructor(where = "В baseUrl") {
    super(
      `${where} указаны логин и пароль. Учётные данные передаются только через ` +
        "переменные окружения: адрес копируется в отчёт дословно, а отчёт " +
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

/**
 * Ссылка на схему, которой не объявлено.
 *
 * Падает на старте намеренно. Аккаунт с неразрешённой ссылкой пошёл бы по схеме
 * по умолчанию, платформа ответила бы 401 — а сплошной отказ совпадает с
 * политикой везде, где доступ не положен. Отчёт вышел бы чистым, и чистота
 * означала бы «мы не представились», а не «дыр нет». Канарейка это поймала бы,
 * но она необязательна, а опечатка — нет.
 */
export class UnknownAuthSchemeError extends Error {
  constructor(accountId: string, name: string, known: readonly string[]) {
    super(
      `Аккаунт "${accountId}" ссылается на схему аутентификации "${name}", которой нет ` +
        `среди объявленных в authSchemes ` +
        `(${known.length === 0 ? "не объявлено ни одной" : known.join(", ")}). ` +
        `Опечатка здесь прячет результат: аккаунт ушёл бы на прогон с чужой схемой, ` +
        `получил бы сплошной 401, а сплошной отказ совпадает с политикой там, где ` +
        `доступ не положен, — и отчёт выглядел бы чистым.`,
    );
    this.name = "UnknownAuthSchemeError";
  }
}

/**
 * Объявленная схема, на которую никто не ссылается.
 *
 * Тот же класс, что шаблон эндпоинтов, не совпавший ни с чем: объявление,
 * которое ни разу не применилось, выглядит проверенным утверждением, не будучи
 * им. Практически это забытый `authScheme` у аккаунта — то есть ровно тот
 * случай, когда прогон идёт не тем контуром и молчит об этом.
 */
export class UnusedAuthSchemeError extends Error {
  constructor(name: string) {
    super(
      `Схема аутентификации "${name}" объявлена, но ни один аккаунт на неё не ссылается. ` +
        `Скорее всего у аккаунта забыт authScheme: он пойдёт по схеме по умолчанию, ` +
        `получит 401 — и прогон промолчит. Мёртвое объявление выглядит проверенным ` +
        `утверждением, не будучи им.`,
    );
    this.name = "UnusedAuthSchemeError";
  }
}

/**
 * Схема у аккаунта, которому нечего предъявлять.
 *
 * Аккаунт без `tokenEnv` обращается анонимно, и схема к нему неприменима: класть
 * в заголовок нечего. Само по себе это безобидно, но ссылка «использует» схему,
 * и настоящий аккаунт того же контура, у которого `authScheme` забыт, перестаёт
 * быть виден проверкой на неиспользуемую схему.
 */
export class AuthSchemeWithoutTokenError extends Error {
  constructor(accountId: string, name: string) {
    super(
      `Аккаунт "${accountId}" ссылается на схему "${name}", но не называет tokenEnv. ` +
        `Аккаунт без токена обращается анонимно, предъявлять по схеме нечего: ` +
        `либо у аккаунта забыт tokenEnv, либо ссылка на схему лишняя.`,
    );
    this.name = "AuthSchemeWithoutTokenError";
  }
}

export class DuplicateResourceIdError extends Error {
  constructor(id: string) {
    super(`Объект с id "${id}" объявлен больше одного раза`);
    this.name = "DuplicateResourceIdError";
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
    for (const entry of rule.endpoints) {
      // Шаблоны проверяет expandPolicy: там видно, совпал ли он хоть с чем-то.
      if (typeof entry !== "string") {
        continue;
      }
      if (!known.has(entry)) {
        throw new UnknownEndpointReferenceError(`Правило политики #${index}`, entry);
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

  // Опечатка здесь отказывает молча и закрыто: тело не читается, проверка
  // не срабатывает, отчёт выглядит чистым. Тот же класс, что и опечатка
  // в имени тенанта, — молчаливое сужение области проверки.
  for (const endpointId of config.bodySignals?.responseMustDifferByTenant ?? []) {
    if (!known.has(endpointId)) {
      throw new UnknownEndpointReferenceError("Объявление responseMustDifferByTenant", endpointId);
    }
  }

  const seenNames = new Set<string>();
  for (const signal of config.bodySignals?.signals ?? []) {
    if (seenNames.has(signal.name)) {
      throw new DuplicateSignalNameError(signal.name);
    }
    seenNames.add(signal.name);
    for (const endpointId of signal.endpoints) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError(`Сигнал "${signal.name}"`, endpointId);
      }
    }
  }
}

/**
 * Переносит на эндпоинты объявление `responseMustDifferByTenant` из конфигурации.
 *
 * Источники эндпоинтов (спецификация, список, коллекция Postman) о тенантах
 * ничего не знают и знать не должны: это заявление человека о намерении,
 * ровно как и политика доступа. См. ADR-0006 и ADR-0011.
 */
export function applyBodySignals(
  endpoints: readonly Endpoint[],
  config: RunConfig,
): readonly Endpoint[] {
  const mustDiffer = new Set(config.bodySignals?.responseMustDifferByTenant ?? []);
  const declared = config.bodySignals?.signals ?? [];
  if (mustDiffer.size === 0 && declared.length === 0) {
    return endpoints;
  }
  return endpoints.map((endpoint) => {
    const extra = declared
      .filter((signal) => signal.endpoints.includes(endpoint.id))
      .map(({ name, kind, path }) => ({ name, kind, path }) as const);
    return {
      ...endpoint,
      ...(mustDiffer.has(endpoint.id) ? { responseMustDifferByTenant: true } : {}),
      ...(extra.length === 0 ? {} : { signals: extra }),
    };
  });
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
 * Разрешает ссылки аккаунтов на именованные схемы аутентификации.
 *
 * Все три ошибки — про одно и то же: прогон, идущий не тем контуром, выглядит
 * не как сбой, а как чистый отчёт. Поэтому они падают здесь, до первого запроса.
 *
 * @throws {InvalidAuthSchemeError} схему нельзя отправить
 * @throws {UnknownAuthSchemeError} ссылка не разрешается
 * @throws {UnusedAuthSchemeError} схема объявлена, но не используется
 * @throws {AuthSchemeWithoutTokenError} схема у аккаунта без токена
 */
function resolveAccountAuth(
  declared: Readonly<Record<string, AuthScheme>> | undefined,
  accounts: readonly {
    readonly id: string;
    readonly tokenEnv?: string | undefined;
    readonly authScheme?: string | undefined;
  }[],
): ReadonlyMap<string, AuthScheme> {
  // Карта, а не индексация по объекту: `authScheme: constructor` на обычном
  // объекте вернул бы унаследованное свойство вместо `undefined`, и ссылка
  // «разрешилась» бы во что попало.
  const schemes = new Map<string, AuthScheme>(Object.entries(declared ?? {}));
  for (const [name, scheme] of schemes) {
    assertAuthSchemeIsSound(scheme, `схема "${name}"`);
  }

  const resolved = new Map<string, AuthScheme>();
  const used = new Set<string>();
  for (const account of accounts) {
    if (account.authScheme === undefined) {
      continue;
    }
    const scheme = schemes.get(account.authScheme);
    if (scheme === undefined) {
      throw new UnknownAuthSchemeError(account.id, account.authScheme, [...schemes.keys()]);
    }
    if (account.tokenEnv === undefined) {
      throw new AuthSchemeWithoutTokenError(account.id, account.authScheme);
    }
    used.add(account.authScheme);
    resolved.set(account.id, scheme);
  }

  for (const name of schemes.keys()) {
    if (!used.has(name)) {
      throw new UnusedAuthSchemeError(name);
    }
  }

  return resolved;
}

/**
 * Разбирает и проверяет конфигурацию.
 *
 * @param source текст файла в YAML или JSON
 * @throws {ConfigParseError} документ не разбирается
 * @throws {ConfigValidationError} документ не соответствует схеме
 * @throws {HostOutsideScopeError} хост из baseUrl вне allowedHosts
 * @throws {DuplicateAccountIdError} повторяющийся id аккаунта
 * @throws {UnknownAuthSchemeError} аккаунт ссылается на необъявленную схему
 * @throws {UnusedAuthSchemeError} объявленная схема никем не используется
 * @throws {AuthSchemeWithoutTokenError} схема у аккаунта без tokenEnv
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

  const accountAuth = resolveAccountAuth(config.authSchemes, config.accounts);

  // Пробелы по краям имени тенанта — всегда опечатка, и опечатка опасная:
  // «tenant-a » и «tenant-a» дают разные отношения и разный вердикт.
  //
  // Краткая форма (список строк) означает лес из корней без связей — поведение
  // до ADR-0013. Развёрнутая объявляет родство явно.
  const tenantNodes: readonly TenantConfig[] | undefined = config.tenants?.map((entry) =>
    typeof entry === "string"
      ? { id: entry.trim() }
      : {
          id: entry.id.trim(),
          ...(entry.parent === undefined ? {} : { parentId: entry.parent.trim() }),
          ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
        },
  );
  // Дерево строится здесь, чтобы неизвестный родитель и цикл падали на старте,
  // а не посреди прогона против чужого стенда.
  const hierarchy = tenantNodes === undefined ? FLAT_HIERARCHY : createTenantHierarchy(tenantNodes);
  if (tenantNodes !== undefined) {
    for (const node of tenantNodes) {
      if (node.baseUrl === undefined) {
        continue;
      }
      const url = new URL(node.baseUrl);
      if (url.username !== "" || url.password !== "") {
        throw new CredentialsInUrlError(`Базовый адрес тенанта "${node.id}"`);
      }
      // Область проверки одна на прогон: адрес тенанта её не расширяет.
      if (!hostAllowed(url, config.target.allowedHosts)) {
        throw new HostOutsideScopeError(url.host, config.target.allowedHosts);
      }
    }
  }
  const declaredTenants = tenantNodes?.map((node) => node.id);
  // Членства аккаунта одним списком: у обычного аккаунта их ноль или одно,
  // у аккаунта с набором — несколько. Дальше все проверки идут по списку,
  // и случай «набор» не заводит себе отдельной ветки в каждой из них.
  const membershipsOf = (account: AccountConfig): readonly string[] =>
    account.tenants?.map((tenant) => tenant.trim()) ??
    (account.tenant === undefined ? [] : [account.tenant.trim()]);
  // Аккаунт без тенанта в сверку не входит и записи в перечне не требует:
  // он объявлен вне тенантов, а не отнесён к какому-то из них. Требовать для
  // него строки в `tenants` значило бы вернуть сентинел через чёрный ход.
  const accountTenants = config.accounts.flatMap(membershipsOf);
  for (const account of config.accounts) {
    const memberships = membershipsOf(account);
    if (declaredTenants !== undefined) {
      for (const tenant of memberships) {
        if (!declaredTenants.includes(tenant)) {
          throw new UnknownTenantError(`Аккаунт "${account.id}"`, tenant, declaredTenants);
        }
      }
    }
    // Повтор и вложенность в наборе меняют отношение молча — см. ADR-0017.
    // Проверка идёт после сверки имён: на неизвестном тенанте вложенность
    // всё равно не определена, и внятнее сказать про имя.
    assertIndependentMemberships(`Аккаунт "${account.id}"`, memberships, hierarchy);
  }

  // Проверяется здесь, а не при первом запросе: прогон должен падать до сети.
  const target = new URL(config.target.baseUrl);
  if (target.username !== "" || target.password !== "") {
    throw new CredentialsInUrlError();
  }
  // Запись с портом сверяется вместе с портом — та же логика, что в HTTP-клиенте.
  // Раньше конфигурация понимала только имя, и возможность клиента была
  // недостижима через CLI.
  if (!hostAllowed(target, config.target.allowedHosts)) {
    throw new HostOutsideScopeError(target.host, config.target.allowedHosts);
  }

  const policy: ExpectedAccessPolicy = config.policy;
  assertPolicyIsSound(policy);

  const resources: Resource[] = [];
  const resourceIds = new Set<string>();
  for (const declared of config.resources ?? []) {
    if (resourceIds.has(declared.id)) {
      throw new DuplicateResourceIdError(declared.id);
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
    accountAuth,
    target: config.target,
    accounts: config.accounts,
    policy,
    exclude: config.exclude ?? [],
    ...(config.bodySignals === undefined ? {} : { bodySignals: config.bodySignals }),
    ...(tenantNodes === undefined ? {} : { tenants: tenantNodes }),
    resources,
  };
}

/** Приводит аккаунты конфигурации к доменному типу ядра. */
export function toAccounts(config: RunConfig): readonly Account[] {
  return config.accounts.map((account) => {
    if (account.tenants !== undefined) {
      // Набор доезжает до ядра набором. Свести его к «первому тенанту»
      // означало бы объявить остальные членства чужими — ровно та подмена,
      // из-за которой законное чтение второго бренда выглядело эскалацией.
      return {
        id: account.id,
        roleId: account.role,
        tenantIds: account.tenants.map((tenant) => tenant.trim()),
      };
    }
    return {
      id: account.id,
      roleId: account.role,
      // Поле не проставляется вовсе, а не заполняется заглушкой: отсутствие
      // тенанта — это утверждение «аккаунт вне тенантов», и оно должно доехать
      // до `relationOf` как отсутствие.
      ...(account.tenant === undefined ? {} : { tenantId: account.tenant.trim() }),
    };
  });
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

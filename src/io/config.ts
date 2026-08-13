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
import type { ContextAttributes } from "../adapters/ports.js";
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

/**
 * Ожидаемый исход. Умолчания нет намеренно — и сообщение объясняет почему.
 *
 * Найдено холодным чтением: `Invalid option: expected one of "allowed"|"denied"`
 * читается как придирка к форме, тогда как речь о содержании — отсутствие
 * умолчания здесь и есть решение.
 */
const outcomeSchema = z.enum(["allowed", "denied"], {
  error:
    'expected "allowed" or "denied". `fallback` has no default on purpose: ' +
    "a silent «everything is allowed» or «everything is denied» is equally " +
    "dangerous when a verdict about a vulnerability rests on it. Say plainly " +
    "what cells no rule covers should count as",
});

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

/**
 * Правило политики. Объект строгий: лишний ключ — ошибка, а не отброшенное поле.
 *
 * Найдено прогоном полигона против старой сборки: нераспознанный `context`
 * молча отбрасывался, и правило «запретить в этих условиях» превращалось
 * в «запретить всегда» — 19 находок на исправной платформе. Та же опечатка
 * в `scope` расширяет правило на все отношения и, наоборот, **прячет**
 * находку. Молча в обе стороны.
 */
const ruleSchema = z.strictObject({
  roles: selectorSchema,
  endpoints: endpointSelectorSchema,
  /** Отсутствие означает «при любом отношении», включая обращения без объекта. */
  scope: relationSchema.optional(),
  /**
   * Имя условий обращения из `contexts`.
   *
   * Отсутствие означает **базовые** условия, а не «любые»: иначе объявление
   * новых условий молча распространило бы на них все прежние ожидания,
   * и платформа, законно закрывающая ставку из запрещённой страны, дала бы
   * «неожиданный отказ» на каждой ручке. См. ADR-0019.
   */
  context: z.string().min(1).optional(),
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

/**
 * Значение атрибута условий: литерал либо имя переменной окружения.
 *
 * Заведено потому, что значение атрибута печатается в отчёте дословно —
 * и человеку, которому нужна в условиях подпись устройства или партнёрский
 * ключ, деться было некуда, кроме открытого текста в конфигурации. Форма
 * `{ env: ИМЯ }` повторяет `tokenEnv` у аккаунта: в отчёт уезжает **имя**,
 * значение живёт только в окружении.
 */
const contextValueSchema = z.union([z.string(), z.strictObject({ env: z.string().min(1) })]);

const configSchema = z.object({
  target: z.object({
    baseUrl: z.url({ protocol: /^https?$/ }),
    allowedHosts: z
      .array(z.string().min(1), {
        error:
          "a list of hosts is required: without an explicitly drawn scope, a run " +
          "against an undeclared host is not testing, it is scanning someone " +
          "else's system. An entry without a port allows any port, with a port — " +
          "exactly that one",
      })
      .min(1, "the host list cannot be empty: there would be nothing to allow"),
    /**
     * Как называется проверяемая система: окружение, версия, что угодно
     * опознающее.
     *
     * Объявляется человеком, потому что инструмент этого знать не может:
     * `baseUrl` вида `http://127.0.0.1:8787` не отличает прогон против
     * прод-подобного стенда от прогона демо-полигона, а отпечаток
     * конфигурации опознаёт **наше объявление**, а не цель. Читатель отчёта
     * без этого поля не имеет права заводить тикет на платформу: артефакт
     * не называет платформу.
     */
    label: z.string().min(1).optional(),
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
            .min(2, "at least two tenants are required: a set of one is the `tenant` field")
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
            'the account declares both "tenant" and "tenants". These are mutually ' +
            "exclusive statements: one node of the tree, or a set of nodes",
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
   * Условия обращения — минимальный полезный кусок ABAC.
   *
   * Тот же аккаунт с той же ролью, но обращение помечено атрибутами: адрес
   * другой страны, устройство, непройденный KYC. Инструмент не моделирует
   * логику решения платформы — он сравнивает **исходы** двух объявленных
   * наборов условий. См. ADR-0019.
   *
   * `endpoints` обязателен: условия без границ умножили бы матрицу на всю
   * поверхность API, а стоимость прогона на чужом стенде — не мелочь.
   */
  contexts: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        /** Человеческое описание: что именно объявлено этими атрибутами. */
        description: z.string().min(1).optional(),
        headers: z.record(z.string().min(1), contextValueSchema).optional(),
        query: z.record(z.string().min(1), contextValueSchema).optional(),
        endpoints: z.array(z.string().min(1)).min(1),
        /** Аккаунты, к которым условия применяются. Отсутствие — ко всем. */
        accounts: z.array(z.string().min(1)).min(1).optional(),
      }),
    )
    .min(1)
    .optional(),
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
  /** Опознание проверяемой системы. Объявляется человеком. */
  readonly label?: string | undefined;
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
      `Signal name "${name}" is declared more than once. Names are keys in the ` +
        `observation, so a repeated name would silently overwrite the previous scalar.`,
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
  /** Условия обращения. Пусто, если не объявлены. */
  readonly contexts: readonly RequestContextConfig[];
}

/**
 * Объявленные условия обращения.
 *
 * Атрибуты — заголовки и параметры запроса — живут здесь, а не в ядре: ядро
 * об HTTP не знает и знать не должно, ему достаточно метки `contextId`.
 */
/**
 * Значение атрибута: либо строка, либо ссылка на переменную окружения.
 *
 * В отчёт уезжает ровно эта форма, поэтому секрет в отчёт попасть не может:
 * `{ env: "DEVICE_SIGNATURE" }` называет переменную, а не значение.
 */
export type ContextAttributeValue = string | { readonly env: string };

export interface RequestContextConfig {
  readonly id: string;
  readonly description?: string | undefined;
  readonly headers: Readonly<Record<string, ContextAttributeValue>>;
  readonly query: Readonly<Record<string, ContextAttributeValue>>;
  /** Ручки, на которых условия применяются. Не бывает пустым. */
  readonly endpointIds: readonly string[];
  /** Аккаунты, к которым применяются. Пусто — ко всем. */
  readonly accountIds: readonly string[];
}

export class ConfigParseError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(`Could not parse the configuration: ${message}`, options);
    this.name = "ConfigParseError";
  }
}

export class ConfigValidationError extends Error {
  constructor(details: string) {
    super(`The configuration is invalid:\n${details}`);
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
      `Host "${host}" from baseUrl is not in allowedHosts (${allowedHosts.join(", ")}). ` +
        `The scope is declared explicitly: a typo in an address must not widen it.`,
    );
    this.name = "HostOutsideScopeError";
  }
}

export class CredentialsInUrlError extends Error {
  constructor(where = "baseUrl") {
    super(
      `${where} carries a login and password. Credentials are passed only through ` +
        "environment variables: the address is copied into the report verbatim, " +
        "and the report goes to stdout by default.",
    );
    this.name = "CredentialsInUrlError";
  }
}

export class DuplicateAccountIdError extends Error {
  constructor(id: string) {
    super(`An account with id "${id}" is declared more than once`);
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
      `Account "${accountId}" references authentication scheme "${name}", which is not ` +
        `declared in authSchemes ` +
        `(${known.length === 0 ? "none are declared" : known.join(", ")}). ` +
        `A typo here hides the result: the account would run with someone else's scheme, ` +
        `get 401 everywhere, and a blanket denial agrees with the policy wherever access ` +
        `is not meant to be granted — so the report would come out clean.`,
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
      `Authentication scheme "${name}" is declared, but no account references it. ` +
        `Most likely an account is missing its authScheme: it will fall back to the ` +
        `default scheme, get 401 — and the run will say nothing. A dead declaration ` +
        `looks like a tested statement without being one.`,
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
      `Account "${accountId}" references scheme "${name}" but names no tokenEnv. ` +
        `An account without a token calls anonymously, so the scheme has nothing to ` +
        `present: either tokenEnv is missing, or the scheme reference is redundant.`,
    );
    this.name = "AuthSchemeWithoutTokenError";
  }
}

export class DuplicateResourceIdError extends Error {
  constructor(id: string) {
    super(`A resource with id "${id}" is declared more than once`);
    this.name = "DuplicateResourceIdError";
  }
}

export class UnknownResourceOwnerError extends Error {
  constructor(resourceId: string, owner: string) {
    super(
      `Resource "${resourceId}" is declared as owned by account "${owner}", which is ` +
        `not among the declared accounts. The «own or foreign» relation would be undefined.`,
    );
    this.name = "UnknownResourceOwnerError";
  }
}

export class UnknownTenantError extends Error {
  constructor(where: string, tenant: string, known: readonly string[]) {
    super(
      `${where} belongs to tenant "${tenant}", which is not among the declared ones ` +
        `(${known.join(", ")}). A typo here hides a finding: the resource drifts ` +
        `into «foreign tenant», a rule with a scope stops applying, and a real ` +
        `leak falls through to the fallback.`,
    );
    this.name = "UnknownTenantError";
  }
}

/**
 * Атрибуты условий не могут подменять учётные и управляющие заголовки.
 *
 * Список хардкодный и из пользовательского ввода не берётся. Условия, тихо
 * переписавшие `Authorization`, дали бы прогон, где половина ячеек ходит
 * не тем аккаунтом, — а выглядело бы это как находки платформы.
 */
export class ForbiddenContextHeaderError extends Error {
  constructor(contextId: string, header: string, reason: string) {
    super(
      `Context "${contextId}" sets header "${header}": ${reason}. ` +
        `Context attributes are added to a request, they do not replace its substance.`,
    );
    this.name = "ForbiddenContextHeaderError";
  }
}

export class ForbiddenContextQueryError extends Error {
  constructor(contextId: string, key: string, reason: string) {
    super(
      `Context "${contextId}" sets query parameter "${key}": ${reason}. ` +
        `Context attributes are added to a request, they do not replace its substance.`,
    );
    this.name = "ForbiddenContextQueryError";
  }
}

export class DuplicateContextIdError extends Error {
  constructor(contextId: string) {
    super(
      `Context "${contextId}" is declared twice. Which one would apply cannot be ` +
        `determined, and the outcome depends on the answer.`,
    );
    this.name = "DuplicateContextIdError";
  }
}

export class UnusedContextError extends Error {
  constructor(contextId: string) {
    super(
      `Context "${contextId}" is declared, but no policy rule references it. ` +
        `Expectations under a context are declared explicitly: without a rule, every ` +
        `cell of that context falls through to the fallback, and the report fills up ` +
        `with discrepancies nobody claimed. Write a rule with "context: ${contextId}" ` +
        `— at least one, declaring the general outcome.`,
    );
    this.name = "UnusedContextError";
  }
}

export class UnknownContextReferenceError extends Error {
  constructor(index: number, contextId: string, declared: readonly string[]) {
    super(
      `Policy rule #${index} references context "${contextId}", which does not exist. ` +
        `Declared: ${declared.length === 0 ? "none" : declared.join(", ")}. ` +
        `A typo here silently changes the verdict: the rule applies to no cell at all.`,
    );
    this.name = "UnknownContextReferenceError";
  }
}

export class UnknownContextAccountError extends Error {
  constructor(contextId: string, accountId: string) {
    super(
      `Context "${contextId}" references account "${accountId}", which is not among ` +
        `the declared accounts. The context would simply apply to nobody.`,
    );
    this.name = "UnknownContextAccountError";
  }
}

export class UnknownEndpointReferenceError extends Error {
  constructor(where: string, endpointId: string) {
    super(
      `${where} references endpoint "${endpointId}", which is not among the parsed ones. ` +
        `A typo here is not harmless: a rule silently stops applying and a resource ` +
        `silently stops binding — both change the verdict without leaving a trace ` +
        `in the report.`,
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
        throw new UnknownEndpointReferenceError(`Policy rule #${index}`, entry);
      }
    }
  });

  for (const resource of config.resources) {
    for (const endpointId of resource.endpointIds ?? []) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError(`Resource "${resource.id}"`, endpointId);
      }
    }
  }

  for (const context of config.contexts) {
    for (const endpointId of context.endpointIds) {
      if (!known.has(endpointId)) {
        throw new UnknownEndpointReferenceError(`Context "${context.id}"`, endpointId);
      }
    }
  }

  for (const account of config.accounts) {
    if (account.canary !== undefined && !known.has(account.canary)) {
      throw new UnknownEndpointReferenceError(
        `The canary of account "${account.id}"`,
        account.canary,
      );
    }
  }

  // Опечатка здесь отказывает молча и закрыто: тело не читается, проверка
  // не срабатывает, отчёт выглядит чистым. Тот же класс, что и опечатка
  // в имени тенанта, — молчаливое сужение области проверки.
  for (const endpointId of config.bodySignals?.responseMustDifferByTenant ?? []) {
    if (!known.has(endpointId)) {
      throw new UnknownEndpointReferenceError(
        "The responseMustDifferByTenant declaration",
        endpointId,
      );
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
        throw new UnknownEndpointReferenceError(`Signal "${signal.name}"`, endpointId);
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
      `Environment variable ${variable} is not set for account "${accountId}". ` +
        `Tokens are passed through the environment only and are never stored in ` +
        `the configuration.`,
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
    assertAuthSchemeIsSound(scheme, `scheme "${name}"`);
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
export class UncarriableKeyError extends Error {
  constructor(path: string) {
    super(
      `The configuration contains a key "${path}" that JavaScript cannot carry as ` +
        `data: assigning it sets an object's prototype instead of adding a key, so ` +
        `the entry silently disappears. A declaration that does nothing and says ` +
        `nothing is worse than an error — rename the key.`,
    );
    this.name = "UncarriableKeyError";
  }
}

/**
 * Отвергает ключи, которые молча пропадают при разборе.
 *
 * `__proto__` в объектном литерале ключом не становится, и объявленный
 * заголовок условий исчезал бы, не уйдя по проводу и не пожаловавшись.
 * Загрязнения прототипа при этом не происходит — проверено, — но молчаливое
 * исчезновение объявления и есть тот класс ошибок, против которого написан
 * весь инструмент. Проверяется на **сыром** документе: к моменту валидации
 * ключа уже нет.
 *
 * @throws {UncarriableKeyError}
 */
function assertNoUncarriableKeys(node: unknown, path = ""): void {
  if (typeof node !== "object" || node === null) {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      assertNoUncarriableKeys(item, `${path}[${index}]`);
    });
    return;
  }
  for (const key of Object.getOwnPropertyNames(node)) {
    const where = path === "" ? key : `${path}.${key}`;
    if (key === "__proto__") {
      throw new UncarriableKeyError(where);
    }
    assertNoUncarriableKeys((node as Record<string, unknown>)[key], where);
  }
}

export function parseRunConfig(source: string): RunConfig {
  let document: unknown;
  try {
    document = parseYaml(source, { maxAliasCount: MAX_ALIAS_COUNT });
  } catch (cause) {
    throw new ConfigParseError(cause instanceof Error ? cause.message : String(cause), { cause });
  }

  assertNoUncarriableKeys(document);

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
        throw new CredentialsInUrlError(`The base address of tenant "${node.id}"`);
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
          throw new UnknownTenantError(`Account "${account.id}"`, tenant, declaredTenants);
        }
      }
    }
    // Повтор и вложенность в наборе меняют отношение молча — см. ADR-0017.
    // Проверка идёт после сверки имён: на неизвестном тенанте вложенность
    // всё равно не определена, и внятнее сказать про имя.
    assertIndependentMemberships(`Account "${account.id}"`, memberships, hierarchy);
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
      throw new UnknownTenantError(`Resource "${declared.id}"`, tenant, knownTenants);
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

  const contexts = normalizeContexts(config.contexts ?? [], {
    accountIds: seen,
    policy,
    auth: config.auth ?? DEFAULT_AUTH_SCHEME,
    accountAuth,
    // Ключи строки запроса, принадлежащие объектам: атрибут условий, совпавший
    // с таким ключом, молча переписывал бы адрес объекта — см. ниже.
    resourceQueryKeys: new Set(resources.flatMap((r) => Object.keys(r.query ?? {}))),
  });

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
    contexts,
  };
}

export class MethodOverrideInContextError extends Error {
  constructor(contextId: string, where: string, value: string) {
    super(
      `Context "${contextId}" sets ${where} to "${value}" — that is the name of an ` +
        `HTTP method. Platforms that honour method override (Rails, Laravel, Symfony, ` +
        `Spring, most API gateways) will perform a write for such a request even ` +
        `while a GET goes over the wire: the safe-method gate looks at the request ` +
        `method and cannot see that bypass. If writing is the intention, run with ` +
        `--unsafe-methods and the report will say so honestly.`,
    );
    this.name = "MethodOverrideInContextError";
  }
}

/**
 * Отвергает атрибуты условий, которыми подменяют метод обращения.
 *
 * Проверка **по значению**, а не по имени, и в этом весь смысл. Имён у подмены
 * метода десяток и будет больше; значение же у неё всегда одно — имя метода.
 * Правило ловит и `x-http-method-override`, и вендорский заголовок, о котором
 * я никогда не слышал, и `_method` в строке запроса.
 *
 * Живёт отдельно от разбора конфигурации, потому что зависит от флага прогона:
 * с `--unsafe-methods` человек уже согласился на запись, и запрещать нечего.
 *
 * Найдено состязательной проверкой. Стенд удалил объект по обращению, которое
 * инструмент считал чтением, а отчёт написал `writeMethodsProbed: false`.
 *
 * @throws {MethodOverrideInContextError}
 */
export function assertContextsCannotWrite(
  contexts: ReadonlyMap<string, ContextValues>,
  options: { readonly allowUnsafeMethods: boolean },
): void {
  if (options.allowUnsafeMethods) {
    return;
  }
  const methods = new Set(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);
  // Проверяются **разрешённые** значения, а не объявленные: значение из
  // переменной окружения на момент разбора конфигурации ещё неизвестно,
  // и проверка объявления пропустила бы `x-vendor-verb: { env: VERB }`
  // с `VERB=DELETE` в окружении.
  for (const [contextId, values] of contexts) {
    for (const [name, value] of Object.entries(values.headers)) {
      if (methods.has(value.trim().toUpperCase())) {
        throw new MethodOverrideInContextError(contextId, `header "${name}"`, value);
      }
    }
    for (const [key, value] of Object.entries(values.query)) {
      if (methods.has(value.trim().toUpperCase())) {
        throw new MethodOverrideInContextError(contextId, `query parameter "${key}"`, value);
      }
    }
  }
}

/** Разрешённые значения атрибутов одних условий. */
export interface ContextValues {
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

export class MissingContextValueError extends Error {
  constructor(contextId: string, attribute: string, variable: string) {
    super(
      `Environment variable ${variable} is not set for ${attribute} of context ` +
        `"${contextId}". Context attributes may take their value from the environment ` +
        `exactly like account tokens do — and for the same reason: the value would ` +
        `otherwise sit in a configuration file that is meant to be committed.`,
    );
    this.name = "MissingContextValueError";
  }
}

export class InvalidContextValueError extends Error {
  constructor(contextId: string, attribute: string, variable: string) {
    super(
      `The value from ${variable} for ${attribute} of context "${contextId}" contains ` +
        `characters that cannot be carried in a request. Check the variable: usually ` +
        `a stray line break or text pasted from a non-ASCII source.`,
    );
    this.name = "InvalidContextValueError";
  }
}

/**
 * Разрешает значения атрибутов условий: литералы как есть, ссылки — из окружения.
 *
 * Отдельным шагом, как `resolveTokens`: окружение передаётся явно, а не читается
 * изнутри. Значение из окружения в отчёт не попадает — там остаётся объявление
 * `{ env: ИМЯ }`.
 *
 * @throws {MissingContextValueError} переменная не задана или пуста
 * @throws {InvalidContextValueError} значение нельзя отправить в обращении
 */
export function resolveContextValues(
  config: RunConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, ContextValues> {
  const resolved = new Map<string, ContextValues>();
  for (const context of config.contexts) {
    const take = (
      source: Readonly<Record<string, ContextAttributeValue>>,
      kind: "header" | "query parameter",
    ): Record<string, string> => {
      const out: Record<string, string> = Object.create(null);
      for (const [name, declared] of Object.entries(source)) {
        if (typeof declared === "string") {
          out[name] = declared;
          continue;
        }
        const where = `${kind} "${name}"`;
        const value = environment[declared.env];
        if (value === undefined || value.trim() === "") {
          throw new MissingContextValueError(context.id, where, declared.env);
        }
        if (!CONTEXT_VALUE_SAFE.test(value)) {
          throw new InvalidContextValueError(context.id, where, declared.env);
        }
        out[name] = value;
      }
      return out;
    };
    resolved.set(context.id, {
      headers: take(context.headers, "header"),
      query: take(context.query, "query parameter"),
    });
  }
  return resolved;
}

/**
 * Заголовки, которых условия задавать не могут.
 *
 * Хардкод, а не настройка: список охраняет основу обращения, и брать его
 * из того же файла, что и сами условия, значило бы охранять дверь ключом,
 * висящим на ней снаружи. `authorization` и `cookie` — учётные данные;
 * `host` уводит запрос за пределы области проверки при неизменном адресе;
 * остальные ломают сам обмен.
 */
const FORBIDDEN_CONTEXT_HEADERS: ReadonlyMap<string, string> = new Map([
  ["authorization", "these are the account's credentials"],
  ["proxy-authorization", "these are credentials"],
  ["cookie", "these are the account's credentials"],
  ["host", "overriding the host takes the request outside the declared scope"],
  ["forwarded", "a routing header: it changes the recipient, not the conditions"],
  ["content-length", "a transport header, not an attribute of the request"],
  ["transfer-encoding", "a transport header, not an attribute of the request"],
  ["connection", "a transport header, not an attribute of the request"],
  ["te", "a transport header, not an attribute of the request"],
  ["upgrade", "a transport header, not an attribute of the request"],
  ["expect", "a transport header, not an attribute of the request"],
]);

/**
 * Семейства заголовков, меняющих **смысл** обращения, а не его условия.
 *
 * Найдено состязательной проверкой, и находка была худшего сорта: условия
 * с `x-http-method-override: DELETE` заставили платформу удалить объект,
 * пока по проводу шёл GET, — а отчёт при этом писал `writeMethodsProbed: false`.
 * Гейт `SAFE_METHODS` смотрит на метод в запросе и такой обход не видит.
 *
 * Префиксом, а не точным именем: у override-заголовка десяток написаний
 * (`X-HTTP-Method`, `X-HTTP-Method-Override`, `X-Method-Override`), и список
 * точных имён отстанет от следующего фреймворка. `x-forwarded-for` при этом
 * разрешён намеренно — это и есть типовой атрибут гео-условий; запрещены
 * только те `x-forwarded-*`, что меняют адресата.
 */
const FORBIDDEN_HEADER_PREFIXES: readonly (readonly [string, string])[] = [
  ["x-http-method", "a method-override header: the platform will write behind a GET"],
  ["x-method", "a method-override header: the platform will write behind a GET"],
  ["x-original-", "a path-override header: the request would go past the declared path"],
  ["x-rewrite-", "a path-override header: the request would go past the declared path"],
  ["x-forwarded-host", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-proto", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-port", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-prefix", "a routing header: it changes the recipient, not the conditions"],
  ["x-forwarded-uri", "a routing header: it changes the recipient, not the conditions"],
];

/**
 * Ключи строки запроса, которыми предъявляют учётные данные.
 *
 * Токен в строке запроса — это другой аккаунт: платформа обслужит обращение
 * как его, а отчёт напишет исходный `baseAccountId`. Найдено состязательной
 * проверкой: `access_token` в условиях обслуживался как чужой аккаунт, и вся
 * половина матрицы ходила не тем, кем отчёт её называл. Плюс само значение
 * уехало бы в отчёт открытым текстом — адреса обращений там печатаются.
 */
const FORBIDDEN_QUERY_KEYS: ReadonlySet<string> = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "authorization",
  "id_token",
  "jwt",
  "session",
  "sessionid",
  "session_id",
  "token",
]);

/** Значение заголовка: только видимый ASCII и таб — иначе `fetch` его не отправит. */
const CONTEXT_VALUE_SAFE = /^[\t\x20-\x7e]*$/;

/** Имя заголовка по RFC 9110: видимые ASCII без разделителей. */
const CONTEXT_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Приводит объявленные условия к рабочему виду и отвергает негодные.
 *
 * Все проверки здесь — про молчаливую подмену: условия, переписавшие учётный
 * заголовок, дают прогон не тем аккаунтом; условия без правила дают ворох
 * расхождений, которых никто не заявлял; опечатка в имени — правило,
 * не применяющееся ни к чему.
 */
function normalizeContexts(
  declared: readonly {
    readonly id: string;
    readonly description?: string | undefined;
    readonly headers?: Readonly<Record<string, ContextAttributeValue>> | undefined;
    readonly query?: Readonly<Record<string, ContextAttributeValue>> | undefined;
    readonly endpoints: readonly string[];
    readonly accounts?: readonly string[] | undefined;
  }[],
  options: {
    readonly accountIds: ReadonlySet<string>;
    readonly resourceQueryKeys: ReadonlySet<string>;
    readonly policy: ExpectedAccessPolicy;
    readonly auth: AuthScheme;
    readonly accountAuth: ReadonlyMap<string, AuthScheme>;
  },
): readonly RequestContextConfig[] {
  // Имя заголовка и куки объявлено человеком, поэтому в запретный список
  // они попадают из разобранных схем, а не из строки конфигурации.
  const inUse = new Set<string>();
  for (const scheme of [options.auth, ...options.accountAuth.values()]) {
    if (scheme.kind === "header") {
      inUse.add(scheme.header.toLowerCase());
    }
  }

  const referenced = new Set(
    options.policy.rules
      .map((rule) => rule.context)
      .filter((context): context is string => context !== undefined),
  );
  const ids = new Set(declared.map((context) => context.id));
  // Ссылки правил сверяются раньше проверки на неиспользуемые условия:
  // опечатка в ссылке даёт оба симптома сразу, но сказать «условия объявлены,
  // но никем не используются» человеку, который их как раз использовал,
  // значит увести его не туда. Первым сообщается то, что он и правил.
  options.policy.rules.forEach((rule, index) => {
    if (rule.context !== undefined && !ids.has(rule.context)) {
      throw new UnknownContextReferenceError(index, rule.context, [...ids]);
    }
  });

  const contexts: RequestContextConfig[] = [];
  const seenIds = new Set<string>();

  for (const context of declared) {
    if (seenIds.has(context.id)) {
      throw new DuplicateContextIdError(context.id);
    }
    seenIds.add(context.id);

    // Без прототипа: имя `__proto__` в обычном объектном литерале не становится
    // ключом, а молча исчезает — объявленный заголовок не ушёл бы по проводу,
    // и никто бы об этом не узнал. Найдено ревью после состязательной проверки.
    const headers: Record<string, ContextAttributeValue> = Object.create(null);
    for (const [name, value] of Object.entries(context.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!CONTEXT_HEADER_NAME.test(name)) {
        throw new ForbiddenContextHeaderError(
          context.id,
          name,
          "this is not a header name per RFC 9110 — a request carrying it would not " +
            "be sent at all",
        );
      }
      // Значение из окружения здесь не проверить — его ещё нет. Оно сверяется
      // при разрешении, ровно как токен аккаунта.
      if (typeof value === "string" && !CONTEXT_VALUE_SAFE.test(value)) {
        throw new ForbiddenContextHeaderError(
          context.id,
          name,
          "the value contains characters a header cannot carry: every cell of such " +
            "a run would die with an opaque request failure",
        );
      }
      const forbidden =
        FORBIDDEN_CONTEXT_HEADERS.get(lower) ??
        FORBIDDEN_HEADER_PREFIXES.find(([prefix]) => lower.startsWith(prefix))?.[1];
      if (forbidden !== undefined) {
        throw new ForbiddenContextHeaderError(context.id, name, forbidden);
      }
      if (inUse.has(lower)) {
        throw new ForbiddenContextHeaderError(
          context.id,
          name,
          "credentials are presented through this header",
        );
      }
      headers[lower] = value;
    }

    for (const [key, value] of Object.entries(context.query ?? {})) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_QUERY_KEYS.has(lower)) {
        throw new ForbiddenContextQueryError(
          context.id,
          key,
          "credentials are presented through this: the platform would serve the " +
            "request as a different account while the report names the original one — " +
            "and the value itself would land in the report in the clear, because " +
            "request URLs are printed there",
        );
      }
      // Ключ объекта, переписанный условиями, — самая тихая из подмен:
      // вердикт считается по объявленному объекту, а спрашивается другой.
      // Найдено состязательной проверкой: межтенантная утечка легла в отчёт
      // как «свой объект, проверено и совпало».
      if (options.resourceQueryKeys.has(key)) {
        throw new ForbiddenContextQueryError(
          context.id,
          key,
          "resources identify themselves with this key in the query string: the " +
            "context would rewrite the resource address while the verdict was computed " +
            "for the declared one",
        );
      }
      if (typeof value === "string" && !CONTEXT_VALUE_SAFE.test(value)) {
        throw new ForbiddenContextQueryError(
          context.id,
          key,
          "the value contains characters a request URL cannot carry",
        );
      }
    }

    for (const accountId of context.accounts ?? []) {
      if (!options.accountIds.has(accountId)) {
        throw new UnknownContextAccountError(context.id, accountId);
      }
    }

    if (!referenced.has(context.id)) {
      throw new UnusedContextError(context.id);
    }

    contexts.push({
      id: context.id,
      ...(context.description === undefined ? {} : { description: context.description }),
      headers,
      query: context.query ?? {},
      endpointIds: context.endpoints,
      accountIds: context.accounts ?? [],
    });
  }

  return contexts;
}

/**
 * Разделитель идентификатора аккаунта в условиях.
 *
 * Аккаунт в условиях — отдельная строка матрицы, и ей нужен свой
 * идентификатор. Совпадение с реально объявленным аккаунтом (например, если
 * аккаунты названы адресами почты) не пройдёт молча: построение матрицы
 * отвергает дубликаты идентификаторов.
 */
const CONTEXT_SEPARATOR = "@";

/**
 * Приводит аккаунты конфигурации к доменному типу ядра, добавляя аккаунты
 * в условиях.
 *
 * Возвращает и карту атрибутов: заголовки и параметры запроса ядру не нужны
 * и в него не попадают, а прогону нужны. Одна функция, а не две, потому что
 * два обхода одной и той же деривации разошлись бы — и разошлись бы молча:
 * аккаунт без атрибутов ходил бы в базовых условиях, отвечая за находки
 * в условиях объявленных.
 */
export function toAccounts(
  config: RunConfig,
  /**
   * Разрешённые значения атрибутов. Обязательны, когда хоть один атрибут берёт
   * значение из окружения: без них он молча уехал бы в обращение как объект.
   */
  contextValues: ReadonlyMap<string, ContextValues> = new Map(),
): {
  readonly accounts: readonly Account[];
  readonly attributes: ReadonlyMap<string, ContextAttributes>;
} {
  const base = baseAccounts(config);
  const attributes = new Map<string, ContextAttributes>();
  const derived: Account[] = [];

  for (const context of config.contexts) {
    for (const account of base) {
      if (context.accountIds.length > 0 && !context.accountIds.includes(account.id)) {
        continue;
      }
      const id = `${account.id}${CONTEXT_SEPARATOR}${context.id}`;
      derived.push({
        ...account,
        id,
        contextId: context.id,
        // Владение объектом сверяется по исходному аккаунту: условия его
        // не отменяют. Без этой ссылки свой заказ переставал быть своим,
        // отношение уезжало в `same-tenant`, а серьёзность — вверх.
        baseAccountId: account.id,
        endpointIds: context.endpointIds,
      });
      const values = contextValues.get(context.id) ?? literalValues(context);
      attributes.set(id, {
        contextId: context.id,
        headers: values.headers,
        query: values.query,
      });
    }
  }

  return { accounts: [...base, ...derived], attributes };
}

/**
 * Значения условий, когда разрешение не передали.
 *
 * Ссылка на окружение здесь превращается в отказ, а не в объект в заголовке:
 * пропущенный шаг разрешения обязан быть слышен.
 */
function literalValues(context: RequestContextConfig): ContextValues {
  const take = (source: Readonly<Record<string, ContextAttributeValue>>, kind: string) => {
    const out: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(source)) {
      if (typeof value !== "string") {
        throw new MissingContextValueError(context.id, `${kind} "${name}"`, value.env);
      }
      out[name] = value;
    }
    return out;
  };
  return {
    headers: take(context.headers, "header"),
    query: take(context.query, "query parameter"),
  };
}

function baseAccounts(config: RunConfig): readonly Account[] {
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
      `The token from ${variable} for account "${accountId}" contains characters that ` +
        `an HTTP header value cannot carry. Check the variable: usually a stray line ` +
        `break or text pasted from a non-ASCII source.`,
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

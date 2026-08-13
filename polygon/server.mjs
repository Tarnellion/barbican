#!/usr/bin/env node

/**
 * Референс-платформа: минимальный мультитенантный API как оракул для barbican.
 *
 * Зачем она есть. VAmPI и crAPI одноарендны — «чужого тенанта» там нет вовсе,
 * а переключатель уязвимостей VAmPI оказался бесполезен, потому что режимы
 * различались только телами ответов (ADR-0009). Инструмент тела не читает
 * принципиально, поэтому здесь действует жёсткое требование:
 *
 *   **каждый дефект обязан проявляться в коде ответа.**
 *
 * Разница, видимая только в JSON, для инструмента не существует и оракулом
 * быть не может.
 *
 * Ноль рантайм-зависимостей: только встроенный `node:http`. Слушаем строго
 * 127.0.0.1 — стенд с намеренными дефектами не должен быть доступен извне.
 */

import { createServer } from "node:http";

/** Только петля. Не параметризуется намеренно. */
const HOST = "127.0.0.1";

const DEFAULT_PORT = 8787;

/**
 * Тенанты платформы: два холдинга, под каждым по бренду, под одним из брендов —
 * аффилиат.
 *
 * Родство объявлено отдельным полем, а не закодировано в идентификаторе, — по той
 * же причине, что и в самом инструменте (ADR-0013): опечатка в разбираемом пути
 * молча переродняет тенанта, и «свой бренд» превращается в «чужой».
 *
 * Второй холдинг нужен именно как **чужая ветвь**. Без него бренд `tenant-b` был
 * бы просто корнем, и «утечка в чужой холдинг» ничем не отличалась бы от «утечки
 * к тенанту без родни» — то есть новый дефект проверял бы старое отношение.
 *
 * Третий уровень нужен по родственной причине, но не про ширину дерева, а про его
 * **глубину**. Пока дерево двухуровневое, «прямой родитель» и «любой предок» для
 * каждого аккаунта — одно и то же множество из одного элемента, и реализация,
 * поднимающаяся на один шаг вместо всей цепочки, ведёт себя неотличимо от той,
 * что поднимается по цепочке. Различить их можно только там, где предков **два**:
 * у `affiliate-a1` это `tenant-a` (шаг) и `holding-1` (два шага).
 */
const TENANTS = [
  { id: "holding-1", parent: undefined },
  { id: "holding-2", parent: undefined },
  { id: "tenant-a", parent: "holding-1" },
  { id: "tenant-b", parent: "holding-2" },
  { id: "affiliate-a1", parent: "tenant-a" },
];

const PARENT_OF = new Map(TENANTS.map((tenant) => [tenant.id, tenant.parent]));

/**
 * Тенант лежит строго ниже предка по дереву.
 *
 * Своя реализация, а не импорт из `src`: платформа — проверяемая система, и брать
 * у инструмента то, что он же на ней и проверяет, значит сверять его с самим собой.
 */
function isBelow(tenantId, ancestorId) {
  let current = PARENT_OF.get(tenantId);
  while (current !== undefined) {
    if (current === ancestorId) {
      return true;
    }
    current = PARENT_OF.get(current);
  }
  return false;
}

/**
 * Прямой родитель тенанта. `undefined` у корня.
 *
 * Отдельной функцией, а не параметром `isBelow`: разница между «родитель» и «любой
 * предок» — это ровно то, чем отличаются дефекты `ancestorLeak` и `parentLeak`,
 * и она должна быть видна в коде, а не спрятана в аргументе.
 */
function parentOf(tenantId) {
  return PARENT_OF.get(tenantId);
}

/**
 * Аккаунты платформы.
 *
 * Два бренда по два пользователя: владелец объекта и другой пользователь того же
 * тенанта. Без второго нельзя отличить BOLA внутри тенанта от межтенантной утечки —
 * оба выглядели бы как «доступ к не своему».
 *
 * Сверх них — аккаунт уровня холдинга. Он сидит **на самом холдинге**, а не на одном
 * из его брендов: приписать его к бренду можно, но тогда собственный бренд холдинга
 * становится «чужим тенантом», и инструмент ошибается дважды — придирается к законному
 * чтению и пропускает настоящую межхолдинговую утечку. Это и есть случай, ради
 * которого писался ADR-0013.
 *
 * Ещё ниже — аккаунт аффилиата, приведённый под бренд. Он нужен ровно за тем,
 * за чем заведён третий уровень дерева: у него **два** предка, и только на нём
 * видно, поднимается реализация по всей цепочке или на один шаг. Аффилиату
 * положена своя статистика и не положено ничего из бренда — ни список заказов,
 * ни расчётный документ, — и тем более ничего с уровня холдинга.
 *
 * Токены берутся из переменных окружения и в коде не хранятся. Имена переменных
 * совпадают с `tokenEnv` в `barbican.run.yaml`.
 *
 * Поле `auth` — **контур**, а не украшение. На мультибрендовой платформе кабинет
 * аффилиата, операторская админка и клиентское API аутентифицируются по-разному,
 * и прогон, охватывающий их разом, обязан ходить в каждый по-своему. Здесь это
 * смоделировано буквально: клиентские аккаунты предъявляют Bearer, операторская
 * админка — сессионную куку, кабинет аффилиата — ключ в своём заголовке.
 *
 * Токен, предъявленный **не тем** транспортом, платформа не принимает (см.
 * `authenticate`). Иначе проверка была бы бутафорской: инструмент, шлющий всё
 * Bearer-ом, проходил бы её насквозь, и полигон подтверждал бы работу того,
 * чего не делает.
 */
const ACCOUNTS = [
  {
    id: "alice-a",
    role: "user",
    tenant: "tenant-a",
    tokenEnv: "POLYGON_TOKEN_ALICE_A",
    auth: { kind: "bearer" },
  },
  {
    id: "bob-a",
    role: "user",
    tenant: "tenant-a",
    tokenEnv: "POLYGON_TOKEN_BOB_A",
    auth: { kind: "bearer" },
  },
  {
    id: "carol-b",
    role: "user",
    tenant: "tenant-b",
    tokenEnv: "POLYGON_TOKEN_CAROL_B",
    auth: { kind: "bearer" },
  },
  {
    id: "dave-b",
    role: "user",
    tenant: "tenant-b",
    tokenEnv: "POLYGON_TOKEN_DAVE_B",
    auth: { kind: "bearer" },
  },
  {
    id: "admin-a",
    role: "admin",
    tenant: "tenant-a",
    tokenEnv: "POLYGON_TOKEN_ADMIN_A",
    auth: { kind: "cookie", name: "opsid" },
  },
  {
    id: "helen-h1",
    role: "holding",
    tenant: "holding-1",
    tokenEnv: "POLYGON_TOKEN_HELEN_H1",
    auth: { kind: "bearer" },
  },
  {
    id: "ivan-af1",
    role: "affiliate",
    tenant: "affiliate-a1",
    tokenEnv: "POLYGON_TOKEN_IVAN_AF1",
    auth: { kind: "header", name: "x-affiliate-key" },
  },
  /**
   * Саппорт на двух брендах **разных холдингов** — аккаунт, который деревом
   * не выражается (ADR-0017).
   *
   * Общего предка у `tenant-a` и `tenant-b` нет вовсе: холдинги разные, корня
   * над ними на этой платформе не существует. Посадить такой аккаунт в один
   * узел нельзя ни одним способом — второй бренд станет чужим, — а завести над
   * холдингами общий корень значило бы отдать ему и всё остальное поддерево.
   *
   * Поле `tenants` вместо `tenant`, а не в дополнение к нему: один узел и набор
   * узлов — взаимоисключающие утверждения.
   */
  {
    id: "sara-ac",
    role: "support",
    tenants: ["tenant-a", "tenant-b"],
    tokenEnv: "POLYGON_TOKEN_SARA_AC",
    auth: { kind: "bearer" },
  },
];

/**
 * Заголовки, в которых платформа вообще смотрит ключи аффилиатского вида.
 *
 * Выводится из аккаунтов, а не пишется списком: разойдясь, список молча перестал
 * бы видеть предъявленный ключ, и аккаунт получал бы 401 — то есть законный
 * с виду отказ.
 */
const CUSTOM_AUTH_HEADERS = new Set(
  ACCOUNTS.filter((account) => account.auth.kind === "header").map((account) =>
    account.auth.name.toLowerCase(),
  ),
);

/**
 * Тенанты аккаунта одним списком.
 *
 * У всех, кроме саппорта, он из одного элемента. Ветвление «есть набор или
 * нет» стоит здесь ровно один раз: дальше по коду разница между одним тенантом
 * и набором не должна быть видна вовсе — иначе каждое место авторизации
 * пришлось бы чинить отдельно, а забытое молча вело бы себя по-старому.
 */
function tenantsOf(account) {
  return account.tenants ?? [account.tenant];
}

/**
 * Заказы — объекты обращения.
 *
 * Идентификаторы совпадают с `params.orderId` в конфигурации прогона: инструмент
 * подставляет их в шаблон пути, а владельца и тенанта объявляет человек (ADR-0010).
 */
const ORDERS = [
  { id: "A-1001", tenant: "tenant-a", owner: "alice-a" },
  { id: "A-1002", tenant: "tenant-a", owner: "bob-a" },
  { id: "B-2001", tenant: "tenant-b", owner: "carol-b" },
  { id: "B-2002", tenant: "tenant-b", owner: "dave-b" },
];

/**
 * Сводные расчётные документы уровня тенанта: один холдинговый, один брендовый.
 *
 * Отдельная коллекция, а не заказ с пустым владельцем. Причина не в опрятности:
 * документ принадлежит **тенанту целиком**, владельца-пользователя у него нет
 * вовсе, и это ровно тот случай, ради которого `ownerAccountId` в инструменте
 * необязателен. Заказ без владельца был бы заказом, который никто не оформлял.
 *
 * Ради него здесь и заведён этот тип объекта: без объекта уровня холдинга
 * отношение `ancestor-tenant` («бренд читает уровень своего холдинга»)
 * невыразимо, и из двух отношений, введённых ADR-0013, сквозным прогоном
 * проверялось только `descendant-tenant`.
 *
 * Второй документ — брендовый. Он живёт на той же ручке намеренно, хотя по имени
 * («сводка по игрокам бренда») просился бы на свою. Своя ручка развела бы два
 * дефекта видимости по разным адресам, и они стали бы различимы по эндпоинту —
 * то есть проверка перестала бы быть проверкой **глубины дерева**, ради которой
 * она и заводится. Здесь же оба документа читаются одной функцией авторизации,
 * и единственное, чем отличается «один шаг вверх» от «всей цепочки», — это
 * ячейка `ivan-af1 × H1-0001`.
 */
const STATEMENTS = [
  { id: "H1-0001", tenant: "holding-1" },
  { id: "A-0001", tenant: "tenant-a" },
];

/**
 * Переключатели дефектов.
 *
 * Шесть из семи видны по статусу: 200 там, где корректная реализация отвечает 403.
 * Седьмой (`listNoFilter`) — принципиально другой: он не меняет ни одного статуса
 * и виден только через сигнал над телом (ADR-0011).
 *
 * Наборы ячеек не пересекаются — кроме пары `ancestorLeak` и `parentLeak`, где
 * второй целиком содержится в первом. Это исключение не побочный эффект,
 * а проверяемое утверждение: см. README, «Дефект, который ловится только глубиной».
 */
const DEFECT_FLAGS = {
  /** Нет фильтра по тенанту: объект чужого тенанта отдаётся 200 вместо 403. */
  crossTenant: "POLYGON_DEFECT_CROSS_TENANT",
  /** Не проверяется роль: обычный пользователь получает 200 на админской ручке. */
  noRoleCheck: "POLYGON_DEFECT_NO_ROLE_CHECK",
  /** IDOR внутри тенанта: чужой объект своего тенанта отдаётся 200 вместо 403. */
  idorSameTenant: "POLYGON_DEFECT_IDOR_SAME_TENANT",
  /**
   * Нет фильтра по тенанту в списке: GET /v1/orders отдаёт заказы всех тенантов.
   *
   * Статус не меняется — 200 и с дефектом, и без него. Ровно тот класс, который
   * до ADR-0011 был для инструмента невидим, и ради которого тела стали читаться.
   */
  listNoFilter: "POLYGON_DEFECT_LIST_NO_FILTER",
  /**
   * Роллап холдинга не ограничен собственным поддеревом: холдингу отдаются
   * объекты бренда чужого холдинга.
   *
   * Отдельный флаг, а не частный случай `crossTenant`, потому что это отдельный
   * путь в коде: «мои заказы» и «заказы моей группы» — разные запросы с разными
   * фильтрами, и ломаются они независимо. Наборы ячеек у них тоже не пересекаются:
   * `crossTenant` живёт на брендовых аккаунтах, этот — на холдинговых.
   */
  crossHolding: "POLYGON_DEFECT_CROSS_HOLDING",
  /**
   * Область видимости сводных документов раскрывается **вверх** по дереву:
   * бренд получает документ своего холдинга — 200 вместо 403.
   *
   * Зеркало `crossHolding`, и потому отдельный флаг. Тот ломает взгляд сверху
   * вниз (холдинг видит чужую ветвь), этот — снизу вверх (бренд видит уровень
   * группы). ADR-0013 разделяет `descendant-tenant` и `ancestor-tenant` ровно
   * потому, что это разные дефекты с разной ценой; свести их в один флаг значило
   * бы вернуть на полигон различие, которое инструмент научили делать.
   *
   * Чужой бренд этим флагом не задет: `holding-1` ему не предок. Так дефект
   * остаётся утверждением об отношении, а не про «документ стал публичным», —
   * и ячейки `carol-b`, `dave-b` работают контролем.
   */
  ancestorLeak: "POLYGON_DEFECT_ANCESTOR_LEAK",
  /**
   * То же раскрытие вверх, но **ровно на один уровень**: видимым становится
   * документ прямого родителя, а не всей цепочки предков.
   *
   * Правдоподобие здесь не украшение, а условие: платформа берёт из токена
   * денормализованное поле «родительский тенант» вместо обхода дерева. Так
   * пишут чаще, чем рекурсию, — и именно поэтому такой дефект стоит уметь ловить.
   *
   * Единственный флаг, чей набор ячеек **пересекается** с чужим: на двухуровневой
   * части дерева он совпадает с `ancestorLeak` ячейка в ячейку. Это не недосмотр,
   * а само проверяемое утверждение — см. README, «Дефект, который ловится только
   * глубиной».
   */
  parentLeak: "POLYGON_DEFECT_PARENT_LEAK",
  /**
   * Платформа помнит у аккаунта только **первое** членство: набор тенантов
   * схлопнут до «основного тенанта».
   *
   * Правдоподобие здесь такое же, как у `parentLeak`: в токене лежит одно поле
   * `tenant_id`, потому что когда-то у всех аккаунтов тенант был один, — и набор
   * членств до авторизации не доезжает. Саппорту двух брендов отдаётся первый
   * и отказывается во втором.
   *
   * Единственный дефект платформы, который проявляется **отказом**, а не лишним
   * доступом: 403 там, где человек объявил доступ положенным. До ADR-0017 такое
   * утверждение было невыразимо — второй бренд объявить своим было нечем, —
   * поэтому и дефект был бы неотличим от исправной работы.
   */
  primaryTenantOnly: "POLYGON_DEFECT_PRIMARY_TENANT_ONLY",
  /**
   * Не проверяется юрисдикция обращения: заказы отдаются и из запрещённой
   * страны — 200 вместо 451.
   *
   * Единственный дефект полигона, который **не виден по одним лишь правам**:
   * ячейка «alice-a × orders.read × собственный заказ» законно даёт 200 в
   * базовых условиях и обязана дать отказ, когда обращение помечено страной
   * из запрета. Различить их можно, только объявив условия отдельным
   * измерением (ADR-0019): роль, тенант и объект здесь одни и те же.
   *
   * Правдоподобие: гео-ограничение живёт в CDN или на входном шлюзе, а не в
   * основной авторизации, и «просочиться» мимо него — самый частый способ
   * такое сломать.
   */
  geoBypass: "POLYGON_DEFECT_GEO_BYPASS",
  /**
   * Скрытый параметр запроса расширяет область выдачи: `?scope=all` снимает
   * фильтр по тенанту в брендовом списке.
   *
   * Статус не меняется, как и у `listNoFilter`, но ломается тут другое: там
   * фильтра нет вовсе, здесь он есть и снимается **атрибутом обращения**.
   * Отсюда и разные наборы ячеек: этот флаг виден только в условиях, где
   * параметр объявлен, и на базовых обращениях не проявляется никак.
   *
   * Правдоподобие: такие параметры заводят для внутренней админки или отладки,
   * а проверку прав на них забывают — она осталась на роли, которой в запросе
   * уже нет.
   */
  scopeAllHonored: "POLYGON_DEFECT_SCOPE_ALL_HONORED",
};

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Читает булев флаг из окружения.
 *
 * Незнакомое значение — ошибка, а не «выключено». Молча принятая опечатка вида
 * `POLYGON_DEFECT_CROSS_TENANT=yes` дала бы прогон без находок, неотличимый
 * от успешной проверки корректной платформы.
 */
function readFlag(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return false;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  throw new ConfigurationError(
    `Переменная ${name} имеет значение "${raw}"; допустимы только 0, 1, false, true ` +
      `или отсутствие переменной. Опечатка здесь молча выключила бы дефект.`,
  );
}

function readDefects() {
  return {
    crossTenant: readFlag(DEFECT_FLAGS.crossTenant),
    noRoleCheck: readFlag(DEFECT_FLAGS.noRoleCheck),
    idorSameTenant: readFlag(DEFECT_FLAGS.idorSameTenant),
    listNoFilter: readFlag(DEFECT_FLAGS.listNoFilter),
    crossHolding: readFlag(DEFECT_FLAGS.crossHolding),
    ancestorLeak: readFlag(DEFECT_FLAGS.ancestorLeak),
    parentLeak: readFlag(DEFECT_FLAGS.parentLeak),
    primaryTenantOnly: readFlag(DEFECT_FLAGS.primaryTenantOnly),
    geoBypass: readFlag(DEFECT_FLAGS.geoBypass),
    scopeAllHonored: readFlag(DEFECT_FLAGS.scopeAllHonored),
  };
}

/**
 * Тенанты, которые платформа на самом деле учитывает для аккаунта.
 *
 * Отдельно от `tenantsOf`: там объявленная принадлежность, здесь — то, что
 * от неё осталось после дефекта. Разделение не косметическое, оно и есть
 * содержание флага `primaryTenantOnly`.
 */
function visibleTenants(account, defects) {
  const declared = tenantsOf(account);
  return defects.primaryTenantOnly ? declared.slice(0, 1) : declared;
}

/**
 * Строит карту «токен → аккаунт».
 *
 * Отсутствующая переменная — отказ на старте. Пустой заголовок авторизации
 * посреди прогона выглядел бы как законный 401 и обесценил бы весь результат.
 */
function readTokens() {
  const byToken = new Map();
  for (const account of ACCOUNTS) {
    const value = process.env[account.tokenEnv];
    if (value === undefined || value.trim() === "") {
      throw new ConfigurationError(
        `Не задана переменная ${account.tokenEnv} для аккаунта "${account.id}". ` +
          `Токены передаются только через окружение и в репозитории не хранятся.`,
      );
    }
    if (byToken.has(value)) {
      throw new ConfigurationError(
        `Токен аккаунта "${account.id}" совпадает с токеном другого аккаунта. ` +
          `Тогда изоляция тенантов непроверяема: обращения неразличимы.`,
      );
    }
    byToken.set(value, account);
  }
  return byToken;
}

/**
 * Всё, что в запросе похоже на предъявленные учётные данные.
 *
 * Возвращает пары «транспорт → значение»: Bearer из `Authorization`, каждую куку
 * по имени и каждый известный заголовок-ключ. Разбор именно всех, а не первого
 * подошедшего: платформа обязана уметь сказать «токен верный, но предъявлен
 * не тем способом», а для этого нужно видеть, чем именно его предъявили.
 */
function presentedCredentials(headers) {
  const presented = [];

  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim());
    if (match !== null) {
      presented.push({ kind: "bearer", value: match[1].trim() });
    }
  }

  const cookie = headers.cookie;
  if (typeof cookie === "string") {
    for (const pair of cookie.split(";")) {
      const separator = pair.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      presented.push({
        kind: "cookie",
        name: pair.slice(0, separator).trim(),
        value: pair.slice(separator + 1).trim(),
      });
    }
  }

  for (const name of CUSTOM_AUTH_HEADERS) {
    const value = headers[name];
    if (typeof value === "string" && value.trim() !== "") {
      presented.push({ kind: "header", name, value: value.trim() });
    }
  }

  return presented;
}

/** Предъявлено ли ровно так, как положено этому аккаунту. */
function matchesScheme(scheme, presented) {
  if (scheme.kind !== presented.kind) {
    return false;
  }
  if (scheme.kind === "bearer") {
    return true;
  }
  // Имена заголовков Node приводит к нижнему регистру; куки регистрозависимы.
  return scheme.kind === "header"
    ? scheme.name.toLowerCase() === presented.name
    : scheme.name === presented.name;
}

/**
 * Аккаунт по предъявленным учётным данным. `undefined` — аноним, неверный токен
 * либо верный токен, предъявленный не тем транспортом.
 *
 * Последний случай — не педантизм. Прими платформа операторскую куку ещё и
 * Bearer-ом, инструмент со схемой по умолчанию у всех аккаунтов прошёл бы прогон
 * насквозь, и полигон подтверждал бы работу переопределения, которого нет.
 */
function authenticate(headers, tokensByValue) {
  for (const presented of presentedCredentials(headers)) {
    const account = tokensByValue.get(presented.value);
    if (account !== undefined && matchesScheme(account.auth, presented)) {
      return account;
    }
  }
  return undefined;
}

/**
 * Доступ к заказу.
 *
 * Ровно одна ветка на ячейку — поэтому включение любого флага меняет только
 * свой набор ячеек и не задевает соседние.
 */
function authorizeOrder(account, order, defects) {
  if (account.role === "affiliate") {
    // Заказы бренда аффилиату не положены ни в каком режиме: у него свой контур
    // (`/v1/affiliate/stats`), а игроки бренда — не его данные.
    //
    // Ветка стоит первой и не смотрит ни на один флаг. Это не перестраховка:
    // без неё аффилиат провалился бы в брендовую ветку ниже, и `crossTenant`
    // добавил бы ему четыре ячейки. Дефект «нет фильтра по тенанту у брендовых
    // аккаунтов» стал бы утверждением и про аффилиатов заодно, а набор ячеек
    // прежнего флага перестал бы быть прежним.
    return 403;
  }

  if (account.role === "support") {
    // Саппорт видит заказы тех брендов, в которых состоит, — и только их.
    // Ветка своя по той же причине, по какой она своя у аффилиата: брендовая
    // ветка ниже спрашивает «тенант заказа равен тенанту аккаунта?», а у этого
    // аккаунта тенант не один, и общая ветка либо отдала бы ему лишнее, либо
    // отказала бы во втором бренде — то есть встроила бы дефект в исправный режим.
    return visibleTenants(account, defects).includes(order.tenant) ? 200 : 403;
  }

  if (account.role === "holding") {
    // Холдинговый контур — отдельная ветка целиком, и брендовая ниже остаётся
    // нетронутой. Это не стилистика: так набор ячеек `crossHolding` не может
    // пересечься с набором `crossTenant`, а прежние комбинации обязаны дать
    // ровно те же результаты, что и до появления холдингов.
    if (isBelow(order.tenant, account.tenant)) {
      // Свой бренд холдингу положен. Именно это отношение инструмент до ADR-0013
      // выразить не мог и объявлял эскалацией.
      return 200;
    }
    return defects.crossHolding ? 200 : 403;
  }

  if (order.tenant !== account.tenant) {
    // Дефект №1: фильтр по тенанту отсутствует.
    return defects.crossTenant ? 200 : 403;
  }
  if (account.role === "admin") {
    // Администратору тенанта положены все объекты его тенанта — это не дефект.
    return 200;
  }
  if (order.owner === account.id) {
    return 200;
  }
  // Дефект №3: IDOR внутри тенанта.
  return defects.idorSameTenant ? 200 : 403;
}

/**
 * Доступ к сводному расчётному документу.
 *
 * Владельца-пользователя у документа нет, поэтому «своё» здесь означает ровно
 * совпадение тенантов — ни `own`, ни BOLA внутри тенанта тут не возникают.
 *
 * Отдельная функция, а не ветка в `authorizeOrder`: у заказов и у сводных
 * документов разные правила видимости, и ломаются они независимо. Побочный
 * и важный эффект — брендовая ветка заказов осталась нетронутой, поэтому ни
 * одна прежняя ячейка не могла сменить исход.
 *
 * Исправное правило — «свой уровень и всё, что ниже»: видимость идёт вниз
 * по дереву. Оба дефекта ломают её направление; отличаются они только тем,
 * насколько далеко вверх поднимаются.
 */
function authorizeStatement(account, statement, defects) {
  // Здесь и ниже — обход по всем тенантам аккаунта. Отдельной ветки для
  // саппорта нет намеренно: правило видимости документов у него то же самое,
  // и своя ветка означала бы, что дефекты раскрытия вверх его не задевают, —
  // утверждение, которого никто не проверял. Пусть задевают: тогда прогон
  // проверяет и то, что предки считаются по каждому членству.
  const tenants = visibleTenants(account, defects);
  if (tenants.includes(statement.tenant)) {
    return 200;
  }
  // Вниз по дереву — положено: холдинг обязан видеть расчётный документ своего
  // бренда, иначе сводного взгляда у лицензиата не существует. Это исправное
  // поведение, а не поблажка, и ни один флаг его не трогает.
  if (tenants.some((tenant) => isBelow(statement.tenant, tenant))) {
    return 200;
  }
  // Дефект №6: фильтр раскрывается вверх по дереву вместо вниз. Реализация
  // спрашивает «документ моего тенанта или любого его предка?» вместо «моего
  // тенанта?» — и бренд получает документ уровня своей группы, а аффилиат —
  // и документ бренда, и документ холдинга.
  if (defects.ancestorLeak && tenants.some((tenant) => isBelow(tenant, statement.tenant))) {
    return 200;
  }
  // Дефект №7: то же раскрытие вверх, но ровно на один шаг — «документ моего
  // тенанта или моего родителя?». Аффилиат получает документ бренда и не получает
  // документ холдинга; брендовые аккаунты не отличают этот дефект от предыдущего
  // вовсе, потому что у них предок ровно один.
  if (defects.parentLeak && tenants.some((tenant) => parentOf(tenant) === statement.tenant)) {
    return 200;
  }
  return 403;
}

/**
 * Доступ к собственной статистике аффилиата.
 *
 * Ручка без объекта и без переключателей: она отвечает 200 только роли
 * `affiliate` и 403 всем остальным в любом режиме. Две работы сразу — канарейка
 * аффилиата (единственное место, где его токен обязан дать 200, поэтому неверный
 * токен остановит прогон, а не притворится законным отказом) и контроль: лишняя
 * находка на ней означала бы ложное срабатывание.
 */
function authorizeAffiliateStats(account) {
  return account.role === "affiliate" ? 200 : 403;
}

/** Доступ к админской ручке. Дефект №2: проверка роли отключена. */
function authorizeAdmin(account, defects) {
  if (account.role === "admin") {
    return 200;
  }
  return defects.noRoleCheck ? 200 : 403;
}

function send(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // Кэш ответа исказил бы матрицу: одна ячейка ответила бы за другую.
    "cache-control": "no-store",
  });
  // Тело для HEAD Node отбрасывает сам; отдельная ветка не нужна.
  res.end(body);
}

const ORDER_PATH = /^\/v1\/orders\/([^/]+)$/;
const STATEMENT_PATH = /^\/v1\/statements\/([^/]+)$/;

/** Список ручек. Дублируется в `endpoints.yaml` — там это объявление человека. */
/**
 * Запрещённая юрисдикция.
 *
 * `AQ` — Антарктида: настоящий код ISO, но заведомо не рынок. Ставить сюда
 * реальную страну в публичном репозитории незачем, а выдуманный код
 * не прошёл бы проверку у читателя, знающего стандарт.
 */
const BLOCKED_COUNTRY = "AQ";

/**
 * Гео-ограничение: заказы не отдаются из запрещённой юрисдикции.
 *
 * Возвращается 451, а не 403: отказ здесь юридический, а не по правам, и
 * платформы так и отвечают. Для инструмента это тоже отказ — см. ADR-0019.
 */
function geoBlocked(headers, defects) {
  if (defects.geoBypass) {
    return false;
  }
  const country = headers["cf-ipcountry"];
  return typeof country === "string" && country.toUpperCase() === BLOCKED_COUNTRY;
}

function handle(req, res, context) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Небезопасные методы платформа не реализует: инструмент их и не шлёт
    // без --unsafe-methods, а держать изменяющую состояние ручку на стенде,
    // который гоняют в цикле, незачем.
    send(res, 405, { error: "method_not_allowed" });
    return;
  }

  const { pathname, searchParams: query } = new URL(req.url ?? "/", `http://${HOST}`);

  // Публичная ручка: отвечает всем, включая аноним. Нужна и как проба
  // готовности для verify.mjs, и как контроль — она не меняется ни от одного
  // флага, поэтому лишняя находка на ней означала бы ложное срабатывание.
  if (pathname === "/v1/health") {
    send(res, 200, { status: "ok", defects: context.defects });
    return;
  }

  const account = authenticate(req.headers, context.tokensByValue);
  if (account === undefined) {
    // Аутентификация проверяется раньше авторизации, поэтому ни один флаг
    // дефекта не открывает доступ анониму.
    send(res, 401, { error: "unauthorized" });
    return;
  }

  if (pathname === "/v1/orders") {
    if (geoBlocked(req.headers, context.defects)) {
      send(res, 451, { error: "unavailable_for_legal_reasons" });
      return;
    }
    if (account.role === "affiliate") {
      // Список заказов бренда аффилиату не положен. Ветка стоит до брендовой
      // и до `listNoFilter`: иначе с этим дефектом аффилиат получил бы общий
      // список, его тело совпало бы с телом чужого бренда, и у прежнего флага
      // прибавилось бы пар — то есть набор ячеек перестал бы быть прежним.
      send(res, 403, { error: "forbidden" });
      return;
    }

    if (account.role === "support") {
      // Список по своим брендам. Строки несут бренд по той же причине, что
      // и у холдингового роллапа: список из двух брендов без атрибуции
      // не читается. Побочный эффект тот же и такой же полезный — тело
      // не совпадает с брендовым ни в одном режиме.
      const visible = ORDERS.filter((order) =>
        visibleTenants(account, context.defects).includes(order.tenant),
      );
      send(res, 200, {
        orders: visible.map((order) => ({
          id: order.id,
          owner: order.owner,
          tenant: order.tenant,
        })),
      });
      return;
    }

    if (account.role === "holding") {
      // Роллап по собственному поддереву. Каждая строка несёт бренд: роллап без
      // атрибуции бесполезен — по нему нельзя понять, чей это заказ.
      //
      // Побочный эффект этой атрибуции важен и его стоит назвать вслух. Холдинг
      // с единственным брендом видит ровно те же заказы, что и сам бренд, и без
      // поля `tenant` тела совпали бы побайтово. Проверка
      // `identical-response-across-tenants` о дереве не знает и сочла бы законный
      // роллап утечкой — на чистой платформе. См. «Границы» в README.md.
      const rollup = ORDERS.filter((order) => isBelow(order.tenant, account.tenant));
      send(res, 200, {
        orders: rollup.map((order) => ({
          id: order.id,
          owner: order.owner,
          tenant: order.tenant,
        })),
      });
      return;
    }

    // Брендовый список. С дефектом отдаются заказы всех тенантов — и статус при
    // этом остаётся 200, как у корректной реализации. Различить их можно только
    // по телу: у корректной оно разное у разных тенантов, у дефектной одинаковое.
    // Корректная реализация неизвестный параметр игнорирует. Дефектная —
    // выполняет: `?scope=all` снимает фильтр по тенанту. Проверка прав на этот
    // параметр не сделана вовсе, потому его и нет в условии.
    const wideScope = context.defects.scopeAllHonored && query.get("scope") === "all";
    const visible =
      context.defects.listNoFilter || wideScope
        ? ORDERS
        : ORDERS.filter((order) => order.tenant === account.tenant);
    send(res, 200, { orders: visible.map((order) => ({ id: order.id, owner: order.owner })) });
    return;
  }

  if (pathname === "/v1/affiliate/stats") {
    const status = authorizeAffiliateStats(account);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    // Тело здесь ничего не решает: для ручки не объявлен
    // `responseMustDifferByTenant`, сигналы над ней не считаются, и дефект —
    // если бы он тут был — был бы виден по статусу.
    send(res, 200, { affiliate: account.id, tenant: account.tenant });
    return;
  }

  if (pathname === "/v1/admin/accounts") {
    const status = authorizeAdmin(account, context.defects);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    const visible = tenantsOf(account);
    const own = ACCOUNTS.filter((entry) =>
      tenantsOf(entry).some((tenant) => visible.includes(tenant)),
    );
    send(res, 200, { accounts: own.map((entry) => ({ id: entry.id, role: entry.role })) });
    return;
  }

  const orderMatch = ORDER_PATH.exec(pathname);
  if (orderMatch !== null) {
    if (geoBlocked(req.headers, context.defects)) {
      send(res, 451, { error: "unavailable_for_legal_reasons" });
      return;
    }
    const orderId = decodeURIComponent(orderMatch[1]);
    const order = ORDERS.find((entry) => entry.id === orderId);
    if (order === undefined) {
      // Несуществующий объект — 404 для всех одинаково: маскировать отказ
      // под «не найдено» здесь не нужно, дефекты и так видны по статусу.
      send(res, 404, { error: "not_found" });
      return;
    }
    const status = authorizeOrder(account, order, context.defects);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    send(res, 200, { id: order.id, tenant: order.tenant, owner: order.owner });
    return;
  }

  const statementMatch = STATEMENT_PATH.exec(pathname);
  if (statementMatch !== null) {
    const statementId = decodeURIComponent(statementMatch[1]);
    const statement = STATEMENTS.find((entry) => entry.id === statementId);
    if (statement === undefined) {
      send(res, 404, { error: "not_found" });
      return;
    }
    const status = authorizeStatement(account, statement, context.defects);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    // Владельца в теле нет: у документа холдинга его не существует.
    send(res, 200, { id: statement.id, tenant: statement.tenant });
    return;
  }

  send(res, 404, { error: "not_found" });
}

function main() {
  const defects = readDefects();
  const tokensByValue = readTokens();
  const context = { defects, tokensByValue };

  const rawPort = process.env.POLYGON_PORT;
  const port = rawPort === undefined || rawPort === "" ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigurationError(`POLYGON_PORT="${rawPort}" не является номером порта`);
  }
  const verbose = readFlag("POLYGON_LOG");

  const server = createServer((req, res) => {
    try {
      handle(req, res, context);
    } catch (error) {
      // Пятисотка ломает вердикт о доступе: инструмент считает её «судить нельзя».
      // Поэтому она видна в логе, а не молча растворяется.
      process.stderr.write(`polygon: сбой обработки: ${error}\n`);
      send(res, 500, { error: "internal" });
    }
    if (verbose) {
      // Заголовки не логируются намеренно: токен не должен попасть ни в логи,
      // ни в отчёты — и это относится ко всем трём транспортам, а не только
      // к `Authorization`.
      process.stderr.write(`polygon: ${req.method} ${req.url} -> ${res.statusCode}\n`);
    }
  });

  server.listen(port, HOST, () => {
    const enabled = Object.entries(defects)
      .filter(([, on]) => on)
      .map(([name]) => name);
    process.stderr.write(
      `polygon: http://${HOST}:${port} дефекты: ${enabled.length === 0 ? "нет" : enabled.join(", ")}\n`,
    );
  });

  const stop = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

try {
  main();
} catch (error) {
  process.stderr.write(`polygon: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

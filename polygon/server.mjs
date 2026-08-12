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
 * Аккаунты платформы.
 *
 * Два тенанта по два пользователя: владелец объекта и другой пользователь того же
 * тенанта. Без второго нельзя отличить BOLA внутри тенанта от межтенантной утечки —
 * оба выглядели бы как «доступ к не своему».
 *
 * Токены берутся из переменных окружения и в коде не хранятся. Имена переменных
 * совпадают с `tokenEnv` в `barbican.run.yaml`.
 */
const ACCOUNTS = [
  { id: "alice-a", role: "user", tenant: "tenant-a", tokenEnv: "POLYGON_TOKEN_ALICE_A" },
  { id: "bob-a", role: "user", tenant: "tenant-a", tokenEnv: "POLYGON_TOKEN_BOB_A" },
  { id: "carol-b", role: "user", tenant: "tenant-b", tokenEnv: "POLYGON_TOKEN_CAROL_B" },
  { id: "dave-b", role: "user", tenant: "tenant-b", tokenEnv: "POLYGON_TOKEN_DAVE_B" },
  { id: "admin-a", role: "admin", tenant: "tenant-a", tokenEnv: "POLYGON_TOKEN_ADMIN_A" },
];

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
 * Переключатели дефектов.
 *
 * Первые три меняют ровно свой набор ячеек «аккаунт × эндпоинт × объект» и видны
 * по статусу: 200 там, где корректная реализация отвечает 403. Четвёртый —
 * принципиально другой: он не меняет ни одного статуса, и виден только через
 * сигнал над телом (ADR-0011).
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
  };
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

/** Аккаунт по заголовку `Authorization`. `undefined` — аноним или неверный токен. */
function authenticate(header, tokensByValue) {
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) {
    return undefined;
  }
  return tokensByValue.get(match[1].trim());
}

/**
 * Доступ к заказу.
 *
 * Ровно одна ветка на ячейку — поэтому включение любого флага меняет только
 * свой набор ячеек и не задевает соседние.
 */
function authorizeOrder(account, order, defects) {
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

/** Список ручек. Дублируется в `endpoints.yaml` — там это объявление человека. */
function handle(req, res, context) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Небезопасные методы платформа не реализует: инструмент их и не шлёт
    // без --unsafe-methods, а держать изменяющую состояние ручку на стенде,
    // который гоняют в цикле, незачем.
    send(res, 405, { error: "method_not_allowed" });
    return;
  }

  const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);

  // Публичная ручка: отвечает всем, включая аноним. Нужна и как проба
  // готовности для verify.mjs, и как контроль — она не меняется ни от одного
  // флага, поэтому лишняя находка на ней означала бы ложное срабатывание.
  if (pathname === "/v1/health") {
    send(res, 200, { status: "ok", defects: context.defects });
    return;
  }

  const account = authenticate(req.headers.authorization, context.tokensByValue);
  if (account === undefined) {
    // Аутентификация проверяется раньше авторизации, поэтому ни один флаг
    // дефекта не открывает доступ анониму.
    send(res, 401, { error: "unauthorized" });
    return;
  }

  if (pathname === "/v1/orders") {
    // Список. С дефектом отдаются заказы всех тенантов — и статус при этом
    // остаётся 200, как у корректной реализации. Различить их можно только
    // по телу: у корректной оно разное у разных тенантов, у дефектной одинаковое.
    const visible = context.defects.listNoFilter
      ? ORDERS
      : ORDERS.filter((order) => order.tenant === account.tenant);
    send(res, 200, { orders: visible.map((order) => ({ id: order.id, owner: order.owner })) });
    return;
  }

  if (pathname === "/v1/admin/accounts") {
    const status = authorizeAdmin(account, context.defects);
    if (status !== 200) {
      send(res, status, { error: "forbidden" });
      return;
    }
    const own = ACCOUNTS.filter((entry) => entry.tenant === account.tenant);
    send(res, 200, { accounts: own.map((entry) => ({ id: entry.id, role: entry.role })) });
    return;
  }

  const orderMatch = ORDER_PATH.exec(pathname);
  if (orderMatch !== null) {
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
      // Заголовок Authorization не логируется намеренно: токен не должен попасть
      // ни в логи, ни в отчёты.
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

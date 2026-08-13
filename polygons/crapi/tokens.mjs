#!/usr/bin/env node

/**
 * Получение токенов crAPI.
 *
 * Инструмент их не добывает и не должен: логин у crAPI — это POST, а без
 * `--unsafe-methods` инструмент POST не выполняет (ADR-0008). Учётные данные
 * добывает оператор, то есть этот скрипт, и кладёт их в переменные окружения.
 *
 * Пользователи crAPI предзаведены её собственным seed'ом — заводить некого,
 * в отличие от VAmPI. Пароли предзаведённых учётных записей опубликованы самим
 * проектом и здесь просто повторены: это константа стенда в петле, не секрет.
 *
 * Ноль зависимостей: только встроенные модули.
 *
 * Использование:
 *   eval "$(node polygons/crapi/tokens.mjs)"
 */

import { fileURLToPath } from "node:url";

/** Обращения к полигону не должны висеть вечно: стенд поднимается в петле. */
const REQUEST_TIMEOUT_MS = 15_000;

const LOGIN_ROUTE = "/identity/api/auth/login";

function user(id, email, secret, tokenEnv) {
  return { id, email, secret, tokenEnv };
}

/**
 * Кого логиним.
 *
 * Имена переменных обязаны совпадать с `tokenEnv` в `barbican.run.yaml`:
 * разойдясь, они дали бы прогон без единого токена, то есть сплошные 401,
 * а сплошной отказ совпадает с политикой и выглядит чистым отчётом.
 */
/**
 * Пароли предзаведённых пользователей стенда.
 *
 * Это не секреты: значения опубликованы в самом crAPI как seed-константы,
 * а стенд живёт в петле и создаётся заново на каждый прогон. VAmPI обходится
 * без них — там пользователи регистрируются скриптом со случайными паролями, —
 * а здесь учётные записи предзаведены, и взять их неоткуда.
 *
 * Переопределяются окружением: держать в репозитории образец «пароль строкой»
 * не стоит даже там, где он безобиден, — читатель копирует форму, а не оговорку.
 */
function secretOf(name, published) {
  return process.env[`CRAPI_PASSWORD_${name.toUpperCase()}`] ?? published;
}

export const USERS = [
  user("adam", "adam007@example.com", secretOf("adam", "adam007!123"), "CRAPI_TOKEN_ADAM"),
  user("pogba", "pogba006@example.com", secretOf("pogba", "pogba006!123"), "CRAPI_TOKEN_POGBA"),
  user("admin", "admin@example.com", secretOf("admin", "Admin!123"), "CRAPI_TOKEN_ADMIN"),
];

export class ProvisionError extends Error {
  constructor(message) {
    super(`crAPI setup failed: ${message}`);
    this.name = "ProvisionError";
  }
}

const JSON_TYPE = "application/json";

async function login(baseUrl, account) {
  const headers = new Headers();
  headers.set("content-type", JSON_TYPE);
  const options = { headers };
  options.method = "POST";
  options.body = JSON.stringify({ email: account.email, password: account.secret });
  options.signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(new URL(LOGIN_ROUTE, baseUrl), options);
  } catch (cause) {
    throw new ProvisionError(`login of ${account.id}: ${cause.message}`);
  }

  const parsed = await response.json().catch(() => undefined);
  const token = parsed?.token;
  if (typeof token !== "string" || token === "") {
    throw new ProvisionError(`login of ${account.id} produced no token: ${response.status}`);
  }
  return token;
}

/**
 * Логинит всех и возвращает карту «переменная окружения → токен».
 *
 * Токены наружу выходят — их нельзя не выдать, они и есть предмет работы.
 * Никуда не записываются: ни в файл, ни в отчёт.
 */
export async function provision(options) {
  const baseUrl = options.baseUrl;
  const log = options.log ?? (() => undefined);
  const tokens = new Map();
  for (const account of USERS) {
    tokens.set(account.tokenEnv, await login(baseUrl, account));
    log(`${account.id}: logged in`);
  }
  return tokens;
}

/**
 * Токен идёт в `export` без кавычек, но только если состоит из безопасных
 * символов: JWT — это base64url через точки, и ничего иного там быть не должно.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._-]+$/;

const DEFAULT_BASE_URL = "http://127.0.0.1:8888";

async function main() {
  const baseUrl = process.env.CRAPI_BASE_URL ?? DEFAULT_BASE_URL;
  const report = (message) => process.stderr.write(`tokens: ${message}\n`);
  const tokens = await provision({ baseUrl, log: report });

  // Токены — в stdout, чтобы работал eval; всё прочее — в stderr.
  for (const [name, token] of tokens) {
    if (!TOKEN_SHAPE.test(token)) {
      throw new ProvisionError(`token ${name} contains unexpected characters`);
    }
    process.stdout.write(`export ${name}=${token}\n`);
  }
}

// Запуск как программы, а не импорт как модуля.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`tokens: ${error.message}\n`);
    process.exit(2);
  }
}

#!/usr/bin/env node

/**
 * Подготовка полигона VAmPI и получение токенов.
 *
 * Инструмент токены не добывает: логин — это POST, а без `--unsafe-methods`
 * инструмент POST не выполняет (ADR-0008). Учётные данные добывает оператор,
 * то есть этот скрипт, и кладёт их в переменные окружения.
 *
 * Пароли генерируются случайно на каждый прогон и никуда не записываются:
 * ни в файл, ни в вывод. Наружу выходят только токены — их нельзя не выдать,
 * они и есть предмет работы.
 *
 * Ноль зависимостей: только встроенные модули.
 *
 * Использование:
 *   eval "$(node polygons/vampi/tokens.mjs)"          # выставить переменные
 *   node polygons/vampi/tokens.mjs --no-reset          # не пересоздавать базу
 */

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Кого заводим на полигоне.
 *
 * Имена пользователей и названия книг обязаны совпадать со значениями
 * `params` в `barbican.run.yaml`: там объявлены объекты обращения, здесь они
 * создаются. `verify.mjs` сверяет два списка перед прогоном — разойдясь,
 * они дали бы 404 на каждое обращение и отчёт без единой находки.
 */
export const USERS = [
  { username: "alice", tokenEnv: "VAMPI_TOKEN_ALICE", book: "alice-secret-book" },
  { username: "bob", tokenEnv: "VAMPI_TOKEN_BOB", book: "bob-secret-book" },
];

/** Обращения к полигону не должны висеть вечно: стенд поднимается в петле. */
const REQUEST_TIMEOUT_MS = 15_000;

export class ProvisionError extends Error {
  constructor(message) {
    super(`VAmPI setup failed: ${message}`);
    this.name = "ProvisionError";
  }
}

async function request(baseUrl, path, options = {}) {
  const url = new URL(path, baseUrl);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ProvisionError(`${options.method ?? "GET"} ${path}: ${cause.message}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // VAmPI отвечает HTML на ошибках самого Flask — оставляем текст как есть.
    body = { raw: text };
  }
  return { status: response.status, body };
}

function postJson(baseUrl, path, payload, token) {
  return request(baseUrl, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Пересоздаёт базу полигона.
 *
 * Нужно потому, что имя пользователя и название книги в VAmPI уникальны:
 * второй прогон подряд упёрся бы в «User already exists», и пароль от той
 * учётной записи был бы уже неизвестен — он случайный и не сохраняется.
 */
export async function resetDatabase(baseUrl) {
  const { status, body } = await request(baseUrl, "/createdb");
  if (status !== 200) {
    throw new ProvisionError(`GET /createdb returned ${status}`);
  }
  return body;
}

/**
 * Заводит пользователей и их книги, возвращает карту «переменная окружения → токен».
 *
 * @param {{ baseUrl: string, reset?: boolean, log?: (message: string) => void }} options
 * @returns {Promise<Map<string, string>>}
 */
export async function provision({ baseUrl, reset = true, log = () => {} }) {
  if (reset) {
    await resetDatabase(baseUrl);
    log("the polygon database was recreated");
  }

  const tokens = new Map();
  for (const user of USERS) {
    // Пароль живёт только в этой области видимости и только до конца прогона.
    const password = randomBytes(18).toString("base64url");

    const registered = await postJson(baseUrl, "/users/v1/register", {
      username: user.username,
      password,
      email: `${user.username}@vampi.invalid`,
    });
    // VAmPI отвечает 200 и на отказ тоже — судить приходится по телу.
    // Это ровно тот случай, ради которого инструмент не читает тела: здесь
    // мы оператор, а не проверяющий.
    if (registered.body?.status !== "success") {
      // 500 на свежем контейнере означает «нет таблицы users»: образ приезжает
      // без базы, и она создаётся только обращением к /createdb. Проверено:
      // с `--no-reset` на только что поднятом стенде регистрация даёт ровно 500.
      const hint =
        registered.status === 500 && !reset
          ? ". The database does not exist yet — run without --no-reset"
          : "";
      throw new ProvisionError(
        `registration of "${user.username}" was rejected: ` +
          `${registered.body?.message ?? registered.status}${hint}`,
      );
    }

    const loggedIn = await postJson(baseUrl, "/users/v1/login", {
      username: user.username,
      password,
    });
    const token = loggedIn.body?.auth_token;
    if (typeof token !== "string" || token === "") {
      throw new ProvisionError(
        `login of "${user.username}" produced no token: ${loggedIn.body?.message ?? loggedIn.status}`,
      );
    }
    tokens.set(user.tokenEnv, token);

    const book = await postJson(
      baseUrl,
      "/books/v1",
      { book_title: user.book, secret: `secret of ${user.username}` },
      token,
    );
    if (book.body?.status !== "success") {
      throw new ProvisionError(
        `book "${user.book}" was not created: ${book.body?.message ?? book.status}`,
      );
    }

    log(`${user.username}: registered, logged in, book "${user.book}" created`);
  }

  return tokens;
}

/** Значение для `export`: токен — учётные данные, кавычки обязательны. */
function shellQuote(value) {
  if (value.includes("'")) {
    throw new ProvisionError("the token contains a single quote — shell escaping is unreliable");
  }
  return `'${value}'`;
}

async function main() {
  const baseUrl = process.env.VAMPI_BASE_URL ?? "http://127.0.0.1:5002";
  const reset = !process.argv.includes("--no-reset");

  const tokens = await provision({
    baseUrl,
    reset,
    log: (message) => process.stderr.write(`tokens: ${message}\n`),
  });

  // Токены — в stdout, чтобы работал `eval "$(...)"`; всё остальное — в stderr.
  for (const [name, token] of tokens) {
    process.stdout.write(`export ${name}=${shellQuote(token)}\n`);
  }
  process.stderr.write(
    `tokens: done. Tokens live as long as tokentimetolive says ` +
      `in docker-compose.yaml, and are never written to files.\n`,
  );
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

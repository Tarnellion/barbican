#!/usr/bin/env node

/**
 * Preparing the VAmPI polygon and obtaining tokens.
 *
 * The tool does not obtain tokens: a login is a POST, and without
 * `--unsafe-methods` the tool does not perform POST (ADR-0008). The credentials are
 * obtained by the operator, that is, by this script, which puts them into
 * environment variables.
 *
 * The passwords are generated at random on every run and are written nowhere:
 * neither to a file nor to the output. Only the tokens go out — they cannot be
 * withheld, they are the point of the work.
 *
 * Zero dependencies: built-in modules only.
 *
 * Usage:
 *   eval "$(node polygons/vampi/tokens.mjs)"          # set the variables
 *   node polygons/vampi/tokens.mjs --no-reset          # do not recreate the database
 */

import { randomBytes } from "node:crypto";
import { throughColdStart } from "../../tools/cold-start.mjs";
import { isMainModule } from "../../tools/is-main.mjs";

/**
 * Who is created on the polygon.
 *
 * The user names and the book titles must match the `params` values in
 * `barbican.run.yaml`: there the resources requests address are declared, here they
 * are created. `verify.mjs` compares the two lists before the run — once they
 * diverged, they would give a 404 on every request and a report without a single
 * finding.
 */
export const USERS = [
  { username: "alice", tokenEnv: "VAMPI_TOKEN_ALICE", book: "alice-secret-book" },
  { username: "bob", tokenEnv: "VAMPI_TOKEN_BOB", book: "bob-secret-book" },
];

/** Requests to the polygon must not hang forever: the deployment lives on loopback. */
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
    // VAmPI answers with HTML on Flask's own errors — leave the text as it is.
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
 * Recreates the polygon's database.
 *
 * Needed because a user name and a book title are unique in VAmPI: a second run in a
 * row would run into "User already exists", and the password of that account would
 * already be unknown — it is random and is not saved.
 */
export async function resetDatabase(baseUrl, { log = () => {} } = {}) {
  // Retried, because the banner endpoint answers before the database layer is
  // ready — `GET /` touches no database — and asking for the schema a moment too
  // early gets a 500. Measured on 18 August 2026 over 31 cold starts: one
  // refusal, a 200 a second later. It used to end the run at setup, and running
  // it again worked, which is the least useful shape a failure can take.
  //
  // Safe to repeat: `/createdb` drops the schema and creates it again, so a
  // second call does what the first would have.
  const { value, taken } = await throughColdStart(async () => {
    const { status, body } = await request(baseUrl, "/createdb");
    if (status !== 200) {
      throw new ProvisionError(`GET /createdb returned ${status}`);
    }
    return body;
  });

  // Said out loud rather than swallowed. A deployment that needs three attempts
  // every time is broken, and a silent retry is what would make it look healthy.
  if (taken > 1) {
    log(`/createdb answered only on attempt ${taken} — the container was still warming up`);
  }
  return value;
}

/**
 * Creates the users and their books, returns the "environment variable → token" map.
 *
 * @param {{ baseUrl: string, reset?: boolean, log?: (message: string) => void }} options
 * @returns {Promise<Map<string, string>>}
 */
export async function provision({ baseUrl, reset = true, log = () => {} }) {
  if (reset) {
    await resetDatabase(baseUrl, { log });
    log("the polygon database was recreated");
  }

  const tokens = new Map();
  for (const user of USERS) {
    // The password lives in this scope only, and only until the run ends.
    const password = randomBytes(18).toString("base64url");

    const registered = await postJson(baseUrl, "/users/v1/register", {
      username: user.username,
      password,
      email: `${user.username}@vampi.invalid`,
    });
    // VAmPI answers 200 on a refusal as well — judging has to go by the body. This
    // is exactly the case for whose sake the tool does not read bodies: here we are
    // the operator, not the one doing the checking.
    if (registered.body?.status !== "success") {
      // A 500 on a fresh container means "there is no users table": the image arrives
      // without a database, and it is created only by a request to /createdb. Tested:
      // with `--no-reset` on a just-started deployment registration gives exactly 500.
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

/** The value for `export`: a token is a credential, the quotes are mandatory. */
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

  // The tokens go to stdout so that `eval "$(...)"` works; everything else to stderr.
  for (const [name, token] of tokens) {
    process.stdout.write(`export ${name}=${shellQuote(token)}\n`);
  }
  process.stderr.write(
    `tokens: done. Tokens live as long as tokentimetolive says ` +
      `in docker-compose.yaml, and are never written to files.\n`,
  );
}

// Run as a program, not imported as a module. Through `isMainModule` and not the
// usual comparison against `process.argv[1]`: that one is false whenever the path
// goes through a symlink, and then this script does nothing and says nothing.
if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`tokens: ${error.message}\n`);
    process.exit(2);
  }
}

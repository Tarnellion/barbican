#!/usr/bin/env node

/**
 * Preparing the Juice Shop polygon and obtaining tokens.
 *
 * The tool does not obtain tokens: registration and login are POSTs, and without
 * `--unsafe-methods` the tool issues none (ADR-0008). The credentials are the
 * operator's to get, that is, this script's, and it puts them into environment
 * variables.
 *
 * The passwords are generated at random on every run and written nowhere. Only
 * the tokens go out — they cannot be withheld, they are the point of the work.
 *
 * A Juice Shop token is a secret in a stronger sense than usual: its payload
 * carries the bcrypt hash of the password, which is the application's own
 * "Password Hash Leak". Nothing for the tool to find, and a reason not to put one
 * in a log.
 *
 * Zero dependencies: built-in modules only.
 *
 * Usage:
 *   eval "$(node polygons/juice-shop/tokens.mjs)"    # set the variables
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { throughColdStart } from "../../tools/cold-start.mjs";
import { isMainModule } from "../../tools/is-main.mjs";

const POLYGON_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(POLYGON_DIR, "barbican.run.yaml");

/**
 * Who is created on the polygon, and what a fresh container assigns them.
 *
 * `userId` and `basketId` are what the image hands out, checked twice on a
 * cleanly recreated container on 18 August 2026. They are here to be **asserted
 * against the run configuration**, not to be trusted: an image that seeds
 * differently would otherwise leave this polygon quietly probing somebody else's
 * basket and reporting that everything agrees.
 *
 * The basket id is not the user id — alice is user 25 and holds basket 6 — and
 * that is the single easiest mistake to make here.
 */
export const USERS = [
  { id: "alice", tokenEnv: "JUICE_TOKEN_ALICE", userId: 25, basketId: 6 },
  { id: "bob", tokenEnv: "JUICE_TOKEN_BOB", userId: 26, basketId: 7 },
];

/** Requests to the polygon must not hang forever: the deployment lives on loopback. */
const REQUEST_TIMEOUT_MS = 15_000;

export class ProvisionError extends Error {
  constructor(message) {
    super(`Juice Shop setup failed: ${message}`);
    this.name = "ProvisionError";
  }
}

async function request(baseUrl, path, options = {}) {
  const url = new URL(path, baseUrl);
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    throw new ProvisionError(`${options.method ?? "GET"} ${path}: ${cause.message}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Juice Shop answers with HTML on its own error pages — leave the text as it is.
    body = { raw: text };
  }
  return { status: response.status, body };
}

function postJson(baseUrl, path, payload) {
  return request(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * The user's own id, out of the token it was issued.
 *
 * Read rather than looked up: `GET /rest/user/whoami` answers 200 with an empty
 * user for a request carrying only the Authorization header — it wants the cookie
 * — so it cannot serve as the source. The payload is base64url and is not
 * verified here: this is the operator reading a token that was just handed over,
 * not a party trusting one.
 */
function userIdFromToken(token) {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    throw new ProvisionError("the token has no payload segment");
  }
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const data = JSON.parse(Buffer.from(padded, "base64url").toString("utf8"))?.data;
  if (typeof data?.id !== "number") {
    throw new ProvisionError("the token payload carries no numeric user id");
  }
  return data.id;
}

/**
 * What the run configuration declares, so that the two cannot drift apart.
 *
 * Read out of the file rather than repeated here. The numbers in `USERS` above
 * are what the image assigns; these are what the policy addresses; and if the
 * image ever changes its seed the run must stop rather than probe whatever now
 * holds those ids. Same reasoning as the endpoint-reference check in the
 * configuration loader — a declaration that quietly matches nothing is the defect
 * this project is written against.
 */
function declaredResourceIds(configText = readFileSync(CONFIG, "utf8")) {
  const declared = new Map();
  for (const [, name, value] of configText.matchAll(
    /params:\s*\{\s*(basketId|userId):\s*"(\d+)"\s*\}/g,
  )) {
    declared.set(`${name}:${value}`, true);
  }
  return declared;
}

function assertMatchesConfiguration(user, userId, basketId) {
  if (userId !== user.userId || basketId !== user.basketId) {
    throw new ProvisionError(
      `${user.id} came back as user ${userId} with basket ${basketId}, and this script ` +
        `expects user ${user.userId} with basket ${user.basketId}. The image seeds ` +
        `differently than it did on 18 August 2026, so every resource in ` +
        `barbican.run.yaml now addresses somebody else. Re-derive the numbers on a ` +
        `freshly recreated container and update both files.`,
    );
  }
  const declared = declaredResourceIds();
  for (const [name, value] of [
    ["userId", userId],
    ["basketId", basketId],
  ]) {
    if (!declared.has(`${name}:${value}`)) {
      throw new ProvisionError(
        `${user.id} holds ${name} ${value}, which no resource in barbican.run.yaml ` +
          `declares. The run would probe nothing that belongs to this account.`,
      );
    }
  }
}

/**
 * Registers the customers and logs them in, returning "environment variable → token".
 *
 * @param {{ baseUrl: string, log?: (message: string) => void }} options
 * @returns {Promise<Map<string, string>>}
 */
export async function provision({ baseUrl, log = () => {} }) {
  const tokens = new Map();

  for (const user of USERS) {
    // The password lives in this scope only, and only until the run ends.
    const password = `${randomBytes(18).toString("base64url")}aA1!`;
    const email = `${user.id}@juice.invalid`;

    // Retried, because a container that has answered its version banner has not
    // necessarily finished seeding and registration is the first write against
    // the database. Only on a 5xx: a 4xx is the application saying what it
    // thinks — "email must be unique" is what a second run against the same
    // container gets, and repeating it five times buries the one line the
    // operator needed.
    const { taken } = await throughColdStart(
      async () => {
        const attempt = await postJson(baseUrl, "/api/Users/", {
          email,
          password,
          passwordRepeat: password,
          securityQuestion: {
            id: 1,
            question: "Your eldest siblings middle name?",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
          securityAnswer: randomBytes(8).toString("hex"),
        });
        if (attempt.status !== 201) {
          throw Object.assign(
            new ProvisionError(
              `registration of ${user.id} returned ${attempt.status}: ` +
                `${JSON.stringify(attempt.body).slice(0, 200)}`,
            ),
            { answered: attempt.status < 500 },
          );
        }
        return attempt;
      },
      { retryable: (error) => error?.answered !== true },
    );
    if (taken > 1) {
      log(`registration of ${user.id} answered only on attempt ${taken} — the container was cold`);
    }

    const loggedIn = await postJson(baseUrl, "/rest/user/login", { email, password });
    const authentication = loggedIn.body?.authentication;
    if (typeof authentication?.token !== "string") {
      throw new ProvisionError(`login of ${user.id} produced no token: ${loggedIn.status}`);
    }
    // `bid` is the basket, and the tool addresses it as a resource. A login that
    // returns no basket means there is nothing for basket.read to be about, and a
    // run without it would report agreement on cells it never made.
    if (typeof authentication.bid !== "number") {
      throw new ProvisionError(`login of ${user.id} returned no basket id`);
    }

    const userId = userIdFromToken(authentication.token);
    assertMatchesConfiguration(user, userId, authentication.bid);

    tokens.set(user.tokenEnv, authentication.token);
    log(`${user.id}: registered, logged in as user ${userId}, basket ${authentication.bid}`);
  }

  return tokens;
}

function shellQuote(value) {
  if (value.includes("'")) {
    throw new ProvisionError("the token contains a single quote — shell escaping is unreliable");
  }
  return `'${value}'`;
}

async function main() {
  const baseUrl = process.env.JUICE_BASE_URL ?? "http://127.0.0.1:3010";

  const tokens = await provision({
    baseUrl,
    log: (message) => process.stderr.write(`tokens: ${message}\n`),
  });

  // The tokens go to stdout so that `eval "$(...)"` works; everything else to stderr.
  for (const [name, token] of tokens) {
    process.stdout.write(`export ${name}=${shellQuote(token)}\n`);
  }
  process.stderr.write("tokens: done. They are never written to files.\n");
}

// Run as a program, not imported as a module. Through `isMainModule` rather than
// the usual comparison against `process.argv[1]`: that one is false whenever the
// path goes through a symlink, and then this script does nothing and says nothing.
if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`tokens: ${error.message}\n`);
    process.exit(2);
  }
}

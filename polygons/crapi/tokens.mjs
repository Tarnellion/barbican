#!/usr/bin/env node

/**
 * Obtaining crAPI's tokens.
 *
 * The tool does not obtain them and must not: a login in crAPI is a POST, and without
 * `--unsafe-methods` the tool does not perform POST (ADR-0008). The credentials are
 * obtained by the operator, that is, by this script, which puts them into environment
 * variables.
 *
 * crAPI's users are pre-seeded by its own seed — there is nobody to create, unlike in
 * VAmPI. The passwords of the pre-seeded accounts are published by the project itself
 * and are simply repeated here: this is a constant of a loopback deployment, not a
 * secret.
 *
 * Zero dependencies: built-in modules only.
 *
 * Usage:
 *   eval "$(node polygons/crapi/tokens.mjs)"
 */

import { isMainModule } from "../../tools/is-main.mjs";

/** Requests to the polygon must not hang forever: the deployment lives on loopback. */
const REQUEST_TIMEOUT_MS = 15_000;

const LOGIN_ROUTE = "/identity/api/auth/login";

function user(id, email, secret, tokenEnv) {
  return { id, email, secret, tokenEnv };
}

/**
 * The passwords of the deployment's pre-seeded users.
 *
 * These are not secrets: the values are published in crAPI itself as seed constants,
 * and the deployment lives on the loopback and is created anew for every run. VAmPI
 * does without them — there the users are registered by a script with random
 * passwords — while here the accounts are pre-seeded, and there is nowhere else to
 * take them from.
 *
 * They are overridden by the environment: a "password as a literal" sample is not
 * worth keeping in a repository even where it is harmless — the reader copies the
 * form, not the caveat.
 */
function secretOf(name, published) {
  return process.env[`CRAPI_PASSWORD_${name.toUpperCase()}`] ?? published;
}

/**
 * Who is logged in.
 *
 * The variable names must match `tokenEnv` in `barbican.run.yaml`: once they
 * diverged, they would give a run without a single token, that is, a solid wall of
 * 401s, and a solid wall of denials agrees with the policy and looks like a clean
 * report.
 */
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
 * Logs everyone in and returns the "environment variable → token" map.
 *
 * The tokens do go out — they cannot be withheld, they are the point of the work.
 * They are written nowhere: neither to a file nor to a report.
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
 * The token goes into `export` without quotes, but only if it consists of safe
 * characters: a JWT is base64url separated by dots, and nothing else should be there.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._-]+$/;

const DEFAULT_BASE_URL = "http://127.0.0.1:8888";

async function main() {
  const baseUrl = process.env.CRAPI_BASE_URL ?? DEFAULT_BASE_URL;
  const report = (message) => process.stderr.write(`tokens: ${message}\n`);
  const tokens = await provision({ baseUrl, log: report });

  // The tokens go to stdout so that eval works; everything else to stderr.
  for (const [name, token] of tokens) {
    if (!TOKEN_SHAPE.test(token)) {
      throw new ProvisionError(`token ${name} contains unexpected characters`);
    }
    process.stdout.write(`export ${name}=${token}\n`);
  }
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

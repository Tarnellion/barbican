/**
 * The values that live in the environment and nowhere else.
 *
 * Two of them: an account's token, and a context attribute declared as
 * `{ env: NAME }`. Both are resolved in a step of their own, with the
 * environment passed in rather than read from inside, and neither is ever put
 * back into the configuration — that way a value cannot travel into the report
 * along with the serialized declaration. What the report keeps is the
 * **name**.
 *
 * Fitness for a request is checked here rather than on the first call: one typo
 * in a variable would otherwise turn into dozens of identical failures in the
 * middle of a run instead of one clear error at startup.
 */

import { isHeaderValue, lookup, safeHeaders } from "../untrusted.js";
import type { ContextAttributeValue, ContextValues, RunConfig } from "./types.js";

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
 * Resolves the values of context attributes: literals as they are, references from
 * the environment.
 *
 * A separate step, like `resolveTokens`: the environment is passed in explicitly
 * rather than read from inside. A value from the environment never lands in the
 * report — the declaration `{ env: NAME }` stays there.
 *
 * Only headers can carry one. A query attribute is a literal by its type, because
 * it is substituted into the address and addresses are printed as they were sent.
 *
 * @throws {MissingContextValueError} the variable is unset or empty
 * @throws {InvalidContextValueError} the value cannot be sent in a request
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
        // Not `environment[declared.env]`: the name comes from the configuration
        // and the lookup walks the prototype chain. `{ env: constructor }`
        // returned a function and the caller got `value.trim is not a function`.
        const value = lookup(environment, declared.env);
        if (value === undefined || value.trim() === "") {
          throw new MissingContextValueError(context.id, where, declared.env);
        }
        if (!isHeaderValue(value)) {
          throw new InvalidContextValueError(context.id, where, declared.env);
        }
        out[name] = value;
      }
      return out;
    };
    resolved.set(context.id, {
      // Through `safeHeaders`, the only producer of the type the client accepts.
      // The names were checked when the configuration was parsed and the values
      // just now; this is the seam where both are turned into something the
      // compiler will carry the rest of the way.
      headers: safeHeaders(Object.entries(take(context.headers, "header"))),
      // Nothing to resolve: the schema admits no `{ env: … }` here.
      query: { ...context.query },
    });
  }
  return resolved;
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

/**
 * Two accounts present the same token.
 *
 * The whole tool rests on the platform being able to tell the accounts apart. If
 * two of them hand over the same credential, every request the run makes "as
 * carol" arrives as alice, and the central claim — "carol cannot read alice's
 * order" — is proved by carol *being* alice. Nothing downstream can notice:
 * the canaries pass, every status is what the policy expects, the report comes
 * back clean and the run reads as evidence of isolation.
 *
 * A refusal rather than a warning, and before the first request, for the same
 * reason a missing host allowlist is one: a result that cannot mean what it says
 * is worse than no result. The reference platform has refused this since the day
 * it was written (`readTokens` in `polygon/server.mjs`) — the tool that checks
 * platforms did not. Found by the audit of 14 August 2026 (K-8).
 *
 * Neither the message nor the fields carry the token: the two variable names are
 * what the operator has to go and look at, and a value that reaches an error
 * message reaches a log.
 */
export class SharedCredentialError extends Error {
  readonly accountId: string;
  readonly variable: string;
  readonly otherAccountId: string;
  readonly otherVariable: string;

  constructor(accountId: string, variable: string, other: { id: string; variable: string }) {
    super(
      `Accounts "${other.id}" and "${accountId}" present the same token, so the ` +
        `platform cannot tell them apart: every cross-account check would compare ` +
        `an account with itself and report the match as isolation. ` +
        (variable === other.variable
          ? `Both read it from ${variable} — give each account a variable of its own.`
          : `${other.variable} and ${variable} hold the same value — the same once ` +
            `surrounding whitespace is removed, which is what a platform compares.`),
    );
    this.name = "SharedCredentialError";
    this.accountId = accountId;
    this.variable = variable;
    this.otherAccountId = other.id;
    this.otherVariable = other.variable;
  }
}

/**
 * Takes the tokens out of the environment.
 *
 * Returns a separate map rather than a field in the configuration: that way a
 * token cannot accidentally travel into the report along with the serialized
 * configuration.
 *
 * Fitness for a header is checked here rather than on the first request: otherwise
 * one typo in a variable would turn into dozens of identical failures in the
 * middle of a run instead of one clear error at startup.
 *
 * @throws {MissingCredentialError} the variable is unset or empty
 * @throws {InvalidCredentialError} the token is unfit as a header value
 * @throws {SharedCredentialError} two accounts present the same token
 */
export function resolveTokens(
  config: RunConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  /**
   * Who already presents each token, so that a second account presenting it can
   * be named against the first.
   *
   * A `Map` keyed by the token value, which never leaves this function: the
   * accounts derived for request conditions share their principal's credential
   * by design (`principalOf`), so the check is over declared accounts only —
   * exactly the set this loop walks.
   */
  const presentedBy = new Map<string, { id: string; variable: string }>();
  for (const account of config.accounts) {
    if (account.tokenEnv === undefined) {
      // An anonymous account: there are no credentials on purpose.
      continue;
    }
    // `tokenEnv: constructor` used to return `Object.prototype.constructor` and
    // fail with `TypeError: value.trim is not a function` instead of naming the
    // variable. The class was already recognised and closed once in this file,
    // which is what makes it a class. Found by the audit of 14 August (D-3).
    const value = lookup(environment, account.tokenEnv);
    if (value === undefined || value.trim() === "") {
      throw new MissingCredentialError(account.id, account.tokenEnv);
    }
    if (!isHeaderValue(value)) {
      throw new InvalidCredentialError(account.id, account.tokenEnv);
    }
    // Keyed by the **trimmed** value, because that is what the platform compares.
    //
    // Raw values were compared until 17 August 2026, and one trailing space took
    // the whole check off: `tok-alice` and `"tok-alice "` are two different
    // strings and one credential — every parser trims the optional whitespace a
    // header value may carry, and the reference platform in this repository does
    // it in the regular expression that reads `Authorization`. Both accounts then
    // authenticated as alice, both canaries passed, and the run reported
    // isolation proved by comparing an account with itself: exactly the failure
    // this check exists to refuse, wearing a space. Found by adversarial review.
    //
    // Trimming is the only normalisation applied. What a platform does beyond it
    // — case, encoding, a prefix of its own — is unknown here, and guessing would
    // trade a refusal that is right for one that is plausible.
    const presented = value.trim();
    const other = presentedBy.get(presented);
    if (other !== undefined) {
      throw new SharedCredentialError(account.id, account.tokenEnv, other);
    }
    presentedBy.set(presented, { id: account.id, variable: account.tokenEnv });
    tokens.set(account.id, value);
  }
  return tokens;
}

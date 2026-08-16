/**
 * The ways of presenting oneself to the system under test.
 *
 * A scheme is a property of the **surface**, not of the run: on a multi-brand
 * platform the affiliate cabinet, the operator console and the customer API
 * authenticate differently, and a run covering them all at once must be able to
 * knock on each in its own way. That is why the provider knows a default scheme
 * and per-account overrides. See ADR-0016.
 *
 * Cookies are supported in one direction only: the value comes from the
 * environment, it is not extracted from responses. This does not touch the
 * invariant "we do not read bodies and `set-cookie`" — we only send what we were
 * given.
 */

import type { HeaderValue } from "../io/untrusted.js";
import { headerName, safeHeaders } from "../io/untrusted.js";
import type { CredentialProvider } from "./ports.js";

/**
 * Request signing is not expressible by a built-in scheme — and that is a
 * decision, not an unfinished piece: canonicalization differs from platform to
 * platform, and a common format invented without a target would give a
 * configuration that describes a signature but matches no real one. A scheme of
 * one's own is implemented on top of the `CredentialProvider` port, which is
 * given a description of the request for exactly this purpose. See ADR-0018.
 */
export type AuthScheme =
  /** `Authorization: Bearer <token>` — the most common scheme for JWTs. */
  | { readonly kind: "bearer" }
  /** An arbitrary header as a whole, for example `X-API-Key: <token>`. */
  | { readonly kind: "header"; readonly header: string }
  /** `Cookie: <name>=<value>` — session-based platforms. */
  | { readonly kind: "cookie"; readonly name: string }
  /** `Authorization: Basic <base64>`; the variable holds `login:password`. */
  | { readonly kind: "basic" };

export const DEFAULT_AUTH_SCHEME: AuthScheme = { kind: "bearer" };

export class InvalidAuthSchemeError extends Error {
  constructor(reason: string, where?: string) {
    super(`Invalid authentication scheme${where === undefined ? "" : ` (${where})`}: ${reason}`);
    this.name = "InvalidAuthSchemeError";
  }
}

/**
 * Checks that the scheme can be sent at all.
 *
 * Exported so that configuration parsing can reject an unusable scheme where its
 * **name** is known: 'the scheme "operator-console"' is more useful to a human
 * than 'the scheme of account admin-a' — the name of the scheme is what they
 * edited.
 *
 * @throws {InvalidAuthSchemeError}
 */
export function assertAuthSchemeIsSound(scheme: AuthScheme, where?: string): void {
  // The grammar comes from `src/io/untrusted.ts`, where it is written once. It
  // used to be a second copy of the same regular expression, character for
  // character — the state a duplicate is in right up until it is not.
  if (scheme.kind === "header") {
    try {
      headerName(scheme.header);
    } catch {
      throw new InvalidAuthSchemeError(`"${scheme.header}" is not a header name`, where);
    }
  }
  if (scheme.kind === "cookie") {
    try {
      headerName(scheme.name);
    } catch {
      throw new InvalidAuthSchemeError(`"${scheme.name}" is not a cookie name`, where);
    }
  }
}

/**
 * The headers by which one token is presented under one scheme.
 *
 * Through `safeHeaders`, which is the only producer of the type the client
 * accepts. The token was checked when it was read out of the environment; the
 * check here is the one that holds for a consumer of the library, who never went
 * through `resolveTokens`.
 */
function headersFrom(scheme: AuthScheme, token: string): Readonly<Record<string, HeaderValue>> {
  switch (scheme.kind) {
    case "bearer":
      return safeHeaders([["authorization", `Bearer ${token}`]]);
    case "header":
      return safeHeaders([[scheme.header.toLowerCase(), token]]);
    case "cookie":
      return safeHeaders([["cookie", `${scheme.name}=${token}`]]);
    case "basic":
      return safeHeaders([
        ["authorization", `Basic ${Buffer.from(token, "utf8").toString("base64")}`],
      ]);
  }
}

/**
 * Creates the credential provider.
 *
 * Tokens are passed in a separate map and are not stored in the configuration —
 * see ADR-0008.
 *
 * `schemesByAccount` overrides the scheme for the named accounts; the rest go by
 * `defaultScheme`. A map rather than a field on the account: the provider does
 * not know the structure of the configuration and must not know it.
 *
 * @throws {InvalidAuthSchemeError} the scheme is unusable for sending
 */
export function createCredentialProvider(
  defaultScheme: AuthScheme,
  tokens: ReadonlyMap<string, string>,
  schemesByAccount: ReadonlyMap<string, AuthScheme> = new Map(),
): CredentialProvider {
  assertAuthSchemeIsSound(defaultScheme);
  // All of them are checked, not only the ones applied: an unusable scheme must
  // fail when the provider is created, not on the first request from the account
  // the run reaches in the middle of the matrix.
  for (const [accountId, scheme] of schemesByAccount) {
    assertAuthSchemeIsSound(scheme, `account "${accountId}"`);
  }

  return {
    headersFor(accountId: string): Readonly<Record<string, HeaderValue>> {
      const token = tokens.get(accountId);
      if (token === undefined) {
        // An anonymous request is a legitimate case: this is how one checks
        // whether an endpoint is open to everyone at all.
        return safeHeaders([]);
      }

      return headersFrom(schemesByAccount.get(accountId) ?? defaultScheme, token);
    },
  };
}

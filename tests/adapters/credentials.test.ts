/**
 * Authentication scheme tests.
 *
 * They check exactly what goes out in the headers: a tool "configured" for the
 * right scheme that sends the wrong thing gives a picture of solid denials and
 * silently reports there is no access anywhere.
 */

import { describe, expect, it } from "vitest";
import {
  createCredentialProvider,
  DEFAULT_AUTH_SCHEME,
  InvalidAuthSchemeError,
} from "../../src/adapters/credentials.js";

const tokens = new Map([["acc", "s3cret-token"]]);

/** The built-in schemes ignore the request: their header is the same for every cell. */
const ANY_REQUEST = { method: "GET", url: "https://api.test/v1/orders" };

describe("authentication schemes", () => {
  it("bearer puts the token in Authorization with a prefix", () => {
    const provider = createCredentialProvider({ kind: "bearer" }, tokens);

    expect(provider.headersFor("acc", ANY_REQUEST)).toEqual({
      authorization: "Bearer s3cret-token",
    });
  });

  it("header puts the token in the named header whole, with no prefix", () => {
    const provider = createCredentialProvider({ kind: "header", header: "X-API-Key" }, tokens);

    expect(provider.headersFor("acc", ANY_REQUEST)).toEqual({ "x-api-key": "s3cret-token" });
  });

  it("cookie assembles a name-value pair", () => {
    const provider = createCredentialProvider({ kind: "cookie", name: "session" }, tokens);

    expect(provider.headersFor("acc", ANY_REQUEST)).toEqual({ cookie: "session=s3cret-token" });
  });

  it("basic encodes the login and the password in base64", () => {
    const provider = createCredentialProvider({ kind: "basic" }, new Map([["acc", "user:pass"]]));

    expect(provider.headersFor("acc", ANY_REQUEST)).toEqual({
      authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
    });
  });

  it("bearer is the default", () => {
    expect(DEFAULT_AUTH_SCHEME).toEqual({ kind: "bearer" });
  });
});

describe("an anonymous request", () => {
  // A lawful case: this is how you check whether an endpoint is open to everyone.
  it("an account without a token makes the request with no headers", () => {
    const provider = createCredentialProvider({ kind: "bearer" }, tokens);

    expect(provider.headersFor("unknown-account", ANY_REQUEST)).toEqual({});
  });
});

describe("a per-account scheme", () => {
  // The override exists for exactly this: on a multi-brand platform the
  // customer API, the operator console and the affiliate cabinet authenticate
  // differently, and one run has to cover them all at once.
  const many = new Map([
    ["player", "player-token"],
    ["operator", "operator-token"],
    ["affiliate", "affiliate-token"],
  ]);

  const provider = createCredentialProvider(
    DEFAULT_AUTH_SCHEME,
    many,
    new Map([
      ["operator", { kind: "cookie", name: "opsid" } as const],
      ["affiliate", { kind: "header", header: "X-Affiliate-Key" } as const],
    ]),
  );

  it("an account with a scheme of its own goes out with it", () => {
    expect(provider.headersFor("operator", ANY_REQUEST)).toEqual({
      cookie: "opsid=operator-token",
    });
    expect(provider.headersFor("affiliate", ANY_REQUEST)).toEqual({
      "x-affiliate-key": "affiliate-token",
    });
  });

  it("an account without one goes out with the default scheme", () => {
    expect(provider.headersFor("player", ANY_REQUEST)).toEqual({
      authorization: "Bearer player-token",
    });
  });

  it("an override gives no headers to an account without a token", () => {
    // Otherwise an anonymous account would stop being anonymous, and the claim
    // "this endpoint is not public" would be checked by the wrong request.
    const anonymous = createCredentialProvider(
      DEFAULT_AUTH_SCHEME,
      new Map(),
      new Map([["ghost", { kind: "cookie", name: "opsid" } as const]]),
    );

    expect(anonymous.headersFor("ghost", ANY_REQUEST)).toEqual({});
  });
});

describe("scheme validation", () => {
  it("rejects a header name with forbidden characters", () => {
    expect(() => createCredentialProvider({ kind: "header", header: "X Api Key" }, tokens)).toThrow(
      InvalidAuthSchemeError,
    );
    expect(() =>
      createCredentialProvider({ kind: "header", header: "X-Key:\nInjected" }, tokens),
    ).toThrow(InvalidAuthSchemeError);
  });

  it("rejects a cookie name with forbidden characters", () => {
    expect(() => createCredentialProvider({ kind: "cookie", name: "sess ion" }, tokens)).toThrow(
      InvalidAuthSchemeError,
    );
  });

  it("validates the scheme on creation, not on the first request", () => {
    // Otherwise a configuration error would surface in the middle of the run.
    expect(() => createCredentialProvider({ kind: "header", header: "" }, tokens)).toThrow(
      InvalidAuthSchemeError,
    );
  });

  it("validates the overrides too, not only the default scheme", () => {
    // An unvalidated override would surface on whichever request the run
    // reaches in the middle of the matrix — that is, after the canaries.
    expect(() =>
      createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        tokens,
        new Map([["acc", { kind: "cookie", name: "sess ion" } as const]]),
      ),
    ).toThrow(InvalidAuthSchemeError);
  });

  it("names the account in the message about an invalid override", () => {
    expect(() =>
      createCredentialProvider(
        DEFAULT_AUTH_SCHEME,
        tokens,
        new Map([["acc", { kind: "header", header: "X Key" } as const]]),
      ),
    ).toThrow(/acc/);
  });
});

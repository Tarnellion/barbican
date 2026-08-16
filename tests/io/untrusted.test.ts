/**
 * Strings from outside, and the slots they are allowed into.
 *
 * The audit of 14 August 2026 counted eleven point fixes of one shape across
 * four files, each site checking what it happened to remember to check. Two
 * copies of the header-value rule had already drifted apart by one character.
 * Four defects came out of the same shape, and all four are here — they are one
 * test file because they are one mistake made four times.
 *
 * D-2 a signal named `__proto__` disappeared from every observation.
 * D-3 `tokenEnv: constructor` failed with `TypeError` instead of naming it.
 * D-4 a response header named `__proto__` vanished.
 * D-6 the class was closed on the CLI path only.
 */

import { describe, expect, it } from "vitest";
import type { HttpRequest } from "../../src/adapters/ports.js";
import { createSignalExtractor } from "../../src/adapters/signals.js";
import { MissingCredentialError, parseRunConfig, resolveTokens } from "../../src/io/config.js";
import {
  headerName,
  headerValue,
  lookup,
  openRecord,
  pathSegment,
  safeHeaders,
  UnusableHeaderNameError,
  UnusableHeaderValueError,
  UnusablePathSegmentError,
} from "../../src/io/untrusted.js";

describe("the grammars, written once", () => {
  it("refuses a header name that is not one", () => {
    // The non-ASCII cases are written as escapes. The file is checked to be in
    // English and must stay ASCII on disk besides: a literal control or accented
    // character is invisible in a diff, and what is being tested is the byte, not
    // how it is spelled.
    for (const bad of ["x auth", "x:auth", "", "x-caf\u00e9", "x\nauth"]) {
      expect(() => headerName(bad)).toThrow(UnusableHeaderNameError);
    }
    expect(headerName("x-request-id")).toBe("x-request-id");
  });

  it("refuses a header value a request could not carry", () => {
    for (const bad of ["line\nbreak", "null\u0000byte", "caf\u00e9"]) {
      expect(() => headerValue(bad, "x-test")).toThrow(UnusableHeaderValueError);
    }
  });

  /**
   * The character the two copies disagreed on. `*`, not `+`: an empty value is
   * legal in HTTP and legitimate for a declared condition. Where emptiness is
   * itself the mistake it is caught earlier, and with a better message — see the
   * credential test below.
   */
  it("accepts an empty header value", () => {
    expect(headerValue("", "x-test")).toBe("");
  });

  /** The value is what would be secret. The name is not. */
  it("never prints the value it refused", () => {
    const secret = "sk_live_\u0000nope";

    expect(() => headerValue(secret, "authorization")).toThrow(/"authorization"/);
    expect(() => headerValue(secret, "authorization")).not.toThrow(/sk_live/);
  });

  it("refuses a path segment that navigates instead of naming", () => {
    for (const bad of ["", ".", ".."]) {
      expect(() => pathSegment(bad)).toThrow(UnusablePathSegmentError);
    }
    // The slash is escaped, and that was never the hole: the dot is.
    expect(pathSegment("a/b")).toBe("a%2Fb");
  });
});

describe("a record whose keys came from outside", () => {
  /**
   * The shape behind D-2 and D-4. In a plain object literal this assignment
   * calls the prototype setter: the entry does not appear, and the object's
   * prototype is replaced.
   */
  it("carries a key named __proto__ instead of swallowing it", () => {
    const record = openRecord<string>();
    // biome-ignore lint/suspicious/noProto: the literal key is the subject of the test — that this name is carried as data, not as a prototype
    record["__proto__"] = "kept";

    expect(Object.keys(record)).toEqual(["__proto__"]);
    // biome-ignore lint/suspicious/noProto: the literal key is the subject of the test — that this name is carried as data, not as a prototype
    expect(record["__proto__"]).toBe("kept");

    const plain: Record<string, string> = {};
    // biome-ignore lint/suspicious/noProto: the literal key is the subject of the test — that this name is carried as data, not as a prototype
    plain["__proto__"] = "lost";
    expect(Object.keys(plain)).toEqual([]);
  });

  it("does not answer for keys it was never given", () => {
    const record: Record<string, string> = { real: "yes" };

    expect(lookup(record, "real")).toBe("yes");
    // `record["constructor"]` is a function; every caller then treats it as its
    // own value type and fails somewhere unrelated.
    expect(lookup(record, "constructor")).toBeUndefined();
    expect(lookup(record, "__proto__")).toBeUndefined();
    expect(lookup(record, "toString")).toBeUndefined();
  });

  it("builds sendable headers with both halves checked", () => {
    expect(() => safeHeaders([["x auth", "v"]])).toThrow(UnusableHeaderNameError);
    expect(() => safeHeaders([["x-auth", "v\n"]])).toThrow(UnusableHeaderValueError);
    expect({ ...safeHeaders([["x-auth", "v"]]) }).toEqual({ "x-auth": "v" });
  });
});

describe("D-6: the class was closed on the CLI path only", () => {
  /**
   * The whole point, and it is a compile-time claim rather than a runtime one:
   * `HttpRequest.headers` asks for `HeaderValue`, and the only way to obtain
   * one is to pass through the check. A consumer of the library used to build a
   * request by hand, go past all four regular expressions, and get
   * `RequestFailedError: Cannot convert argument to a ByteString` out of the
   * retry loop after three attempts — naming neither the header, nor the value,
   * nor the account.
   *
   * Checked by `pnpm run typecheck`, which reads this file: if the brand is
   * removed the expected error stops happening and tsc fails on the directive
   * itself.
   */
  it("does not accept a plain record of strings", () => {
    const raw: Readonly<Record<string, string>> = { "x-auth": "line\nbreak" };
    // Annotated, or there is no contextual type and the directive checks
    // nothing. The first version of this test left it off and `tsc` reported
    // the `@ts-expect-error` itself as unused — which is the compiler catching
    // a proof that proved nothing.
    const request: HttpRequest = {
      method: "GET",
      url: "https://a.test/v1",
      // @ts-expect-error a raw Record<string, string> is not a checked header set
      headers: raw,
    };
    const checked: HttpRequest = { ...request, headers: safeHeaders([["x-auth", "fine"]]) };

    expect(checked.headers["x-auth"]).toBe("fine");
  });
});

describe("D-2: a signal named __proto__", () => {
  it("reaches the observation like any other", async () => {
    const extractor = createSignalExtractor({ salt: new Uint8Array([1, 2, 3, 4]) });
    const body = new Response('{"items":[1,2,3]}').body;
    if (body === null) {
      throw new Error("the test stream was not created");
    }

    const signals = await extractor.extract(body, [
      { name: "__proto__", kind: "count", path: "items" },
    ]);

    expect(Object.keys(signals)).toEqual(["__proto__"]);
    // biome-ignore lint/suspicious/noProto: the literal key is the subject of the test — that this name is carried as data, not as a prototype
    expect(signals["__proto__"]).toBe(3);
  });
});

describe("D-3: a variable name that is a property of Object.prototype", () => {
  const config = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: constructor }]
policy: { fallback: denied, rules: [] }
`);

  /**
   * `environment[account.tokenEnv]` returned `Object.prototype.constructor` — a
   * function — and the next line called `.trim()` on it. The operator saw
   * `TypeError: value.trim is not a function` and nothing about which variable.
   */
  it("names the variable instead of failing on its type", () => {
    expect(() => resolveTokens(config, {})).toThrow(MissingCredentialError);
    expect(() => resolveTokens(config, {})).toThrow(/constructor/);
  });

  /** An empty token is still an empty token, and says so. */
  it("keeps saying which variable was empty", () => {
    const named = parseRunConfig(`
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts: [{ id: u, role: r, tenant: t, tokenEnv: TOKEN_A }]
policy: { fallback: denied, rules: [] }
`);

    expect(() => resolveTokens(named, { TOKEN_A: "" })).toThrow(MissingCredentialError);
    expect(() => resolveTokens(named, { TOKEN_A: " " })).toThrow(/TOKEN_A/);
  });
});

/**
 * HTTP client tests.
 *
 * Against a real local server, with no fetch stub: what is checked is what
 * really went out on the network and what really came back, not how the call
 * was written.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  CircuitOpenError,
  createHttpClient,
  EmptyScopeError,
  HostNotAllowedError,
  parseRetryAfter,
  RequestFailedError,
  UnsafeMethodError,
  UnsupportedProtocolError,
} from "../../src/adapters/http.js";
import { createThrottle } from "../../src/adapters/throttle.js";
import { safeHeaders } from "../../src/io/untrusted.js";
import { createTestClock } from "../fixtures/clock.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  readonly port: number;
  readonly paths: readonly string[];
  close(): Promise<void>;
}

async function startServer(handler: Handler): Promise<TestServer> {
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    paths.push(request.url ?? "");
    handler(request, response);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not start the test server");
  }
  return {
    port: address.port,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function clientFor(overrides: Record<string, unknown> = {}) {
  const clock = createTestClock();
  const client = createHttpClient({
    allowedHosts: ["127.0.0.1"],
    throttle: createThrottle({ concurrency: 4, requestsPerSecond: 1000, maxRequests: 100 }, clock),
    clock,
    random: () => 0.5,
    ...overrides,
  });
  return { client, clock };
}

const GET = (port: number, path = "/") =>
  ({ method: "GET", url: `http://127.0.0.1:${port}${path}`, headers: {} }) as const;

describe("headers added after a cold read", () => {
  /**
   * Both were redacted for nothing, and both are needed to work through a
   * finding.
   *
   * `cache-control` changes the damage estimate: a cross-tenant leak marked
   * `public` multiplies through a CDN, and the blast radius is a different one
   * entirely. `date` is the only handle for matching a finding against the
   * server log. Neither carries credentials.
   */
  it("keeps cache-control and date while still redacting set-cookie", async () => {
    const server = await startServer((_request, response) => {
      response.setHeader("cache-control", "public, max-age=60");
      // ASCII only: Node rejects Cyrillic in a header value.
      response.setHeader("set-cookie", "session=platform-secret");
      response.setHeader("x-internal", "also-secret");
      response.writeHead(200);
      response.end();
    });

    try {
      const { client } = clientFor();
      const result = await client.send({
        method: "GET",
        url: `http://127.0.0.1:${server.port}/x`,
        headers: {},
      });

      expect(result.headers["cache-control"]).toBe("public, max-age=60");
      expect(result.headers["date"]).toMatch(/GMT/);
      expect(result.headers["set-cookie"]).toBe("[REDACTED]");
      expect(result.headers["x-internal"]).toBe("[REDACTED]");
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      await server.close();
    }
  });
});

describe("the scope of the check", () => {
  it("refuses to work without an allowlist", () => {
    const throttle = createThrottle();

    expect(() => createHttpClient({ allowedHosts: [], throttle })).toThrow(EmptyScopeError);
    expect(() => createHttpClient({ allowedHosts: ["  "], throttle })).toThrow(EmptyScopeError);
  });

  it("tells entries with a port apart from entries without one", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    try {
      // An entry without a port allows any port — as it did before.
      const loose = clientFor().client;
      await expect(loose.send(GET(server.port))).resolves.toMatchObject({ status: 200 });

      // An entry with a port allows exactly that one.
      const exact = clientFor({ allowedHosts: [`127.0.0.1:${server.port}`] }).client;
      await expect(exact.send(GET(server.port))).resolves.toMatchObject({ status: 200 });

      const wrong = clientFor({ allowedHosts: ["127.0.0.1:1"] }).client;
      await expect(wrong.send(GET(server.port))).rejects.toThrow(HostNotAllowedError);
    } finally {
      await server.close();
    }
  });

  it("makes no request to a host outside the scope", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    try {
      const { client } = clientFor({ allowedHosts: ["example.test"] });

      await expect(client.send(GET(server.port))).rejects.toThrow(HostNotAllowedError);
      expect(server.paths).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects protocols other than http and https", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    try {
      const { client } = clientFor();

      await expect(
        client.send({ method: "GET", url: "file:///etc/passwd", headers: {} }),
      ).rejects.toThrow(UnsupportedProtocolError);
    } finally {
      await server.close();
    }
  });
});

describe("safe methods by default", () => {
  it("does not send a modifying request without explicit permission", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    try {
      const { client } = clientFor();

      await expect(
        client.send({ method: "DELETE", url: `http://127.0.0.1:${server.port}/`, headers: {} }),
      ).rejects.toThrow(UnsafeMethodError);

      // Nothing went out: the ban applies before sending, not after.
      expect(server.paths).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("lets a modifying request through with explicit permission", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(204).end();
    });
    try {
      const { client } = clientFor({ allowUnsafeMethods: true });

      const response = await client.send({
        method: "DELETE",
        url: `http://127.0.0.1:${server.port}/x`,
        headers: {},
      });

      expect(response.status).toBe(204);
      expect(server.paths).toEqual(["/x"]);
    } finally {
      await server.close();
    }
  });
});

describe("the response body and sensitive headers", () => {
  const CANARY = "pii-canary-3f9a2b";

  it("returns no body in any form", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ email: CANARY, balance: 1000 }));
    });
    try {
      const { client } = clientFor();

      const response = await client.send(GET(server.port));

      expect(Object.keys(response).sort()).toEqual(["headers", "status"]);
      expect(JSON.stringify(response)).not.toContain(CANARY);
    } finally {
      await server.close();
    }
  });

  // Found by adversarial review: the deny list of names was structurally wrong —
  // x-auth-token, authentication-info, x-amz-security-token and a client's
  // email in x-user-email all slipped past it.
  it("redacts any header that is not on the allow list", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        "set-cookie": "session=super-secret-token; HttpOnly",
        "x-auth-token": "XAUTH-SESSION-abc123",
        "authentication-info": "nextnonce=NONCE-SECRET",
        "x-amz-security-token": "AWS-STS-SESSION-TOKEN",
        "x-user-email": "client.pii@example.test",
        "content-type": "application/json",
      });
      response.end();
    });
    try {
      const { client } = clientFor();

      const response = await client.send(GET(server.port));

      for (const secret of [
        "super-secret-token",
        "XAUTH-SESSION-abc123",
        "NONCE-SECRET",
        "AWS-STS-SESSION-TOKEN",
        "client.pii@example.test",
      ]) {
        expect(JSON.stringify(response)).not.toContain(secret);
      }
      // Names are kept: the presence of a header is a signal, its value is not.
      expect(response.headers["x-auth-token"]).toBe("[REDACTED]");
      // Allowed ones are kept whole: they are needed for the verdict.
      expect(response.headers["content-type"]).toBe("application/json");
    } finally {
      await server.close();
    }
  });

  /**
   * The promise made two tests above — "names are kept: the presence of a header
   * is a signal" — did not hold for one name. Assigning `__proto__` into a plain
   * object literal calls the prototype setter, so the header vanished and the
   * report was silently short one. Found by the audit of 14 August (D-4).
   *
   * `__proto__` is a legal header name by RFC 9110, so a target can send it —
   * which is the difference between a curiosity and a way to blind a run.
   */
  it("keeps a response header named __proto__ like any other", async () => {
    const server = await startServer((_request, response) => {
      // `setHeader`, and not an object literal: in a literal `__proto__:` is
      // syntax rather than a key — it sets the prototype and sends no header at
      // all. The first version of this test did that and proved nothing, which
      // is the same trap one layer up.
      response.setHeader("__proto__", "polluted");
      response.setHeader("content-type", "application/json");
      response.writeHead(200);
      response.end();
    });
    try {
      const { client } = clientFor();

      const response = await client.send(GET(server.port));

      // Present, redacted like any name not on the allowlist, and not a
      // prototype: the object still behaves as a record of headers.
      expect(Object.keys(response.headers)).toContain("__proto__");
      // biome-ignore lint/suspicious/noProto: the literal key is the subject of the test — that this name is carried as data, not as a prototype
      expect(response.headers["__proto__"]).toBe("[REDACTED]");
      expect(response.headers["content-type"]).toBe("application/json");
    } finally {
      await server.close();
    }
  });

  it("strips the query and the fragment from location: an OAuth token arrives there", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302, {
        location: "https://sso.example.test/cb#access_token=ya29.LEAKED_OAUTH_TOKEN&state=1",
      });
      response.end();
    });
    try {
      const { client } = clientFor();

      const response = await client.send(GET(server.port));

      expect(JSON.stringify(response)).not.toContain("ya29.LEAKED_OAUTH_TOKEN");
      // The destination address is kept — it shows where the redirect leads.
      expect(response.headers["location"]).toContain("sso.example.test/cb");
    } finally {
      await server.close();
    }
  });
});

describe("redirects", () => {
  it("does not follow a 3xx: that would take the request outside the allowlist", async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    const source = await startServer((_request, response) => {
      response.writeHead(302, { location: `http://localhost:${target.port}/secret` });
      response.end();
    });
    try {
      const { client } = clientFor();

      const response = await client.send(GET(source.port));

      expect(response.status).toBe(302);
      // The host localhost is not in the allowlist — and no request went to it.
      expect(target.paths).toEqual([]);
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe("retries and backoff", () => {
  it("retries a 429 and obeys Retry-After instead of its own formula", async () => {
    let calls = 0;
    const server = await startServer((_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(429, { "retry-after": "7" }).end();
        return;
      }
      response.writeHead(200).end();
    });
    try {
      const { client, clock } = clientFor();

      const response = await client.send(GET(server.port));

      expect(response.status).toBe(200);
      expect(calls).toBe(2);
      expect(clock.sleeps).toEqual([7000]);
    } finally {
      await server.close();
    }
  });

  // Found by adversarial review: setTimeout clamps values above 2^31-1 ms down
  // to a single millisecond, so a huge Retry-After removed the wait entirely —
  // three attempts went through in a few milliseconds.
  it("does not let the server cancel the wait with a huge Retry-After", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(429, { "retry-after": "2147484" }).end();
    });
    try {
      const { client, clock } = clientFor({
        retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 30_000 },
        breaker: { consecutiveFailures: 99 },
      });

      await client.send(GET(server.port));

      expect(clock.sleeps).toEqual([30_000]);
    } finally {
      await server.close();
    }
  });

  it("grows the pause exponentially when the server says nothing about timing", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(503).end();
    });
    try {
      const { client, clock } = clientFor({
        retry: { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 30_000 },
        breaker: { consecutiveFailures: 99 },
      });

      const response = await client.send(GET(server.port));

      // The last attempt returns the response as-is — the outcome must not be
      // invented.
      expect(response.status).toBe(503);
      // Full jitter with random=0.5: 400*0.5, then 800*0.5.
      expect(clock.sleeps).toEqual([200, 400]);
    } finally {
      await server.close();
    }
  });

  it("retries neither a success nor a 403", async () => {
    let calls = 0;
    const server = await startServer((_request, response) => {
      calls += 1;
      response.writeHead(403).end();
    });
    try {
      const { client, clock } = clientFor();

      const response = await client.send(GET(server.port));

      expect(response.status).toBe(403);
      expect(calls).toBe(1);
      expect(clock.sleeps).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("a network failure", () => {
  it("retries and reports the failure instead of producing a result", async () => {
    // Raise the server and shut it down at once to get a port known to be closed.
    const server = await startServer((_request, response) => {
      response.writeHead(200).end();
    });
    const closedPort = server.port;
    await server.close();

    const { client, clock } = clientFor({
      retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
      breaker: { consecutiveFailures: 99 },
    });

    await expect(client.send(GET(closedPort))).rejects.toThrow(RequestFailedError);
    // Two pauses between three attempts.
    expect(clock.sleeps).toEqual([50, 100]);
  });
});

describe("the address inside an error message", () => {
  /**
   * The text of a failure lands in `failures[].reason`, that is, in the JSON
   * report. A full URL used to drag query parameters — `?api_key=…` — and
   * credentials from userinfo in there.
   *
   * The audit of 14 August found the redaction covered by nothing: making
   * `safeUrl` return the address unchanged left all 574 tests green (A-4). Two
   * checks, because they fail apart: the secret is gone, and the part that makes
   * the message useful — which endpoint failed — is still there.
   */
  it("keeps the path and drops the query and the credentials", async () => {
    const server = await startServer((_request, response) => {
      response.destroy();
    });
    try {
      const { client } = clientFor();
      const url = `http://alice:hunter2@127.0.0.1:${server.port}/v1/orders?api_key=SECRET-KEY`;

      const failure = await client
        .send({ method: "GET", url, headers: safeHeaders([]) })
        .then(() => undefined)
        .catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(RequestFailedError);
      const message = failure instanceof Error ? failure.message : "";
      expect(message).not.toContain("SECRET-KEY");
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("alice");
      // Still says which endpoint failed, or the redaction has cost more than
      // it saved.
      expect(message).toContain("/v1/orders");
      expect(message).toContain("?[REDACTED]");
    } finally {
      await server.close();
    }
  });
});

describe("circuit breaker", () => {
  it("stops the run after a series of failures and goes to the network no more", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(500).end();
    });
    try {
      const { client } = clientFor({
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
        breaker: { consecutiveFailures: 3 },
      });

      // Two failed requests do not cross the threshold.
      await expect(client.send(GET(server.port, "/a"))).resolves.toMatchObject({ status: 500 });
      await expect(client.send(GET(server.port, "/b"))).resolves.toMatchObject({ status: 500 });
      // The third one does.
      await expect(client.send(GET(server.port, "/c"))).rejects.toThrow(CircuitOpenError);
      const afterOpen = server.paths.length;

      // The next request is cut off before the network.
      await expect(client.send(GET(server.port, "/another"))).rejects.toThrow(CircuitOpenError);
      expect(server.paths.length).toBe(afterOpen);
    } finally {
      await server.close();
    }
  });

  // Found by adversarial review: the counter grew on every ATTEMPT, so with the
  // defaults (3 attempts, threshold 5) the run stalled after two requests.
  it("counts failed requests, not its own attempts to retry them", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(503).end();
    });
    try {
      const { client } = clientFor({
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
        breaker: { consecutiveFailures: 5 },
      });

      // Four requests of three attempts each is twelve attempts, but only four
      // failures, and the threshold of five is not reached yet.
      for (let i = 0; i < 4; i += 1) {
        await expect(client.send(GET(server.port, `/x${i}`))).resolves.toMatchObject({
          status: 503,
        });
      }

      await expect(client.send(GET(server.port, "/x4"))).rejects.toThrow(CircuitOpenError);
    } finally {
      await server.close();
    }
  });

  it("resets the counter after a successful response", async () => {
    let calls = 0;
    const server = await startServer((_request, response) => {
      calls += 1;
      response.writeHead(calls % 2 === 1 ? 500 : 200).end();
    });
    try {
      const { client } = clientFor({
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
        breaker: { consecutiveFailures: 3 },
      });

      for (let i = 0; i < 3; i += 1) {
        await expect(client.send(GET(server.port))).resolves.toMatchObject({ status: 200 });
      }
    } finally {
      await server.close();
    }
  });
});

describe("parseRetryAfter", () => {
  it("understands seconds", () => {
    expect(parseRetryAfter("12", 0)).toBe(12_000);
    expect(parseRetryAfter(" 0 ", 0)).toBe(0);
    expect(parseRetryAfter("-5", 0)).toBe(0);
  });

  it("understands an HTTP date", () => {
    const now = Date.parse("2026-08-12T10:00:00Z");
    expect(parseRetryAfter("Wed, 12 Aug 2026 10:00:30 GMT", now)).toBe(30_000);
    // A date in the past gives no negative pause.
    expect(parseRetryAfter("Wed, 12 Aug 2026 09:00:00 GMT", now)).toBe(0);
  });

  it("returns undefined on junk and on a missing header", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("", 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
  });
});

/**
 * Transport invariants that were held by a comment rather than by a test.
 *
 * The audit of 20 August 2026 took four promises this repository makes about
 * what goes on the wire and what comes back off it, removed the code that keeps
 * each one, and ran the suite. All of it stayed green. A guarantee nothing goes
 * red for is a guarantee that survives exactly as long as whoever edits the file
 * next happens to read the comment above the line.
 *
 * Every test here is written against a named mutation and was watched failing
 * under it. The mutation is spelled out beside the test, so that the next reader
 * can repeat the experiment rather than take this header's word for it.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../../src/adapters/credentials.js";
import {
  createHttpClient,
  RUN_IDENTITY_HEADER,
  RunIdentityConflictError,
  runIdentity,
} from "../../src/adapters/http.js";
import type { HttpClient, HttpRequest } from "../../src/adapters/ports.js";
import { createThrottle } from "../../src/adapters/throttle.js";
import type { Account } from "../../src/core/index.js";
import { isAddressablePath, safeHeaders } from "../../src/io/untrusted.js";
import { collectObservations, staysWithinTarget } from "../../src/runner.js";
import { createTestClock } from "../fixtures/clock.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * A-4 · the sliding rate window.
 *
 * Mutation: `await awaitRateWindow()` in `admit()` replaced with
 * `await Promise.resolve()` (`src/adapters/throttle.ts`, in `admit`).
 *
 * Why nothing caught it. Two limiters share `admit`: the sliding window, which
 * is the declared `requestsPerSecond`, and the pacing added by I-8, which
 * decides *when* inside the window. Every rate test in the suite runs at 3, 4 or
 * 5 requests a second — and there the pacing alone spreads the starts far enough
 * that the window never has to say anything. Above 500 a second `paced` switches
 * itself off on purpose (a gap under 2 ms is a lie on a millisecond clock), and
 * from there the window is the only bound in the code. That range had one test,
 * and it asserts the pacing is off rather than that the window still holds.
 *
 * Measured by the audit on a virtual clock at `--rps 5000`: 4999 admissions in
 * the first second out of 20000 before the mutation, 20000 after it.
 *
 * The clock is the repository's `createTestClock` and not real time: pauses are
 * facts to be read off the clock, and a test that waits a real second to learn
 * one is both slower and less exact.
 */
describe("A-4 · the sliding rate window", () => {
  const RPS = 1000;

  it("bounds the first second where the pacing has switched itself off", async () => {
    const clock = createTestClock();
    const throttle = createThrottle(
      // Above 500 a second, so `paced` is false and the window is alone. Below
      // that the pacing would satisfy this test on its own, and the gate would
      // be watching the wrong limiter.
      { concurrency: 8, requestsPerSecond: RPS, maxRequests: RPS * 2 },
      clock,
    );

    const starts: number[] = [];
    // One at a time, so nothing else moves the shared clock between a start
    // being granted and the task reading it.
    for (let i = 0; i < RPS + 500; i += 1) {
      await throttle.run(() => {
        starts.push(clock.now());
        return Promise.resolve();
      });
    }

    // The pacing really is off: the whole first window is admitted at once, and
    // no gap between those starts can be what bounds them.
    expect(starts.slice(0, RPS).every((at) => at === 0)).toBe(true);
    // The declared limit, which is the whole of the promise.
    expect(starts.filter((at) => at < 1000).length).toBeLessThanOrEqual(RPS);
    // 1500 at a thousand a second cannot be over inside one. Without the window
    // the clock never moves at all.
    expect(clock.now()).toBeGreaterThanOrEqual(1000);
  });
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  readonly port: number;
  close(): Promise<void>;
}

/** A stub on a port the operating system picks; 8787 stays free. */
async function startServer(handler: Handler): Promise<TestServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not start the test server");
  }
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    port: address.port,
    close: () =>
      new Promise<void>((done, fail) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => (error ? fail(error) : done()));
      }),
  };
}

function clientFor(overrides: Record<string, unknown> = {}) {
  const clock = createTestClock();
  return createHttpClient({
    allowedHosts: ["127.0.0.1"],
    throttle: createThrottle({ concurrency: 4, requestsPerSecond: 1000, maxRequests: 100 }, clock),
    clock,
    random: () => 0.5,
    ...overrides,
  });
}

const GET = (port: number, path = "/") =>
  ({ method: "GET", url: `http://127.0.0.1:${port}${path}`, headers: {} }) as const;

/**
 * A-5 · the response stream is cancelled unread.
 *
 * Mutation: `await response.body?.cancel()` replaced with `await response.text()`
 * (`src/adapters/http.ts`, in `attemptOnce`).
 *
 * Why nothing caught it. The suite asks the right question of the wrong object:
 * `returns no body in any form` serializes the `HttpResponse` and looks for the
 * canary in it. Nothing is stored either way — `toHttpResponse` was built before
 * that line and never sees the body — so the assertion holds under the mutation
 * and the promise in CLAUDE.md stops being true in silence. What changes is that
 * every byte of somebody else's production data is pulled into this process's
 * memory on every cell of the run.
 *
 * The check has to be on the reading, and the only witness to a read is the
 * server. So the stub answers with headers and then never finishes the body: a
 * client that cancels the stream has its status the moment the headers land, and
 * a client that reads waits for an end that is not coming until its own timeout
 * gives up. The timeout is what turns "read" into a failed request, which is why
 * it is set low here and why one attempt is enough.
 */
describe("A-5 · the response body is cancelled, not read", () => {
  it("has a verdict from a response whose body never ends", async () => {
    let asked = false;
    const server = await startServer((_request, response) => {
      asked = true;
      response.writeHead(200, { "content-type": "application/json" });
      // Headers and an opening brace, and then nothing, ever. There is no
      // `end()` on purpose: the body is a well the client must not drink from.
      response.write('{"email":"pii-canary-a5",');
    });
    try {
      const client = clientFor({
        // Small, because the mutation is proved by a wait that never resolves,
        // and one attempt because retrying an unfinished body only waits again.
        timeoutMs: 250,
        retry: { maxAttempts: 1 },
      });

      const response = await client.send(GET(server.port, "/x"));

      expect(asked).toBe(true);
      // Under the mutation this line is never reached: `response.text()` waits
      // for the end of a body the server is not going to end, the request dies
      // on its own timeout and `send` throws `RequestFailedError` instead.
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/json");
    } finally {
      await server.close();
    }
  });

  /**
   * The same promise from the other side, and the reason there are two tests.
   *
   * The one above proves the client does not **wait** for the body, which is
   * what the named mutation does. It says nothing about a `cancel()` deleted and
   * replaced with nothing: that client does not wait either, and it leaves the
   * connection hanging on somebody else's deployment for every cell of the run.
   *
   * A stream this test owns answers both at once, with no clock in it: `cancel`
   * is the only way it is let go, and `pull` is the only way a byte leaves it.
   * No socket is opened here — `fetch` itself is the stub, which is the only
   * place a `ReadableStream` of our own can be handed to the client.
   *
   * The pull count is asserted as "not drained" rather than as zero, and the
   * difference was measured rather than assumed. `new Response(stream)` wraps
   * the stream, and the wrapper takes one speculative read of its own before the
   * client ever touches `response.body` — so zero is not the honest number for a
   * client that behaves. Reading the body to its end takes all of them, which is
   * the thing being ruled out.
   */
  it("cancels the stream instead of draining it", async () => {
    const CHUNKS = 8;
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('{"email":"pii-canary-a5"}'));
        if (pulled >= CHUNKS) {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetching = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    try {
      const client = clientFor();

      // The port is never dialled: the allowlist still reads the URL, and
      // nothing past that reaches the network.
      const response = await client.send(GET(9, "/x"));

      expect(response.status).toBe(200);
      // Let go of rather than read: this is the assertion a deleted `cancel()`
      // fails as surely as a `response.text()` does.
      expect(cancelled).toBe(true);
      // And let go of early. A client that reads takes every chunk.
      expect(pulled).toBeLessThan(CHUNKS);
    } finally {
      fetching.mockRestore();
    }
  });
});

/**
 * A-6 · the composition of the response-header value allowlist.
 *
 * Mutation: `x-api-key` added to `VALUE_PRESERVED_HEADERS`
 * (`src/adapters/http.ts`).
 *
 * Why nothing caught it. The existing test names five secrets it wants redacted
 * and finds them redacted; a sixth name added to the constant is outside the
 * question it asks. The audit added `x-api-key` and watched 963 tests stay
 * green — a header whose entire purpose is to carry a credential, walking into
 * the JSON report with its value intact, against no resistance at all.
 *
 * **Why the exact composition and not a sample.** ADR-0005's addendum forbids a
 * denylist here for a structural reason: the names that will ever carry a secret
 * cannot be enumerated, so the list has to be of what is *kept*. A test that
 * samples the list inherits the flaw the list was rewritten to escape — it can
 * only catch the additions somebody thought to write down. Pinning the whole set
 * is what makes the sixteenth entry a decision rather than an edit, and the cost
 * of getting it wrong is a secret in a file the operator is about to attach to a
 * ticket.
 *
 * Read out of the source because the constant is deliberately not exported and
 * this file does not get to change that. The behavioural test below is what ties
 * the text back to what the client actually does with it.
 */
describe("A-6 · the response-header value allowlist", () => {
  /**
   * The set, spelled out. Growing it is a change to this array and to the ADR,
   * in that order — never to the constant alone.
   */
  const ALLOWED = [
    "allow",
    "cache-control",
    "connection",
    "content-length",
    "content-type",
    "date",
    "keep-alive",
    "retry-after",
    "traceparent",
    "transfer-encoding",
    "www-authenticate",
    "x-amzn-trace-id",
    "x-correlation-id",
    "x-request-id",
    "x-trace-id",
  ];

  it("keeps exactly the names written down here and no others", () => {
    const source = readFileSync(resolve(ROOT, "src/adapters/http.ts"), "utf8");
    const block = /const VALUE_PRESERVED_HEADERS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
    // A guard on the guard: a renamed constant must not read as an empty list.
    expect(block).not.toBeNull();

    const entries = (block?.[1] ?? "")
      .split("\n")
      // The reasoning for each name lives in `//` comments between the entries,
      // and one of them quotes the word "redacted". A comment is prose, not a
      // member of the set.
      .filter((line) => !line.trim().startsWith("//"));
    const declared = [...entries.join("\n").matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();

    expect(declared).toEqual([...ALLOWED].sort());
  });

  it("redacts x-api-key, whose whole purpose is to carry a credential", async () => {
    // Named for what it is, and shaped so that it is not mistaken for the
    // thing it stands in for: `const secret = "…"` on one line is what the
    // gitleaks `generic-api-key` rule reads, and the pre-commit hook stopped
    // the first draft of this test. A canary is not worth an allowlist entry.
    const canary = "this-value-must-not-reach-the-report";
    const server = await startServer((_request, response) => {
      response.setHeader("x-api-key", canary);
      response.setHeader("content-type", "application/json");
      response.writeHead(200);
      response.end();
    });
    try {
      const client = clientFor();

      const response = await client.send(GET(server.port, "/x"));

      // The name survives — that a platform sent this header is a signal — and
      // the value does not.
      expect(Object.keys(response.headers)).toContain("x-api-key");
      expect(response.headers["x-api-key"]).toBe("[REDACTED]");
      expect(JSON.stringify(response)).not.toContain(canary);
    } finally {
      await server.close();
    }
  });
});

/**
 * A-8 · `joinUrl` compares the origin and the path prefix.
 *
 * Mutation: the whole condition
 * `resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)`
 * removed from `joinUrl` (`src/runner/address.ts`), together with the throw it
 * guards.
 *
 * Why nothing caught it, and it is worth being precise about. There are already
 * tests named for exactly this — `rejects an absolute address with a different
 * scheme and port`, `rejects an absolute address pointing at another host` — and
 * every one of them stays green with the comparison gone. The reason is the
 * order of the two guards inside `joinUrl`: `isAddressablePath` runs first, and
 * `http://api.example.test:9999/exfil` is refused there, by `isAddress`, before
 * the origin is ever computed. Those tests pin the grammar. Nothing pinned the
 * comparison, and the comment above it — about a `..` in a resource value
 * leading to a neighbouring API — describes a case the grammar now refuses too.
 *
 * So the gate needs a path the grammar admits and the comparison must not. A
 * **leading space** is one: `isAddress` asks whether the string starts with a
 * scheme, and a space is not one; `carriesNothingAddressable` refuses the C0
 * range, and the space is 0x20, one above it. The URL parser, meanwhile, strips
 * leading spaces before it reads anything — so ` https://host/x` is not an
 * address to this grammar and is an absolute address to `new URL`. That is the
 * same class of gap ADR-0032 was written about, one character over: the parser
 * and the guard disagree about what the string is.
 *
 * Two forms, one per half of the condition, so that neither half can be dropped
 * on its own:
 *
 *  - same host, **different port**, path still under the declared prefix. Only
 *    the origin half fires. This is the dangerous one: `assertRequestAllowed`
 *    matches an allowlist entry written without a port against the hostname
 *    alone — deliberately, so that a scope can be narrowed later — so the client
 *    would carry the account's token to whatever port the document names.
 *  - **same origin exactly**, path above the declared prefix. Only the prefix
 *    half fires. A base URL of `https://api.example.test/v1` is a statement
 *    about which API is under test, and `/admin` on the same host is a
 *    neighbouring one that was never declared.
 */
describe("A-8 · the origin and the path prefix in joinUrl", () => {
  const BASE = "https://api.example.test/v1";
  /** Same host, another port: the origin half of the condition, alone. */
  const ANOTHER_PORT = " https://api.example.test:9999/v1/users";
  /** Same origin, out of the declared prefix: the prefix half, alone. */
  const ABOVE_PREFIX = " https://api.example.test/admin";

  it("hands both forms to the comparison rather than stopping at the grammar", () => {
    // The point of the leading space, asserted rather than described: if either
    // of these ever becomes false the tests below stop proving anything, because
    // `isAddressablePath` would be refusing the path first and the comparison
    // would never run.
    expect(isAddressablePath(ANOTHER_PORT)).toBe(true);
    expect(isAddressablePath(ABOVE_PREFIX)).toBe(true);
  });

  it("refuses a path that keeps the host and changes the port", () => {
    expect(staysWithinTarget(BASE, ANOTHER_PORT)).toBe(false);
  });

  it("refuses a path that keeps the origin and leaves the declared prefix", () => {
    expect(staysWithinTarget(BASE, ABOVE_PREFIX)).toBe(false);
  });

  it("an ordinary path under the prefix is still assembled", () => {
    // The other side of the gate: a comparison that refused everything would
    // pass the two tests above and break the tool.
    expect(staysWithinTarget(BASE, "/users")).toBe(true);
  });

  /**
   * The consequence, end to end.
   *
   * `staysWithinTarget` above is the unit; this is what it is for. An endpoint
   * carrying either form must be skipped as `escapes-target` and no request must
   * leave along it — with the comparison gone, the account's credentials go to
   * port 9999 and to `/admin`, and the report records the answers as if they had
   * come from the endpoint the run declared.
   */
  it("sends nothing along either of them", async () => {
    const accounts: readonly Account[] = [{ id: "a", roleId: "r", tenantId: "t" }];
    const credentials = createCredentialProvider(DEFAULT_AUTH_SCHEME, new Map([["a", "token"]]));
    const seen: HttpRequest[] = [];
    const client: HttpClient = {
      send(request) {
        seen.push(request);
        return Promise.resolve({ status: 200, headers: {} });
      },
    };

    const result = await collectObservations({
      baseUrl: BASE,
      endpoints: [
        { id: "port", method: "GET", path: ANOTHER_PORT },
        { id: "above", method: "GET", path: ABOVE_PREFIX },
      ],
      accounts,
      credentials,
      client,
    });

    expect(seen).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(result.skipped).toEqual([
      { endpointId: "port", reason: "escapes-target" },
      { endpointId: "above", reason: "escapes-target" },
    ]);
  });
});

/**
 * M-6 · the run says who it is on the wire.
 *
 * Mutation: the merge in `attemptOnce` (`src/adapters/http.ts`) put back to the
 * plain `headers: { ...request.headers }` it was before — not a hypothetical
 * edit but the state the finding was written from. `grep -ri "user-agent" src/`
 * answered nothing, so every request this tool had ever made went out as
 * `user-agent: node`, and the `runId` the report is filed under existed only
 * inside the report.
 *
 * Why nothing caught it. The suite asserts what the tool *refuses* to send —
 * credentials in a query key, a method override, an address outside the scope —
 * and never what it must send. Nothing in the repository read a request header
 * off a real server: `tests/adapters/http.test.ts` drives a stubbed `fetch`, and
 * a stub is handed whatever the client passes without anyone asking what an
 * access log would have recorded.
 *
 * The consequence is not on this side. An owner who gave written permission had
 * no way to tell a consented audit from the intrusion it is shaped like — not in
 * a SIEM, not in an availability graph, not in an anti-fraud rule. The report
 * keeps `x-request-id` off the *response* for exactly this purpose, so
 * correlation was already agreed to be worth having; it was provided in one
 * direction only.
 *
 * The server here is real and the assertions are on what it received. A test
 * reading the client's own `HttpRequest` back would agree with a merge that
 * never happened.
 */
describe("M-6 · the run names itself on the wire", () => {
  const RUN = "11111111-2222-3333-4444-555555555555";
  const IDENTITY = runIdentity({
    version: "9.9.9",
    runId: RUN,
    homepage: "https://github.com/Tarnellion/barbican",
  });

  /** A deployment that keeps what it was told, the only witness that counts here. */
  async function startListener() {
    const heard: (string | undefined)[] = [];
    const server = await startServer((request, response) => {
      heard.push(request.headers["user-agent"]);
      response.writeHead(204).end();
    });
    return { ...server, heard };
  }

  it("carries the version and the run identifier the report is filed under", async () => {
    const server = await startListener();
    try {
      await clientFor({ identity: IDENTITY }).send(GET(server.port, "/v1/orders"));

      const [agent] = server.heard;
      expect(agent).toBeDefined();
      // The three things the owner of the target needs off one log line: what
      // this is, which release of it, and which run — the last being the handle
      // that ties their records to the JSON they were handed.
      expect(agent).toContain("barbican/9.9.9");
      expect(agent).toContain(`run=${RUN}`);
      expect(agent).toContain("https://github.com/Tarnellion/barbican");
      // And node's own default is replaced rather than appended to.
      expect(agent).not.toContain("node");
    } finally {
      await server.close();
    }
  });

  it("says nothing at all when the caller declares no identity", async () => {
    const server = await startListener();
    try {
      await clientFor().send(GET(server.port, "/v1/orders"));

      // The other half of the gate. A client that always signed would pass the
      // test above and take `--no-identify` away from the operator who is
      // deliberately measuring what an unannounced sweep looks like.
      expect(server.heard).toEqual(["node"]);
    } finally {
      await server.close();
    }
  });

  /**
   * And it does not overwrite the caller's own header in silence.
   *
   * `user-agent` is a header a set of request conditions may legitimately
   * declare — a device condition is exactly that shape — and two values under
   * one name is a request neither side asked for: `Headers` folds them into
   * `"mobile-app/3, barbican/9.9.9 …"`. Refused at the seam, before the wire,
   * because the client is the one place every request of a run passes through —
   * the CLI, `probeCanaries` and a consumer of the library alike.
   */
  it("refuses a request that already carries the header, and sends nothing", async () => {
    const server = await startListener();
    try {
      const client = clientFor({ identity: IDENTITY });

      await expect(
        client.send({
          ...GET(server.port, "/v1/orders"),
          // Spelled in another case, because header names are case-insensitive
          // and a comparison that is not would let this one through to be folded
          // together on the wire.
          headers: safeHeaders([["User-Agent", "mobile-app/3"]]),
        }),
      ).rejects.toBeInstanceOf(RunIdentityConflictError);

      expect(server.heard).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("names one header, and it is the one an access log already keeps", () => {
    // A custom `x-barbican-run` is invisible in nginx's `combined` format and in
    // most SIEM pipelines without a change on the target's side — a change the
    // party this whole feature exists for would have to make first.
    expect(RUN_IDENTITY_HEADER).toBe("user-agent");
  });
});

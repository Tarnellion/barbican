/**
 * Tests for signals over the response body.
 *
 * The main one is not about computation but about the body going nowhere.
 * ADR-0011 allowed reading the body; the price of that permission is that the
 * ban on PII in the report now rests on the type of a signal value, and that
 * has to be proven.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../../src/adapters/http.js";
import type { SignalSpec } from "../../src/adapters/ports.js";
import {
  createSignalExtractor,
  InvalidSignalSpecError,
  parseSignalPath,
} from "../../src/adapters/signals.js";
import { createThrottle } from "../../src/adapters/throttle.js";
import { createTestClock } from "../fixtures/clock.js";

const SALT = new Uint8Array([1, 2, 3, 4]);

function streamOf(text: string): ReadableStream<Uint8Array> {
  const body = new Response(text).body;
  if (body === null) {
    throw new Error("the test stream was not created");
  }
  return body;
}

const DIGEST: readonly SignalSpec[] = [{ name: "digest", kind: "digest" }];

async function digestOf(text: string, salt = SALT): Promise<number | boolean | undefined> {
  const extractor = createSignalExtractor({ salt });
  const signals = await extractor.extract(streamOf(text), DIGEST);
  return signals["digest"];
}

describe("a body nobody declared a signal over", () => {
  /**
   * The stream is cancelled, not left open and not read.
   *
   * This is the default path — no `bodySignals`, no reading — and nothing
   * covered it: removing the `cancel()` left the whole suite green. An
   * uncancelled response body holds the connection until the socket times out,
   * and at a few thousand cells that is the run stalling on somebody else's
   * deployment. Found by the audit of 14 August (A-5).
   */
  it("cancels the stream instead of leaving it open", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"orders":[1,2,3]}'));
      },
      cancel() {
        cancelled = true;
      },
    });

    const signals = await createSignalExtractor({ salt: SALT }).extract(body, []);

    expect(cancelled).toBe(true);
    expect(signals).toEqual({});
    // And nothing was read out of it on the way.
    expect(body.locked).toBe(false);
  });
});

describe("parseSignalPath", () => {
  it("splits segments on dots; an empty path is the root", () => {
    expect(parseSignalPath("")).toEqual([]);
    expect(parseSignalPath("data.items")).toEqual(["data", "items"]);
  });

  it("rejects an empty segment", () => {
    expect(() => parseSignalPath("data..items")).toThrow(InvalidSignalSpecError);
  });
});

describe("the digest", () => {
  it("matches for identical bodies and differs for different ones", async () => {
    const left = await digestOf('{"orders":[1,2]}');
    const right = await digestOf('{"orders":[1,2]}');
    const other = await digestOf('{"orders":[1,3]}');

    expect(left).toBe(right);
    expect(left).not.toBe(other);
  });

  it("fits in a safe integer", async () => {
    const value = await digestOf('{"orders":[1,2]}');

    expect(typeof value).toBe("number");
    expect(Number.isSafeInteger(value)).toBe(true);
  });

  /**
   * Found by the audit of 14 August. A declared signal sharing the digest's name
   * used to overwrite it — the specs are written in order, and the implied
   * digest goes first. With `kind: present` the value became `true`, `digestOf`
   * in the check returned `undefined`, and the observation dropped out of the
   * comparison entirely: eighteen cross-tenant findings became zero while the
   * report went on saying the check had run.
   *
   * A configuration cannot reach this any more — the name is refused at parsing
   * (`ReservedSignalNameError`). This is the same guarantee for the library,
   * where the specs are assembled by hand: a declared scalar may be lost, and
   * that shows in the report; the digest may not, because losing it is silent.
   */
  it("survives a declared signal that shares its name", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const shadowing: readonly SignalSpec[] = [
      { name: "digest", kind: "digest" },
      { name: "digest", kind: "present", path: "orders" },
    ];

    const signals = await extractor.extract(streamOf('{"orders":[1,2]}'), shadowing);

    expect(typeof signals["digest"]).toBe("number");
    expect(signals["digest"]).toBe(await digestOf('{"orders":[1,2]}'));
  });

  // The other order of declaration must not change the answer either.
  it("survives it whichever way round the specs are given", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const shadowing: readonly SignalSpec[] = [
      { name: "digest", kind: "count", path: "orders" },
      { name: "digest", kind: "digest" },
    ];

    const signals = await extractor.extract(streamOf('{"orders":[1,2]}'), shadowing);

    expect(signals["digest"]).toBe(await digestOf('{"orders":[1,2]}'));
  });

  /**
   * The salt is not decoration. Without it the digest of a predictable body can
   * be brute-forced, and the report starts confirming guesses about the content.
   */
  it("depends on the salt: the same body gives different values in different runs", async () => {
    const first = await digestOf('{"error":"forbidden"}', new Uint8Array([9, 9]));
    const second = await digestOf('{"error":"forbidden"}', new Uint8Array([7, 7]));

    expect(first).not.toBe(second);
  });

  /**
   * This checks the **default**, not a salt that was passed in: the tests above
   * supply the salt explicitly and so would not notice if the default became a
   * constant. The mutation "the default salt is empty" passed all of them.
   */
  it("salts randomly by default, so a digest does not carry between runs", async () => {
    const body = '{"error":"forbidden"}';
    const first = await createSignalExtractor().extract(streamOf(body), DIGEST);
    const second = await createSignalExtractor().extract(streamOf(body), DIGEST);

    expect(typeof first["digest"]).toBe("number");
    expect(first["digest"]).not.toBe(second["digest"]);
  });

  it("is computed for a body that is not JSON too", async () => {
    const value = await digestOf("not json at all");

    expect(typeof value).toBe("number");
  });
});

/**
 * A digest over the part of the body a human named.
 *
 * The digest over raw bytes is switched off by the envelope real list endpoints
 * come wrapped in. Two responses carrying the records of **both** tenants — a
 * complete leak — differ by one `requestId` and the digests differ with them:
 * zero findings, and `comparedPairs` counted the pair as compared and honestly
 * different. `requestId`, `serverTime`, `generatedAt`, a pagination cursor, an
 * echoed ETag: every one of them disables the single check the "bodies are not
 * read" invariant was relaxed for.
 *
 * The path is declared, never derived — the same rule as everything else in this
 * model (ADR-0006). See ADR-0044.
 */
describe("a digest over a declared subtree", () => {
  const scoped: readonly SignalSpec[] = [{ name: "digest", kind: "digest", path: "data" }];

  async function scopedDigestOf(
    text: string,
    specs: readonly SignalSpec[] = scoped,
  ): Promise<Readonly<Record<string, number | boolean>>> {
    return createSignalExtractor({ salt: SALT }).extract(streamOf(text), specs);
  }

  /** M-2, the blindness this exists to remove. */
  it("ignores an envelope field that changes on every request", async () => {
    const left = await scopedDigestOf('{"requestId":"r-1","data":{"orders":[1,2]}}');
    const right = await scopedDigestOf('{"requestId":"r-2","data":{"orders":[1,2]}}');

    expect(typeof left["digest"]).toBe("number");
    expect(left["digest"]).toBe(right["digest"]);
  });

  /** And still answers the question it was asked: the subtree itself decides. */
  it("differs when the declared subtree differs", async () => {
    const left = await scopedDigestOf('{"requestId":"r-1","data":{"orders":[1,2]}}');
    const right = await scopedDigestOf('{"requestId":"r-1","data":{"orders":[3,4]}}');

    expect(left["digest"]).not.toBe(right["digest"]);
  });

  /**
   * Key order is not a difference. A digest over raw bytes says two responses
   * differ when a platform serialises the same record's fields in another order,
   * which is the same blindness in a subtler form. Array order is kept: the order
   * of records is data, and a tool that sorted it would answer a question nobody
   * asked. See ADR-0044.
   */
  it("does not depend on the order of object keys", async () => {
    const left = await scopedDigestOf('{"data":{"a":1,"b":2}}');
    const right = await scopedDigestOf('{"data":{"b":2,"a":1}}');

    expect(left["digest"]).toBe(right["digest"]);
  });

  it("does depend on the order of array elements", async () => {
    const left = await scopedDigestOf('{"data":[1,2]}');
    const right = await scopedDigestOf('{"data":[2,1]}');

    expect(left["digest"]).not.toBe(right["digest"]);
  });

  /**
   * The half that keeps a declaration from failing open.
   *
   * The runner prepends the whole-body digest implied by
   * `responseMustDifferByTenant` and appends what the endpoint declared, so both
   * arrive under the name `digest`. If the scoped one cannot be computed and the
   * unscoped value were left standing, the check would go on comparing whole
   * bodies while the configuration said otherwise — a wrong comparison, in
   * silence, which is the failure this repository keeps finding. There is no
   * digest instead, and a flag saying which silence it is.
   */
  it("yields no digest at all when the declared path is absent", async () => {
    const signals = await scopedDigestOf('{"requestId":"r-1","payload":{"orders":[1]}}');

    expect(signals).not.toHaveProperty("digest");
    expect(signals["digestScopeMissing"]).toBe(true);
  });

  it("yields no digest when the body is not JSON", async () => {
    const signals = await scopedDigestOf("not json at all");

    expect(signals).not.toHaveProperty("digest");
    expect(signals["digestScopeMissing"]).toBe(true);
  });

  /**
   * The bound is on the tool's own recursion and not on the engine's stack: a
   * body that gave a digest on one machine and none on another would make a
   * report unreproducible, which ADR-0036 exists to prevent.
   */
  it("yields no digest for a subtree nested deeper than the tool will walk", async () => {
    const deep = `{"data":${"[".repeat(200)}1${"]".repeat(200)}}`;

    const signals = await scopedDigestOf(deep);

    expect(signals).not.toHaveProperty("digest");
    expect(signals["digestScopeMissing"]).toBe(true);
  });

  /** And says nothing when there was nothing to say. */
  it("does not flag a subtree it found", async () => {
    const signals = await scopedDigestOf('{"data":{"orders":[1]}}');

    expect(signals).not.toHaveProperty("digestScopeMissing");
  });

  /**
   * The contract `applyBodySignals` relies on: the runner's implied whole-body
   * digest arrives first, the endpoint's declared one after it, and the declared
   * scope must replace the default rather than sit beside it under one name.
   */
  it("replaces the implied whole-body digest the runner puts first", async () => {
    const both: readonly SignalSpec[] = [{ name: "digest", kind: "digest" }, ...scoped];

    const left = await scopedDigestOf('{"requestId":"r-1","data":{"orders":[1,2]}}', both);
    const right = await scopedDigestOf('{"requestId":"r-2","data":{"orders":[1,2]}}', both);

    expect(typeof left["digest"]).toBe("number");
    expect(left["digest"]).toBe(right["digest"]);
  });

  /** A scoped digest is not the same number as the whole-body one over the same text. */
  it("is not the whole-body digest under another name", async () => {
    const body = '{"data":{"orders":[1,2]}}';

    const value = (await scopedDigestOf(body))["digest"];

    expect(value).not.toBe(await digestOf(body));
  });
});

describe("count and present", () => {
  const specs: readonly SignalSpec[] = [
    { name: "orders", kind: "count", path: "data.orders" },
    { name: "hasNext", kind: "present", path: "next" },
  ];

  it("counts array elements at a path and detects presence", async () => {
    const extractor = createSignalExtractor({ salt: SALT });

    const signals = await extractor.extract(
      streamOf('{"data":{"orders":[1,2,3]},"next":"cursor"}'),
      specs,
    );

    expect(signals["orders"]).toBe(3);
    expect(signals["hasNext"]).toBe(true);
  });

  /**
   * A zero would be a claim of emptiness we never made: the path could point at
   * an object, a number, or nothing at all. The absence of a signal is honest.
   */
  it("produces no count when the path does not hold an array", async () => {
    const extractor = createSignalExtractor({ salt: SALT });

    const signals = await extractor.extract(streamOf('{"data":{"orders":42}}'), specs);

    expect(signals["orders"]).toBeUndefined();
    expect(signals["hasNext"]).toBe(false);
  });

  /**
   * The body comes from someone else's deployment. Without `Object.hasOwn` the
   * path `constructor` would be found through the prototype chain on any object
   * — the same mistake already made in binding resources to endpoints.
   */
  it("does not find inherited properties through the prototype", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const probes: readonly SignalSpec[] = [
      { name: "ctor", kind: "present", path: "constructor" },
      { name: "str", kind: "present", path: "toString" },
    ];

    const signals = await extractor.extract(streamOf('{"orders":[]}'), probes);

    expect(signals["ctor"]).toBe(false);
    expect(signals["str"]).toBe(false);
  });

  /**
   * Found by research into affiliate cabinets: field visibility there is driven
   * by flags on the account, so an extra column does not change the response
   * status — that is BOPLA by construction. There is nothing to check it with
   * until the path can descend into a list.
   *
   * The former behaviour was not merely a gap: `present` answered `false` for a
   * field that IS in the response, and such a signal is indistinguishable from
   * an honest "no".
   */
  it("sees a field inside a list element by numeric index", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const probes: readonly SignalSpec[] = [
      { name: "emailCol", kind: "present", path: "rows.0.email" },
      { name: "phoneCol", kind: "present", path: "rows.0.phone" },
    ];

    const signals = await extractor.extract(
      streamOf('{"rows":[{"id":1,"email":"klient@example.com"}]}'),
      probes,
    );

    expect(signals["emailCol"]).toBe(true);
    expect(signals["phoneCol"]).toBe(false);
  });

  /**
   * Only a run of decimal digits counts as an index.
   *
   * The first version of this test used the segment `email` and checked
   * nothing: `Number("email")` is `NaN`, indexing by `NaN` also gives
   * `undefined`, and the result matched with the check removed. The mutation
   * "index by any segment" passed it. The difference shows only where a string
   * does coerce numerically: `Number("1e0")` is 1, `Number(" 0 ")` is 0.
   */
  it("does not index a list by a segment that merely coerces to a number", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const probes: readonly SignalSpec[] = [
      { name: "sci", kind: "present", path: "rows.1e0.email" },
      { name: "padded", kind: "present", path: "rows. 0 .email" },
      { name: "hex", kind: "present", path: "rows.0x0.email" },
      { name: "word", kind: "present", path: "rows.email" },
    ];

    const signals = await extractor.extract(streamOf('{"rows":[{"email":"a@b.c"}]}'), probes);

    expect(signals["sci"]).toBe(false);
    expect(signals["padded"]).toBe(false);
    expect(signals["hex"]).toBe(false);
    expect(signals["word"]).toBe(false);
  });

  it("past the end of a list there is no signal, not a false presence", async () => {
    const extractor = createSignalExtractor({ salt: SALT });
    const probes: readonly SignalSpec[] = [{ name: "x", kind: "present", path: "rows.7.email" }];

    const signals = await extractor.extract(streamOf('{"rows":[{"email":"a@b.c"}]}'), probes);

    expect(signals["x"]).toBe(false);
  });

  it("produces no path signals when the body does not parse as JSON", async () => {
    const extractor = createSignalExtractor({ salt: SALT });

    const signals = await extractor.extract(
      streamOf("<html>the server returned a page</html>"),
      specs,
    );

    expect(signals["orders"]).toBeUndefined();
    expect(signals["hasNext"]).toBeUndefined();
  });
});

describe("the size ceiling", () => {
  /**
   * A prefix will not do: two responses differing past the cut-off would give
   * the same digest, and the tool would claim a match that does not exist. The
   * absence of a signal beats a wrong one.
   */
  /**
   * Nothing computed, and one flag saying which silence this is.
   *
   * A body over the ceiling yielded an empty set, so the pair was skipped, the
   * comparison quietly became zero, and the report could not tell "no comparison
   * was made" from "the bodies differed" — the two readings this whole check
   * exists to keep apart. Found by the audit of 14 August (D-5).
   */
  it("computes nothing when the body is over the ceiling, and says so", async () => {
    const extractor = createSignalExtractor({ salt: SALT, maxBodyBytes: 16 });

    const signals = await extractor.extract(streamOf("x".repeat(64)), DIGEST);

    expect(signals).toEqual({ bodyOverLimit: true });
    // The digest in particular is absent, not zero or guessed.
    expect(signals).not.toHaveProperty("digest");
  });

  /** And says nothing when there was nothing to say. */
  it("does not flag a body that fitted", async () => {
    const extractor = createSignalExtractor({ salt: SALT, maxBodyBytes: 64 });

    const signals = await extractor.extract(streamOf("x".repeat(16)), DIGEST);

    expect(signals).not.toHaveProperty("bodyOverLimit");
  });

  it("computes when the body is exactly at the ceiling", async () => {
    const extractor = createSignalExtractor({ salt: SALT, maxBodyBytes: 16 });

    const signals = await extractor.extract(streamOf("x".repeat(16)), DIGEST);

    expect(typeof signals["digest"]).toBe("number");
  });

  it("rejects a non-positive ceiling", () => {
    expect(() => createSignalExtractor({ maxBodyBytes: 0 })).toThrow(InvalidSignalSpecError);
  });
});

describe("the HTTP client and bodies", () => {
  async function startServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ port: number; close(): Promise<void> }> {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not start the test server");
    }
    return {
      port: address.port,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }

  function clientFor() {
    const clock = createTestClock();
    return createHttpClient({
      allowedHosts: ["127.0.0.1"],
      throttle: createThrottle({ concurrency: 2, requestsPerSecond: 1000, maxRequests: 50 }, clock),
      clock,
      signalExtractor: createSignalExtractor({ salt: SALT }),
    });
  }

  const SECRET = '{"orders":[{"email":"klient@example.com","card":"4111111111111111"}]}';

  /**
   * The load-bearing test of ADR-0011. The body was read, the signal computed —
   * and not a byte of the content is in the port's response. It must not be
   * marked `skip`.
   */
  it("carries no body content into HttpResponse even while reading it", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(SECRET);
    });

    try {
      const response = await clientFor().send({
        method: "GET",
        url: `http://127.0.0.1:${server.port}/orders`,
        headers: {},
        signals: [
          { name: "digest", kind: "digest" },
          { name: "orders", kind: "count", path: "orders" },
        ],
      });

      expect(response.signals?.["orders"]).toBe(1);
      expect(typeof response.signals?.["digest"]).toBe("number");

      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain("klient@example.com");
      expect(serialized).not.toContain("4111111111111111");
      expect(serialized).not.toContain('orders":[{');
      // Signal values are scalars only: a string that could hold the body has
      // nowhere to come from.
      for (const value of Object.values(response.signals ?? {})) {
        expect(["number", "boolean"]).toContain(typeof value);
      }
    } finally {
      await server.close();
    }
  });

  it("with no declared signals the body is not read and there are no signals", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(SECRET);
    });

    try {
      const response = await clientFor().send({
        method: "GET",
        url: `http://127.0.0.1:${server.port}/orders`,
        headers: {},
      });

      expect(response.status).toBe(200);
      expect(response.signals).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain("klient@example.com");
    } finally {
      await server.close();
    }
  });
});

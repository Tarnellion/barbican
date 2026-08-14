/**
 * The defaults nobody passes in.
 *
 * CLAUDE.md says "throttling is always on" and "the defaults are conservative".
 * A mutation campaign on 14 August found half of them held by nothing: the
 * retry policy, the circuit breaker threshold, the request timeout, the body
 * ceiling and the digest width could all be changed without a single test going
 * red. The throttle limits survived, and the reason is visible one file over —
 * `throttle.test.ts` asserts them with an exact `toEqual`. The others had no
 * such assertion and were only ever exercised through values passed in
 * explicitly, which is precisely the case a default is not.
 *
 * Two of the six are worth naming individually. The breaker threshold at 5000
 * turns off the guard against a run of 5xx and 429 on someone else's deployment.
 * `DIGEST_BYTES` at 1 gives an eight-bit digest, about one collision in 256 per
 * pair — a wall of fabricated cross-tenant findings, and the reasoning for six
 * bytes is written down in ADR-0011.
 *
 * Exact equality rather than a range: a range is a second opinion about what the
 * value should be, and the number lives in the source. What this asserts is that
 * changing it is a deliberate act with a test to update, not a silent one.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BREAKER_POLICY,
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
} from "../../src/adapters/http.js";
import type { SignalSpec } from "../../src/adapters/ports.js";
import { createSignalExtractor, DEFAULT_MAX_BODY_BYTES } from "../../src/adapters/signals.js";

const DIGEST: readonly SignalSpec[] = [{ name: "digest", kind: "digest" }];

function streamOf(text: string): ReadableStream<Uint8Array> {
  const body = new Response(text).body;
  if (body === null) {
    throw new Error("the test stream was not created");
  }
  return body;
}

describe("the HTTP client's defaults", () => {
  it("retries three times with an exponential backoff", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
    });
  });

  /**
   * The breaker is the guard against hammering a deployment that is already
   * unwell. Raised, it stops being one; removed, nothing notices.
   */
  it("opens the circuit after five consecutive failures", () => {
    expect(DEFAULT_BREAKER_POLICY).toEqual({ consecutiveFailures: 5 });
  });

  it("gives a request fifteen seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
  });
});

describe("the body reader's defaults", () => {
  it("reads at most 256 KiB of a response", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(256 * 1024);
  });

  /**
   * Six bytes, forty-eight bits. ADR-0011 chose the width so that a collision
   * between two tenants is not a plausible explanation for a match — the whole
   * tenant-isolation check rests on "the same digest means the same body".
   *
   * Pinned by behaviour rather than by exporting the constant, because the width
   * is what matters and the constant is only how it is spelled. Five hundred
   * distinct bodies bound it from both sides: every digest below 2^48 rules out
   * anything wider, and at least one above 2^40 rules out anything narrower —
   * with five bytes every value is below that ceiling by construction. Both
   * bounds are deterministic for six bytes, not probabilistic: the first always
   * holds, and the second fails only if all five hundred draws land in the
   * lowest 1/256 of the range.
   */
  it("computes a digest wide enough that a collision is no explanation", async () => {
    const extractor = createSignalExtractor();
    const digests = new Set<number>();
    let widest = 0;

    for (let index = 0; index < 500; index += 1) {
      const signals = await extractor.extract(streamOf(`{"n":${index}}`), DIGEST);
      const value = signals["digest"];
      if (typeof value !== "number") {
        throw new Error("the digest is not a number");
      }
      digests.add(value);
      widest = Math.max(widest, value);
    }

    // Distinct bodies, distinct digests: an eight-bit digest cannot manage this.
    expect(digests.size).toBe(500);
    expect(widest).toBeLessThan(2 ** 48);
    expect(widest).toBeGreaterThan(2 ** 40);
  });
});

/**
 * Scalar signals over a response body.
 *
 * The body is read in transit, in the memory of this module, and dies here. Only
 * irreversible reductions go outward — a number or a boolean. The reasoning and
 * the bounds of the decision: ADR-0011.
 *
 * A rule that is easy to break unnoticed: `SignalValue` must not gain a string
 * variant. A string holds the whole body, and the guarantee "there is no PII in
 * the report" would turn from structural into disciplinary.
 */

import { createHash, randomBytes } from "node:crypto";
import { BODY_OVER_LIMIT_SIGNAL } from "../core/checks/tenant-isolation.js";
import { openRecord } from "../io/untrusted.js";
import type { SignalSpec, SignalValue } from "./ports.js";

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/**
 * How many bytes of the digest we keep.
 *
 * Six bytes — 48 bits: fits into a JavaScript safe integer, which lets
 * `SignalValue` stay numeric. Over a run of a thousand responses the probability
 * of a collision is of the order of 10⁻⁹.
 */
const DIGEST_BYTES = 6;

export class InvalidSignalSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSignalSpecError";
  }
}

/**
 * Parses a path into segments.
 *
 * The syntax is deliberately minimal: segments separated by dots. No wildcards,
 * no expressions — this is an evaluator over data from someone else's
 * deployment, and its surface must be zero. An empty path means the root.
 */
export function parseSignalPath(path: string): readonly string[] {
  if (path === "") {
    return [];
  }
  const segments = path.split(".");
  if (segments.some((segment) => segment === "")) {
    throw new InvalidSignalSpecError(`Path "${path}" contains an empty segment`);
  }
  return segments;
}

/**
 * Walks the path inside the parsed body.
 *
 * `Object.hasOwn`, not a check against `undefined`: the body comes from someone
 * else's deployment, and `{"constructor": …}` or `{"toString": …}` would
 * otherwise be found through the prototype chain. The same mistake was already
 * made in binding resources to endpoints.
 */
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function resolvePath(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    if (Array.isArray(current)) {
      // A numeric segment indexes a list. Without this `present` answered
      // `false` for a field that is there in the response — and a wrong signal
      // is indistinguishable from an honest "the field is absent". A whole class
      // of BOPLA ("a column with an email address appeared in the report") went
      // unchecked because of it. No extension of `SignalValue` is needed.
      if (!ARRAY_INDEX.test(segment)) {
        return undefined;
      }
      current = current[Number(segment)];
      continue;
    }
    if (!Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Reads no more than `maxBodyBytes` of the body.
 *
 * On overflow it returns `undefined` rather than a prefix. A digest over a
 * prefix would claim a match between two responses that differ beyond the cutoff
 * — that is worse than the absence of a signal.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBodyBytes: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export interface SignalExtractor {
  /**
   * Computes the declared signals, reading the body.
   *
   * Returns scalars only. The body is not returned, not remembered and not
   * logged under any outcome.
   */
  extract(
    body: ReadableStream<Uint8Array> | null,
    specs: readonly SignalSpec[],
  ): Promise<Readonly<Record<string, SignalValue>>>;
}

export interface SignalExtractorOptions {
  readonly maxBodyBytes?: number;
  /**
   * The digest salt. Random for every run by default.
   *
   * Without a salt the digest of a response with a predictable body
   * (`{"error":"forbidden"}` and the like) is found by brute force, and the
   * report starts confirming guesses about the content. The parameter exists for
   * the sake of reproducible tests.
   */
  readonly salt?: Uint8Array;
}

export function createSignalExtractor(options: SignalExtractorOptions = {}): SignalExtractor {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new InvalidSignalSpecError("The body size cap must be a positive integer");
  }
  const salt = options.salt ?? randomBytes(32);

  // Paths are parsed up front: a mistake in the configuration must fail at
  // startup, not in the middle of a run against someone else's deployment.
  function segmentsFor(spec: SignalSpec): readonly string[] {
    return spec.kind === "digest" ? [] : parseSignalPath(spec.path);
  }

  return {
    async extract(
      body: ReadableStream<Uint8Array> | null,
      specs: readonly SignalSpec[],
    ): Promise<Readonly<Record<string, SignalValue>>> {
      // Without a prototype: a signal a human named `__proto__` used to call the
      // prototype setter instead of becoming a key, so it disappeared from every
      // observation and the report was short one declared signal without saying
      // so. Found by the audit of 14 August (D-2).
      const signals = openRecord<SignalValue>();
      if (specs.length === 0 || body === null) {
        await body?.cancel();
        return signals;
      }

      const paths = new Map(specs.map((spec) => [spec.name, segmentsFor(spec)]));

      const bytes = await readCapped(body, maxBodyBytes);
      if (bytes === undefined) {
        // The body is over the ceiling: the signals are unavailable. An empty
        // set, not guesses — and one flag saying which of the two silences this
        // is. Without it the pair was skipped, the comparison became zero, and
        // the report could not tell "no comparison was made" from "the bodies
        // differed". See D-5.
        signals[BODY_OVER_LIMIT_SIGNAL] = true;
        return signals;
      }

      const needsJson = specs.some((spec) => spec.kind !== "digest");
      let parsed: unknown;
      let parsedOk = false;
      if (needsJson) {
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
          parsedOk = true;
        } catch {
          // Not JSON — signals by path are unavailable. The digest over the
          // bytes works.
          parsedOk = false;
        }
      }

      for (const spec of specs) {
        if (spec.kind === "digest") {
          // Written after the loop — see below.
          continue;
        }

        if (!parsedOk) {
          continue;
        }
        const target = resolvePath(parsed, paths.get(spec.name) ?? []);

        if (spec.kind === "present") {
          signals[spec.name] = target !== undefined;
          continue;
        }
        // count: not an array — no signal. A zero would be a claim of emptiness
        // that we never made.
        if (Array.isArray(target)) {
          signals[spec.name] = target.length;
        }
      }

      /**
       * The digests go in last, so a declared signal sharing the name cannot
       * take their place.
       *
       * Configuration refuses that name outright (`ReservedSignalNameError`);
       * this is the guarantee for whoever assembles the specs through the
       * library. The asymmetry is deliberate: losing a declared scalar is
       * visible in the report, while losing the digest disables the
       * tenant-isolation check in silence and leaves `checksRun` claiming it
       * ran. Between two ways to lose, take the one that shows.
       */
      for (const spec of specs) {
        if (spec.kind !== "digest") {
          continue;
        }
        const hash = createHash("sha256").update(salt).update(bytes).digest();
        let value = 0;
        for (let index = 0; index < DIGEST_BYTES; index += 1) {
          value = value * 256 + (hash[index] ?? 0);
        }
        signals[spec.name] = value;
      }

      return signals;
    },
  };
}

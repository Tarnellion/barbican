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
import {
  BODY_OVER_LIMIT_SIGNAL,
  DIGEST_SCOPE_MISSING_SIGNAL,
} from "../core/checks/tenant-isolation.js";
import { byCodeUnits } from "../core/order.js";
import { openRecord } from "../io/untrusted.js";
import type { SignalSpec, SignalValue } from "./ports.js";

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/**
 * How deep the canonical form of a declared subtree is walked.
 *
 * A bound of the tool's own rather than the engine's stack. A body that yielded
 * a digest on one machine and none on another would make a report
 * irreproducible, which is the thing ADR-0036 exists to prevent; `JSON.parse`
 * and `JSON.stringify` both give out at a depth nobody can name in advance and
 * that moves with the runtime. Past this depth the subtree has no digest and the
 * observation says so, which is the same treatment a body over the size ceiling
 * gets.
 *
 * A hundred is far past any response an API returns on purpose and far short of
 * any stack.
 */
const MAX_SUBTREE_DEPTH = 100;

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

/**
 * A deterministic text for a subtree, so that a digest over it is a digest over
 * the data and not over one serialization of it.
 *
 * There is no byte range to hash: the subtree is reached by parsing, and the
 * bytes it came from are not addressable once `JSON.parse` has run. So the value
 * is written out again, by one rule on every machine.
 *
 * **Object keys are sorted; array order is kept.** The two halves are decided
 * separately and both matter. A platform that serialises one record's fields in
 * another order between two requests is not a platform whose tenants leak into
 * each other, and hashing the raw order would report a difference there was
 * none of — the same blindness this whole scoped digest exists to remove, one
 * level down. The order of elements in a list, on the other hand, is data: two
 * tenants shown the same records in a different order is a leak, and sorting it
 * away would be the tool answering a question nobody asked. See ADR-0044.
 *
 * `Object.keys` and not a walk of the prototype chain: the value comes from
 * someone else's deployment. `JSON.parse` gives own properties only, a key named
 * `__proto__` among them, and this reads exactly those.
 */
function canonicalText(value: unknown, depth: number): string {
  if (depth > MAX_SUBTREE_DEPTH) {
    throw new RangeError("The declared subtree is nested deeper than the tool will walk");
  }
  if (value === null || typeof value !== "object") {
    // `JSON.parse` produces no undefined, no NaN and no function, so every leaf
    // that reaches here has a JSON text of its own.
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalText(element, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort(byCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalText(record[key], depth + 1)}`);
  return `{${fields.join(",")}}`;
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
  //
  // A digest without a declared scope has no path — the empty list is the root,
  // and it is never consulted, because that digest is over the raw bytes rather
  // than over anything parsed.
  function segmentsFor(spec: SignalSpec): readonly string[] {
    if (spec.kind === "digest") {
      return spec.path === undefined ? [] : parseSignalPath(spec.path);
    }
    return parseSignalPath(spec.path);
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

      // A digest scoped to a subtree needs the body parsed as much as a count
      // does: the subtree is reached by walking the parsed value, not by finding
      // a byte range.
      const needsJson = specs.some((spec) => spec.kind !== "digest" || spec.path !== undefined);
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
       *
       * Resolved by name **before** anything is hashed, and the later
       * declaration of a name wins. That is not tidiness: the runner prepends
       * the whole-body digest implied by `responseMustDifferByTenant` and
       * appends whatever the endpoint declared, so a scoped digest arrives
       * beside the unscoped one under the same name. Assigning them in turn
       * would leave the outcome to the order of two writes, and — worse — a
       * scoped digest that cannot be computed would leave the unscoped value
       * standing, so the check would compare whole bodies while the
       * configuration said to compare a subtree. One spec per name, one
       * outcome, and where that outcome is "no digest" the name is absent
       * rather than holding somebody else's number. See ADR-0044.
       */
      const digestSpecs = new Map<string, SignalSpec>();
      for (const spec of specs) {
        if (spec.kind === "digest") {
          digestSpecs.set(spec.name, spec);
        }
      }

      for (const [name, spec] of digestSpecs) {
        const scope = spec.kind === "digest" ? spec.path : undefined;
        const hash = createHash("sha256").update(salt);

        if (scope === undefined) {
          hash.update(bytes);
        } else {
          // A subtree needs the body parsed, and the two ways that fails —
          // not JSON, and the declared path is not there — are one outcome
          // for the reader: the comparison the configuration asked for could
          // not be made. Falling back to the whole body would be answering a
          // different question under the same field name.
          const target = parsedOk ? resolvePath(parsed, segmentsFor(spec)) : undefined;
          let text: string | undefined;
          if (target !== undefined) {
            try {
              text = canonicalText(target, 0);
            } catch {
              // Deeper than `MAX_SUBTREE_DEPTH`, or deeper than the engine will
              // walk. Either way there is no canonical form and so no digest.
              text = undefined;
            }
          }
          if (text === undefined) {
            signals[DIGEST_SCOPE_MISSING_SIGNAL] = true;
            continue;
          }
          // The declared path is hashed with the value. Two endpoints scoped
          // differently then cannot produce one number by accident, and a
          // scoped digest is never the whole-body digest of the same text.
          hash
            .update("\u0000scope\u0000")
            .update(spec.path ?? "")
            .update("\u0000")
            .update(text);
        }

        const digest = hash.digest();
        let value = 0;
        for (let index = 0; index < DIGEST_BYTES; index += 1) {
          value = value * 256 + (digest[index] ?? 0);
        }
        signals[name] = value;
      }

      return signals;
    },
  };
}

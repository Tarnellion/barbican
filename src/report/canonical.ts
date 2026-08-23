/**
 * One serialisation whose result depends on the meaning, and the digests taken
 * over it.
 *
 * Split out of `build.ts` by ADR-0054. It is the one part of the report layer
 * that knows nothing about a report: it takes a value and produces bytes, and
 * both of its callers — `configDigest` over a parsed configuration and
 * `contentDigest` over a finished document — are elsewhere. Everything in this
 * file is about that one question, which is why it is a file.
 */

import { createHash } from "node:crypto";
import { byCodeUnits } from "../core/order.js";

/**
 * A serialisation whose result depends on the meaning and not on the shape.
 *
 * `JSON.stringify` was used here and dropped a whole field: `accountAuth` is a
 * `Map`, and a `Map` stringifies to `{}` whatever is in it. Sorting the keys is
 * the second half — see `configDigest` for why that half is insurance and not a
 * fix.
 *
 * A `Map` becomes its entries sorted by key, tagged so that it cannot collide
 * with a plain object carrying the same pairs: a fingerprint that cannot tell
 * two different declarations apart is the failure being fixed, and inventing a
 * new way to do it would be a poor exchange. Arrays keep their order — in a
 * policy the order of rules decides the outcome, and sorting them would make two
 * different policies look alike.
 *
 * All three sorts go through `byCodeUnits`, and until 21 August 2026 they did
 * not: the `Map` branch used `localeCompare()` while the `Set` branch and the
 * object keys used the default `.sort()`. One function, two orders — and the
 * `Map` half took its order from the machine's `LC_ALL`, so `configDigest` came
 * out different on a Swedish machine than on an American one over the same
 * declaration. That is precisely the question `docs/report.md` sells this digest
 * as the answer to: "the platform changed" against "we changed the declaration".
 * Found by the audit of 21 August 2026 (L-2); `src/core/order.ts` holds the rule.
 *
 * Exported since ADR-0054 split this file out, and no further than the report
 * layer: `buildReport` hashes the configuration with it. It is not on the
 * package's surface — `build.ts` re-exports the two digest functions and not
 * this one, because a serialisation nobody can compare against is of no use to
 * a consumer, and publishing it would freeze the format of a value this tool
 * only ever hashes.
 */
export function canonical(value: unknown): string {
  const pieces: string[] = [];
  canonicalInto((piece) => pieces.push(piece), value);
  return pieces.join("");
}

/**
 * The same serialisation, handed to a sink one piece at a time.
 *
 * One traversal for both readers, which is the whole reason this function is
 * shaped like this: `configDigest` hashes a configuration small enough to hold
 * as a string, and `contentDigest` hashes the finished report, which is not.
 * `src/report/write.ts` was rewritten in chunks because the string ceiling —
 * 536 870 888 characters — is reachable on this tool's ordinary output: a run of
 * 57 826 cells against a platform answering with 196 headers died at the last
 * step with every request already spent (ADR-0038). Building the canonical form
 * as one string to hash it would put that ceiling straight back, one function
 * further along.
 *
 * A second serialiser would be the other way to have it, and this project has a
 * rule about that. The `Set` branch is the one place a piece has to be
 * materialised — its members are sorted by their serialised form — and it is
 * bounded by the set, not by the document.
 */
function canonicalInto(write: (piece: string) => void, value: unknown): void {
  if (value instanceof Map) {
    const entries = [...value.entries()].sort(([left], [right]) =>
      byCodeUnits(String(left), String(right)),
    );
    write("Map(");
    entries.forEach(([key, one], index) => {
      write(index === 0 ? "" : ",");
      write(`${JSON.stringify(String(key))}:`);
      canonicalInto(write, one);
    });
    write(")");
    return;
  }
  if (value instanceof Set) {
    write(`Set(${[...value].map(canonical).sort(byCodeUnits).join(",")})`);
    return;
  }
  if (Array.isArray(value)) {
    write("[");
    value.forEach((element, index) => {
      write(index === 0 ? "" : ",");
      canonicalInto(write, element);
    });
    write("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A key whose value is `undefined`, a function or a symbol is dropped, for
    // the reason `reportChunks` drops it: `JSON.stringify` does, so the file on
    // disk does not have it. `contentDigest` is checked against a report parsed
    // back out of that file, and a serialisation that wrote `"tenant":null`
    // where the document has no `tenant` at all would fail every honest report
    // it was asked about. Found the first time this digest was compared with
    // itself across a round trip — `ReportedAccount.tenant` is `string |
    // undefined` and an account outside a tenant carries the key unset.
    //
    // It is the right answer for `configDigest` too, and slightly more right
    // than what stood here: `{ exclude: undefined }` and `{}` are one
    // declaration, and a fingerprint that told them apart was answering a
    // question nobody asked.
    const keys = Object.keys(record)
      .filter((key) => {
        const own = record[key];
        return own !== undefined && typeof own !== "function" && typeof own !== "symbol";
      })
      .sort(byCodeUnits);
    write("{");
    keys.forEach((key, index) => {
      write(index === 0 ? "" : ",");
      write(`${JSON.stringify(key)}:`);
      canonicalInto(write, record[key]);
    });
    write("}");
    return;
  }
  // `undefined` inside an array, and a function or a symbol anywhere: all three
  // become `null`, which is what `JSON.stringify` writes for them in an array.
  write(JSON.stringify(value) ?? "null");
}

/**
 * The name of the field a report carries its own digest under.
 *
 * Written once, because two readers need it and they must agree: the builder
 * that fills it and the verifier that has to take it back out before
 * recomputing. A literal in both places is the shape ADR-0024 was written
 * against, at the one spot where a disagreement would make every report verify
 * against itself and none against the file.
 */
const CONTENT_DIGEST = "contentDigest";

/**
 * The digest of everything in a report except the field that carries it.
 *
 * Over the **parsed** document and not over its bytes, which is the same
 * decision `configDigest` rests on: indentation, key order and the trailing
 * newline are the file's formatting, not its content, and a reader who
 * reserialised the JSON to look at it would otherwise be told the report had
 * been tampered with.
 *
 * A whole sha256 rather than the sixteen characters `configDigest` keeps.
 * That one is a label two runs are compared by, where a short string is easier
 * to read off a screen; this one is a check value, and truncating a check value
 * trades collision resistance for nothing.
 */
export function contentDigestOf(report: object): string {
  const { [CONTENT_DIGEST]: _carried, ...content } = report as Record<string, unknown>;
  const hash = createHash("sha256");
  canonicalInto((piece) => {
    hash.update(piece);
  }, content);
  return hash.digest("hex");
}

/** What {@link checkContentDigest} answers. */
export interface ContentDigestCheck {
  /**
   * Whether the file carries a digest and that digest is the one its content
   * gives.
   *
   * **False on a report that carries none.** A verifier that read a missing
   * field as a pass would make the whole exercise optional: delete the line and
   * the document is unimpeachable again. `declared` is what tells the two cases
   * apart — a report written before 0.5.0 has no digest, and that is a thing to
   * know rather than a thing to wave through.
   */
  readonly ok: boolean;
  /** The digest this content gives now. */
  readonly computed: string;
  /** The digest the file carries, if it carries one. */
  readonly declared?: string;
}

/**
 * Whether a report is the file the run wrote.
 *
 * **What it catches:** an edit made without thinking — a row deleted from
 * `findings`, a sentence rewritten in `verdict.reason`, a counter nudged in
 * `summary`, a merge that mangled the JSON, a truncated download. Since
 * HTML and PDF are rendered from this file (ADR-0002), an edit here reaches
 * every form of the document, and this is what makes the edit visible.
 *
 * **What it does not catch: a deliberate change.** Whoever edited the row can
 * run this function and write the new value back, and nothing here would know.
 * A digest a reader can recompute is a digest an author can recompute. Making
 * the artifact evidence against a determined editor takes a signature — a key
 * that does not live beside the report and a verifier that holds the public
 * half — and that is a separate decision this one does not make. ADR-0051
 * records it as not done rather than leaving the reader to assume it was.
 */
export function checkContentDigest(report: object): ContentDigestCheck {
  const declared = (report as Record<string, unknown>)[CONTENT_DIGEST];
  const computed = contentDigestOf(report);
  return {
    ok: typeof declared === "string" && declared === computed,
    computed,
    ...(typeof declared === "string" ? { declared } : {}),
  };
}

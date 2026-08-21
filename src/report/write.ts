/**
 * Writing the report without holding it as one string.
 *
 * `JSON.stringify(report, null, 2)` builds the whole file in memory before a
 * byte of it is written, and a string in node stops at 536 870 888 characters.
 * The project already met that wall once: `MAX_ROWS_PER_DEFECT` exists because
 * 2 000 accounts on one endpoint produced 1 999 000 evidence rows and
 * `RangeError: Invalid string length` at the last step of the run — see the
 * reasoning beside the constant in `build.ts`.
 *
 * The cap bounds `findings`. It does not bound `observations`, which carries one
 * row per cell whether anything was found there or not, so the wall stayed
 * reachable from the other side: the audit of 20 August 2026 (J-1) lost a run of
 * 57 826 cells against a platform that answers with 196 headers — every request
 * sent, every finding discarded, no file on disk, and an error naming a string
 * length rather than anything the operator did.
 *
 * Serialising in chunks removes the ceiling on the file. It does not remove the
 * report from memory — the object graph is still built in full, and the matrix
 * is still materialised three times over the course of a run (J-10). That is a
 * larger change and it is not this one.
 *
 * The output is byte-for-byte what `JSON.stringify(report, null, 2)` produced,
 * because things read it: the polygon's oracle parses the file and compares it
 * cell for cell, and a reader diffing two runs would see an unrelated change in
 * every line. `tests/report/write.test.ts` asserts the equality rather than
 * trusting this paragraph.
 */

/** Re-indents a serialised value so it sits at `depth` spaces inside the document. */
function reindent(value: string, depth: number): string {
  return value.split("\n").join(`\n${" ".repeat(depth)}`);
}

/**
 * The report as a sequence of chunks, in document order.
 *
 * Arrays are the point: their elements are serialised one at a time, so the
 * largest string this ever holds is one observation, not the whole file.
 */
export function* reportChunks(report: object): Generator<string> {
  const entries = Object.entries(report).filter(
    // `JSON.stringify` drops a key whose value is `undefined`, a function or a
    // symbol, and so must this: the two outputs have to agree on which keys exist
    // at all.
    //
    // Asked of the value itself rather than by serialising it. The first version
    // wrote `JSON.stringify(value) !== undefined` here, which serialises every
    // top-level value in full **before the first chunk is yielded** — so the
    // ceiling this whole function exists to remove was still there, one line
    // above the loop that avoids it. Found by adversarial review on 21 August
    // 2026 (V-3), with 700 megabyte-long strings in `observations`: the throw
    // came from the filter, not from the loop.
    ([, value]) => value !== undefined && typeof value !== "function" && typeof value !== "symbol",
  );

  // `JSON.stringify({}, null, 2)` is `{}` and not `{\n}`: an object with no keys
  // is the one case where the indented form has no newline in it.
  if (entries.length === 0) {
    yield "{}\n";
    return;
  }

  yield "{\n";
  for (const [index, [key, value]] of entries.entries()) {
    const last = index === entries.length - 1;
    yield `  ${JSON.stringify(key)}: `;

    if (Array.isArray(value) && value.length > 0) {
      yield "[\n";
      for (const [position, element] of value.entries()) {
        yield `    ${reindent(JSON.stringify(element, null, 2) ?? "null", 4)}`;
        yield position === value.length - 1 ? "\n" : ",\n";
      }
      yield "  ]";
    } else {
      yield reindent(JSON.stringify(value, null, 2) ?? "null", 2);
    }

    yield last ? "\n" : ",\n";
  }
  yield "}\n";
}

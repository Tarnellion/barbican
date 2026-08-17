/**
 * A block of a document that a run writes and a human does not.
 *
 * `polygon/README.md` carries the verification table between two markers. It is
 * rendered by `polygon/verify.mjs` from the run that produced the verdict,
 * because the numbers in that document drifted away from the code twice — the
 * second time the paragraph beside them explained why they differed, having been
 * updated while the numbers were not. `--check-readme` compares what the
 * document holds with what this run would write, and `--update-readme` puts the
 * new block in.
 *
 * Both operations are string comparison against a file on disk, and that is
 * where they broke: the comparison was `current === block`, the rendered block
 * joins its lines with "\n", and a working tree checked out on Windows holds
 * "\r\n". Every line then differs, the gate goes red, and the message says the
 * table is stale — so the fix it recommends, regenerating the table, commits the
 * wrong line endings and cures nothing. A contributor meets it on their first
 * run, and the repository had no `.gitattributes` to keep it from happening.
 * Found by the audit of 14 August 2026 (K-4).
 *
 * So the line endings are made one here, in the three functions that read and
 * write such a block, and not left to each caller to remember. `.gitattributes`
 * settles the other half — what git puts in the working tree in the first place.
 *
 * Zero dependencies: built-in modules only.
 */

export class ManagedBlockError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManagedBlockError";
  }
}

/**
 * One spelling for the end of a line.
 *
 * CRLF and a lone CR both become LF. The lone CR costs one character in the
 * pattern and closes the case that a partial conversion leaves behind — a file
 * half-fixed by an editor, which is a shape that turns up in practice more often
 * than a whole file written by a classic Mac.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * The block between the markers, both markers included.
 *
 * @param {string} text the whole document
 * @param {string} begin the opening marker
 * @param {string} end the closing marker
 * @returns {string}
 * @throws {ManagedBlockError} a marker is missing, or they are the wrong way round
 */
export function extractManagedBlock(text, begin, end) {
  const document = normalizeNewlines(text);
  const from = document.indexOf(begin);
  const to = document.indexOf(end);
  if (from === -1 || to === -1) {
    throw new ManagedBlockError(
      `the document has no ${begin} / ${end} markers around the managed block`,
    );
  }
  if (to < from) {
    // Otherwise `slice` returns "" and the caller reads that as "the block is
    // empty", which is a document that will be silently overwritten.
    throw new ManagedBlockError(`${end} comes before ${begin} in the document`);
  }
  return document.slice(from, to + end.length);
}

/**
 * Whether the document's block already says exactly this.
 *
 * Both sides are normalised: the document may have come off any checkout, and
 * the block is whatever the caller rendered.
 *
 * @param {string} text the whole document
 * @param {string} begin the opening marker
 * @param {string} end the closing marker
 * @param {string} block the block as it would be written
 * @returns {boolean}
 * @throws {ManagedBlockError} a marker is missing
 */
export function managedBlockMatches(text, begin, end, block) {
  return extractManagedBlock(text, begin, end) === normalizeNewlines(block);
}

/**
 * The document with the block replaced, and with LF throughout.
 *
 * The whole document is normalised rather than only the part that was replaced:
 * writing an LF block into a CRLF file leaves a file with both, which no
 * comparison and no reviewer can read. If the working tree wants CRLF, git puts
 * it back on checkout — that is what `.gitattributes` is for.
 *
 * `split`/`join` and not `String.replace`: `$&` and `$1` in a replacement string
 * are substitutions, and a rendered block is arbitrary text that may contain
 * them.
 *
 * @param {string} text the whole document
 * @param {string} begin the opening marker
 * @param {string} end the closing marker
 * @param {string} block the block to write
 * @returns {string}
 * @throws {ManagedBlockError} a marker is missing
 */
export function replaceManagedBlock(text, begin, end, block) {
  const document = normalizeNewlines(text);
  const current = extractManagedBlock(document, begin, end);
  return document.split(current).join(normalizeNewlines(block));
}

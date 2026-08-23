/**
 * The keys this tool joins its own tables on.
 *
 * Not exported from `src/core/index.ts`, and so not part of the package's public
 * surface: which string the runner and the report meet on is how this tool
 * arranges its own bookkeeping, not something a consumer is promised.
 * `src/core/order.ts` is here on the same terms and for the same reason.
 *
 * It lives in `src/core` all the same, and that is the whole of the placement
 * decision. The two consumers are in two layers — `src/runner` writes the cells
 * and `src/report` reads them back — and the layering rule runs one way: core
 * may not import from either, both may import core. A key kept in the runner
 * would have made the report import upwards, and a key kept in the report would
 * have done the same to the runner; keeping a copy in each is what actually
 * happened, and what this module ends. A coordinate of the matrix is a core
 * subject anyway: pure functions over three strings, no I/O, no state.
 * See ADR-0059.
 *
 * ## Nothing here hands out the raw material
 *
 * The separator is **not exported**, and that is the seam rather than an
 * accident of tidying. While it was exported, a second key builder under any
 * other name could import it and rebuild the same string by hand — which is
 * exactly what a reviewer did on 23 August 2026, past a gate whose ADR claimed
 * to catch it. A constant nobody outside this file can reach is a stronger
 * statement than any test that looks for imitations of one: a copy elsewhere
 * now has to spell the character itself, and one file spelling one character is
 * checkable in every spelling of it. See ADR-0060.
 *
 * `joinKey` is what leaves instead — the joining, not the character. The four
 * modules outside this one that call it each build a **different** key; they are
 * named in `tests/invariants/one-decision-one-home.test.ts` with the key each
 * builds, and pinned to **one call apiece**, so that neither a fifth module nor a
 * second key inside one of the four gets in under an allowance granted for
 * something else.
 *
 * `src/core/path-parameters.ts` got this right first: the regular expression it
 * owns is deliberately never handed to a caller, so a caller cannot share its
 * state or copy its source. This module is that module's shape now.
 */

/**
 * The separator between the parts of a key: a character that never occurs in an
 * identifier.
 *
 * Gluing with a hyphen, or with a space, would admit a collision between two
 * different keys — `a` + `|b` and `a|b` have to be different strings, and an
 * endpoint id ending in a space is enough to make them one.
 *
 * Written as an escape sequence rather than as the byte itself. The byte in the
 * source made the file binary to `grep`: a search across the repository silently
 * skipped it entirely, and "no matches" here would read as "this code does not
 * exist". `tests/invariants/one-decision-one-home.test.ts` reads the sources for
 * this character, in every spelling a source can give it, which is the second
 * reason it stays spelled this way.
 *
 * Module-private since ADR-0060. `joinKey` below is the export.
 */
const KEY_SEPARATOR = "\u0000";

/**
 * Glues the parts of a key with the separator.
 *
 * The one way to build a key in this repository, and the reason the character
 * above need not leave the file. A caller that has some other tuple to index by
 * — a defect signature, an acceptance, a per-defect evidence budget — asks here
 * rather than writing the character out, so the character has one home and the
 * keys built from it cannot drift from one another over how they are glued.
 *
 * They can still drift over **what** they glue, and no gate can see that: this
 * function does not know that `signature NUL kind` and `kind NUL signature` are
 * the same pair of coordinates in two orders. What it does mean is that neither
 * of them can glue two different defects into one entry.
 *
 * Variadic rather than taking an array, so that a caller cannot hand one over by
 * accident: an array argument is a type error here, and `[a, b].join(separator)`
 * — the form three of the callers used — has no way in at all.
 */
export function joinKey(...parts: readonly string[]): string {
  return parts.join(KEY_SEPARATOR);
}

/**
 * The key of a matrix cell: account, endpoint, resource.
 *
 * "Written out by hand in five places, and the sixth had to agree with all five
 * for a verdict and a finding to meet on the same cell." That sentence stood in
 * `src/report/findings.ts` over one of **two** character-for-character identical
 * copies of this function — the other in `src/runner/stream.ts`, with nothing
 * between them but the two authors' agreement. The warning had happened to the
 * file that carried it.
 *
 * Here it is once. `tests/invariants/one-decision-one-home.test.ts` is what keeps
 * it once, because a comment asking the next reader to agree with five other
 * places is exactly what failed.
 *
 * Three coordinates and nothing else. The request conditions are in the account:
 * an account under conditions is a matrix row of its own and carries an id of its
 * own (`src/io/config/contexts.ts`), so a fourth field here would be the same
 * fact twice.
 *
 * ## Why `resourceId` admits an explicit `undefined`
 *
 * `?: string | undefined` under `exactOptionalPropertyTypes`, and not the
 * `?: string` the two replaced copies carried. The widening arrived with the
 * move and unremarked, which is how it came to be reviewed; it is kept
 * deliberately, and this is the reason.
 *
 * A cell either has a resource or has none, and the two ways a caller can say
 * "none" — leaving the property out, and passing `undefined` — are one fact to
 * this function: both produce the same key, and a test pins that. `?: string`
 * would make the *distinction* meaningful at the type level while the function
 * goes on ignoring it, and it would do so where callers hold a
 * `Resource | undefined` and write `resourceId: resource?.id`: two call sites in
 * `src/runner/walk.ts` would each need a conditional spread, so the caller of a
 * key would be made to think about a difference the key does not have. The
 * looser type is the honest one here. `CellRecord` in `src/runner/stream.ts`
 * keeps `?: string` and passes through unchanged, because a record on disk
 * really does either carry the field or not.
 */
export function cellKey(cell: {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string | undefined;
}): string {
  return joinKey(cell.accountId, cell.endpointId, cell.resourceId ?? "");
}

/**
 * The object a request addresses: endpoint and resource, without the account.
 *
 * A second concept and not a cell key with a field dropped. Both places that
 * build it leave the account out deliberately, and each would be wrong with it:
 *
 * - Placing a resumed record. `cells` in `collectObservations` is the endpoint ×
 *   resource list the walk is made of, held once and shared by every account
 *   (ADR-0053); the account is resolved separately, into a walker. This key
 *   answers "which column", and the row is somebody else's question.
 * - Naming an object this run has already changed. A 404 after *anybody's*
 *   successful write is this run's own doing — see the `changed` set in
 *   `src/runner/walk.ts`, which spells out what an account in this key would
 *   cost: the second account through would read a manufactured 404 as protection
 *   observed.
 *
 * The two keys sit in one module so the difference between them is a paragraph
 * away rather than a file away. They must not be swapped for one another: the
 * cell key in either place above would put a row-shaped question to a
 * column-shaped index, and this one in a cell's place would merge every
 * account's cell into a single entry.
 *
 * `resourceId` reads an explicit `undefined` for the reason written over
 * `cellKey`.
 */
export function objectKey(of: {
  readonly endpointId: string;
  readonly resourceId?: string | undefined;
}): string {
  return joinKey(of.endpointId, of.resourceId ?? "");
}

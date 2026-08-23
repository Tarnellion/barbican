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
 * exist". `tests/invariants/one-key-one-source.test.ts` reads the sources for
 * this literal, which is the second reason it stays spelled this way.
 */
export const KEY_SEPARATOR = "\u0000";

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
 * Here it is once. `tests/invariants/one-key-one-source.test.ts` is what keeps it
 * once, because a comment asking the next reader to agree with five other places
 * is exactly what failed.
 *
 * Three coordinates and nothing else. The request conditions are in the account:
 * an account under conditions is a matrix row of its own and carries an id of its
 * own (`src/io/config/contexts.ts`), so a fourth field here would be the same
 * fact twice.
 */
export function cellKey(cell: {
  readonly accountId: string;
  readonly endpointId: string;
  readonly resourceId?: string | undefined;
}): string {
  return `${cell.accountId}${KEY_SEPARATOR}${cell.endpointId}${KEY_SEPARATOR}${cell.resourceId ?? ""}`;
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
 */
export function objectKey(of: {
  readonly endpointId: string;
  readonly resourceId?: string | undefined;
}): string {
  return `${of.endpointId}${KEY_SEPARATOR}${of.resourceId ?? ""}`;
}

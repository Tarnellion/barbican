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
 * statement than any test that looks for imitations of one: a copy elsewhere has
 * to spell the character itself, and a character written into a source literal
 * is checkable in every spelling a literal can give it. A character *computed*
 * rather than written — `decodeURIComponent("%00")` is the short way — is past
 * every scanner, and `tests/invariants/one-decision-one-home.test.ts` says so in
 * its own limits. What is left holding there is this line: such a copy is a
 * second implementation of the separator and not a second reference to this one,
 * so it drifts the day this one moves. See ADR-0060.
 *
 * `joinKey` is what leaves instead — the joining, not the character. The modules
 * outside this one that call it each build a **different** key; they are named in
 * `tests/invariants/one-decision-one-home.test.ts` with the key each builds, and
 * pinned to **one call apiece**, so that neither a further module nor a second
 * key inside one of them gets in under an allowance granted for something else.
 * That test enumerates the **import** rather than the text of the call:
 * `import { joinKey as glue }` and `const glue = joinKey` each reduced a count of
 * `joinKey(` to zero, which is how the first version of it was walked around.
 *
 * There were three of them until ADR-0066 and there is one, `src/core/defects.ts`.
 * The other two each built a key that is a defect signature and one coordinate
 * more, by handing the finished signature back here as a part — which the seam
 * below now refuses, because a part of a key is an identifier and a signature is
 * a key. They ask `defectSignature` to extend itself instead, so the coordinates
 * of a defect are still read in one place and the joining is still done in this
 * one.
 *
 * `src/core/path-parameters.ts` got this right first: the regular expression it
 * owns is deliberately never handed to a caller, so a caller cannot share its
 * state or copy its source. This module is that module's shape now.
 *
 * ## The seam, since ADR-0066
 *
 * The sentence over the separator below used to say that the character "never
 * occurs in an identifier" and nothing made it true. It is true now because
 * `joinKey` refuses a part that is not one: `./identifiers.js` owns the grammar,
 * and this is the place it is applied, for the reason ADR-0032 gives about the
 * address — `joinKey` is the one place a key is built, so a door nobody
 * remembered is a door this covers anyway. The doors report the same refusal in
 * an operator's words; this one is the backstop under them.
 */

import { identifier } from "./identifiers.js";

/**
 * The separator between the parts of a key: a character that never occurs in an
 * identifier, because `joinKey` refuses one that does.
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
 *
 * ## Every part is an identifier, or is absent
 *
 * A part may be `undefined`, and that is the coordinate a key does not have — a
 * cell with no resource, a defect with no conditions. It is written as the empty
 * string, which is what the callers used to write themselves.
 *
 * They wrote `?? ""`, and the difference is the whole reason the parameter type
 * changed: while absence and the empty string were one value here, the grammar
 * could not refuse an empty **identifier** without refusing every key that has a
 * coordinate missing. A resource whose id is `""` and no resource at all are two
 * different cells, and they had one key. Now absence has a spelling of its own
 * and the empty string has none.
 *
 * A part that is neither is refused — not folded, not escaped. Escaping would be
 * a second grammar to keep in step with the first, and the tool would then hold
 * an id it can never print: the string reaches a report a person reads and a
 * terminal that obeys it, and the honest answer to a name that cannot be printed
 * is to ask for a different name. See `./identifiers.js` and ADR-0066.
 *
 * @throws {UnusableIdentifierError}
 */
export function joinKey(...parts: readonly (string | undefined)[]): string {
  return parts.map(asCoordinate).join(KEY_SEPARATOR);
}

/**
 * One part, checked, with absence written the way the callers used to write it.
 *
 * The message names no field, because this function cannot know one: which
 * declaration a coordinate came from is the door's to say, and a door says it.
 * What this one guarantees is that no route reaches a key without being asked —
 * including the route ADR-0032 found open twice, a consumer of the library
 * calling into the core with no adapter between.
 */
function asCoordinate(part: string | undefined): string {
  return part === undefined ? "" : identifier(part, "A coordinate of a key");
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
  return joinKey(cell.accountId, cell.endpointId, cell.resourceId);
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
  return joinKey(of.endpointId, of.resourceId);
}

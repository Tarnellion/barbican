/**
 * The one grammar for `{name}` in an endpoint path.
 *
 * Not exported from `src/core/index.ts`, and so not part of the package's public
 * surface, for the same reason as `./order.js`: this is how the tool reads a
 * template it was handed, not something a consumer is promised. It lives in its
 * own module all the same, because the alternative is the shape ADR-0024 was
 * written against.
 *
 * ## What was wrong
 *
 * Three copies of one grammar, in two layers. `TEMPLATE_PARAMETER`
 * (`/\{[^}]+\}/`) in `src/runner/address.ts` asked whether a path names
 * parameters at all; `PARAMETER_NAME` (`/\{([^}]+)\}/g`) in the same file read
 * the names out for substitution; and a third, **character for character the
 * same as the second**, sat in `src/core/matrix.ts` deciding whether a resource
 * applies to an endpoint. A comment above the first admitted the first two were
 * one grammar written twice. Nothing anywhere mentioned the third, and the
 * spelling had already leaked into prose: a comment in `src/adapters/postman.ts`
 * and one in its test quoted the expression by hand to explain why `{{playerId}}`
 * has to be reduced to `{playerId}`.
 *
 * That is exactly ADR-0024's arithmetic — eleven point fixes of one shape across
 * four files, two of them already drifted. The three here had not drifted yet,
 * which is the state a duplicate is in right up until it is not: the two in the
 * runner are the *same* rule, and the third decides, in another layer, whether
 * the cell the runner is about to probe exists at all. Had one of them learned
 * about `{name:int}` or a nested brace and the others not, the run would have
 * probed a cell the matrix does not contain, or the matrix would have expected a
 * cell the run never walked.
 *
 * ## Why the core and not `src/io/untrusted.ts`
 *
 * ADR-0024 puts the grammars in `src/io/untrusted.ts`, and this one cannot go
 * there. `src/core/matrix.ts` is one of the three callers, `io` already imports
 * `core` (`untrusted.ts` takes `isUsablePathSegment` from `./types.js`), and a
 * core that imported back would close that ring. The precedent is that same
 * `isUsablePathSegment`: the value grammar sits in the core "because the core
 * builds cells out of the same values", and `untrusted.ts` reaches down for it.
 * A path template is read by the core for the same reason — an endpoint is a cell
 * coordinate. So the rule of ADR-0024 is applied, at the address the layering
 * allows: one module, one grammar, everybody imports it.
 *
 * ## Why no regular expression leaves this file
 *
 * A `RegExp` carrying the `g` flag is **stateful**: `lastIndex` survives between
 * calls. `test()` on a global regex advances it and resets only on a failed
 * match, and `String.prototype.matchAll` clones the regex *with the `lastIndex`
 * it is handed*, so a scan that follows a `test()` starts in the middle of the
 * string. Measured on Node 22: after one `test()` of
 * `/v1/players/{playerId}/orders/{orderId}`, `matchAll` over that same string
 * yields `orderId` alone.
 *
 * Collapsing three copies into one shared global regex is therefore not a
 * simplification but a defect, and it is the obvious thing to reach for. Hence a
 * source written once and compiled per use: `PARAMETER` has no flags and is safe
 * to share, `everyParameter()` builds a fresh global one from it for each scan,
 * and nothing this module exports is a `RegExp` for a caller to share.
 * `tests/core/path-parameters.test.ts` holds all three of those.
 *
 * ## What keeps the copies from coming back
 *
 * Not this comment. The three copies above had a comment over them too, saying
 * they were one grammar written twice, and a fourth returned to
 * `src/runner/address.ts` past lint, tsc and 1550 tests on the day they were
 * collapsed — as did a second spelling inside this very file.
 * `tests/invariants/one-decision-one-home.test.ts` is the check, and it holds
 * exactly two things about a brace:
 *
 * - no **regular-expression literal** outside this module may carry a brace that
 *   is not a quantifier, with two reasoned exceptions counted exactly, and this
 *   module holds exactly one such literal;
 * - a `RegExp` **built at runtime** is not a literal, so the modules that build
 *   one are enumerated with a count — this one and `./selectors.ts` — and the
 *   string and template literals handed to such a call are read for a brace as
 *   if they had been written as expressions.
 *
 * The second half was added after a fourth copy of this grammar, assembled by
 * `new RegExp` out of a variable, went back into `src/runner/address.ts` with
 * everything green: the first version of this comment said "no regular
 * expression outside this module", and a constructed one was not read at all.
 * What is still not read is a grammar built inside one of the two modules the
 * table already allows to construct one, and a grammar written with no regular
 * expression at all — `indexOf` and `slice` over a brace. Both are in the test
 * file's own list of what it cannot see. See ADR-0060.
 *
 * Handing out no `RegExp` is half of that gate as well as the answer to
 * `lastIndex`: a caller with nothing to copy has to write the grammar out, and
 * writing it out is what the gate reads. `src/core/keys.ts` was given the same
 * shape for the same reason.
 */

/**
 * The grammar. One regex literal, in one place, with no flags on it.
 *
 * `[^}]+` and not `[^{}]+`: the character class is the one all three copies
 * carried, and widening or narrowing it here would change which paths have
 * parameters — a behaviour change dressed up as a rename.
 * `src/adapters/postman.ts` depends on this exact reading, which is why it
 * reduces `{{playerId}}` rather than leaving it to be read as a parameter named
 * `{playerId`.
 */
const PARAMETER = /\{([^}]+)\}/;

/**
 * A fresh global matcher, built from the same literal.
 *
 * `new RegExp(re, flags)` recompiles the source of `re` under the given flags, so
 * this cannot drift from `PARAMETER` — there is no second spelling to keep in
 * step. Fresh per call because `lastIndex` is per object: a shared one would make
 * the answer depend on who asked last.
 */
function everyParameter(): RegExp {
  return new RegExp(PARAMETER, "g");
}

/**
 * Whether the path names parameters at all.
 *
 * Asked by the plan, to decide that an endpoint with parameters and no matching
 * resource has nothing to substitute, and by the canary checks, which refuse a
 * canary on a templated endpoint.
 */
export function hasPathParameters(path: string): boolean {
  return PARAMETER.test(path);
}

/**
 * The parameter names, in the order the template writes them.
 *
 * Read by the core: a resource applies to an endpoint when it has a value for
 * every name the endpoint's path asks for.
 */
export function pathParameterNames(path: string): readonly string[] {
  // `?? ""` is unreachable and stays: the one group of `PARAMETER` participates
  // in every match this grammar can produce, and `noUncheckedIndexedAccess`
  // types it optional all the same. The copy in `src/core/matrix.ts` carried the
  // same fallback, and a rename is no place to decide it should throw instead.
  return [...path.matchAll(everyParameter())].map((match) => match[1] ?? "");
}

/**
 * The path with every `{name}` replaced by what `value` returns for that name.
 *
 * The replacement is used literally — a `$&` in it stands for itself — because
 * `String.prototype.replace` treats the return of a function that way. The caller
 * checks and escapes; anything it throws comes back out of here unchanged, which
 * is how one unusable resource value stops one cell rather than the run.
 */
export function fillPathParameters(path: string, value: (name: string) => string): string {
  return path.replace(everyParameter(), (_match, name: string) => value(name));
}

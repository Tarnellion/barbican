# 0057. The runner is cut at the address

- **Status:** accepted
- **Date:** 2026-08-23

> **Correction, 23 August 2026 (ADR-0060).** One character of the record below
> has been changed, and this note was added above it; nothing else in the file
> moved. (The first version of this note said "one character and nothing else"
> while being nine added lines of its own — a sentence that was not true of the
> paragraph it stood in.) The quoted key under "Noticed and not fixed" held the
> separator as the **raw NUL byte**, which makes a whole file binary to `grep`:
> every search of this repository for the separator answered "no matches" over
> this ADR, and the fixer of ADR-0059 read that silence as "the ADR renders the
> key with a space" and wrote it down. The byte is now the escape `\u0000`, which
> is how `walk.ts` spelled it at the time and so is the more faithful quotation.
> The reasoning is untouched.

## Context

`src/runner.ts` was 1 726 lines and the last of the four large files this month's
splits set out to pay down — after `src/report/build.ts` (ADR-0054),
`src/io/config.ts` (ADR-0055) and `src/cli.ts` (ADR-0056). It did six jobs:

1. deciding which endpoints a run touches and why it skips the rest;
2. building the address — `joinUrl`, the tenant's base URL, the substitution of a
   resource's values into a path template, the query, and the grammar at the
   seam;
3. the canaries: what can be refused before a request exists, and the pass that
   sends;
4. the walk itself, through a pool of workers;
5. the stream of finished cells and the resume that reads it back;
6. reducing a response status — or the error that arrived instead of one — to a
   conclusion about access.

Size alone is not the argument, and this repository has said so twice. The
argument here is that **this file holds more of the security invariants in
CLAUDE.md than any other**, each of them with a test that goes red when the
protection is taken away, and several of them written as an explicit warning
against a future edit: do not move the grammar off the seam, do not reorder the
two spreads, do not send the control request twice. A file nobody opens in full
is a file whose warnings are not read before the next change to the line above
them.

## Decision

**`src/runner.ts` keeps the import path and nothing else**; the layer is
`src/runner/`, six modules, and the barrel is 51 lines of named re-exports.

| module        | lines | what it is                                                             |
| ------------- | ----: | ---------------------------------------------------------------------- |
| `address.ts`  |   193 | where a request goes                                                    |
| `outcome.ts`  |   212 | what came back, and what follows from it — which is usually nothing     |
| `plan.ts`     |    90 | what a run will and will not touch                                      |
| `canaries.ts` |   434 | authentication, confirmed per account before the walk means anything    |
| `stream.ts`   |    72 | one finished cell leaving the walk, and coming back into one            |
| `walk.ts`     |   801 | the walk itself                                                         |

Three of the six are the point of the exercise and the rest follow from them.

### `address.ts` exists because the address has one seam and it must stay one

ADR-0032 is a decision about a place, not about a function: the grammar for an
address moved out of the three adapters that read a document and into `joinUrl`,
"the one place an address is built", because a fourth door had no adapter on it —
`collectObservations` takes `Endpoint[]` straight from a consumer of the library,
and `?_method=DELETE` went on the wire through it with `allowUnsafeMethods:
false`. The whole value of that decision is that the check and the build are not
separable.

A cut that left `substitute` on one side of a module boundary and `joinUrl` on
the other would recreate exactly the state that ADR was written from, with a
boundary in the middle where drift is harder to see rather than easier. So
everything that decides an address is in one file: `joinUrl`,
`baseUrlForTenant`, `substitute`, `withQuery`, `staysWithinTarget`, and the two
error classes they throw.

Two things came with it that a table of contents would have filed elsewhere:

- **`TEMPLATE_PARAMETER`**, which asks whether a path names parameters at all. It
  is read by `planEndpoints` and by the canary checks, neither of which is in
  this file — but it and `PARAMETER_NAME`, four lines from `substitute`, are the
  same `{name}` grammar written twice. The pair now sits where a reader meets
  both. That they are two spellings at all is recorded below as a defect found
  and not fixed.
- **`substitute`'s own warning**, which is the argument for this seam in
  miniature: "`pathSegment` checks and escapes in one step. Written out here as
  two, the check and the escaping could be separated by an edit — and it is the
  pair that holds." The sentence is still true of the file it is in.

### `outcome.ts` exists because `ProbeFailure.reason` has two sources

`ProbeFailure` says why its reason is mandatory: "an `error` with no explanation
makes it impossible to tell a deployment that is down from a wrong
configuration". Exactly two functions in the runner produce that string, and each
was written against that sentence:

- `unreadableStatusReason`, for a status this tool does not read. Its own comment
  quotes `ProbeFailure`'s by name and recounts what was missing before it existed
  — the commonest `error` in a run left no row at all, so `summary.failures`
  stayed 0 and the CLI printed nothing.
- `reasonOf(terminal ?? cause)`, for an error that arrived instead of a status,
  with `terminalCause` beside it because the whole cause chain has to be read and
  a match on the outer name once reported `truncated: false` over three cells
  nobody probed.

`classifyStatus` is here for the same reason as `unreadableStatusReason`: they are
two readings of one list of statuses, and the second exists only for the branch
where the first returns `error`. On two sides of a boundary that list is a fact
written twice.

`ProbeFailure` itself is in this module rather than in the walk that produces it,
so that the sentence `unreadableStatusReason` answers to is on the same page as
the answer.

### `walk.ts` is 801 lines and stays one module

The same argument `run.ts` made in ADR-0056. Nearly every comment inside
`collectObservations` is about the **position** of a line: the resume gate after
the shape of the matrix is known and before the first request; the attribute
check before the credentials are merged over it; the stop honoured before a cell
is recorded, because a recorded cell is one `--resume` will not probe again; the
holes closed only at the end, in place, because a second array would be the
second full copy of the matrix ADR-0053 removed. Cut further, those reasons end
up in whichever file happens to hold the boundary, and none of them can be
enforced from there.

The dependency graph is acyclic and one-way: `address` and `outcome` are read by
everything; `plan` reads `address`; `canaries` reads all three; `stream` reads
`outcome`; `walk` reads all five.

### The import path does not move, and the barrel is a list

`src/runner.ts` re-exports **by name** the twenty-two values and types it exported
before — fifteen values and seven types — so no import anywhere in this
repository or in anybody else's changed, and `src/index.ts` is untouched.

A list rather than `export *`, and here that is load-bearing rather than tidy:
`src/index.ts` does `export * from "./runner.js"`, so anything the barrel
re-exports is on the package's published surface. The six modules export
thirty-two names between them and hand each other the ten the package never
promised — `TEMPLATE_PARAMETER`, `joinUrl`, `baseUrlForTenant`, `substitute`,
`withQuery`, `cellKey`, `failureCode`, `terminalCause`, `reasonOf` and
`unreadableStatusReason` — and a star would publish every one of them.

The modules are unreachable from outside for a second reason as well: the
`exports` map in `package.json` names `.`, `./core`, `./schema/*` and
`./package.json`, so `barbican/dist/runner/address.js` is not an import path a
consumer has.

Under `verbatimModuleSyntax` a type re-exported without the `type` modifier is
emitted as a runtime re-export of a name that does not exist at runtime, and the
package fails at import. Every type in the barrel therefore goes through
`export type`.

### What was not allowed to change, and did not

- **The text.** Every moved line is the original, comments included. Proved
  rather than asserted: the six modules reassembled, with the added `export`
  keywords taken back off, differ from `git show HEAD:src/runner.ts` in nothing
  but the new file headers and the new import lines. No comment was reworded, and
  Biome reformatted nothing in the moved code — `biome check --write` touched one
  file, the barrel.
- **The bytes.** All 29 polygon combinations, each run against a fresh platform
  with fixed tokens: the reports are identical once the run identifier, the
  timestamps, the per-request durations and the per-run digest salt are folded —
  the salted body digests compared by their equality relation rather than by
  value, since that is what the isolation checks read. The 29 stderr transcripts
  and all 29 exit codes are identical too.
- **The public surface.** `git diff src/index.ts` is empty, `docs/library.md` is
  untouched, `dist/index.d.ts` is byte-identical, and the package exports the
  same 227 runtime names in the same order. `dist/runner.d.ts` names the same
  twenty-two.
- **The coverage gate.** `vitest.config.ts` measured `src/runner.ts` by name.
  Left alone, it would have measured a file of re-exports and left the walk, the
  address seam and the canaries unmeasured — the gate lowered by a move rather
  than by a decision. `src/runner/**/*.ts` is added to the include list and given
  the same four thresholds. The totals are the same on both sides of the change:
  2684/2722 statements, 1881/1978 branches, 536/540 functions, 2622/2659 lines.
- **The invariants, at their new addresses.** Four protections taken away one at
  a time and the suite run under each: the `isAddressablePath` guard removed from
  `joinUrl`; the two spreads in the request swapped so an attribute lands over
  the account's own credential header; the canary's control request never sent;
  and the A-8 origin-and-prefix comparison removed. Two, four, one and three
  tests red respectively. The harness refuses to run a mutation whose replacement
  did not apply, which was confirmed against a deliberately wrong one.

### Node 22, checked rather than remembered

Three things this layer relies on were read against the current documentation
rather than recalled, and none of them is deprecated: `signal.addEventListener
("abort", …, { once: true })` in `stopped()` is the documented form, with
`events.addAbortListener` as the stricter alternative (it survives
`stopImmediatePropagation` and returns a disposable) — noted, not taken here;
`error.cause` chaining, which `causeChain` walks, is the documented mechanism;
and `AbortSignal.any` exists in 22 but composes nothing this file needs.

## Alternatives

**Leave it.** Rejected on the same grounds as ADR-0054: the comments are the
asset, and here they are the record of what each adversarial review found and
what must not be undone. The file that holds them was the one nobody would open
whole.

**Cut by the six jobs listed above, one module each** — planning, address,
canaries, walk, stream, status. That is nearly what happened, with one difference
that is the whole decision: "status" is not a subject. The status list and the
sentence about the statuses it cannot read are one fact, and the sentence's twin
for a request that never produced a status is the other half of the same field.
`outcome.ts` is the seam; `status.ts` would have been the table of contents.

**Put `assertCanariesUsable` in `plan.ts`.** Tempting: its five refusals mirror,
one for one, the reasons `planEndpoints` has for not probing, and the comments
say so — which by ADR-0056's rule makes the next such change an edit rather than
an agreement. Rejected for two reasons. `UndiscerningCanaryError` would have had
to go with the other five to keep the error classes in their order, and it is a
statement about a control request rather than about planning. And keeping the six
in one uninterrupted span is what let the stranded comment below travel without
being re-attached, which would have been a fix smuggled in with a move.

**Cut `walk.ts` further** — the resume placement into `stream.ts`, the worker
pool into its own file. Rejected: the resume block needs five locals and a local
interface, so the seam would be a parameter list rather than a subject, and the
reasons for the order of the phases would be spread over files that cannot
enforce them.

## Consequences

**Three guards were re-pointed and one of them properly.**
`tests/docs/envelope-limitation.test.ts` sliced `src/runner.ts` up to
`export function classifyStatus` twice. It now finds the module by the
declaration, off the directory, for the reason `tests/one-walk.test.ts` gives
about a guard of this shape — one that has to be re-pointed by hand every time
the code moves is one that will be left pointing at the wrong file and pass. It
slices the single module that declares the function rather than the layer
concatenated: the assertions are about the text immediately above it, and a
haystack of six files would let another module's comment answer for it. The other
two are prose: `tests/public-surface.test.ts` called `runner.ts` a single file,
and `tests/invariants/transport.test.ts` gave `joinUrl`'s old address in the A-8
mutation recipe.

**Ten names are exported one layer wider than before** — from file-private to
module-public. None reaches the barrel, and the `exports` map keeps the modules
off a consumer's import paths.

**Defects found while reading, and left alone.** A behaviour change arriving with
a move is a change nobody reviewed.

- **A doc comment attached to the wrong declaration.** "A canary the policy
  denies for that account's role" describes `DeniedCanaryError` and sits above
  `UndiscerningCanaryError`, which was inserted between the comment and its class
  on 21 August. `DeniedCanaryError` has had no doc comment of its own since. Both
  blocks moved as one span, in order, untouched.
- **The `{name}` grammar written twice.** `TEMPLATE_PARAMETER` and
  `PARAMETER_NAME` read the same construct with two regexes. They are now in one
  file, which is as far as a move may go; making them one is a change.
- **The endpoint × resource key written twice more.** `cellKey` is the
  single-source key for a *cell*, and it carries a comment about being written
  out by hand once. Two other keys of the same shape,
  `` `${endpoint.id}\u0000${resource?.id ?? ""}` ``, are spelled inline in
  `walk.ts` — one placing a resumed record, one naming the object a write has
  already changed. They agree today and nothing makes them.
- **Two orphaned doc comments of the same kind as the first.** "Checks that the
  accounts really are authenticated." sits above the real doc for
  `assertCanariesUsable`, and "Probes every account × endpoint pair" — which
  describes `collectObservations` — sits above `EndpointPlan`. Both are now in
  different modules from the declaration they describe, which makes them slightly
  more visible and no more correct.
- **A defensive branch the types forbid.** `probeCanaries` re-throws
  `UnknownCanaryEndpointError` for an endpoint `assertCanariesUsable` has already
  refused three lines earlier. Unreachable, and it is one of the two uncovered
  lines in `canaries.ts`.

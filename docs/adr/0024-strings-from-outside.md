# ADR-0024. Strings from outside pass through one place

**Date:** 15 August 2026
**Status:** accepted.

## Context

A string arrives from a configuration file, an environment variable or a
response, and is dropped into a slot with a grammar of its own: a header name, a
header value, a segment of a URL path, a key in a record. The audit of 14 August
2026 counted **eleven point fixes of that shape across four files**, each site
checking what it happened to remember to check.

The evidence that this is a class and not a list:

- The header-value rule was written twice and the copies had already drifted —
  `/^[\t\x20-\x7e]*$/` in `config.ts` against `/^[\t\x20-\x7e]+$/` in the same
  file, differing on whether an empty value is allowed. The header-name rule was
  written twice too, identically, which is the state a duplicate is in right up
  until it is not.
- Where no check was written, `fetch` refused the request from inside the retry
  loop: three attempts, then `RequestFailedError: Cannot convert argument to a
  ByteString`, naming neither the header, nor the value, nor the account (D-6).
  The CLI path was covered; a consumer of the library was not, and the library is
  half of what this package is.
- A signal a human named `__proto__` disappeared from every observation, and so
  did a response header — eighteen lines below a comment promising that the name
  of a header is always kept, because the presence of a header is itself a signal
  (D-2, D-4). Both from a plain object literal, where assigning that key calls
  the prototype setter instead of creating a property.
- `tokenEnv: constructor` returned `Object.prototype.constructor` from the
  environment and failed with `TypeError: value.trim is not a function` instead
  of naming the variable (D-3). The same class had already been recognised and
  closed once elsewhere in that same file.

## Decision

**`src/io/untrusted.ts` holds the grammars, once, and the branded types that
prove a string went through them.**

`HeaderName`, `HeaderValue` and `PathSegment` are strings the compiler will not
hand out without a check. `HttpRequest.headers` and `CredentialProvider.headersFor`
ask for `HeaderValue`, so a raw `Record<string, string>` cannot reach the client
from anywhere — not from the CLI, and not from a consumer of the library. That
is the half that was open.

**The predicates are exported next to the constructors.** Parsing a
configuration knows which context the string came from, and "the header of
context geo-blocked" beats "not usable as a header name" by the whole distance
between a message and a fix. What has to live in one place is the **rule**; who
reports it is the caller's business.

**`openRecord()` for keys the tool did not choose**, built on
`Object.create(null)`, and no validation in it. A target may answer with any
header it likes, and refusing to record one would hand it a way to blind the run.
**`safeHeaders()` for what goes out**, where both halves are checked. **`lookup()`
for reading by a key from outside**, which is `Object.hasOwn` and not indexing.

**The `*`/`+` disagreement resolves to `*`.** An empty header value is legal in
HTTP and legitimate for a declared request condition. Where emptiness is itself
the mistake — a credential read out of the environment — it is caught earlier and
with a better message: which variable was empty, not "unfit as a header value".

The technique is the one this project already applies twice and states as a
principle: `SignalValue` is a number or a boolean, `Account` is a union, and a
duplicate the compiler cannot check drifts apart sooner or later.

## Alternatives

**A fifth point fix.** Rejected on the arithmetic: four sites drifted in a
repository where every one of them has a comment explaining why it is there.

**Validate at the client, on the way out.** One place, no new types, no ripple.
Rejected: it reports the mistake at the furthest possible point from where it was
made — inside a retry loop, on the twelfth cell, with the account not in the
message — and it cannot say *which* declaration was wrong. The check belongs
where the string is accepted.

**A runtime wrapper class rather than a branded string.** Rejected: it would have
to be unwrapped at every boundary, including `fetch`, and an unwrapping is a
place to forget. A brand costs nothing at runtime and is checked at every call
site at once.

## Consequences

- Four defects close: D-2, D-3, D-4, D-6. Each has a test, and each test goes red
  when the fix is reverted — checked one at a time.
- Two regular expressions become zero: `config.ts` and `credentials.ts` no longer
  carry their own copies.
- `pnpm run typecheck` is part of the proof, not only of the build. The D-6 test
  is a `@ts-expect-error` on a `HttpRequest` literal; removing the brand makes
  tsc report the directive as unused, and the gate fails. The first version of
  that test had no type annotation on the literal, so the directive checked
  nothing — and tsc said so, which is the compiler catching a proof that proved
  nothing.
- A trap worth writing down: in an object literal `__proto__:` is **syntax**, not
  a key. The first version of the D-4 test set the header that way, sent no
  header at all, and passed. It uses `setHeader` now.
- A-4 closes alongside: the redaction of addresses inside error text was covered
  by no test — making `safeUrl` return the address unchanged left 574 tests green
  — and now a failure against a URL with userinfo and a query is checked to keep
  the path and drop the rest.
- What is **not** closed: `substitute` now calls `pathSegment`, but the query
  string is still assembled without a branded type. There is no defect there
  today — the values are literals by schema, as D-5 required — and inventing a
  `QueryValue` before there is a second producer would be the duplicate-shaped
  mistake pointing the other way.

## Note of 2026-08-21: "not from a consumer of the library" held for the CLI only

The Decision above says `HttpRequest.headers` and `CredentialProvider.headersFor`
ask for `HeaderValue`, "so a raw `Record<string, string>` cannot reach the client
from anywhere — not from the CLI, and not from a consumer of the library. That is
the half that was open."

The half stayed open, in a shape the sentence did not consider. The types were
right; the module holding them was re-exported by neither index, so from outside
this repository `HeaderValue` was a type with no reachable constructor. A
consumer could not write a compiling provider at all, and the way out of that is
a cast — `as never` type-checks, and a cast is the grammar skipped rather than
applied. The check was not weakened, it was made unreachable, which costs the
same.

Fixed on 21 August 2026 by re-exporting `src/io/untrusted.ts` from
`src/index.ts`, whole: the predicates, the constructors, the four error classes,
and `openRecord`/`lookup` with them. Those last two read as internal mechanics
and are the same rule — a record keyed by names the tool did not choose — which a
consumer holds the moment it reads `observation.headers` out of a report parsed
back from JSON.

The lesson is the one this ADR is already about, one level up: a rule written
once has to be **reachable** once. `tests/public-surface.test.ts` reads `src/io`
now, and requires every error class the source declares to be exported.

## Note of 2026-08-23: the `{name}` grammar, and where a grammar goes when the core reads it too

**This is not a new decision.** It is the twelfth case of the one above, and it
is recorded here rather than in an ADR of its own because nothing in the
Decision needed changing — only its address needed spelling out, for a grammar
the core is one of the callers of.

The same `{name}` template-parameter grammar stood written three times:

- `TEMPLATE_PARAMETER = /\{[^}]+\}/` in `src/runner/address.ts` — is there a
  parameter at all, asked by `planEndpoints` and by `assertCanariesUsable`;
- `PARAMETER_NAME = /\{([^}]+)\}/g` in the same file — the names, for
  `substitute`;
- `PARAMETER_NAME = /\{([^}]+)\}/g` in `src/core/matrix.ts`, **character for
  character** the second, deciding in another layer whether a resource applies
  to an endpoint.

A comment above the first admitted the first two were one grammar in two
spellings. Nothing named the third, and the spelling had already leaked into
prose — a comment in `src/adapters/postman.ts` and one in its test wrote the
expression out by hand to explain why `{{playerId}}` must be reduced. Five
places holding one rule, none of which the compiler compares. This ADR's
arithmetic exactly.

They had not drifted, which is the state a duplicate is in right up until it is
not. What drift would have cost is worth naming: the two in the runner decide
what a run walks, and the one in the core decides which cells exist. A
`{name:int}` learned by one and not the others gives a run that probes a cell
the matrix does not contain, or a matrix expecting a cell the run never walked.

### Where it went, and why not `src/io/untrusted.ts`

`src/core/path-parameters.ts`, and the callers import it.

The file this ADR names is the right home for a grammar the *doors* need. This
one is also read by the core — `resourceApplies` in `src/core/matrix.ts` — and
`src/io/untrusted.ts` already imports `isUsablePathSegment` from
`src/core/types.ts`. A core that imported back would close that ring.

The precedent is that same `isUsablePathSegment`, whose comment states the rule
this note is generalising: it is in the core "because the core builds cells out
of the same values", and `untrusted.ts` reaches down for it rather than keeping
a copy. A path template is read by the core for the same reason — an endpoint is
a cell coordinate. So: **a grammar lives in `src/io/untrusted.ts` unless the core
reads it too, in which case it lives in `src/core` and `untrusted.ts` imports
it.** One rule, one place, at the address the layering allows.

Its own module rather than a few more lines in `src/core/types.ts`, following
`src/core/order.ts` — off `src/core/index.ts` and so off the published surface,
because how the tool reads a template it was handed is not something a consumer
is promised. The package still exported 227 values and `src/index.ts` was
untouched.

### The trap inside the tidying

The obvious way to write one module out of three copies is one `RegExp` with the
`g` flag, shared. That is a defect, not a simplification. A global regex is
**stateful**: `test()` advances `lastIndex` and resets it only on a miss, and
`String.prototype.matchAll` clones the regex *with the `lastIndex` it is handed*,
so a scan following a presence test starts in the middle of the string. Measured
on Node 22: after one `test()` of `/v1/players/{playerId}/orders/{orderId}`,
`matchAll` over that same string yields `orderId` alone.

Through `planEndpoints` that reads as a resource declaring only `orderId` being
taken for one that covers the endpoint, the cell being walked, and `substitute`
sending the request to `/v1/players//orders/1001` — an address the endpoint does
not name, with the endpoint's verdict computed from whatever answers.

So the module keeps one flagless literal, derives a fresh global one per scan
with `new RegExp(PARAMETER, "g")`, and exports no `RegExp` at all.
`tests/core/path-parameters.test.ts` holds the symptom in three tests and the
shape in a fourth, all written against that collapse and watched failing under
it.

### Consequences

- Five spellings of one grammar become one, and one of the five was in another
  layer with nothing pointing at it.
- `TEMPLATE_PARAMETER` no longer exists. It was never on the published surface —
  `src/runner.ts` re-exports by name, and this constant was on the list of what
  the six modules hand each other and the package does not promise.
- Behaviour is unchanged: `/\{[^}]+\}/` and `/\{([^}]+)\}/` match the same
  substrings, and a capture group added to a presence test changes nothing about
  what matches. The polygon oracle answers as it did over all 29 combinations.
- The seam of [ADR-0032](0032-the-grammar-sits-at-the-seam.md) did not move.
  Reading `{name}` out of a template refuses nothing; every guard
  `src/runner/address.ts` owns — `isAddressablePath` before the join, the origin
  and prefix comparison after it, `pathSegment` on each substituted value — is
  still in that file, and the header there says so, because from a distance this
  move looks like the thing that ADR forbids.
- Not closed, and deliberately: `src/adapters/postman.ts` keeps a
  `PARAMETER_NAME` of its own, `/^[A-Za-z0-9_.-]+$/`. It is a different grammar
  wearing the same name — the character set a Postman `:playerId` may use, not
  the shape of a template — and folding two different rules together because
  their constants collide would be this ADR run backwards.

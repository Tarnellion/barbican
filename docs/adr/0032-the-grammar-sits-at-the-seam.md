# 0032. The grammar sits at the seam, not only at the doors

- **Status:** accepted
- **Date:** 2026-08-19

## Context

ADR-0024 says a string from outside has its grammar written once, in
`src/io/untrusted.ts`. On 17 August 2026 `pathTemplate` was added there after
adversarial review found three documents whose path travelled to the platform
verbatim, and the three adapters that read a document were made to call it.

Adversarial review of 19 August went through that guard twice in one afternoon.

**A backslash.** `isUsablePathTemplate` split the string on `/` and looked for
segments equal to `.` or `..`. The URL parser splits http and https paths on `\`
as well, so `/v1/reports\..\..\danger` was one segment to the guard and three to
the parser. The request arrived at `/danger` — an endpoint the configuration had
excluded — and the verdict for `reports` was computed from its answer, with the
report stating that `danger` had been skipped. The same reading applies to tab,
newline and carriage return, which the parser removes from the input before it
reads anything: a segment of `.`, newline, `.` is `..` by the time an address
exists.

**A door with no guard on it.** `pathTemplate` is called by the OpenAPI parser,
the endpoint list and the Postman parser. `collectObservations` takes
`Endpoint[]` from its caller, and this package is published as a library as much
as a CLI — `exports` names four entry points and `docs/library.md` describes them
as a contract. Through that door, with `allowUnsafeMethods: false` and an
exclusion list declared, a path of `/v1/orders/42?_method=DELETE` went on the
wire as written, and so did the backslash form.

Both are the same mistake in two shapes: a check placed on the ways in rather
than on the place the value is used.

## Decision

**The grammar is applied where the address is built.** `joinUrl` in
`src/runner.ts` is the one function that turns a base URL and a path into a
request address, and it now refuses a path that is not addressable before
resolving it. Every door — three adapters and any consumer of the library —
passes through it.

**Two strictnesses, one file.** `isAddressablePath` is the literal grammar: no
query, no fragment, no backslash, no C0 control or DEL, no `.` or `..` segment.
`isUsablePathTemplate` is that same grammar applied to the percent-decoded
spelling, because a template comes from a document and the platform will decode
`%2e`, `%2f` and `%5c` before it routes. The seam deliberately does not decode:
by then the values a resource substituted have been through
`encodeURIComponent`, and decoding would read an escaped identifier back as the
character it stands for and refuse a legitimate resource.

**A backslash is refused rather than normalised.** Folding `\` into `/` and
re-splitting would mean modelling somebody else's normalisation, which is how
the first version was wrong. A path has no use for the character.

The check by value in `src/io/config.ts` was widened in the same pass:
`WRITE_METHOD_WORDS` knew the seven methods this tool can issue, and a platform
honouring an override is not limited to them — `MOVE` deletes the source. The
WebDAV, versioning, binding and ACL methods are in the set now, with `PURGE`.
That set is an enumeration, and it is allowed to be one for the reason the
denylist of header names in ADR-0005's addendum was not: the header names that
will ever carry a secret are unbounded and belong to whoever wrote the platform,
while the methods a platform can be talked into performing are a registered
vocabulary.

## What the second pass added, the same day

The fixes above were attacked again before the day was out, and three spellings
went through them. All three are the same class as the backslash — a string the
receiver reads differently than a split on `/` does — and all three are now in
the grammar:

- **`%2e`.** The seam had been written to read the string literally, on the
  reasoning that only the target decodes. The reasoning was wrong about the
  parser this tool calls on the very next line: the URL Standard calls `.%2e`,
  `%2e.` and `%2e%2e` double-dot path segments, so `new URL` collapsed them
  inside `joinUrl` and the request reached an excluded endpoint again. The
  navigation check therefore reads the `%2e` spelling on both sides of the
  grammar; `%2f` and `%5c` stay undecoded at the seam, because the parser leaves
  those alone and reading them would refuse a legitimate encoded identifier.
- **`..;`.** A servlet container strips `;params` from a segment before it
  normalises the path — the long-standing way past a path-prefix rule in Spring
  Security. The part before `;` is what the navigation check now reads.
- **An absolute or scheme-relative URL as a path.** `new URL(path, base)` gives
  priority to an absolute address, which is why `joinUrl` compares origins — and
  origin does not carry userinfo, so `https://user:secret@host/x` as an OpenAPI
  `paths` key passed the comparison and printed the credentials into
  `observations[].url`. Scheme-relative went a stranger way: `joinUrl` strips
  leading slashes, so `//host/x` became a path *inside* the target that the
  endpoint does not name. The endpoint list and the Postman parser had each
  refused this in their own way; the OpenAPI parser had not, which is the same
  divergence between doors this ADR is about.

The lesson the ADR did not carry the first time, and does now: **the receiver is
not only the platform.** The tool's own URL parser is a receiver, and it
normalises before the platform ever answers.

## Alternatives

**Brand `Endpoint.path` the way `HeaderValue` is branded.** It would put the
refusal in the type system, which is stronger than a runtime check. Rejected for
now: `Endpoint` is a core type and its `path` is a cell coordinate the whole
matrix is keyed by, so branding it changes every fixture, every adapter and every
consumer's build — and the seam gives the same guarantee for the address, which
is what the invariant is about. Revisit if a second place ever builds a request
address; two seams are a reason to move the check into the type.

**Leave the check in the adapters and add a fourth call for the library path.**
That is the twelfth point fix ADR-0024 exists to stop, and it was already the
eleventh: the same value was being checked in three places and not in the fourth.

**Normalise instead of refusing** — trim backslashes, collapse navigation, and
walk what is left. It hides a hostile document instead of reporting it, and the
operator learns nothing about the specification they were handed.

## Consequences

An endpoint whose path carries a backslash, a control character, a query string
or a navigating segment is skipped with `escapes-target` and named in the
report's `skipped`, rather than walked. A canary on such an endpoint stops the
run before any traffic.

A consumer of the library sees a `UnusablePathTemplateError` from
`collectObservations` where it previously got a request on the wire. That is a
behaviour change and it is the point of the ADR.

The cost is one predicate evaluated per cell — a `RegExp.test` and a `split` on a
string this tool already holds.

Revisit if a legitimate platform is found whose paths require a backslash. Then
the answer is an explicit declaration in the configuration, not a hole in the
grammar.

## Note of 2026-08-21: the class a consumer was told to catch was not exported

The Consequences above say a consumer of the library "sees a
`UnusablePathTemplateError` from `collectObservations` where it previously got a
request on the wire", and calls that behaviour change the point of the ADR. The
behaviour changed. The name did not arrive: `src/io/untrusted.ts` was re-exported
by no index, so the class existed in the build and had no name in the package.
What was left to a consumer was `err.name === "UnusablePathTemplateError"` — the
class name copied into somebody else's codebase, checked by no compiler on either
side, against a `docs/library.md` that calls the error classes public on purpose
because `instanceof` needs the class.

Two details of that sentence are worth stating precisely while it is being
corrected. The refusal reaches a consumer as a **skip** from
`collectObservations` — `planEndpoints` marks such an endpoint `escapes-target`,
so one hostile path does not break off the walk — and as a **throw** from
`probeCanaries`, which runs first and stops the run before any traffic. The class
is what a `catch` needs in the second case, and it is what names the first in
`failures[].reason`.

Fixed on 21 August 2026. `tests/public-surface.test.ts` now provokes the throw
through the public surface and asserts `instanceof`, so the class is checked to
be catchable rather than merely present.

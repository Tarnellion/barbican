# 0036. One comparison rule, and it is code units

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Eleven string comparisons in this repository went through `localeCompare()` with
no locale argument. Called that way it compares by the locale the process
started in — the machine's `LC_ALL` or `LANG`. They decided the order of the
finding rows in the report (`src/report/build.ts`), of the defect groups
(`src/core/defects.ts`), of the accounts a body-comparison check pairs up
(`src/core/checks/tenant-isolation.ts`), of the suggestions a configuration error
lists (`src/io/config.ts`), and of the entries `configDigest` is hashed from.

The audit of 21 August 2026 (L-2) ran one matrix under two locales. `LC_ALL=sv_SE`
gave a different row order and a different `configDigest` than `en_US`. Both are
claims this project makes in writing:

- The comment above the finding sort says two runs of the same matrix have to
  produce the same file.
- `docs/report.md` offers `configDigest` as the way to tell "the platform
  changed" from "we changed the declaration". A digest that moves with the
  machine answers that question wrong, in the direction that costs most: two
  identical declarations look like a changed one, so the field a reader consults
  to rule out a false alarm manufactures one.

The consequence beyond order is `MAX_ROWS_PER_DEFECT`. Evidence rows are cut
**after** the sort (ADR-0029), so two machines walking one matrix did not merely
print the same rows in two orders — they kept different rows of the same defect.

`canonical()`, the serialisation `configDigest` is computed over, was the sharpest
form of it: its `Map` branch compared through `localeCompare`, its `Set` branch
and its object-key branch through the default `.sort()`, which is code units. One
function, two rules, and the fingerprint of the whole configuration on top.

## Decision

One comparison rule for every string this tool sorts: **UTF-16 code units**,
written once as `byCodeUnits` in `src/core/order.ts` and called from every sort
whose result a reader or a digest can see.

The module is deliberately not re-exported from `src/core/index.ts`. It is how
this tool arranges its own output, not a contract offered to a consumer of the
library.

## Alternatives

**Pin the locale — `localeCompare(other, "en-US")`.** Reproducible in the same
narrow sense, and the wrong half of the fix. The default `.sort()` cannot be
given a locale, so pinning one means rewriting every plain `.sort()` in the
project into a comparator call and then keeping the next one from being written
plainly — and this repository already has the record of what happens to a rule
that has to be re-applied by hand at every site (ADR-0024: eleven point fixes
across four files, two of which had drifted). Code units go the other way:
`byCodeUnits` *is* what the default sort already does, so a bare `.sort()`
written tomorrow agrees with it by construction.

A pinned locale is also less fixed than it looks. Collation comes from the ICU
data compiled into the Node build — `small-icu` and `full-icu` do not carry the
same tables — and the tables change between ICU versions. Code-unit order is a
property of the string and of nothing else.

**Set `LC_ALL` in the tool's own process.** It would have to be set before the
runtime reads it, which is not something a library can do for its host, and it
leaves the library door open — `groupDefects` and `buildReport` are exported.

**Leave it and document the locale in the report.** A reader comparing two
reports would then have to notice the field, and the digest would still differ
for two identical declarations. Recording a defect is not fixing it.

## Consequences

The order is no longer the one a reader of a Latin alphabet expects in a
dictionary: `Ä` lands after `Z`, and `Z` before `a`. That is the right trade
here. The strings sorted are `id`s out of a run configuration — ASCII in the
overwhelming majority — and what the report needs from their order is that two
machines produce one file, not that a Swedish reader recognises the alphabet.

An existing report gains nothing retroactively: a `configDigest` written by
0.4.0 on a non-`en_US` machine will not match one written now. There is no
migration and none is worth building — the field compares two runs of the same
version, and a project that pinned it would be promising the tables of ICU 74
forever.

`tests/same-order-on-every-machine.test.ts` is the guard. It cannot set two
locales in one process — the default is fixed at startup — so it substitutes the
comparison instead, binding `String.prototype.localeCompare` to a real
`Intl.Collator` for `sv-SE` and for `en-US` in turn and asserting that the report,
the digest, the defect groups, the check's pairs and the error's suggestion list
come out the same under both and under the machine's own. A path that consults
no locale answers the same whatever is bound; a path that consults one does not.

Revisit if this tool ever sorts strings meant to be read as a list in a natural
language — a rendered HTML report grouping by a human-written label, say. That is
a presentation concern and belongs in the renderer, which is a separate step by
ADR-0002; the JSON stays as it is.

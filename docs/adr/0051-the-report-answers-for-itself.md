# 0051. The report answers for itself, as far as a digest can

- **Status:** accepted
- **Date:** 2026-08-22

## Context

Three fields in a report identify something: `runId` says which run,
`configDigest` says which declaration, `tool.version` says which build. None of
them says anything about the **artifact**. `createHash` occurred exactly once in
`src/report/build.ts` and it hashed the configuration.

So the file could be opened in a text editor and changed without a trace. Delete
a row from `findings`, soften a sentence in `verdict.reason`, move
`summary.bySeverity.critical` from `3` to `0` — nothing inside the document would
object, and nothing outside it either. The provenance npm publishes attests to
the package that ran, not to what the run produced.

Two things make that worse than it sounds for this project in particular.

The report is meant to be the basis of a ticket and the raw material of an
evidence pack for a regulator. A document put in front of a certifying body is
normally expected to be checkable for having not been altered; this one had no
way to be.

And ADR-0002 makes the edit spread. JSON is the single source of truth, HTML and
PDF are rendered from it in a separate step — so a doctored JSON is not one
doctored file, it is every form of the document, with the rendering step
laundering the change into something that looks generated.

Found as M-19.

## Decision

A report carries `contentDigest`: a sha256 over the canonical serialisation of
the whole report **except that field**. `checkContentDigest(report)` recomputes
it from a parsed document and answers `{ ok, computed, declared }`.

### What it does not do, said here rather than in a footnote

**It catches carelessness. It does not catch malice.** Whoever deleted the
finding can call `contentDigestOf` and write the new value into the file, and
nothing in this design would know. A digest a reader can recompute is a digest an
author can recompute; that is not a flaw in the implementation, it is what a bare
digest is.

What it does catch is worth having and is most of what actually happens: an edit
made without thinking about consequences, a hand-merge that mangled the JSON, a
truncated download or a copy-paste that lost the tail of a large file, a
"clean-up" pass over a report before it was forwarded. None of those survives the
check, and none of them was visible before.

**The real answer is a signature, and it is deliberately not made here.** Naming
it as future work rather than leaving the reader to assume it exists is the point
of this section. What a signature needs and this ADR does not decide:

- where the private key lives — a CI secret, a hardware token, a signing service
  — and who is allowed to make the tool sign;
- what the verifier holds and how it got it, which is the whole problem, because
  a public key shipped in the same package as the tool proves that the package
  signed the report and nothing about who ran it;
- whether the signature is a field of the report or a detached file, which
  decides whether `schemaVersion` moves;
- what a signed report claims. "This tool produced this file" is not "these
  findings are true", and an evidence pack that blurs the two is worse than one
  that signs nothing.

Until that decision is made, `contentDigest` is an integrity check and
`docs/report.md` says so in the same words as this ADR.

### Over the parsed document, not over the bytes

The same choice `configDigest` already rests on. Indentation, key order and the
trailing newline are the file's formatting, not its content; a reader who
reserialised the JSON to look at it would otherwise be told the report had been
tampered with, and a check that fires on innocent handling trains its reader to
ignore it.

### One canonical serialisation, extended rather than duplicated

`canonical()` already existed in `src/report/build.ts` for `configDigest`, and it
has its own scar: its `Map` branch sorted through `localeCompare()` while its
other two branches used the default `.sort()`, so the fingerprint moved with
`LC_ALL` (ADR-0036). A second canonicaliser beside it would be that defect
waiting to be rediscovered, so there is one and both digests use it.

Two things about it changed, and both were forced by the new reader.

**It is fed to a sink one piece at a time.** `src/report/write.ts` was rewritten
in chunks because the string ceiling — 536 870 888 characters — is reachable on
this tool's ordinary output: a run of 57 826 cells against a platform answering
with 196 headers died at the last step with every request already spent
(ADR-0038). Building the canonical form of a finished report as one string in
order to hash it would put that ceiling straight back, one function further
along. `canonical()` is now the wrapper that joins the pieces, which is fine for
a configuration and is not used for a report.

**A key whose value is `undefined` is dropped rather than written as `null`.**
`JSON.stringify` drops it, so the file on disk does not have it, so a digest
compared against a report parsed back out of that file must not have it either.
This was found the first time the digest was compared with itself across a round
trip: `ReportedAccount.tenant` is `string | undefined`, an account outside a
tenant carries the key unset, and every honest report failed its own check. It is
also the better answer for `configDigest`: `{ exclude: undefined }` and `{}` are
one declaration, and a fingerprint that told them apart was answering a question
nobody asked. `reportChunks` in `src/report/write.ts` makes the same exclusion,
for the same reason, and now the two agree about what is in the document.

### The whole hash, and the field is last

64 hex characters, where `configDigest` keeps 16. That one is a label two runs
are compared by, and a short string is easier to read off a screen; this one is a
check value, and truncating a check value trades collision resistance for
nothing.

The digest is computed after `verdict` and `warnings` are on the report. Those
are the two sentences a reader is most likely to want changed, and a digest taken
before them would cover the file everywhere except where it matters.

## Alternatives

**A signature now instead of a digest.** The right end state and not a thing to
improvise: every question in the list above has to be answered before a key
exists, and answering them badly produces an artifact that looks stronger than it
is, which is worse than one that is honestly weak. The digest is not in its way —
a signature over a document that already carries its own digest is strictly
easier to reason about, because "the bytes changed" and "the signer did not sign
this" stay separable.

**A digest over the file's bytes.** Simpler to implement and wrong for the same
reason `configDigest` is not computed over the YAML text: reindenting a report,
or writing it through a formatter, would read as tampering, and a check that
false-positives on ordinary handling is a check nobody runs twice.

**Put the digest in a sidecar file.** It keeps the report's shape untouched, and
it separates the two things that must travel together. A report is forwarded as
one file, attached to one ticket, pasted into one issue; a sidecar is the half
that gets lost, and the failure mode is silent — the document arrives with
nothing to check it against and looks exactly like a document nobody tampered
with.

**Make a missing digest verify as `ok`.** Kinder to reports written before this
change, and it makes the whole exercise optional: delete the field and the
document is unimpeachable again. `ok` is false and `declared` is `undefined`, so
a caller that wants to be lenient about old files can be, deliberately.

## Consequences

`RunReport` gains `contentDigest` and the package gains two functions,
`contentDigestOf` and `checkContentDigest`. `schemaVersion` stays `2`: a reader
written against `2` is not broken by a field appearing, which is the rule
`tests/report/report-shape.json` records by carrying the new paths with its own
version left alone.

`configDigest` values change for any configuration that carried a key set to
`undefined`. Nothing pins one — no test, no fixture, no document quotes a
value — and the two runs a digest is meant to be compared across are runs of the
same build.

The CLI does not verify anything yet, and nor does anything else in this tree:
this change publishes the field and the two functions, and wiring a `--verify`
into `src/cli.ts` is a separate change with its own surface to design (what it
exits with, what it prints, whether it reads from stdin). Until then the check is
available to a library consumer and to whoever renders the pack, which is where
the question is actually asked.

**Revisit when** the pack has to be handed to somebody who did not run it. That
is the moment "this file was not edited by accident" stops being enough, and the
signature decision above is due — before an evidence pack is offered to an
external body, not after.

## Addendum, 23 August 2026: the field was last, and the document was not

"The whole hash, and the field is last" above is true of `buildReport` and was
false of the tool. The CLI wrote one more field onto the finished report —
`{ ...built, runId }`, which is ADR-0045 putting the identifier the platform saw
into the document the platform's owner gets — one line past the last thing that
hashed anything. So `checkContentDigest` answered `ok: false` for every artifact
this tool had produced: 58 of 58 on the polygon.

The test in this repository was green throughout, because it checks a report
built in memory and round-tripped through `JSON.stringify` — the one report that
never reaches anybody.

`runId` is an option of `buildReport` now, the digest is taken over a document
that already carries it, and the guarantee is proved by running the command and
reading the disk. A report written by 0.5.0 or earlier fails its own check and
cannot be told apart from one that was edited; `docs/report.md` says so rather
than leaving the first reader to run the check and wonder. See
[ADR-0058](0058-a-guarantee-holds-where-the-artifact-goes.md).

# 0043. A catalogue of clauses, so that "covered by nothing" can be said

- **Status:** accepted
- **Date:** 2026-08-21

## Context

`StandardRef` is two free strings — `{ standard, clause }` — and a check declares
a list of them. [ADR-0025](0025-checks-are-plugins-in-fact.md) wired those
references into the report in both directions and named the reason: a clause is
covered by a check that found nothing just as much as by one that found
something, so it took the filter off findings that name no cell, specifically to
make room for the shape "this clause is covered by nothing".

That shape was still inexpressible, and not because the check was unwritten.
**There was nothing to iterate over.** Saying that 8.2.1 is covered by nothing
requires a list of clauses, and no list existed anywhere in the tree except as
prose: `docs/research/tenancy-models.md` section 6 is titled "Identifiers for
mapping findings" and tabulates the ASVS, OWASP API and CWE identifiers with
their sources, and no line of code has ever read it.

Two consequences, and the second is the worse one.

**The completeness of an evidence pack is undecidable.** A pack can enumerate the
clauses some check happened to mention. The question a reader actually brings —
"what did you *not* check" — has no answer, and a pack that cannot answer it is a
list of findings with a standard's name on the cover.

**A misspelt clause number is silent and permanent.** `OWASP-ASVS-5.0 / 8.4.11`
type-checks, registers, runs, and puts a coverage row for a requirement that does
not exist into every report. It fails in the direction nobody audits: an evidence
pack is read for the clauses it omits, never for the ones it should not have
mentioned. There was no registry to resolve against and therefore no way for
anything to notice.

## Decision

**The catalogue is data in this repository and a registry at run time.**
`StandardCatalog` in `src/core/standards/` holds `StandardDefinition`s, each an
identifier, a statement of its own boundary, and a list of clauses. Per instance,
never global, exactly as `CheckRegistry` is and for the same reason.

**A clause carries an identifier, one line of our own, and a source address —
never the standard's own text.** This repository is public and these documents
are distributed under their own terms. The paraphrase is a pointer; `url` is
mandatory so that the pointer resolves, and where the paraphrase and the standard
disagree the standard is right.

**Three standards ship as data, all of them already cited by the tree.** OWASP
ASVS 5.0 chapter V8 (eight clauses), the three authorization entries of the OWASP
API Top 10 2023, and the five access-control weaknesses under CWE-284 — sixteen
clauses, transcribed from the tables in `docs/research/tenancy-models.md` section
6. ASVS is the first standard by the same reasoning
`docs/research/coverage-model.md` had already reached from the other end: it is
public, CC BY-SA, stably numbered within a released version, and 8.4.1 is the one
published requirement that states exactly what this tool checks.

**Every definition states its own boundary, and the boundary travels with the
answer.** No catalogue here is a whole standard: ASVS has fourteen chapters and
CWE has no bottom. `StandardDefinition.scope` says what was catalogued, and every
row of `findUncoveredClauses` carries that sentence. Without it, "8.2.3 is
covered by nothing" reads as a statement about ASVS rather than about sixteen
hand-picked clauses — the same false completeness this ADR removes, one level up.

**A second standard arrives by registration, and that is what makes a private one
possible.** GLI-19 and the AGCO requirements are the standards this project will
need next, and their numbering and text may not go into a public repository at
all. They are registered at run time, from a source this repository never sees,
by whoever holds it and beside the private checks that cite them.
`StandardCatalog.register` is the same door for both kinds, which is why the
whole surface is exported from `src/core/index.ts`: a consumer of the library
needs it as much as the CLI does.

The invariant is therefore stated against the run and not against the repository:
**every reference a check declares resolves against the catalogue assembled for
that run.** On CI here that means the bundled three and the checks this tree
ships, and it is absolute. On a machine holding the private catalogue it is
exactly as strict, over a larger set.

**Two functions read the catalogue.** `findUnresolvedStandardRefs` returns the
references nothing answers to, each tagged `unknown-clause` or
`unknown-standard`; `findUncoveredClauses` returns the catalogued clauses no
check answers for. `tests/invariants/standard-refs.test.ts` applies both to the
checks discovered on the package surface, with no allowance for a standard that
is "not catalogued yet".

The two `reason` values are kept apart because their cures are opposite.
`unknown-clause` is a typo. `unknown-standard` is the ordinary, expected state of
a check citing GLI-19 on a machine where the private definition was not
registered, and it must not read as a misspelling.

## Alternatives

**Validate only the clause, and let an unknown standard pass.** This was the
first shape, and it has a hole exactly where the value is: `OWASP-ASVS-5.O` with
a letter O would resolve to nothing, be classed "a standard we do not catalogue",
and pass in silence. A typo in either half is a typo.

**Keep an exception list for the standards not catalogued yet.** Rejected on this
repository's own standing rule — an entry under `overrides` carries the condition
for its own removal, an exception in `osv-scanner.toml` carries an expiry, and a
list with neither is a pin nobody removes. The strict gate has a real cost: a
check citing a standard nothing catalogues turns CI red until somebody either
catalogues it or stops claiming it. Both are the right move.

**Catalogue ASVS V8 alone, and let the OWASP API and CWE references stay
unresolved as a named backlog.** Rejected for the same reason. It would have made
the gate a comparison against a hand-written allowlist of two, and the allowlist
is the thing that goes stale. Cataloguing all three costs sixteen data entries
and makes the gate absolute — and it demonstrates the registration mechanism
inside the repository rather than only in a test.

**Transcribe the standards whole.** Rejected twice over: it is a transcription
project, and one done from memory rather than from the published document would
put fabricated identifiers into the one artifact whose entire job is to be
authoritative about identifiers. Every clause here was read from a table already
vetted in this repository.

**Derive the catalogue from the checks — collect whatever they cite.** Rejected;
it is [ADR-0006](0006-expected-access-declaration.md) again. A catalogue built
from the references it validates agrees with itself by construction, cannot
detect a typo, and can never contain an uncovered clause.

**Add a `origin: "bundled" | "external"` field so a report could say whether a
clause is verifiable from this repository.** Rejected for now, and the reason is
this ADR's own predecessor: `Check.standards` was declared, filled and read by
nobody for weeks, and ADR-0025 exists because of it. Writing an unread field into
the module that fixes that defect would be a poor joke. It goes in when a reader
does.

## Consequences

- The gate is real and it is absolute. A misspelt clause number, in either half
  of a reference, fails `pnpm run check`.
- Thirteen of the sixteen catalogued clauses are covered by nothing, and
  `tests/invariants/standard-refs.test.ts` pins the list by exact equality — a
  check added, a check's claims widened, or a clause added all move it, and all
  three deserve to be read in a diff. The thirteen are not a backlog of
  oversights: `tenant-isolation.ts` explains why it does not claim API3 or
  CWE-862, and a gap with a reason is still a gap worth printing.
- **The catalogue is not wired into the report.** `findUncoveredClauses` exists
  and nothing calls it in a run. That is deliberate: what an uncovered clause
  looks like in the artifact is a decision about `REPORT_SCHEMA_VERSION` and
  about `src/report/build.ts`, which is being changed on another track. The
  shapes are here and tested; the first consumer is the evidence pack.
- The clause numbers cannot be verified by anything in this repository. Checking
  a transcription against the published standard is a human step, done once when
  a clause is added; what a test can do is pin the list so that a later edit is
  deliberate, and `tests/core/standards.test.ts` does that.
- `docs/library.md` gains a section and its two export counts move.

Revisit when the second standard is real. If registering a private catalogue
turns out to want a file format and a loader, that is an adapter and an ADR of
its own — the core's contract is `register`, and it should not learn to read
files.

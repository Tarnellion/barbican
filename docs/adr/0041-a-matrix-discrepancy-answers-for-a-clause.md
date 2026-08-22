# ADR-0041: a matrix discrepancy answers for a clause too

- Status: accepted
- Date: 21 August 2026

## Context

`ReportFinding.standards` was filled on one branch of `mergeFindings` — the one
fed by the registry — and the field's own comment explained the other branch
away:

> Matrix discrepancies carry none: they come from the declared policy, not from a
> check mapped onto a standard.

That sentence is formally true. `Check.standards` is a declaration a check makes
about itself, and a matrix discrepancy has no check behind it.

It is also a dead end. The matrix channel is privilege escalation and
cross-tenant access — which is everything this tool was written to find. Phase 5
promises a traceability matrix "finding ↔ standard clause"; built from today's
report it would cover one registered check and nothing else. `docs/report.md`
says of `checksRun` that both directions of the citation are needed, "which is
the whole difference between an evidence pack and a list of findings", and the
channel carrying the tool's central claims was on neither direction.

The same document also warns the reader that **the most exploitable defect may
well carry `source: "check"`**. The inverse is what this ADR is about: the most
numerous ones carry `source: "matrix"`, and they were invisible to the clause
index.

Found as M-11.

## Decision

A matrix discrepancy carries `standards`, assigned by `standardsForDiff(kind,
relation)` in `src/core/checks/clauses.ts` and substituted where the report
merges the two channels.

The mapping takes the two axes `severityOf` already takes, and the rule is one
sentence: **the cell decides which control the row is evidence about, and the
kind decides what kind of evidence it is.**

| what | clauses |
|---|---|
| every discrepancy | ASVS 8.1.1 — a declaration and a platform disagreeing |
| the cell names no resource | ASVS 8.2.1 — function-level access |
| the cell names a resource | ASVS 8.2.2 — object-level access |
| the relation crosses a tenant boundary | ASVS 8.4.1 — tenant isolation |
| `kind` is `privilege-escalation` | API1 or API5, matching the level, and CWE-285 |

Three consequences of that table are deliberate and each was the alternative to
something worse.

**Only an escalation claims a defect class.** An unexpected denial is the
platform being *stricter* than the declaration; an unobserved cell and a failed
probe say nothing was learned. Handing any of the three an API Top 10 entry
would be the inflated claim of coverage the isolation check dropped `API3` over —
"being credited with a class of finding it cannot find".

**The two inconclusive kinds still carry the level clause.** "ASVS 8.2.2 was
left unproved on 140 cells" is a statement about 8.2.2, and it has to reach the
clause it is about or the gap attaches to nothing — which is the failure this
whole ADR is against. `kind` and `severity` on the same row say which direction
a citation runs; a reader who wants only demonstrated breakage filters on
`kind`, which they must do anyway.

**Crossing a boundary is stated as "neither of the two relations inside one
tenant"**, not as a list of the three that cross. `own` and `same-tenant` are
exactly the cases where the account is a member of the resource's tenant;
everything else crosses by construction. A list of three would silently drop a
sixth relation, were ADR-0013 ever to gain one.

The clause numbers are chosen by meaning against OWASP ASVS 5.0 and the OWASP
API Security Top 10 2023 — the two families the isolation check already cites —
and reconciled with what that check declares. **No text from either standard is
reproduced**: the repository is public and the standards are distributed on their
own terms, so what sits next to each identifier is a sentence of this project's
own about what the tool takes the clause to mean.

### One place spells a clause; two places assign one

The identifiers move out of `tenant-isolation.ts` into named constants, and the
check imports the same three it used to spell inline. So there are two mappings
and one vocabulary: `standardsForDiff` and `Check.standards` both point at
`ASVS_TENANT_ISOLATION`, by identity rather than by two literals that agree
today. When a catalogue of clauses arrives — `src/core/standards/`, in progress
on another track — it has one module to meet rather than a literal in every check
that was ever written.

A comment claiming that cannot notice the next check written with its clauses
inline, so a test reads `src/` and fails if any module but `clauses.ts` contains
a `StandardRef` literal. `untrusted.ts` collected eleven point fixes of one shape
across four files before that class of rule was written down (ADR-0024); this is
the rule written down at one.

## Alternatives

**Make the matrix channel a registered check — `policy-violation`.** Then
`standards` appears with no mapping at all, and ADR-0003's "checks are plugins"
becomes true to the end rather than true of the second channel only.

Rejected **for now**, and the reason is the blast radius rather than the idea.
The matrix channel is not one more finder of findings: `summary.byKind` holds
kinds of matrix discrepancy and check identifiers in one key space and
`RESERVED_CHECK_IDS` exists precisely to stop a check from taking one of those
names; `summary.verdictInputs` separates `matrixByKind` from
`failingCheckFindings` because `runVerdict` reads a report from anywhere and
never sees the registry (ADR-0029); the exit code is derived from that
separation; and the polygon oracle counts by those same kinds. Moving the channel
means changing all of it at once, and all of it is the machinery the verdict
rests on. Paying that today buys a field that a mapping delivers now.

**Put the mapping in the report layer.** It would be a table of clause numbers
in `src/report/build.ts`, which is the arrangement ADR-0025 undid when it took
`bodyComparison` out of that file: the report carries what a channel declares, it
does not decide it. The mapping is a statement about what a discrepancy *means*,
which is core.

**Derive the clause from the severity.** Cheaper still and wrong: severity is a
property of how bad a finding is, and two findings of equal weight can be about
different controls. ADR-0014 settled severity from `kind × relation` for its own
reasons; reusing the *axes* is right, reusing the *answer* is not.

## Consequences

`findings[].standards` is now present on every row the tool produces. The path
already existed in `tests/report/report-shape.json` — check findings put it there
— so `schemaVersion` stays `2`: a reader written against `2` is not broken by a
field appearing where it was previously absent.

`src/core/checks/clauses.ts` is a second place where a clause is *assigned* and
the only place where one is *spelled*. That is the residual risk this decision
accepts, and it is the smaller half of the original one.

**What this does not deliver, and what makes the rejected alternative
inevitable.** `coverage.checksRun` names the clauses a check exercised *whether
or not it found anything* — the second direction, from a clause to what covered
it. The matrix channel has no such list: a clause the matrix exercised on nine
hundred clean cells appears in the evidence pack only if something went wrong on
one of them. So an evidence pack built on this ADR can say "here is what failed
under 8.2.2" and cannot say "8.2.2 was exercised on the whole surface and held".
That second sentence is the one a certification body asks for.

Making the matrix a registered check produces it for free, because `checksRun` is
the list of what ran. The moment to do it is when the pack has to state coverage
of a clause rather than list findings against it — that is, when phase 5 builds
the traceability matrix proper, and before any external standard is chosen to map
against. It should be its own change with its own ADR, and this one is what buys
the time to make it carefully: `byKind`, `verdictInputs`, the exit codes and the
oracle move together or not at all.

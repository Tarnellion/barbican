# 0039. A finding names the whole cell, and a check that throws takes only itself

- **Status:** accepted
- **Date:** 2026-08-21

## Context

A cell of the matrix is `account × endpoint × resource × conditions`. That is
what `withVerdicts` and `withRequest` key an observation by, and `Finding` — the
shape a check returns — carried three of the four. There was no `resourceId` on
it, and no `relation` either.

So a finding about an object could not be matched to the observation it was made
on. The lookup missed, and the cell came out `match: true` with a finding
standing on it: counted in `cellsMatched`, in a defect group whose `resourceIds`
was empty, with no request to reproduce it with.

Third time this class has been closed. [ADR-0022](0022-one-verdict-per-cell.md)
closed it for the walk, when twelve cells of a reference run printed as agreed
while carrying a high-severity leak; `relatedAccountId` closed it for the second
account of a pair, which used to travel inside `evidence` as a convention nobody
had written down ([ADR-0025](0025-checks-are-plugins-in-fact.md)).

It stayed latent because the registry holds one check and that check compares
whole endpoints, skipping every cell that names a resource. The first check of
Module 2 that judges an object — a BOLA read against a body, the obvious one to
write first — is where it would have stopped being latent.

Beside it, `runChecks` was a `flatMap` with no `try`. It is called after the walk
and before the report is built, so a check that met a shape it did not expect —
the ordinary condition of code reading a system nobody here controls — reached
the CLI's handler, printed "Run aborted" and wrote no file. An hour of traffic
against somebody else's deployment, discarded at the last step.

The argument against that was already written twenty lines further on, where a
failure to write the report prints it to stdout instead: the run is already paid
for in traffic, and losing the result now would mean spending it twice. It had
not been applied one step earlier.

Both found by the audit of 20 August 2026 (D-3, M-13).

## Decision

`Finding` carries `resourceId` and `relation`, and the report maps them through
like every other field.

The relation is carried rather than recomputed. The report groups defects by
`endpoint × relation × conditions`, and a check that knows which resource it
judged knows the relation too; recomputing it in the report would need the tenant
tree at a layer that does not have it, and the two answers would drift the way
two copies of a fact always do.

`runChecks` wraps each `check.run` and each `check.coverage`. A check that throws
is removed from the run and nothing else with it. Its failure becomes a run-level
finding — the shape ADR-0025 introduced for saying something about the run rather
than about a cell — carrying the **class** of the error and never its message: a
bounded vocabulary of symbols cannot hold a URL with a token in it, and a message
from a check written elsewhere is a string this project has audited for nothing.

Severity `high`, not `info`: a check that judged nothing is not a check that
agreed. `coverage` is wrapped the same way and stays silent, because the finding
for that check has already been made and saying it twice would print one breakage
as two.

## Alternatives

**Leave the coordinate off and let checks avoid resources.** What the one
registered check does today, by filtering them out. It makes the shape of the
registry a promise about what checks may judge, and ADR-0003 promises the
opposite.

**Recompute the relation in the report from `resourceId`.** Needs the tenant
hierarchy in the report layer and produces a second answer to a question the core
already answered.

**Let a failing check abort the run.** What was in place. It treats one check's
bad day as a reason to throw away evidence gathered from somebody else's
production, and it makes a crashed check indistinguishable from a clean one for
anybody reading only the exit code.

## Consequences

A check can now name an object, and the report will find its cell. Eleven tests
hold both halves; removing the `try` kills five, dropping the coordinate kills
five of six.

`Finding.resourceId` and `Finding.relation` are additive for a reader of report
schema 2 — the paths already existed on matrix findings.

What this does not do: it does not make the matrix channel a registered check.
That question is [ADR-0041](0041-a-matrix-discrepancy-answers-for-a-clause.md),
and the reasons for leaving it are written there.

## Addendum, 23 August 2026: one lookup was not on the list

The coordinate reached `Finding`, `withVerdicts` and `withRequest`, and the
comment written here named those as the lookups that need it. `relatedRequestOf`
— the one that finds the other side of a paired finding — was not on that list
and kept building its key out of the account and the endpoint alone. Latent for
the same reason this whole ADR stayed latent, and it would have stopped being
latent on the same check: the fourth closing of this class is
[ADR-0058](0058-a-guarantee-holds-where-the-artifact-goes.md).

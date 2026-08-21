# 0046. 410 is read as 404, and the statuses that stay unreadable are named

- **Status:** accepted
- **Date:** 2026-08-21

## Context

`classifyStatus` in `src/runner.ts` turns a response status into a conclusion
about access. It concludes only where the status is unambiguous — `2xx` is
granted, `401`/`403`/`451` is refused, `404` is not served — and calls everything
else an `error`, because stretching `denied` over an ambiguous answer records the
absence of a conclusion as proof of protection.

That decision is right. What was never written down is that the *list* is itself
an assumption, and the review of 21 August 2026 measured what it costs.

**410 was on the wrong side of it.** "Gone" says what 404 says and says it
harder: the resource was not served, and it will not be. `toBinary` in
`src/core/diff.ts` already folds `not-found` into a denial, and the reason it
gives for doing so holds for 410 word for word — telling "410 instead of 403, to
hide existence" from "the object really is gone" needs to know that the object
exists, which belongs to the checks rather than to the base diff. As an `error`
the cell was lost quietly: a `probe-error` is low severity, it is outside the
exit code, and below the half-the-matrix threshold the run still ends in `0`. A
refusal the platform had actually issued simply did not appear in the verdict.

**The 3xx line is worse, and it is not fixable here.** `docs/guide.md` offers
`kind: cookie` as a first-class authentication scheme and describes an operator
console behind a session cookie. The canonical answer such a console gives a
caller it refuses is `302 Location: /login` — not 403. barbican does not follow
redirects, deliberately (the target of one can be outside the host allowlist), so
every denied cell of that surface becomes a `probe-error` and the run comes back
green with the refusals dropped.

The warning that looks like it should catch this cannot. `nothingRefused` fires
on `coverage.outcomes.denied === 0` across the **whole** run, so a configuration
covering an API that answers 401 beside a console that answers 302 never earns
it — and the sentence it prints names a different cause anyway.

Two more classes sit in the same family. `202 Accepted` is read as access
granted, so a platform that queues the request and refuses it in a worker
produces a `privilege-escalation` finding over a refusal arriving a second later.
`405` answers about the endpoint's methods, not about who asked. And soft delete
makes `404` and `410` answer everyone alike, so an empty cell reads as a
protected one — a limit this ADR *adds to*, by moving 410 into the same fold.

## Decision

**410 is read as `not-found`, the way 404 is.** This changes verdicts: a cell
that was a `probe-error` becomes a denial, which may now agree with a policy that
declared it denied, or disagree with one that declared it allowed.

The self-inflicted guard moves with it. A run with `--unsafe-methods` that
deletes an object gets 404 — or, where deletion is soft, 410 — from every later
account, and folding that into a denial would report protection this run
manufactured itself. While 410 was an `error` the guard had nothing to guard,
because an unreadable status is already no conclusion; now it does, so it covers
both.

**The rest of the list is not guessed at. It is named.** A cell whose status this
tool cannot read now leaves a row in `failures` giving the status and why nothing
follows from it, and for a 3xx it says the thing the report cannot show on its
own: redirects are not followed, and a sign-in redirect is how a whole class of
surface refuses. `summary.failures` stops being 0 on such a run, so the CLI
prints `Requests that failed: N (reasons in the report)` in yellow where it
previously printed nothing at all.

And the four classes — a refusal that redirects, an outcome that is not final, a
soft delete, an answer about the endpoint rather than the account — are written
into the README, `docs/guide.md` and `docs/report.md`, beside "a platform that
refuses with 200", which was until now the only member of the family anybody had
recorded. `tests/docs/envelope-limitation.test.ts` holds all four in all three
documents and at `classifyStatus` itself, for the reason that test already
existed: a warning nothing checks survives exactly until the next edit.

## Alternatives

**Read a 3xx as a denial.** It is a guess at somebody else's convention. A
redirect is a redirect: it means "continue over there", and whether "over there"
is a sign-in page, a canonical URL, a trailing slash or a tenant's own subdomain
is a fact about that platform. A run that read the first of those as a refusal
would record denials that never happened on every platform that does the other
three, which is the same failure as the 200-envelope case with the sign flipped.

**Read a 3xx as a denial when `Location` looks like a sign-in page.** Worse than
the above, not better: it derives the expectation from the answer of the system
under test, which is precisely what [ADR-0006](0006-expected-access-declaration.md)
exists against, and it does it through a heuristic over somebody else's URL
scheme. The tool would then be right about `/login` and silently wrong about
`/auth/signin?next=…`, `/sso/start` and a 302 to the tenant's own host.

**Declare it: a `deniedStatuses` list in the configuration.** This is the shape
of the real fix, and it stays undone rather than half-done. The operator saying
"on this platform a refusal looks like this" is a declaration in exactly the
sense ADR-0006 means, and it is where the 3xx case has to end up. It needs to
travel from the parsed configuration through to the walk to have any effect, and
a configuration key the run does not read is a worse artifact than an absent one
— this repository has already shipped a documented flag that had no effect, and
the comment on `CollectOptions.concurrency` is what is left of it. Until the
whole path exists, the honest position is the boundary written down, and a run
that says out loud which cells it discarded.

**Turn an unreadable status into an exit code.** Tempting for the 3xx case and
wrong for the rest: `429` and `503` are ordinary partial failure, and the
half-the-matrix threshold already answers them. What is missing on a redirecting
console is not severity, it is a declaration; giving `probe-error` teeth in
general would fail runs against healthy platforms to catch one class of misread.

**Read 202 as `error`.** It would trade a false escalation for a lost cell on
every platform that answers 202 to an *allowed* asynchronous write, which is the
common case. Nothing in the response distinguishes "queued, and it will be
refused" from "queued, and it will be done". Named as a limit instead.

## Consequences

A cell answered `410` changes kind. Where the policy declared that cell denied,
a `probe-error` becomes a match and the run gets *cleaner*; where the policy
declared it allowed, it becomes an `unexpected-denial` finding and the exit code
can move from 0 to 1. Both are more accurate than what came before, and a
consumer diffing two reports across this change will see it.

`failures[]` grows. Every cell with an unreadable status now has a row, where
before only a thrown request and the self-inflicted 404 did — so a run against a
platform answering 5xx under load, or a console answering 302, carries more rows
and a larger file. The count enters `summary.failures` and nothing else: the
verdict reads `summary.verdictInputs.matrixByKind`, not this, so no exit code
moves because of it.

The 3xx case remains unfixed and is now documented as such in four places. That
is the point of the change rather than a shortfall of it: what a report cannot
be trusted about has to be readable from the report.

Revisit when the declaration exists. The shape to add is a list of statuses the
operator states this platform refuses with, validated to cover only the statuses
`classifyStatus` currently calls `error` — declaring `200` denied would hide the
escalations the 200-envelope section is about, and declaring `403` allowed is not
a statement anyone means to make.

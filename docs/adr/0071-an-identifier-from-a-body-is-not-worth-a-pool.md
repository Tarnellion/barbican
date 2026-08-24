# 0071. An identifier from a response body is not worth a pool

- **Status:** accepted
- **Date:** 2026-08-24

## Context

`plan.md` has carried an open question since phase 2, marked "to be decided in
phase 2, before the detectors of this class are written":

> **Identifiers from responses against the ban on storing bodies.** Some BOLAs are
> reachable only through an `id` from the body of a previous response. The
> proposed direction: extract individual values along paths fixed in the code
> into a short-lived in-memory pool that never reaches the report.

The case that motivated it is crAPI's challenge 1: the identifier of another
user's vehicle is a GUID, and the documented way to obtain it is to read
`author.vehicleid` out of the body of `GET /community/api/v2/community/posts/recent`.
`HttpResponse` deliberately carries no body (ADR-0011), so on the face of it the
whole class is out of reach.

The question was never priced. It is now.

## What was measured

A reconnaissance pass on 24 August 2026 brought crAPI up, tore its volumes down
with `docker compose down -v`, and re-seeded it. **The vehicle GUIDs came back
byte for byte** — five of them, one per seeded user. They are constants of the
seed, not values generated per deployment.

That settles the motivating case without any new machinery: a GUID that survives
a teardown is a value a human can write into `resources[]`, which is what ADR-0010
already says a resource is. crAPI's other identifier-dependent challenge —
challenge 2, a mechanic's report — takes a sequential integer, which was never in
doubt.

Then the same pass went through all eighteen of crAPI's numbered challenges and
asked, for each one that this tool cannot see: **is the body the reason, and is it
the *only* reason?**

- **Challenges 1 and 2** — reachable, by declaring the identifier. No pool needed.
- **Challenges 4 and 5** — the defect *is* the body: an endpoint the account is
  allowed to call returns somebody else's email, or an internal field of a video.
  The status is 200 either way and 200 is correct. A pool that carried the value
  into the next request would not help, because there is no next request; what
  is wrong is the response itself.
- **Challenges 8, 9 and 10** — mass assignment. The verification is a comparison
  of a balance before and after, which the matrix does not model at all: a cell
  is one account against one endpoint under one set of conditions, not a
  before-and-after of the same account.
- **Challenges 3, 6, 11, 12, 13, 15, 16, 17, 18** — brute force, timing, request
  shape, SSRF, injection, JWT forging, LLM prompts. None of them is about a body
  travelling into a later request.

**The count of challenges blocked solely by the ban on storing bodies is zero.**

There is a second reason the proposed direction would not have paid. The pool was
to hold scalars, because `SignalValue` is a number or a boolean and CLAUDE.md is
explicit that extending it to a string needs an ADR of its own — the ban on PII in
the report rests on that type. A vehicle GUID is a string. So the pool as
described could not have carried the one value it was proposed for.

## Decision

**The question is closed, and the answer is no.** No pool, no runtime extraction
of identifiers from response bodies.

An identifier a run needs is declared by a human in `resources[]`, exactly as
ADR-0010 says a resource is, and for the same reason ADR-0006 gives about the
policy: a value the tool fished out of the system under test is a value the
system under test chose, and comparing a platform against something it supplied
is comparing it with itself.

Where an identifier genuinely cannot be declared — because it is generated per
deployment and per user — the honest answer is that the cell is not covered, and
`coverage.notProbed` already says so by name. That is a sentence this tool can
say. "We probed it with an identifier the platform handed us" is not.

## Alternatives

**Build the pool anyway, for platforms unlike crAPI.** Rejected on the evidence
above and on cost: it needs a path language, a lifetime, a redaction story, an
answer for what happens when the value is a string, and a new way for the report
to explain where a probed identifier came from. That is a large surface bought by
a measured zero. If a platform turns up where a per-deployment identifier is the
only route to a real defect, this ADR is the thing to reopen, and the measurement
to bring is the same one: how many defects are blocked *solely* by it.

**Read the body but store nothing.** This already exists, narrowly: ADR-0011 lets
a body be read in transit for irreversible scalars where a human declared
`bodySignals.responseMustDifferByTenant`. It answers a different question — "did
two tenants get the same thing" — and it deliberately cannot carry a value
forward. Widening it into an identifier channel would put a string where the type
forbids one, which is the ADR that would have to be written first.

## Consequences

- `plan.md`'s open question 1 is closed, eleven days after it was raised.
- The bound on what this tool can find is now stated with a number rather than a
  worry: of eighteen crAPI challenges, three are found by a safe run once the
  identifiers are declared, a fourth needs `--unsafe-methods`, and fourteen are
  out of reach for reasons that have nothing to do with this question.
- `docs/polygons/crapi.md` keeps the per-challenge breakdown. This document keeps
  only the decision and the measurement behind it.

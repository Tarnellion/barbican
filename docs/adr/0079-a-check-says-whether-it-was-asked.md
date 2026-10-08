# 0079. A check says whether it was asked, and the pack notices a zero

- **Status:** accepted
- **Date:** 2026-10-08

## Context

[ADR-0052](0052-a-clause-can-be-reported-as-exercised.md) refused to give the check
channel a denominator: a cell count invented for it "would be this record making a
claim it cannot support", and what a check examined is `coverage.byCheck`, in the
check's own terms. That stands. It left one consequence unclosed, and the pre-release
review of `permissive-cors` ([ADR-0076](0076-a-permissive-cross-origin-policy-is-a-registered-check.md))
made it visible: a clause only a check answers for reads
`answered-without-findings` on **any** run where the check ran and reported nothing,
including a run in which no request carried an `Origin`, so the check could not have
found anything. The row's own text says that a check which reported nothing is not the
same as there being nothing to report, and a reader of a pack still gets a claim with
no reservation attached.

Walked through the real code, the defect is not specific to CORS. OWASP API1,
CWE-285 and ASVS 8.4.1 are check-only rows whenever no endpoint carries
`responseMustDifferByTenant`, and they read `answered-without-findings` with zero
pairs compared.

Two things are true of any fix and decide its shape. The core is pure and does not
see the request, so a check cannot know by itself whether an `Origin` was sent; the
layer that builds the contexts can. And a pack cannot name a plugin (ADR-0003), so
whatever it reads has to be generic.

## Decision

**A check may declare, once, which of its own coverage counters says it was put
something to judge** (`Check.reachCounter`, copied into `coverage.checksRun[]`). The
report carries, on every clause row a check answers for, **`checkReach`**: one
`{ checkId, counter, total }` per check on the row that declared one. The total is the
sum of that counter over the check's coverage rows, `0` where it returned none, and it
is the check's own number, copied unchanged.

**The pack notices exactly one thing about it.** If every check on a clause row
declared a reach and every total is `0`, a row that would have read
`answered-without-findings` reads `inconclusive` instead: the clause was reached, the
check ran and was never asked, and nothing was concluded either way. Nothing else
changes. A positive total is carried and not interpreted, with no threshold and no
ratio; a check that declared nothing keeps the reading it always had; a row the matrix
reaches keeps the claim its cells give it and carries the zero for the reader; a
disagreement stands and a run that exited 2 is withheld, as before. The claim
vocabulary does not grow and `ClaimStatus` is not widened.

**`permissive-cors` declares `crossOriginCellsAnswered`**: answered cells that either
sent an `Origin` or got a CORS header back. The CLI, which knows what every context
sends, hands the check the set of contexts that send one (`originContexts`, always
given, an empty set included). The counter is positive on every coverage row the check
emits, so a total of zero means no row: no request invited a header and none came.

## Alternatives

- **A cell denominator for the check channel.** Rejected by ADR-0052 and still
  rejected. This does not give the pack a count of what a check should have examined;
  it lets a check say, in its own terms, that it examined nothing.
- **Leave the pack alone and print the check's counters on the row.** Considered and
  scored lowest by the design panel: a pack reader, the tally and the
  `barbican pack` summary would still see one claim for "asked and found nothing" and
  "never asked", and only a human reading an extra line could tell them apart.
- **A seventh claim, `not-asked`.** Rejected. It widens `ClaimStatus` (an exhaustive
  switch in a consumer stops compiling), adds a required output field, and a pack
  carrying it is refused by a 0.8.x renderer. `inconclusive` already means "reached,
  nothing concluded", and the sentence is extended to say that it covers this too.
- **A reservation code a check raises on the row.** Rejected for now: a typed channel
  from a plugin into the pack's vocabulary, validated on read, is a larger decision
  than a number the check already owns.

## Consequences

- API8 reads `inconclusive` on a run the pack stands behind where no request carried
  an origin, and `answered-without-findings` once an origin was sent and refused. On
  upgrade a pack built from a new report can show `inconclusive` where it showed
  `answered-without-findings`; a pack built from a report written by 0.8.1 or earlier
  carries no `checkReach` and reads as before.
- **Polarity.** Every miss fails open to the reading the pack always had: a check that
  declared nothing, a report that predates the field, a library consumer who built
  `createCorsCheck` without `originContexts`, `byCheck` omitted. Every zero fails
  closed: the pack never says a check was asked when its own count says otherwise.
- Report `schemaVersion` stays `2` and the pack's version stays `1`: the changes are
  additive (`coverage.checksRun[].reachCounter`, `coverage.clauses[].checkReach`). The
  package surface is unchanged in values; new types are `CheckReach`,
  `PackableReach`, `CorsCheckOptions.originContexts` and the two optional fields.
- `src/core/checks/reach.ts` is the one place a named counter is summed.
  `foreignOriginCellsAnswered` now calls it instead of writing the loop again.

### Limits

What this does **not** catch, written down because a gate is described by what it
misses (ADR-0065):

- **A positive total is not a statement about the platform.** One asked cell is asked;
  the pack does not weigh 1 against 900 and does not say what fraction of the surface
  the check was put.
- **A check that does not declare a reach is not helped.** Only a check that can tell
  "I was asked nothing" from "I looked and found nothing" can say it, and the registry
  does not require one to. A third-party check that never declares keeps the weaker
  claim.
- **The library door.** A consumer who sends an `Origin` from their own harness and
  does not pass `originContexts` gets no declared reach and the old reading, which is
  the safe direction. A consumer who passes the wrong set gets a wrong total, and
  nothing here can see that.
- **Nothing reads the CLI's construction of `originContexts` against the contexts the
  configuration declares** beyond the tests that run a stand; a context added later
  that sends an origin by a door this function does not read would not be counted.
- **A zero on a row with several checks is read only if all of them declared.** One
  undeclared check on the row keeps the weaker claim, so a clause answered by two
  checks where one cannot say is never reported as unasked.

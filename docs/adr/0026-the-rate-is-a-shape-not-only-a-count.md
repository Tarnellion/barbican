# ADR-0026. The rate is a shape, not only a count

**Date:** 15 August 2026
**Status:** accepted. Narrows the guarantee of the throttle described in
[ADR-0005](0005-tool-safety-invariants.md).

## Context

`--rps` was enforced by a sliding one-second window: admit while fewer than `R`
starts fall in the last second. That bounds the **count** and says nothing about
the **shape**. At `--rps 5` it lets five go in the same instant and then waits a
second, which satisfies "five a second" while putting five requests on somebody
else's deployment at once.

While the walk was sequential this hardly showed: the round trip spaced the
requests by itself. [ADR-0023](0023-the-walk-is-parallel.md) made the walk
parallel and it showed. Measured against a server counting arrivals, the worst
wall-clock second at `--rps 5` held 6 requests at `--concurrency 1`, 7 at the
default 2, and 9 at 8.

The throttle's own admissions were exact — instrumented, three per window at
`--rps 3` — so this is not a counting bug. Requests admitted at the same instant
reach the socket together, and the compression lands them across a window
boundary. The count is right and the traffic is not what was asked for.

Filed as I-8 while closing I-1, deliberately not fixed there: it changes a
declared invariant.

## Decision

**Admissions are spaced by `1000 / rps` milliseconds, not released in a burst.**
The sliding window stays and stays the authority — it is the declared limit; the
spacing only decides *when* inside it, and in the steady state the two agree.

**Below a two-millisecond gap nothing is shaped.** Two milliseconds is twice the
resolution of the clock the throttle is given. Under that, the rounding is of the
same order as the gap: measured, `--rps 5000` and `--rps 100000` both delivered
about 850 admissions a second while spacing was on, because a sleep of "0.01 ms"
is a sleep of one. A flag that cannot reach what it declares is exactly the
defect I-1 was, in a new place. Above 500 a second the window is the only bound,
as it was before.

**The declared rate is a ceiling the tool stays under, not a target it hits.**
Spacing undershoots: `--rps 50` delivers about 46 a second, because a requested
20 ms sleep takes about 21.7. The error is in the safe direction and is not
compensated — scheduling against an ideal timeline would make the tool burst to
catch up after any pause, which is the behaviour being removed.

## Alternatives

**Leave it and document the burst.** Rejected: "the defaults are deliberately
timid" is a claim about traffic on a system the operator does not own, and five
at once is not timid. The number in the report would keep being true and the
sentence beside it false.

**Compensate the timer error against an ideal timeline.** Rejected above: it buys
exactness at the cost of a catch-up burst, which is the thing this decision
exists to prevent.

**Space by `1000 / rps` at every rate, with no floor.** Rejected on measurement:
it caps the tool at ~850 admissions a second whatever `--rps` says.

**Make the gap configurable.** Rejected: a second knob describing the same limit,
which is the kind of duplicate that drifts. The gap is a function of `--rps` and
has no independent meaning.

## Consequences

- The worst wall-clock second a target sees, at `--rps 5`, goes from 6 / 7 / 9
  (at concurrency 1 / 2 / 8) to 6 / 6 / 6. At `--rps 50` with `--concurrency 16`,
  from 66 to 49. The residual 6 against a limit of 5 is a boundary artifact of
  sub-millisecond arrival jitter and predates parallelism; it is not the burst.
- In-flight concurrency drops on rate-bound runs — measured peak 1 at `--rps 5`
  whatever `--concurrency` says — because with a 200 ms gap and 20 ms latency
  there is never a second request to have in flight. That is correct and worth
  expecting: `--concurrency` cannot beat `--rps`.
- A short run pays for the shape. Five requests at `--rps 5` take 800 ms instead
  of arriving at once. Sixty cells at `--rps 5` went from 11.4 s to 12.1 s, and
  at `--rps 50` with `--concurrency 8` from 1.31 s to 1.50 s.
- Two throttle tests were rewritten. They asserted an exact list of pauses —
  nothing, nothing, nothing, then a full second — which pinned the *shape of the
  old behaviour* rather than the guarantee. They now assert the guarantee: no
  more than `R` starts in any sliding second, and no two starts closer than the
  gap. Reverting the spacing turns one red; removing the floor turns another.
- The boundary at 500 a second is a real edge and is stated in the README rather
  than left to be discovered: below it the traffic is shaped, above it only
  counted.

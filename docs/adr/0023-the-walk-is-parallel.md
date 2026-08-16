# ADR-0023. The walk is parallel, the ceiling is not

**Date:** 15 August 2026
**Status:** accepted.

## Context

`--concurrency` did nothing. `await client.send(request)` sat inside two nested
loops, so exactly one request was ever in flight whatever the flag said: 615
requests at 20 ms latency took 13 766 ms at `--concurrency 1` and 13 754 ms at
128.

The flag was documented in the README's traffic table **and written into the
report** (`inputs.throttle`), which exists precisely so that "the throttle was
on" is not something the reader has to take on faith. So the report asserted
something about the run that had not happened — the same class of defect the
tool is written against, in the tool.

The cost is not only honesty. `tasks.md` records the practical ceiling at about
20 000 cells, and what binds first is walk time, "because the walk is
sequential": 15 minutes at 50 ms RTT with nothing able to shorten it. Dropping
the flag would have made that ceiling permanent.

Found by the audit of 14 August 2026 (I-1).

## Decision

**The walk pulls from a flat list of cells with a pool of workers sized by the
throttle's own limit.** The nested loops become a list built before the first
request; a worker takes the next index and probes it.

**The traffic ceiling does not move, and is not re-implemented.** `client.send`
goes through `throttle.run`, which is where concurrency, the sliding-second rate
window and the per-run budget are enforced. The walk only stops starving it. The
number comes from `throttle.limits` — the single place where defaults and flags
are merged — rather than being read from the flags a second time, or the walk and
the limiter would hold two different values for one limit and the report would
print one of them.

**A caller that passes nothing gets one at a time.** The walk must never be the
wider of the two.

**Not "start every task and let the throttle queue them".** Admission is honest
either way, but that holds twenty thousand pending promises for the whole run,
and the first terminal error has to be dealt out to all of them.

**The observations are drained in the order the cells were laid out**, not the
order they came back. Two runs over the same matrix have to produce the same
file; otherwise a diff between two reports is unreadable and `configDigest` —
which says the input was identical — promises more than the artifact delivers.

## Alternatives

**Drop the flag and document the sequential walk honestly.** Cheap and true on
the day it lands. Rejected because it fixes the report by narrowing the tool: the
ceiling `tasks.md` already names as the first thing to bind would become
permanent, and the throttle — which exists to bound exactly this — would keep
enforcing a limit nothing could reach.

**Keep the flag, stop printing it.** Rejected: a flag that does nothing is the
same divergence between word and deed, moved somewhere less visible.

**Parallelise inside the throttle instead.** Rejected: the throttle is a port,
and a port that decides how much work to invent is no longer a limiter.

## Consequences

- Measured on a target answering in a fixed 20 ms, 610 cells with the rate limit
  lifted: 14 127 ms at `--concurrency 1`, 3 776 at 4, 1 137 at 16, 543 at 64.
  All 610 observed in every case, in an identical order.
- **At the defaults nothing changes**, and that is worth stating plainly: 60
  cells at `--rps 5` take 11 407 ms at concurrency 1 and 11 308 at 8. The rate
  limit binds first. The flag matters on a deployment you have been allowed to
  probe faster, or where latency is high.
- The in-flight peak equals the limit and never exceeds it: measured 1, 4 and 16
  against the same values, and 5 when `--rps 5` bound before the pool did. The
  test pins both halves — reverting the pool to sequential turns one red,
  removing the cap turns three red.
- The circuit breaker's "consecutive" now means "this many with no success in
  between", failures being interleaved, and up to `concurrency - 1` requests are
  already in flight when it trips. Bounded by the limit, and the limit is the
  thing the operator agreed to.
- What the **target** sees in a wall-clock second can exceed `--rps`, and by a
  little more than before: at `--rps 5` a server counting arrivals saw a worst
  second of 6 at concurrency 1, 7 at the default 2, and 9 at 8. The throttle's
  own admissions are exact — instrumented and checked, three per window at rps 3
  — and the excess is arrival compression between admission and the socket. It
  is recorded as I-8 rather than fixed here: pacing admissions is a change to a
  declared invariant and deserves its own decision.
- A trap worth leaving written down. The first version of the new throttle test
  read the clock inside the task and appeared to catch four admissions in a
  second where three were declared. Instrumenting `admit` showed exactly three
  per window: the clock is shared and moves in jumps, so a task admitted at 0
  runs its body after another caller's `sleep` has moved the clock to 1000. What
  a task sees is not when it was let through. The test asserts on the pauses
  instead.

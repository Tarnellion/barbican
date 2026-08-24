# 0072. The suite is as long as its longest file

- **Status:** accepted
- **Date:** 2026-08-24

## Context

`pnpm run check` took 21.3 s on a ten-core laptop, and 19.0 s of that was the
test run. Vitest's own summary said where it went:

```
Duration 18.4s (transform 1.8s, setup 0ms, import 12.6s, tests 48.3s, environment 7ms)
```

Import was the largest line after the tests themselves, and nothing in this
repository had ever looked at it. The obvious suspect was the barrels: 74 of the
126 test files import `src/index.js`, `src/core/index.js`, `src/report/build.js`,
`src/io/config.js` or `src/runner.js` rather than the module they are about, and
a barrel pulls its whole subtree into every worker that touches it.

That suspect is innocent, and the measurement that clears it is worth keeping,
because it is also the reason the rest of this document exists.

**The three figures in that line are sums across workers; the Duration is not.**
Vitest 4 reports `collectDuration` per test module and, under
`experimental.importDurations`, `selfTime` per imported module. Read per file,
the suite is not 126 files sharing 18.4 s. It is two files:

| file | import | tests |
| --- | --- | --- |
| `tests/invariants/cli-surface.test.ts` | 0.06 s | 18.2 s |
| `tests/cli.test.ts` | 0.22 s | 14.9 s |
| the other 124, together | 12.5 s | 15.1 s |

The two ran beside each other on separate workers, and everything else finished
underneath them: with those two excluded, the remaining 124 files complete in
**5.2 s** with their import time unchanged. The suite's duration was the longer
of the two files, plus a little. The file that set it imports 63 ms of modules.

**The ceiling on the barrel idea, measured without editing an import.** Running
with `--no-isolate` makes each worker import each module once instead of once per
test file. That takes the reported import figure from 12.6 s to 5.4 s — more than
any change to *which* modules 74 test files name could ever remove, since it
removes the repetition itself. The wall clock moved from 12.00 s to 11.06 s
(medians of three interleaved rounds). **Halving the import time buys 0.94 s.**
Rewriting the tests' imports cannot beat that bound, and on the file that sets
the duration it would do nothing at all.

**What the two files were actually spending it on** is
`DEFAULT_THROTTLE_LIMITS`. Since ADR-0026 five requests a second is a *pace* and
not only a ceiling: `minimumGapMs` holds every start 200 ms apart, so the
smallest useful run — one account, one endpoint, a canary — takes about 800 ms
against a stub on loopback that answers in under a millisecond. Nineteen of the
twenty-six tests in `tests/cli.test.ts`, and ten of the sixty in
`cli-surface.test.ts`, were sleeping through that while asserting about the
screen, an exit code or the shape of a report. One call site had already noticed
and passed `--rps 200 --concurrency 8`, with the reasoning written beside it:
"fifty-two
cells at the conservative default of five a second is ten seconds of waiting for
a local stand to answer itself."

## Decision

**A test that drives a local stand and is not about the pace passes
`FAST_STAND`.** The pair lives once, in `tests/fixtures/local-stand.ts`, with the
reasoning and the two rules for using it; the six sites in `tests/cli.test.ts`
and `tests/invariants/cli-surface.test.ts` that drive a walk take it from there,
including the one that used to write it out.

Not applied to the interrupted and resumed runs, which pass `--rps 50` of their
own: they need the walk still to be going when the signal arrives, so there the
slowness is the fixture. Not applied as a way to settle a flaky test — it removes
waiting, not work.

Nothing about the pace stopped being tested. `tests/adapters/throttle.test.ts`
holds `DEFAULT_THROTTLE_LIMITS` with an exact `toEqual`, holds the README table
built from the same constant, and drives the throttle through a test clock — so
it proves the 200 ms spacing without waiting for it either.

**And the general rule the measurement bought:** the suite's duration is not a
budget shared among 126 files. It is the longest file. A change that does not
shorten the longest file does not shorten the suite, whatever it does to a
summed figure. Before optimising anything here, read `collectDuration` and
`duration` per module and find out which file is the wall clock.

## Alternatives

Each was measured on this tree, not reasoned about.

**Rewrite the tests' barrel imports to name the module under test.** Ceiling
under 0.94 s by the bound above, and zero on the critical path, which imports
63 ms. Rejected. (`tests/public-surface.test.ts` and
`tests/invariants/cli-surface.test.ts` would have had to keep the barrel anyway:
for those two the barrel is the subject.)

**`isolate: false`.** −0.94 s (12.00 s → 11.06 s, medians of three). Rejected.
Four test files import `src/cli.ts` — a module that runs `parseAsync` at the top
level, so importing it is running the command — and all four call
`vi.resetModules()` to make the next import execute rather than return the cache.
Without per-file isolation those four share the registry they are each resetting,
alongside `process.argv` and `process.exitCode`, which they already save and
restore by hand. The suite passes with `--no-isolate` today; that is a fact about
which worker took which file, and 0.94 s is not the price of a standing hazard of
that shape.

**`pool: "threads"`.** 11.94 s against 12.00 s, and 11.12 s against 11.06 s with
isolation off as well. Nothing, in both directions. Rejected for having no effect
to argue about.

**`describe.concurrent` on the 33 flag-refusal tests in
`tests/invariants/cli-surface.test.ts`.** −2.4 s in that file, which is the file
that sets the duration. Rejected on what it does to the assertion: each of those
tests reads `stub.seen.length`, refuses a flag, and asserts the number did not
move — "this refusal put nothing on the wire". Run concurrently the sentence
becomes "nothing was on the wire while these five ran", which is true only while
every test in the block is `--dry-run` and is a trap for whoever adds the first
one that is not. The 2.4 s is real and the number is here so somebody can weigh
it again.

**Split `tests/invariants/cli-surface.test.ts` so its parts run on separate
workers.** Rejected on cost, not on principle: the file is named by path in
eleven places — four ADRs, `vitest.config.ts`, five other test files and
`src/cli/run.ts` — and a split that leaves those stale trades seconds for exactly
the kind of document this repository keeps having to repair.

**Import the subcommand modules lazily in `src/cli.ts`.** `node dist/cli.js
--help` takes 96 ms against 22.5 ms for a bare `node -e ''`; the 74 ms difference
is `zod`, `yaml` and `@apidevtools/swagger-parser` loading for a run that may
never touch them, and this suite pays it about 60 times, some 4.4 s. It is the
largest single number left. Rejected **here**: it is a change to the entry point
whose shape ADR-0056 calls load-bearing, it would be visible to every operator
rather than only to the suite, and it belongs to a decision about the tool taken
on its own evidence — not to a round about how long a contributor waits.

## Consequences

- `pnpm run check`: 21.34 s → 14.84 s (medians of three interleaved rounds, both
  sides green). `pnpm run test`: 18.36 s → 12.12 s.
- Worker test time 48.3 s → 28.5 s. Reported import time did not move — 12.2 s
  before, 12.8 s after — which is the whole point: the run got a third shorter
  and the number this was started to look at went up.
- Coverage is identical to the statement: 3307/3362, 2277/2399, 705/714,
  3220/3273. No branch stopped being reached, which is the check that the tests
  are still doing what they did.
- `node polygon/verify.mjs`: 29 combinations, 0 mismatches.
- The duration is now set by `tests/invariants/cli-surface.test.ts` at about
  9.7 s, of which roughly 5.7 s is 60 `node dist/cli.js` process startups. That
  is the next thing to attack, and the two candidates with numbers beside them
  are in **Alternatives** above.
- Revisit when a single test file goes over about 6 s again. The instrument is
  `--experimental.importDurations.limit=<n>` and a reporter reading
  `TestModule.diagnostic()`; it took an afternoon to find out the answer was one
  file, and the table at the top of this document is what a second afternoon
  should not have to rediscover.

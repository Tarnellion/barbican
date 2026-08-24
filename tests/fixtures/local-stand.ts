/**
 * The throttle a test drives a local stand with.
 *
 * `DEFAULT_THROTTLE_LIMITS` is five requests a second, and since ADR-0026 that
 * is a *pace* and not only a ceiling: `minimumGapMs` holds every start 200 ms
 * apart, so the smallest useful run — one account, one endpoint, a canary — takes
 * about 800 ms of waiting for a stub on loopback that answers in under a
 * millisecond. Measured on 24 August 2026: `tests/cli.test.ts` and
 * `tests/invariants/cli-surface.test.ts` ran 13.2 s longer than the other 124
 * files put together, and the suite's wall clock is the longer of those two,
 * because everything else finishes underneath them. **Taking the pace off those
 * two returned 6.2 s** of the 18.4 — 17.19 s to 11.00 s on the run that measured
 * it. The 13.2 is the gap between the two files and the rest; the 6.2 is what
 * the pace itself cost, and an earlier version of this comment said the first
 * number where it meant the second.
 *
 * Passing this to a test that is about the screen, the exit code or the shape of
 * the report is therefore not a shortcut: the pace is not what those tests are
 * looking at, and none of them asserts anything about it. What holds the pace is
 * `tests/adapters/throttle.test.ts` — an exact `toEqual` on
 * `DEFAULT_THROTTLE_LIMITS`, plus the README table built from the same constant —
 * and `tests/adapters/throttle.test.ts` drives the throttle through a test clock,
 * so it proves the spacing without waiting for it either.
 *
 * Two rules for using it:
 *
 * - **Not on a test that is about the pace, or about interrupting a run.** The
 *   interrupted and resumed runs in `cli-surface.test.ts` pass `--rps 50` of
 *   their own: they need the walk still to be going when the signal arrives, so
 *   there the slowness is the fixture.
 * - **Not as a way to make a flaky test pass.** It removes waiting, not work.
 *
 * The pair was written out at one call site with this reasoning beside it before
 * it was written here; it is one decision and it now has one home.
 */
export const FAST_STAND: readonly string[] = ["--rps", "200", "--concurrency", "8"];

/**
 * What a run's command line says, and what a value on it is allowed to be.
 *
 * The shape and the grammar together: they are two halves of one statement
 * about the same flags, and the grammar exists because one of those flags is a
 * limit on traffic against somebody else's deployment.
 */

import { InvalidArgumentError } from "commander";

/**
 * The digits an operator typed, and not everything `Number()` is willing to read.
 *
 * A limit is not merely a number here: `--rps` divides a second by it, and
 * `--max-requests` is the ceiling on traffic against somebody else's deployment.
 * Written as `Number(raw)` guarded by `Number.isInteger`, the flags accepted
 * `1e23` — an integer by both tests, and a `minimumGapMs` of 1e-20, which leaves
 * the sliding window admitting every request the instant it arrives. That is the
 * "no limits" mode the project says must not exist (ADR-0005 and the throttle's
 * own comment), reached by a form of writing rather than by a decision.
 * `0x10`, `0b101`, `5.0` and `" 5 "` passed the same way: each a limit the
 * command line did not say and the report then recorded as declared.
 *
 * So what is refused is the **notation**, not the magnitude. Decimal digits, and
 * a value `Number.isSafeInteger` vouches for. No ceiling is invented on top of
 * that: an operator raising a limit deliberately is doing their job, and
 * `--rps 100000` remains theirs to ask for. Above 2^53 the refusal is not about
 * taste either — integers stop being exact there, so the number enforced would
 * not be the number written.
 *
 * Found by the audit of 20 August 2026 (C-4/H-8).
 */
const DECIMAL_DIGITS = /^[0-9]+$/;

export function positiveInteger(raw: string): number {
  if (!DECIMAL_DIGITS.test(raw)) {
    throw new InvalidArgumentError(
      "a positive integer in decimal digits is expected. Exponent, hex and binary " +
        "notation, a decimal point and surrounding spaces are refused rather than " +
        "read: Number() turns them into limits nobody typed, and --rps 1e23 is the " +
        "no-limits mode this tool must not have",
    );
  }
  const value = Number(raw);
  // A negative number cannot arrive — the grammar above has no sign — so this is
  // zero, and zero reads as "no limits" exactly the way the throttle refuses it.
  if (value <= 0) {
    throw new InvalidArgumentError(
      "a positive integer is expected: zero is not a limit, it is the absence of " +
        "one, and this tool has no mode without limits",
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new InvalidArgumentError(
      "a positive integer is expected, and this one is past 9007199254740991, " +
        "where integers stop being exact — the limit enforced would not be the " +
        "limit written",
    );
  }
  return value;
}

export interface RunFlags {
  readonly config: string;
  readonly spec?: string;
  readonly endpoints?: string;
  readonly postman?: string;
  readonly report?: string;
  readonly unsafeMethods?: boolean;
  readonly dryRun?: boolean;
  /**
   * Whether the run names itself on the wire. On unless `--no-identify` is given.
   *
   * commander fills this in for every run, so the value is never really absent;
   * it is optional here because `describePlan` and the tests build a `RunFlags`
   * by hand, and a default that has to be repeated in three places is a default
   * that will disagree with itself. `flags.identify !== false` is the reading
   * everywhere.
   */
  readonly identify?: boolean;
  readonly checks?: string;
  readonly concurrency?: number;
  readonly rps?: number;
  readonly maxRequests?: number;
  /** Continue the walk the stream beside `--report` was left in the middle of. */
  readonly resume?: boolean;
}

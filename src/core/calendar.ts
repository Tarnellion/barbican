/**
 * One grammar for the one date format this tool reads.
 *
 * Not exported from `src/core/index.ts`, and so not part of the package's public
 * surface: it is how this tool reads a date an operator wrote, not something a
 * consumer is promised. It lives in its own module for the reason `order.ts`
 * beside it does — the alternative is the shape ADR-0024 was written against,
 * the same string grammar decided separately in several files.
 *
 * It was decided in three, as two different regular expressions: the schema's
 * `.regex()` on `accepted[].until`, the schema's own `isCalendarDate` behind it,
 * and `acceptanceExpiresAt` in `src/core/accepted.ts`. All three agreed, and the
 * one direction in which they could stop agreeing safely was documented — a
 * format the expiry arithmetic cannot read yields `NaN`, `NaN` compares false,
 * the acceptance reads as lapsed and the finding is reported again. The other
 * direction has no such floor: loosen the schema alone and a string the schema
 * admits reaches an arithmetic that cannot read it, which is a deadline the file
 * states and the run does not honour. A suppressed finding is the one outcome of
 * this feature that nobody notices. See ADR-0064.
 *
 * In `src/core` and not in `src/io/untrusted.ts` beside the other grammars,
 * because the core may not import `src/io` and `acceptanceExpiresAt` is core.
 * The layering decides the direction: `src/io/config/schema.ts` reaches down to
 * this, and nothing here reaches up.
 */

/**
 * `YYYY-MM-DD`, and nothing else.
 *
 * Anchored at both ends: `2026-11-30T00:00:00Z` is not a date this tool reads,
 * and half-reading it would give a deadline nobody wrote.
 *
 * The expression itself is what the schema shares, not a predicate over it —
 * zod's `.regex()` wants a `RegExp`, and one without the `g` flag carries no
 * state between calls. Which is also why it has no capture groups even though
 * `calendarDayOf` below wants the three numbers: this pattern is copied verbatim
 * into `schema/barbican.run.schema.json`, a file that ships and that editors
 * complete a configuration from, and adding parentheses to it would rewrite a
 * published artifact to say the same thing. `split` costs a line and changes
 * nothing anybody downstream can see.
 */
export const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A day that exists, in the numbers a person wrote rather than a `Date`. */
export interface CalendarDate {
  readonly year: number;
  /** 1-12 as written, not the 0-11 `Date` counts in. */
  readonly month: number;
  readonly day: number;
}

/**
 * The three numbers, and only where they name a day that exists.
 *
 * The regular expression admits `2026-11-31` and `2026-13-01`; `Date.UTC` rolls
 * both over into a different day without complaint, which would leave the file
 * saying one date and the run honouring another. Building the date and reading
 * the three fields back is the check — a calendar written here would be a second
 * implementation of one somebody else already ships.
 *
 * `undefined` rather than a throw: both callers have a safe answer for an
 * unreadable date and neither wants an exception at that point — the schema
 * turns it into a validation message naming the line of the file, and the expiry
 * arithmetic turns it into `NaN`, which compares false and leaves the acceptance
 * lapsed.
 *
 * UTC throughout, for the reason `acceptanceExpiresAt` gives: a verdict that
 * changes with the timezone of whichever runner picked the job up is the same
 * defect as a sort order that changes with `LC_ALL` (ADR-0036), and worse,
 * because what moves is whether a finding fails the build.
 */
export function calendarDayOf(value: string): CalendarDate | undefined {
  if (!CALENDAR_DATE.test(value)) {
    return undefined;
  }
  const parts = value.split("-");
  const date = { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
  const built = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const exists =
    built.getUTCFullYear() === date.year &&
    built.getUTCMonth() === date.month - 1 &&
    built.getUTCDate() === date.day;
  return exists ? date : undefined;
}

/**
 * Whether the string names a day that exists — the same question, as a predicate.
 *
 * Separate from the shape alone because the schema asks the two halves for two
 * different messages: `30/11/2026` is not the format, and `2026-11-31` is the
 * format naming a day there is not. One sentence for both would send the reader
 * looking for the wrong mistake.
 */
export function isCalendarDate(value: string): boolean {
  return calendarDayOf(value) !== undefined;
}

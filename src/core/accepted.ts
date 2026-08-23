/**
 * A finding the operator has seen, accepted, and given a deadline.
 *
 * The model had exactly one channel for intent — `ExpectedAccessPolicy` — and it
 * carried two statements at once. "This access is meant to exist" and "this
 * access is not meant to exist, we know it does, and it is scheduled for the
 * next quarter" had one spelling between them: declare the cell allowed. After
 * which the finding is gone from the report entirely — no row, no defect group,
 * `match: true` — which is the difference ADR-0006 separated the declaration
 * from the specification to preserve, erased one layer up.
 *
 * The second cost is about the tool being adopted at all. A team whose first run
 * finds forty things cannot put barbican in CI until all forty are fixed, and
 * what happens instead is that the step comes out of CI. See ADR-0048.
 *
 * An acceptance is therefore a **second** channel, and it says something the
 * policy cannot: the finding stands, it stays in the report with its severity
 * and its evidence, and it is held out of the verdict until a date the operator
 * named.
 */

import { calendarDayOf } from "./calendar.js";
import type { DefectCoordinates } from "./defects.js";
import { defectSignature } from "./defects.js";
import { joinKey } from "./keys.js";

/**
 * One accepted finding, in the core's own vocabulary.
 *
 * The declaration a human writes is `accepted[]` in the run configuration, which
 * spells the coordinates `endpoint`/`context` the way the rest of that file
 * does; `parseRunConfig` converts, exactly as it does for a resource's `tenant`
 * and `owner`.
 */
export interface Acceptance extends DefectCoordinates {
  /**
   * The way this defect showed itself: a kind of matrix discrepancy, or the id
   * of the check that found it.
   *
   * Part of the key although ADR-0030 took it out of the defect signature — the
   * two questions are different. "How many things are broken here" answers once
   * for an endpoint that fails by status and by body alike; "what did the
   * operator look at and accept" answers about the one they looked at. A defect
   * that starts failing a second way is a finding the acceptance has not seen,
   * and it has to arrive as one.
   */
  readonly kind: string;
  /**
   * Why it is accepted. Required, and not for the file's sake.
   *
   * The rule this borrows is the one about `overrides` in `pnpm-workspace.yaml`:
   * a standing decision about somebody else's tree that carries no condition for
   * its own removal is a pin nobody notices. A suppression with no reason beside
   * it is the same object.
   */
  readonly reason: string;
  /**
   * The last day the acceptance holds, `YYYY-MM-DD`, inclusive, in UTC.
   *
   * Required for the same reason. Past it the finding counts again — see
   * {@link isAcceptanceInForce}.
   */
  readonly until: string;
  /** Where the fix is tracked. Optional: not every team has a tracker to cite. */
  readonly ticket?: string | undefined;
}

/**
 * The key an acceptance and a finding meet on.
 *
 * The defect signature — endpoint, relation, conditions — plus the kind. Neither
 * the account nor the resource is in it, and that is the whole of the addressing
 * decision: a key carrying the resource would come apart at the first new
 * resource declared for the same endpoint, which is an acceptance that expires
 * for a reason having nothing to do with the platform. A key carrying only the
 * endpoint would be the opposite failure — "everything on this endpoint",
 * including the cross-tenant leak nobody has looked at yet.
 *
 * `defectSignature` and not a second spelling of it: the grouping already
 * answers the question "which findings are one breakage", and asking it twice is
 * how two answers drift apart.
 */
export function acceptanceKeyOf(of: DefectCoordinates, kind: string): string {
  // The separator the signature already uses, and now literally the same
  // joining: `joinKey` in `./keys.js`, which is where the character lives and
  // the only place it is spelled — ADR-0060.
  // A space stood here first and is precisely what the signature's own reason
  // forbids — an endpoint id ending in a space, with no conditions, glues to
  // the same string as its neighbour with the kind read as part of the context.
  return joinKey(defectSignature(of), kind);
}

/**
 * The declarations arranged for lookup.
 *
 * A `Map` and not a scan, because this is asked once per finding and a run with
 * a wide first-time acceptance list has plenty of both. Duplicate keys are
 * refused when the configuration is parsed, so the last writer never decides
 * anything here.
 */
export function indexAcceptances(
  acceptances: readonly Acceptance[],
): ReadonlyMap<string, Acceptance> {
  return new Map(
    acceptances.map((acceptance) => [acceptanceKeyOf(acceptance, acceptance.kind), acceptance]),
  );
}

/** The acceptance covering this finding, if one was declared. */
export function matchingAcceptance(
  finding: DefectCoordinates & { readonly kind: string },
  index: ReadonlyMap<string, Acceptance>,
): Acceptance | undefined {
  return index.get(acceptanceKeyOf(finding, finding.kind));
}

/**
 * The first moment the acceptance no longer holds, as a UTC timestamp.
 *
 * The day after `until`, because a date written next to "accepted until" reads
 * to a person as inclusive of that day. `Date.UTC` does the calendar: passing
 * `day + 1` rolls a month and a year over on its own, and arithmetic of our own
 * here would be a small parser of somebody else's format, which is the shape
 * ADR-0032 warns about.
 *
 * UTC and not the machine's zone. A verdict that changes with the timezone of
 * whichever runner picked the job up is the same defect as a sort order that
 * changes with `LC_ALL` (ADR-0036) — and worse, because what moves is whether a
 * finding fails the build.
 *
 * The format is checked when the configuration is parsed; a string that reached
 * here in some other shape yields `NaN`, and `NaN` compares false, so the
 * acceptance is treated as lapsed. That is the safe direction: a finding
 * reported is recoverable, a finding suppressed by a malformed date is not.
 *
 * Both checks are `src/core/calendar.ts` now, and it is the same grammar the
 * schema validates `accepted[].until` against — one expression rather than the
 * three in two spellings there were until 23 August 2026 (ADR-0064). Which
 * closes the gap the paragraph above leaves open: the schema is one of two doors
 * into this function, and a consumer of the library building an `Acceptance` by
 * hand comes through the other with nothing between. `2026-11-31` used to reach
 * `Date.UTC` here and roll over into 1 December, so the acceptance outlived the
 * date the file named by a day; now it reads as lapsed, which is the direction
 * this function already chose for everything else it cannot read.
 */
export function acceptanceExpiresAt(until: string): number {
  const date = calendarDayOf(until);
  if (date === undefined) {
    return Number.NaN;
  }
  return Date.UTC(date.year, date.month - 1, date.day + 1);
}

/**
 * Whether the acceptance still holds at the given moment.
 *
 * The moment is the run's start, so every finding of one run is judged against
 * one clock: a walk that crosses midnight must not accept its first half and
 * report its second.
 */
export function isAcceptanceInForce(acceptance: Acceptance, at: Date): boolean {
  return at.getTime() < acceptanceExpiresAt(acceptance.until);
}

/** How an acceptance is named to a human, by its place in the declaration. */
export function describeAcceptance(index: number): string {
  return `The acceptance at accepted[${index}]`;
}

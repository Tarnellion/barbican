/**
 * The arithmetic an acceptance rests on: what it is keyed by, and when it lapses.
 *
 * Both are one-liners and both decide whether a finding is reported or held out
 * of the verdict, which is the most consequential thing a one-liner in this
 * project does. The key in particular is written twice by construction — the
 * grouping builds it for `defects[].key`, the acceptance builds it to match — so
 * the assertion worth making is that the two are the **same** function and not
 * two spellings that agree today.
 */

import { describe, expect, it } from "vitest";
import type { Acceptance } from "../../src/core/accepted.js";
import {
  acceptanceExpiresAt,
  acceptanceKeyOf,
  indexAcceptances,
  isAcceptanceInForce,
  matchingAcceptance,
} from "../../src/core/accepted.js";
import type { DefectCoordinates } from "../../src/core/defects.js";
import { citableDefectKey, groupDefects } from "../../src/core/defects.js";

/** A finding row, with the two coordinates the key deliberately ignores. */
type FoundRow = DefectCoordinates & {
  readonly kind: string;
  readonly accountId: string;
  readonly resourceId?: string | undefined;
};

const KNOWN: Acceptance = {
  endpointId: "orders.list",
  relation: "same-tenant",
  contextId: "geo-blocked",
  kind: "privilege-escalation",
  reason: "the legacy order service has no tenant filter; PLAT-1234 fixes it",
  until: "2026-11-30",
};

describe("what an acceptance is keyed by", () => {
  /**
   * The citable key and the acceptance's key are built from one function.
   *
   * A ticket quotes `defects[].key`; the operator copies the three words back
   * into the configuration. If the acceptance composed its own version of that
   * string the two would agree until an id contained a space, and the failure
   * would be an acceptance that silently matches nothing.
   */
  it("names the same defect the grouping names", () => {
    const [group] = groupDefects([
      {
        accountId: "carol",
        endpointId: KNOWN.endpointId,
        relation: KNOWN.relation,
        contextId: KNOWN.contextId,
        kind: KNOWN.kind,
        severity: "high",
      },
    ]);

    expect(group?.key).toBe(citableDefectKey(KNOWN));
    expect(citableDefectKey(KNOWN)).toBe("orders.list same-tenant geo-blocked");
  });

  /**
   * The kind is part of the acceptance key and not of the defect key.
   *
   * ADR-0030 took the kind out of the defect signature: how a defect was noticed
   * is not what a defect is. Accepting is a different question — the operator
   * has seen one specific breakage and named the way it shows — and a group that
   * later starts failing a second way must not be silenced by the first
   * acceptance.
   */
  it("separates two ways one defect showed itself", () => {
    const coordinates = {
      endpointId: KNOWN.endpointId,
      relation: KNOWN.relation,
      contextId: KNOWN.contextId,
    };

    expect(acceptanceKeyOf(coordinates, "privilege-escalation")).not.toBe(
      acceptanceKeyOf(coordinates, "identical-response-across-tenants"),
    );
  });

  /**
   * Neither the account nor the resource is in the key: see the ADR.
   *
   * The rows are typed as findings rather than written as bare coordinates, so
   * that the two extra fields are really present when the lookup is made. An
   * object literal narrowed to the coordinates would prove nothing about them.
   */
  it("covers every account and every resource of the defect", () => {
    const index = indexAcceptances([KNOWN]);

    for (const [accountId, resourceId] of [
      ["carol", "order-1001"],
      ["dave", "order-2002"],
    ]) {
      const finding: FoundRow = {
        accountId: accountId ?? "",
        resourceId,
        endpointId: KNOWN.endpointId,
        relation: KNOWN.relation,
        contextId: KNOWN.contextId,
        kind: KNOWN.kind,
      };

      expect(matchingAcceptance(finding, index)).toEqual(KNOWN);
    }
  });

  it("does not reach a different relation or a different context", () => {
    const index = indexAcceptances([KNOWN]);
    const base: FoundRow = { accountId: "carol", endpointId: KNOWN.endpointId, kind: KNOWN.kind };

    expect(
      matchingAcceptance({ ...base, relation: "foreign-tenant", contextId: "geo-blocked" }, index),
    ).toBeUndefined();
    expect(matchingAcceptance({ ...base, relation: "same-tenant" }, index)).toBeUndefined();
  });

  /**
   * An absent relation and an absent context are their own coordinates.
   *
   * `citableDefectKey` prints them as `any-resource` and `baseline`, and those
   * two words are what a reader sees in `defects[].key`. A finding with no
   * resource must not be matched by an acceptance written for a relation.
   */
  it("treats baseline conditions and no resource as coordinates of their own", () => {
    const whole: Acceptance = {
      endpointId: "admin.users",
      kind: "privilege-escalation",
      reason: "the admin console is open to every role while PLAT-9 is open",
      until: "2026-11-30",
    };
    const index = indexAcceptances([whole]);

    const noResource: FoundRow = {
      accountId: "carol",
      endpointId: "admin.users",
      kind: "privilege-escalation",
    };

    expect(citableDefectKey(whole)).toBe("admin.users any-resource baseline");
    expect(matchingAcceptance(noResource, index)).toEqual(whole);
    expect(matchingAcceptance({ ...noResource, relation: "own" }, index)).toBeUndefined();
  });
});

describe("when an acceptance lapses", () => {
  /**
   * `until` is the last day it holds, inclusive, in UTC.
   *
   * Inclusive because that is how a person reads a date written next to
   * "accepted until"; UTC because the alternative is a run whose verdict depends
   * on the timezone of the machine that started it — the same class of defect as
   * `localeCompare` in the sort order (ADR-0036).
   */
  it("holds through the whole of its last day and not past it", () => {
    expect(isAcceptanceInForce(KNOWN, new Date("2026-11-30T00:00:00.000Z"))).toBe(true);
    expect(isAcceptanceInForce(KNOWN, new Date("2026-11-30T23:59:59.999Z"))).toBe(true);
    expect(isAcceptanceInForce(KNOWN, new Date("2026-12-01T00:00:00.000Z"))).toBe(false);
  });

  it("rolls over a month and a year without arithmetic of its own", () => {
    const endOfYear: Acceptance = { ...KNOWN, until: "2026-12-31" };

    expect(isAcceptanceInForce(endOfYear, new Date("2026-12-31T22:00:00.000Z"))).toBe(true);
    expect(isAcceptanceInForce(endOfYear, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
  });

  /**
   * A deadline in some other shape lapses rather than holding for ever.
   *
   * `parseRunConfig` refuses one, so this is about the library door: a consumer
   * assembling a `RunConfig` in code reaches `buildReport` without passing that
   * gate, which is the same door `collectObservations` was found open at
   * (ADR-0032). Of the two ways to be wrong, reporting a finding that was
   * accepted is recoverable and suppressing one for ever is not.
   */
  it("does not hold at all when the date cannot be read", () => {
    const unreadable: Acceptance = { ...KNOWN, until: "next quarter" };

    expect(acceptanceExpiresAt("next quarter")).toBeNaN();
    expect(isAcceptanceInForce(unreadable, new Date("2020-01-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("an accepted defect seen more than once", () => {
  /**
   * The mark survives the merge into a group that already exists.
   *
   * A defect touches as many cells as there are, and the second row of it takes
   * the other branch of `groupDefects` — the one that adds to a group rather
   * than creating it. A mark applied only on the first row would leave the
   * group's `acceptedKinds` depending on which cell the walk reached first.
   */
  it("marks the group whichever row created it", () => {
    const row = (accountId: string, kind: string, accepted: boolean) => ({
      accountId,
      endpointId: "orders.get",
      relation: "same-tenant" as const,
      kind,
      severity: "high" as const,
      accepted,
    });

    const [group] = groupDefects([
      row("carol", "privilege-escalation", true),
      row("dave", "privilege-escalation", true),
      // A second way the same defect shows, which nobody has accepted.
      row("carol", "identical-response-across-tenants", false),
    ]);

    expect(group?.kinds).toEqual(["identical-response-across-tenants", "privilege-escalation"]);
    expect(group?.acceptedKinds).toEqual(["privilege-escalation"]);
    expect(group?.violations).toBe(3);
  });
});

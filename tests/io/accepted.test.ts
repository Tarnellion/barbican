/**
 * The `accepted:` section of a run configuration.
 *
 * It is the one place in this format where a human tells the tool to stop
 * failing a build over something it found, so every way of writing it wrong has
 * to stop the run rather than quietly suppress the wrong thing — or the wrong
 * amount of it. See ADR-0048.
 */

import { describe, expect, it } from "vitest";
import type { Endpoint } from "../../src/core/index.js";
import {
  assertReferencesResolve,
  ConfigValidationError,
  DuplicateAcceptanceError,
  parseRunConfig,
  UnacceptableFindingKindError,
  UnknownAcceptanceContextError,
  UnknownEndpointReferenceError,
} from "../../src/io/config.js";

const ENDPOINTS: readonly Endpoint[] = [
  { id: "orders.list", method: "GET", path: "/v1/orders" },
  { id: "admin.users", method: "GET", path: "/v1/admin/users" },
];

const HEAD = `
target: { baseUrl: "https://a.test", allowedHosts: [a.test] }
accounts:
  - { id: alice, role: user, tenant: t-a, tokenEnv: A }
policy: { fallback: denied, rules: [] }
`;

function config(accepted: string) {
  return parseRunConfig(`${HEAD}accepted:\n${accepted}`);
}

describe("a declared acceptance", () => {
  it("carries the coordinates of a defect, a reason and a deadline", () => {
    const parsed = config(`
  - endpoint: orders.list
    relation: same-tenant
    kind: privilege-escalation
    reason: the legacy order service has no tenant filter
    until: 2026-11-30
    ticket: PLAT-1234
`);

    expect(parsed.accepted).toEqual([
      {
        endpointId: "orders.list",
        relation: "same-tenant",
        kind: "privilege-escalation",
        reason: "the legacy order service has no tenant filter",
        until: "2026-11-30",
        ticket: "PLAT-1234",
      },
    ]);
  });

  /** Nothing is declared means nothing is suppressed, and the field still exists. */
  it("is an empty list when the section is absent", () => {
    expect(parseRunConfig(HEAD).accepted).toEqual([]);
  });

  it("cannot be written without a reason or without a deadline", () => {
    expect(() =>
      config(`
  - { endpoint: orders.list, kind: privilege-escalation, until: 2026-11-30 }
`),
    ).toThrow(ConfigValidationError);
    expect(() =>
      config(`
  - { endpoint: orders.list, kind: privilege-escalation, reason: known }
`),
    ).toThrow(ConfigValidationError);
  });

  /**
   * A deadline that is not a date is a deadline that never arrives.
   *
   * `until: soon` and `until: 30/11/2026` would both parse as strings, and a
   * string the expiry arithmetic cannot read yields `NaN` — which compares false
   * against every moment, so the acceptance would be permanently lapsed or,
   * written the other way round, permanently in force. Neither is what the file
   * says, so neither is allowed to happen.
   */
  it("refuses a deadline that is not a calendar date", () => {
    for (const until of [
      "soon",
      "30/11/2026",
      "2026-11-31",
      "2026-13-01",
      "2026-11-30T00:00:00Z",
    ]) {
      expect(
        () =>
          config(`
  - { endpoint: orders.list, kind: privilege-escalation, reason: known, until: "${until}" }
`),
        `accepted an unusable deadline: ${until}`,
      ).toThrow(ConfigValidationError);
    }
  });

  /**
   * A date already gone is a legitimate declaration and must not stop the run.
   *
   * The whole mechanism is that a lapsed acceptance turns back into a finding.
   * Refusing it here would replace that with a run that does not start, which is
   * the failure mode this feature exists to keep teams out of.
   */
  it("is accepted with a date already in the past", () => {
    expect(
      config(`
  - { endpoint: orders.list, kind: privilege-escalation, reason: known, until: 2020-01-01 }
`).accepted,
    ).toHaveLength(1);
  });

  /**
   * `not-observed` and `probe-error` are statements about the run's own reach.
   *
   * Neither says anything about the platform: one means no request covered the
   * cell, the other that the request did not come back. Accepting them would be
   * accepting "we did not look", and `probe-error` is worse than that — half a
   * matrix failing to answer is the exit code 2 that says the report describes
   * the network. That is the one thing this mechanism must never be able to buy.
   */
  it("cannot be written for a kind that says the run reached nothing", () => {
    for (const kind of ["not-observed", "probe-error"]) {
      expect(() =>
        config(`
  - { endpoint: orders.list, kind: ${kind}, reason: known, until: 2026-11-30 }
`),
      ).toThrow(UnacceptableFindingKindError);
    }
  });

  /** Two entries for one key would leave the file's meaning to their order. */
  it("cannot be declared twice for the same defect and kind", () => {
    expect(() =>
      config(`
  - { endpoint: orders.list, kind: privilege-escalation, reason: first, until: 2026-11-30 }
  - { endpoint: orders.list, kind: privilege-escalation, reason: second, until: 2027-01-01 }
`),
    ).toThrow(DuplicateAcceptanceError);
  });

  it("is a different declaration under a different relation", () => {
    expect(
      config(`
  - { endpoint: orders.list, relation: own, kind: privilege-escalation, reason: a, until: 2026-11-30 }
  - { endpoint: orders.list, relation: same-tenant, kind: privilege-escalation, reason: b, until: 2026-11-30 }
`).accepted,
    ).toHaveLength(2);
  });

  it("refuses a relation that is not one of the five", () => {
    expect(() =>
      config(`
  - { endpoint: orders.list, relation: shared-with, kind: privilege-escalation, reason: a, until: 2026-11-30 }
`),
    ).toThrow(ConfigValidationError);
  });

  /**
   * A stray key is refused like everywhere else in this format.
   *
   * Here the cost is specific: `untill` would leave the entry with no deadline,
   * and a suppression with no deadline is the silencer the whole design is
   * against.
   */
  it("refuses a key it does not know", () => {
    expect(() =>
      config(`
  - { endpoint: orders.list, kind: privilege-escalation, reason: a, until: 2026-11-30, untill: 2030-01-01 }
`),
    ).toThrow(ConfigValidationError);
  });

  it("refuses conditions no context declares", () => {
    expect(() =>
      config(`
  - { endpoint: orders.list, context: geo-blocked, kind: privilege-escalation, reason: a, until: 2026-11-30 }
`),
    ).toThrow(UnknownAcceptanceContextError);
  });
});

describe("an acceptance against the endpoints that were parsed", () => {
  /**
   * A typo in the endpoint id makes the acceptance match nothing.
   *
   * That direction is the harmless one — the finding is reported, CI stays red,
   * somebody looks. It is refused anyway, because this is what the project does
   * with every other reference that resolves to nothing, and because the
   * operator who wrote it believes the opposite has happened.
   */
  it("stops the run when the endpoint is not among them", () => {
    const parsed = config(`
  - { endpoint: orders.lst, kind: privilege-escalation, reason: a, until: 2026-11-30 }
`);

    expect(() => {
      assertReferencesResolve(parsed, ENDPOINTS);
    }).toThrow(UnknownEndpointReferenceError);
  });

  it("passes when it does name one of them", () => {
    const parsed = config(`
  - { endpoint: orders.list, kind: privilege-escalation, reason: a, until: 2026-11-30 }
`);

    expect(() => {
      assertReferencesResolve(parsed, ENDPOINTS);
    }).not.toThrow();
  });
});

/**
 * What a consumer must supply to feed this library observations of their own.
 *
 * The README invites exactly that — `buildAccessMatrix` and `diffAccess` are
 * exported, and the example passes observations in by hand. Until 17 August 2026
 * `AccessObservation` also required `headers` and `durationMs`, neither of which
 * anything in `src/core` reads: they travel through the matrix to reach the
 * report, and `durationMs` is read by no code at all — the runner writes it and
 * the file carries it for a person to look at.
 *
 * So a harness that has no clock and keeps no headers had to write
 * `durationMs: 0, headers: {}` on every row, and that is not merely noise. An
 * empty header map says "the response carried nothing we keep"; the truth was
 * "nobody recorded any", and a report cannot tell the two apart. A required
 * field the producer cannot supply turns into a false statement in the artifact.
 * Absent says the true thing.
 *
 * Found by the audit of 14 August 2026 (E-8), noticed while closing E-2.
 */

import { describe, expect, it } from "vitest";
import type { AccessObservation, Endpoint, ExpectedAccessPolicy } from "../../src/core/index.js";
import { buildAccessMatrix, diffAccess, expandPolicy } from "../../src/core/index.js";

const ENDPOINTS: readonly Endpoint[] = [
  { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
  { id: "users.list", method: "GET", path: "/v1/admin/users" },
];

const POLICY: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [{ roles: ["player"], endpoints: ["profile.read"], outcome: "allowed" }],
};

/**
 * Everything a foreign harness has, and nothing it would have to invent.
 *
 * Written as a literal of the exported type rather than assembled by a helper:
 * what is under test is the shape a consumer has to satisfy, and a helper would
 * fill in whatever the type asked for and prove nothing.
 */
const FROM_A_FOREIGN_HARNESS: readonly AccessObservation[] = [
  { accountId: "player-1", endpointId: "profile.read", status: 200, outcome: "allowed" },
  { accountId: "player-1", endpointId: "users.list", status: 200, outcome: "allowed" },
];

describe("observations from somebody else's harness", () => {
  /**
   * The assertion is that this file compiles. `pnpm run typecheck` is the half
   * that matters, and it reads this fixture; the run below is here so that the
   * claim is not only about types.
   */
  it("need neither headers nor a duration", () => {
    for (const one of FROM_A_FOREIGN_HARNESS) {
      expect(one.headers).toBeUndefined();
      expect(one.durationMs).toBeUndefined();
    }
  });

  it("still give the diff the core is for", () => {
    const matrix = buildAccessMatrix({
      endpoints: ENDPOINTS,
      accounts: [{ id: "player-1", roleId: "player", tenantId: "tenant-a" }],
      observations: FROM_A_FOREIGN_HARNESS,
    });

    const found = diffAccess(matrix, expandPolicy(POLICY, ENDPOINTS));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      accountId: "player-1",
      endpointId: "users.list",
      kind: "privilege-escalation",
      expected: "denied",
      actual: "allowed",
    });
  });

  /**
   * And a harness that does record them is unchanged: optional is a widening,
   * so the pairing of "the report prints what it was given" holds either way.
   */
  it("carry what a harness does record", () => {
    const withEverything: AccessObservation = {
      accountId: "player-1",
      endpointId: "profile.read",
      status: 200,
      outcome: "allowed",
      headers: { "content-type": "application/json" },
      durationMs: 12,
    };

    const matrix = buildAccessMatrix({
      endpoints: ENDPOINTS,
      accounts: [{ id: "player-1", roleId: "player", tenantId: "tenant-a" }],
      observations: [withEverything],
    });

    expect(matrix.observations[0]?.headers).toEqual({ "content-type": "application/json" });
    expect(matrix.observations[0]?.durationMs).toBe(12);
  });
});

/**
 * The permissive-CORS check over response headers.
 *
 * It reads `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials`
 * off the observations and reports the two origins that are wrong with
 * credentials whatever origin was asked: the wildcard and the null origin. The
 * cases below are the boundary of that claim — a specific origin is not flagged,
 * because from the matrix alone a reflection cannot be told from an allowlist
 * (ADR-0076) — and the mechanics the check shares with its sibling: one finding
 * per endpoint × condition, the condition carried from the account, and the
 * coverage that tells "asked and clean" from "never asked".
 *
 * Fixtures are hand-written, per the repository rule: a matrix generated from
 * the thing under test is a check that a function agrees with itself.
 */

import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../src/core/checks/types.js";
import type { AccessObservation, Account } from "../../src/core/index.js";
import {
  CORS_CHECK_ID,
  createBundledCatalog,
  createCorsCheck,
  runChecks,
} from "../../src/core/index.js";

function observation(over: Partial<AccessObservation> = {}): AccessObservation {
  return {
    endpointId: "list-orders",
    accountId: "alice",
    status: 200,
    outcome: "allowed",
    ...over,
  };
}

function contextOf(
  observations: readonly AccessObservation[],
  accounts: readonly Partial<Account>[] = [{ id: "alice", roleId: "user" }],
): CheckContext {
  return {
    matrix: {
      endpoints: [],
      accounts: accounts as readonly Account[],
      resources: [],
      observations,
    },
  };
}

const check = createCorsCheck();

describe("the permissive-CORS check", () => {
  it("flags a wildcard with credentials", () => {
    const findings = check.run(
      contextOf([
        observation({
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "true",
          },
        }),
      ]),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe(CORS_CHECK_ID);
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.endpointId).toBe("list-orders");
    expect(findings[0]?.evidence).toMatchObject({
      allowOrigin: "*",
      allowCredentials: true,
      status: 200,
    });
  });

  it("flags the null origin with credentials, and weighs it heavier", () => {
    const findings = check.run(
      contextOf([
        observation({
          headers: {
            "access-control-allow-origin": "null",
            "access-control-allow-credentials": "true",
          },
        }),
      ]),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.evidence.allowOrigin).toBe("null");
  });

  it("says nothing about a permissive origin without credentials", () => {
    // A wildcard with no credentials is the ordinary way to share a public
    // endpoint, and the browser never attaches a cookie to it. Reporting it
    // would be the false positive the whole tool is written against.
    const findings = check.run(
      contextOf([
        observation({
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "false",
          },
        }),
        observation({
          endpointId: "other",
          headers: { "access-control-allow-origin": "null" },
        }),
      ]),
    );

    expect(findings).toEqual([]);
  });

  it("does not flag a specific origin, which it cannot tell from an allowlist", () => {
    // Reflection of an arbitrary origin is the dangerous case and the one out of
    // reach here: without the origin that was sent, an echoed `https://app`
    // could be a reflection or a legitimately trusted partner. The check refuses
    // to guess. See ADR-0076.
    const findings = check.run(
      contextOf([
        observation({
          headers: {
            "access-control-allow-origin": "https://app.example.com",
            "access-control-allow-credentials": "true",
          },
        }),
      ]),
    );

    expect(findings).toEqual([]);
  });

  it("reads the credentials flag as the Fetch standard does", () => {
    // `true` is the only value a browser reads as true; `True` and `1` enable
    // nothing, so flagging them would invent a danger. Surrounding whitespace is
    // the one thing trimmed, because a header may carry it and no browser minds.
    const notTrue = check.run(
      contextOf([
        observation({
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "True",
          },
        }),
        observation({
          endpointId: "e2",
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "1",
          },
        }),
      ]),
    );
    expect(notTrue).toEqual([]);

    const trimmed = check.run(
      contextOf([
        observation({
          headers: {
            "access-control-allow-origin": "null",
            "access-control-allow-credentials": " true ",
          },
        }),
      ]),
    );
    expect(trimmed).toHaveLength(1);
  });

  it("makes one finding per endpoint and condition, not per account", () => {
    // The CORS policy is a property of the endpoint under one condition, so two
    // accounts reaching the same wildcard are one finding.
    const findings = check.run(
      contextOf(
        [
          observation({
            accountId: "alice",
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-credentials": "true",
            },
          }),
          observation({
            accountId: "bob",
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-credentials": "true",
            },
          }),
        ],
        [
          { id: "alice", roleId: "user" },
          { id: "bob", roleId: "user" },
        ],
      ),
    );

    expect(findings).toHaveLength(1);
  });

  it("carries the condition from the account, and splits findings by it", () => {
    const findings = check.run(
      contextOf(
        [
          observation({
            accountId: "alice@origin-a",
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-credentials": "true",
            },
          }),
          observation({
            accountId: "alice@origin-b",
            headers: {
              "access-control-allow-origin": "*",
              "access-control-allow-credentials": "true",
            },
          }),
        ],
        [
          { id: "alice@origin-a", roleId: "user", contextId: "origin-a" },
          { id: "alice@origin-b", roleId: "user", contextId: "origin-b" },
        ],
      ),
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.contextId).sort()).toEqual(["origin-a", "origin-b"]);
  });

  it("settles its severities through runChecks, which it declares high as a fallback", () => {
    const resolved = runChecks(
      [check],
      contextOf([
        observation({
          headers: {
            "access-control-allow-origin": "null",
            "access-control-allow-credentials": "true",
          },
        }),
      ]),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.severity).toBe("high");
  });

  it("reads headers only as own properties", () => {
    // `observation.headers` is keyed by names the platform chose, and a report
    // read back from JSON carries Object.prototype. An inherited value under one
    // of the names read here must not be mistaken for a response header. See the
    // module comment on `ownHeader`.
    const poisoned = Object.create({
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
    }) as Record<string, string>;

    const findings = check.run(contextOf([observation({ headers: poisoned })]));

    expect(findings).toEqual([]);
  });
});

describe("the permissive-CORS coverage", () => {
  it("counts the responses that carried a CORS header, and which allowed credentials", () => {
    const coverage = check.coverage?.(
      contextOf([
        observation({
          endpointId: "list-orders",
          accountId: "alice",
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-credentials": "true",
          },
        }),
        observation({
          endpointId: "list-orders",
          accountId: "bob",
          headers: { "access-control-allow-origin": "https://app" },
        }),
        observation({ endpointId: "list-orders", accountId: "carol" }),
      ]),
    );

    expect(coverage).toEqual([
      {
        checkId: CORS_CHECK_ID,
        endpointId: "list-orders",
        counters: { corsResponsesSeen: 2, corsResponsesAllowingCredentials: 1 },
      },
    ]);
  });

  it("is empty when no origin condition was declared", () => {
    // Zero everywhere is the signal that the question was never asked, which an
    // evidence pack must not read as "asked and clean".
    const coverage = check.coverage?.(
      contextOf([observation(), observation({ endpointId: "e2" })]),
    );

    expect(coverage).toEqual([]);
  });
});

describe("the clause the check cites", () => {
  it("resolves in the bundled catalogue", () => {
    const catalog = createBundledCatalog();
    for (const ref of check.standards) {
      expect(catalog.clause(ref)).toBeDefined();
    }
  });
});

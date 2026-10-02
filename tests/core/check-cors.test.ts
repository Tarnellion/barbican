/**
 * The permissive-CORS check over response headers.
 *
 * It reads `Access-Control-Allow-Origin` and `Access-Control-Allow-Credentials`
 * off every answered observation and reports the two origins that are wrong with
 * credentials whatever origin was asked, the wildcard and the null origin, and,
 * since ADR-0078, an origin the operator declared foreign. The cases below are the
 * boundary of that claim — a specific origin nobody declared foreign is not
 * flagged, because from the matrix alone a reflection cannot be told from an
 * allowlist (ADR-0076) — and the mechanics the check shares with its sibling: one
 * finding per endpoint × condition × shape, the condition carried from the account,
 * and a coverage that counts what was answered. That coverage cannot tell asked and
 * clean from never asked for the two shapes that need no declaration; only the
 * reflection question has a counter that can.
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
  foreignOriginCellsAnswered,
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

  it("keeps the severity each of its findings carries through runChecks", () => {
    // The check declares `high` once and every finding names its own, so this
    // pins that `runChecks` leaves a medium finding medium. It cannot show the
    // fallback: no finding of this check leaves its severity off.
    const resolved = runChecks(
      [check],
      contextOf(
        [
          observation({
            accountId: "alice",
            headers: {
              "access-control-allow-origin": "null",
              "access-control-allow-credentials": "true",
            },
          }),
          observation({
            accountId: "bob",
            endpointId: "other",
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

    expect(resolved.map((finding) => [finding.endpointId, finding.severity])).toEqual([
      ["list-orders", "high"],
      ["other", "medium"],
    ]);
    expect(check.severity).toBe("high");
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
    // Not empty first: a loop over an empty list is a pass for any catalogue.
    expect(check.standards.map((ref) => `${ref.standard}/${ref.clause}`)).toEqual([
      "OWASP-API-2023/API8",
    ]);
    for (const ref of check.standards) {
      expect(catalog.clause(ref)).toBeDefined();
    }
  });
});

/**
 * Reflection, judged against an origin the operator declared foreign (ADR-0078).
 *
 * The case ADR-0076 left out because an echoed origin cannot be told from an
 * allowlisted partner. What settles it is a fact only a human has — which origin
 * the platform must not trust — so the check is handed a map from a context to the
 * origin it sent, and a cell under such a context that comes back trusting that
 * very origin, with credentials, is a finding. The boundary of the claim is in the
 * cases that stay silent.
 */
describe("a reflected origin the operator declared foreign", () => {
  const FOREIGN = "https://attacker.example";
  const foreign = createCorsCheck({ foreignOrigins: new Map([["foreign", FOREIGN]]) });

  const accounts: readonly Partial<Account>[] = [
    { id: "alice", roleId: "user" },
    { id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" },
    { id: "alice@partner", roleId: "user", contextId: "partner", baseAccountId: "alice" },
  ];

  const echoing = (origin: string, credentials = "true") => ({
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": credentials,
  });

  it("flags the declared origin when the platform allows it with credentials", () => {
    const findings = foreign.run(
      contextOf([observation({ accountId: "alice@foreign", headers: echoing(FOREIGN) })], accounts),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: CORS_CHECK_ID,
      severity: "high",
      endpointId: "list-orders",
      accountId: "alice@foreign",
      contextId: "foreign",
      evidence: {
        allowOrigin: FOREIGN,
        allowCredentials: true,
        status: 200,
        foreignOriginDeclared: true,
      },
    });
    expect(findings[0]?.title).toContain("declared foreign");
  });

  it("is silent about the same origin when nobody declared it foreign", () => {
    // The boundary of ADR-0076, unchanged: an echoed origin is evidence of
    // nothing until a human says which origins are not to be trusted.
    const findings = check.run(
      contextOf([observation({ accountId: "alice@foreign", headers: echoing(FOREIGN) })], accounts),
    );

    expect(findings).toEqual([]);
  });

  it("is silent when the platform allows a different origin than the declared one", () => {
    // An allowlist: it was sent the foreign origin and answered with its own.
    const findings = foreign.run(
      contextOf(
        [
          observation({
            accountId: "alice@foreign",
            headers: echoing("https://app.example.com"),
          }),
        ],
        accounts,
      ),
    );

    expect(findings).toEqual([]);
  });

  it("is silent without credentials, however permissive the origin", () => {
    const findings = foreign.run(
      contextOf(
        [observation({ accountId: "alice@foreign", headers: echoing(FOREIGN, "false") })],
        accounts,
      ),
    );

    expect(findings).toEqual([]);
  });

  it("judges only the cells under the context that sent the declared origin", () => {
    // The same string echoed under another context, or in the baseline, belongs
    // to a different question: nobody said that origin is foreign there.
    const findings = foreign.run(
      contextOf(
        [
          observation({ accountId: "alice", headers: echoing(FOREIGN) }),
          observation({ accountId: "alice@partner", headers: echoing(FOREIGN) }),
        ],
        accounts,
      ),
    );

    expect(findings).toEqual([]);
  });

  it("reports a wildcard under a foreign context once, as the wildcard", () => {
    const findings = foreign.run(
      contextOf([observation({ accountId: "alice@foreign", headers: echoing("*") })], accounts),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("medium");
    expect(findings[0]?.evidence).not.toHaveProperty("foreignOriginDeclared");
  });

  it("is not made to report twice by a declared origin of * or null", () => {
    // The configuration refuses both as origins. A consumer building the map by
    // hand can still hand them over, and the order of the verdicts is what keeps
    // one answer from becoming two findings.
    for (const word of ["*", "null"]) {
      const odd = createCorsCheck({ foreignOrigins: new Map([["foreign", word]]) });

      const findings = odd.run(
        contextOf([observation({ accountId: "alice@foreign", headers: echoing(word) })], accounts),
      );

      expect(findings, word).toHaveLength(1);
      expect(findings[0]?.evidence, word).not.toHaveProperty("foreignOriginDeclared");
    }
  });

  it("ignores an empty origin rather than matching a header that says nothing", () => {
    const empty = createCorsCheck({ foreignOrigins: new Map([["foreign", ""]]) });

    const findings = empty.run(
      contextOf([observation({ accountId: "alice@foreign", headers: echoing("") })], accounts),
    );

    expect(findings).toEqual([]);
  });

  it("holds its own copy of the map it was given", () => {
    const given = new Map([["foreign", FOREIGN]]);
    const copied = createCorsCheck({ foreignOrigins: given });
    given.clear();

    const findings = copied.run(
      contextOf([observation({ accountId: "alice@foreign", headers: echoing(FOREIGN) })], accounts),
    );

    expect(findings).toHaveLength(1);
  });

  it("makes one finding per endpoint and context, the verdict being a property of both", () => {
    const two = createCorsCheck({
      foreignOrigins: new Map([
        ["foreign", FOREIGN],
        ["partner", "https://other.example"],
      ]),
    });

    const findings = two.run(
      contextOf(
        [
          observation({ accountId: "alice@foreign", headers: echoing(FOREIGN) }),
          observation({ accountId: "alice@partner", headers: echoing("https://other.example") }),
        ],
        accounts,
      ),
    );

    expect(findings.map((finding) => finding.contextId).sort()).toEqual(["foreign", "partner"]);
  });
});

describe("the coverage of the reflection question", () => {
  const FOREIGN = "https://attacker.example";
  const foreign = createCorsCheck({ foreignOrigins: new Map([["foreign", FOREIGN]]) });
  const accounts: readonly Partial<Account>[] = [
    { id: "alice", roleId: "user" },
    { id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" },
  ];

  it("says an endpoint was asked and answered with no CORS header at all", () => {
    // Asked and clean has to be distinguishable from never asked, and here there
    // is no header on the response to count — the platform simply did not answer
    // the cross-origin question with a policy.
    const coverage = foreign.coverage?.(
      contextOf([observation({ accountId: "alice@foreign" })], accounts),
    );

    expect(coverage).toEqual([
      {
        checkId: CORS_CHECK_ID,
        endpointId: "list-orders",
        counters: {
          corsResponsesSeen: 0,
          corsResponsesAllowingCredentials: 0,
          foreignOriginCellsAnswered: 1,
        },
      },
    ]);
  });

  it("does not count a cell whose probe failed", () => {
    const coverage = foreign.coverage?.(
      contextOf(
        [observation({ accountId: "alice@foreign", status: 0, outcome: "error" })],
        accounts,
      ),
    );

    expect(coverage).toEqual([]);
  });

  it("counts only the cells under a context declared foreign", () => {
    const coverage = foreign.coverage?.(
      contextOf(
        [
          observation({ accountId: "alice" }),
          observation({ accountId: "alice@foreign" }),
          observation({ accountId: "alice@foreign", endpointId: "other" }),
        ],
        accounts,
      ),
    );

    expect(
      coverage?.map((row) => [row.endpointId, row.counters.foreignOriginCellsAnswered]),
    ).toEqual([
      ["list-orders", 1],
      ["other", 1],
    ]);
  });

  it("leaves the counter out when no origin was declared foreign", () => {
    // A zero would claim the question was put. `skippedDifferentContextPairs` of
    // the isolation check is absent for the same reason.
    const coverage = check.coverage?.(
      contextOf(
        [
          observation({
            headers: {
              "access-control-allow-origin": "https://app.example.com",
              "access-control-allow-credentials": "true",
            },
          }),
        ],
        accounts,
      ),
    );

    expect(coverage?.[0]?.counters).toEqual({
      corsResponsesSeen: 1,
      corsResponsesAllowingCredentials: 1,
    });
  });
});

/**
 * The two limits ADR-0078 records for the reflection verdict, pinned by running
 * them rather than by describing them.
 */
describe("what the reflection verdict does not do, measured", () => {
  const FOREIGN = "https://attacker.example";
  const foreign = createCorsCheck({ foreignOrigins: new Map([["foreign", FOREIGN]]) });
  const accounts: readonly Partial<Account>[] = [
    { id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" },
  ];
  const headers = (origin: string) => ({
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
  });

  it("reads a response whatever its status, and carries the status for the reader", () => {
    // A CORS layer that is global middleware decorates a refusal as well. The
    // finding is true of that response and weaker about the data, which is why
    // `status` is in its evidence.
    const findings = foreign.run(
      contextOf(
        [
          observation({
            accountId: "alice@foreign",
            status: 401,
            outcome: "denied",
            headers: headers(FOREIGN),
          }),
        ],
        accounts,
      ),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.status).toBe(401);
  });

  it("matches the declared origin as written, and does not fold case", () => {
    // The declared origin is canonical and a platform echoes what it received, so
    // a browser's request cannot produce this. A platform that re-cased what it
    // echoed would be missed, and that is accepted rather than guessed at.
    const findings = foreign.run(
      contextOf(
        [observation({ accountId: "alice@foreign", headers: headers("https://Attacker.example") })],
        accounts,
      ),
    );

    expect(findings).toEqual([]);
  });
});

/**
 * A cell whose probe failed is not read (ADR-0078, after adversarial review).
 *
 * The finding and the coverage have to ask the same question. Measured: a 503 or a
 * 302 that carried reflecting headers was a high finding on a cell the coverage
 * counted as unanswered and the report listed as a probe error.
 */
describe("a cell whose probe failed", () => {
  const FOREIGN = "https://attacker.example";
  const foreign = createCorsCheck({ foreignOrigins: new Map([["foreign", FOREIGN]]) });
  const accounts: readonly Partial<Account>[] = [
    { id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" },
  ];
  const failed = (headers: Record<string, string>, status: number) =>
    observation({ accountId: "alice@foreign", status, outcome: "error", headers });

  it("is not judged, whichever of the three verdicts the headers would give", () => {
    for (const origin of [FOREIGN, "*", "null"]) {
      for (const status of [503, 302]) {
        const findings = foreign.run(
          contextOf(
            [
              failed(
                {
                  "access-control-allow-origin": origin,
                  "access-control-allow-credentials": "true",
                },
                status,
              ),
            ],
            accounts,
          ),
        );

        expect(findings, `${origin} on ${status}`).toEqual([]);
      }
    }
  });

  it("is not counted either, so the two cannot disagree about it", () => {
    const coverage = foreign.coverage?.(
      contextOf(
        [
          failed(
            {
              "access-control-allow-origin": FOREIGN,
              "access-control-allow-credentials": "true",
            },
            503,
          ),
        ],
        accounts,
      ),
    );

    expect(coverage).toEqual([]);
  });

  it("leaves a refusal that is an answer alone: 401 and 403 are read", () => {
    for (const status of [401, 403]) {
      const findings = foreign.run(
        contextOf(
          [
            observation({
              accountId: "alice@foreign",
              status,
              outcome: "denied",
              headers: {
                "access-control-allow-origin": FOREIGN,
                "access-control-allow-credentials": "true",
              },
            }),
          ],
          accounts,
        ),
      );

      expect(findings, String(status)).toHaveLength(1);
    }
  });
});

describe("a declared origin written with whitespace around it", () => {
  it("still matches the echo, because the header it is compared with is trimmed too", () => {
    // Measured by adversarial review: through the library door a trailing space
    // made the declared origin match nothing, silently, on the platform it was
    // meant to catch.
    const check = createCorsCheck({
      foreignOrigins: new Map([["foreign", " https://attacker.example "]]),
    });

    const findings = check.run(
      contextOf(
        [
          observation({
            accountId: "alice@foreign",
            headers: {
              "access-control-allow-origin": "https://attacker.example",
              "access-control-allow-credentials": "true",
            },
          }),
        ],
        [{ id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" }],
      ),
    );

    expect(findings).toHaveLength(1);
  });

  it("is ignored when nothing is left of it, in the verdict and in the coverage", () => {
    // The account is declared this time. The first version of this test left it
    // out, so the lookup missed and the coverage was empty whatever the declared
    // origin was: it passed with the filter deleted and with the filter and the
    // trim in the wrong order, which is exactly what its whitespace-only input is
    // there to tell apart.
    const check = createCorsCheck({ foreignOrigins: new Map([["foreign", "  \t "]]) });
    const accounts = [
      { id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" },
    ];
    const echoingNothing = observation({
      accountId: "alice@foreign",
      headers: { "access-control-allow-origin": "", "access-control-allow-credentials": "true" },
    });

    expect(check.run(contextOf([echoingNothing], accounts))).toEqual([]);
    expect(check.coverage?.(contextOf([echoingNothing], accounts))?.[0]?.counters).toEqual({
      corsResponsesSeen: 1,
      corsResponsesAllowingCredentials: 1,
    });
  });
});

/**
 * The one reader of the counter that says the reflection question was put. The
 * run's warning for a marker nobody acted on rests on it, so it is held here.
 */
describe("foreignOriginCellsAnswered", () => {
  const row = (checkId: string, counters: Record<string, number>) => ({
    checkId,
    endpointId: "e",
    counters,
  });

  it("is zero over nothing, and over a run whose check wrote no such counter", () => {
    expect(foreignOriginCellsAnswered([])).toBe(0);
    expect(
      foreignOriginCellsAnswered([
        row(CORS_CHECK_ID, { corsResponsesSeen: 4, corsResponsesAllowingCredentials: 1 }),
      ]),
    ).toBe(0);
  });

  it("sums the counter over the endpoints of this check", () => {
    expect(
      foreignOriginCellsAnswered([
        row(CORS_CHECK_ID, { foreignOriginCellsAnswered: 2 }),
        row(CORS_CHECK_ID, { foreignOriginCellsAnswered: 3 }),
      ]),
    ).toBe(5);
  });

  it("does not read another check's rows, whatever they are called", () => {
    expect(
      foreignOriginCellsAnswered([
        row("identical-response-across-tenants", { foreignOriginCellsAnswered: 9 }),
      ]),
    ).toBe(0);
  });

  it("reads a counter only as an own property of the row", () => {
    // A report parsed back from JSON carries Object.prototype; a counter map that
    // inherits the name is not a counter this check wrote.
    const inherited = Object.create({ foreignOriginCellsAnswered: 7 }) as Record<string, number>;

    expect(foreignOriginCellsAnswered([row(CORS_CHECK_ID, inherited)])).toBe(0);
  });

  it("agrees with what the check writes", () => {
    const check = createCorsCheck({ foreignOrigins: new Map([["foreign", "https://a.example"]]) });
    const coverage = check.coverage?.(
      contextOf(
        [observation({ accountId: "alice@foreign" }), observation({ accountId: "alice@foreign" })],
        [{ id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" }],
      ),
    );

    // The same cell twice is two cells to the check; the reader must not decide
    // otherwise.
    expect(foreignOriginCellsAnswered(coverage ?? [])).toBe(2);
  });
});

/**
 * What the pre-release review found the first version of the check did not hold.
 * Each case here failed, or survived a mutant, before the fix beside it.
 */
describe("what the check reads and how it names a cell", () => {
  const both = (origin: string, credentials = "true") => ({
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": credentials,
  });
  const alice = [{ id: "alice", roleId: "user" }] as const;
  const people = [
    { id: "alice", roleId: "user" },
    { id: "bob", roleId: "user" },
  ] as const;

  describe("HTTP whitespace and no other", () => {
    it("trims what a header value is trimmed of, in the verdict and in the evidence", () => {
      const findings = check.run(
        contextOf(
          [
            observation({ accountId: "alice", headers: both(" * ", "\ttrue ") }),
            observation({ accountId: "bob", endpointId: "other", headers: both("\tnull\t") }),
          ],
          people,
        ),
      );

      expect(findings.map((one) => one.evidence.allowOrigin)).toEqual(["*", "null"]);
    });

    it("does not trim a no-break space, which no browser does", () => {
      // `String.prototype.trim` strips U+00A0 and the vertical tab, the form feed
      // and the Unicode spaces. Fetch does not, so each of these is no grant in
      // any browser and a finding on it would be about a request nobody can make.
      for (const [origin, credentials] of [
        ["\u00a0null", "true"],
        ["null\u00a0", "true"],
        ["*", "true\u00a0"],
        ["*", "\u000btrue"],
        ["\u2003*", "true"],
      ] as const) {
        const findings = check.run(
          contextOf([observation({ headers: both(origin, credentials) })], alice),
        );

        expect(findings, JSON.stringify([origin, credentials])).toEqual([]);
      }
    });

    it("trims the declared origin the same way and no wider", () => {
      const declared = createCorsCheck({
        foreignOrigins: new Map([["foreign", "\u00a0https://attacker.example"]]),
      });
      const accounts = [
        { id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" },
      ];

      // A declared origin that starts with a no-break space is not the origin a
      // browser sends, and an echo of the plain one must not match it.
      expect(
        declared.run(
          contextOf(
            [
              observation({
                accountId: "alice@foreign",
                headers: both("https://attacker.example"),
              }),
            ],
            accounts,
          ),
        ),
      ).toEqual([]);
    });
  });

  describe("the case a consumer's harness spelled the names in", () => {
    it("finds, and counts, headers written in the case HTTP libraries use", () => {
      const observations = [
        observation({
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": "true",
          },
        }),
      ];

      expect(check.run(contextOf(observations, alice))).toHaveLength(1);
      expect(check.coverage?.(contextOf(observations, alice))?.[0]?.counters).toEqual({
        corsResponsesSeen: 1,
        corsResponsesAllowingCredentials: 1,
      });
    });

    it("still refuses a name that is only inherited", () => {
      // A report parsed back from JSON carries Object.prototype; a name the record
      // does not own is not a header the response had, in any case.
      const poisoned = Object.create({
        "Access-Control-Allow-Origin": "*",
        "access-control-allow-credentials": "true",
      }) as Record<string, string>;

      expect(check.run(contextOf([observation({ headers: poisoned })], alice))).toEqual([]);
      expect(check.coverage?.(contextOf([observation({ headers: poisoned })], alice))).toEqual([]);
    });
  });

  describe("one finding per shape, not per endpoint", () => {
    it("reports both shapes when two accounts give different ones on one endpoint", () => {
      // A collapse to one finding per endpoint and condition would drop the high
      // `null` finding whenever a medium `*` one came first.
      const findings = check.run(
        contextOf(
          [
            observation({ accountId: "alice", headers: both("*") }),
            observation({ accountId: "bob", headers: both("null") }),
          ],
          people,
        ),
      );

      expect(findings.map((one) => one.severity).sort()).toEqual(["high", "medium"]);
    });
  });

  describe("the declared origin is matched whole", () => {
    const FOREIGN = "https://attacker.example";
    const declared = createCorsCheck({ foreignOrigins: new Map([["foreign", FOREIGN]]) });
    const accounts = [
      { id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" },
    ];

    it("says nothing about an echo that is only near it", () => {
      // A match by prefix or by substring would call each of these a platform that
      // trusts the declared origin: a high finding on a platform that does not.
      for (const near of [
        "https://attacker.example:8443",
        "https://attacker.example.evil.test",
        "https://attacker.example/",
        "https://attacker.exampl",
        "https://xattacker.example",
        "http://attacker.example",
        "https://attacker.example, https://other.example",
      ]) {
        const findings = declared.run(
          contextOf([observation({ accountId: "alice@foreign", headers: both(near) })], accounts),
        );

        expect(findings, near).toEqual([]);
      }
    });

    it("matches the declared origin when it is padded in the response", () => {
      const findings = declared.run(
        contextOf(
          [observation({ accountId: "alice@foreign", headers: both(` ${FOREIGN}\t`) })],
          accounts,
        ),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.evidence.allowOrigin).toBe(FOREIGN);
    });
  });

  describe("the output does not depend on the order the cells arrive in", () => {
    const cells = [
      observation({ accountId: "bob", endpointId: "z-last", status: 403, headers: both("null") }),
      observation({ accountId: "alice", endpointId: "a-first", status: 200, headers: both("*") }),
      observation({ accountId: "bob", endpointId: "a-first", status: 403, headers: both("*") }),
      observation({ accountId: "alice", endpointId: "m-mid", status: 200, headers: both("null") }),
    ];

    it("gives the same findings, in endpoint order, whichever way the cells are fed", () => {
      const forward = check.run(contextOf(cells, people));
      const backward = check.run(contextOf([...cells].reverse(), people));

      expect(backward).toEqual(forward);
      // Asserted as it comes out, not sorted afterwards: the order is the claim.
      expect(forward.map((one) => one.endpointId)).toEqual(["a-first", "m-mid", "z-last"]);
    });

    it("names the cell by a rule: the first account by code unit, then the lower status", () => {
      const findings = check.run(contextOf(cells, people));
      const wildcard = findings.find((one) => one.endpointId === "a-first");

      // alice and bob both answered `*` on a-first; alice sorts first, so it is
      // alice's status that the finding carries, not bob's 403.
      expect(wildcard?.accountId).toBe("alice");
      expect(wildcard?.evidence.status).toBe(200);

      const sameAccount = check.run(
        contextOf(
          [
            observation({ accountId: "alice", status: 403, headers: both("*") }),
            observation({ accountId: "alice", status: 200, headers: both("*") }),
          ],
          alice,
        ),
      );
      expect(sameAccount[0]?.evidence.status).toBe(200);
    });

    it("gives the coverage rows in endpoint order whichever way the cells are fed", () => {
      const forward = check.coverage?.(contextOf(cells, people));
      const backward = check.coverage?.(contextOf([...cells].reverse(), people));

      expect(backward).toEqual(forward);
      expect(forward?.map((row) => row.endpointId)).toEqual(["a-first", "m-mid", "z-last"]);
    });
  });
});

/**
 * Edges the second pre-release review found unpinned in the fixes of the first.
 */
describe("the edges of how the check reads and names", () => {
  const pair = (origin: string, credentials = "true") => ({
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": credentials,
  });
  const solo = [{ id: "alice", roleId: "user" }] as const;
  const people = [
    { id: "alice", roleId: "user" },
    { id: "bob", roleId: "user" },
    { id: "Zed", roleId: "user" },
  ] as const;

  describe("two keys that differ only in case", () => {
    it("reads the exact lower-case one, whatever the order they were set in", () => {
      const forward = { "access-control-allow-origin": "null", "ACCESS-CONTROL-ALLOW-ORIGIN": "*" };
      const backward = {
        "ACCESS-CONTROL-ALLOW-ORIGIN": "*",
        "access-control-allow-origin": "null",
      };

      for (const origin of [forward, backward]) {
        const findings = check.run(
          contextOf(
            [observation({ headers: { ...origin, "access-control-allow-credentials": "true" } })],
            solo,
          ),
        );

        expect(findings.map((one) => one.evidence.allowOrigin)).toEqual(["null"]);
      }
    });

    it("reads the first by code unit when none is the lower-case one", () => {
      // "ACCESS-..." sorts before "Access-..." because "C" is before "c", so the
      // answer is "*" in both orders and not whichever key came first.
      const one = { "Access-Control-Allow-Origin": "null", "ACCESS-CONTROL-ALLOW-ORIGIN": "*" };
      const other = { "ACCESS-CONTROL-ALLOW-ORIGIN": "*", "Access-Control-Allow-Origin": "null" };

      for (const origin of [one, other]) {
        const findings = check.run(
          contextOf(
            [observation({ headers: { ...origin, "access-control-allow-credentials": "true" } })],
            solo,
          ),
        );

        expect(findings.map((finding) => finding.evidence.allowOrigin)).toEqual(["*"]);
      }
    });
  });

  it("does not throw on a header value that is not a string, and reads it as absent", () => {
    // A record parsed from a file this tool did not write can hold anything. A
    // `null` would have thrown in the trim and taken the check out of the run.
    const headers = {
      "access-control-allow-origin": null,
      "access-control-allow-credentials": "true",
    } as unknown as Record<string, string>;

    expect(() => check.run(contextOf([observation({ headers })], solo))).not.toThrow();
    expect(check.run(contextOf([observation({ headers })], solo))).toEqual([]);
    expect(check.coverage?.(contextOf([observation({ headers })], solo))).toEqual([]);
  });

  describe("the cell a finding names", () => {
    it("is the first account by code unit, whatever the statuses", () => {
      // The rule is account first and status second. A rule on status alone would
      // name bob's 200 here, and a rule by locale would name alice, whose "a" sorts
      // before "Z" in a dictionary and after it by code unit.
      const findings = check.run(
        contextOf(
          [
            observation({ accountId: "bob", status: 200, headers: pair("*") }),
            observation({ accountId: "alice", status: 403, outcome: "denied", headers: pair("*") }),
            observation({ accountId: "Zed", status: 401, outcome: "denied", headers: pair("*") }),
          ],
          people,
        ),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.accountId).toBe("Zed");
      expect(findings[0]?.evidence.status).toBe(401);
    });
  });

  describe("the order of findings on one endpoint", () => {
    it("is by condition and then by title, whichever way the cells are fed", () => {
      const accounts = [
        { id: "alice", roleId: "user" },
        { id: "alice@b", roleId: "user", contextId: "b", baseAccountId: "alice" },
        { id: "alice@a", roleId: "user", contextId: "a", baseAccountId: "alice" },
      ];
      const cells = [
        observation({ accountId: "alice@b", headers: pair("*") }),
        observation({ accountId: "alice@a", headers: pair("null") }),
        observation({ accountId: "alice@a", headers: pair("*") }),
        observation({ accountId: "alice", headers: pair("null") }),
      ];

      const forward = check.run(contextOf(cells, accounts));
      const backward = check.run(contextOf([...cells].reverse(), accounts));

      expect(backward).toEqual(forward);
      // Baseline first (no condition sorts as the empty string), then a, then b;
      // inside "a" the two shapes in the order of their titles, "allows any
      // origin" before "allows the null origin", which is the wildcard first.
      expect(forward.map((one) => [one.contextId ?? "", one.severity])).toEqual([
        ["", "high"],
        ["a", "medium"],
        ["a", "high"],
        ["b", "medium"],
      ]);
    });
  });

  describe("HTTP whitespace, all four characters of it", () => {
    it("trims a line feed and a carriage return as well as a tab and a space", () => {
      const findings = check.run(
        contextOf(
          [
            observation({ accountId: "alice", headers: pair("\n*\r\n", "\r\ntrue\n") }),
            observation({ accountId: "bob", endpointId: "other", headers: pair("\t null \t") }),
          ],
          people,
        ),
      );

      expect(findings.map((one) => one.evidence.allowOrigin)).toEqual(["*", "null"]);
    });
  });

  describe("the declared origin and the near misses it is not", () => {
    const FOREIGN = "https://attacker.example";
    const declared = createCorsCheck({ foreignOrigins: new Map([["foreign", FOREIGN]]) });
    const accounts = [
      { id: "alice@foreign", roleId: "user", contextId: "foreign", baseAccountId: "alice" },
    ];

    it("is not matched by an upper-case scheme, a bare colon, a fragment or a different scheme", () => {
      for (const near of [
        "HTTPS://attacker.example",
        "https://attacker.example:",
        "https://attacker.example#x",
        "ftp://attacker.example",
        "https://attacker.example\\u0000",
      ]) {
        const findings = declared.run(
          contextOf([observation({ accountId: "alice@foreign", headers: pair(near) })], accounts),
        );

        expect(findings, near).toEqual([]);
      }
    });
  });

  it("states in the description it ships in every report that it reads every answered cell", () => {
    // Shipped in `coverage.checksRun[].description`, and the first version said the
    // opposite of what the check did. Pinned so that the sentence cannot drift back.
    expect(check.description).toContain("every answered cell");
    expect(check.description).not.toContain("under a declared origin condition");
  });
});

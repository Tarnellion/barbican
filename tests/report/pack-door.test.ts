/**
 * The tenth door: a saved report read to build a pack from.
 *
 * A report file can come from another machine, an earlier build or somebody
 * else, exactly like an OpenAPI file. ADR-0066 put the identifier grammar on the
 * comparison's reader and called it the ninth door; this is the same document
 * read for a different purpose, and a rendered document is a **new sink** — the
 * strings below travel into a page rather than only onto a terminal.
 *
 * Two things are under test. That the door refuses what it must, naming the
 * field and the file; and that it can read what this tool actually writes, which
 * a hand-written fixture can never show — the reader names its fields as string
 * literals, so nothing but a real report keeps them level with `shape.ts`.
 *
 * See ADR-0067.
 */

import { describe, expect, it } from "vitest";
import { UnusableIdentifierError } from "../../src/core/identifiers.js";
import type { AccessObservation, Account, Endpoint } from "../../src/core/index.js";
import { buildAccessMatrix, describeMatrix, expandPolicy } from "../../src/core/index.js";
import { createBundledCatalog } from "../../src/core/standards/bundled.js";
import { parseRunConfig } from "../../src/io/config.js";
import type { RunReport } from "../../src/report/build.js";
import { buildReport } from "../../src/report/build.js";
import { UnreadableReportError } from "../../src/report/compare.js";
import { evidencePack, toPackableRun } from "../../src/report/pack.js";

const CONFIG = parseRunConfig(`
target: { baseUrl: "https://api.test", allowedHosts: [api.test], label: demo }
accounts:
  - { id: alice, role: user, tenant: tenant-a, tokenEnv: T_ALICE, canary: me }
policy:
  fallback: denied
  rules:
    - { roles: [user], endpoints: [me], outcome: allowed }
`);

const ACCOUNTS: readonly Account[] = [{ id: "alice", roleId: "user", tenantId: "tenant-a" }];

const ENDPOINTS: readonly Endpoint[] = [
  { id: "me", method: "GET", path: "/v1/me" },
  { id: "admin.accounts", method: "GET", path: "/v1/admin/accounts" },
];

function seen(
  endpointId: string,
  status: number,
  outcome: "allowed" | "denied",
): AccessObservation {
  return { accountId: "alice", endpointId, status, headers: {}, outcome, durationMs: 1 };
}

/** The admin list is open to a plain user: one privilege escalation. */
const BROKEN: readonly AccessObservation[] = [
  seen("me", 200, "allowed"),
  seen("admin.accounts", 200, "allowed"),
];

function reportOf(): RunReport {
  const matrix = buildAccessMatrix({
    endpoints: ENDPOINTS,
    accounts: ACCOUNTS,
    observations: BROKEN,
  });
  const policy = expandPolicy(
    { fallback: "denied", rules: [{ roles: ["user"], endpoints: ["me"], outcome: "allowed" }] },
    ENDPOINTS,
  );
  const walked = describeMatrix(matrix, policy);
  return buildReport({
    version: "test",
    config: CONFIG,
    accounts: ACCOUNTS,
    endpoints: ENDPOINTS,
    probed: ENDPOINTS,
    observations: BROKEN,
    skipped: [],
    failures: [],
    unauthenticated: [],
    canariesChecked: 1,
    canaries: [{ accountId: "alice", endpointId: "me", status: 200, authenticated: true }],
    truncated: false,
    findings: walked.diffs,
    cells: walked.cells,
    policy,
    startedAt: new Date(0),
    finishedAt: new Date(1),
  });
}

/** What lands on disk: the report through `JSON.stringify` and back. */
function onDisk(edit: (document: Record<string, unknown>) => void = () => {}): unknown {
  const document = JSON.parse(JSON.stringify(reportOf())) as Record<string, unknown>;
  edit(document);
  return document;
}

/**
 * The first clause row of a fixture report, for an edit to be made to.
 *
 * It throws rather than asserting the row is there: an edit made to nothing
 * would leave the document untouched, and every refusal below would then be
 * asserted against a document with nothing wrong with it.
 */
function firstClause(document: Record<string, unknown>): Record<string, unknown> {
  const coverage = document["coverage"] as Record<string, unknown>;
  const row = (coverage["clauses"] as Record<string, unknown>[])[0];
  if (row === undefined) {
    throw new Error("the fixture report carries no clause rows to edit");
  }
  return row;
}

describe("a report this tool wrote", () => {
  /**
   * The assertion the hand-written fixtures cannot make.
   *
   * `toPackableRun` names `coverage.clauses`, `findings[].standards`,
   * `findingsOmitted` and eleven more as string literals. Nothing but a real
   * report keeps that list level with `shape.ts`: rename a field there and every
   * test built on a `PackableRun` literal stays green while the door starts
   * refusing the tool's own files.
   */
  it("is readable, and the pack made of it says what the run found", () => {
    const pack = evidencePack({
      run: toPackableRun(onDisk(), "report.json"),
      catalog: createBundledCatalog(),
    });

    expect(pack.standing).toBe("evidence");
    expect(pack.run.runId.length).toBeGreaterThan(0);
    expect(pack.run.surface.cellsObserved).toBe(2);
    // The escalation is on the two clauses `standardsForDiff` gives it and on
    // the control clause every cell cites.
    const claims = new Map(pack.clauses.map((one) => [`${one.standard} ${one.clause}`, one.claim]));
    expect(claims.get("OWASP-ASVS-5.0 8.1.1")).toBe("breached");
    expect(claims.get("OWASP-API-2023 API5")).toBe("breached");
    expect(claims.get("CWE 285")).toBe("breached");
    // And the clauses nothing in this run answered for are not thereby passed.
    expect(claims.get("OWASP-ASVS-5.0 8.4.1")).toBe("unanswered");
    expect(claims.get("CWE 639")).toBe("unanswered");
  });

  it("gives the same pack twice, from the same file", () => {
    const document = onDisk();
    const twice = [0, 1].map(() =>
      JSON.stringify(
        evidencePack({
          run: toPackableRun(document, "report.json"),
          catalog: createBundledCatalog(),
        }),
      ),
    );

    expect(twice[0]).toBe(twice[1]);
  });
});

describe("a document that is not one", () => {
  it("is refused when it is not an object at all", () => {
    expect(() => toPackableRun("[]", "report.json")).toThrow(UnreadableReportError);
    expect(() => toPackableRun(null, "report.json")).toThrow(UnreadableReportError);
    expect(() => toPackableRun([], "report.json")).toThrow(UnreadableReportError);
  });

  it("names the file and the field it stopped on", () => {
    expect(() =>
      toPackableRun(
        onDisk((one) => delete one["findings"]),
        "yesterday.json",
      ),
    ).toThrow(/yesterday\.json.*"findings" is missing or is not an array/s);
  });

  /**
   * A shape this build cannot read is refused rather than read as an empty run.
   *
   * The one place this reader parts company with `toComparableRun`, which states
   * a version mismatch instead of throwing: there are two files there and one
   * here, so there is nothing to state the difference against — and a pack built
   * from a shape whose `coverage.clauses` is somewhere else would report every
   * clause unanswered over a run that answered for all of them. That is this
   * module's own worst failure, pointed at itself.
   */
  it("is refused when its schemaVersion is not the one this build reads", () => {
    expect(() =>
      toPackableRun(
        onDisk((one) => {
          one["schemaVersion"] = "1";
        }),
        "old.json",
      ),
    ).toThrow(/schemaVersion 1 and this build reads 2/);
  });

  /**
   * And when it predates the field the whole pack is built on.
   *
   * `coverage.clauses` arrived in 0.5.0 and `schemaVersion` deliberately stayed
   * `2`, so a 0.4.0 report passes the check above and reaches here. Refused with
   * the reason rather than with "missing or is not an array", because this is the
   * absence a reader will actually meet.
   */
  it("is refused when it carries no clause coverage", () => {
    expect(() =>
      toPackableRun(
        onDisk((one) => {
          delete (one["coverage"] as Record<string, unknown>)["clauses"];
        }),
        "0.4.0.json",
      ),
    ).toThrow(/carries no "coverage\.clauses"/);
  });

  /**
   * A row of an array that is not an object at all.
   *
   * Three arrays carry rows a pack reads, and each of them is a place a document
   * may hold a number, a string or a `null` where a row belongs. Named by its
   * position, because a file with forty clause rows in it needs the index — and
   * asserted one by one, because the three readers are three functions and a
   * missing guard in any of them is an object index on something that is not an
   * object.
   */
  it("is refused where a row of an array is not an object", () => {
    const cases: readonly [string, (one: Record<string, unknown>) => void, RegExp][] = [
      [
        "a clause row",
        (one) => {
          (one["coverage"] as Record<string, unknown>)["clauses"] = [42];
        },
        /coverage\.clauses\[0\] is not an object/,
      ],
      [
        "a finding row",
        (one) => {
          one["findings"] = [null];
        },
        /findings\[0\] is not an object/,
      ],
      [
        "a clause reference on a finding",
        (one) => {
          const findings = one["findings"] as Record<string, unknown>[];
          one["findings"] = [{ ...findings[0], standards: ["OWASP-ASVS-5.0 8.1.1"] }];
        },
        /findings\[0\]\.standards\[0\] is not an object/,
      ],
    ];

    for (const [what, edit, message] of cases) {
      expect(() => toPackableRun(onDisk(edit), "broken.json"), what).toThrow(message);
    }
  });
});

/**
 * Every string lifted out of the file goes through the identifier grammar.
 *
 * The strings below are the platform's, the operator's, or another machine's,
 * and each of them travels into a document a person reads. A newline in a clause
 * id makes one row of a table read as two; `U+001B` is a command to a terminal
 * and the opening of an escape sequence; and the renderer above this has one
 * grammar to be right about instead of two. ADR-0066 for the rule, ADR-0067 for
 * why a pack is the sink that made it worth applying twice.
 */
describe("a string that is not text", () => {
  /**
   * `U+001B [31m`, built from its code point.
   *
   * Written out rather than typed: a raw escape character in a test file is a
   * file that mangles the terminal of anybody who cats it, and the precedent
   * is `RAW_SEPARATOR` in `tests/invariants/one-decision-one-home.test.ts`.
   */
  const ESCAPE = `${String.fromCharCode(0x1b)}[31m`;

  it("is refused in a clause identifier", () => {
    expect(() =>
      toPackableRun(
        onDisk((one) => {
          firstClause(one)["clause"] = `8.1.1${ESCAPE}`;
        }),
        "hostile.json",
      ),
    ).toThrow(UnusableIdentifierError);
  });

  it("is refused in a reservation code", () => {
    expect(() =>
      toPackableRun(
        onDisk((one) => {
          firstClause(one)["reservations"] = [`run-truncated${ESCAPE}`];
        }),
        "hostile.json",
      ),
    ).toThrow(/coverage\.clauses\[0\]\.reservations\[0\] in the report "hostile\.json"/);
  });

  it("is refused in a warning, in a verdict reason and in a label", () => {
    for (const edit of [
      (one: Record<string, unknown>) => {
        one["warnings"] = [`nothing was refused${ESCAPE}`];
      },
      (one: Record<string, unknown>) => {
        (one["verdict"] as Record<string, unknown>)["reason"] = `all clear${ESCAPE}`;
      },
      (one: Record<string, unknown>) => {
        (one["target"] as Record<string, unknown>)["label"] = `production${ESCAPE}`;
      },
    ]) {
      expect(() => toPackableRun(onDisk(edit), "hostile.json")).toThrow(UnusableIdentifierError);
    }
  });

  /** And the refusal does not carry what it is refusing onto the screen. */
  it("spells the character out rather than repeating it", () => {
    try {
      toPackableRun(
        onDisk((one) => {
          one["warnings"] = [`nothing was refused${ESCAPE}`];
        }),
        "hostile.json",
      );
      expect.unreachable("the door admitted an escape sequence");
    } catch (error) {
      const message = (error as Error).message;

      expect(message).toContain("\\u001B");
      expect(message).not.toContain(ESCAPE);
    }
  });
});

/**
 * The records whose keys came out of a file.
 *
 * `inconclusive` is keyed by the reasons a cell concluded nothing, and a file may
 * spell one of them `__proto__`. An object literal swallows that assignment — the
 * write is a no-op and the row disappears from a count the reader is relying on
 * to be complete. ADR-0024; the same guard `toComparableRun` puts on `notProbed`.
 */
describe("a count keyed by a name from the file", () => {
  it("keeps a reason literally named __proto__", () => {
    const run = toPackableRun(
      onDisk((one) => {
        firstClause(one)["matrixCells"] = JSON.parse(
          '{"conclusive":1,"upheld":1,"breached":0,"inconclusive":{"__proto__":4}}',
        );
      }),
      "report.json",
    );

    expect(Object.keys(run.clauses[0]?.matrixCells?.inconclusive ?? {})).toEqual(["__proto__"]);
  });
});

/**
 * An acceptance holds a row out of the verdict until the day it names.
 *
 * The pack counts the held rows separately and keeps the clause breached either
 * way (ADR-0048). What is read here is the mark itself: a lapsed one stops
 * holding, and the row counts again.
 */
describe("the acceptance mark on a finding", () => {
  function heldRows(expired: boolean | undefined): number {
    const run = toPackableRun(
      onDisk((one) => {
        const findings = one["findings"] as Record<string, unknown>[];
        for (const finding of findings) {
          finding["accepted"] =
            expired === undefined
              ? { reason: "known", until: "2026-12-31" }
              : { reason: "known", until: "2026-12-31", expired };
        }
      }),
      "report.json",
    );
    return run.findings.filter((one) => one.heldByAcceptance).length;
  }

  it("holds while it has not expired", () => {
    expect(heldRows(false)).toBeGreaterThan(0);
  });

  it("stops holding once it has", () => {
    expect(heldRows(true)).toBe(0);
  });

  it("holds where the mark does not say, which is the older shape", () => {
    expect(heldRows(undefined)).toBeGreaterThan(0);
  });
});

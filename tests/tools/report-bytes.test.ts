/**
 * The comparison that says a refactor changed no report.
 *
 * `tools/report-bytes.mjs` was 227 lines with no test beside it, while nearly
 * every other module under `tools/` has one. Its whole guarantee rests on two
 * things: `normalize`, which decides what two reports are compared **on**, and
 * `VOLATILE`, the list of names it stops comparing. The second is a denylist,
 * and a denylist's failure modes are not symmetric — a name missing from it
 * makes two runs disagree loudly, and a name added to it makes them agree about
 * a field neither side looked at.
 *
 * So what is held here is the asymmetric half. The table is exact in both
 * directions and every entry carries its reason; the manifest carries a census
 * of what was masked, so a name added later shows up as a difference between two
 * manifests even when every digest matches; and `normalize` is held on the
 * shapes a report actually has.
 *
 * **What is not held here.** Whether a name in `VOLATILE` is really volatile.
 * That needs two runs of the same tree against the same platform, and this tool
 * makes one — the whole reason it exists is to be run twice, by hand, on two
 * revisions. A field wrongly listed is a field two revisions are never compared
 * on, and nothing in this file would notice.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  censusLines,
  digestOf,
  manifestDifferences,
  manifestOf,
  normalize,
  VOLATILE,
} from "../../tools/report-bytes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The report's own inventory of key paths, held by `tests/report/report-shape.test.ts`. */
const SHAPE = JSON.parse(readFileSync(resolve(ROOT, "tests/report/report-shape.json"), "utf8")) as {
  shape: Record<string, string>;
};

const names = new Set(
  Object.keys(SHAPE.shape).flatMap((path) => path.split(".").map((one) => one.replace("[]", ""))),
);

describe("the list of what is not compared", () => {
  /**
   * Exact in both directions and spelled out here, so that adding a name is an
   * edit to two files with a reason in each rather than one word in a `Set`.
   */
  it("is exactly these seven names", () => {
    expect(Object.keys(VOLATILE).sort()).toEqual([
      "at",
      "contentDigest",
      "date",
      "durationMs",
      "finishedAt",
      "runId",
      "startedAt",
    ]);
  });

  it("says why about each of them", () => {
    for (const [name, reason] of Object.entries(VOLATILE)) {
      expect(reason.length, `${name} has no reason beside it`).toBeGreaterThan(8);
    }
  });

  /**
   * A name the report does not carry masks nothing and hides the fact.
   *
   * Checked against `report-shape.json` — the inventory of every key path the
   * report has, which `tests/report/report-shape.test.ts` compares against a
   * real document. `date` is the one exception and it is not an exception to
   * the rule: it is a **response header** name, so it appears under
   * `observations[].headers.<name>` only when the platform sent one, and the
   * fixture's platform did not. It reaches a report at all because
   * `VALUE_PRESERVED_HEADERS` keeps it.
   */
  it("names nothing the report does not have", () => {
    const missing = Object.keys(VOLATILE).filter((name) => !names.has(name));

    expect(missing).toEqual(["date"]);
    expect(readFileSync(resolve(ROOT, "src/adapters/http.ts"), "utf8")).toContain('  "date",');
  });
});

describe("normalising a report", () => {
  it("replaces a volatile value wherever it sits", () => {
    const census = new Map<string, number>();
    const normalised = normalize(
      { runId: "a", nested: { at: "then", keep: 1 }, list: [{ durationMs: 5 }] },
      new Map(),
      census,
    );

    expect(normalised).toEqual({
      runId: "<runId>",
      nested: { at: "<at>", keep: 1 },
      list: [{ durationMs: "<durationMs>" }],
    });
    expect([...census]).toEqual([
      ["runId", 1],
      ["at", 1],
      ["durationMs", 1],
    ]);
  });

  it("leaves everything else exactly as it was", () => {
    const document = {
      verdict: { match: false, exitCode: 3 },
      findings: [{ cell: "a", severity: null }],
      empty: [],
    };

    expect(normalize(document, new Map())).toEqual(document);
  });

  /**
   * The defect this tool exists to have caught, in the tool itself.
   *
   * `out[key] = …` on an object literal walks into the `__proto__` setter
   * instead of defining a property, so a set of request conditions called
   * `__proto__` disappeared from the normalised document — the same
   * disappearance the audit of 23 August found in `coverage.contextsProbed`,
   * one layer down and in the thing that was supposed to notice it.
   */
  it("keeps a key called __proto__", () => {
    // Through `JSON.parse`, which is how the tool receives a report and the only
    // way to get the key at all: in an object literal `__proto__:` is the
    // prototype setter and no property is created.
    const document: unknown = JSON.parse('{"contextsProbed":{"__proto__":2,"plain":1}}');
    const normalised = normalize(document, new Map()) as {
      contextsProbed: Record<string, unknown>;
    };

    expect(Object.keys(normalised.contextsProbed)).toEqual(["__proto__", "plain"]);
    expect(JSON.stringify(normalised)).toContain("__proto__");
  });

  /**
   * The salted body digests are compared by their equality relation: "these two
   * tenants saw the same list" has to survive, and the number must not.
   */
  it("keeps which body digests are equal and not what they were", () => {
    const shared = new Map<number, number>();
    const first = normalize({ a: { digest: 900 }, b: { digest: 900 }, c: { digest: 7 } }, shared);
    const second = normalize(
      { a: { digest: 12 }, b: { digest: 12 }, c: { digest: 4 } },
      new Map<number, number>(),
    );

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain("900");
  });

  it("gives two reports that differ only in their volatile parts one digest", () => {
    const one = { runId: "r1", startedAt: "t1", cells: [{ at: "t2", status: 403 }] };
    const other = { runId: "r2", startedAt: "t3", cells: [{ at: "t4", status: 403 }] };

    expect(digestOf(one)).toBe(digestOf(other));
  });

  it("gives two reports that differ anywhere else two digests", () => {
    expect(digestOf({ runId: "r1", status: 403 })).not.toBe(digestOf({ runId: "r1", status: 200 }));
  });
});

describe("the manifest", () => {
  const reports = [
    { name: "b-combination", report: { runId: "x", status: 200 } },
    { name: "a-combination", report: { runId: "y", status: 200 } },
  ];

  it("is one line per report, in name order, under the census", () => {
    const lines = manifestOf(reports)
      .split("\n")
      .filter((line) => line !== "");

    expect(lines.filter((line) => line.startsWith("masked "))).toHaveLength(
      Object.keys(VOLATILE).length,
    );
    expect(lines.slice(-2).map((line) => line.slice(34))).toEqual([
      "a-combination",
      "b-combination",
    ]);
    // Thirty-two hexadecimal characters, two spaces, the combination's name.
    expect(lines.at(-1)).toMatch(/^[0-9a-f]{32} {2}b-combination$/);
  });

  it("counts every name in the list, including the ones that masked nothing", () => {
    const census = new Map([["runId", 2]]);

    expect(censusLines(census)).toBe(
      [
        "masked at 0",
        "masked contentDigest 0",
        "masked date 0",
        "masked durationMs 0",
        "masked finishedAt 0",
        "masked runId 2",
        "masked startedAt 0",
        "",
      ].join("\n"),
    );
  });

  it("says nothing about two manifests that agree", () => {
    expect(manifestDifferences(manifestOf(reports), manifestOf(reports))).toEqual([]);
  });

  it("names the report that changed", () => {
    const changed = [
      reports[0] as (typeof reports)[0],
      { name: "a-combination", report: { status: 500 } },
    ];

    expect(manifestDifferences(manifestOf(reports), manifestOf(changed)).join("\n")).toContain(
      "DIFFERS: a-combination",
    );
  });

  /**
   * The asymmetric failure, made loud. Both sides digest to the same value
   * because one of them stopped comparing a field, and the census is the only
   * place that shows it.
   */
  it("names a field that stopped being compared even when every digest agrees", () => {
    const before = `masked runId 2\n${manifestOf(reports).split("\n").slice(7).join("\n")}`;
    const after = `masked runId 9\n${manifestOf(reports).split("\n").slice(7).join("\n")}`;

    const differences = manifestDifferences(before, after);

    expect(differences.join("\n")).toContain("MASKING: runId (2 -> 9 values)");
    expect(differences.join("\n")).toContain("agree about something neither side read");
  });

  it("names a field the other side did not have in its list at all", () => {
    const differences = manifestDifferences("masked runId 2\n", "masked runId 2\nmasked note 4\n");

    expect(differences.join("\n")).toContain("MASKING: note (not in the list -> 4 values)");
  });
});

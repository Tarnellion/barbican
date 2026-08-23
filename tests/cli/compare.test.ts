/**
 * The `diff` subcommand, from two paths to an exit code.
 *
 * Not one statement of this module was executed by the suite before ADR-0063:
 * `src/cli/` was outside the coverage `include`, and the only thing that ran the
 * subcommand at all was the polygon, in a CI job of its own. What that leaves
 * unheld is the whole shape of the command — which stream each half goes to, and
 * whether the code the process leaves with is the comparison's own.
 *
 * The two split streams are the point of the assertions below. The summary is
 * for a human and `--json` is for a pipeline, and mixing them would make
 * `barbican diff a b --json > out.json` produce a file that is not JSON — the
 * same split `run` makes for the same reason.
 *
 * The comparison itself belongs to `src/report/compare.ts` and is tested there,
 * on hand-written fixtures for the reason that file's header gives.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diff } from "../../src/cli/compare.js";

let directory: string;
let stderr: string[];
let stdout: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "barbican-cli-diff-"));
  stderr = [];
  stdout = [];
  // Pinned off, so that the assertions below compare sentences rather than
  // sentences wrapped in escape codes — vitest may be run on a terminal.
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A report as the file holds one, cut down to what a comparison reads. */
function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "2",
    runId: "11111111-1111-4111-8111-111111111111",
    configDigest: "aaaa000000000000",
    startedAt: "2026-08-20T09:00:00.000Z",
    truncated: false,
    target: { baseUrl: "https://api.test", label: "staging" },
    defects: [],
    observations: [{ endpointId: "orders.list" }],
    coverage: { endpointsTotal: 1, endpointsProbed: 1, cellsObserved: 1, notProbed: {} },
    verdict: { code: 0, reason: "no discrepancy with the declared policy" },
    ...over,
  };
}

/** One defect, in the shape the report prints and the comparison joins on. */
const REGRESSION = {
  key: "orders.list any-resource baseline",
  endpointId: "orders.list",
  kinds: ["privilege-escalation"],
  severity: "critical",
  accountIds: ["carol-b"],
  resourceIds: [],
  violations: 4,
};

async function saved(name: string, document: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(document), "utf8");
  return path;
}

describe("two saved reports read against each other", () => {
  it("says on stderr that nothing moved, and returns the comparison's code", async () => {
    const before = await saved("before.json", report());
    const after = await saved(
      "after.json",
      report({ runId: "22222222-2222-4222-8222-222222222222" }),
    );

    await expect(diff(before, after, false)).resolves.toBe(0);
    expect(stderr.join("")).toContain("the same defects, over the same surface");
    // Nothing on stdout without --json: the summary is for a human, and a
    // pipeline redirecting stdout gets an empty file rather than half a screen.
    expect(stdout).toEqual([]);
  });

  /**
   * A defect the later run has and the earlier one did not. The exit code is the
   * comparison's own — `diff` returns it rather than deciding one — so a
   * pipeline reads the same conclusion the screen shows.
   */
  it("reports a defect that appeared, and does not exit 0 on it", async () => {
    const before = await saved("before.json", report());
    const after = await saved(
      "after.json",
      report({
        runId: "22222222-2222-4222-8222-222222222222",
        startedAt: "2026-08-21T09:00:00.000Z",
        defects: [REGRESSION],
        verdict: { code: 1, reason: "the platform disagrees with the declared policy" },
      }),
    );

    const code = await diff(before, after, false);

    expect(code).not.toBe(0);
    expect(stderr.join("")).toContain("orders.list");
  });

  /**
   * `--json` writes the comparison to stdout and keeps the summary on stderr.
   * Both come out of one `compareRuns`, so the file and the terminal cannot
   * reach different conclusions — the mistake `WARNINGS` spent four days being.
   */
  it("writes the comparison to stdout under --json, and still says it on stderr", async () => {
    const before = await saved("before.json", report());
    const after = await saved(
      "after.json",
      report({ runId: "22222222-2222-4222-8222-222222222222", defects: [REGRESSION] }),
    );

    await diff(before, after, true);

    const written = JSON.parse(stdout.join("")) as { verdict: { code: number } };
    expect(written.verdict.code).not.toBe(0);
    expect(stderr.join("")).not.toBe("");
  });

  /** Which of the two paths is unreadable, because the system error names neither. */
  it("names the argument whose file is not there", async () => {
    const before = await saved("before.json", report());

    await expect(diff(before, join(directory, "absent.json"), false)).rejects.toThrow(
      /the second report cannot be read/,
    );
  });

  /** A document that is not a report is refused rather than compared as an empty one. */
  it("refuses a document that is not a report", async () => {
    const before = await saved("before.json", report());
    const after = await saved("after.json", { hello: "world" });

    await expect(diff(before, after, false)).rejects.toThrow();
  });
});

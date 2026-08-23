/**
 * The key of a cell is built in one place, and this is what says so.
 *
 * `cellKey` was written twice — character for character, once in
 * `src/runner/stream.ts` and once in `src/report/findings.ts` — and the doc
 * comment over the second copy read: "Written out by hand in five places, and
 * the sixth had to agree with all five for a verdict and a finding to meet on
 * the same cell." The warning had happened to the file that carried it, and
 * nothing noticed, because a comment asking the next reader to agree is not a
 * check. Both copies are `src/core/keys.ts` now; see ADR-0059.
 *
 * This test is the check. It reads the tracked sources — `git ls-files`, the
 * exact set that goes public, for the reason `tests/docs/language.test.ts`
 * gives — and refuses a second hand-written key under `src/`.
 *
 * The first time it ran it found two more that no reader had: `parse.ts` keyed
 * the acceptance duplicate check and `signals.ts` framed a digest, both with the
 * **byte itself** rather than with the escape, which is what makes a file binary
 * to `grep` — a search of the repository for the separator had been answering
 * "no matches" over two files that use it.
 *
 * ## What it can and cannot see
 *
 * It looks for the **separator**, because that character is what a key of this
 * shape is made of and copying one is how every duplicate here arrived. A key
 * glued with some other character would pass this gate and fail on its own
 * merits: it would not equal the keys everything else builds, and the tests that
 * join a verdict to a finding go red. A copy that imported `KEY_SEPARATOR` and
 * rebuilt the same string is caught by the last assertion instead — nothing
 * outside the owning module may declare a `cellKey` or an `objectKey`.
 *
 * The scan stops at `src/`. `tools/oracle/index.mjs` has a `cellKey` of its own
 * on purpose — an oracle that shared the tool's code would agree with itself —
 * and the tests that split `git ls-files -z` output split on a NUL that is not a
 * key at all.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cellKey, KEY_SEPARATOR, objectKey } from "../../src/core/keys.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The one module that owns the separator and the keys built out of it. */
const OWNER = "src/core/keys.ts";

/**
 * The separator as a source file may write it: the escape.
 *
 * Six characters, not one. The character itself is `RAW` below, written as a
 * code point rather than typed out — a raw NUL in this file would make the gate
 * itself unsearchable, which is half of what it is here to prevent.
 */
const ESCAPE = "\\u0000";
const RAW = String.fromCharCode(0);

/**
 * The one file other than `keys.ts` that may spell the separator, and why.
 *
 * `src/adapters/signals.ts` frames a scoped digest with it — the declared path,
 * then the canonical text, so that two endpoints scoped differently cannot
 * produce one number by accident. That is domain separation inside a hash, not a
 * key in a map: the bytes go into a number the report prints, and tying them to a
 * constant whose subject is lookup keys would mean that changing how this tool
 * indexes its own tables silently changes a digest. The count is exact, so a
 * **new** one in that file fails here like anywhere else.
 */
const FRAMES_A_DIGEST = { path: "src/adapters/signals.ts", occurrences: 3 } as const;

/**
 * The tracked sources under `src/`, from git rather than from the disk.
 *
 * `.gitignore` already answers "does this go public", and a hand-written list
 * beside it would drift — and walking the tree here would descend into
 * `.claude/worktrees/`, where another branch's copy of a file would answer for
 * this one.
 */
function trackedSources(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path.endsWith(".ts"));
}

function sourceOf(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** How many times a needle occurs — the count, because "at least one" hides the second. */
function countIn(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A declaration of `name`, in the two forms this repository writes. */
function declares(source: string, name: string): boolean {
  return source.includes(`function ${name}(`) || source.includes(`const ${name} =`);
}

describe("one key, one source", () => {
  const files = trackedSources();

  it("sees the sources, rather than an empty list", () => {
    // A check that found nothing is green for the same reason a passing one is.
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain(OWNER);
    expect(files).toContain(FRAMES_A_DIGEST.path);
  });

  it("carries the separator as an escape, never as the byte", () => {
    const binary = files.filter((path) => sourceOf(path).includes(RAW));

    expect(
      binary,
      `A raw NUL byte is in: ${binary.join(", ")}. It makes the file binary to ` +
        `\`grep\`, so a search for the separator answers "no matches" over a file ` +
        `that uses it — which is how two of these went unnoticed. Write the escape ` +
        `instead; the string is the same.`,
    ).toEqual([]);
  });

  it("spells the separator in one module, and in one other for a reason", () => {
    const elsewhere = files.filter(
      (path) => path !== OWNER && path !== FRAMES_A_DIGEST.path && sourceOf(path).includes(ESCAPE),
    );

    expect(
      elsewhere,
      `The key separator is spelled outside ${OWNER}: ${elsewhere.join(", ")}. ` +
        `A key glued by hand has to agree with every other copy of it, and two ` +
        `such copies drifted apart unnoticed once already. Import KEY_SEPARATOR, ` +
        `or better one of the key functions beside it.`,
    ).toEqual([]);
  });

  it("spells it once in the module that owns it, and thrice in the digest", () => {
    // The constant and nothing else here: a second key built from the literal in
    // this file would be the same duplicate, one directory further in.
    expect(countIn(sourceOf(OWNER), ESCAPE)).toBe(1);
    expect(countIn(sourceOf(FRAMES_A_DIGEST.path), ESCAPE)).toBe(FRAMES_A_DIGEST.occurrences);
  });

  it("lets no other module declare a cell key or an object key", () => {
    const elsewhere = files.filter(
      (path) =>
        path !== OWNER && ["cellKey", "objectKey"].some((name) => declares(sourceOf(path), name)),
    );

    expect(
      elsewhere,
      `A second cellKey or objectKey is declared in: ${elsewhere.join(", ")}. ` +
        `Both live in ${OWNER}; a copy that agrees today is what ADR-0059 is about.`,
    ).toEqual([]);
  });
});

describe("the two keys", () => {
  const alice = { accountId: "alice", endpointId: "orders.read", resourceId: "o-1" };
  const carol = { accountId: "carol", endpointId: "orders.read", resourceId: "o-1" };

  it("keeps the coordinates apart wherever the boundary falls", () => {
    // The separator's whole job: two different cells whose coordinates
    // concatenate to the same letters must not share a key.
    expect(cellKey({ accountId: "a", endpointId: "b.c", resourceId: "d" })).not.toBe(
      cellKey({ accountId: "a", endpointId: "b", resourceId: "c.d" }),
    );
    expect(KEY_SEPARATOR).toHaveLength(1);
  });

  it("reads an absent resource and an undefined one as one cell", () => {
    expect(cellKey({ accountId: "alice", endpointId: "orders.list" })).toBe(
      cellKey({ accountId: "alice", endpointId: "orders.list", resourceId: undefined }),
    );
  });

  it("carries the resource, in both keys", () => {
    // The coordinate a copy of this function lost once: `relatedRequestOf`
    // dropped `resourceId` from the key it built, and a finding then named a
    // different cell than the one that produced it. Two objects of one endpoint
    // are two cells, and an endpoint with no resource is neither of them.
    expect(cellKey({ ...alice, resourceId: "o-2" })).not.toBe(cellKey(alice));
    expect(cellKey({ accountId: "alice", endpointId: "orders.read" })).not.toBe(cellKey(alice));
    expect(objectKey({ endpointId: "orders.read" })).not.toBe(objectKey(alice));
  });

  it("names one object for two accounts, and two cells", () => {
    // The difference between them, and the reason both exist: the walk asks
    // "which object" about a column every account shares, and the report asks
    // "which cell" about one account's row.
    expect(objectKey(alice)).toBe(objectKey(carol));
    expect(cellKey(alice)).not.toBe(cellKey(carol));
  });
});

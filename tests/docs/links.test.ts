/**
 * Links in the documentation.
 *
 * Found while translating the ADRs into English:
 * `[ADR-0008](0008-run-configuration.md)` pointed at a file that does not
 * exist — the real name is `0008-run-configuration-format.md`. The link had
 * been broken since the day it was written, in the Russian version too: nobody
 * ever followed it.
 *
 * The same class as everything else in this project: the document claims the
 * reasoning behind a decision lives right here, and there is nothing there —
 * and the reader finds out exactly when the decision needed disputing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Everything the repository carries, from git rather than from the disk.
 *
 * Walking the file system meant descending into `.claude/worktrees/`: of the 93
 * markdown files this visited, 41 were not the repository at all — checkouts of
 * other branches, whose broken links say nothing about this one and whose count
 * depends on what happened to be lying around. `language.test.ts` next door had
 * it right from the start. Found by the audit of 14 August 2026 (K-5).
 */
function trackedFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one !== "");
}

/**
 * Every tracked path, and every directory on the way to one, spelled the way git
 * records it.
 *
 * This set — and not the file system — is what a link target is checked against,
 * and the reason is the letter case. `existsSync` asks the file system, and the
 * file system on macOS, as on Windows, answers `true` for
 * `0003-CHECK-registry.md`. A link with the case wrong therefore passed on the
 * machine it was written on and failed on Linux CI: a gate red for a reason that
 * is not the contributor's, and a message that does not say so. The audit of
 * 14 August 2026 (K-6) found no such link in the repository at the time, which
 * is the only reason nobody had met it yet.
 *
 * The guard was rewritten on 15 August to take its **list of documents** from
 * `git ls-files` (K-5). That changed which files are scanned and nothing about
 * how their targets are checked, so the case-blindness outlived it — and it is
 * also what makes the cure cheap: git records a path with one spelling, and a
 * comparison against that record gives the same answer on every operating
 * system.
 *
 * Directories are in here because four links point at one — `docs/adr/`,
 * `examples/` — and git lists no directories of its own.
 */
function trackedPaths(files: readonly string[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const one of files) {
    paths.add(one);
    // `git ls-files` separates with `/` whatever the platform.
    for (let parent = posix.dirname(one); parent !== "."; parent = posix.dirname(parent)) {
      paths.add(parent);
    }
  }
  return paths;
}

/** Where a link points, as a repository path — the currency the tracked set uses. */
function targetOf(from: string, link: string): string {
  return relative(ROOT, resolve(dirname(join(ROOT, from)), link))
    .split(sep)
    .join("/");
}

/**
 * Whether the repository carries what a link points at.
 *
 * The set is a parameter rather than a constant this reads for itself, so that
 * the claim "this answers from the index and not from the disk" can be put to it
 * directly. A version of this function that consults the file system passes
 * every test below that uses the real set and fails the two that do not.
 */
function carries(paths: ReadonlySet<string>, from: string, link: string): boolean {
  return paths.has(targetOf(from, link));
}

/**
 * What `npm pack` puts in the tarball.
 *
 * `files` in `package.json`, plus the three npm always includes. A link is only
 * usable by whoever installed the package if its target is in here too.
 */
const SHIPPED = ["dist", "docs", "examples", "schema"];
const ALWAYS = new Set(["README.md", "LICENSE", "package.json"]);

function ships(repoPath: string): boolean {
  return (
    ALWAYS.has(repoPath) ||
    SHIPPED.some((directory) => repoPath === directory || repoPath.startsWith(`${directory}/`))
  );
}

/** Relative links only: external addresses need the network and are not checked here. */
function relativeLinks(repoPath: string): readonly string[] {
  const text = readFileSync(join(ROOT, repoPath), "utf8");
  return [...text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => target !== "" && !/^(https?:|mailto:)/.test(target));
}

/**
 * A link that names an ADR by number, and the document it actually opens.
 *
 * Both halves carry the number, and the guard above compares neither of them: it
 * asks only whether the target exists, so a label naming one decision over a link
 * to another is green. `docs/library.md` labelled the catalogue-of-clauses ADR
 * `ADR-0041` while linking `0043-a-catalogue-of-clauses.md`, and `README.md`
 * labelled `ADR-0044` while linking `0045-a-consented-run-says-who-it-is.md`;
 * both opened the right document under the wrong name.
 *
 * Neither example is spelled here as a link, deliberately. This file is tracked
 * and the scan below reads it, so a mismatched link written out in prose would
 * be a real finding about a real file — the gate failing on its own evidence.
 *
 * That is worse here than a dead link. An ADR number is working currency in this
 * repository — comments cite one, commit messages cite one, `CLAUDE.md` cites
 * nine — and none of those citations is a link anything can follow. A reader who
 * takes "ADR-0041" from a sentence and goes looking for it lands on a decision
 * about matrix discrepancies answering for a clause, when the sentence was about
 * a catalogue of clauses. The link was the one place the two numbers could be
 * compared, and nothing compared them.
 */
const ADR_LINK = /\[ADR-(\d{4})\]\(([^)\s]+)\)/g;

/** The number a target carries: the last path segment, `NNNN-` and a name. */
const ADR_TARGET = /(?:^|\/)(\d{4})-[^/]*\.md$/;

interface AdrLink {
  readonly line: number;
  readonly text: string;
  readonly label: string;
  /** The number in the filename, or `undefined` when this gate cannot read one. */
  readonly document: string | undefined;
}

/**
 * Every ADR link in one text, label and document number side by side.
 *
 * A function over a string rather than over a path, so that the assertions below
 * can put a wrong label to it without one existing in the repository — and, more
 * to the point, without one existing **in this file**, which git tracks and the
 * scan reads like any other. `language.test.ts` next door learnt that the hard
 * way: it flagged its own source, and only after the commit that made it
 * visible to itself. The samples are therefore assembled at run time from parts.
 */
function adrLinks(text: string): readonly AdrLink[] {
  const found: AdrLink[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(ADR_LINK)) {
      const target = (match[2] ?? "").split("#")[0] ?? "";
      found.push({
        line: index + 1,
        text: match[0],
        label: match[1] ?? "",
        document: ADR_TARGET.exec(target)?.[1],
      });
    }
  });
  return found;
}

/** Binary files carry no links; reading them as text proves nothing. */
const BINARY = /\.(png|jpg|jpeg|gif|ico|pdf|woff2?|zip|gz)$/i;

const files = trackedFiles();
const tracked = trackedPaths(files);
const documents = files.filter((one) => one.endsWith(".md"));

describe("links in the documentation", () => {
  it("finds documents instead of staying silent on an empty list", () => {
    // A test that found nothing is green for the same reason a passing one is.
    expect(documents.length).toBeGreaterThan(10);
  });

  it("lead to files that exist", () => {
    const broken: string[] = [];
    for (const file of documents) {
      for (const target of relativeLinks(file)) {
        if (!carries(tracked, file, target)) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  /**
   * The answer comes from the repository's index and not from the disk.
   *
   * Put to a set made up for the occasion, because that is the one form of this
   * claim that means the same thing on every machine: one of the two files is on
   * disk and in the set, the other is on disk and out of it. Anything that
   * consults the file system agrees on the first and disagrees on the second,
   * here and on CI alike.
   */
  it("answers from what git records, not from what the disk holds", () => {
    const from = "docs/adr/0019-request-contexts.md";
    const pretend = new Set(["docs", "docs/adr", "docs/adr/0003-check-registry.md"]);
    const missingFromTheSet = "0028-the-policy-is-indexed-once.md";

    expect(existsSync(join(ROOT, "docs/adr", missingFromTheSet))).toBe(true);
    expect(carries(pretend, from, "0003-check-registry.md")).toBe(true);
    expect(carries(pretend, from, missingFromTheSet)).toBe(false);
  });

  /**
   * A link whose case is wrong leads nowhere, whatever this machine's file
   * system says about it.
   *
   * On macOS `existsSync` answers `true` for a name that differs only in case,
   * so this assertion is the finding itself: with the check made against the
   * file system it fails here and passes on Linux, which is the wrong way round
   * from every point of view. What this machine thinks is deliberately not
   * asserted — that would be a test with a different verdict per operating
   * system, the very thing being fixed.
   */
  it("does not accept a target whose letter case is wrong", () => {
    const from = "docs/adr/0019-request-contexts.md";

    expect(carries(tracked, from, "0003-check-registry.md")).toBe(true);
    expect(carries(tracked, from, "0003-Check-Registry.md")).toBe(false);
  });

  /**
   * And they lead somewhere for a reader who **installed** rather than cloned.
   *
   * `files: ["dist", "docs", "examples", "schema"]` leaves `polygon/`,
   * `tasks.md`, `plan.md`, the tests and the workflows outside the tarball, so
   * nine relative links in the shipped documents pointed at nothing under
   * `node_modules/barbican/`. The guard above stayed green on every one of them:
   * it resolves against the repository, where they all exist. Found by the audit
   * of 14 August 2026 (E-3).
   *
   * The fix for such a link is an absolute address on GitHub, which is what the
   * rest of the documents already use.
   */
  it("lead somewhere for a reader who installed the package", () => {
    const dead: string[] = [];
    for (const file of documents) {
      if (!ships(file)) {
        continue;
      }
      for (const target of relativeLinks(file)) {
        if (!ships(targetOf(file, target))) {
          dead.push(`${file} -> ${target}`);
        }
      }
    }

    expect(dead).toEqual([]);
  });
});

/**
 * An ADR link names the ADR it opens.
 *
 * Every tracked file, and not only the markdown ones: the rule is about a number
 * that is currency everywhere in this repository, and a link in a source comment
 * is as wrong as a link in a document. There are none in source today, which is
 * a fact about today.
 *
 * This is completely checkable and is therefore checked completely — no sampling,
 * no allowlist, and no link quietly passed over because its target has a shape
 * the gate did not expect. A target it cannot read a number from is a failure of
 * its own below, not a skip: a gate that skips what it does not understand is
 * green about exactly the cases nobody thought of.
 */
describe("an ADR link names the document it opens", () => {
  const linksByFile = files
    .filter((one) => !BINARY.test(one))
    .map((one) => ({ file: one, links: adrLinks(readFileSync(join(ROOT, one), "utf8")) }))
    .filter((one) => one.links.length > 0);
  const all = linksByFile.flatMap((one) => one.links.map((link) => ({ file: one.file, link })));

  it("finds ADR links, rather than agreeing with an empty repository", () => {
    // A check that found nothing is green for the same reason a passing one is.
    // There were 178 on 23 August 2026, across README, docs/ and the ADRs.
    expect(all.length).toBeGreaterThan(100);
  });

  it("can read a number from every target it found", () => {
    const unreadable = all
      .filter(({ link }) => link.document === undefined)
      .map(({ file, link }) => `${file}:${link.line} ${link.text}`);

    // Not a skip list. If this fires, either a link points somewhere new or
    // `ADR_TARGET` is too narrow — and until one of those is settled the
    // assertion below is not the total check it claims to be.
    expect(unreadable).toEqual([]);
  });

  it("carries the same number in the label as in the filename", () => {
    const lying = all
      .filter(({ link }) => link.document !== undefined && link.document !== link.label)
      .map(({ file, link }) => `${file}:${link.line} ${link.text}`);

    expect(lying).toEqual([]);
  });

  /**
   * Put to the reader directly, so that "no mismatch in the repository" is a
   * statement about the repository and not about a function that never says yes.
   *
   * The samples are built from parts on purpose: written out whole they would be
   * a mismatched ADR link inside a tracked file, and the scan above reads this
   * file too. The guard would then fail on its own evidence, which is the shape
   * `language.test.ts` next door was caught in.
   */
  it("tells a matching label from a lying one", () => {
    const link = (label: string, document: string): string =>
      `see [ADR-${label}](adr/${document}-a-catalogue-of-clauses.md)`;

    const agreeing = adrLinks(link("0043", "0043"));
    expect(agreeing).toHaveLength(1);
    expect(agreeing[0]?.label).toBe("0043");
    expect(agreeing[0]?.document).toBe("0043");

    const lying = adrLinks(link("0041", "0043"));
    expect(lying).toHaveLength(1);
    expect(lying[0]?.label).toBe("0041");
    expect(lying[0]?.document).toBe("0043");
  });

  /**
   * An absolute address on GitHub is read the same way as a relative one.
   *
   * Half the ADR links in `docs/guide.md` and `docs/report.md` are absolute —
   * that is the fix the shipped-links assertion above asks for — so a gate that
   * only understood `adr/NNNN-….md` would be silent on exactly the documents a
   * reader who installed the package gets.
   */
  it("reads the number out of an absolute address too", () => {
    const base = "https://github.com/Tarnellion/barbican/blob/main/docs/adr";
    const found = adrLinks(`([ADR-${"0013"}](${base}/0013-tenant-hierarchy.md))`);

    expect(found).toHaveLength(1);
    expect(found[0]?.document).toBe("0013");
  });

  /** A `#section` on the end is part of the address, not part of the filename. */
  it("is not thrown by an anchor", () => {
    const found = adrLinks(`[ADR-${"0032"}](adr/0032-the-grammar-sits-at-the-seam.md#decision)`);

    expect(found).toHaveLength(1);
    expect(found[0]?.document).toBe("0032");
  });
});

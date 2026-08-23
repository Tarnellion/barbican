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
 *
 * What follows is the population: any inline link, with the label and everything
 * the parentheses hold.
 *
 * The population is a **link**, and the label is the thing on trial. The first
 * version of this gate collected with `[ADR-NNNN](target)`, which put the
 * accused in charge of the arrest: a label spelled any other way was never
 * collected, so it could not be judged, and the file said in the same breath
 * that nothing here is passed over. Adversarial review of 23 August 2026 walked
 * through with emphasis marks, a code span, a lower-case prefix, a word in front
 * of the number, a space instead of the hyphen, an unpadded number, a gloss
 * after the colon, a link title and the bare filename as the label — nine
 * shapes, all of them ordinary markdown, all of them invisible.
 */
const INLINE_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;

/** The number a target carries: the last path segment, `NNNN-` and a name. */
const ADR_TARGET = /(?:^|\/)(\d{4})-[^/]*\.md$/;

/**
 * An ADR number claimed inside a label, wherever in it and however spelled.
 *
 * Anchored on the word so that "quadratic" cannot start one, and separated by at
 * most three characters of dash, space, underscore, dot or colon — which covers
 * `ADR-0043`, `ADR 43`, `ADR_0043` and an en dash, and stops well short of
 * matching a number that merely follows the word somewhere in a sentence.
 * Two to four digits: a run of five is not an ADR number, and `43` is compared
 * padded, so an unpadded label is judged rather than excused.
 */
const LABEL_CLAIM = /\badr[\s\p{Pd}_.:]{0,3}(\d{2,4})\b/giu;

/** Emphasis and code marks around a label, which say nothing about its number. */
const LABEL_MARKUP = /[*_`~]/g;

/** A label that is the ADR's filename, which claims a number without saying "ADR". */
const FILENAME_LABEL = /^(\d{4})-/;

interface AdrLink {
  readonly line: number;
  readonly text: string;
  /** Every ADR number the label claims, four digits each. Usually one; often none. */
  readonly claims: readonly string[];
  /** The number in the filename, or `undefined` when this gate cannot read one. */
  readonly document: string | undefined;
}

/** What a link actually opens: the address, without a title or an anchor. */
function targetIn(inside: string): string {
  const address = inside.trim().split(/\s+/)[0] ?? "";
  return (address.replace(/^</, "").replace(/>$/, "").split("#")[0] ?? "").trim();
}

/**
 * Every ADR number a label claims, padded to four digits.
 *
 * The filename form is only read when the target is an ADR document, so that a
 * label like `2020-2024` on a link to something else cannot be dragged in here
 * as a claim about ADR 2020.
 */
function claimsIn(label: string, document: string | undefined): readonly string[] {
  const plain = label.replace(LABEL_MARKUP, "").trim();
  const claims = [...plain.matchAll(LABEL_CLAIM)].map((match) => (match[1] ?? "").padStart(4, "0"));
  const filename = document === undefined ? null : FILENAME_LABEL.exec(plain)?.[1];
  return filename === undefined || filename === null ? claims : [...claims, filename];
}

/**
 * Every link that names an ADR — in its label, in its target, or in both.
 *
 * A function over a string rather than over a path, so that the assertions below
 * can put a wrong label to it without one existing in the repository — and, more
 * to the point, without one existing **in this file**, which git tracks and the
 * scan reads like any other. `language.test.ts` next door learnt that the hard
 * way: it flagged its own source, and only after the commit that made it
 * visible to itself. The samples are therefore assembled at run time from parts,
 * on both sides of the link: a label the new grammar cannot read is no longer
 * enough to keep a sample out of the scan.
 */
function adrLinks(text: string): readonly AdrLink[] {
  const found: AdrLink[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(INLINE_LINK)) {
      const document = ADR_TARGET.exec(targetIn(match[2] ?? ""))?.[1];
      const claims = claimsIn(match[1] ?? "", document);
      if (document === undefined && claims.length === 0) {
        continue;
      }
      found.push({ line: index + 1, text: match[0], claims, document });
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
 * What is checked and what is not, said plainly, because the first version of
 * this block claimed the second half away. Collected: every inline markdown link
 * whose target is an ADR document, and every inline link whose label claims an
 * ADR number, whatever the label looks like. Judged: the claims in the label
 * against the number in the filename. A link to an ADR under a label that names
 * no number at all — the words "the tenant hierarchy" over a link to
 * `0013-tenant-hierarchy.md` — is collected and has nothing to judge; there are
 * none in the repository today.
 *
 * Not collected at all, and each of these is a real way past: a reference-style
 * link, whose target is defined on another line under a shorthand; a raw
 * `<a href>`; a label carrying a `]` of its own; and an ADR number cited in
 * prose with no link around it, which is how most of them are cited — 965 of the
 * 1160 citations in the tree on 23 August 2026 — and is the shortfall no gate
 * here closes. An address with a bracket in it is half a hole: the label's claim
 * is still read, so the link fails loudly as a target no number can be read
 * from, but under a label that claims nothing it goes unrecognised. The
 * repository holds no link of any of those shapes today; that is a fact about
 * today and not a property of this gate.
 */
describe("an ADR link names the document it opens", () => {
  const linksByFile = files
    .filter((one) => !BINARY.test(one))
    .map((one) => ({ file: one, links: adrLinks(readFileSync(join(ROOT, one), "utf8")) }))
    .filter((one) => one.links.length > 0);
  const all = linksByFile.flatMap((one) => one.links.map((link) => ({ file: one.file, link })));

  it("finds ADR links, rather than agreeing with an empty repository", () => {
    // A check that found nothing is green for the same reason a passing one is.
    // A floor and not a census: the population is every tracked non-binary file,
    // `tasks.md` and `SECURITY.md` and the polygon READMEs among them, and it
    // grows with every ADR written. An exact figure here would be wrong by the
    // commit that added it — which is what happened to the one this line used to
    // carry.
    expect(all.length).toBeGreaterThan(100);
  });

  it("can read a number from every target whose label names one", () => {
    const unreadable = all
      .filter(({ link }) => link.document === undefined)
      .map(({ file, link }) => `${file}:${link.line} ${link.text}`);

    // Not a skip list. If this fires, either a label names an ADR over a link to
    // something else or `ADR_TARGET` is too narrow — and until one of those is
    // settled the assertion below is not the total check it claims to be.
    expect(unreadable).toEqual([]);
  });

  it("carries the same number in the label as in the filename", () => {
    const lying = all
      .filter(({ link }) => link.claims.some((claim) => claim !== link.document))
      .map(({ file, link }) => `${file}:${link.line} ${link.text}`);

    expect(lying).toEqual([]);
  });

  /**
   * Put to the reader directly, so that "no mismatch in the repository" is a
   * statement about the repository and not about a function that never says yes.
   *
   * The samples are built from parts on purpose, on **both** sides of the link:
   * written out whole they would be a mismatched ADR link inside a tracked file,
   * and the scan above reads this file too. Interpolating the label was enough
   * while the gate collected on the label alone; now that it collects on the
   * target as well, the filename has to be assembled too, or every sample here
   * would be a real link to a real ADR under a label this gate cannot read.
   */
  const label = (text: string): string => `[${text}]`;
  const target = (document: string, rest = "-a-catalogue-of-clauses.md"): string =>
    `(adr/${document}${rest})`;
  const link = (text: string, document: string, rest?: string): string =>
    `see ${label(text)}${target(document, rest)}`;
  const one = (text: string, document: string, rest?: string): AdrLink | undefined =>
    adrLinks(link(text, document, rest))[0];

  it("tells a matching label from a lying one", () => {
    const agreeing = adrLinks(link("ADR-0043", "0043"));
    expect(agreeing).toHaveLength(1);
    expect(agreeing[0]?.claims).toEqual(["0043"]);
    expect(agreeing[0]?.document).toBe("0043");

    const lying = adrLinks(link("ADR-0041", "0043"));
    expect(lying).toHaveLength(1);
    expect(lying[0]?.claims).toEqual(["0041"]);
    expect(lying[0]?.document).toBe("0043");
  });

  /**
   * The nine shapes the review of 23 August 2026 walked through the old grammar
   * with, each one an ordinary way to write the same lying link.
   *
   * `[ADR-NNNN](target)` was the whole population, so a label spelled any other
   * way was not collected and therefore not judged — while the file said in its
   * own header that nothing is passed over. Each of these now reads as a claim
   * of 0041 over a link to 0043.
   */
  it.each([
    ["emphasis around the label", "**ADR-0041**", undefined],
    ["a code span around the label", "`ADR-0041`", undefined],
    ["a word in front of the number", "see ADR-0041", undefined],
    ["a gloss after the number", "ADR-0041: a catalogue of clauses", undefined],
    ["a space instead of the hyphen", "ADR 0041", undefined],
    ["an en dash instead of the hyphen", "ADR–0041", undefined],
    ["a lower-case prefix", "adr-0041", undefined],
    ["an unpadded number", "ADR-41", undefined],
    ["the filename as the label", "0041-a-catalogue-of-clauses.md", undefined],
  ])("reads a claim of 0041 out of %s", (_shape, text) => {
    const found = one(text, "0043");

    expect(found?.claims).toEqual(["0041"]);
    expect(found?.document).toBe("0043");
  });

  /** A title after the address is not part of the address, and does not hide it. */
  it("reads a link that carries a title", () => {
    const found = one("ADR-0041", "0043", `-a-catalogue-of-clauses.md "A catalogue"`);

    expect(found?.claims).toEqual(["0041"]);
    expect(found?.document).toBe("0043");
  });

  /**
   * And the shapes that must **not** be read as a claim, because a gate that
   * invents one fails on a label that was never lying.
   */
  it("reads no claim out of a label that names no number", () => {
    const found = one("the catalogue of clauses", "0043");

    expect(found?.claims).toEqual([]);
    expect(found?.document).toBe("0043");
  });

  it("does not find the word inside another one", () => {
    // "quadratic" carries the three letters; the anchor is what stops it.
    const found = one("quadratic, 2023 edition", "0043");

    expect(found?.claims).toEqual([]);
  });

  it("counts an unpadded label that agrees as agreeing", () => {
    const found = one("ADR-43", "0043");

    expect(found?.claims).toEqual(["0043"]);
    expect(found?.document).toBe("0043");
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
    const found = adrLinks(`(${label("ADR-0013")}(${base}/${"0013"}-tenant-hierarchy.md))`);

    expect(found).toHaveLength(1);
    expect(found[0]?.document).toBe("0013");
  });

  /** A `#section` on the end is part of the address, not part of the filename. */
  it("is not thrown by an anchor", () => {
    const found = one("ADR-0032", "0032", "-the-grammar-sits-at-the-seam.md#decision");

    expect(found?.document).toBe("0032");
    expect(found?.claims).toEqual(["0032"]);
  });
});

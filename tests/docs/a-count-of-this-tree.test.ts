/**
 * A number that counts this repository, written into this repository.
 *
 * On 24 August 2026 four documents asserted a count of the tree and were wrong
 * by the commit that asserted it. `tests/docs/links.test.ts` gave a figure for
 * the citations it scans, and the same commit added seven more; `README.md` gave
 * the size of the published surface twice, and the merge that carried the section
 * moved it; `tasks.md` gave a commit count over "the range between the commit
 * that last touched this file and this one", whose right-hand end moves every
 * time the file is touched; and `docs/adr/0073` gave a line count for a module in
 * the commit that took two lines out of it.
 *
 * None of the four is carelessness. They are one structure: a **self-referential
 * measurement**. The author counts the tree, writes the number into the tree, and
 * the writing is what makes the number wrong — so the more careful the author is
 * about measuring first, the more certain the result. Being more careful is not
 * the fix. Measuring at the moment the number is read is.
 *
 * That is what this file does. It reads the prose the repository ships, finds the
 * counts it states about itself, and measures each one **against the tree the
 * suite is running on** — which, when `pnpm run check` runs before a commit, is
 * the tree that commit will have, the number's own line included.
 *
 * ## What it catches
 *
 * A count of one of the populations in `READERS` below, about a subject this file
 * can resolve, that the tree it is measured against does not answer with. Four
 * populations: the lines of a named file, the files directly under a named
 * directory, the values the package exports, and the commits between two named
 * commits. A subject that resolves to no tracked file, or to more than one, is a
 * failure of its own — a reader cannot follow it either.
 *
 * Which tree it is measured against is the rest of the rule, and there are three
 * answers. A sentence that names exactly one commit is measured **at that
 * commit**, whatever tense it is in. A sentence in the present tense with no
 * commit named is measured against **this tree**, the one the suite is running on.
 * A sentence in the past tense with no commit named is a record and is not
 * measured at all.
 *
 * The tense is in the grammar rather than in a judgement made afterwards, and that
 * is the boundary this gate is drawn on. **A count in the past tense is a record
 * of a measurement and does not go stale**: `build.ts` was 3 012 lines at
 * `4fca59d`, the commit ADR-0054 was written against, and it will have been 3 012
 * lines there for as long as the repository lasts. Not "on the day it was cut":
 * the cut itself is `7531bff`, where the file is 301 lines, and the same calendar
 * day holds both numbers. A day is not an anchor, which is the rule below. A count in the present tense is a claim about the tree now, and the tree
 * moves under it. Only the second kind drifts, and drift is the whole defect.
 *
 * The counterpart is that a document which records a decision speaks about the
 * tree it was decided on, in the past tense, and this file is what makes that a
 * rule rather than a habit. A present-tense count in such a document goes red on
 * the day the tree moves, and the edit it asks for is one word — or one anchor,
 * which keeps the number checked instead of retiring it.
 *
 * ## What it cannot see
 *
 * ADR-0065 is the reasoning for having this section, and it applies here without
 * amendment. Every form below was written into a tracked document, the suite was
 * run, and the outcome is recorded in ADR-0075's `Limits` section with its
 * counts. The three that matter most:
 *
 * - **A count in the past tense with no commit named**, including one wearing a
 *   date — "there were 195 of them on 23 August 2026". That is the shape of the
 *   first of the four defects above, and this gate does not read it. A date is not
 *   an anchor: a day holds many commits and a population moves inside it, so there
 *   is no tree to measure against. Naming the commit is what makes such a sentence
 *   checkable, and `tasks.md`'s census bullets are written that way.
 * - **A population that is not in the table.** "eleven point fixes", "eight
 *   doors", "nine shapes" — every one of them a count of this repository, and
 *   nothing enumerates them. A pattern for a population with no oracle would flag
 *   what it cannot adjudicate, which is a gate people learn to silence. The table
 *   is the boundary, deliberately.
 * - **A count of a design rather than of the tree** — "five relations", "three
 *   layers", "two rules". Out of scope for the same reason and on purpose.
 *
 * And the ordinary ones: a claim inside a fenced block or inside a pair of double
 * quotes is read as an example or as somebody else's sentence and skipped; a
 * subject spelled as prose rather than as a backticked path has nothing to
 * resolve; a file the scan does not enumerate — untracked, or with an extension
 * not listed — is not read at all.
 *
 * ## On Windows
 *
 * Every repository path here comes from `git ls-files` and is therefore
 * `/`-separated on every platform; no path is derived from `relative()` and none
 * is compared against a glob, which is how this suite broke on `windows-latest`
 * once already. No `RegExp` is built out of a path, which is how it broke the
 * second time. File text has its carriage returns removed before anything counts
 * a line, so a checkout with `core.autocrlf=true` gives the same numbers as one
 * without. `git` is reached through `execFileSync` with an argument array, so no
 * shell quoting is involved.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Files tracked by git — the exact set that ends up on GitHub.
 *
 * The same choice `language.test.ts` and `links.test.ts` make, for the same
 * reason: `.gitignore` already answers "does this go public", and a second
 * hand-written list would drift away from it. It carries the same consequence
 * too — a document written but not yet added is not read here, and the count it
 * states is judged for the first time by the commit that adds it.
 */
function trackedFiles(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\u0000")
    .filter((one) => one !== "");
}

/**
 * A tracked file as text, with carriage returns removed.
 *
 * Removing them is what makes the line count below mean the same thing on a
 * Windows checkout, where `core.autocrlf` may have put them there, as on the
 * Linux runner where the blob has none.
 */
function textOf(repoPath: string): string {
  return readFileSync(resolve(ROOT, repoPath), "utf8").replace(/\r/g, "");
}

/**
 * Lines, the way `wc -l` counts them: one per newline.
 *
 * The other definition — lines as the pieces a split produces — differs by one on
 * a file with no final newline. Every tracked text file in this repository ends
 * with one, measured over all of them, because Biome's formatter puts it there;
 * so the two definitions agree here and this one is the cheaper to explain.
 */
function lineCount(text: string): number {
  let lines = 0;
  for (const character of text) {
    if (character === "\n") {
      lines += 1;
    }
  }
  return lines;
}

/** Whether a tracked file carries prose this gate reads, and in which form. */
function proseKind(repoPath: string): "markdown" | "comments" | undefined {
  if (repoPath.endsWith(".md")) {
    return "markdown";
  }
  return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(repoPath) ? "comments" : undefined;
}

/** @see https://spec.commonmark.org/0.31.2/#fenced-code-blocks */
const FENCE = /^\s{0,3}(?:`{3,}|~{3,})/;

/**
 * A markdown document's prose, as lines, with the fenced blocks blanked out rather
 * than removed — so a line number still means what it says.
 *
 * A claim inside a fence is an example: ADR-0075 states the shapes this file reads
 * by writing them in one, and a gate that read its own documentation as evidence
 * would be failing on the description of itself.
 */
function markdownProse(text: string): readonly string[] {
  let fenced = false;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      kept.push("");
      continue;
    }
    kept.push(fenced ? "" : line);
  }
  return kept;
}

/**
 * The comments of a module, and nothing else.
 *
 * Whole lines while a block comment is open, and from `//` to the end of a line
 * otherwise. A `//` inside a string literal is kept as if it were a comment — the
 * address in a fixture, for one. Nothing in the grammars below can match such a
 * fragment, and a scanner that understood string literals would be a parser,
 * which ADR-0065 rejects for this family of gates.
 */
function commentProse(text: string): readonly string[] {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (inside) {
      kept.push(line);
      if (line.includes("*/")) {
        inside = false;
      }
      continue;
    }
    if (line.includes("/*")) {
      kept.push(line);
      if (!line.includes("*/")) {
        inside = true;
      }
      continue;
    }
    const start = line.indexOf("//");
    kept.push(start === -1 ? "" : line.slice(start));
  }
  return kept;
}

/** A sentence of a document, and the line its paragraph opens on. */
interface Sentence {
  readonly line: number;
  readonly text: string;
}

/**
 * A sentence that supposes rather than states.
 *
 * "If `src/report/shape.ts` is 1 500 lines after the next cut, cut it again" is a
 * hypothesis about a tree that does not exist, and this gate read it as a claim
 * about the one that does — measured on 26 August 2026, red against a file of
 * 1 128 lines. That direction is the one worth being strict about: a gate that
 * fires on a sentence nobody meant as an assertion is a gate people learn to
 * silence, and a silenced gate catches nothing at all.
 *
 * Only the opening word, and only these three. A conditional buried mid-sentence
 * — "cut it again if it is 1 500 lines" — is still read, and so is "suppose",
 * "were it" and every other way English has of not committing. Both directions of
 * that are named in ADR-0075's limits, because a rule about grammar written by
 * somebody who is not a grammarian should say how far it reaches.
 */
const SUPPOSES = /^(?:If|Unless|Whether)\b/;

/**
 * The sentences of a document, each with the line to cite it by.
 *
 * A paragraph is flattened before it is split, because the markdown here is hard
 * wrapped and a count can sit on either side of a break. Flattening also folds a
 * non-breaking or narrow space into an ordinary one, which is what lets the
 * grammars below spell a thousands separator as a single space and mean every
 * spelling of it.
 *
 * The line reported is the paragraph's first, not the sentence's: a citation that
 * is occasionally a line or two early is worth more than one that pretends to a
 * precision it does not have.
 */
function sentencesOf(lines: readonly string[]): readonly Sentence[] {
  const found: Sentence[] = [];
  let paragraph: string[] = [];
  let opensOn = 1;
  const flush = (): void => {
    const flat = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (flat === "") {
      return;
    }
    for (const text of flat.split(/(?<=[.!?])\s+/)) {
      if (SUPPOSES.test(text)) {
        continue;
      }
      found.push({ line: opensOn, text });
    }
  };
  lines.forEach((line, index) => {
    if (line.trim() === "") {
      flush();
      return;
    }
    if (paragraph.length === 0) {
      opensOn = index + 1;
    }
    paragraph.push(line);
  });
  flush();
  return found;
}

/**
 * A span inside straight double quotes, blanked out before a sentence is read.
 *
 * A document quoting another document's sentence is not making that sentence's
 * claim — `docs/adr/0063` quotes ADR-0055's closing pointer, line count and all,
 * and correcting the quotation would be falsifying it. The cost is that a pair of
 * quotes is a way past this gate; it is in ADR-0075's `Limits`, measured.
 */
function unquoted(sentence: string): string {
  return sentence.replace(/"[^"]*"/g, (span) => " ".repeat(span.length));
}

/**
 * A number as this repository writes one: `242`, `1 128`, `3 012`.
 *
 * The grouped form is tried first, so that "1 128" is one number and not two. By
 * the time a sentence reaches here every run of whitespace is a single space.
 */
const COUNT = String.raw`\d{1,3}(?: \d{3})+|\d+`;

/**
 * Emphasis around a number or its subject, which Markdown allows anywhere.
 *
 * Written once and spliced into all three grammars below. It was in
 * `DIRECTORY_CLAIM` alone until 26 August 2026, and the review of this gate found
 * what that cost: a lines-claim naming a real module, with a wrong number in bold,
 * passed green — the two grammars that had no `**` in them stopped matching at the
 * asterisk. Measured by writing one into a tracked ADR, not argued.
 *
 * The example is described here rather than written out, because writing it out
 * makes it a claim: the first version of this comment spelled the sentence, and
 * the gate flagged its own doc comment on the run that closed the hole. Which is
 * the gate working, and the reason the sentence is gone.
 *
 * The lesson is the one this repository keeps relearning: a rule written into two
 * of three places is a rule that holds in two of three places. Splicing beats
 * repeating, and the repeating is what let the third drift.
 */
const EMPHASIS = String.raw`(?:\*\*)?`;

function numberIn(written: string): number {
  return Number(written.replace(/ /g, ""));
}

/** A backticked token that looks like a file: no whitespace, and an extension. */
const PATH_IN_PROSE = String.raw`\`([^\s\`]+\.[a-z]+)\``;

/**
 * `shape.ts` **is** N lines — the present tense, immediately, with nothing between
 * the subject and the verb but a comma.
 *
 * Immediately is the point. A draft of this that allowed forty characters of
 * anything in between read "with `page.ts`, and the render half is 197 lines" as a
 * claim about `page.ts`, which it is not. A subject spelled as prose is a subject
 * this file cannot resolve, and reaching for the nearest backticked token instead
 * is how a gate comes to fail on a sentence that was right.
 *
 * The one word allowed in between is `which`, and it is safe for the same reason
 * the rule is strict: a relative pronoun refers to the noun in front of it, so
 * "`parse.ts`, which was 659 lines" cannot be about anything else. It is there
 * because ADR-0055's pointer reads that way and rewriting a sentence to suit a
 * scanner is how prose starts serving the gate instead of the reader.
 */
const LINES_CLAIM = new RegExp(
  `${EMPHASIS}${PATH_IN_PROSE}${EMPHASIS},? (?:which )?(?:(is|are)|(at)|(was|were)) (?:now |still )?${EMPHASIS}(${COUNT})${EMPHASIS} lines\\b`,
  "g",
);

/**
 * A past auxiliary, which only the tenseless form of the claim above has to ask
 * about.
 *
 * "`shape.ts` **is** N lines" carries its own tense and needs nothing else read.
 * "`shape.ts` **at** N lines" carries none: it is an apposition, and the tense is
 * whatever the sentence's verb says. `tasks.md` has "`config.ts` at 1 718 lines
 * was not covered" — a record of a module that no longer exists at that size, and
 * a first draft of this file read it as a claim about the tree today.
 *
 * The asymmetry is deliberate and it is the conservative direction: a claim with a
 * present-tense verb of its own is read even in a sentence that is otherwise about
 * the past, because the verb is what makes the claim.
 */
const PAST_AUXILIARY = /\b(?:was|were|had|been)\b/;

/** `docs/adr/` **holds** N files, optionally with the range of names it holds. */
const DIRECTORY_CLAIM = new RegExp(
  String.raw`\`([^\s\`]+/)\` (?:(?:holds|has|carries|contains)|(held|had|carried|contained)) ` +
    `${EMPHASIS}(${COUNT})${EMPHASIS} files` +
    String.raw`(?:,? (\d{4}) through (\d{4}))?`,
  "g",
);

/** The package **exports** N names — the one population with no subject to resolve. */
const EXPORTS_CLAIM = new RegExp(
  `package (?:still )?exports ${EMPHASIS}(${COUNT})${EMPHASIS} (?:names|values)\\b`,
  "g",
);

/** N **commits**, in a sentence that names the two ends of the range. */
const COMMITS_CLAIM = new RegExp(`(${COUNT}) commits\\b`, "g");
const NOT_MERGES_CLAIM = new RegExp(`(${COUNT}) of them not merges\\b`, "g");
const COMMIT_NAME = /`([0-9a-f]{7,40})`/g;

/**
 * What a claim states, and what the tree answers.
 *
 * `measured` is absent when the tree cannot answer at all, and `why` says what
 * stopped it: a subject naming two files, or none, or a range whose ends this
 * clone does not carry.
 */
interface Verdict {
  readonly what: string;
  readonly stated: number;
  readonly measured: number | undefined;
  readonly why: string;
}

/**
 * Every tracked file whose path ends in the token a document wrote.
 *
 * A document names `shape.ts` and means `src/report/shape.ts`. That is fine while
 * exactly one tracked file answers to it; `compare.ts` answers for two, and a
 * reader following it has the same problem this function does.
 */
function resolvePath(files: readonly string[], token: string): readonly string[] {
  return files.filter((one) => one === token || one.endsWith(`/${token}`));
}

/** Tracked files directly under a directory — its children, not its descendants. */
function childrenOf(files: readonly string[], directory: string): readonly string[] {
  return files.filter(
    (one) => one.startsWith(directory) && !one.slice(directory.length).includes("/"),
  );
}

/**
 * The commit a sentence anchors its count to, if it names exactly one.
 *
 * This is the other half of the rule, and the constructive half. A count in the
 * past tense is a record this file does not read — but a record that names the
 * commit it was taken at is a question with an answer, forever, because a commit
 * is a tree and a tree does not move. `tasks.md` has one written that way.
 *
 * Exactly one, because two named commits in a sentence are a **range**, which is
 * the fourth population below and not an anchor for the first two.
 *
 * A date is deliberately not accepted here. A day holds many commits and a
 * population moves inside it, so "on 23 August 2026" names no tree to measure
 * against — which is what made the weakest of the four defects this file was
 * written for unarguable in either direction.
 */
function anchorIn(sentence: string): string | undefined {
  const named = [...sentence.matchAll(COMMIT_NAME)].map((match) => match[1] ?? "");
  return named.length === 1 ? named[0] : undefined;
}

/**
 * The files a commit's tree carries, asked once per commit.
 *
 * `git ls-tree` answers with `/` separators on every platform, exactly as
 * `git ls-files` does, so an anchored claim is resolved in the same currency as an
 * unanchored one.
 */
const treesRead = new Map<string, readonly string[]>();

function filesAt(commit: string): readonly string[] {
  const known = treesRead.get(commit);
  if (known !== undefined) {
    return known;
  }
  const listed = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\u0000")
    .filter((one) => one !== "");
  treesRead.set(commit, listed);
  return listed;
}

/** A file's text at a commit — the blob, so no working-tree conversion is involved. */
function textAt(commit: string, repoPath: string): string {
  return execFileSync("git", ["show", `${commit}:${repoPath}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).replace(/\r/g, "");
}

/** Whether this clone carries a commit at all, which a shallow one may not. */
function carriesCommit(name: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${name}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function commitsBetween(from: string, to: string, merges: "with" | "without"): number {
  const flags = merges === "without" ? ["--no-merges"] : [];
  return Number(
    execFileSync("git", ["rev-list", "--count", ...flags, `${from}..${to}`], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
  );
}

/**
 * Whether this clone is shallow, asked once.
 *
 * CI checks out with `fetch-depth: 0` for the job that runs this suite, so a range
 * claim is always adjudicated there. A contributor's shallow clone may not carry
 * both ends, and a gate red for a reason that is not the contributor's is a gate
 * they learn to work around — so the claim is left unread, and said to be.
 */
const SHALLOW =
  execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim() === "true";

/** One population, and the way this file measures it. */
type Reader = (files: readonly string[], sentence: string) => readonly Verdict[];

/**
 * Which tree a claim is measured against, and whether it is measured at all.
 *
 * Three answers, and they are the whole rule:
 *
 * - a sentence that names one commit is measured **at that commit**, whatever
 *   tense it is in — that is what an anchor buys;
 * - a sentence in the present tense with no anchor is measured **against this
 *   tree**, the one the suite is running on;
 * - a sentence in the past tense with no anchor is a record and is not measured.
 *
 * A shallow clone that does not carry the anchor answers `unreachable`, so the
 * verdict says why rather than going red for a reason the reader cannot fix.
 */
type Ground =
  | { readonly at: "this tree" }
  | { readonly at: "a commit"; readonly commit: string }
  | { readonly at: "nothing"; readonly why: string };

function groundFor(sentence: string, past: boolean): Ground {
  const commit = anchorIn(sentence);
  if (commit === undefined) {
    return past ? { at: "nothing", why: RECORD_REASON } : { at: "this tree" };
  }
  if (!carriesCommit(commit)) {
    // A shallow clone is missing history through nobody's fault, and is told so.
    // A full clone that cannot find the commit has been given a name that is not
    // one, which is the same defect as a link to a file that does not exist.
    return { at: "nothing", why: SHALLOW ? SHALLOW_REASON : `names no commit: ${commit}` };
  }
  return { at: "a commit", commit };
}

const RECORD_REASON = "a record: the past tense, and no commit named to measure it at";
const SHALLOW_REASON = "this clone is shallow and does not carry the commit named";

const linesOfAFile: Reader = (files, sentence) => {
  const found: Verdict[] = [];
  for (const match of sentence.matchAll(LINES_CLAIM)) {
    const token = match[1] ?? "";
    const tenseless = match[3] !== undefined;
    const ground = groundFor(sentence, match[4] !== undefined);
    if (ground.at === "nothing" && ground.why === RECORD_REASON) {
      continue;
    }
    if (tenseless && ground.at === "this tree" && PAST_AUXILIARY.test(sentence)) {
      continue;
    }
    const stated = numberIn(match[5] ?? "");
    const where = ground.at === "a commit" ? ` at ${ground.commit}` : "";
    const tree = ground.at === "a commit" ? filesAt(ground.commit) : files;
    const candidates = ground.at === "nothing" ? [] : resolvePath(tree, token);
    if (ground.at === "nothing") {
      found.push({ what: `the lines of ${token}`, stated, measured: undefined, why: ground.why });
      continue;
    }
    if (candidates.length !== 1) {
      found.push({
        what: `the lines of ${token}${where}`,
        stated,
        measured: undefined,
        why:
          candidates.length === 0
            ? `names no file${where === "" ? " this tree carries" : where}`
            : `names ${candidates.length} files: ${candidates.join(", ")}`,
      });
      continue;
    }
    const path = candidates[0] ?? "";
    if (ground.at === "a commit") {
      found.push({
        what: `the lines of ${path}${where}`,
        stated,
        measured: lineCount(textAt(ground.commit, path)),
        why: "",
      });
      continue;
    }
    const onDisk = existsSync(resolve(ROOT, path));
    found.push({
      what: `the lines of ${path}`,
      stated,
      measured: onDisk ? lineCount(textOf(path)) : undefined,
      why: "tracked, but deleted in the working tree",
    });
  }
  return found;
};

const filesInADirectory: Reader = (files, sentence) => {
  const found: Verdict[] = [];
  for (const match of sentence.matchAll(DIRECTORY_CLAIM)) {
    const directory = match[1] ?? "";
    const ground = groundFor(sentence, match[2] !== undefined);
    if (ground.at === "nothing" && ground.why === RECORD_REASON) {
      continue;
    }
    const where = ground.at === "a commit" ? ` at ${ground.commit}` : "";
    const children =
      ground.at === "a commit"
        ? childrenOf(filesAt(ground.commit), directory)
        : childrenOf(files, directory);
    found.push({
      what: `the files in ${directory}${where}`,
      stated: numberIn(match[3] ?? ""),
      measured: ground.at === "nothing" ? undefined : children.length,
      why: ground.at === "nothing" ? ground.why : "",
    });
    const last = match[5];
    if (last === undefined) {
      continue;
    }
    const numbered = children
      .map((one) => /(?:^|\/)(\d{4})-/.exec(one)?.[1])
      .filter((one): one is string => one !== undefined)
      .map(Number);
    found.push({
      what: `the last numbered name in ${directory}${where}`,
      stated: Number(last),
      measured:
        ground.at === "nothing" || numbered.length === 0 ? undefined : Math.max(...numbered),
      why: ground.at === "nothing" ? ground.why : "holds no numbered file",
    });
  }
  return found;
};

/**
 * The one population an anchor cannot help.
 *
 * The lines of a file and the files in a directory are questions about a tree, and
 * `git` answers them at any commit. The exported names are not: reading them means
 * running the code, and the code that runs here is this tree's. So a sentence that
 * names a commit is left alone rather than answered against the wrong tree — and
 * the present tense is the only form this reader knows, which is the same thing
 * said from the other side.
 */
const namesThePackageExports: Reader = (_files, sentence) =>
  anchorIn(sentence) !== undefined
    ? []
    : [...sentence.matchAll(EXPORTS_CLAIM)].map((match) => ({
        what: "the names the package exports",
        stated: numberIn(match[1] ?? ""),
        measured: Object.keys(api).length,
        why: "",
      }));

const commitsInARange: Reader = (_files, sentence) => {
  const named = [...sentence.matchAll(COMMIT_NAME)].map((match) => match[1] ?? "");
  if (named.length !== 2) {
    return [];
  }
  const from = named[0] ?? "";
  const to = named[1] ?? "";
  const reachable = !SHALLOW || (carriesCommit(from) && carriesCommit(to));
  const found: Verdict[] = [];
  for (const [claim, merges, what] of [
    [COMMITS_CLAIM, "with", "the commits"],
    [NOT_MERGES_CLAIM, "without", "the commits that are not merges"],
  ] as const) {
    for (const match of sentence.matchAll(claim)) {
      found.push({
        what: `${what} between ${from} and ${to}`,
        stated: numberIn(match[1] ?? ""),
        measured: reachable ? commitsBetween(from, to, merges) : undefined,
        why: SHALLOW_ENDS_REASON,
      });
    }
  }
  return found;
};

const SHALLOW_ENDS_REASON = "this clone is shallow and does not carry both ends of the range";

/**
 * The reasons a claim is left unmeasured that are not the reader's to fix.
 *
 * Both are the same reason: a clone that does not carry the history. CI checks out
 * with `fetch-depth: 0` for the job that runs this suite, so neither fires there;
 * a contributor's shallow clone is where they do, and a gate red for a reason the
 * contributor cannot fix is a gate they learn to work around.
 */
const NOT_THE_READERS_FAULT: ReadonlySet<string> = new Set([SHALLOW_REASON, SHALLOW_ENDS_REASON]);

/**
 * The four populations this gate can adjudicate.
 *
 * A population belongs here when a command can enumerate it. That is the whole
 * admission rule, and it is what keeps this gate off "three layers" and "eight
 * doors" — counts of this repository in every sense except the one that decides,
 * which is that something can answer them.
 */
const READERS: readonly Reader[] = [
  linesOfAFile,
  filesInADirectory,
  namesThePackageExports,
  commitsInARange,
];

function verdictsIn(files: readonly string[], sentence: string): readonly Verdict[] {
  const text = unquoted(sentence);
  return READERS.flatMap((read) => read(files, text));
}

interface Claim extends Verdict {
  readonly file: string;
  readonly line: number;
  readonly sentence: string;
}

function claimsIn(files: readonly string[]): readonly Claim[] {
  const found: Claim[] = [];
  for (const file of files) {
    const kind = proseKind(file);
    if (kind === undefined || !existsSync(resolve(ROOT, file))) {
      continue;
    }
    const text = textOf(file);
    const prose = kind === "markdown" ? markdownProse(text) : commentProse(text);
    for (const sentence of sentencesOf(prose)) {
      for (const verdict of verdictsIn(files, sentence.text)) {
        found.push({ ...verdict, file, line: sentence.line, sentence: sentence.text });
      }
    }
  }
  return found;
}

function shortened(sentence: string): string {
  return sentence.length <= 120 ? sentence : `${sentence.slice(0, 117)}…`;
}

const files = trackedFiles();
const claims = claimsIn(files);

describe("a count of this tree, written into this tree", () => {
  it("reads four populations, each with something that can answer it", () => {
    // The table is the boundary this gate is drawn on, so it is asserted rather
    // than only described. A fifth reader is a fifth population, which is a
    // decision to take in ADR-0075 and not on the way past a red test.
    expect(READERS).toHaveLength(4);
  });

  it("finds prose to read, rather than staying silent on an empty list", () => {
    // A scan that found nothing is green for the same reason a passing one is.
    expect(files.filter((file) => proseKind(file) !== undefined).length).toBeGreaterThan(100);
  });

  it("finds counts this repository states about itself", () => {
    // A floor and not an exact number, and the reason is this file's own subject:
    // an exact count of the claims in the tree would be a count of the tree
    // written into the tree, invalidated by the commit that writes a claim. What
    // a floor holds is the failure that matters — a grammar that has stopped
    // matching the documents entirely. That each grammar still reads the shape it
    // was written for is held below, on samples this file builds itself.
    expect(claims.length).toBeGreaterThan(5);
  });

  it("resolves every subject a count names", () => {
    const unresolved = claims
      .filter((claim) => claim.measured === undefined && !NOT_THE_READERS_FAULT.has(claim.why))
      .map((claim) => `${claim.file}:${claim.line} ${claim.what} — ${claim.why}`);

    expect(unresolved).toEqual([]);
  });

  it("states counts the tree answers with", () => {
    const wrong = claims
      .filter((claim) => claim.measured !== undefined && claim.measured !== claim.stated)
      .map(
        (claim) =>
          `${claim.file}:${claim.line} states ${claim.stated} for ${claim.what}, ` +
          `and this tree has ${claim.measured} — ${shortened(claim.sentence)}`,
      );

    expect(wrong).toEqual([]);
  });
});

/**
 * The grammars, put to samples this file assembles at run time.
 *
 * Assembled rather than written out, for the reason `links.test.ts` gives next
 * door: this file is tracked and the scan above reads it like any other, so a
 * wrong count spelled here in prose would be a real finding about a real file —
 * the gate failing on its own evidence. Every sample below is built from parts,
 * and none of them is in a comment.
 */
describe("the grammar of a count", () => {
  const backtick = "`";
  const quote = (token: string): string => `${backtick}${token}${backtick}`;
  const claim = (subject: string, verb: string, count: string): string =>
    `${quote(subject)} ${verb} ${count} lines and stays one module.`;
  const shape = "src/report/shape.ts";
  /** The commit before ADR-0054's cut: `build.ts` at its largest, and 54 ADRs. */
  const BEFORE_THE_CUT = "4fca59d";

  it("reads a line count in the present tense", () => {
    const verdicts = verdictsIn(files, claim(shape, "is", "1 128"));

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.stated).toBe(1128);
    expect(verdicts[0]?.measured).toBe(lineCount(textOf(shape)));
  });

  it("reads the same claim written with `at` in place of the verb", () => {
    expect(verdictsIn(files, claim(shape, "at", "1 128"))).toHaveLength(1);
  });

  /**
   * `at` is an apposition and carries no tense, so the sentence's verb decides.
   *
   * The pair below is the whole asymmetry: the same number, the same subject, and
   * a verdict that turns on which of the two words the author reached for.
   */
  it("does not read the `at` form in a sentence about the past", () => {
    expect(verdictsIn(files, `${quote(shape)} at 1 128 lines was not covered.`)).toEqual([]);
  });

  it("reads the `is` form where the sentence is otherwise about the past", () => {
    const sentence = `${quote(shape)} is 1 128 lines, and the rest of it was cut.`;

    expect(verdictsIn(files, sentence)).toHaveLength(1);
  });

  /**
   * The boundary, asserted rather than only described.
   *
   * A count in the past tense is a record of a measurement: it was true when it
   * was taken and it stays true, so there is nothing in it to drift. This is also
   * the largest way past this gate, and one word is all it takes — which is why it
   * is in the header, in ADR-0075's `Limits`, and here.
   */
  it("does not read a line count in the past tense", () => {
    expect(verdictsIn(files, claim(shape, "was", "1 128"))).toEqual([]);
  });

  it("does not reach past prose for a subject", () => {
    const sentence = `The render half of ${quote("src/report/page.ts")}, and the rest, is 197 lines.`;

    expect(verdictsIn(files, sentence)).toEqual([]);
  });

  it("says so when a subject names more than one tracked file", () => {
    const verdicts = verdictsIn(files, claim("compare.ts", "is", "971"));

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.measured).toBeUndefined();
    expect(verdicts[0]?.why).toContain("src/report/compare.ts");
  });

  it("says so when a subject names no tracked file", () => {
    expect(verdictsIn(files, claim("src/report/nothing-here.ts", "is", "10"))[0]?.why).toBe(
      "names no file this tree carries",
    );
  });

  /**
   * The anchored form, which is the constructive half of the rule.
   *
   * A record that names the commit it was taken at is a question with an answer,
   * and the answer does not move. `src/report/build.ts` was 3 012 lines before
   * ADR-0054 cut it; the commit below is where it stood, and this is the whole
   * mechanism `tasks.md`'s census bullet now leans on.
   */
  it("measures a past-tense count at the commit a sentence names", () => {
    const anchored = `${quote("src/report/build.ts")} was 1 lines at ${quote(BEFORE_THE_CUT)}.`;
    const verdicts = verdictsIn(files, anchored);

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.measured).toBe(SHALLOW ? undefined : 3012);
  });

  it("measures a directory at the commit a sentence names", () => {
    const anchored = `${quote("docs/adr/")} held 1 files, 0000 through 0001, at ${quote(BEFORE_THE_CUT)}.`;
    const verdicts = verdictsIn(files, anchored);

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]?.measured).toBe(SHALLOW ? undefined : 54);
    expect(verdicts[1]?.measured).toBe(SHALLOW ? undefined : 53);
  });

  it("does not take a date for an anchor", () => {
    const dated = `${quote(shape)} was 1 128 lines on 23 August 2026.`;

    expect(verdictsIn(files, dated)).toEqual([]);
  });

  /**
   * A name that is not a commit is the same defect as a link to a file that is not
   * there, and it is said in the same words.
   *
   * Held apart from the shallow-clone case on purpose: one is a repository this
   * reader was not given, the other is a sentence this reader wrote.
   */
  it("says so when an anchor names no commit", () => {
    const nowhere = "0".repeat(40);
    const verdicts = verdictsIn(files, `${quote(shape)} was 1 128 lines at ${quote(nowhere)}.`);

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.measured).toBeUndefined();
    expect(verdicts[0]?.why).toBe(SHALLOW ? SHALLOW_REASON : `names no commit: ${nowhere}`);
  });

  it("reads a directory's file count and the last name in it", () => {
    const held = childrenOf(files, "docs/adr/").length;
    const verdicts = verdictsIn(
      files,
      `${quote("docs/adr/")} holds ${held} files, 0000 through 0000.`,
    );

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]?.measured).toBe(verdicts[0]?.stated);
    expect(verdicts[1]?.stated).toBe(0);
    expect(verdicts[1]?.measured).toBeGreaterThan(0);
  });

  it("reads the size of the published surface", () => {
    const verdicts = verdictsIn(files, "The package exports 1 names.");

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.measured).toBe(Object.keys(api).length);
  });

  it("reads a commit count only where the sentence names both ends", () => {
    const range = `Between ${quote("9e716e4")} and ${quote("29f99d7")}: 1 commits.`;

    expect(verdictsIn(files, "Some 1 commits went by.")).toEqual([]);
    expect(verdictsIn(files, range)).toHaveLength(1);
    expect(verdictsIn(files, range)[0]?.measured).toBe(SHALLOW ? undefined : 197);
  });

  it("does not read a sentence somebody else is being quoted in", () => {
    expect(verdictsIn(files, `The pointer read "${claim(shape, "is", "1 128")}"`)).toEqual([]);
  });

  it("does not read a claim inside a fenced block", () => {
    const fence = backtick.repeat(3);

    expect(sentencesOf(markdownProse([fence, claim(shape, "is", "9"), fence].join("\n")))).toEqual(
      [],
    );
  });

  /**
   * A count written across a line break is one count.
   *
   * Every document here is hard wrapped, and a thousands separator is a good place
   * for a wrap to land. Read line by line this claim is two numbers and no
   * population; read as a paragraph it is what its author wrote.
   */
  it("reads a count that a line break runs through", () => {
    const wrapped = [`${quote(shape)} is 1`, "128 lines and stays one module."];

    expect(verdictsIn(files, sentencesOf(wrapped)[0]?.text ?? "")).toHaveLength(1);
  });
});

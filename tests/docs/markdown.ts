/**
 * Reading a repository document, and one section of it.
 *
 * `envelope-limitation.test.ts` worked this out the expensive way and the lesson
 * is worth keeping in one place rather than in each guard that needs it: a
 * limitation asserted against the **whole** file is false-green as soon as the
 * README's `### Unreleased` entry describing the change repeats the same words,
 * and that entry is renamed at release and then kept forever. Deleting the
 * section itself leaves such a test passing off the changelog.
 *
 * So a guard over prose finds its section by heading. That also pins the name
 * the documents cross-reference each other by, which is the other half of what
 * makes a warning findable.
 *
 * This module is not a test file — `vitest.config.ts` includes
 * `tests/**\/*.test.ts` only.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A tracked document, by its repository path. */
export function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/**
 * Every heading of a document, in the order it reads, and nothing else.
 *
 * Fenced blocks are cut out first. `README.md` carries `# the tag must match
 * package.json's version` inside the shell snippet under "Releasing", and a
 * guard that reads position among headings would have counted it as one — which
 * is how a check about where a section sits comes to depend on a comment in an
 * example.
 *
 * Whole lines are returned rather than levels and text: what the callers ask is
 * whether a particular heading sits where they expect, and comparing the line
 * they already know keeps them from re-deriving the spelling.
 */
export function headingsOf(text: string): readonly string[] {
  let fenced = false;
  /** @see https://spec.commonmark.org/0.31.2/#fenced-code-blocks */
  const fence = /^\s{0,3}(?:`{3,}|~{3,})/;
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (fence.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && /^#{1,6} /.test(line)) {
      found.push(line.trimEnd());
    }
  }
  return found;
}

/**
 * Everything under a heading, up to the next heading of the same level or higher.
 *
 * The level is taken from the heading that was found rather than fixed, because
 * one section sits at `##` in `docs/report.md` and at `###` in `docs/guide.md` —
 * the guide keeps its boundaries inside "what the tool does not do" and the
 * report document gives them a top-level section of their own.
 *
 * An absent heading yields an empty string, so a missing section fails as one
 * assertion about the section rather than as a handful about its contents.
 */
export function section(text: string, heading: string): string {
  const start = new RegExp(`^(#{2,4}) ${heading}\\s*$`, "m").exec(text);
  if (start === null) {
    return "";
  }
  const level = (start[1] ?? "###").length;
  const body = text.slice(start.index + start[0].length);
  const end = new RegExp(`^#{1,${level}} `, "m").exec(body);
  return end === null ? body : body.slice(0, end.index);
}

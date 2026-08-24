/**
 * Reading a saved report, which is a document the tool was handed.
 *
 * A report file can come from another machine, an earlier build or somebody
 * else, exactly like an OpenAPI file or a Postman collection. ADR-0066 named
 * `toComparableRun` the ninth door and put the identifier grammar on it; this
 * module is that door's reading half, taken out of `compare.ts` on the day a
 * second reader arrived.
 *
 * ## Why it is a module and not a second copy
 *
 * The decision here is one sentence — **every string lifted out of a saved
 * report goes through the identifier grammar, and every refusal names the field
 * and the file** — and it was written once, inside `compare.ts`, where it read
 * as part of comparing. `evidencePack` reads a different set of fields out of
 * the same kind of file and needs the same sentence to be true of them. Writing
 * `stringAt` a second time in `pack.ts` is the shape CLAUDE.md counts eleven
 * times in its own history: a point fix per door, two of which had already
 * drifted apart before anybody noticed. ADR-0024 says what to do instead — the
 * grammar has one home and the doors call it — and this is that rule applied one
 * layer up, to the reading rather than to the grammar.
 *
 * The measurable half of the argument is in `tests/invariants/one-decision-one-home.test.ts`:
 * `src/report/compare.ts` used to be the module allowed to import `identifier`,
 * and that allowance now names this file. One module of the report layer reaches
 * into the owner, not two, and a third door added tomorrow reaches for `stringAt`
 * here rather than for the grammar itself. See ADR-0067.
 *
 * ## What it does not do
 *
 * It does not know what a report is. Each reader above it names the fields it
 * needs and stops there, for the reason `toComparableRun` gives: a second full
 * validator of the report shape beside `buildReport` is a duplicate that drifts,
 * and the first thing it would drift into is refusing a file this tool wrote.
 */

import { identifier } from "../core/identifiers.js";
import { openRecord } from "../io/untrusted.js";

/**
 * A file that is not a barbican report this tool can read.
 *
 * Public, like the rest of this package's error classes: telling a mistyped path
 * from a report of another vintage is something a consumer has to be able to do
 * in a `catch`, and `instanceof` needs the class. It reaches the published
 * surface through `compare.ts`, which is where it was declared until 25 August
 * 2026 and where a consumer's import of it already points.
 *
 * The sentence naming the two arguments of a comparison went with the move: this
 * class is now thrown by two readers, and a message telling the operator of
 * `barbican pack` that "both arguments" are report files would be describing
 * somebody else's command.
 */
export class UnreadableReportError extends Error {
  override readonly name = "UnreadableReportError";
  constructor(source: string, why: string) {
    super(
      `${source} is not a barbican report this tool can read: ${why}. ` +
        `A report file is what \`barbican run --report\` writes.`,
    );
  }
}

/** Whether a parsed value is an object worth reading fields off. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where in the document a value sits, as the operator reads the file.
 *
 * `""` at the root, `defects[3]` inside the fourth defect. It is threaded through
 * the readers below so that every refusal names the line rather than the field
 * name alone: `"key" is not a string` is unactionable in a file with forty
 * defects in it, and so is `The value at key carries U+001B`.
 *
 * Module-private, like `readable` under it. It was exported when this file was
 * cut out of `compare.ts` and no reader outside ever asked for it: what a reader
 * above wants is `stringAt` and the rest, which build the path themselves so that
 * every refusal spells a position the same way. A second caller composing its own
 * `at` string would be the second speller.
 */
function pathTo(holder: string, key: string): string {
  return holder === "" ? key : `${holder}.${key}`;
}

/**
 * Every string a reader lifts out of a saved report goes through the identifier
 * grammar, and this is the one place that happens.
 *
 * **Every** string, and not only the ones ADR-0066 calls identifiers. Each of
 * them is printed to a terminal, keyed on, or rendered into a document: a defect
 * key indexes the defect comparison, an endpoint id indexes the probed set, a
 * `notProbed` key indexes the skip table, and `runId`, `startedAt`,
 * `configDigest`, `verdict.reason`, `target.label` and the rest are printed
 * verbatim. Measured on 24 August 2026: an endpoint id carrying `U+001B [2K` and
 * a carriage return erases the line it was printed on, and a defect key carrying
 * `U+001B [31m` recolours the rest of the screen. None of them has a use for a
 * character that is not text, and none is ever the empty string in a report this
 * tool wrote — `target.label` is `min(1)` in the configuration schema, a digest
 * is 64 hex characters, and `citableDefectKey` writes `any-resource` and
 * `baseline` where a coordinate is missing.
 *
 * A rendered document is the newer reason and the same one. HTML is a second
 * grammar with a second set of characters that are not text to it, and escaping
 * on the way out is modelling somebody else's parser — which CLAUDE.md names as
 * how the address grammar was wrong the first time. Refusing at the door leaves
 * the renderer with strings that carry no control character at all, which is one
 * fewer thing for it to be right about.
 *
 * Refused rather than escaped, for the reason CLAUDE.md gives about the address:
 * the tool would otherwise hold an id it can never print back. See ADR-0066.
 */
function readable(source: string, path: string, value: string): string {
  return identifier(value, `${path} in the report "${source}"`);
}

/** @throws {UnreadableReportError} when the field is absent or is not a string. */
export function stringAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
  at = "",
): string {
  const path = pathTo(at, key);
  const value = holder[key];
  if (typeof value !== "string") {
    throw new UnreadableReportError(source, `"${path}" is not a string`);
  }
  return readable(source, path, value);
}

/** A field a report may leave out, checked when it is there. */
export function optionalStringAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
  at = "",
): string | undefined {
  const value = holder[key];
  return typeof value === "string" ? readable(source, pathTo(at, key), value) : undefined;
}

/** @throws {UnreadableReportError} when the field is absent or is not finite. */
export function numberAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
  at = "",
): number {
  const value = holder[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UnreadableReportError(source, `"${pathTo(at, key)}" is not a number`);
  }
  return value;
}

/** @throws {UnreadableReportError} when the field is absent or is not an object. */
export function objectAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
  at = "",
): Readonly<Record<string, unknown>> {
  const value = holder[key];
  if (!isRecord(value)) {
    throw new UnreadableReportError(source, `"${pathTo(at, key)}" is missing or is not an object`);
  }
  return value;
}

/** @throws {UnreadableReportError} when the field is absent or is not an array. */
export function arrayAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
  at = "",
): readonly unknown[] {
  const value = holder[key];
  if (!Array.isArray(value)) {
    throw new UnreadableReportError(source, `"${pathTo(at, key)}" is missing or is not an array`);
  }
  return value;
}

/** @throws {UnreadableReportError} when the field is not an array of strings. */
export function stringsAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
  at = "",
): readonly string[] {
  const path = pathTo(at, key);
  return arrayAt(source, holder, key, at).map((one, index) => {
    if (typeof one !== "string") {
      throw new UnreadableReportError(source, `"${path}" holds something that is not a string`);
    }
    return readable(source, `${path}[${index}]`, one);
  });
}

/**
 * The counts a record of "how many, by reason" carries, over keys the tool did
 * not choose.
 *
 * `openRecord`, not `{}`: the keys are a saved file's, and a reason literally
 * named `__proto__` is swallowed by an object literal — the assignment is a
 * no-op and the row silently disappears from whatever reads it. ADR-0024.
 */
export function countsAt(
  source: string,
  holder: Readonly<Record<string, unknown>>,
  key: string,
  at = "",
): Readonly<Record<string, number>> {
  const path = pathTo(at, key);
  const value = objectAt(source, holder, key, at);
  const counts = openRecord<number>();
  for (const [reason, count] of Object.entries(value)) {
    // The key before the count. It is printed and it indexes a table, so it is a
    // string out of a document doing both the things `readable` is about. Named
    // by its position rather than by itself, because a message that quoted it
    // would carry what it is refusing onto the terminal the refusal exists to
    // protect.
    readable(source, `a key of ${path}`, reason);
    if (typeof count !== "number" || !Number.isFinite(count)) {
      throw new UnreadableReportError(source, `"${path}.${reason}" is not a number`);
    }
    counts[reason] = count;
  }
  return counts;
}

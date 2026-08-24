/**
 * The grammar of an identifier — the strings this tool keys its own tables on.
 *
 * `src/core/keys.ts` said of its separator that it is "a character that never
 * occurs in an identifier". Nothing made that true. An endpoint id, a context id
 * and an acceptance's `kind` are `z.string().min(1)` with no character class,
 * YAML writes a NUL as `\0` inside double quotes, and `src/adapters/endpoint-list.ts`
 * admits one because it asks only that the id not be blank. A key is a fixed
 * number of parts joined by that character, so a part carrying it splits two
 * ways. Adversarial review of 24 August 2026 measured the pair, both entries
 * legal that morning:
 *
 *     accepted:
 *       - { endpoint: "a",      relation: own, kind: "\0E", reason: r1, until: … }
 *       - { endpoint: "a\0own",                kind: "E",   reason: r2, until: … }
 *
 * One `acceptanceKeyOf`, two different defects. Through the library door
 * `indexAcceptances` is a `Map` on that key, so the second entry replaced the
 * first and decided its deadline, silently. See ADR-0066.
 *
 * ## Why the core and not `src/io/untrusted.ts`
 *
 * ADR-0024 puts a grammar for a string from outside in `src/io/untrusted.ts`,
 * **unless the core reads the same grammar** — then it lives in `src/core` and
 * `untrusted.ts` reaches down for it, because `untrusted.ts` already imports
 * `isUsablePathSegment` from `./types.js` and a core that imported back would
 * close that ring. This one is not merely read by the core: the place it has to
 * hold is `joinKey` in `./keys.js`, which is core, and which is the one seam a
 * consumer of the library cannot walk past. `./types.js` and `./path-parameters.ts`
 * are the two precedents, and this is the third.
 *
 * Its own module rather than more lines in `./types.js`, following
 * `./path-parameters.ts`: the doors that report a refusal in an operator's words
 * are in four layers, and a module they can all import without dragging the
 * whole of the core's vocabulary with it is the cheaper import.
 *
 * ## What it refuses, and why the line is there
 *
 * A code point that is not text: the C0 controls, DEL, the C1 controls, and the
 * two Unicode line separators. Plus the empty string, which is the *absence*
 * sentinel every key in this repository writes for a coordinate it does not have.
 *
 * Refusing the NUL alone would be the twelfth point fix ADR-0024 counts. It
 * would make the sentence in `keys.ts` true by naming one character, and it
 * would stay true only until the separator moved. The rule as written is true of
 * the separator whatever the separator becomes — and it is the rule the address
 * grammar one layer over already applies to a path, for the same reason in
 * another slot (`isNeverInAPath` in `src/io/untrusted.ts`, ADR-0032).
 *
 * The rest of the range is not padding. An identifier is printed: into the
 * report a person reads, into an error message, onto a terminal. A newline in an
 * endpoint id makes one line of console output read as two, with the second
 * under the control of the document being tested; `U+001B` opens an escape
 * sequence a terminal obeys; a carriage return rewrites the line already
 * printed. The C1 range is the same class in a spelling that survives a search
 * for `\n`, and `U+2028` is a line terminator to a JavaScript parser, which is
 * what the JSON of a report becomes the moment it is embedded in a page.
 *
 * Where the line stops is as deliberate. A space, punctuation, a letter from any
 * script and an emoji are all allowed: a Postman folder path is somebody's
 * prose, and an endpoint called `Bestellungen / Übersicht` is a legal id today. So are the
 * characters that make two different ids *look* alike — a homoglyph, a
 * bidirectional override — because those are a legibility problem and not an
 * identity one: a key is compared by code points, and two ids that read alike are
 * still two rows. ADR-0066 lists that under what this grammar does not hold.
 */

/**
 * Whether a code unit is text, for the purpose of naming something.
 *
 * Read as the question it asks rather than as a character class: Biome refuses a
 * control character inside a regular expression (`noControlCharactersInRegex`),
 * and for once the rule and the intent agree.
 *
 * A code **unit** and not a code point, because every value it answers `true`
 * for is in the basic plane and none of them is a surrogate. A scan over units
 * therefore gives the same answer as a scan over points, on any input, and it
 * gives it without building an array — which matters, because `joinKey` asks
 * this of every coordinate of every cell of a run.
 */
function isNotText(code: number): boolean {
  // C0, then DEL together with C1, then the two line separators.
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** `U+001B`, from the code unit, for a message and for the escape below. */
function nameOf(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * The value as an operator can look for it, with every refused character spelled
 * out.
 *
 * Not decoration. The refusal is printed to a terminal and written into a log,
 * and a message that quoted the value as it arrived would carry the escape
 * sequence it is refusing into the very place the refusal exists to protect.
 *
 * Exported, which ADR-0066 left as an open question — "a fourth name on the
 * surface for the sake of a message" — because a second caller arrived with a
 * stronger reason than a message. A response header on the value allowlist is
 * text the **platform under test** chose, and it travels whole into
 * `observations[].headers` and from there into the report. `JSON.stringify`
 * escapes C0 and leaves C1 alone, so a `content-type` carrying U+009B reaches
 * the file intact: measured on 24 August 2026, two raw C1 characters in a
 * report this tool wrote. The report is the artifact an operator hands to
 * somebody else, and this project already refuses to let it carry a body or a
 * secret; carrying an escape sequence is the same promise.
 *
 * Spelled out rather than redacted, because the value is evidence — a reader
 * still needs to see what the platform sent — and rather than escaped on the
 * way to a screen, because the tool does not own the screen the file is opened
 * on. One representation, at the point the value is kept.
 *
 * Over code units for the reason above, and safely: a character that is passed
 * through is passed through whole, so the halves of a surrogate pair rejoin.
 */
export function spellOut(value: string): string {
  let written = "";
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    written += isNotText(code) ? `\\u${nameOf(code)}` : value[at];
  }
  return written;
}

/**
 * Which rule refuses this string, as the words that follow the name of the slot.
 *
 * One decision read by both entry points below. `isUsableIdentifier` answers the
 * seam, which asks only whether the string is one; `identifier` answers a door,
 * which has to say what to change. ADR-0061 is the reason they are not two
 * spellings: two readings of one rule is how a sixth rule reaches one of them and
 * not the other.
 */
function refusalOf(value: string): string | undefined {
  if (value === "") {
    return "is empty, and an empty coordinate is how a key says it has none";
  }
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (isNotText(code)) {
      return `carries U+${nameOf(code)}, which is a control character rather than text`;
    }
  }
  return undefined;
}

/**
 * A string this tool refuses to key a table on.
 *
 * A class rather than a name, because `instanceof` is how a consumer of the
 * library tells a configuration mistake from a network failure, and this one is
 * thrown from the seam every key passes through. See `docs/library.md`.
 */
export class UnusableIdentifierError extends Error {
  /** The string as it arrived, unescaped. The message carries the spelled-out form. */
  readonly value: string;

  constructor(what: string, value: string, reason: string) {
    super(
      `${what} ${reason}. Written out, the value is "${spellOut(value)}". An ` +
        `identifier names a row of this tool's own tables: the matrix, the findings ` +
        `and the acceptances meet on keys that are these strings joined with a ` +
        `control character, so a coordinate carrying one glues two different rows ` +
        `into a single entry — and the same string is printed into the report and ` +
        `onto a terminal, where a newline makes one row read as two and an escape ` +
        `is a command. Change it where it is declared.`,
    );
    this.name = "UnusableIdentifierError";
    this.value = value;
  }
}

/**
 * Whether a string can name a row of this tool's tables.
 *
 * Exported beside the constructor for the reason `isUsablePathSegment` is: a
 * consumer assembling `Endpoint[]` or `Acceptance[]` for the library door can ask
 * before it builds, and get its own message at the place the value was chosen,
 * rather than the general one the seam throws.
 */
export function isUsableIdentifier(value: string): boolean {
  return refusalOf(value) === undefined;
}

/**
 * The same rule at a door, with the slot named.
 *
 * `what` is the operator's word for where the string came from — `The id of
 * account #2`, `accepted[0].kind` — and it is the whole difference between this
 * and the seam. "A coordinate of a key is unusable" is true and unactionable;
 * the line of the file is the answer.
 *
 * @throws {UnusableIdentifierError}
 */
export function identifier(value: string, what: string): string {
  const reason = refusalOf(value);
  if (reason !== undefined) {
    throw new UnusableIdentifierError(what, value, reason);
  }
  return value;
}

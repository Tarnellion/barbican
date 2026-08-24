/**
 * The pack as one page: a self-contained HTML document drawn from the structure,
 * adding nothing to it.
 *
 * `evidencePack` decided what may be said about a clause (ADR-0067). This module
 * decides nothing at all — it is the separate step `CLAUDE.md` requires: "JSON is
 * the single source of truth. HTML/PDF are rendered from JSON in a separate step,
 * not generated along the way as the checks run." A pack is built from a saved
 * report, and a page is drawn from a pack.
 *
 * ## Every sentence comes from the structure
 *
 * The page prints **labels and values**. Every sentence that says something about
 * the platform or about the run is `pack.notes` or `CLAIMS[row.claim]`, read out
 * of the table rather than restated here. A heading that asserted anything the
 * structure does not carry would be a claim made by a renderer, which is exactly
 * the failure `a-claim-has-one-wording.test.ts` names as the one it cannot see: a
 * column printing `PASS` beside an `upheld` row says something the table never
 * said. `tests/report/pack-page.test.ts` is the reader's half of that, and it
 * asserts the absence of those words by name.
 *
 * ## Nothing in the page reaches anywhere, and nothing in it runs
 *
 * An auditor opens this on a machine with no network, and a rendered document is
 * a new sink for text somebody else wrote — an operator's identifiers, the
 * platform's own words, a catalogue a consumer registered. So the page carries no
 * script, no external stylesheet, no font, no image, and **no attribute a browser
 * dereferences**: {@link Attribute} is a closed union that has no `href`, no
 * `src` and no `on…`, so a link is not something this renderer can emit at all.
 * That is structural rather than a scan — a `javascript:` URL in a clause's
 * `url` is printed as text because there is no element here that could make it
 * anything else.
 *
 * The address is printed rather than linked for the same reason `report.json`
 * prints one: the tool does not vouch for a string it was handed, and a live
 * control in an evidence pack is a capability nobody asked this document for.
 *
 * ## Two escapings, composed and never merged
 *
 * {@link words} is the one seam a dynamic string reaches the page through, and it
 * does two different jobs in order.
 *
 * `spellOut` (`src/core/identifiers.ts`, ADR-0066) first: a code point that is
 * **not text** becomes text. It is imported and not rewritten, per ADR-0024 — a
 * second spelling of "what is not text" is the twelfth point fix that rule counts.
 * The door under the pack already refuses every one of those characters
 * (`src/report/document.ts`), so on a pack built by `toPackableRun` this is the
 * identity; it is applied anyway because two of the renderer's inputs never went
 * through that door — the catalogue, which a consumer may register from a private
 * source (ADR-0043), and a `PackableRun` a consumer assembled itself, which is a
 * structural type and not a checked one.
 *
 * Then the markup escaping below, which is a **different job for a different
 * sink** and is deliberately not moved next to `spellOut`. `spellOut` is a
 * decision about how a value is *kept*: its output goes into `report.json` and is
 * what a person reads back out of the file. Teaching it `&lt;` would put HTML
 * entities into the report — a lie about what the platform sent, in the artifact
 * this project is most careful about. The two sets of characters do not overlap
 * and neither has to agree with the other; what would have to agree is a second
 * control-character rule, and there is not one.
 */

import { spellOut } from "../core/identifiers.js";
import { byCodeUnits } from "../core/order.js";
import type { CitedClause, ClaimedClause, EvidencePack, PackableCells } from "./pack.js";
import { CLAIMS } from "./pack.js";

/**
 * A fragment of the page, already encoded.
 *
 * A brand and not a plain string, following `HeaderValue` in
 * `src/io/untrusted.ts` and for its reason: the only way to obtain one is
 * {@link words}, {@link tag}, {@link pieces} or {@link stylesheet}, so a raw
 * string cannot be spliced into the document by anything in this module. There is
 * no "trust me" constructor to reach for, which is what makes the seam a seam
 * rather than a convention.
 */
type Markup = string & { readonly __page: "Markup" };

/**
 * The elements this document is built from.
 *
 * A closed union rather than a string, so that a tag name cannot be computed. It
 * costs one line per element added and buys the sentence above: `script`,
 * `iframe`, `object` and `link` are not spellable here.
 */
type Element =
  | "html"
  | "head"
  | "meta"
  | "title"
  | "style"
  | "body"
  | "header"
  | "main"
  | "footer"
  | "section"
  | "h1"
  | "h2"
  | "h3"
  | "p"
  | "dl"
  | "dt"
  | "dd"
  | "ul"
  | "li"
  | "span"
  | "code";

/**
 * The attributes this document is built from.
 *
 * The load-bearing half of the pair above. `href`, `src`, `srcset`, `style` and
 * every `on…` are absent, so the page has no way to reach anywhere and no way to
 * run anything — proved structurally by this type and again by a scan of the
 * rendered bytes in `tests/report/pack-page.test.ts`, because a reader of the
 * artifact deserves the second one.
 */
type Attribute = "lang" | "charset" | "name" | "content" | "class" | "id";

/** The elements above that take no children and no closing tag. */
const VOID: ReadonlySet<Element> = new Set<Element>(["meta"]);

/**
 * A pack this build has no sentence for.
 *
 * A class rather than a message, like the rest of this package's errors: telling
 * a pack from a later build apart from a corrupt file is done in a `catch`, and
 * `instanceof` needs the class.
 *
 * Refused rather than rendered, and this is the one place the renderer decides
 * anything. `ClaimStatus` is a closed union, so a TypeScript consumer cannot
 * reach here without a cast — but a pack parsed back out of a `--json` file, or
 * one written by a build whose vocabulary has since grown, is an `EvidencePack`
 * by structure and not by construction. The alternatives are both worse than a
 * refusal: a row printed with a bare code and no sentence hands a third party a
 * word with no statement of what it means, and a row silently reworded into the
 * nearest known claim is this whole artifact's forbidden direction. The pack's
 * own door takes the same position on a `schemaVersion` it cannot read, and for
 * the same reason (ADR-0067).
 *
 * A reservation is the opposite case and is deliberately treated the opposite
 * way: an unrecognised **qualification** is carried through, because dropping one
 * strengthens a claim. An unrecognised **claim** is the claim itself.
 *
 * The value is spelled out and not quoted raw: the message is printed to a
 * terminal, and this class exists because the string came from somewhere else.
 */
export class UnrenderableClaimError extends Error {
  override readonly name = "UnrenderableClaimError";
  constructor(standard: string, clause: string, claim: string) {
    super(
      `The clause ${spellOut(standard)} ${spellOut(clause)} carries the claim ` +
        `"${spellOut(claim)}", and this build has no sentence for it. A pack states ` +
        `what it is willing to say about a clause, and a document that printed the ` +
        `code without the sentence would hand a third party a word with nothing ` +
        `behind it. Build the pack with the version of barbican that renders it.`,
    );
  }
}

/**
 * One character as markup, or itself.
 *
 * A `switch` rather than a table keyed by the character: the key here comes from
 * a string somebody else wrote, and a lookup on an object literal is the shape
 * ADR-0024 is about. A single character can be neither `__proto__` nor
 * `constructor`, so this is not a defect being fixed — it is the shape that has
 * nothing to argue about.
 *
 * Five characters and not three. `&`, `<` and `>` are the text-node rule; `"` and
 * `'` are what keeps a value inside its quotes in an attribute, and the two
 * contexts share one function so that an attribute cannot be escaped by the
 * weaker of two rules — which is how a second escaper drifts from the first.
 */
function marked(character: string): string {
  switch (character) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    case "'":
      return "&#39;";
    default:
      return character;
  }
}

/**
 * The one seam a string somebody else wrote reaches the page through.
 *
 * `spellOut` first, then the markup escaping: make it text, then encode it for
 * this sink. See the module comment for why those are two jobs and why only one
 * of them lives here.
 *
 * Over code units, like `spellOut`: every character it rewrites is in the basic
 * plane and none is a surrogate, so a scan of units gives the same answer as a
 * scan of points and passes a surrogate pair through whole.
 */
function words(value: string): Markup {
  const text = spellOut(value);
  let written = "";
  for (let at = 0; at < text.length; at += 1) {
    written += marked(text.charAt(at));
  }
  return written as Markup;
}

/** Fragments in a row, which is the only concatenation this module does. */
function pieces(children: readonly Markup[]): Markup {
  return children.join("") as Markup;
}

/**
 * One element.
 *
 * Attribute values take a raw string and are put through {@link words} here, so
 * that a caller cannot hand one an already-encoded fragment and encode it twice —
 * and cannot hand one a fragment that was never encoded at all.
 *
 * Both lists are written out at every call rather than defaulted to `[]`. A
 * default nobody takes is a branch nothing exercises, and this repository gates
 * branch coverage; a default one caller takes is worse, because it hides which
 * of the two lists was meant to be empty.
 */
function tag(
  name: Element,
  attributes: readonly (readonly [Attribute, string])[],
  children: readonly Markup[],
): Markup {
  const written = attributes.map(([key, value]) => ` ${key}="${words(value)}"`).join("");
  if (VOID.has(name)) {
    return `<${name}${written}>` as Markup;
  }
  return `<${name}${written}>${pieces(children)}</${name}>` as Markup;
}

/** An element with one text child, which is most of them. */
function line(name: Element, className: string, value: string): Markup {
  return tag(name, [["class", className]], [words(value)]);
}

/** A `<dt>`/`<dd>` pair: the label of a field, and the field. */
function field(label: string, children: readonly Markup[]): readonly Markup[] {
  return [tag("dt", [], [words(label)]), tag("dd", [], children)];
}

/** The same, where the field is one string. */
function said(label: string, value: string): readonly Markup[] {
  return field(label, [words(value)]);
}

/**
 * The stylesheet, inline and entire.
 *
 * A module-private literal with nothing interpolated into it, and there is no
 * function here that would put a computed string inside a `<style>` — which is
 * what makes `</style>` unreachable from the outside. A value carrying that text
 * goes through {@link words} into a text node and arrives as `&lt;/style&gt;`.
 *
 * What it deliberately does not have: no `url(`, no `@import`, no `@font-face`.
 * The page is opened on a machine with no network, so a stylesheet that could
 * fetch would either fail or reach out, and both are wrong.
 *
 * One light palette and no `prefers-color-scheme` block. This is a document that
 * ends up as a PDF through a browser's print dialogue, browsers print the light
 * rendering, and a second palette is a second thing to keep level for a reader
 * who will not see it. Colour is never the only carrier of anything: a claim is a
 * word on the row and the tint beside it repeats that word, so the page says the
 * same thing in monochrome.
 *
 * The print rules are reasoned about rather than measured — no browser runs in
 * this repository's test suite. `break-inside: avoid` on a clause row is what
 * keeps a claim from being split across a page boundary from its numbers, and it
 * is written with the legacy `page-break-inside` beside it because the engines
 * disagree about which they honour. `break-after: avoid` on a heading keeps a
 * section title off the foot of a page. ADR-0068 says plainly that these are
 * declarations and not observations.
 */
function stylesheet(): Markup {
  const style = [
    ":root { color-scheme: light; }",
    "* { box-sizing: border-box; }",
    "body { margin: 0 auto; padding: 2rem 1.4rem 4rem; max-width: 58rem;",
    "  background: #ffffff; color: #16181d;",
    '  font: 15px/1.55 ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }',
    "h1 { font-size: 1.5rem; margin: 0 0 1rem; }",
    "h2 { font-size: 1.05rem; margin: 2.2rem 0 .7rem; padding-bottom: .3rem;",
    "  border-bottom: 1px solid #d5dae2; break-after: avoid; page-break-after: avoid; }",
    "h3 { font-size: 1rem; margin: 0 0 .45rem; font-weight: 600; }",
    "p { margin: 0 0 .6rem; }",
    "dl { margin: 0; display: grid; grid-template-columns: 12rem 1fr; gap: .18rem .9rem; }",
    "dt { color: #5a6270; font-size: .82rem; text-transform: uppercase;",
    "  letter-spacing: .04em; padding-top: .12rem; }",
    "dd { margin: 0; }",
    "ul { margin: 0; padding-left: 1.1rem; }",
    "code, .ref { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
    "  font-size: .92em; }",
    ".identity { border: 1px solid #d5dae2; border-radius: 4px; padding: .9rem 1.1rem; }",
    ".notes p { color: #2c313a; }",
    ".tally li { margin-bottom: .1rem; }",
    ".clause { border: 1px solid #d5dae2; border-left: 5px solid #8d95a3;",
    "  border-radius: 4px; padding: .85rem 1.1rem; margin: 0 0 .7rem;",
    "  break-inside: avoid; page-break-inside: avoid; }",
    ".claim { display: inline-block; margin-left: .5rem; padding: .05rem .45rem;",
    "  border: 1px solid #b9c0cb; border-radius: 3px; font-size: .78rem;",
    "  text-transform: uppercase; letter-spacing: .05em; }",
    ".claim-breached { border-left-color: #9b2c2c; }",
    ".claim-upheld { border-left-color: #2f6b3a; }",
    ".claim-unanswered { border-left-color: #6b6f78; }",
    ".claim-withheld { border-left-color: #8a5a12; }",
    ".claim-inconclusive { border-left-color: #6b6f78; }",
    // `answered-without-findings` had no rule of its own until 24 August 2026,
    // so one claim of six fell through to the default border. Its own tone, and
    // not the green of `upheld`: a check that ran and found nothing has no
    // denominator behind it (ADR-0052 refused to invent one), and it must not
    // read as the stronger statement standing beside it.
    ".claim-answered-without-findings { border-left-color: #4a6b78; }",
    ".says { color: #2c313a; margin: 0 0 .6rem; }",
    ".reservations { color: #6b3f0a; }",
    "footer { margin-top: 2.5rem; padding-top: .7rem; border-top: 1px solid #d5dae2;",
    "  color: #5a6270; font-size: .85rem; }",
    "@page { margin: 18mm 16mm; }",
    "@media print {",
    "  body { max-width: none; padding: 0; font-size: 10.5pt;",
    "    background: #ffffff; color: #000000; }",
    "  .clause, .identity { break-inside: avoid; page-break-inside: avoid; }",
    "  h2, h3 { break-after: avoid; page-break-after: avoid; }",
    "  p, li { orphans: 3; widows: 3; }",
    "}",
  ].join("\n");
  return `<style>\n${style}\n</style>` as Markup;
}

/** The run this pack was built from, as the pack names it. */
function identity(pack: EvidencePack): Markup {
  const { run } = pack;
  const rows: Markup[] = [
    ...said("Tool", `${run.tool.name} ${run.tool.version}`),
    ...said("Documentation", run.tool.documentation),
    ...said("Target", run.target.label ?? run.target.baseUrl),
    ...said("Address", run.target.baseUrl),
    ...said("Run", run.runId),
    ...said("Declaration", run.configDigest),
    ...said("Started", run.startedAt),
    ...said("Finished", run.finishedAt),
    ...said("Verdict", `${run.verdict.code} — ${run.verdict.reason}`),
    ...said("Standing", pack.standing),
    ...said(
      "Surface",
      `${run.surface.cellsObserved} cells over ${run.surface.endpointsProbed} of ` +
        `${run.surface.endpointsTotal} endpoints`,
    ),
  ];
  if (run.evidenceRowsOmitted > 0) {
    rows.push(...said("Evidence rows left out", String(run.evidenceRowsOmitted)));
  }
  return tag("section", [["class", "identity"]], [tag("dl", [], rows)]);
}

/**
 * What governs the whole document, in the order the pack puts it in.
 *
 * Printed before anything a row says, and printed whole. These are the four
 * sentences `EvidencePack.notes` carries — the standing, then the three limits of
 * the method — and a document that dropped one would be claiming more than the
 * pack does.
 */
function notes(pack: EvidencePack): Markup {
  return pieces([
    tag("h2", [], [words("What this document is")]),
    tag(
      "section",
      [["class", "notes"]],
      pack.notes.map((one) => tag("p", [], [words(one)])),
    ),
  ]);
}

/** The run's own warnings, in the tool's own words, or nothing. */
function warnings(pack: EvidencePack): Markup {
  if (pack.run.warnings.length === 0) {
    return "" as Markup;
  }
  return pieces([
    tag("h2", [], [words("What the run said about itself")]),
    tag(
      "ul",
      [],
      pack.run.warnings.map((one) => tag("li", [], [words(one)])),
    ),
  ]);
}

/**
 * How many clauses stand at each claim, every status named.
 *
 * ADR-0067 refused "a percentage, a score, or a count of clauses passed", and
 * this is not one: nothing is summed and nothing is divided. Every status of
 * `CLAIMS` gets a line whether or not any clause reached it, in the table's own
 * order, so the number a reader most needs — how many clauses nothing answered
 * for — cannot be the one that went missing. That number is the whole of B-4.
 */
function tally(pack: EvidencePack): Markup {
  const counted = Object.keys(CLAIMS).map((claim) => {
    const many = pack.clauses.filter((one) => one.claim === claim).length;
    return tag("li", [], [words(`${many} ${claim}`)]);
  });
  return pieces([
    tag("h2", [], [words("The catalogue, clause by clause")]),
    tag(
      "dl",
      [],
      [
        ...said("Clauses in the catalogue", String(pack.clauses.length)),
        ...said("Cited outside the catalogue", String(pack.outsideCatalogue.length)),
        ...field("At each claim", [tag("ul", [["class", "tally"]], counted)]),
      ],
    ),
  ]);
}

/** The cells of the matrix under one clause, as the report counted them. */
function cellFields(cells: PackableCells): readonly Markup[] {
  const inconclusive = Object.entries(cells.inconclusive)
    .sort(([left], [right]) => byCodeUnits(left, right))
    .map(([reason, many]) => tag("li", [], [words(`${many} ${reason}`)]));
  return [
    ...said(
      "Cells",
      `${cells.conclusive} reached a conclusion: ${cells.upheld} upheld, ${cells.breached} breached`,
    ),
    ...(inconclusive.length === 0 ? [] : field("Concluded nothing", [tag("ul", [], inconclusive)])),
  ];
}

/**
 * One clause, with everything the run had to say about it on the row.
 *
 * The reservations are here and not in a footnote, which is the reason
 * `clauseReservationsOf` exists: a qualification left behind in another section
 * is one that did not travel with the claim, and the defect this whole artifact
 * is written against is a claim that outran its own numbers.
 *
 * An empty `reservations` prints nothing rather than "none". The structure
 * conflates two cases — a clause row that recorded no qualification, and a clause
 * with no row to read one off — and a document that printed "none recorded" would
 * be picking one of the two for the reader. See ADR-0068.
 */
function clause(row: CitedClause, catalogued: ClaimedClause | undefined, at: number): Markup {
  // `Object.hasOwn` and not `CLAIMS[row.claim] !== undefined`: the key comes from
  // a document, and indexing an object literal answers for `constructor` and for
  // `toString`. ADR-0024, in the smallest slot it has.
  if (!Object.hasOwn(CLAIMS, row.claim)) {
    throw new UnrenderableClaimError(row.standard, row.clause, row.claim);
  }
  const heading = tag(
    "h3",
    [],
    [
      line("span", "ref", `${row.standard} ${row.clause}`),
      // A space in the markup and not only the margin in the stylesheet. The two
      // spans are adjacent, so a reader that drops the CSS — a browser's reading
      // mode, a screen reader, anything that copies the text out — gets
      // `8.1.1breached` from the margin alone. Measured on a real pack.
      words(" "),
      line("span", "claim", row.claim),
    ],
  );
  const figures: Markup[] = [];
  if (catalogued !== undefined) {
    figures.push(...said("Clause", catalogued.title));
  }
  if (row.cells !== undefined) {
    figures.push(...cellFields(row.cells));
  }
  if (row.checkIds.length > 0) {
    figures.push(...said("Checks that answer for it", row.checkIds.join(", ")));
  }
  figures.push(
    ...said(
      "Evidence rows",
      `${row.evidence.disagreements} recording a disagreement ` +
        `(${row.evidence.heldByAcceptance} held by an acceptance), ` +
        `${row.evidence.other} recording something else` +
        (row.evidence.lowerBound ? " — a floor, the file left evidence rows out" : ""),
    ),
  );
  if (row.reservations.length > 0) {
    figures.push(
      ...field("Reservations", [
        tag(
          "ul",
          [["class", "reservations"]],
          row.reservations.map((one) => tag("li", [], [words(one)])),
        ),
      ]),
    );
  }
  if (catalogued !== undefined) {
    figures.push(...said("Catalogued scope", catalogued.scope));
    figures.push(...said("Published wording", catalogued.url));
  }
  return tag(
    "section",
    [
      ["class", `clause claim-${row.claim}`],
      ["id", `clause-${at}`],
    ],
    [heading, line("p", "says", CLAIMS[row.claim]), tag("dl", [], figures)],
  );
}

/** Every clause of the catalogue, in the catalogue's own order. */
function clauseRows(pack: EvidencePack): Markup {
  return pieces(pack.clauses.map((row, at) => clause(row, row, at)));
}

/** The clauses the run cited that this catalogue does not carry, or nothing. */
function outside(pack: EvidencePack): Markup {
  if (pack.outsideCatalogue.length === 0) {
    return "" as Markup;
  }
  return pieces([
    tag("h2", [], [words("Cited outside the catalogue")]),
    pieces(
      pack.outsideCatalogue.map((row, at) => clause(row, undefined, pack.clauses.length + at)),
    ),
  ]);
}

/**
 * The pack as a page.
 *
 * Pure, and the whole input is the pack: no clock, no file system, no network,
 * nothing read from the environment. Two renderings of one pack are byte for byte
 * the same document on every machine, which is ADR-0036's rule applied to the
 * artifact a third party is handed.
 *
 * The result is one file. Everything it needs is inside it.
 */
export function renderPack(pack: EvidencePack): string {
  const page = tag(
    "html",
    [["lang", "en"]],
    [
      tag(
        "head",
        [],
        [
          tag("meta", [["charset", "utf-8"]], []),
          tag(
            "meta",
            [
              ["name", "viewport"],
              ["content", "width=device-width, initial-scale=1"],
            ],
            [],
          ),
          tag("title", [], [words(`Evidence pack — ${pack.run.runId}`)]),
          stylesheet(),
        ],
      ),
      tag(
        "body",
        [],
        [
          tag("header", [], [tag("h1", [], [words("Evidence pack")]), identity(pack)]),
          tag(
            "main",
            [],
            [notes(pack), warnings(pack), tally(pack), clauseRows(pack), outside(pack)],
          ),
          // A label and a value, like every other fact on the page. A sentence
          // here would be the renderer saying something of its own about the
          // document, which is the one thing this module does not do.
          tag("footer", [], [tag("dl", [], [...said("Pack schema", pack.schemaVersion)])]),
        ],
      ),
    ],
  );
  return `<!doctype html>\n${page}\n`;
}

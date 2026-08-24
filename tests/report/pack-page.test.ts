/**
 * The document an auditor opens.
 *
 * Two questions, and neither of them is "does it look right".
 *
 * **Is it inert?** A rendered page is a new sink for text this tool did not
 * write: an operator wrote the identifiers, the platform under test chose the
 * header values, a consumer may have registered the catalogue, and the report
 * file itself may have come from another machine. So the assertions below feed a
 * `<script>`, an `onerror=`, a `</style>`, a `javascript:` URL and a U+2028
 * through every channel the page draws from, and then ask of the rendered bytes
 * what a browser would ask: which elements are in this document, and which
 * attributes. Not a blocklist of things that would be bad — the set of what is
 * *there*, compared against the closed unions `src/report/page.ts` declares. A
 * blocklist is a list of the attacks somebody thought of.
 *
 * **Does it out-claim the structure?** `a-claim-has-one-wording.test.ts` holds the
 * eleven sentences to one module and states plainly, in its own header and in
 * ADR-0067's `Limits`, that the largest thing it cannot see is a **paraphrase** —
 * a renderer printing `PASS` beside an `upheld` row says something the table
 * never said, and no scan of source text will notice. This file is the other half
 * of that: it reads the rendered document, subtracts every sentence the pack
 * carries, and asserts that what is left — the renderer's own vocabulary — holds
 * no verdict word at all.
 *
 * The fixtures are written by hand, per CLAUDE.md. The door is exercised once, at
 * the foot of the file, because four of the five injections travel through it and
 * the fifth is refused by it, and that difference is the argument for where the
 * escaping lives.
 *
 * See ADR-0068.
 */

import { describe, expect, it } from "vitest";
import { UnusableIdentifierError } from "../../src/core/identifiers.js";
import { StandardCatalog } from "../../src/core/standards/catalog.js";
import type {
  CitedClause,
  EvidencePack,
  PackableClauseRow,
  PackableRun,
  PackedRun,
} from "../../src/report/pack.js";
import {
  CLAIMS,
  DISCLAIMERS,
  evidencePack,
  STANDINGS,
  toPackableRun,
} from "../../src/report/pack.js";
import { renderPack, UnrenderableClaimError } from "../../src/report/page.js";

/** The five ways a document has been broken out of, one string each. */
const HOSTILE = {
  script: "<script>alert(1)</script>",
  handler: '" onerror="alert(1)',
  style: "</style><style>body{display:none}",
  scheme: "javascript:alert(1)",
  /** A line terminator to a JavaScript parser, which the report's door refuses. */
  separator: "a\u2028b",
  /**
   * A value that already looks escaped, which is the other direction entirely.
   *
   * An escaper that left `&` alone would render this back as live markup, and an
   * escaper that "recognised" the entity would be decoding on the way out. The
   * right answer is that `&` is a character like any other and comes back as
   * `&amp;amp;` — an operator who named an endpoint `A&B` sees `A&B` on the page,
   * and one who named it `&lt;b&gt;` sees exactly that.
   */
  entity: "&amp;<b>bold</b>",
} as const;

/**
 * A catalogue whose fields are hostile, and the channel that explains why.
 *
 * `StandardCatalog.register` refuses a blank field and nothing else, and ADR-0043
 * has a private standard registered at run time from a source outside this
 * repository — its numbering may not be published, so it cannot come from
 * `bundled.ts`. A title, a scope and a `url` therefore reach the renderer as
 * somebody else's text, having passed no door of the report's.
 */
function catalogOf(
  clauses: readonly { id: string; title: string; url: string }[],
): StandardCatalog {
  const catalog = new StandardCatalog();
  catalog.register({ id: "PRIVATE-1", scope: `The boundary of it ${HOSTILE.style}`, clauses });
  return catalog;
}

/** Two clauses with ordinary identifiers, for the tests that index rows by them. */
const PLAIN = (): StandardCatalog =>
  catalogOf([
    { id: "C1", title: `What it asks for ${HOSTILE.script}`, url: HOSTILE.scheme },
    { id: "C2", title: "And what this one asks for", url: "https://example.test/c2" },
  ]);

/** The same, with the hostile text moved into a clause identifier as well. */
const HOSTILE_IDS = (): StandardCatalog =>
  catalogOf([
    { id: "C1", title: `What it asks for ${HOSTILE.script}`, url: HOSTILE.scheme },
    { id: `C2${HOSTILE.handler}`, title: `And this one ${HOSTILE.separator}`, url: HOSTILE.scheme },
  ]);

function run(extra: Partial<PackableRun> = {}): PackableRun {
  return {
    runId: "0f5f2e5c-1b2a-4d2e-9a71-000000000001",
    configDigest: "1122334455667788",
    startedAt: "2026-08-25T10:00:00.000Z",
    finishedAt: "2026-08-25T10:04:00.000Z",
    tool: { name: "barbican", version: "0.6.0", documentation: "https://example.test/report.md" },
    target: { baseUrl: "http://127.0.0.1:8962", label: "a demonstration deployment" },
    verdict: { code: 0, reason: "no discrepancy with the declared policy" },
    surface: { endpointsTotal: 7, endpointsProbed: 6, cellsObserved: 144 },
    warnings: [],
    evidenceRowsOmitted: 0,
    clauses: [],
    findings: [],
    ...extra,
  };
}

function row(extra: Partial<PackableClauseRow> = {}): PackableClauseRow {
  return { standard: "PRIVATE-1", clause: "C1", checkIds: [], reservations: [], ...extra };
}

/** Every element the rendered document actually contains, by name. */
function elementsOf(page: string): readonly string[] {
  return [...page.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)[\s/>]/g)]
    .map((one) => (one[1] ?? "").toLowerCase())
    .filter((one, at, all) => all.indexOf(one) === at)
    .sort();
}

/**
 * Every attribute the rendered document actually contains, by name.
 *
 * An attribute is `name="`, with a real quote. That is what makes this readable
 * over a document full of hostile text: an identifier carrying `" onerror="` is
 * escaped to `&quot; onerror=&quot;`, which has no quote after the `=` and is
 * therefore not an attribute — which is precisely the fact under test.
 */
function attributesOf(page: string): readonly string[] {
  return [...page.matchAll(/\s([a-zA-Z-]+)="/g)]
    .map((one) => (one[1] ?? "").toLowerCase())
    .filter((one, at, all) => all.indexOf(one) === at)
    .sort();
}

/**
 * The document as a reader sees it, with the five entities undone.
 *
 * The inverse of the renderer's escaping rather than a second copy of it: a
 * helper here that escaped a sentence in order to look for it would be the second
 * implementation this repository keeps finding, and it would agree with the
 * renderer by construction. `&amp;` is undone last, so `&amp;lt;` reads back as
 * `&lt;` and not as `<`.
 */
function readAs(page: string): string {
  return page
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** The page minus every sentence the pack put in it: the renderer's own words. */
function rendererWords(page: string, pack: EvidencePack): string {
  let rest = readAs(page);
  for (const sentence of [...pack.notes, ...Object.values(CLAIMS)]) {
    rest = rest.split(sentence).join(" ");
  }
  return rest;
}

describe("a document drawn from a pack", () => {
  const pack = evidencePack({
    run: run({
      runId: `run ${HOSTILE.script}`,
      configDigest: `digest ${HOSTILE.handler}`,
      target: { baseUrl: `http://127.0.0.1${HOSTILE.style}`, label: `label ${HOSTILE.script}` },
      verdict: { code: 1, reason: `because ${HOSTILE.separator}` },
      warnings: [`a warning ${HOSTILE.script}`, `and one about ${HOSTILE.entity}`],
      evidenceRowsOmitted: 3,
      clauses: [
        row({
          matrixCells: {
            conclusive: 12,
            upheld: 11,
            breached: 1,
            inconclusive: { [`reason ${HOSTILE.script}`]: 3 },
          },
          checkIds: [`check ${HOSTILE.handler}`],
          reservations: [`reservation ${HOSTILE.style}`],
        }),
      ],
      findings: [
        {
          kind: "privilege-escalation",
          channel: "matrix",
          severity: "high",
          standards: [{ standard: `OUTSIDE ${HOSTILE.script}`, clause: `X ${HOSTILE.handler}` }],
          heldByAcceptance: false,
        },
      ],
    }),
    catalog: HOSTILE_IDS(),
  });
  const page = renderPack(pack);

  it("is one file, with nothing outside it to fetch", () => {
    expect(page.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(page.trimEnd().endsWith("</html>")).toBe(true);
    // The stylesheet is inline and is the only one. A second `<style` would mean
    // a value had reached the inside of the first.
    expect([...page.matchAll(/<style[\s>]/g)]).toHaveLength(1);
    expect([...page.matchAll(/<\/style>/g)]).toHaveLength(1);
    // Nothing in the document fetches anything.
    expect(page).not.toContain("@import");
    expect(page).not.toContain("url(");
    expect(page).not.toContain("//fonts.");
  });

  it("contains only the elements and the attributes the renderer declares", () => {
    // The closed unions in `src/report/page.ts`, read back off the artifact. A
    // document that grew an element or an attribute grew it here.
    expect(elementsOf(page)).toEqual([
      "body",
      "dd",
      "dl",
      "dt",
      "footer",
      "h1",
      "h2",
      "h3",
      "head",
      "header",
      "html",
      "li",
      "main",
      "meta",
      "p",
      "section",
      "span",
      "style",
      "title",
      "ul",
    ]);
    expect(attributesOf(page)).toEqual(["charset", "class", "content", "id", "lang", "name"]);
  });

  /**
   * The five injections, each asserted twice: the live form is absent, and the
   * escaped form is present. The second half is what stops this passing because
   * the renderer dropped the value on the floor.
   */
  it("holds none of the five live, and prints all five as text", () => {
    expect(page).not.toContain("<script");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    expect(page).not.toMatch(/\son[a-z]+="/i);
    expect(page).toContain("&quot; onerror=&quot;alert(1)");

    // `</style>` arrives from a target address, a reservation code and a scope,
    // and the document still holds exactly one closing tag — asserted above.
    expect(page).toContain("&lt;/style&gt;&lt;style&gt;body{display:none}");

    // The scheme is printed and is not a control: there is no `href` in the
    // document at all, so there is nothing for it to be the scheme of.
    expect(page).toContain("javascript:alert(1)");
    expect(page).not.toContain("href");
    expect(page).not.toContain("<a ");

    // U+2028 reaches the renderer through the catalogue and through a
    // consumer-built run — the two channels the report's door does not cover —
    // and `spellOut` is what makes it text.
    expect(page).not.toContain("\u2028");
    expect(page).toContain("a\\u2028b");
  });

  /**
   * The other direction: a value that already looks escaped.
   *
   * An escaper that left `&` alone renders `&amp;<b>` back as live markup, and
   * one that recognised the entity would be decoding on the way out. `&` is a
   * character like any other here, so it comes back doubled — and an operator who
   * named an endpoint `A&B` reads `A&B` on the page rather than an entity.
   */
  it("escapes an ampersand rather than reading one", () => {
    expect(page).toContain("and one about &amp;amp;&lt;b&gt;bold&lt;/b&gt;");
    expect(page).not.toContain("<b>");
    expect(readAs(page)).toContain("and one about &amp;<b>bold</b>");
  });

  it("says the same thing twice running", () => {
    expect(renderPack(pack)).toBe(page);
  });

  /** The two counts that only appear when the file admits to leaving rows out. */
  it("says when the evidence rows it counted are a floor", () => {
    expect(page).toContain("Evidence rows left out");
    expect(page).toContain("a floor, the file left evidence rows out");
  });
});

describe("what the document is allowed to say", () => {
  const pack = evidencePack({
    run: run({
      verdict: { code: 2, reason: "the walk was cut short" },
      target: { baseUrl: "http://127.0.0.1:8962" },
      clauses: [row({ matrixCells: { conclusive: 4, upheld: 4, breached: 0, inconclusive: {} } })],
    }),
    catalog: PLAIN(),
  });
  const page = renderPack(pack);

  it("carries every note the pack governs the document with", () => {
    const read = readAs(page);
    expect(pack.notes).toHaveLength(4);
    for (const note of pack.notes) {
      expect(read).toContain(note);
    }
    // Named as well as counted, so that a `notes` list which stopped carrying one
    // of them fails here rather than passing over the remaining three.
    expect(read).toContain(STANDINGS.withheld);
    expect(read).toContain(DISCLAIMERS.declaration);
    expect(read).toContain(DISCLAIMERS.blackBox);
    expect(read).toContain(DISCLAIMERS.catalogue);
  });

  it("prints the sentence of every claim it shows, out of the table", () => {
    const read = readAs(page);
    const shown = new Set(pack.clauses.map((one) => one.claim));
    expect(shown.size).toBeGreaterThan(0);
    for (const claim of shown) {
      expect(read).toContain(CLAIMS[claim]);
    }
  });

  /**
   * The paraphrase ADR-0067's `Limits` names as the biggest hole in the wording
   * gate, closed from the other end.
   *
   * A source scan cannot tell that `PASS` beside an `upheld` row is an assertion
   * the table never made. A reader of the rendered artifact can — so the pack's
   * own sentences are subtracted, and what is left is the vocabulary the renderer
   * contributed. `pass` is in that list although `CLAIMS.upheld` ends "before
   * reading this as a pass": the subtraction is what makes the word askable
   * about, and asserting it against the whole page would have been impossible.
   */
  it("uses no verdict word the pack does not carry", () => {
    const mine = rendererWords(page, pack).toLowerCase();
    for (const forbidden of [
      "pass",
      "fail",
      "compliant",
      "certified",
      "conformant",
      "no issues",
      "all clear",
      "secure",
      "score",
      "audit",
    ]) {
      expect(mine, `the renderer's own words carry "${forbidden}"`).not.toContain(forbidden);
    }
  });

  /**
   * Every claim of the vocabulary is named whatever the run reached.
   *
   * The count a reader most needs is how many clauses nothing answered for, and a
   * tally that listed only the statuses with something in them is a score with
   * the inconvenient half rounded off. That number is the whole of B-4.
   */
  it("names all six claims in the tally, whatever the run reached", () => {
    for (const claim of Object.keys(CLAIMS)) {
      expect(page).toContain(`${claim}</li>`);
    }
    // And one of them really did have nothing: a tally of six lines that were all
    // non-zero would not be testing the thing this exists for.
    expect(page).toContain("0 unanswered</li>");
  });
});

describe("a reservation", () => {
  /** One clause row of the rendered page, from its marker to the next one. */
  function rowAt(page: string, at: number): string {
    const start = page.indexOf(`id="clause-${at}"`);
    expect(start).toBeGreaterThan(-1);
    const next = page.indexOf(`id="clause-${at + 1}"`);
    return page.slice(start, next === -1 ? page.length : next);
  }

  /**
   * The defect the whole artifact is written against, asked of the document.
   *
   * B-4 was a run that probed two endpoints of eleven and printed "No privilege
   * escalation found" over the other nine. Nothing was missing from the file; the
   * number that mattered was not next to the claim. `clauseReservationsOf` exists
   * so that the qualification travels with the row, and a document that gathered
   * the qualifications into a footnote would have undone that in the last step.
   */
  it("is on the clause row it belongs to, and not in a footnote", () => {
    const pack = evidencePack({
      run: run({
        clauses: [
          row({
            clause: "C1",
            matrixCells: { conclusive: 9, upheld: 9, breached: 0, inconclusive: {} },
            reservations: ["endpoints-not-probed"],
          }),
          row({
            clause: "C2",
            matrixCells: { conclusive: 4, upheld: 4, breached: 0, inconclusive: {} },
            reservations: ["authentication-unproved"],
          }),
        ],
      }),
      catalog: PLAIN(),
    });
    const page = renderPack(pack);

    const first = rowAt(page, 0);
    const second = rowAt(page, 1);
    expect(first).toContain("PRIVATE-1 C1");
    expect(first).toContain("endpoints-not-probed");
    // Each row carries its own and only its own. A document that printed both
    // lists on both rows would satisfy "the reservation is on the row" and say
    // something false about each of them.
    expect(first).not.toContain("authentication-unproved");
    expect(second).toContain("authentication-unproved");
    expect(second).not.toContain("endpoints-not-probed");
    // And nowhere else in the document: a second home for a qualification is a
    // footnote by another name.
    expect([...page.matchAll(/endpoints-not-probed/g)]).toHaveLength(1);
  });

  /**
   * A code from another vintage travels too.
   *
   * `PackableClauseRow.reservations` deliberately does not check the vocabulary:
   * a qualification nobody recognises is still a qualification, and dropping one
   * is the single direction a pack must never move in. The renderer is the last
   * place that could quietly do it.
   */
  it("this build has never heard of is printed as it stands", () => {
    const pack = evidencePack({
      run: run({
        clauses: [
          row({
            matrixCells: { conclusive: 1, upheld: 1, breached: 0, inconclusive: {} },
            reservations: ["a-reason-from-2027"],
          }),
        ],
      }),
      catalog: PLAIN(),
    });

    expect(renderPack(pack)).toContain("a-reason-from-2027");
  });

  /**
   * An empty list prints nothing rather than "none recorded".
   *
   * `CitedClause.reservations` is empty in two different situations — a clause row
   * that recorded no qualification, and a clause with no row to read one off — and
   * the structure does not tell them apart. A document that printed "none" would
   * be choosing one of the two on the reader's behalf, which is the direction this
   * artifact must not move in. See ADR-0068.
   */
  it("that is absent is not rendered as an absence of reservations", () => {
    const page = renderPack(evidencePack({ run: run(), catalog: PLAIN() }));

    expect(page).toContain("unanswered");
    expect(page.toLowerCase()).not.toContain("none recorded");
    expect(page).not.toContain("Reservations");
  });
});

describe("the print rules", () => {
  /**
   * Declared, not measured — and this test says which.
   *
   * No browser runs in this repository's suite, so what is asserted here is that
   * the properties are in the document, in both the modern and the legacy
   * spelling, because the engines disagree about which they honour. Whether a
   * particular engine then keeps a clause row off a page boundary is not something
   * this file can answer, and ADR-0068 says so rather than implying otherwise.
   */
  it("are in the document, in both spellings", () => {
    const page = renderPack(evidencePack({ run: run(), catalog: PLAIN() }));

    expect(page).toContain("@media print");
    expect(page).toContain("@page");
    expect(page).toContain("break-inside: avoid");
    expect(page).toContain("page-break-inside: avoid");
    expect(page).toContain("break-after: avoid");
    expect(page).toContain("page-break-after: avoid");
    // Nothing dark behind anything dark: the print block puts black on white, and
    // there is no `prefers-color-scheme` rule to hold a second opinion.
    expect(page).toContain("background: #ffffff; color: #000000");
    expect(page).not.toContain("prefers-color-scheme");
  });
});

/**
 * A pack this build did not build.
 *
 * `EvidencePack` is a structure, not a construction: a pack read back out of a
 * `--json` file, or one written by a build whose vocabulary has since grown, is
 * one of these without `evidencePack` ever having run. `claim` is the field where
 * that matters, because it is the one the renderer looks a **sentence** up by.
 */
describe("a pack from somewhere else", () => {
  function packWith(claim: string): EvidencePack {
    const cited: CitedClause = {
      standard: "S",
      clause: "1",
      claim: claim as CitedClause["claim"],
      checkIds: [],
      evidence: { disagreements: 0, heldByAcceptance: 0, other: 0, lowerBound: false },
      reservations: [],
    };
    const source = run();
    const packed: PackedRun = {
      runId: source.runId,
      configDigest: source.configDigest,
      startedAt: source.startedAt,
      finishedAt: source.finishedAt,
      tool: source.tool,
      target: source.target,
      verdict: source.verdict,
      surface: source.surface,
      warnings: [],
      evidenceRowsOmitted: 0,
    };
    return {
      schemaVersion: "1",
      run: packed,
      standing: "evidence",
      notes: ["a note the pack carried"],
      clauses: [{ ...cited, title: "t", url: "u", scope: "s" }],
      outsideCatalogue: [],
    };
  }

  /**
   * A claim with no sentence is refused rather than printed bare.
   *
   * The alternative was a row carrying the word and nothing else, which hands a
   * third party a verdict with no statement of what it means — and the whole
   * argument of ADR-0067 is that the sentence *is* the decision. It is also the
   * shape the injection would have arrived in: `class="clause claim-…"` is the
   * one attribute value drawn from a field, so the refusal and the escaping cover
   * the same slot from two sides.
   */
  it("with a claim the vocabulary does not have is refused, naming the clause", () => {
    expect(() => renderPack(packWith('" onmouseover="alert(1)'))).toThrow(UnrenderableClaimError);
    expect(() => renderPack(packWith('" onmouseover="alert(1)'))).toThrow(
      /The clause S 1 carries the claim/,
    );
    // And the refusal does not carry what it is refusing onto the terminal it
    // exists to protect: a U+2028 in the claim is spelled out, not passed on.
    expect(() => renderPack(packWith(HOSTILE.separator))).toThrow(/"a\\u2028b"/);
  });

  /** A claim that is a property of every object is not a claim. */
  it("with a claim named after a prototype member is refused too", () => {
    expect(() => renderPack(packWith("constructor"))).toThrow(UnrenderableClaimError);
    expect(() => renderPack(packWith("toString"))).toThrow(UnrenderableClaimError);
  });

  /** And a pack whose claims are all in the vocabulary renders. */
  it("with a claim the vocabulary has is drawn as usual", () => {
    const page = renderPack(packWith("unanswered"));

    expect(page).toContain('class="clause claim-unanswered"');
    expect(attributesOf(page)).toEqual(["charset", "class", "content", "id", "lang", "name"]);
  });
});

/**
 * The door under the page, and the one injection that never gets past it.
 *
 * This is the argument for where the escaping lives, made as a measurement. Four
 * of the five hostile strings are *text* — a `<script>` and a `javascript:` are
 * ordinary characters to `identifier`, and the door has no business refusing an
 * endpoint somebody legitimately called `a<b` — so they travel through
 * `toPackableRun` and are the renderer's problem. U+2028 is not text, and the
 * door refuses it by name. Two grammars, one each, neither doing the other's job.
 */
describe("a saved report carrying all five", () => {
  function report(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: "2",
      runId: `run ${HOSTILE.script}`,
      configDigest: `digest ${HOSTILE.handler}`,
      startedAt: "2026-08-25T10:00:00.000Z",
      finishedAt: "2026-08-25T10:04:00.000Z",
      tool: { name: "barbican", version: "0.6.0", documentation: HOSTILE.scheme },
      target: { baseUrl: `http://127.0.0.1${HOSTILE.style}`, label: `label ${HOSTILE.script}` },
      verdict: { code: 1, reason: "one privilege escalation" },
      coverage: {
        endpointsTotal: 2,
        endpointsProbed: 2,
        cellsObserved: 4,
        clauses: [
          {
            standard: "PRIVATE-1",
            clause: "C1",
            checkIds: [],
            reservations: [`reservation ${HOSTILE.style}`],
          },
        ],
      },
      warnings: [],
      findingsOmitted: 0,
      findings: [],
      ...over,
    };
  }

  it("lets the four that are text through, and the page holds none of them live", () => {
    const page = renderPack(
      evidencePack({
        run: toPackableRun(report(), "hostile.json"),
        catalog: PLAIN(),
      }),
    );

    expect(page).not.toContain("<script");
    expect(page).not.toMatch(/\son[a-z]+="/i);
    expect(page).not.toContain("href");
    expect([...page.matchAll(/<\/style>/g)]).toHaveLength(1);
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("&quot; onerror=&quot;alert(1)");
    expect(page).toContain("&lt;/style&gt;&lt;style&gt;body{display:none}");
    expect(page).toContain("javascript:alert(1)");
  });

  it("refuses the fifth by name, before anything is rendered", () => {
    expect(() => toPackableRun(report({ runId: HOSTILE.separator }), "hostile.json")).toThrow(
      UnusableIdentifierError,
    );
    expect(() => toPackableRun(report({ runId: HOSTILE.separator }), "hostile.json")).toThrow(
      /runId in the report "hostile\.json" carries U\+2028/,
    );
  });
});

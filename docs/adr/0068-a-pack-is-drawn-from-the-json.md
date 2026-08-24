# 0068. A pack is drawn from the JSON, into one file that reaches nowhere

- **Status:** accepted
- **Date:** 2026-08-25

## Context

[ADR-0067](0067-an-evidence-pack-says-what-it-checked.md) built the structure of
an evidence pack and decided what it is allowed to say about a clause. It
deliberately rendered nothing and added no subcommand, and named both as this
track's:

```
barbican pack <report.json> --out <file.html> [--json <file.json>]
```

The architectural invariant that governs the rest is in `CLAUDE.md`: *JSON is the
single source of truth. HTML/PDF are rendered from JSON in a separate step, not
generated along the way as the checks run.* A pack is built from a saved report
after the run is over, and a document is drawn from the pack.

Three things about the document are not obvious and are the whole of this
decision: what it is made of, what it is allowed to say, and what it is allowed
to do.

## Decision

`renderPack(pack)` in `src/report/page.ts` returns one self-contained HTML
document as a string. Pure — no clock, no file system, no network, nothing from
the environment — so two renderings of one pack are byte for byte the same
document on every machine, which is [ADR-0036](0036-one-order-on-every-machine.md)'s
rule applied to the artifact a third party is handed. `src/cli/pack.ts` is the
subcommand above it and is short for the reason `src/cli/compare.ts` is short.

### Why HTML

Because of who opens it and on what.

- **A PDF is the deliverable and a browser is the printer.** An evidence pack
  ends up attached to something. Producing a PDF directly means a PDF writer,
  which means a dependency — and `CLAUDE.md`'s rule on those is vetting, which
  this is not the change to do. A browser's print dialogue is on every machine an
  auditor has, and it turns this file into the PDF without anything being
  installed.
- **Markdown was the real alternative** and is rejected on the same ground:
  rendering it is somebody else's renderer, chosen by the reader, with its own
  sanitiser and its own opinion about raw HTML in the source. The document would
  then be inert or not depending on which viewer opened it, which is not a
  property a security artifact may have.
- **A terminal rendering** — the shape `renderComparison` takes — answers a
  different question. `barbican diff` prints to a screen somebody is watching; a
  pack is handed to somebody who was not there, is read once, months later, and
  has to carry its own qualifications with it.
- **JSON was already available** and is still written, by `--json`. The document
  exists because `coverage.clauses` over sixteen catalogued clauses is not a
  thing a person reads.

### The page reaches nowhere, and nothing in it runs

A rendered document is a **new sink**, and a sink is where this project has been
bitten twice this week. So the page carries no script, no external stylesheet, no
font, no image — and no attribute a browser dereferences.

That last one is structural rather than a scan. `Element` and `Attribute` in
`src/report/page.ts` are closed unions; `script`, `iframe`, `link` and `object`
are not spellable as elements, and `href`, `src`, `style` and every `on…` are not
spellable as attributes. A link is therefore not something this renderer can
emit, which is why a `javascript:` URL in a clause's `url` is not a special case:
it is printed as text because there is no element that could make it anything
else.

**The address of a clause's published wording is printed rather than linked**,
and that is a real cost — an auditor with a network would have clicked it. It is
paid for two reasons. The pack's own catalogue may be one a consumer registered
from a private source (ADR-0043), so the tool is not in a position to vouch for
the string; and a scheme allowlist would be a fourth grammar in this repository
modelling somebody else's parser, which `CLAUDE.md` names as how the address
grammar was wrong the first time. `report.json` already prints every address as
text. This does the same.

The stylesheet is a module-private literal with nothing interpolated into it, so
`</style>` is unreachable from the outside: a value carrying that text goes
through the escaping seam into a text node and arrives as `&lt;/style&gt;`. It
has no `url(`, no `@import` and no `@font-face`, so there is nothing in it that
could fetch.

### Two escapings, composed and never merged

The task this decision was written against asked directly whether HTML escaping
belongs beside `spellOut` in `src/core/identifiers.ts`. It does not, and the
reason is not that they are similar enough to be confused — it is that they are
answers to different questions asked at different places.

`spellOut` is a decision about how a value is **kept**. Its output goes into
`report.json` and is what a person reads back out of the file (ADR-0066, note of
24 August 2026). Teaching it `&lt;` would put HTML entities into the report — a
lie about what the platform sent, in the artifact this project is most careful
about.

Markup escaping is a decision about a **sink**: which characters of a grammar the
tool itself writes must not be read as that grammar. It belongs where the
document is built.

They are composed, in that order, at one seam — `words()` — and neither is
rewritten. `spellOut` is imported, because a second spelling of "what is not text"
is precisely the twelfth point fix [ADR-0024](0024-strings-from-outside.md)
counts; `tests/invariants/one-decision-one-home.test.ts` carries the allowance for
that import with its reason. The two sets of characters do not overlap and neither
has to agree with the other. What *would* have had to agree is a second
control-character rule, and there is not one.

`spellOut` is applied even though the pack's own door already refuses every
character it rewrites, because **two of the renderer's inputs never went through
that door**: the catalogue, which ADR-0043 has a consumer registering at run time
from a source this repository never sees, and a `PackableRun` a consumer
assembled itself, which is a structural type and not a checked one. This is
measured rather than asserted — `tests/report/pack-page.test.ts` sends the same
U+2028 down both routes and through the door, and the door refuses it while the
other two arrive.

`words()` is the only way a dynamic string becomes markup. `Markup` is a brand,
following `HeaderValue` in `src/io/untrusted.ts`, so there is no "trust me"
constructor to reach for; attribute values take a raw string and are escaped by
`tag` itself, so a caller can neither double-encode one nor skip encoding it.

### The document does not out-claim the structure

Every sentence on the page that says anything about the platform or about the run
is `pack.notes` or `CLAIMS[row.claim]`, read out of the table. The rest of the
page is labels and numbers. `tests/invariants/a-claim-has-one-wording.test.ts`
holds the eleven sentences to one module, and both it and ADR-0067's `Limits`
state plainly that the largest thing that gate cannot see is a **paraphrase** — a
renderer printing `PASS` beside an `upheld` row says something the table never
said, and no scan of source text will notice.

`tests/report/pack-page.test.ts` is the other half of that, and it is the reason
this ADR can claim anything at all here. It renders a document, subtracts every
sentence the pack carries, and asserts that what is left — the vocabulary the
renderer contributed — contains none of `pass`, `fail`, `compliant`, `certified`,
`conformant`, `no issues`, `all clear`, `secure`, `score`, `audit`. The
subtraction is what makes `pass` askable about: `CLAIMS.upheld` itself ends
"before reading this as a pass", so the whole page could never have been asked.

Two consequences of that rule are worth naming because they look like omissions:

- **The reservations are on the clause row**, not in a footnote. That is the
  reason `clauseReservationsOf` exists at all — a qualification left behind in
  another section is one that did not travel with the claim, and B-4 was a claim
  that outran its own numbers.
- **An empty reservations list prints nothing, not "none recorded".**
  `CitedClause.reservations` is empty in two different situations — a clause row
  that recorded no qualification, and a clause with no row to read one off — and
  the structure does not tell them apart. A document that printed "none" would be
  choosing one of the two on the reader's behalf. See *A finding for the other
  track* below.

The tally at the top names **all six** claims whatever the run reached, in the
table's order, and nothing is summed or divided. ADR-0067 refused "a percentage, a
score, or a count of clauses passed"; a tally that listed only the statuses with
something in them would be a score with the inconvenient half rounded off, and
the line it would have dropped is *how many clauses nothing answered for*, which
is the whole of B-4.

### A claim with no sentence is refused

`UnrenderableClaimError` is the renderer's one decision and its only new error.
`ClaimStatus` is a closed union, so a TypeScript consumer cannot reach it without
a cast — but a pack read back out of a `--json` file, or one written by a build
whose vocabulary has since grown, is an `EvidencePack` by structure and not by
construction.

The two alternatives are worse. A row printed with a bare code and no sentence
hands a third party a word with no statement of what it means, when the sentence
*is* the decision ADR-0067 made. A row reworded into the nearest known claim is
this artifact's one forbidden direction. The pack's own door takes the same
position on a `schemaVersion` it cannot read.

The opposite treatment of an unrecognised **reservation** is deliberate and is
not an inconsistency: dropping a qualification strengthens a claim, so an
unknown one is carried through. An unknown claim *is* the claim.

### Printable, and which properties were reasoned about

The document is meant to become a PDF. `@page { margin: 18mm 16mm }`, a `@media
print` block that puts black on white at 10.5pt, `break-inside: avoid` on each
clause row and on the identity block, `break-after: avoid` on headings, and
`orphans`/`widows` of 3.

**No browser runs in this repository's test suite, so none of that is measured.**
What the test asserts is that the properties are in the document, in both the
modern and the legacy spelling (`break-inside` beside `page-break-inside`),
because the engines disagree about which they honour. Whether a given engine then
keeps a clause row off a page boundary is not something this repository can
answer today, and no document here says otherwise.

One light palette and no `prefers-color-scheme` block. Browsers print the light
rendering, a second palette is a second thing to keep level for a reader who will
not see it, and "no dark-on-dark" is then true by there being no dark at all.
Colour is never the only carrier of anything: the claim is a word on the row and
the tint beside it repeats that word, so the page says the same thing in
monochrome.

### The subcommand

As ADR-0067 specified it, with two decisions of its own.

`--out` is **required**. The alternative was letting `--json` stand alone, which
would make `barbican pack` produce two different kinds of thing depending on the
flags. The product of the subcommand is the document; `--json` is the structure it
was drawn from, written so that a reader can check the document against it rather
than take it on trust.

**Exit 2 when the standing is `withheld`**, which is ADR-0067's recommendation
taken rather than softened. A pack built from a run that exited 2 is a legitimate
thing to look at, and it says on its face that no clause in it is upheld — but a
CI job that publishes one as evidence with nobody noticing is defect B-4 with a
document wrapped around it, and the exit code is the only part of this a pipeline
reads. 0 when a pack was built; 2 when the report cannot be read; 64 for a
mistake on the command line, like every other subcommand.

Both artifacts are written by `writeDocumentFile`, which is `writeReportFile` with
a different source of chunks: the same `rm` then `wx` then rename then `chmod`,
the same 0600. A pack carries every address, the label of the deployment and the
identifiers of the accounts, exactly as the report does, and
[ADR-0058](0058-a-guarantee-holds-where-the-artifact-goes.md)'s rule is that a
guarantee holds where the artifact goes. The discipline moved into one private
function rather than being written a second time.

Nothing goes to stdout. A rendered page printed to a terminal is not a thing
anybody wants, so there is no stream for the summary to be mixed into and it goes
to stderr with everything else this tool says.

## What deliberately did not get in

**A pre-flight writability check on `--out`.** `assertReportPathIsWritable` exists
because a typo in `-r` cost a whole run's traffic against somebody else's
deployment. `barbican pack` sends nothing: a wrong `--out` costs a failed local
command. The check would be the shape of the rule without its reason.

**A table of contents, collapsible sections, sorting, filtering.** All of them
need script, and the page has none. A reader who wants to sort has `--json`.

**An embedded copy of `report.json`.** It would double the document, and it would
put a run's every observed address into a file that gets emailed. The pack is the
narrowing; `runId` and `configDigest` tie it back to the report.

**A logo, a font, a print header with a page number.** The first two are files to
fetch. The third is `@page` margin boxes, which are honoured unevenly and would be
a property claimed here without being measured.

**A scheme allowlist so the clause address could be a link.** Above.

**Rendering the pack's `schemaVersion` as a sentence.** It is a label and a value,
like everything else in the footer. A sentence there would be the renderer saying
something of its own about the document.

## Alternatives

**Put the renderer in `src/cli/`.** It is only the CLI that writes a file, so this
is a fair question. Rejected: the rendering is pure and takes the report layer's
own structure, and `src/cli/` is the layer that is deliberately thin. A consumer
holding a pack from the library wants the document without shelling out, which is
the same argument that puts `renderComparison` in `src/report/compare.ts`.

**Build the page with string templates instead of `tag`/`words`.** Shorter, and it
is how the defect arrives: a template is a place where a raw string can be
interpolated, and nothing in the type system objects. The brand plus the closed
attribute union means the *absence* of a link is checked by the compiler rather
than by a reviewer's eye.

**Escape only `&`, `<` and `>`.** The text-node rule, and correct for text nodes.
Rejected because the same function escapes attribute values, and a second, weaker
escaper for the second context is exactly how two rules that must agree stop
agreeing. Five characters, one function, both contexts.

**Sanitise rather than escape** — strip `<script>` and keep the rest. That is
modelling somebody else's parser, which is the mistake `CLAUDE.md` records twice
about the address grammar. Escaping does not need to know what a `<script>` is.

**Let the page carry the claim as a colour and drop the word.** Rejected on the
print requirement and on a plainer ground: a document whose meaning is in its
colours is a document that says nothing when photocopied.

**Emit XHTML, or validate the output against a parser.** A validator is a
dependency. What is asserted instead is the set of elements and attributes
actually present in the rendered bytes, compared against the closed unions the
renderer declares — which is the question a browser asks, without a parser to
install.

## Limits

The rule is [ADR-0065](0065-what-a-source-scan-can-hold.md)'s. Nothing in this
document, in the tests' headers or in `README.md` says any of the guards here
cannot be walked around.

**What the escaping does not do.** It is right for text nodes and for quoted
attribute values, and those are the only two contexts this renderer produces. It
would not be enough inside a `<script>`, inside a `style` attribute, inside a URL
attribute or inside an unquoted attribute — and the answer to all four is that
none of them exists here, held by `Element` and `Attribute` rather than by care.
A future element or attribute added to either union without reading this section
is where that stops being true, which is why the test asserts the sets rather than
a blocklist: adding one is a red test.

**What the element and attribute assertion does not see.** It reads the rendered
bytes of the packs those tests build. A branch of the renderer no fixture reaches
would emit whatever it likes; the coverage gate on `src/report/**` is what stands
against that, and it is a different guarantee.

**What the "no verdict word" assertion does not see.** It subtracts the pack's
sentences and looks for ten words. A paraphrase in different words — "this clause
is in order", a tick, a green square with no text — passes it. That is the same
hole ADR-0067 names, moved one step: the scan there could not see a paraphrase in
the source, and this one cannot see a paraphrase it has no word for. What stands
against it is that the page has one place a sentence can come from and a reviewer
who reads the rendered document.

**What the print assertions do not see.** Everything. They are declarations, and
the section above says so.

**Measured on 25 August 2026**, against the tree of this change, by a harness
that refuses a replacement which does not land the intended number of times —
shown refusing once, on a deliberately misspelt needle, before any of these were
trusted. Restoration was from a byte copy taken before the first edit. Each
mutation was applied alone and the **whole** suite run, 1918 tests over 124
files:

| mutation | what happened |
| --- | --- |
| `words` returns the value without `spellOut` | **caught**: 1 failed, 1 file |
| `words` returns the value without the markup escaping | **caught**: 5 failed, 1 file |
| `marked` no longer escapes `"` — attribute values only | **caught**: 3 failed, 1 file |
| the reservations no longer reach the clause row | **caught**: 3 failed, 2 files |
| an unknown claim printed bare instead of refused | **caught**: 2 failed, 1 file |
| `href` added to `Attribute`, the clause address emitted as a link | **caught**: 5 failed, 2 files |
| the tally prints only the claims with a count above zero | **caught**: 1 failed, 1 file |
| `writeArtifact` writes with `w`, mode 0644, and no `chmod` after | **caught**: 3 failed, 2 files |

One measurement worth keeping. The first spelling of the third mutation replaced
`case '"'` with `case "\u0000"`, and that failed
`tests/invariants/one-decision-one-home.test.ts` as well — the separator gate
catching a NUL written into a module that is not allowed to write one, in a
throwaway edit by a test harness. It was respelled with an ordinary character so
that the row above measures the escaping and not the gate next door. The figure
in the table is the second run.

## Consequences

The package gains two exported names — `renderPack` and `UnrenderableClaimError`
— and 238 becomes 240. `docs/library.md` states the count and
`tests/public-surface.test.ts` holds it; the error-class count in the same file
moves from 98 to 99.

`Markup`, `Element` and `Attribute` are deliberately **not** exported. `Markup` is
a brand whose entire value is that nothing outside the module can construct one,
and exporting the type would let a consumer write `"" as Markup` and splice a raw
string into a document with this tool's name on it.

`barbican` has a fourth subcommand. `src/cli.ts` registers it before the loop that
applies `exitOverride` to `program.commands`, which is the trap
`tests/invariants/cli-surface.test.ts` records: a subcommand registered after that
loop keeps commander's own `process.exit(1)` — this tool's "the platform
disagrees with the declared policy", reported for a forgotten flag. The four exit
codes of `pack` are asserted there, through a spawned process.

`readReport`'s message lost the clause "a comparison takes two paths". Two
subcommands read a saved report now, and that was a comparison's sentence in the
mouth of a function both of them call — the same defect ADR-0067 fixed one layer
in, on `UnreadableReportError`.

`REPORT_SCHEMA_VERSION` and `PACK_SCHEMA_VERSION` do not move. Nothing about
either artifact's shape changes here: this is a reader of the second one.

**Revisit when** a second output format is asked for. The split this change makes
— a pure `renderPack` over the pack, a thin subcommand over the file — is what
makes that a new module beside this one rather than a flag inside it. What must
not happen is a second renderer that writes its own version of the eleven
sentences.

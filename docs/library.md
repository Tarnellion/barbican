# Using barbican as a library

The package is a CLI and a library from the same build. This page says which of
the exported names are meant for a consumer, and what the rest are.

It exists because nothing said so. The package exported 266 names and the only
place any of them appeared was one example in the README — five of them — so a
consumer had no way to tell an entry point from a helper the CLI happens to share
with itself. Found by the audit of 14 August 2026 (E-6).

## The four entry points

Everything a consumer needs is reachable from these.

| Name | What it does |
|---|---|
| `parseRunConfig(source)` | validates a run configuration and returns a `RunConfig`. The only supported way in: it applies the size and depth limits and every check the CLI applies |
| `buildAccessMatrix({ endpoints, accounts, resources, observations })` | assembles the matrix from observations you collected however you like |
| `diffAccess(matrix, policy)` | compares the matrix against a resolved policy and returns the discrepancies |
| `buildReport(options)` | turns a walk into the report the CLI writes, verdict and summary included |

Two more you will need beside them:

- `expandPolicy(policy, endpoints)` turns the patterns in a declared policy into
  names. `diffAccess` takes the **resolved** policy, and a pattern matching
  nothing has to fail there rather than quietly stop applying.
- `configJsonSchema()` returns the JSON Schema an editor completes a
  configuration from. This is the supported way to get it — the zod schema that
  validates a run is deliberately **not** exported, so that a zod major is not a
  breaking change for you.

The example in the [README](../README.md) is compiled and run by a test, and it
uses four of these.

## Comparing two runs

`compareRuns(before, after)` takes two reports and returns what changed between
them: whether the declaration behind them moved, whether the second run looked
at less than the first, and which defects appeared, went or changed — joined on
`defects[].key`, because a difference in the number of finding **rows** is news
about the shape of a run and not about the platform. `renderComparison(result)`
turns that into the lines the CLI prints, each with a tone rather than a colour.
See [ADR-0050](adr/0050-a-comparison-is-of-defects-not-of-files.md) for what the
exit codes mean and why a truncated run can be compared but not believed.

Its input is a structural view that a `RunReport` already satisfies, so a walk
you drove yourself needs no conversion. A report that came back off disk is
JSON and is not one until something has checked it: `toComparableRun(value,
source)` is that check, and it throws `UnreadableReportError` naming the file.

## Building an evidence pack

`evidencePack({ run, catalog })` turns a saved run into the structure a document
about external standards is drawn from: one row per clause of the catalogue,
saying what this run did about it and — where it did nothing — saying that in a
way a reader cannot take for a pass. It is pure and renders nothing; JSON is the
source of truth and a document is a separate step.

`createBundledCatalog()` is the catalogue this repository ships — the
authorization chapter of OWASP ASVS 5.0, three entries of the API Top 10 and the
CWE-284 hierarchy. It is a fresh instance each time on purpose, so you can
register a standard of your own into it — that is what `StandardCatalog`'s own
`register` method is for: a standard whose numbering may not be published belongs
on the machine that holds it and not in a public repository. Whatever you
register gets rows like the rest.

The input is what came back off disk: `toPackableRun(value, source)` is the check,
and it throws the same `UnreadableReportError`, naming the field and the file.
A `RunReport` is deliberately **not** assignable to `PackableRun` — a file may
carry a severity or a reservation code this build has never heard of, and typing
those as the report's own unions would be a promise made by a cast.

Every sentence a pack prints comes out of `CLAIMS`, `STANDINGS` and
`DISCLAIMERS`. A row carries the code and you read the sentence from the table:
they are assertions the tool makes to somebody who was not there, and a second
copy of one is a second assertion the day it is improved. Read
[ADR-0067](adr/0067-an-evidence-pack-says-what-it-checked.md) before rendering
one — what a pack may claim, and what it refuses to, is the whole of that
decision.

## Drawing the document

`renderPack(pack)` returns one self-contained HTML document as a string: no
external stylesheet, no font, no image, no script, and no attribute a browser
dereferences — the address of a clause's published wording is printed as text,
because an auditor opens this with no network and the tool does not vouch for a
string it was handed. It is pure, so two renderings of one pack are the same
bytes on every machine, and it is the same document `barbican pack` writes.

Everything a page says comes out of the pack. The sentences are `notes` and
`CLAIMS`, read from the table; the rest is labels and numbers. It will not print
a claim it has no sentence for: a `claim` outside the vocabulary — a pack from a
later build, or one parsed back out of a `--json` file — raises
`UnrenderableClaimError` rather than putting a bare word in front of a third
party.

Write it yourself if you like, but write it the way this tool does: a pack
carries every address and every account identifier, so `barbican pack` writes it
0600 and through a rename. See
[ADR-0068](adr/0068-a-pack-is-drawn-from-the-json.md).

```ts
import { createBundledCatalog, evidencePack, renderPack, toPackableRun } from "barbican";

const saved = JSON.parse(await readFile("run.json", "utf8"));
const pack = evidencePack({
  run: toPackableRun(saved, "run.json"),
  catalog: createBundledCatalog(),
});
await writeFile("pack.html", renderPack(pack), { encoding: "utf8", mode: 0o600 });
```

## Running the walk yourself

`collectObservations` performs it: it takes the endpoints, the accounts, a
credential provider and an HTTP client, and honours the throttle and the
safe-method default. The adapters behind it are exported alongside their ports,
so an implementation of your own can be substituted:

- `createHttpClient`, `createThrottle`, `createCredentialProvider`
- `createOpenApiParser`, `createEndpointListParser`, `createPostmanCollectionParser`
- `createSignalExtractor` — response-body scalars, and nothing else reads a body
- `createTenantHierarchy`, `createIdenticalResponseCheck`, `CheckRegistry`
- `safeHeaders` — the checked constructor of the `HeaderValue` that
  `CredentialProvider.headersFor` returns. A provider that signs a request needs
  it ([ADR-0018](adr/0018-request-signing-is-a-port-concern.md)); an object
  literal does not type-check in its place, because the grammar for a string from
  outside applies to this door as well as to the CLI
  ([ADR-0024](adr/0024-strings-from-outside.md)). It was unreachable until
  21 August 2026, which made that whole promise false.
- `identifier` and `isUsableIdentifier` — the same rule for the strings this tool
  keys its own tables on: an endpoint id, an account id, a resource id, a context
  id, an accepted finding's `kind`, the id of a check you register. A control
  character in one of those glued two different rows into a single entry, because
  a key is a fixed number of parts joined by one. `joinKey` refuses such a part
  wherever a key is built, so a consumer that hands `Endpoint[]` or `Acceptance[]`
  straight to the core meets `UnusableIdentifierError` from the walk; call
  `identifier(value, "where it came from")` at the point you chose the value and
  the message names the line of your own document instead
  ([ADR-0066](adr/0066-an-identifier-has-a-grammar.md)).

Three of its options are about a walk that may not reach its end, and they are
what the CLI builds `--resume` out of ([ADR-0047](adr/0047-a-walk-that-survives-its-run.md)):
`record` is handed every cell the moment it is finished, `resumed` takes those
records back and skips the cells they cover, and `abort` stops the walk where it
stands and comes back `truncated: true`. A record that fits no cell of the matrix
is refused with `ResumeDoesNotFitError` before the first request.

The port interfaces are in `src/adapters/ports.ts` and exported by name.

## Standards a check can cite

`createBundledCatalog()` returns the clauses this repository carries as data:
part of OWASP ASVS 5.0 chapter V8, the three authorization entries of the OWASP
API Top 10 2023, and the access-control weaknesses under CWE-284. Each entry is
an identifier, one line of the project's own about what the clause is for, and
the address of the published text — never the requirement's own wording.

Three functions read it:

- `findUnresolvedStandardRefs(catalog, checks)` returns the references your
  checks declare that no catalogue entry answers to. A misspelt clause number
  otherwise reaches the report as a coverage row for a requirement that does not
  exist, and nothing downstream would ever notice.
- `clauseAnswers(catalog, checks)` returns one row per catalogued clause with
  everything in this tool that can cite it: the registered checks that declare
  it, and the kinds of matrix discrepancy whose mapping cites it. Both are
  derived — there is no field anywhere that declares a clause covered.
- `findUnansweredClauses(catalog, checks)` is those rows where both are empty —
  the half an evidence pack cannot be complete without, since a pack built from
  findings alone lists only what happened to be checked. Each row's
  `clause.unansweredBecause` says why nothing answers it. It replaced
  `findUncoveredClauses`, which asked about registered checks alone and so named
  four clauses as covered by nothing that the matrix channel cites on every run;
  see [ADR-0069](adr/0069-the-catalogue-says-what-is-unanswered.md).

A standard whose numbering may not be published goes in through
`StandardCatalog.register(definition)`, from a source outside this repository and
beside the private checks that cite it. All three then hold it to exactly the
same terms as the bundled three. See
[ADR-0043](adr/0043-a-catalogue-of-clauses.md).

`clauseCoverage({ cells, checksRun, reservations })` is the other direction, and
`report.coverage.clauses` is what a run puts there: one row per clause either
channel reached, carrying the cells that concluded, the cells that concluded
nothing by reason, and the reservations that stop "exercised" from meaning
"holds across the surface". `controlClausesForCell(relation)` is the rule it
shares with `standardsForDiff`. See
[ADR-0052](adr/0052-a-clause-can-be-reported-as-exercised.md).

## Saying whether a report is the file the run wrote

`report.contentDigest` is a sha256 over the report's canonical form with that
field taken out, and `checkContentDigest(parsedReport)` recomputes it: `ok` is
true only when the file carries a digest and the content gives that same digest.
`contentDigestOf(parsedReport)` is the value alone.

It catches a careless edit and not a deliberate one — anyone who can change a row
can recompute the digest. A signature is a separate decision and is not made; see
[ADR-0051](adr/0051-the-report-answers-for-itself.md).

**The digest is the last thing `buildReport` puts in the document, so anything
you write onto the report it returns is outside it** — the report then fails its
own check and nothing says so. Whatever belongs in the artifact goes in through
`BuildReportOptions`, `runId` included: pass the identifier if you minted one
before the walk, and one is minted for you if you did not. This is not
hypothetical advice — `{ ...built, runId }` in this tool's own CLI is what
invalidated the digest of every report it wrote until 23 August 2026. See
[ADR-0058](adr/0058-a-guarantee-holds-where-the-artifact-goes.md).

## What the rest of the surface is

The package exports 242 values and a comparable number of types. They fall into
three groups, and only the first is a contract:

1. **The names above**, plus the domain types they take and return — `Account`,
   `Endpoint`, `Resource`, `RunConfig`, `AccessObservation`, `AccessDiff`,
   `RunReport` and their neighbours.
2. **99 error classes.** These are public on purpose: catching an error and
   naming it is the only way to tell a configuration mistake from a network
   failure, and `instanceof` needs the class. They are grouped by the module that
   throws them.
3. **Everything else** — `assertPolicyIsSound`, `indexPolicy`, `relationOf`,
   `expandPattern` and some forty more. These exist because the CLI needs them
   and the CLI is built from the same modules. They are exported rather than
   hidden so that the build does not carry code no one can reach, which is the
   older of the two mistakes. **They are not a contract.** Use them if they help;
   they may change in any release while the version is `0.x`.

## What is deliberately not exported

- **The zod schema.** `configSchema` was exported until 17 August 2026, and that
  put 100 lines of `z.ZodObject<…>` into the published types — naming
  `z.core.$strip`, zod's internal namespace. A dependency inside a public type is
  a version of that dependency the package has promised to keep. Use
  `parseRunConfig` to validate and `configJsonSchema()` to obtain the schema. A
  CI step asserts that no shipped declaration imports from any package at all.
- **Anything that would let a body reach a report.** The `HttpResponse` port
  carries no body, `SignalValue` is a number or a boolean, and neither is an
  oversight; see [ADR-0011](adr/0011-response-body-signals.md).

## Stability

The version is `0.x` and the whole surface may change, including the four entry
points. What will not happen quietly: the report has a `schemaVersion`, and every
change to what the tool writes is recorded in an ADR under
[docs/adr/](adr/).

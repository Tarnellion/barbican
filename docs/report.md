# How to read the report

This document is written from the questions of a person who saw the report for
the first time with no explanation at all, not from the structure of the JSON.
He gave the report 2 out of 5 and refused to file tickets until he had settled
three things. Everything he asked is answered here — and what the report really
does not have yet is named honestly.

The ADR links point to GitHub rather than to a neighbouring file: this document
usually arrives attached to a report, without the rest of the repository. An ADR
is a short note about a non-obvious decision: context, decision, rejected
alternatives. No conclusion here requires following a link — the links are for
people who want to dispute a decision, not to understand the report.

## What actually happened

The tool probed **cells** and compared what it observed against what you declared.

A cell is **account × endpoint × resource × request conditions**. Endpoints
without path parameters have no resource, and that coordinate drops out;
conditions are usually absent entirely, and then a cell is the familiar triple.
So the number of probed cells is not "accounts × endpoints": it is larger.

```
Cells probed: 144 (matrix rows 27, of them accounts 9 and the same accounts
under contexts, endpoints 7, resources 6)
```

Seven endpoints and 144 cells rather than more, because one of the seven is a
write and a run without `--unsafe-methods` does not probe it — `skipped` says so.
That is the arithmetic to expect, and it is why the number of endpoints alone
never predicts the number of cells.

Every number quoted in this document comes from one run — the reference polygon
with all defects switched on, 13 August 2026. They illustrate the shape of the
output; yours will be different, and a difference is not a discrepancy.

**There are more matrix rows than accounts** when request conditions are
declared: one account gives a row per set of conditions. Count cells from
`accountRows`, not from `accounts` — otherwise the arithmetic will not add up.
`summary.accounts` is the only one of these counters that is **not** the length
of its array, which is worth knowing before you check it: 9 against 27 is the
conditions, not a bug.
Conditions have a section of their own below.

Every cell's response reduces to one of four outcomes:

| Response code | Outcome | Meaning |
|---|---|---|
| 2xx | `allowed` | access granted |
| 401, 403, 451 | `denied` | access refused |
| 404 | `not-found` | **not** a denial: the resource is absent, or it is being hidden |
| everything else | `error` | no conclusion can be drawn |

451 stands next to 401 and 403 not for the sake of completeness: "unavailable
for legal reasons" is a decision not to serve, not a failure and not a missing
resource. That is how geo and jurisdiction restrictions answer, and without this
row a healthy platform would give a wall of `probe-error` exactly where it
behaves correctly.

404 is set apart deliberately. Returning 404 instead of 403 is a legitimate
defensive move, but it is indistinguishable from "the resource does not exist",
and recording it as a successful denial would pass ignorance off as proof of
protection. For the same reason 3xx, 5xx and 400 land in `error`, not in `denied`.

## One list of findings

`findings` holds everything that was found, whatever the means of detection. The
`source` field says which one:

| `source` | Found by | What it carries |
|---|---|---|
| `matrix` | comparison against the declared policy | `expected`, `actual`, `relation` |
| `check` | a check from the registry | `title`, `evidence` |

Both carry `standards`: the clauses of external standards the row answers for.
A check declares its own; a matrix discrepancy gets them from `kind` and
`relation` — the cell says which control the row is evidence about, the kind says
what kind of evidence it is. Only `privilege-escalation` cites an OWASP API Top
10 entry and a CWE, because only it demonstrates broken authorization; an
unexpected denial, an unobserved cell and a failed probe cite the control they
contradict or leave unproved. Until 21 August 2026 the matrix rows carried
nothing here, so a traceability matrix built from a saved report covered one
registered check and none of privilege escalation or cross-tenant access. See
[ADR-0041](adr/0041-a-matrix-discrepancy-answers-for-a-clause.md).

### The array may be abridged; the counts are not

`findings` carries at most **50 rows per defect**, and `findingsOmitted` says how
many it left out — zero on nearly every run. So

```
findings.length + findingsOmitted === summary.findings
```

and it is `summary.findings` that answers "how much was found". Everything a
verdict rests on — the summary, every `defects` entry, the cell verdicts, the
exit code — is counted before the cap applies, so an abridged report carries the
same conclusion as an unabridged one. When rows are dropped, `warnings` says so.

That sentence was written before it was true. Until 17 August 2026 the exit code
was derived by filtering the rows, which are the capped ones, against a
denominator that is not — so 101 cells that all failed to answer exited **0**. The
counts the verdict is made of now travel in `summary.verdictInputs`, taken before
the cap and separated by source; if you recompute a verdict from a saved report,
that is the field to read.

The reason is that the isolation check compares accounts pairwise: one endpoint
returning the same response to 2 000 accounts is one defect and 1 999 000 rows,
which used to end the run in `RangeError: Invalid string length` at the moment of
writing the file — inside the default `--max-requests` budget. Rows past the
fiftieth are examples of something already counted. See
[ADR-0029](adr/0029-evidence-rows-have-a-budget.md).

Both share `kind`, `severity`, `accountId`, `endpointId` and `request`. For
matrix discrepancies `kind` is the kind of discrepancy (`privilege-escalation`
and others); for check findings it is the check's identifier.

**There used to be two lists, and that turned out to be an expensive mistake.**
The same cross-tenant leak landed in a different list depending on whether it
was visible by status or by body — that is, a difference in the **means of
detection** was passed off as a difference in the nature of the finding. The
cost: `bySeverity` counted only the first list and showed half the real number,
`byKind` did not count the second at all, and grouping by signature did not
extend to checks — six clones of one finding inflated the picture sixfold. Three
symptoms, one cause.

The practical consequence for the reader: **the most exploitable defect may well
carry `source: "check"`**. A list endpoint with no tenant filter answers 200 both
in a correct and in a leaky implementation; to make use of it you do not need to
guess identifiers — logging in is enough.

## Summary fields

| Field | What it means |
|---|---|
| `observations` | how many cells were probed |
| `findings` | finding rows — **not** the number of defects, and **not** always the length of the array: see the abridgement note below |
| `checkFindings` | how many findings were found by body rather than by status |
| `byKind` | by kind; the keys are kinds of discrepancy and check identifiers |
| `bySeverity` | by severity |
| `defectGroups` | distinct defect signatures — a lower bound, **with one exception**: two groups differing only by `contextId` are usually one breakage. See below |
| `defectsBySeverity` | the same by severity, but counting **defects**, not rows |
| `defects[].violations` | how many rows this defect produced — **not** "probes performed". For findings by body a row is a **pair of accounts**, not a cell |
| `accepted` | how many findings an `accepted:` declaration is holding out of the verdict, how many of those declarations have lapsed, and how many covered nothing. See below |
| `skipped` / `failures` | what was not probed and what failed, with reasons |

### Why "at least N defects"

One defect in the platform touches as many cells as there are. One missing
tenant filter gives ten rows; three BOLAs, seen by a user and by an
administrator, give six.

Rows collapse to the signature "endpoint × relation × conditions". Role is not
part of the signature: an endpoint open to a user and to an admin alike is one
defect, not two. Relation is part of it: BOLA inside a tenant and a cross-tenant
leak live on the same endpoint and break independently.

**It is a lower bound everywhere but one axis, and that is worth knowing before
the number is quoted.** Conditions are part of the signature on purpose — the
country check and the permission check are different mechanisms that break
independently — and the price is that a defect visible both with a declared
attribute and without it counts twice. The tool does not merge those, because
from the outside they may be two paths in the code; the section on conditions
below spells this out. So `defectGroups` is a floor against everything except a
defect seen under several sets of conditions, and the CLI's "at least N" carries
the same caveat.

**The kind of finding is not part of it, and was until 17 August 2026.** How a
defect was noticed is not what a defect is. An endpoint with no authorization on
it at all answers a request it should refuse *and* returns the same body to every
tenant, so it produced a `privilege-escalation` group and an
`identical-response-across-tenants` group — two entries for one missing check,
which is the one thing a lower bound may never be: larger than the truth. On the
reference platform this happened in 3 of the 29 combinations, taking 7 defects to
6 and 13 to 11. Each group now carries `kinds`, every way its cells were found to
be broken, so nothing is lost by the merge. See
[ADR-0030](adr/0030-a-defect-is-not-its-channel.md).

**The signature is also the defect's `key`, and it is what to cite.** The array
is ordered by severity, so "defect #5 from run X" points at something else a
month later — one fix upstream renumbers everything below it. The key does not
move: two runs of the same configuration against the same platform name the same
defect the same way, and a defect noticed a second way keeps the name it had.

```jsonc
"key": "orders.list any-resource baseline",
"kinds": ["identical-response-across-tenants", "privilege-escalation"]
```

The tool **does not know the exact number of defects and cannot know it**: two
different bugs with the same signature are indistinguishable from the outside.
The number of signatures is the lower bound, the number of rows the upper one.
Details and an example — [ADR-0015](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0015-defect-grouping.md).

### Severity

It is computed from the kind of discrepancy and the relation to the resource,
not declared:

| Discrepancy | Relation | Severity |
|---|---|---|
| `privilege-escalation` | `foreign-tenant` | critical |
| `privilege-escalation` | `ancestor-tenant`, `same-tenant`, `descendant-tenant`, no resource | high |
| `privilege-escalation` | `own` | medium |
| `unexpected-denial` | any | medium |
| `not-observed`, `probe-error` | — | low |

**Read `defectsBySeverity`, not `bySeverity`, when you answer the question "how
many problems do we have".** `bySeverity.critical: 10` is one missing filter that
touched ten cells. The same count over defects gives 1. Rows are for working
through, defects are for deciding.

Findings by body (`source: "check"`) have no `relation` field and do not fall
under the table above: the check itself assigns their severity. For the single
check that exists today it is `high`.

**A set of tenants on an account lowers the severity, and that is not a bug.** A
support account declared in `tenant-a` and `tenant-b` at once, reaching for a
resource of the second tenant, gets the relation `same-tenant`, not
`foreign-tenant` — and a finding on the same endpoint comes out `high` where a
single-tenant account would have made it `critical`. You declared the
membership; the tool compares behaviour against that declaration, not against a
guess about what the membership ought to be. If a set is declared wider than it
really is, the report weakens silently — there is nobody but you to check what
the sets contain.

`own` is lowered deliberately: an account's access to its own resource, declared
forbidden, is almost always a mistake in the policy, not a hole in the platform.
The reasoning — [ADR-0014](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0014-severity-and-exit-codes.md).

## Findings that are known and accepted

A finding can be declared known: it stays in the report, with everything a ticket
is filed from, and leaves the **verdict** until a date the operator named. That
is `accepted:` in the run configuration, and
[ADR-0048](adr/0048-a-finding-can-be-known-and-still-reported.md) is why it is
not a policy rule.

The short version: declaring the cell allowed removes the finding from the
artifact altogether — no row, no defect group, `match: true`, exit `0`, and
nothing anywhere recording that anybody knew. "Not found" and "found and
accepted" are the same file, and the second is exactly what an evidence pack has
to be able to show.

### What an accepted finding looks like in the file

The row is where it always was, at its own severity, with its request and its
clauses. It carries one field more:

```jsonc
{
  "kind": "privilege-escalation",
  "source": "matrix",
  "severity": "critical",
  "accountId": "carol-b",
  "endpointId": "orders.get",
  "resourceId": "order-a-1001",
  "relation": "foreign-tenant",
  "accepted": {
    "reason": "the order service has no tenant filter; PLAT-1234 replaces it",
    "until": "2026-11-30",
    "ticket": "PLAT-1234",
    "expired": false
  }
}
```

`expired: true` means the day has passed and **the row counts again** — it is
back in `summary.verdictInputs`, and it fails the run exactly as it did before.
The mark is kept rather than dropped, because a run that has just started failing
over something that was accepted until last week is explained by this field and
by nothing else in the file.

The defect group keeps its place in `defects` too, at its own severity, and
carries `acceptedKinds`: which of its `kinds` are currently held. A group where
that list covers `kinds` is a breakage the operator has signed for; a group where
it covers some of them is the same endpoint failing a second way, which nobody
has looked at yet.

### The declarations, and what each one did

Top-level `accepted[]` carries them in the order written:

```jsonc
{
  "defect": "orders.get foreign-tenant baseline",
  "kind": "privilege-escalation",
  "reason": "the order service has no tenant filter; PLAT-1234 replaces it",
  "until": "2026-11-30",
  "ticket": "PLAT-1234",
  "expired": false,
  "matched": 1
}
```

`defect` is the same string as `defects[].key`, built by the same function, so the
two line up by eye and a ticket quoting one quotes the other.

**`matched: 0` is the entry worth reading.** It means the declaration covered
nothing on this run, and there are two reasons for that: what it names is fixed —
in which case the line should be deleted — or the run never reached those cells,
in which case `coverage.notProbed` says why. The report cannot tell the two apart
and does not guess. It does not fail the run over it either: failing a build on a
fix is how a CI step gets deleted instead of a configuration line.

### The counters still add up

Nothing is subtracted from what was found. `summary.findings`, `byKind`,
`bySeverity`, `defectGroups`, `defectsBySeverity` and every `defects` entry count
accepted rows like any others, and the cell keeps `match: false` with its
`findingKinds`. One number changes, and it is the one the verdict reads:

```
summary.byKind[k] − summary.accepted.byKind[k] === summary.verdictInputs.matrixByKind[k]
```

for every matrix kind. `summary.accepted` holds four numbers beside that
breakdown:

| Field | What it means |
|---|---|
| `declared` | entries in the `accepted:` section |
| `findings` | rows currently held out of the verdict |
| `expired` | rows whose acceptance has lapsed — these are back in the verdict |
| `unused` | declarations that covered no finding on this run |

And the sentence beside the exit code says so out loud, because an exit code of
`0` over a critical row cannot explain itself:

```
Exit code 0: no discrepancy that fails a run — the rows above are notes, or
findings an acceptance holds out of the verdict; 3 findings are held out of this
verdict by an acceptance and are still in the report
```

### What cannot be accepted

`not-observed` and `probe-error`. Neither says anything about the platform — one
means no request covered the cell, the other that the request did not answer — so
accepting either would be accepting "we did not look". For probe errors it is
worse: half a matrix failing to answer is the exit code `2` that says the report
describes the state of the network, and that conclusion is not for sale from a
configuration file. Neither needs accepting anyway: `not-observed` is `low` and
fails no run, and `probe-error` fails one only at the threshold where the run is
telling the truth.

## The verdict and the warnings are in the file

```jsonc
"verdict": { "code": 1, "reason": "privilege escalation: 4 cells" },
"warnings": ["The target is unnamed: target has no label field. …"]
```

The report used to carry every input to the verdict and not the verdict, so a
reader who got the JSON — which is how it travels, attached to a ticket — had to
reimplement the arithmetic to learn whether the run passed. The console that had
the answer is gone by then. Both halves are here since 15 August 2026: the code
for a machine, the reason for a person.

`warnings` is the same idea for what is not a failure: things the numbers do not
say and the terminal said once. Only what is derivable from the report itself,
so the file and the console cannot disagree.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | tested, no discrepancies |
| 1 | tested, there are discrepancies |
| 2 | **the result cannot be trusted** |
| 64 | the command line was wrong; nothing was sent |
| 130 | interrupted from the keyboard part-way through the walk |

The last two are about the invocation, not about the platform. **64** is
`EX_USAGE`, and it is separate for one reason: until 15 August 2026 an unknown
flag exited 1, which is this table's "tested, there are discrepancies" — a typo
reported as a privilege escalation, in the one place where the exit code is the
whole interface. The line is drawn at the start of the run: what the argument
parser rejects is 64, and anything failing after that is 2. **130** is the
ordinary `128 + SIGINT`, and **143** is `128 + SIGTERM`, which is how CI kills a
job past its timeout. A run that ends either way stops the walk, writes the
report it has, and then re-raises the signal — so the status a pipeline reads is
still the signal's, and the report beside it says `truncated: true` and carries
the verdict `2` that goes with it ([ADR-0047](adr/0047-a-walk-that-survives-its-run.md)).
Until 21 August 2026 such a run wrote nothing at all.

A 2 outranks a 1: what was not tested is never clean. It is returned when any of
these holds:

| Reason | What it means |
|---|---|
| no observations at all | the source gave no endpoints, or every cell was skipped |
| `truncated: true` | the walk did not reach the end of the matrix: the request budget ran out, the circuit breaker tripped, or a signal stopped the run |
| an account got no access anywhere it was declared to have some | the credentials do not work, or the address is wrong |
| **an account with credentials has no canary that passed** | authentication is confirmed by nothing for that account, and `verdict.reason` names it. A policy made only of denials leaves the safety net above with nothing to say: nothing is declared accessible to such an account, so "no access anywhere" never triggers. Asked per account since 19 August 2026 ([ADR-0033](adr/0033-a-canary-is-per-account.md)) — until then one canary anywhere in the run answered for every account, and an account carrying a dead token was reported as tested and clean |
| **half or more of the requests failed** | the report describes the state of the network or the deployment, not the platform. Fewer failures are ordinary partial failures: they are visible in `failures` and in `byKind`, and they do not cancel the verdicts on the cells that survived |
| **credentials went stale during the walk** | an account's canary passed before the walk and failed after it, so every cell probed past that point recorded a refusal that says nothing about access. `staleCredentials` names the accounts. This row was missing from the table until 17 August 2026 — five reasons listed and six in the code, which is the shape of gap this document exists to close |

**A check finding fails the run at any severity but `info`**, which is the same
line the matrix channel has. Until 15 August 2026 it needed `high` or
`critical`, so the same disagreement between platform and declaration failed a
build when the status showed it and passed when the response body did. `info` is
what a check uses to say something without failing anybody's build.

An unexpected denial also gives **1**. The tool compares the declared intent
against observed behaviour, and a discrepancy is a discrepancy whichever way it
points. It cannot tell which side is wrong — the platform or your declaration —
and since it cannot, it has no right to stay silent.

## Comparing this report with an earlier one

**Do not `diff` two report files.** They differ almost everywhere and agree on
everything worth knowing: `runId`, `startedAt` and `finishedAt`, the `at` and
`durationMs` of every observation, and every `signals.digest` — the digest salt
is drawn afresh per run on purpose. Two runs of one matrix against one unchanged
platform produce two files a text diff calls entirely different.

```
barbican diff yesterday.json today.json
```

```
before: run d02be8cb-… started 2026-08-21T09:12:04.061Z against orders staging
after:  run 6f895b72-… started 2026-08-22T09:10:58.970Z against orders staging
The declaration is the same in both runs (configDigest 995214bfffe7fb1a), so
what follows is about the platform.
Coverage: 144 cells over 7 of 7 endpoints, unchanged.
Defects: 2 → 2 — 1 new, 1 gone, 0 changed, 1 unchanged.
New (1):
  reports.list any-resource baseline — privilege-escalation, critical, 4 cells
      the first run probed reports.list too, so this is new behaviour.
Gone (1):
  orders.list any-resource baseline — was privilege-escalation, critical, 2 cells
      the second run probed orders.list and found nothing there.
Run verdicts: 1 → 1.
Exit code 1: the two runs do not describe the same platform: 1 new, 1 gone
```

`--json` writes the same conclusion to stdout as a document, while the summary
above stays on stderr — so a redirect gives you JSON and not JSON with a
paragraph in front of it. Both come from one comparison; they cannot disagree.

Four things about how to read it.

**The declaration is the first line, and it governs the rest.** If
`configDigest` moved between the two runs, the comparison says so before it says
anything else: comparing findings across two declarations is legitimate and
often the point, but half the differences may then be your own edit rather than
the platform's doing. A changed digest does **not** by itself make the exit code
1 — two runs finding the same defects over the same surface describe a platform
in the same state, whatever you edited in between.

**The unit is the defect, not the finding row.** Rows are joined on
`defects[].key` — endpoint, relation, conditions — which is what that key was
made readable and stable for. A difference in the *number of rows* is news about
the shape of a run, not about the platform: one defect is fifty rows or one
depending on the evidence budget above and on how wide your matrix is, and
`violations` moves the moment you add an account. So `violations`, `accountIds`
and `resourceIds` are printed and compared by nothing. A defect counts as
**changed** along three axes only: its set of `kinds`, its `severity`, and
whether an `accepted:` declaration now holds it out of the verdict — that last
one because a defect somebody signed for looks, to the exit code and to every
counter beside it, exactly like a defect that was fixed.

**A defect that is gone is not necessarily fixed.** It is absent from the second
report both when the platform was repaired and when nothing went looking, and
the two are identical in `defects`. Every disappearance therefore carries the
answer to one question — did the second run probe that endpoint at all, judged
from `observations[].endpointId`, which is what a run really asked about rather
than what it was handed:

```
Coverage shrank: 144 cells over 7 of 7 endpoints → 12 cells over 1 of 7 endpoints.
  no longer probed: invoices.list, orders.list, payouts.list, reports.list, users.list
  endpoints skipped as "excluded": 0 → 5
A defect gone from a run that did not go looking for it was not fixed. Read the
disappearances below against this line.
```

The mirror holds too: a new defect on an endpoint the *first* run never probed
may be newly covered surface rather than newly broken behaviour, and it says so.

**A difference in coverage is a difference.** Coverage that grew is news and
exits 1. Coverage that shrank exits **2**, because every disappearance under it
is unexplained — a run that looked at twelve cells where yesterday's looked at a
hundred and forty-four fixed nothing.

### What the comparison exits with

| Code | Meaning |
|---|---|
| 0 | the same defects, over the same surface |
| 1 | the two runs do not describe the same platform: a defect appeared, went or changed, or the surface probed is not the same |
| 2 | **this comparison cannot be trusted** |
| 64 | the command line was wrong; nothing was read |

`2` outranks `1` for the reason it does above: what was not tested is never
clean. Six ways to get it, and they divide in two. These stop the comparison
before it starts, and nothing below the declaration line is printed:

| Reason | What it means |
|---|---|
| different `schemaVersion`s | the fields do not line up — `coverage.bodyComparison` became `coverage.byCheck`, `checksRun` changed what its entries hold — so a field-by-field reading would compare things that are not the same thing |
| a `schemaVersion` this build does not read | the two files agree with each other and not with anything here, and a comparison that guessed would answer confidently about fields it never read |

And these let it run and print in full, because you still want to see it:

| Reason | What it means |
|---|---|
| the same `runId` in both files | a report compared with itself. Every difference is zero by construction, which is indistinguishable from a quiet week — and it is the most expensive false clean this subcommand can produce |
| either run is `truncated` | that run never reached the end of its matrix, so the comparison is honest only as "here is what was looked at". Deliberately compared rather than refused: refusing would hide the half that *was* walked from the operator whose CI job was killed on its timeout |
| either run's own verdict was `2` | a comparison cannot be steadier than the runs it is made of |
| coverage shrank | above |

**64 is what the argument parser rejects, and nothing else** — the same line this
document draws for `run`. A path that is not there, a file that is not JSON and a
document that is not a report are all **2**: conclusions the tool refuses to
draw, not mistakes in the invocation.

See [ADR-0050](adr/0050-a-comparison-is-of-defects-not-of-files.md).

## How to tell "clean" from "nothing was tested"

This is the main question to ask of any report like this, and there is something
in it to stand on.

**Canaries.** `canaries` lists by name which account confirmed authentication on
which endpoint. If `authenticated: false`, the run stops before any observations
are collected: a 401 reads as a denial, a denial agrees with the expectation
wherever access is not meant to be granted, and the report would come out
spotless having tested nothing. An empty list means no canaries were declared;
then "clean" rests on nothing.

**`byKind["not-observed"]`.** A cell the policy declared but which could not be
observed. A non-zero value is a hole in coverage.

**`byKind["unexpected-denial"]` with observations that are not empty.** Indirect
but strong evidence: if the tokens had gone stale, cells expected to be allowed
would have given unexpected denials, and a zero here would be impossible.

**`truncated`.** The run was cut short: the ceiling on requests was used up, the
circuit breaker tripped, or a signal stopped the walk. The tail of the matrix was
not tested, and there are no findings there precisely because it was never
reached.

The field does not say **which** of the three it was, and that is deliberate: the
shape of this file is compared byte for byte by the polygon's oracle, so a field
was not added for it. The terminal that ran the walk says which, and so does the
stream beside the report — see "A run that was interrupted" in the
[guide](guide.md). What matters for reading the report is the same either way:
nothing follows from the absence of findings in the part that was never walked.

`barbican diff` treats a truncated run on either side as a reason to exit 2
while still printing the whole comparison, for exactly this: what is missing
from such a run is missing from the walk, not from the platform. See "Comparing
this report with an earlier one" above.

## How to tell a broken platform from a misread one

The mirror of the question above, and the one worth asking **before** you forward
a report full of findings. There is a way for every cell to be wrong at once, and
it does not look like an error.

barbican decides whether access was granted from the **status code alone**. A
platform that answers `200 OK` and puts the outcome in the body —
`{"success": false, "error": {"code": "FORBIDDEN"}}` — reads as "allowed"
everywhere. Every cell the policy declared `denied` then becomes a
`privilege-escalation` finding, and the report describes a catastrophe that is
not there.

Two things in the report say it, and neither of them is a field of its own:

- **`coverage.outcomes.denied` is `0`.** The signature, in one field. Not one
  request in the whole run was refused — which is either a platform where nothing
  is protected or one that refuses with 200. The tool says this on stderr too,
  before you get as far as reading the findings; it does not turn it into an exit
  code, because a genuinely wide-open platform is the worst finding there is and
  hiding it behind "cannot be trusted" would be the opposite mistake.
- **`byKind["privilege-escalation"]` is roughly the number of cells your policy
  denies.** A real platform fails in places. One that fails everywhere, in the
  same direction, on every account including the anonymous one, is more likely
  being misread than uniformly broken.
- **Open one cell you are certain about** — an ordinary account against an admin
  endpoint — and read it. A `200` where a `403` was expected settles it in one
  look. Nothing in the report can do this for you: from status codes alone the
  two readings are the same picture.

If that is your platform, **no** part of this report can be believed, and there
is no flag that fixes it. Not the matrix, and not the body checks either — the
natural guess is that comparing digests is safe from a status-code problem, and
it is wrong: those checks run only on cells that came back `allowed`, which here
is all of them, and two accounts both **refused** get the same envelope and the
same digest. On a six-cell demo platform of this kind the report came out with
four privilege escalations — every cell the policy denies — and one
`identical-response-across-tenants` that is two refusals, not a shared record.

See `docs/guide.md`, "A platform that refuses with 200".

## The statuses this tool cannot read

The section above is the loud failure: every cell wrong, findings everywhere,
exit code 1. This is the quiet one — cells missing from the verdict, and a run
that ends in `0`.

A conclusion about access is drawn from `2xx`, from `401`, `403` and `451`, and
from `404` and `410`. Everything else is `outcome: "error"` and a `probe-error`
finding: low severity, outside the exit code, and while fewer than half the
cells are one, the verdict stays `0`.

**Where to look.** `coverage.outcomes.error` against `summary.observations`, and
then `failures[]`, which carries a row for every cell whose status was not read —
the status, and why nothing follows from it. A run with a healthy
`denied` count and a large `error` count is the shape to be suspicious of: some
part of the surface is answering in a way the tool discarded.

Four classes end up there, and each can hide a real refusal:

- **A refusal that redirects.** An operator console on a session cookie refuses
  with `302 Location: /login`, not with `403`. Redirects are not followed, so
  every denied cell of that surface is a `probe-error`. `nothingRefused` will not
  catch it in a mixed run: that warning needs `coverage.outcomes.denied` to be
  `0` across the *whole* run, and an API answering `401` alongside satisfies it.
  Read such rows as refusals the run did not count.
- **An outcome that is not final.** `202 Accepted` is read as access granted.
  Where the platform queues the request and refuses it in a worker, the cell
  becomes a `privilege-escalation` finding over a refusal that arrives later.
  A `privilege-escalation` on an asynchronous write endpoint is worth opening by
  hand before it goes into a ticket.
- **A delete that only hides the object.** Soft delete makes `404` and `410`
  answer everyone alike, and the diff folds both into a refusal — so the cell
  reads as protected when it is merely empty. `coverage.resourcesNotFound` is the
  field: a resource missing for every account is usually a tombstone rather than
  authorization.
- **An answer about the endpoint rather than the account.** `405` says the
  endpoint does not offer that method. A wall of them means the endpoint list and
  the platform disagree, not that anyone was refused.

None of the four has a flag. Each needs the operator to declare something the
tool may not derive from the system under test, and there is no such declaration
yet — see `docs/guide.md`, "The statuses this tool cannot read".

## One probe per cell

Every row in this file is **one request, asked once**. There is no second pass:
a finding is not re-probed to see whether it holds, and a cell that agreed is not
re-probed either. Nothing in the report distinguishes a result that was seen
twice from one that was seen once, because no result in it was ever seen twice.

The tool does repeat a request, and it is worth knowing which repeats those are,
so the sentence above is not read as "the tool never asks again". The retry loop
fires on `429`, on `5xx` and on a request that failed on the wire — conditions
about the transport, chosen because they say the answer never arrived. An
**unexpected outcome is not one of them.** A `200` where the policy said `denied`
is a finding, and a finding is what the run is for; asking again would be the
tool deciding which of two answers it prefers.

**A single `200` is enough for a `critical`.** Any one of these produces one, on
a platform whose isolation is intact:

- a stale replica behind a cache, answering from the state before a permission
  was revoked;
- a permissions rollout part-way through the fleet, where one node has the new
  rule and another does not;
- an A/B branch, a feature flag or a canary deployment, where the account landed
  on the arm that has not been fixed.

The row that comes out of that is `privilege-escalation`, `foreign-tenant`,
severity `critical` — indistinguishable, in the file, from the same row produced
by a hole that is always open. Before a finding of that weight leaves for a
ticket, ask for it again by hand, with the `request` line the finding carries.
That is a repeat the tool cannot make for you.

**And the other direction is quieter, which makes it the more expensive one.** A
single `403` off the node that *does* have the rule settles the cell as agreed:
`match: true`, no finding, and one more towards `coverage.cellsMatched`. That
counter reads "tested and agreed", and on such a cell what it means is "asked
once, and once it was refused". A hole open on two nodes out of three is a coin
this run tossed a single time.

There is no way to say any of this in the file — no `confirmed` field, no count
of probes per cell — because there is nothing to put in one. Read
`cellsMatched`, and every `match: true` under it, as a single sample. See
`docs/guide.md`, "One probe per cell", for the same boundary before a run rather
than after it.

## What was tested and what was not

The `coverage` section answers the question without which the numbers above mean
nothing. The numbers in this example come from one particular run — the reference
polygon under its `all-nine` variant, which switches on nine of that platform's
twelve defects, 15 August 2026 — and they are here to
show the shape of the section, not to be compared with yours. Your run will
differ in every one of them:

```jsonc
"coverage": {
  "endpointsTotal": 7,          // how many the source gave
  "endpointsProbed": 6,         // how many were actually probed
  "cellsObserved": 144,
  "cellsMatched": 74,           // observed, and nothing was found on them
  "cellsWithFindings": 70,      // observed, and something was
  "cellsNotObserved": 0,        // declared by the policy, but not observed
  "notProbed": { "unsafe-method": 1 },   // why an endpoint was not probed, by reason
  "bodiesComparedOn": ["orders.list"],    // where bodies were compared
  "writeMethodsProbed": false,
  "checksRun": [
    {
      "id": "identical-response-across-tenants",
      "description": "The response digest matched for accounts from different tenants on an endpoint whose response was declared to differ between them: the sign of a missing tenant filter",
      "standards": [                      // which clauses this check answers for
        { "standard": "OWASP-API-2023", "clause": "API1" },
        { "standard": "OWASP-ASVS-5.0", "clause": "8.4.1" },
        { "standard": "CWE", "clause": "285" }
      ]
    }
  ],
  "clauses": [                            // what this run did about each clause
    {
      "standard": "OWASP-ASVS-5.0",
      "clause": "8.1.1",                  // every cell cites it, so this row is the whole matrix
      "checkIds": [],
      "matrixCells": {
        "conclusive": 144,                // cells that gave an answer this tool can read
        "upheld": 74,                     //   the declaration and the platform agreed
        "breached": 70,                   //   they did not
        "inconclusive": {                 // cells the clause reaches and nothing was learned from
          "not-observed": 0,
          "probe-error": 0
        }
      },
      "reservations": ["endpoints-not-probed"]   // one endpoint of the seven was never asked
    },
    {
      "standard": "CWE",
      "clause": "285",
      "checkIds": ["identical-response-across-tenants"],   // reached by a check and not by the matrix
      "reservations": ["endpoints-not-probed"]             // no matrixCells: see below
    }
    // …and one row like the first for each of 8.2.1, 8.2.2 and 8.4.1.
  ],
  "byCheck": [                            // what each check examined, in its own terms
    {
      "checkId": "identical-response-across-tenants",
      "endpointId": "orders.list",
      "counters": {
        "comparedPairs": 24,                // and how those 24 came out:
        "matchedPairs": 12,                 //   the digests matched — one finding each
        "differedPairs": 12,                //   the digests differed (see the boundary below)
        "skippedBothEmptyPairs": 0,         // every declared count zero on both sides
        "pairsWithoutDigest": 0,            // body over the ceiling, or a scope that was absent
        "emptinessSignalsDeclared": 1,      // 0 would mean empty and full are indistinguishable here
        "skippedRelatedPairs": 39,          // shared tenant or kinship in the tree
        "skippedDifferentContextPairs": 147 // different conditions — cannot compare
      }
    }
  ],
  "contextsProbed": { "geo-blocked": 45, "wide-scope": 9 }
}
```

**`cellsMatched` is "tested and agreed".** It used to be something you had to get
by subtraction, and "it is clean here" existed in the report only as the reader's
own arithmetic. As a number it is checkable:

    cellsMatched + cellsWithFindings === cellsObserved

If that does not hold, the report is lying. **Note that the second term is not
`summary.findings`:** that counts rows, and one cell can produce several of them
at once — a discrepancy over the status code and a body one on the same cell are
two findings and one cell. This document offered the sum over
`summary.findings` until 15 August 2026, and on the run above it gave 156 against
144 observed.

**`bodiesComparedOn` matters more than it looks.** On every other endpoint the
absence of a finding means "no comparison was made", not "nothing matched".
Without this list you cannot see the difference.

It names endpoints that were **declared and probed**, not merely declared. Until
15 August 2026 it was filtered out of every endpoint the source gave, so one
carrying `responseMustDifferByTenant` and then excluded — or skipped as an unsafe
method — was named here as compared, which is this field lying in the one
direction it exists to prevent. Being on the list means the question was asked;
how many pairs it was asked of is `byCheck`.

**`checksRun` lists the checks that ran, including the ones that found nothing.**
Without it, a check that someone forgot to register, or that crashed, would give
a report indistinguishable from a clean one: its key shows up in `byKind` only
once it has found something. Since `--checks` exists, it also says which ones the
operator left out — a check left out is coverage left out.

**Each entry names the clauses that check answers for**, and so does every
finding it produced. Both directions are needed and both are here: from a finding
to a clause, and from a clause to what exercised it at all — including a check
that found nothing, which is the whole difference between an evidence pack and a
list of findings. Until 15 August 2026 `Check.standards` was declared, filled and
read by no line of code: the word did not occur in a report, so neither direction
could be built from a saved artifact.

**Of the matrix channel only the first direction was here** until 22 August
2026. Its findings cite clauses and there is still no `checksRun` entry for it —
`checksRun` is the list of registered checks, and the matrix channel is not one
(ADR-0041 says why, and what has to move before it becomes one). So a clause the
matrix exercised on nine hundred cells that all agreed with the policy appeared
in this section only if one of them did not.

`coverage.clauses` below is the other direction for both channels at once. Read
it rather than `checksRun` when the question is "what did this run do about
8.2.2"; read `checksRun` when the question is "which checks ran".

**And each entry says what the check asserts, in words.** `description` was in
exactly the same state until 17 August 2026, and was answered the same way. An
identifier and a clause number are two labels; "identical-response-across-tenants
covers ASVS 8.4.1" is not a sentence anyone can audit. The reader of a saved
report is the person who has the report and not `src/core/checks/`, which is the
only reason the field exists at all. Reports written before that date have no
`description` on these entries; `schemaVersion` stays `2`, because a reader
written against `2` is not broken by a field appearing.

### `clauses` — what the run did about each clause, and what it could not

One row per clause either channel reached. `checkIds` names the registered
checks that answer for it and ran; `matrixCells` is what the matrix channel
reached. A clause both reach is one row with both halves.

**There is no percentage here, on purpose.** A percentage hides its denominator,
and the denominator is the entire question. So a row carries the cells that
concluded and the cells that concluded nothing side by side:

    conclusive + every value of inconclusive === the clause's whole reach

and

    upheld + breached === conclusive

`conclusive` is the number "exercised" means: cells where a request was made, an
answer came back, and the tool could read it. `upheld` is the same "tested and
agreed" the rest of this document uses — narrowed by the checks, so a cell the
walk agreed with and a body check objected to is not in it. For **8.1.1**, which
every cell cites, `upheld` is `cellsMatched`; that is the arithmetic to check
this section against the rest of the file by.

**`inconclusive` is where the honest half of the answer is.** `not-observed` is a
cell the policy declared and no request reached. `probe-error` is a request that
failed — a cell with no answer in it. Neither is evidence about anything, and
neither is counted as an exercise of the clause. Both keys are always present: a
missing key would be read as a zero by whoever thought to look for it.

**`reservations` say why "exercised" is not "holds across the surface."** Four
codes, and each one is elsewhere in this report as well — they are repeated on
every row because a row is what gets copied out of here and into a document about
one requirement, and a qualification left behind in another section is one that
did not travel with the claim.

| Code | What it means | Where the detail is |
|---|---|---|
| `authentication-unproved` | some account's credentials were never proved: no canary passed for it, its token went stale, the second confirmation never happened, or it was granted access nowhere. A refusal recorded under such an account says what an unauthenticated request says, so a cell that "upheld" a denial upheld nothing | `canaries`, `staleCredentials`, `unverifiedAfterWalk`, `unauthenticated`, `verdict.reason` |
| `endpoints-not-probed` | fewer endpoints were probed than the source gave. The clause was not asked there at all — and a skipped path template is the object half of the surface | `endpointsTotal`, `endpointsProbed`, `notProbed` |
| `no-refusal-observed` | not one observation came back denied. Either the platform grants everything or it refuses with `200` and the outcome in the body; from status codes alone the two are one picture | `outcomes` |
| `run-truncated` | the walk was cut short, so the tail of the matrix was never reached | `truncated`, `verdict` |

**Three things this section deliberately does not say**, because each would be a
claim it cannot support:

- **A row with no `matrixCells` has no cell numbers, and none are invented.**
  That is a clause a check reached and the matrix did not: what the check
  examined is `byCheck`, in the check's own counters.
- **API1, API5 and CWE-285 never carry `matrixCells`.** A clean cell shows that a
  control was exercised; it does not show that the tool went looking for a class
  of weakness and failed to find it. Those clauses keep the other direction —
  findings cite them — and appear here when a check does.
- **A clause nothing in this run touched is not here.** This section is about
  what a run reached. "Which catalogued clauses does nothing cover" is a
  different question, answered against a catalogue by
  `findUncoveredClauses`, and it is not in the report.

A run that computed no cell verdicts has no `matrixCells` on any row — the same
silence `cellsMatched` keeps, and for the same reason: a zero would be a claim
about the platform where what has to be said is "we did not count this".

See [ADR-0052](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0052-a-clause-can-be-reported-as-exercised.md).

**`skippedDifferentContextPairs` — pairs under different conditions.** They are
not compared on purpose: in such a pair the tenant and the context attributes
differ at once, and equal digests would say nothing about either. What the check
asserts is "different tenants get different responses **all else being equal**".

**`byCheck` answers the question "was this pair compared at all".** It was
`bodyComparison` before 15 August 2026 — one check's shape, with the report
layer importing its type from that check's module. A check now reports its own
reach and the report carries the counters without knowing what they mean, which
is what "checks are plugins" has to mean if it means anything. The counters below
are that check's; another check names its own.
`bodiesComparedOn` names the endpoint but stays silent about a particular pair of
accounts, and that silence reads as "nothing matched". Yet not every pair is
compared: accounts of the same tenant are skipped (a match between them is
legitimate), and accounts related in the tree — parent and descendant — are
skipped in the same way, because a holding is supposed to see its descendant's
data. On the run above, 24 pairs out of 210 were compared, 39 were skipped as
related and 147 because the conditions differed; without these numbers "there are
no findings on the pair" and "the pair was not compared" are indistinguishable.

This paragraph read "8 pairs out of 21 were compared and 13 were skipped as
related" until 16 August 2026, while the `byCheck` block thirty lines above
already said 24, 39 and 147 — the same document disagreeing with itself about the
same run. The old figures were not invented: 8 + 13 = 21 is every pair among the
seven comparable rows this endpoint had before request conditions existed. With
conditions there are twenty-one rows and 210 pairs, and most of them are pairs
the check refuses to draw a conclusion from.

**`comparedPairs` splits into `matchedPairs` and `differedPairs`**, and the sum
is checkable on the spot:

    matchedPairs + differedPairs === comparedPairs

Until 21 August 2026 there was only the total, and it grew by one whether the
digests matched, differed, or were compared when there was nothing to compare. A
reader could not tell "we compared and they honestly differed" from "we compared,
the difference sat in a request identifier, and the leak went past us". The
boundary section below is what `differedPairs` has to be read against.

**`skippedBothEmptyPairs` — pairs where the human's own counts were zero on both
sides.** Two tenants with no records return the same bytes on a healthy platform
and on a broken one, so the pair proves nothing either way. Counting it as
compared is how a fresh deployment, where half the tenants have nothing yet,
produced a wall of `high` findings and exit 1 against a platform with nothing
wrong with it. Only pairs where **every** declared `count` is zero on **both**
sides land here: one account seeing nothing while another sees four records under
the same digest is still a finding.

**`emptinessSignalsDeclared` — how many `count` signals the endpoint has.** Zero
means the tool has no way to tell an empty response from a full one there, so the
skip above could not have fired whatever the platform returned, and the false
positive is still reachable. The cure is one line of `bodySignals.signals`
declaring a count over the collection the endpoint returns.

**`pairsWithoutDigest` — pairs the tool could not compare at all.** A body over
`maxBodyBytes` yields no digest, and neither does a `compareSubtree` scope whose
path was not in the response; the observation carries `bodyOverLimit` or
`digestScopeMissing` saying which. Before this counter such a pair was filtered
out ahead of pairing and vanished from every number in the report — the flag on
the observation existed since 16 August 2026 and nothing read it.

## A difference in digests is not proof of isolation

The most important sentence in this section, and the one a reader supplies for
themselves if the document does not.

`differedPairs: 12` means twelve pairs of accounts from different tenants got
responses whose digests were not equal. It means **only that the bytes were
different**. It is not a statement that those tenants are isolated from each
other, and no arrangement of these counters can be made into one.

Three ways bytes differ while data leaks, all of them ordinary:

- **The envelope moved.** A `requestId`, a `serverTime`, a `generatedAt`, a
  pagination cursor, an echoed ETag — one field that changes between two requests
  is enough. Two responses carrying the records of *both* tenants then have
  different digests and produce no finding at all. This is the normal shape of a
  list endpoint on a real platform, which is why `compareSubtree` exists: it
  compares the part of the body you name and lets the envelope move. Without it,
  on such an endpoint, `differedPairs` counts pairs the check never really
  examined.
- **The scope excludes the leak.** `compareSubtree: { path: data.orders }`
  compares `data.orders` and nothing else. A tenant name leaking in
  `data.meta.owner` is outside the comparison, and the pair still lands in
  `differedPairs`.
- **The same records came back in another order.** Digests are over an exact
  value; two tenants shown identical rows in different orders differ by digest.
  Array order is deliberately kept — the order of records is data, and two tenants
  shown the same records is a leak worth seeing — but it means order alone can
  hide one.

What the check *does* establish is the other direction, and it is worth having:
`matchedPairs` is a claim about a platform, not about a serialisation. Where two
accounts from unrelated tenants received the same bytes on an endpoint an
operator declared must differ between them, something is wrong, and
`skippedBothEmptyPairs` is what keeps that claim from being made about two empty
responses.

So the body channel is one that finds leaks and never clears an endpoint of them.
Read `differedPairs` as "the tool has nothing to report here", never as "these
tenants are isolated". The same asymmetry runs through the whole report — see
"How to tell 'clean' from 'nothing was tested'" above — but here it is sharper,
because a digest looks like a measurement of the whole response and is a
measurement of one particular text.

See `docs/guide.md`, "Signals over the body", for the declaration side of this.

**`contextsProbed` answers the question "did anything go out under these
conditions at all".** Every declared set of conditions has a key, including with
a zero: its endpoints may have gone into `skipped`, and then the absence of
findings means "it was not tested", not "everything is in order under these
conditions".

**`endpointsTotal` is the denominator of the source, not of the whole API.** If
you gave the tool a list of six endpoints while the platform has a hundred, the
report does not know that and cannot know it.

**`endpointsProbed` below `endpointsTotal` puts a warning in `warnings`**, since
21 August 2026. Until then this section held the fact and nothing read it: a run
that probed two endpoints out of eleven — the other nine templated, with no
`resources` declaring values for their parameters — came back with `warnings: []`,
`findings: 0`, exit code `0` and a green headline on the terminal. The counters
elsewhere in this file all answer "was anything found"; `coverage` is the only one
that answers "was anything looked at", and the reader who does not open it is the
reader the warning is for. The reason matters as well as the count: a path
parameter with no resource declared drops the endpoints addressed by identifier,
which is the half of the surface where broken object-level authorization lives.

## Resources nobody could reach

`coverage.resourcesNotFound` names the resources every account was answered 404
for. Their cells settle nothing: a missing object refuses exactly like a
protected one, and `not-found` counts as a denial, so every one of those cells
agrees with a policy of denial and reads as "tested and agreed".

Two situations produce the same list and cannot be told apart by status: the
object is not there, or the platform hides its existence from everyone. For a
reader they mean the same thing — no conclusion about isolation follows from
those cells.

Where an owner **is** granted access this surfaces on its own: that account's
cell expects `allowed`, gets a denial and lands in `findings` as an unexpected
denial. The field is for the other half, where the declaration grants nobody
anything and there is nothing to contradict.

## What the tool did not test

- **Write methods.** Without `--unsafe-methods` only GET and HEAD are performed;
  `coverage.writeMethodsProbed` says whether it was otherwise. "Clean" applies
  to reading.
- **Endpoints outside the list.** Exactly what you declared was tested.
- **Response bodies.** They are not stored. They are read in transit only where
  you declared `bodySignals`, and only for the sake of irreversible scalars ([ADR-0011](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0011-response-body-signals.md)).

  **One number about the body is in the file for every cell anyway**, and it is
  worth knowing before this report travels: `content-length`, on the header
  allowlist. The tool never reads a body to obtain it — the server volunteers it
  in a header — and it carries no credential, which is why it stays. But it is a
  scalar derived from content, it is present on endpoints you declared nothing
  about, and lengths can be compared across accounts by anyone holding the file.
  On the reference platform's clean run, `orders.read` shows three distinct
  lengths across seven responses. Weighed and kept on 17 August 2026: an empty
  200 and a four-kilobyte 200 are different findings, and dropping the number to
  close a channel the tool never opened would cost more than it buys. Saying so
  is the part that was missing.
  Which means a whole class — extra fields in an otherwise legitimate response —
  is out of reach.
- **Whether the context attributes reached the application.** The tool sends the
  declared headers and parameters, but cannot make sure a proxy or a load
  balancer did not strip them on the way. If they were stripped, requests under
  conditions repeat the base ones, and the report will say "the restriction does
  not work" where it simply was not tested. This is the one place where "was not
  tested" is not reliably distinguishable from "does not work", and on someone
  else's perimeter it is worth keeping in mind: confirming that the attributes
  were delivered has to happen outside the tool.
- **Checks by body run only on the declared endpoints.** If an endpoint is not
  named in `bodySignals.responseMustDifferByTenant`, the absence of a finding
  means "no comparison was made", not "clean".

## What the report has about signals

`signals` in an observation are scalars computed over the body. `digest` is the
first 48 bits of SHA-256 over the body with a **salt that is random for every
run**. Comparing digests across runs is meaningless; within a run it is
meaningful.

An observation is identified by the triple **`accountId` + `endpointId` +
`resourceId`**; on endpoints without path parameters `resourceId` is absent, and
the key degenerates into a pair. The same triple links a finding to the
observation it came from — observations have no identifier of their own. The
observation itself carries `method`, `url`, `status`, `at` (the moment of the
request), the redacted headers, `outcome`, `durationMs` and, where `bodySignals`
are declared, `signals`.

**And the verdict on its own cell:**

```jsonc
{
  "accountId": "alice-a", "endpointId": "orders.read", "resourceId": "order-b-2001",
  "status": 403, "outcome": "denied",
  "expected": "denied",       // what the human declared
  "relation": "foreign-tenant",
  "match": true,              // tested and agreed
  "basis": "rule",            // a rule of the policy decided this, not the fallback
  "ruleIndex": 11             // and this is the rule, in inputs.policy.rules
}
```

`basis` is on the observation and not only on the finding since 17 August 2026.
Before that, the grounds for an expectation were on the rows that disagreed and
missing from the rows that agreed — so "the fallback decided this cell" and "the
tool did not fill the field in" looked the same on exactly the cells a reader
goes to when they doubt the declaration. See "Which rule gave the verdict" below.

`match: true` is **the only place in the report where a positive result is
visible cell by cell and not as a total**. It was absent on principle before, and
"it is clean here" had to be obtained by subtraction: a reader checking a single
cell was rewriting the tool's core in his own language
([ADR-0020](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0020-verdict-next-to-observation.md)).

**A cell cannot be listed as agreed and appear in `findings` at the same time.**
Two things judge a cell: the walk over the matrix, by status code, and the checks
over response bodies. Both have to be satisfied, and it is worth knowing that
until 15 August 2026 only the first reached this field — on the reference run
twelve cells were printed as agreed while carrying a high-severity leak.

**And a finding by body is about two cells, not one.** The fix above taught this
field to read check findings and left it reading one end of them, so the cell that
*received* another tenant's data — the counterpart in `relatedAccountId` — went on
being printed as agreed. Twelve again, on the same reference run, until
17 August 2026. Both sides of a pair now carry `findingKinds` and neither counts
towards `cellsMatched`.

Which is why a `false` here sometimes has no visible cause on the row. This one
is a real cell from that run:

```jsonc
{
  "accountId": "alice-a", "endpointId": "orders.list",
  "status": 200, "outcome": "allowed",
  "expected": "allowed",      // declared allowed, and allowed is what happened
  "match": false,             // and still it did not agree
  "findingKinds": ["identical-response-across-tenants"],
  "basis": "rule", "ruleIndex": 1
}
```

Access was declared allowed and was allowed; by status code there is nothing
here. What failed is the other declaration — `responseMustDifferByTenant` on this
endpoint — and `findingKinds` names it. **Without that field the row would be
unreadable**, and reading it as a bug in the tool would be the reasonable
conclusion.

Checkable on the spot: the number of observations with `match: true` must equal
`coverage.cellsMatched`, and the number carrying `findingKinds` must equal
`coverage.cellsWithFindings`.

The same field makes a mistake in **your** policy visible, as opposed to one in
the platform: a rule that accidentally declared access allowed used to give the
absence of a finding — indistinguishable from the absence of a problem. Now you
can see what exactly was declared, and by which rule.

**The findings are ordered by severity**, both channels interleaved. They used
to be every matrix row and then every check row, so a critical leak found by body
could sit below eighty low-severity discrepancies while `defects[]` beside it was
sorted properly all along. Ties break on endpoint, account, resource and kind, so
two runs of one matrix produce the same file.

**A finding carries the response headers**, redacted as everywhere else. They are
the one thing that tells "the endpoint is closed" from "we knocked with the wrong
transport": a 401 with `www-authenticate` is the platform naming a scheme you did
not use.

**Every authentication scheme names its header.** `{"kind": "bearer"}` said
nothing about where the credential goes while `header` and `cookie` named theirs;
the report writes `header: "authorization"` for bearer and basic. The
configuration keeps its shape — `kind: bearer` and nothing else is right there.

**Each request names the account that sent it.** On a list endpoint both sides of
a paired finding ask the same address and differ only by the credentials, which
are not in the report and will not be — so `request` and `relatedRequest` came out
byte for byte identical and a reader had two lines with no way to tell which was
whose. `as` is the account id, which is what turns a `curl` into the right `curl`.

**A check finding carries the values, not only their comparison.** The most
convincing number in the report is not `bodyDigestsEqual: true` but what stands
behind it:

```jsonc
"evidence": {
  "own.orderCount": 4,        // how many orders admin-a saw
  "other.orderCount": 4,      // how many carol-b from another tenant saw
  "otherAccountId": "carol-b",
  "tenant": "tenant-a", "otherTenant": "tenant-b",
  "status": 200, "bodyDigestsEqual": true
}
```

The scalars of both sides are held apart by the prefixes `own.` and `other.`; you
define which ones there are in `bodySignals.signals`, so the names in `evidence`
are yours, not ours.

**The digest itself is not here**, and until 15 August 2026 it was — contradicting
the note beside `bodyDigestsEqual` in the same object. It is meaningful only
inside one run, because the salt is random, so in a ticket it is a number that
cannot be compared with anything. Whoever wants it has it: `signals.digest` on
the observation for this cell is the same value, which is where a per-cell
measurement belongs.

The other side of the pair is named twice on purpose: `relatedAccountId` is the
field the report itself reads, and `evidence.otherAccountId` is there for whoever
is looking at one finding rather than at the schema.

`bodyDigestsEqual: true` means strictly "the body digests matched". The
probability of a collision over a run of a thousand responses is on the order of
10⁻⁹, but the tool never made a claim about the bodies being identical byte for
byte — which is why the field is named this way and not `identicalBody`, as it
was before. For the same reason the finding's title says "the response digest
matched", not "the responses are identical".

## Accounts with an at-sign in the name

`alice-a@geo-blocked` is not a separate platform account but **the same account
under declared request conditions**: the same credentials, the same role, the
same tenant, but the request is marked with attributes — a country from the CDN,
a device flag, a KYC status. What changes is the request, not who makes it.

Conditions are the fourth coordinate of a cell, and they exist for restrictions
that permissions cannot express at all: a bet from a forbidden jurisdiction, a
withdrawal before KYC is passed. The role, the tenant and the resource there are
the very same ones, and without a separate coordinate "alice sees her own order"
and "alice sees her own order from a forbidden country" are one and the same cell.

What to look for in the report:

| Where | What it says |
|---|---|
| `inputs.contexts` | which conditions are declared and with which attributes — without them there is nothing to reproduce a finding with |
| `accounts[].contextId` | that this row is an account under conditions, not a separate account |
| `accounts[].baseAccountId` | who this really is: the same account, the same credentials, the same scheme |
| `findings[].request.contextHeaders` | the attributes without which the row reproduces the **base** case, not the one that was found |
| `findings[].contextId` | that the discrepancy was found under conditions, not in the base ones |
| `coverage.contextsProbed` | how many cells were observed under each set of conditions; **zero means "not tested"** |

A policy rule without a `context` field applies **only in the base conditions**.
So a discrepancy under conditions always rests on an explicitly written rule or
on the `fallback` — and never on an expectation declared for base requests.

A defect under conditions and the same defect in the base ones are **two
different defects** in `defects`, not one. The country check and the permission
check live in different places in the platform, break independently and are
fixed separately.

**The flip side of this decision is double counting, and it is worth knowing
about.** A defect visible in the base conditions is usually visible under every
declared set as well: a list with no tenant filter leaks both with the added
attribute and without it. In `defects` that is two groups, while in the platform
it is one breakage. **Two groups that differ only by `contextId` are almost
certainly one defect.** The tool does not merge them itself, and that is
deliberate: from the outside "leaks with the attribute" and "leaks without it"
may be different paths in the code, and conditions exist for exactly that case.
Details — [ADR-0019](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0019-request-contexts.md).

## Identifying the run and the target

`target.label` names the system under test — the environment, the version,
anything that identifies it. A human declares it, because the tool cannot know
it: a `baseUrl` like `http://127.0.0.1:8787` does not tell a production-like
stand from the demo reference platform.

**A missing `label` is meaningful.** A report without one does not name the
platform, and you cannot file a ticket against the platform from it — first find
out from whoever ran it which system was tested. The CLI warns about this at
startup.

| Field | What for |
|---|---|
| `schemaVersion` | the shape of the report has changed and will change again; without a version a parser breaks silently. **`2` since 15 August 2026** — `checksRun` holds objects where it held bare ids, `bodyComparison` became `byCheck`, `checksWithUnusableFindings` is gone, and `findings[].accountId` and `.endpointId` are optional. A reader written against `1` breaks on all four |
| `runId` | otherwise two reports cannot be told apart — and, since 21 August 2026, the value the run went out under on the wire |
| `configDigest` | to tell "the platform changed" from "we changed the declaration" |
| `contentDigest` | to tell whether this is the file the run wrote. **Since 22 August 2026** |

The fingerprint is computed over the **parsed** configuration, not over the text
of the file: comments and indentation do not affect the result of a run, while
they would affect a hash of the text.

### `contentDigest`: what it proves, and what it does not

A sha256 over everything in this report except that field, and
`checkContentDigest(report)` in the library recomputes it. Over the **parsed**
document for the same reason `configDigest` is: reindenting the JSON, or reading
it through a formatter, is handling and not tampering.

Until 22 August 2026 nothing in the file said anything about the file. Three
fields identify the run, the declaration and the build; none identified the
artifact. So a report could be opened in an editor, have a row taken out of
`findings` and a sentence rewritten in `verdict.reason`, and nothing inside it
would object — and under this project's own invariant the edit spreads, because
HTML and PDF are rendered from this JSON rather than produced alongside it.

**It catches carelessness. It does not catch anyone who means it.** Whoever
deleted the row can recompute this value and write it back; a digest a reader can
check is a digest an author can forge. What it does catch is what usually
happens: an edit made without thinking, a hand-merge that mangled the file, a
truncated copy, a tidy-up before forwarding.

**The real answer is a signature, and there is not one.** Where a key would live,
who holds the half that verifies it, and what a signed report would even be
claiming are open questions, and an artifact that looks stronger than it is would
be worse than one that is honestly weak. Do not present this digest to anybody as
proof that a report was not altered. See
[ADR-0051](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0051-the-report-answers-for-itself.md).

A report written before 22 August 2026 carries no digest. `checkContentDigest`
answers `ok: false` with `declared` absent on such a file — not `ok: true`,
because a verifier that waved a missing field through would make the whole thing
optional.

**A report written by `0.5.0` carries a digest that does not check out, and this
is not a sign of tampering.** The digest was computed correctly and then the
command wrote one more field — `runId`, the identifier the run had already put on
the wire — onto the finished document. Every artifact produced between 22 and
23 August 2026 answers `ok: false` with `declared` present, and there is no way
to tell such a file from one that was edited. If you are holding one, the digest
tells you nothing either way; re-run against the current version if the question
matters. Fixed on 23 August 2026 —
[ADR-0058](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0058-a-guarantee-holds-where-the-artifact-goes.md).

### `runId` is also what the platform's own logs recorded

Unless the run was made with `--no-identify`, every request it sent carried this
`user-agent`:

```
barbican/0.4.0 (+https://github.com/Tarnellion/barbican#readme; run=<runId>)
```

That is there for the party who agreed to the run and then has to live with it in
their own systems. With `runId` from this file they can find exactly this run's
traffic in an access log or a SIEM, filter it out of an availability graph, and
show an anti-fraud rule what it was. It is the other direction of the
correlation this report already offers: `x-request-id`, `x-correlation-id`,
`x-trace-id` and `traceparent` are kept off the **responses** so that a finding
can be matched against a record on the platform's side.

If the run was made with `--no-identify`, none of that is available and the
traffic is indistinguishable from an attack. Nothing in the file says which of
the two happened — the operator's terminal does, on a line reading either
`Named on the wire as: …` or `This run did not name itself on the wire`. See
[ADR-0045](https://github.com/Tarnellion/barbican/blob/main/docs/adr/0045-a-consented-run-says-who-it-is.md).

## The run's own blast radius

The rest of this document is about what the run observed. This section is about
what the run **did**, because two of its consequences show up in the file wearing
somebody else's name.

**The job that produced this report held every role's live credentials at once.**
barbican does not log in — a login is usually a POST, and that is outside safe
mode — so the operator supplies working tokens through the environment
of one process: the customer, the affiliate, the support agent, the tenant
administrator and the operator console, side by side, for the length of the walk.
That process is a concentration of privilege the platform itself never grants to
one principal. `accounts[].tokenEnv` in this file names the variable each of them
came from, and `barbican.run.yaml` is meant to be committed and reviewed —
`tokenEnv` names a variable rather than a value precisely so that it can be. The
committed file is therefore a map of which variable holds which role, which is
harmless on its own and is half of a pair. Whoever reads this report is holding
the other half: the addresses, the account identifiers, and the places the
authorization does not hold.

Nothing in the tool can shrink that. What can be decided is where the job runs,
who can read its environment, who can restart it with a shell, and how long the
tokens live after the window closes.

**And the run is shaped like the attack it looks for.** By construction it sends
a long run of `401` and `403` from one subject in a few minutes — every cell the
policy expects to be refused, in order, from one account. That is the signature
platforms hang an account lockout, a step-up challenge or an anti-fraud flag on,
and the ones that do it are the ones worth testing: consumer platforms, payment
surfaces, anything with a regulator behind it.

The report knows the case where **half the requests failed** and exits 2 for it.
It does not know this one, and the difference matters twice over. A lockout does
not fail requests — it answers them, correctly formed, with `401` or `403`. Those
are denials. A denial agrees with a policy of denial, so the cells past the
lockout land in `cellsMatched` and read as tested and agreed, and the run can
still end in `0`.

What does fire is the canary, probed again after the walk, and **it reports the
lockout as `staleCredentials`** — an account whose canary passed before and
failed after. That row is worded for a token that expired on its own. Read it as
the question "what happened to this account during the walk", not as the answer
"the token was too short-lived": on a platform with a lockout policy, the run is
the likeliest cause, and it is the one cause the tool cannot see. The same goes
for a sudden wall of `probe-error` from one account part-way through the file:
`at` on each observation is the timestamp to line up against the platform's own
security log.

None of this is a reason not to run. It is the reason the run is agreed in
advance, in writing, with someone who can unlock an account — see "Before a run
against something you do not own" and the checklist in
[first-run.md](first-run.md).

## Where this file came from, and who can read it

`barbican run --report run.json` writes the report to that path, creating it with
mode `0600` — owner only. **Without `--report` the report goes to stdout**, which
in a pipeline means the build log: readable by everyone who can see the build,
kept for as long as the build is kept, and copied wherever build logs are
collected.

That matters because of what this document is. It has no response bodies and no
credentials — those are kept out by construction — but it holds every request
address, every response header the value allowlist preserved, the identifiers of
every account, tenant and resource, and a list of the places where a platform's
authorization does not hold. It is a map of somebody's unlocked doors.

So: redirect it (`barbican run … > run.json`) or name a path with `--report`, and
treat the result as you would treat any other finding about an unfixed
vulnerability. The CLI warns on any real run started without `--report`.

## Inputs: what the conclusions rest on

The `inputs` section holds everything without which a finding can neither be
filed as a ticket nor disputed:

```jsonc
"inputs": {
  "policy":  { "fallback": "denied", "rules": [ /* with patterns expanded */ ] },
  "tenants": [ { "id": "tenant-a", "parentId": "holding-1" } ],
  "auth":    { "kind": "bearer" }
}
```

**`policy`** — already expanded: patterns like `/v1/admin/**` are replaced with
concrete identifiers. This is exactly the policy that produced the verdicts, not
the one written in the file — the difference shows when a pattern captured
something other than what you thought.

**`tenants`** — the tree on which `foreign-tenant`, `ancestor-tenant` and
`descendant-tenant` are computed. Without it there is nothing to explain the
relation in a finding with.

An account declared without credentials carries `anonymous: true`, and the `auth`
field is not written at all: it has nothing to present. Without that mark the
report's only positive conclusion — "the anonymous account was denied everywhere"
— is unprovable, because an account whose token was passed wrongly would look
the same.

**`exclude`** — endpoints the operator excluded by hand. An empty list means
"nothing was excluded"; saying nothing about it would read the same way, but mean
something else.

**`throttle`** — the limits that were actually in force: concurrency, rate, the
ceiling on requests per run. Otherwise the invariant "throttling is always on"
has to be taken on trust.

**`auth`** — the **default** scheme: the kind and, for `header`/`cookie`, the
name of the header or the cookie. There are no values here and there cannot be:
they live only in environment variables.

The scheme of a particular account sits next to it in `accounts[].auth`. On a
platform with several authentication surfaces they differ, and without this field
the reader cannot tell "the endpoint is closed" from "we knocked with the wrong
transport": both give 401.

## How to reproduce a finding

Every finding carries the request that produced it:

```jsonc
{
  "accountId": "alice-a",
  "relation": "foreign-tenant",
  "severity": "critical",
  "request": { "method": "GET", "url": "http://127.0.0.1:8787/v1/orders/B-2001" }
}
```

Parameter values are substituted. Credentials in the URL are forbidden by
configuration, so the line can be pasted into a ticket as is — adding the
authentication header of the account named in `accountId`.

**For a finding under request conditions the URL alone is not enough.**
Attributes that are parameters are visible right in the URL, attributes that are
headers are not, and a request without them reproduces the base case instead of
the one that was found. That is why they are printed next to it:

```jsonc
"request": {
  "method": "GET",
  "url": "http://127.0.0.1:8787/v1/orders/A-1001",
  "contextHeaders": { "cf-ipcountry": "AQ" }
}
```

There are no credential headers here and there never will be: they come from the
environment, and that is the only place for them. `contextHeaders` is what the
human declared in `contexts`.

**A finding by body has two requests.** The second one is in `relatedRequest`: on
a platform where brands are spread across subdomains the other side has a
different host, and a request put together by eye would have gone to the wrong
place.

**With which token.** `accounts[].tokenEnv` names the environment variable — the
name, not the value. It is in the configuration anyway, the one you are supposed
to commit, and without it "add the authentication header of account alice-a" does
not say where to get that token.

**When it happened.** Every observation has `at` — the moment of the request in
ISO-8601. Without it there is nothing to match the finding against the platform's
log, and that is the first thing the team that receives the ticket will ask for.
Correlation headers (`x-request-id`, `traceparent` and the like) are kept
unredacted for the same reason: they are not credentials but a handle for
matching.

## Which rule gave the verdict

Two fields answer this, and the second exists because the first could not.

`basis` says what declared the expectation: `"rule"` or `"fallback"`. `ruleIndex`
is the rule's position in `inputs.policy.rules`, present only when `basis` is
`"rule"`. Both are on `findings[]` and, since 17 August 2026, on `observations[]`
as well — a cell that agreed has grounds too, and they are what a reader checks
when they suspect the declaration rather than the platform.

The absence of `ruleIndex` used to be the whole answer, and it was not a good
one: on the reference run 37 of 80 matrix findings carried no index, and 22 of
the 34 critical ones. On most of the most expensive findings the grounds for
"access was not expected" were expressed by a missing key — and a missing key
cannot be told from a field the tool failed to fill in. That is the point where
a ticket comes back.

A finding from the matrix has `ruleIndex` — the number of the rule in
`inputs.policy.rules` that declared the expectation:

```jsonc
{ "kind": "privilege-escalation", "ruleIndex": 11 }
// inputs.policy.rules[11]:
// { "roles": ["user","admin","affiliate","support"],
//   "endpoints": ["statements.read"], "scope": "ancestor-tenant",
//   "outcome": "denied" }
```

**A missing field is a meaningful answer, not an omission:** no rule matched, and
the `fallback` fired. For a cross-tenant leak that is normal — it is forbidden by
the default, not by a rule of its own.

The number points at the **last rule that matched**: that is the one that wins,
and pointing at the first match would name the wrong source of the verdict.

## A finding that names no cell

Most findings are about a cell: this account, this endpoint, this resource. Some
are about the run — "this clause is covered by nothing at all" — and those carry
neither `accountId` nor `endpointId`. Nothing is put in their place: an endpoint
id there would tell you a request was made to it.

Two consequences worth knowing before you write a parser:

- **They are in `summary.findings` and in `byKind`,** like any other. Until
  15 August 2026 they were dropped on the floor and the report said
  `findings: 0` about a critical one.
- **They are not in `defects`.** A defect group answers "how many distinct
  breakages of the platform", and a statement about the run is not one of those.
  So the identity is `sum(defects[].violations) + findings with no cell ===
  summary.findings`.

No check registered today produces one; the shape exists because the evidence
pack is made of them.

## What the report still does not have

**The coverage denominator has been struck off this list.** It stood here as an
open item and sent the reader to `tasks.md`, where the same item had already been
recorded as done — a pointer to an open question that nobody has open. The
`coverage` section carries `endpointsTotal` and `endpointsProbed`, `cellsObserved`
and `cellsNotObserved`, `cellsMatched` and `cellsWithFindings`, and `notProbed`
with a reason for every endpoint that was not touched. All of it is described
above.

Half of the old entry survives, and it is a boundary rather than a debt: **how
many endpoints the API has in total cannot be known from a run.** The tool sees
the list it was handed, `endpointsTotal` counts that list, and no field added
later can close the gap between it and the platform. That is said above, next to
`endpointsTotal`, and it is said there because it is permanent.

The entry is struck off rather than deleted for the reason the rest of this
document exists: a reader who saw the old one is owed the news that it changed,
and which half of it changed.

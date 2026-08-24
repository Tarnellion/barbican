# 0069. The catalogue says what is unanswered, over both channels

- **Status:** accepted
- **Date:** 2026-08-24

## Context

[ADR-0043](0043-a-catalogue-of-clauses.md) put a catalogue of clauses in the tree
so that "this clause is covered by nothing" could be said at all, and shipped
`findUncoveredClauses(catalog, checks)` to say it. Its Consequences record the
answer of the day: "Thirteen of the sixteen catalogued clauses are covered by
nothing, and `tests/invariants/standard-refs.test.ts` pins the list by exact
equality."

[ADR-0041](0041-a-matrix-discrepancy-answers-for-a-clause.md) is dated the same
day and decides the other half: **a matrix discrepancy carries `standards` too**,
assigned by `standardsForDiff(kind, relation)`. Privilege escalation and
cross-tenant access — which is everything this tool was written to find — cite
ASVS 8.1.1 on every row, the level clause 8.2.1 or 8.2.2 according to the cell,
8.4.1 where the cell crosses a tenant boundary, and API1/API5 with CWE-285 where
the discrepancy is an escalation.

The two never met. `findUncoveredClauses` subtracts `Check.standards` and nothing
else, so it was wrong from the day both landed.

### What it answered, measured

`clauseAnswers` over the bundled catalogue and the checks this package exports,
on the tree this ADR was written from:

| standard | clause | checks that answer | discrepancy kinds that cite it |
|---|---|---|---|
| OWASP-ASVS-5.0 | 8.1.1 | — | all four |
| OWASP-ASVS-5.0 | 8.1.3 | — | — |
| OWASP-ASVS-5.0 | 8.2.1 | — | all four (cells naming no resource) |
| OWASP-ASVS-5.0 | 8.2.2 | — | all four (cells naming a resource) |
| OWASP-ASVS-5.0 | 8.2.3 | — | — |
| OWASP-ASVS-5.0 | 8.3.1 | — | — |
| OWASP-ASVS-5.0 | 8.3.3 | — | — |
| OWASP-ASVS-5.0 | 8.4.1 | `identical-response-across-tenants` | all four (cells crossing a boundary) |
| OWASP-API-2023 | API1 | `identical-response-across-tenants` | `privilege-escalation` |
| OWASP-API-2023 | API3 | — | — |
| OWASP-API-2023 | API5 | — | `privilege-escalation` |
| CWE | 284 | — | — |
| CWE | 285 | `identical-response-across-tenants` | `privilege-escalation` |
| CWE | 862 | — | — |
| CWE | 863 | — | — |
| CWE | 639 | — | — |

Seven clauses are answered; nine are not. The pinned list said thirteen. The four
it named wrongly are **ASVS 8.1.1, 8.2.1, 8.2.2 and API5** — one of them the
clause every discrepancy this tool produces cites first.

Two things fall out of the same table and are worth stating because neither was
designed:

- **No clause is answered by a check alone.** All three the check declares are
  also cited by the matrix mapping. That is why the wrong answer was survivable:
  subtracting only the checks was wrong in one direction and never in the other,
  so it over-reported gaps and never under-reported them.
- **API1, API5 and CWE-285 are cited by exactly one kind.** They are defect
  classes, and ADR-0041 refuses to credit an unexpected denial, an unobserved
  cell or a failed probe with having gone looking for one.

### Three ways this cost something

**The claim is false.** "ASVS 8.2.1 is covered by nothing" is said of the clause
that every function-level escalation cites. An evidence pack is read for the
clauses it omits; four wrong rows in thirteen is a 31 % error rate in the one
artifact whose whole job is to be believed about what was *not* checked.

**The nine real gaps are hidden inside the thirteen.** CWE-862 and CWE-863 are
absent for a reason no check will ever close — from outside a platform, a missing
authorization check and a wrong one give the same answer — and that is worth
reading. Filed beside four rows that are simply wrong, it is not.

**The answer could not move when the fact did.** `standard-refs.test.ts` pinned
the thirteen "so that a check added, a check's claims widened, or a clause added
all move it". A fourth thing changes what that list should say and moved it by
nothing: a change to `standardsForDiff`.

This is not the claim that the mapping was unwatched — it was.
`tests/core/clause-coverage.test.ts` and
`tests/report/matrix-findings-carry-clauses.test.ts` pin what
`controlClausesForCell` returns by exact equality, and both mutations run against
the tree before this change (3 and 5 in the table below) were caught there. The
claim is narrower and worse. Under mutation 3, ASVS 8.2.1 genuinely stopped being
answered by anything at all, and the list whose entire job is to name such
clauses **printed exactly the same thirteen rows**: it had been listing 8.2.1
wrongly, and went on listing it, now rightly, with nothing anywhere recording
that its meaning had inverted. Under mutation 5 the reverse — the matrix channel
began citing 8.1.3 — and the same thirteen rows came back, with 8.1.3 still on
them and now falsely.

A list that gives the same answer whether or not the fact is true is not evidence
about the fact. That is what an evidence pack would have been quoting.

## Decision

### An unanswered clause is carried, with a reason, and never dropped

Of the three shapes available — refuse to register a clause nothing answers, drop
it from the catalogue, or carry it with an explicit marker — the third, and the
argument is [ADR-0006](0006-expected-access-declaration.md) at one remove.

That ADR's rule is that the tool must not compare an implementation against
itself. A catalogue pruned of the clauses nothing here answers is exactly that
failure moved up a level: the boundary of the audit would be drawn by what the
tool happens to implement, and a pack built on it would answer "did you cover the
standard" with "I covered what I cover". Refusing to register such a clause is
the same thing with a louder error. Both make the pack *look* complete, which is
the direction that does not get audited.

So the catalogue keeps them, and each one says why. `StandardClause` gains
`unansweredBecause` — the sentence a reader needs when the derivation comes back
empty. `bundled.ts` had already written down where that sentence belongs: the two
CWE weaknesses a status code cannot tell apart "are worth standing in the
catalogue as clauses nothing covers … and the reason belongs in the pack rather
than in a source comment nobody reading a report will see." It was in a source
comment.

### Whether a clause is answered is derived, never declared

There is no `covered` field, and that is the structural half.
`clauseAnswers(catalog, checks)` returns one row per catalogued clause carrying
two computed lists — the registered checks that declare it, and the kinds of
matrix discrepancy whose mapping cites it — and "answered" is those lists being
non-empty. `findUnansweredClauses` is that table filtered.

A clause added to the catalogue tomorrow with nothing behind it therefore comes
back unanswered because **there is nothing to declare it with**. The only thing
that can be got wrong is the reason, and the reason is gated in both directions.

`findUncoveredClauses` and `UncoveredClause` are gone rather than kept beside the
new pair. The question they asked — "which clauses does no registered check
declare" — is one nobody should ask of a pack, and two functions differing by one
channel is the shape every drift in this repository has had. The word also
changed on purpose: since [ADR-0052](0052-a-clause-can-be-reported-as-exercised.md)
"covered" is a per-run notion (`coverage.clauses`, what one walk reached), and
this is a structural one — what the tool can ever speak to.

### The matrix channel is enumerated, not listed

Which clauses that channel can cite is asked of `standardsForDiff` over every
`DiffKind` and every `ResourceRelation` including `undefined`. Nothing models its
branches; they are called.

That enumeration is only as complete as the list it iterates, so `DIFF_KINDS`
becomes the source of truth in `src/core/types.ts` and `DiffKind` is derived from
it — the shape `RESOURCE_RELATIONS` in the same file has had since the tenant
hierarchy, for the same reason. [ADR-0064](0064-a-table-written-twice-is-made-to-agree.md)
rejected `satisfies readonly DiffKind[]` on an array because it holds only one
half: a member of the union left out of the array still compiles. Deriving the
union from the array has no second half to lose, and it leaves the
`Record<DiffKind, …>` tables that ADR chose exactly as they are.

### The clause texts were checked against the published documents

Every clause was read against its source on 24 August 2026: ASVS v5.0.0 chapter
V8, the three OWASP API 2023 entry pages, and the five CWE definitions. What was
found is in the Consequences below. This step is not automatable — ADR-0043 said
so — and the record of having done it belongs where the next person adding a
clause will look.

## Alternatives

**Leave `findUncoveredClauses` and add the wider function beside it.** Rejected:
two functions answering "what does nothing cover" that differ by one channel is a
fact written twice, and the copy that goes stale is the one nobody calls. If the
narrower question is ever genuinely wanted, `clauseAnswers(...).filter(row =>
row.checkIds.length === 0)` is one line and does not need a name.

**Make `unansweredBecause` mandatory in the type for every clause.** Rejected. A
clause something answers has no such reason to give, so the field would have to
be filled with a lie or an empty string on seven of sixteen entries, and
`register` refuses a blank precisely because an empty cell reads as a reason.

**Have `register` refuse a clause that nothing answers.** Impossible where it
would have to live: a catalogue is assembled without ever seeing a check, and
that independence is what lets a private standard be registered at run time
(ADR-0043). The door can only refuse a blank; the agreement between the reason
and the derivation is a test.

**Make the matrix channel a registered check, so that there is one channel to
subtract.** This is ADR-0041's own rejected alternative and its blast radius has
not shrunk: `summary.byKind` holds discrepancy kinds and check ids in one key
space, `RESERVED_CHECK_IDS` exists to keep them apart, `verdictInputs` separates
them for the exit code, and the polygon oracle counts by those kinds. It remains
the right end state and it is not this change.

**Add a field per clause naming the channel that covers it.** Rejected as the
same defect one level down: a declared answer can be wrong, a derived one cannot.
ADR-0043 rejected an `origin` field for being unread; this would be worse, being
read and wrong.

**Drop CWE-284, 862, 863 and 639 from the catalogue, since nothing will ever
answer them.** Rejected, and this is the ADR-0006 argument at its sharpest: those
four are the clauses a reader of a pack most needs to see named, because they are
where a black-box probe structurally stops. A catalogue that carries only what it
can answer is a mirror.

## Consequences

### What the surface gains and loses

- `clauseAnswers` and `findUnansweredClauses` are exported;
  `findUncoveredClauses` is gone. `DIFF_KINDS` is exported for the reason
  `RESOURCE_RELATIONS` and `SAFE_METHODS` are: a consumer reading
  `AccessDiff.kind` has the same need for the list that this module does.
- The package exports 234 values, up from 232. `docs/library.md` answers for the
  count and gains the two functions.
- `StandardClause` gains one optional field. A consumer's `StandardDefinition`
  still compiles unchanged, and `register` refuses it blank.

### What the paraphrase check found

Four ASVS summaries said more or less than their requirement does, and were
narrowed:

| clause | was | the published requirement | why it mattered |
|---|---|---|---|
| 8.1.1 | "which functions and which data **each role** may reach" | rules based on "consumer permissions **and resource attributes**" | narrower than the standard, and narrower than this tool, which has request conditions |
| 8.3.1 | "on a **server-side** layer the caller cannot reach around" | "at a **trusted service layer**", not relying on controls an untrusted consumer can manipulate | "server-side" is a gloss the standard does not make |
| 8.3.3 | "not its own **wider** ones" | "not … the permissions of any intermediary" | the standard does not say the intermediary's rights are wider |
| 8.4.1 | "one tenant's operations never **reach** a tenant …" | "cross-tenant controls to ensure consumer operations will never **affect** tenants …" | the widening is on the axis this tool lives on |

The last is the substantive one and it is not fully closed by rewording. This
tool's central finding is a cross-tenant **read**, and a read affects nothing in
the strictest sense of the standard's verb. Citing 8.4.1 for it is the common
reading of the requirement and it is a reading; the title now carries the
standard's own word so that a reader can make that judgement instead of
inheriting ours.

The other five ASVS titles, all three OWASP API titles and all five CWE titles
match their sources. The CWE hierarchy `bundled.ts` describes — 284 → 285 →
{862, 863}, 639 under 863 — is correct, and 284 is a Pillar, which the title now
says.

Three further inaccuracies, none of them a clause title:

- **The ASVS `scope` line was wrong twice.** It said the catalogue holds "the
  requirements a black-box probe over HTTP can speak to at all". Chapter V8 has
  thirteen requirements and eight are catalogued; two of the eight (8.1.1, 8.1.3)
  are documentation requirements no probe speaks to, and 8.1.2 — the field-level
  twin of 8.1.1 — is absent while 8.2.3, its enforcement twin, is present. The
  line now names what is catalogued and names the five that are not.
- **ASVS 5.0 has seventeen chapters, not fourteen.** Said as fourteen in
  `bundled.ts`, in the `scope` string a report would carry, and in ADR-0043,
  which now has a note.
- **The OWASP API clause ids are `API1`, `API3`, `API5`; the document spells them
  `API1:2023`.** Left as they are and recorded here: the edition is already
  carried by the standard half of the reference (`OWASP-API-2023`), the short
  form is unambiguous within it, and the id is a coordinate that appears in
  `report.coverage.clauses[].clause`. Changing it is a report-content change and
  belongs with a `schemaVersion` decision, not here.

### The gate, and the seven mutations it was put to

`tests/invariants/a-clause-nothing-answers.test.ts` pins the nine by exact
equality, holds `unansweredBecause` and the derivation to agree in both
directions, and shows the derivation is not vacuous.

Attacked before it was trusted. Every mutation below was applied to a committed
tree by a harness that reads the file, counts the needle, and **refuses to write
anything at all unless the count is the one the spec declares** — a replacement
that landed somewhere other than where it was aimed proves nothing about the gate
it was aimed at. Shown refusing once on a needle that matches nothing (`id:
"8.9.9"`): exit 3, no file written, no backup taken. Every file touched is copied
byte for byte before the first write and restored from that copy in a `finally`;
never `git checkout --`, which restores what the index holds rather than what was
there a second ago. The backups live outside the repository, because the first
run put a `bundled.ts.mutation-backup` next to its original and
`tools/coverage-gate.mjs` correctly refused an unrecognised extension under
`src/` — the harness was littering in the tree it was measuring.

Two of the seven were also run against the tree before this change, extracted from
the release commit into a scratch directory. That tree is not a git checkout, so
the twelve test files that read `git ls-files` fail there for a reason of their
own; the pre-change column below is from a run of the five files that bear on
this question, and the failures listed are that run's.

| # | mutation | on the tree before | on this tree |
|---|---|---|---|
| 1 | a sixteenth clause (CWE-732) added to the catalogue, nothing behind it and no reason | — | **red**: four assertions here — the count, the pinned list, the missing reason, the length floor — and `standards.test.ts` |
| 2 | `unansweredBecause` added to ASVS 8.4.1, which both channels answer | — | **red**: "is on no clause something answers" |
| 3 | the matrix channel stops citing ASVS 8.2.1 | **the pinned list of uncovered clauses did not move.** `standard-refs.test.ts` and `standards.test.ts` green; three other files red on the mapping itself | **red**: five assertions here, plus the same three files |
| 4 | the one registered check declares no clause at all | — | **red**: "reaches clauses down both channels", plus four other files |
| 5 | the matrix channel starts citing ASVS 8.1.3, which the catalogue says nothing answers | **the pinned list did not move.** `standard-refs.test.ts` green; `clause-coverage.test.ts` red on the mapping | **red**: three assertions here, plus `clause-coverage.test.ts` |
| 6 | the enumeration stops looping and asks about one `DiffKind` | — | **red**: "asks the matrix channel about every kind there is". The clause *set* is unchanged — `privilege-escalation` cites a superset — so only the anti-vacuity assertion catches it |
| 7 | a reason that is present, long enough and says nothing | — | **green**, and deliberately: one of the entries under "what the gate does not hold", run rather than imagined |

Mutations 3 and 5 are the experiment this ADR exists for. Neither is the claim
that the mapping was unwatched: it is pinned by exact equality in two other
files, and both mutations were caught there. What neither of those files can say
is what the *catalogue's* answer becomes, and that answer — the list a pack
quotes — came back identical in both directions, once when it had newly become
right and once when it had newly become wrong.

### What the gate does not hold

Stated because [ADR-0065](0065-what-a-source-scan-can-hold.md) requires it, and
every entry below was run before it was written down. This gate is not a source
scan — it reads the exported surface — so its blind spots are the surface's.

- **A check that is not exported from `src/index.ts`.** Checks are discovered by
  the naming pattern on the package surface, as `standard-refs.test.ts` discovers
  them. A check a consumer registers is invisible here, and so is the clause it
  answers. One-directional: such a clause reads as unanswered, never as answered.
- **A private catalogue.** Only the bundled three are read. A standard registered
  at run time is held to nothing by this file. The alternative — asking a
  consumer's catalogue the same question — is not a gate this repository can run,
  and `clauseAnswers` is exported precisely so that a consumer can run it.
- **A reason that is present, non-blank and wrong.** Nothing reads what the
  sentence says. Run as mutation 7: CWE-862's reason replaced with "Nobody has
  got round to this one, and this sentence is long enough to clear the floor" —
  1841 tests passed. The length floor is arithmetic and not judgement.
- **Whether the catalogue's boundary is the right one.** `scope` is a human
  judgement about which clauses to carry; this file asks nothing about it. The
  paraphrase audit above is what a human does instead, and it found the boundary
  described wrongly, which no test would have.
- **A clause that both channels cite for a reason that is nonsense.** The
  derivation asks whether a citation exists, never whether it is apt. That
  8.2.2 is cited by a `probe-error` cell — a cell that concluded nothing — is
  ADR-0041's deliberate choice and would look identical to a mistake here.
- **The pack.** Nothing yet renders these rows. A pack that computed the answer
  correctly and printed only the answered rows would be the original defect
  restored, and this file cannot see a renderer. That is the next track's to
  hold.

### Revisit when

The matrix channel becomes a registered check. Then `clauseAnswers` has one
channel to subtract instead of two, `matrixClauses` and the enumeration over
`DIFF_KINDS` go away, and `DIFF_KINDS` keeps its place for the tables ADR-0064
put it beside.

# 0048. A finding can be known and still reported

- **Status:** accepted
- **Date:** 2026-08-21

## Context

The model had exactly one channel for intent — `ExpectedAccessPolicy` — and by
21 August 2026 it was carrying two statements at once.

"This access is meant to exist" is the one it was designed for. "This access is
not meant to exist, we know it does, and it is scheduled for the next quarter"
had no spelling of its own, so the only way to stop a finding failing a build was
to declare the cell allowed. After that the finding is gone from the artifact
entirely: no row in `findings`, no group in `defects`, `match: true` on the
observation, `cellsMatched` one higher, exit code 0. Nothing anywhere records
that anybody ever knew.

That is the distinction ADR-0006 separated the declaration from the specification
to preserve, erased one layer up. And it is the distinction Module 2 exists for:
an evidence pack has to be able to show "found, accepted, for this reason, until
this date". Suppressing through the policy shows "nothing was found", which is a
sentence about a different platform.

The second cost is about whether the tool is used at all. A team whose first run
finds forty things cannot put barbican in CI until all forty are fixed. What
happens instead is not that they fix forty things. It is that the step comes out
of CI, and then nothing is measured at all — which is the worst of the available
outcomes and the most common one.

## Decision

A second channel: `accepted:` in the run configuration. An entry names a finding
that is known, gives a reason and a deadline, and holds that finding **out of the
verdict** while leaving it in the report.

```yaml
accepted:
  - endpoint: orders.get
    relation: same-tenant
    kind: privilege-escalation
    reason: the order service has no tenant filter; PLAT-1234 replaces it
    until: 2026-11-30
    ticket: PLAT-1234
```

Four decisions inside that.

**The key is the defect, plus the way it showed itself.** A matrix cell is
account × endpoint × resource × conditions, and a defect group is keyed by
endpoint × relation × conditions — the role is deliberately not in it, and
neither is the resource. An acceptance is keyed by the group's coordinates and
the `kind`.

The two ends of that choice are both failures. A key carrying the resource comes
apart at the first new resource declared for the same endpoint: the acceptance
expires for a reason having nothing to do with the platform, and the operator who
declared five resources gets five entries to maintain. A key naming only the
endpoint is the opposite — "everything on this endpoint", which silences the
cross-tenant leak nobody has looked at yet along with the neighbour-inside-a-
tenant one they have.

The kind is in the key although ADR-0030 took it out of the defect signature, and
the two are not in conflict. "How many things are broken here" answers once for
an endpoint that fails by status and by body alike. "What did the operator look
at and sign for" answers about the one they looked at: a defect that starts
failing a second way is a finding the acceptance has not seen, and it has to
arrive as one. The group then carries `acceptedKinds` as a subset of `kinds`,
which is how a reader tells a defect accepted whole from one accepted in part.

The key is built by `citableDefectKey` and `defectSignature` — the same functions
the grouping uses — so `accepted[].defect` in the report is the same words as
`defects[].key`, and the string a ticket quotes is the string the configuration
is written against.

**A reason and a deadline are required.** The rule borrowed here is the project's
own about `overrides` in `pnpm-workspace.yaml`: an entry that carries no
condition for its own removal is a pin nobody notices. A suppression is that
object exactly. `until` is a date, `YYYY-MM-DD`, inclusive of its last day, in
UTC — not the machine's zone, because a verdict that changes with which runner
picked the job up is the defect ADR-0036 is about, one level up in
consequence. Past that day the acceptance stops holding: the finding counts in
the verdict again, and the row keeps its mark with `expired: true` on it, which
is what explains a run that has just started failing over something that passed
last week.

**The finding does not disappear.** It keeps its row in `findings`, its severity,
its clauses, its request, its place in `byKind`, `bySeverity`, `defects` and
`summary.findings`; the cell keeps `match: false` and its `findingKinds`. Exactly
one number changes: `summary.verdictInputs`, which is what `runVerdict` reads.
`summary.accepted` says how many rows are held, how many have lapsed, how many
declarations covered nothing, and the held ones by kind — so that for every
matrix kind `byKind[k] − accepted.byKind[k] === verdictInputs.matrixByKind[k]`
holds and a distrustful reader can check it from the file.

**An acceptance that covered nothing is named.** `accepted[].matched` is the row
count and `summary.accepted.unused` the number of declarations at zero. Either
what the entry names is fixed — and the line should be deleted — or the run never
reached those cells, in which case `coverage.notProbed` says why. The report
cannot tell the two apart and does not guess.

Two kinds may never be accepted, and this is hardcoded: `not-observed` and
`probe-error`. Neither says anything about the platform — one means no request
covered the cell, the other that the request did not answer — so accepting either
is accepting "we did not look". For `probe-error` it is worse than that: half a
matrix failing to answer is the exit code 2 that says the report describes the
state of the network, and that conclusion must not be purchasable from a
configuration file. Neither is a thing an operator needs, which is what makes the
rule cheap: `not-observed` is `low` and fails no run, and `probe-error` fails one
only at the threshold where the run is telling the truth.

## Alternatives

**Keep using the policy, and add a comment.** This is the state being fixed. The
finding vanishes, the counters agree with its absence, and a year later nobody
can tell an endpoint nobody ever broke from an endpoint everybody agreed to leave
broken.

**A baseline file: record the current findings, fail only on new ones.** The
familiar shape from linters, and it fails the requirement the loudest. A baseline
has no reason and no deadline per entry — it is a snapshot, so it accepts
everything at once, including whatever nobody read. It also silences by row
rather than by defect, so the same breakage on one more account arrives as new.
The deadline is what turns a suppression into a decision, and a baseline is
structurally unable to carry one.

**Let an acceptance lower the severity instead of leaving the verdict.** Then the
threshold decides, `bySeverity` stops describing the findings, and the operator's
statement about *scheduling* is expressed as a claim about *how bad it is*. Two
different things, and mixing them is how `defectsBySeverity` would stop being
readable.

**Refuse the run when an acceptance matches nothing**, the way an unused resource
or an unknown role is refused. Tempting, and it is the same class of dead
declaration. It is rejected because the good case and the bad case are
indistinguishable from inside one run: the platform being fixed and the walk not
reaching the cell both produce zero. Failing CI on a fix is precisely how the
step comes out of CI, which is the failure this ADR was written from. The
deadline is the real bound — a stale entry can silence for at most as long as its
own date — and the report says the entry did nothing.

**Refuse an already-expired date at parse time.** It would replace "the finding
comes back" with "the run does not start", which is a worse answer to the same
situation and, again, one that pushes a team to delete the step rather than the
line.

## Consequences

A team with forty findings can put the tool in CI on the first day, with forty
dated entries and forty reasons, and the report goes on carrying all forty. What
they cannot do is make anything quiet without saying why and until when.

The mechanism can still be abused: an entry with a reason of `known` and a date
three years out silences a critical finding for three years, and nothing here
stops it. What the design refuses is silence *by accident* — the entry is in the
configuration under review, in the report under `accepted[]`, on the finding row,
in `summary.accepted`, and in the sentence beside the exit code. Reviewing what a
team accepts is a human job and stays one.

The report grows a top-level `accepted[]`, a `summary.accepted`, an optional
`accepted` on a finding row and an optional `acceptedKinds` on a defect group.
All of it is additive, so `schemaVersion` stays `"2"` — a reader written against
it parses the file unchanged.

The console does not go quiet either, and that falls out rather than being
arranged: its headline reads `summary.byKind["privilege-escalation"]`, which
still counts the accepted row, so a run with an accepted escalation prints
`Privilege escalation: 1` in red above an exit code of 0 explained on the last
line. Loud about the finding, honest about the verdict, and no green sentence
anywhere near it.

What the console says about the acceptances themselves it says in one place
only: the reason beside the exit code, which `runVerdict` composes and the CLI
prints as its last line. A sentence
of its own in `report.warnings[]` would be the natural second home for the
"matched nothing" case, and it needs a colour declared beside it in
`src/cli.ts` — `WARNING_STYLE` is a total map over `WARNINGS` on purpose, so that
a warning cannot reach the file and miss the screen. That is left for the change
that touches the CLI.

Revisit if the deadline turns out to be the wrong bound in practice — if teams
routinely extend the same entry, the honest reading is that the deadline is
theatre and the entry is a policy rule that nobody wants to write. The number to
watch is `summary.accepted.expired` across runs.

## Note, 24 August 2026: the duplicate check was reading the human form

Two acceptances of one defect are refused, because two deadlines on one finding
would leave the file's meaning to the order of its lines. That check keyed on
`citableDefectKey` — the string this ADR exported for people to paste into a
ticket — while the report matches a finding with `acceptanceKeyOf`, built on
`defectSignature`. Two keys, one described in the code as being "exactly what the
report matches a finding on". It was not.

They differ in both parts. The citable form writes `any-resource` and `baseline`
where a coordinate is absent, and joins with a space; the signature writes
nothing and joins with NUL. Nothing reserves either sentinel, and both an
endpoint id and a context id are `z.string().min(1)`, so:

- an acceptance with no context and one naming a context called `baseline` had
  one citable key and two signatures — refused as a duplicate, though the report
  would have matched each to a different finding;
- `"orders.list own" + same-tenant + "c"` and `"orders.list" + own +
  "same-tenant c"` are one citable string and two signatures — the collision the
  comment above `defectSignature` says the NUL exists to avoid, reached through
  the key the check was using.

The check now uses `acceptanceKeyOf`, and the message still prints the citable
form, because that is the string the operator wrote and will search their file
for. Both cases are in `tests/io/accepted.test.ts` and both go red under the old
key — measured, not argued.

This is a change in which configurations are accepted, and it goes both ways.

Files that were refused for naming one defect twice when they named two are now
parsed. And an adversarial review of the same day found the other direction,
which the first version of this note denied: **a NUL written into an identifier**.
Nothing forbids one — `endpoint`, `context` and `kind` are `z.string().min(1)`,
and YAML writes `\0` in double quotes — so the signature, which is four parts
and always three separators, can be split two ways:

    "a"      + own + (no context) + "\0E"   and
    "a\0own" +       (no context) + "E"

One signature, two citable forms. Such a pair was accepted before and is refused
now — but it was never two acceptances in any useful sense: `indexAcceptances`
is a `Map` on that same signature, so the second entry silently replaced the
first and decided the deadline. The refusal is the better behaviour; the sentence
claiming there was no such case was not.

The premise underneath is what deserves the attention. `src/core/keys.ts` calls
its separator "a character that never occurs in an identifier", and nothing makes
that true — the same shape as the sentinel `baseline` above, one layer down. See
the note that follows this one if the identifiers have since been given a
grammar; until then this is a named limit and not a closed one.

The general lesson is the one ADR-0059 is about, in the direction nobody was
watching: a string built for people to read had become a map key. A form meant
for a human is allowed to be ambiguous — that is what makes it readable — and
that is exactly what disqualifies it from deciding identity.

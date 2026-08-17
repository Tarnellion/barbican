# ADR-0030: a defect is not the channel that found it

- Status: accepted
- Date: 17 August 2026

## Context

Findings collapse into defect groups so that the report says how many problems a
platform has rather than how large the matrix is. The signature was

```
endpoint × kind × relation × conditions
```

and `kind` is the kind of matrix discrepancy for one channel and the check's
identifier for the other. So the two channels could never merge.

An endpoint with no authorization on it at all answers a request it should refuse
**and** returns the same body to every tenant. That is one missing check, and it
produced two groups: `privilege-escalation` and
`identical-response-across-tenants`. Two rows, two keys, two tickets to the same
team, the second closed as a duplicate of the first.

The field is documented as a **lower bound** — `docs/report.md` says so, and
`groupDefects` says it at more length: two different bugs giving one signature are
indistinguishable from outside, the upper bound is the number of observations, and
the truth is somewhere between. Splitting one defect in two is the one thing a
lower bound may never do.

Not hypothetical, and not only on a constructed fixture: on the reference polygon
it happens in 3 of the 28 combinations, taking 7 defects to 6 and 13 to 11.

Found by the audit of 14 August 2026 (B-6).

## Decision

The signature drops `kind`:

```
endpoint × relation × conditions
```

and each group carries `kinds` — every way its cells were found to be broken,
sorted, at least one entry. Kinds of matrix discrepancy and check identifiers in
one list, because they are already one key space in `summary.byKind` and the
reader is asking what is wrong with an endpoint, not which half of the tool spoke
first.

`kinds` is deliberately **not** in the `key`. The key exists so that a ticket can
cite a defect and still point at it next month; a defect noticed a second way
would otherwise be renamed by the very run that learned more about it.

`relation` and `conditions` stay. They say **which cells** are affected, not how
the tool noticed: a BOLA inside a tenant and a cross-tenant leak on one endpoint
are different mechanisms, and so are a check that fires only under a declared
condition and one that fires in the baseline.

## Alternatives

**Merge only across the two channels, keeping matrix kinds apart.** This is what
B-6 literally asks for, and there is no principled way to do it: a check
identifier does not correspond to any particular matrix kind, so the rule would
have to be "merge a check finding into whichever matrix group is there", which is
an ordering accident dressed as a decision.

**Leave it and document that the count is not a lower bound.** Honest, and it
gives up the only number in the report that answers "how many problems do I
have". The count is the reason the grouping exists.

**Keep `kind` in the key and merge only the count.** Two names for one group, and
the array would have to hold one of them. Whichever was picked, the other would
be a defect the reader can see in `byKind` and cannot cite.

## Consequences

- `DefectGroup.kind: string` becomes `DefectGroup.kinds: readonly string[]`. A
  consumer reading `kind` gets a type error rather than `undefined`.
- The `key` loses its kind: `"orders.list any-resource baseline"` where it used to
  read `"orders.list privilege-escalation any-resource baseline"`. Keys cited from
  runs before this change do not resolve; there is no version of this fix where
  they do, since the whole point is that some of those keys named half a defect.
- `summary.defectGroups` can only go down. On the reference polygon: 3 of 28
  combinations change, none by more than two.
- Exit codes are untouched — they are derived from findings, not from groups — and
  the 28 ground-truth combinations still match, because the ground truth counts
  findings.
- The oracle's structural check follows the new signature and gains one: every
  kind a finding carries must appear in its group's `kinds`, and every name in
  `kinds` must come from a finding. Merging is only right if nothing is lost by
  it, and that is now asserted on all 28 combinations rather than argued here.

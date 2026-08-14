# 0012. A single format for the machine-readable oracle

- **Status:** accepted
- **Date:** 2026-08-12

## Context

There are now two oracles, and they diverged within a day.

| | `polygon/ground-truth.json` | `polygons/vampi/ground-truth.json` |
|---|---|---|
| variant container | `combinations` | `modes` |
| what defines a variant | `flags`: a map of env variables | `vulnerable`: a single boolean |
| a finding | `{account, endpoint, resource, kind}` | the same plus `defect` |
| taxonomy | `kinds` — kinds of discrepancy | `visibility` — what is visible to the tool |

The divergence is not cosmetic. The verification scripts (`verify.mjs`) are each
written for their own shape, and they share no code. A third polygon will add a
third. This is exactly the situation an ADR was created for: not "it is ugly" but
"validation is not reused, and every next polygon costs as much as the first".

Something else matters more: the VAmPI version turned out **richer in substance**,
and not by accident. In it a finding refers to a named defect, and a defect has a
visibility marker. This answers a question that has stayed unanswered until now and
is recorded in the task list as a separate item: **one defect produces as many rows
as there are cells it touched**. The crAPI run gave six rows for three BOLAs, the
reference-platform run ten rows for one missing filter. Without the link "finding →
defect" they cannot be collapsed at all: the tool sees cells, but what has to be
counted is defects.

## Decision

A single schema for all polygons. The VAmPI shape is taken as the basis, being the
more complete one, with a generalization of what defines a variant.

```jsonc
{
  "note": "…",                    // what this oracle is for and how it was written
  "cellKey": "…",                 // what the cell key is assembled from
  "target": "vampi" ,             // which polygon
  "defects": {
    "user-directory-public": {
      "title": "…",
      "visibility": "status",     // status | body-signal | invisible
      "note": "…"                 // what exactly it shows up as
    }
  },
  "variants": [
    {
      "id": "clean",
      "selector": { "POLYGON_DEFECT_CROSS_TENANT": false },
      "expectedExitCode": 0,
      "findings": [
        {
          "account": "alice",
          "endpoint": "orders.list",
          "resource": null,       // null on endpoints without parameters
          "other": null,          // the second account of the pair — for check findings
          "kind": "privilege-escalation",
          "defect": "user-directory-public"
        }
      ]
    }
  ]
}
```

Three decisions inside the schema deserve an explanation.

**`selector` is an opaque map, not a boolean and not a list of flags.** On VAmPI a
variant is defined by a single `vulnerable`, on our own platform by four variables,
on the next polygon it may be an image version or a compose profile. They have
exactly one thing in common: a set of "name → value" pairs which the verification
script passes to the deployment and then checks against what the deployment reports
about itself. The schema fixes the shape, and the meaning stays with the polygon's
script.

**`visibility` is required on every defect.** Three values: `status` — visible by
response code; `body-signal` — visible only through a scalar over the body
(ADR-0011); `invisible` — out of the tool's reach in principle. The last value
matters more than the first two: an oracle where unreachable defects are simply not
mentioned is indistinguishable from an oracle where they were forgotten. Writing
down explicitly "this defect exists and we will not find it" turns a coverage gap
from an omission into a statement.

**`defect` is required on every finding.** This is the link that was missing. It
gives the collapsing — "3 defects, 6 cells" instead of "6 findings" — and makes it
possible to check not only sets of cells but also sets of **defects**: a
verification that checks that all declared `status` defects were found and all
`invisible` ones were not answers the question of completeness, not only of
coincidence.

## Alternatives

**Keep two formats and factor the common code into a verification library.**
Rejected: there will be almost no common code while the shapes differ, and bringing
the shapes to a common one is precisely the decision above, only without a record of
it.

**Take the `polygon/` shape as the basis, it came first.** Rejected: it has no link
from a finding to a defect and no visibility marker, that is, it lacks exactly what
a single format is needed for. Being first is not an argument.

**Describe the schema as JSON Schema and validate with it.** Postponed, not
rejected. While there are two or three polygons, schema validation pays off worse
than checking by hand; at the fourth it is worth coming back to. It will require no
new dependency: validation of a schema this size is written by hand.

**Generate the oracle from the polygon's configuration.** Rejected outright, as in
ADR-0009: a reference produced by the system under test checks that system against
itself for consistency.

## Consequences

Both existing verification scripts are rewritten to the common shape, and a common
comparison module appears. The price is a one-off rework of two working scripts; the
test of success is the same as it was: after the rework all variants must come out
with no discrepancies, otherwise the rework broke something.

It becomes possible to report in terms of defects rather than cells. This closes the
task about collapsing, but not for free: the link "finding → defect" is filled in by
a human in the oracle, that is, it works on polygons and does not work on someone
else's deployment, where the defects are not known in advance. Collapsing in the
tool's own report is a separate task, and this ADR does not solve it.

Revisit if a polygon appears where a variant cannot be defined by a set of "name →
value" pairs — for example a deployment switched only by rebuilding the image.
`selector` would then have to be extended, and that is worth doing with a record
rather than silently.

## Clarification of 2026-08-12: a finding is explained by a set of defects, not by one

The schema above gave a finding a `defect` field — exactly one. While porting the
reference platform's oracle to this format it turned out that this does not work.

The completeness check reported immediately:

```
defect "POLYGON_DEFECT_PARENT_LEAK" is declared visible (status) yet expected in no variant
```

The reason is not in the data but in the schema. `PARENT_LEAK` raises visibility
upward by one level, `ANCESTOR_LEAK` along the whole chain, so **the cells of the
first are a subset of the cells of the second**. A shared cell is produced by either
of the two defects independently; attributing it to one means declaring the other
uncheckable.

The field becomes `defects` — a non-empty array. On the platform eight cells out of
two hundred and forty-one are explained by two defects at once; that is not sloppy
marking but an exact description of the nesting.

An empty array is forbidden: a finding that nothing explains is either a forgotten
defect or an error in the oracle itself, and accepted silently it devalues the
completeness check.

Attribution is derived **per variant**, not globally: in a variant with a single
flag enabled all findings belong to it, and in a composite one a cell is attributed
to every enabled defect whose single-flag variant contains it. The first attempt
built one global "cell → defect" map and on nested defects gave exactly the false
conclusion this clarification starts with.

## Clarification of 2026-08-12: six kinds of visibility instead of three

The original list — `status | body-signal | invisible` — did not survive the porting
of the VAmPI oracle. There every defect already carried a reason, and there turned
out to be four reasons, not one — three kinds became six:

| Kind | Why the tool does not find it |
|---|---|
| `body-only` | the difference is in the body, but is not expressible by a declared scalar — field values |
| `unsafe-method` | it lives on a write method, and without `--unsafe-methods` it is not probed |
| `excluded` | it would be visible, but the endpoint must not be touched: a request breaks the deployment |
| `out-of-scope` | the question is not about the role × endpoint matrix at all |

Collapsing them into a single `invisible` would erase the difference between four
different gaps, each of which is closed in its own way: one by extending the signals,
the second by the unsafe-methods flag, the third not closed at all and rightly so,
the fourth by a different tool. A gap whose reason is not named is indistinguishable
from laziness.

Only `status` and `body-signal` count as detectable; the completeness check requires
such defects to appear in at least one variant, and all the rest to appear nowhere.

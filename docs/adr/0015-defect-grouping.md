# 0015. Grouping discrepancies by defect signature

- **Status:** accepted
- **Date:** 2026-08-12

## Context

One defect in the platform touches as many cells of the matrix as there are, and
each one gives a row in the report. The numbers stop meaning what the reader
sees in them.

Measured on runs, not assumed:

- crAPI: **six rows for three BOLAs** — the same three defects, seen from the
  user's side and from the administrator's side.
- The reference platform: **ten rows for one** missing tenant filter.

"17 discrepancies found" sounds like "seventeen problems", but means "seventeen
cells touched". The difference matters: the first number speaks about the
platform, the second about the size of the matrix, which we set ourselves.

## Decision

Discrepancies collapse to a **signature**: the endpoint, the kind of
discrepancy, the relation to the resource. The report gets a `defects` field
with the groups and `summary.defectGroups` with their count; the rows themselves
stay in place as evidence.

Role is not part of the signature. If an endpoint was opened to a user and to an
administrator alike, the defect is one — a missing check — and not two.

Relation is part of it. BOLA inside a tenant and a cross-tenant leak live on the
same endpoint but break independently: these are different branches of
authorization and different defects.

### This is a lower bound, and it is written that way

The tool **does not know** the number of defects and cannot know it. Two
different bugs with the same signature are indistinguishable from the outside.

The example is not invented, it is from our own platform. In `all-six` mode the
group `orders.read × privilege-escalation × foreign-tenant` holds 12 cells — and
that is **two** defects: `POLYGON_DEFECT_CROSS_TENANT` (10 cells, brand
accounts) and `POLYGON_DEFECT_CROSS_HOLDING` (2 cells, the holding account). In
the platform these are different branches of `authorizeOrder` with different
filters; from the outside both give 200 where a denial was expected, on the same
endpoint under the same relation.

That is why the CLI prints "distinct defects: **at least** N", not "N". The
number of observations is the upper bound, the number of signatures the lower
one, and the truth lies between them. A tool that calls a lower bound an exact
value lies in its own favour.

## Alternatives

**Keep a flat list.** Rejected: a report where the size of the matrix is
indistinguishable from the number of problems gets read wrongly, and the longer
it is the more surely so.

**Collapse the rows, leaving one per group.** Rejected: the rows are evidence.
The statement "this account got this resource" is checkable, a summary is not.
Evidence must not be lost for the sake of brevity, so the groups are added
rather than replacing anything.

**Include the role in the signature.** Rejected: it gives exactly the inflation
we are moving away from. An endpoint open to everyone would turn into as many
defects as there are roles.

**Ask a human to declare the defects and link findings to them.** That is how
the machine-readable oracle of the polygons is built
([ADR-0012](0012-ground-truth-format.md)), and there it fits: the defects are
known in advance. On someone else's deployment they are unknown by definition —
if they were known, the tool would not be needed.

## Consequences

The summary starts answering the question "how many problems do we have" instead
of "how many rows". A group carries the highest severity of its observations, so
sorting by it gives the order to work through straight away.

The price is an underestimate where the platform breaks in several places that
look the same from the outside. There is no mitigation and there cannot be:
these cases cannot be told apart by HTTP responses. The only defence is not to
pass a lower bound off as an exact number, and that is what the wording does.

Revisit if a signal appears that tells branches of authorization apart from the
outside. Scalar signals over the body
([ADR-0011](0011-response-body-signals.md)) could in principle: a different
shape of response from different branches would give a different set of scalars.
For now that is a guess, not a measurement.

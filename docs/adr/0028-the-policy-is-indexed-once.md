# ADR-0028. The policy is indexed once, not scanned per cell

**Date:** 16 August 2026
**Status:** accepted. Keeps the core pure as
[ADR-0002](0002-pure-core-and-json-source-of-truth.md) requires, by the same
means as I-3: hoisting the work to the caller rather than caching it inside.

## Context

Resolving one cell read the **whole** policy. `resolveExpectedVerdict` looped
over every rule, and for every rule asked `Array.includes` of its endpoint list;
the loop deliberately ran to the end, because the last rule that matches wins and
an early exit would answer with the wrong rule.

That is once per cell, and a cell is account × endpoint × resource × conditions.
The audit of 14 August measured it twice over: trimming a policy from 440 rules
to 2 took `findUnauthenticated` from 275 ms to 21 ms, and took `describeCells`
from 622 ms to 344 ms — at which point the remainder was the regex work closed as
I-3. Filed as I-7.

The finding named the missing `break` as the defect. **That part of it is
wrong**, and the measurement above says why: the cost is not that the loop
overshoots the answer, it is that the loop is over the policy at all. A backward
scan with an early exit — the one rewrite that keeps "the last match wins" — is
no faster on the shape a policy actually has, because a hand-written policy opens
with a broad rule and narrows it afterwards, and the broad rule is the one a
backward scan reaches last.

## Decision

**The policy is arranged for lookup once, by `indexPolicy`, and the arrangement
is passed to the resolution.** Two levels, both keyed by what is compared
exactly:

- by **request conditions**, because they are compared exactly and absence means
  baseline rather than "any" — conditions no rule was declared under have no
  bucket at all, and the fallback is the whole answer without a rule being read;
- by **endpoint**, into the rules that name it and, separately, the rules that
  name any endpoint. The later of the two answers wins, which is the same "last
  rule wins" read across the policy: the rule numbers are the positions in it.

The two endpoint lists are kept apart rather than merged into one list per
endpoint. Merging reads better at the lookup, and costs a copy of every broad
rule for every endpoint the policy names — a policy of broad rules over a spec of
1 600 endpoints would pay for it in memory, and this project has a scale entry
open (I-6).

**The index holds the rules themselves, not copies of their selectors.** A copy
is a second description of the same thing, and the description nobody reads is
the one that goes wrong. What the index adds is a number — the rule's position in
`policy.rules`, which is what the report cites.

**The scan for the last match stays a scan to the end.** Over the candidates, not
over the policy. This is the same rule as before and the same code shape; only
the list it runs over is different.

**The caller builds the index.** `walk` builds one per walk, `findUnauthenticated`
one per pass. A memo inside the resolution would fix the same numbers and put
mutable state in the core, which has none by design — the argument is I-3's,
verbatim, and it is binding here for the same reason.

Measured on a synthetic matrix of 41 accounts × 200 endpoints × 20 resources
(47 150 cells) against a 440-rule policy, before and after — median of seven
repetitions, and of three such runs:

| | before | after |
|---|---|---|
| `describeCells` | 1 095.6 ms | 51.6 ms |
| `findUnauthenticated` | 1 118.3 ms | 46.0 ms |

With the same policy trimmed to 2 rules the walk takes 32.8 ms before and 34.4 ms
after — that is the walk without a policy worth scanning — so what the policy
costs in a walk went from about 1 063 ms to about 17 ms. The verdicts themselves
are unchanged: the same 47 150 cells and 21 639 discrepancies, digest for digest,
before and after.

## Alternatives

**A backward scan with an early exit.** The finding's own suggestion, and correct
— the first match found from the end *is* the last match. Rejected as the fix
because it does not answer the measurement: the broad rule at the top of a policy
is exactly the case where the scan runs to the far end, and that is the case
policies are written in. It also trades a rule that is stated once ("run to the
end, keep the last") for one that has to be re-derived by every reader.

**A memo inside `resolveExpectedVerdict`.** Same numbers, mutable state in the
core. Refused before, for `resourceApplies`, and refused again.

**Keeping a direct scan for the one-shot entry point.** `resolveExpectedVerdict`
now builds an index and throws it away, which costs a single question more than
the old scan did: 0.21 → 1.83 µs on a 5-rule policy, 17.7 → 98.4 µs on a
440-rule one. Keeping the old loop beside the new one would have avoided that,
and would have left two ways to work out what a cell expects. ADR-0020 says what
to do with a second way to obtain a verdict: delete it, do not reconcile it. The
one-shot is documented as what it is — prepare the policy, ask one question — and
a caller with many questions is told, in the same doc comment, to call
`indexPolicy` once. Everything in this repository that asked in a loop now does.

## Consequences

- Five names on the public surface: `indexPolicy`, `resolveIndexedVerdict`,
  `PolicyIndex`, `ContextRules`, `IndexedAccessRule`. The surface is already too
  wide and undocumented (E-6); these five carry doc comments that say when to
  reach for them.
- `resolveExpected` and `resolveExpectedVerdict` keep their signatures and their
  answers, and get slower per call. Nothing in the tool calls them in a loop any
  more; a library consumer who does will find the note in the doc comment before
  the profiler finds them.
- The index is built from a `ResolvedAccessPolicy`, that is, after
  `expandPolicy`. Patterns never reach it, which is what
  [ADR-0006](0006-expected-access-declaration.md)'s expansion step already
  guaranteed for the resolution.
- What is not fixed: the walk still visits every cell. This removes a factor from
  the constant, not the shape of the term. I-6 and the ceiling entry stand.

# ADR-0029: evidence rows have a budget, counts do not

- Status: accepted
- Date: 17 August 2026

## Context

The isolation check compares accounts pairwise. On an endpoint that returns the
same response to everybody it therefore emits one finding per pair — quadratic in
the number of accounts — while the one guard that bounds a run, `--max-requests`,
is linear in them and defaults to 2 000.

Measured on 17 August 2026, one endpoint, every account in its own tenant, every
response identical:

| Accounts | Requests | Findings | `JSON.stringify` |
|---|---|---|---|
| 100 | 100 | 4 950 | 1.65 MB |
| 200 | 200 | 19 900 | 6.64 MB |
| 2 000 | 2 000 | 1 999 000 | `RangeError: Invalid string length` |

The last row is inside the default budget. The walk completes, the checks
complete, the defect is correctly identified — and then the run is lost at its
final step to an error that names a string length and nothing an operator did.

Two facts make this cheaper to fix than it looks. The first is that the report
**already** collapses all 4 950 rows into one defect group: the summary a human
reads is right at every size above. The second is that everything a verdict
depends on — `summary.findings`, `summary.byKind`, `summary.bySeverity`, the
defect groups, the cell verdicts, the exit code — is computed from the full set
before any row is written. The rows themselves are evidence: examples of a thing
already counted.

The audit of 14 August 2026 raised this as I-5 and I-6 and left it as "nothing to
measure against until somebody runs it at that size". Somebody has now run it at
that size.

## Decision

The report carries at most **50 evidence rows per defect**, and `findingsOmitted`
says how many it left out. Every count in the file is taken before the cap.

**Per defect, not over the list.** A first-N cap over the flat array would let
the endpoint leaking to two thousand accounts spend the entire budget, and the
second, rarer defect would arrive listed in `defects` with no evidence row to
cite. The rare one is the interesting one. The signature is the one the grouping
already uses — `defectSignature`, exported for this — rather than a second notion
of "the same defect" that would drift from the first.

**Fifty.** The constant is decided by the many-defects case, which is what
actually bounds a file: 200 endpoints leaking to 50 accounts produce 245 000 rows
across 200 defects — 4.5 MB at fifty rows each, 13.9 MB at two hundred. With a
single defect the constant barely shows, 0.55 MB against 0.60 MB, because the
observations dominate. So fifty costs nothing where it does not matter and three
times less where it does, and fifty examples is far past the point where a reader
stops looking for the pattern.

**A warning, not an exit code.** `truncated` means cells were never probed and
the absence of findings there means nothing, so it forces exit 2. This is the
opposite case: everything was probed, everything was counted, and the file is
abridged. The verdict is unchanged and must stay unchanged; what the reader gets
is `findingsOmitted` and a warning saying which numbers to trust.

## Alternatives

**Report one finding per collision class instead of per pair.** The right answer
information-theoretically: n accounts sharing a digest is one fact, not n(n-1)/2.
It is also a change of shape — `relatedAccountId` becomes a set, the report and
the schema follow, and every expected finding count in the hand-written
`polygon/ground-truth.json` moves. Rewriting the oracle to agree with a code
change is the thing this project has a rule against. Left open deliberately; the
cap does not preclude it, and with the cap in place nothing is on fire.

**Stream the JSON instead of building one string.** Fixes the `RangeError` and
nothing else: the file would then be 660 MB of rows that collapse to one defect.
The size is the problem, not the serialiser.

**Raise the cap when few defects were found.** A cap that varies with the run
means two reports of the same platform can disagree about what evidence they
carry, for a reason found nowhere in either file.

**Do nothing and document the ceiling.** What the audit assumed. It stops being
defensible once the failure is reachable inside the default request budget and
presents as a `RangeError`.

## Consequences

- `RunReport.findingsOmitted` is new. `schemaVersion` stays `2`: a reader written
  against 2 does not break on a field it does not know, which is the same
  reasoning applied to `checksRun.description`.
- `findings.length + findingsOmitted === summary.findings` holds, and is tested.
- `summary.findings` may exceed `findings.length`. Any consumer counting the
  array to learn how many problems were found was already wrong for a truncated
  run; now it is wrong for an abridged one too, and the file says so.
- 2 000 accounts on one endpoint now produce a 0.55 MB report with the right
  counts and exit code, where they used to produce a `RangeError`.
- The polygon is unaffected: eight accounts never approach fifty rows in any one
  defect, so the 28 ground-truth combinations are untouched.

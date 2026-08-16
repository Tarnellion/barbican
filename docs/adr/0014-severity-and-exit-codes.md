# 0014. Finding severity and exit code semantics

- **Status:** accepted
- **Date:** 2026-08-12

## Context

Two related problems, both of which surfaced on runs.

**All findings weigh the same.** The run against crAPI gave 17 discrepancies in
one list: a leak of someone else's order stands there next to a public QR code
with nothing sensitive in it. The reader of the report has nowhere to start. The
task was written into the plan long ago and was phrased as a "severity scale".

**An unexpected denial does not affect the exit code.** `unexpected-denial` is
described as "not a vulnerability, but a discrepancy with intent", and the exit
code ignores it. This was not discovered by reasoning: while checking the oracle
of the reference platform, a holding was cut off from its own brand — the
platform is broken, the declared access does not work — and barbican returned
**0**. The run looked successful.

An industry review showed this is not harmless. In multi-brand gambling, the
absence of end-to-end visibility between brands is a regulatory violation: the
UKGC fined 888 £7.8m because self-exclusion did **not** carry over between
brands (see `docs/research/igaming-contours.md`). Excessive isolation is
punishable there just as much as insufficient isolation.

## Decision

### Severity is derived from the relation, not declared

`AccessDiff` gets a `severity` field. The value is computed mechanically:

| Discrepancy | Relation | Severity |
|---|---|---|
| `privilege-escalation` | `foreign-tenant` | **critical** |
| `privilege-escalation` | `ancestor-tenant`, `same-tenant`, `descendant-tenant` | high |
| `privilege-escalation` | no resource (access to a function) | high |
| `privilege-escalation` | `own` | medium |
| `unexpected-denial` | any | medium |
| `not-observed` | — | low |
| `probe-error` | — | low |

The scale has a fifth level, `info`, and the table above does not use it: a
discrepancy of the matrix is never merely informational. It exists for checks
from the registry, which assign severity themselves — a check may have something
to say that changes nothing about access.

This does not contradict [ADR-0006](0006-expected-access-declaration.md). A
human declares the **expectation** — what is meant to be granted and what is
not. Severity, on the other hand, is a property of a discrepancy that has
already been found, and it follows from the model mechanically: a leak into a
foreign tenant is plainly heavier than access to someone else's resource inside
your own. No judgement about business consequences is made here, and the tool
must not make one.

`own` gets `medium` deliberately: an account's access to its own resource,
declared forbidden, is almost always a mistake in the policy, not a hole in the
platform. Lowering it here is more honest than a false alarm at the high level.

### Exit code 1 means "reality diverged from what was declared"

Any discrepancy — an escalation and an unexpected denial alike — gives **1**.

The old logic silently assumed the tool looks for vulnerabilities. It looks not
for those but for **discrepancies between declared intent and observed
behaviour**; that has been written into its purpose from the very start. A
discrepancy is a discrepancy whichever way it points. On top of that, the tool
cannot determine which side is wrong — the platform or the declaration — and
since it cannot, it has no right to stay silent.

The meaning of the codes stays three-valued:

- **0** — tested, no discrepancies;
- **1** — tested, there are discrepancies;
- **2** — the result cannot be trusted (no observations, the run was cut short,
  the accounts did not authenticate). The 2 takes priority: what was not tested
  is never clean.

`not-observed` and `probe-error` do not give code 1: these are gaps in coverage,
not discrepancies. They are already accounted for by the 2 when there is no
coverage at all.

## Alternatives

**Leave `unexpected-denial` without effect and rely on the summary.** Rejected:
the summary is read by a human, the exit code by a pipeline. A tool that stays
green in CI while the declared access is broken will be used in exactly that way.

**A separate `--strict` flag for unexpected denials.** Rejected: it turns
honesty into an option. A default under which a discrepancy does not count as a
discrepancy is wrong, and the flag merely lets you not know about it.

**Let a human declare severity in the policy.** Rejected as a first step: a
field that has to be filled in by hand on every rule will stay empty. If an
override is needed, add it on top of the computed value, not instead of it.

**Take the CVSS scale.** Rejected: CVSS requires a vector that cannot be
reconstructed from the outside, and it would create an appearance of precision
that does not exist. Five levels are exactly as many as the tool is able to tell
apart.

## Consequences

The report becomes sortable, and it gains something for the reader to start
from. A run with broken declared access stops being green.

The price is a change of contract: pipelines where `unexpected-denial` counted
as acceptable will go red. That is the right direction, but it has to be said in
the CHANGELOG at the next release, not left to be discovered on one's own.

Revisit if a need appears to tell severities apart within one relation — for
example, to separate reading payment data from reading a reference list. That
would require a declaration from a human and therefore a separate decision.

## Addendum of 2026-08-15: a usage error is not a discrepancy

The three-valued contract above was stated as if the tool were the only thing
that ever sets an exit code. It is not. commander exits **1** on an unknown
option, a missing required one, or a value its parser rejects — and 1 in this
document means "tested, there are discrepancies".

So `barbican run --unsafe-metods` reported as a privilege escalation. In CI,
where the exit code is the whole interface, it reported as one silently: the
explanation goes to stderr, which a pipeline usually does not read once the code
has already said "failed for a known reason". The failure mode is the same one
the 2 exists to prevent, pointing the other way — there, an untested run looks
clean; here, an unstarted run looks like a finding.

**A usage error exits 64**, `EX_USAGE` from `sysexits.h`. The line is drawn at
the start of the run: what the argument parser rejects is 64, and anything that
fails after it — an unreadable configuration, an unwritable report path, a
platform that does not answer — stays 2. Nothing was sent in the 64 case, and
that is the whole difference the code is carrying.

`--help` and `--version` needed a condition rather than being separate paths:
commander reports printing them as an exit too, and marks them with `exitCode:
0`. They stay 0.

The callback is set on every command and not only on the root — commander does
not pass it down to subcommands, and it is the subcommand that handles
`barbican run`, which is where every usage error that matters happens. Set by a
loop over the registered commands, so a command added later cannot be forgotten.
Proved by mutation: removing the loop turns the polygon gate red naming the
case.

`process.exitCode` rather than `process.exit()`, which is what commander would
otherwise call: the report goes to stdout by default, and a hard exit can
truncate a write that has not drained.

**130 is documented, not introduced.** An interrupt part-way through the walk
gives the ordinary `128 + SIGINT`, and no report is written. It was missing from
the table, which listed three codes for a tool that can return five.

Found by the audit of 14 August 2026 (G-5, G-6).


## Addendum of 2026-08-15: one threshold, and a name that cannot be borrowed

The decision above says a discrepancy is a discrepancy whichever way it points.
The code had two thresholds. A matrix discrepancy failed the run at any
severity; a check finding needed `high` or `critical`. So the same statement —
the platform disagrees with what a human declared — failed a build when the
status showed it and passed when the response body did.

**A check finding fails the run at any severity but `info`.** That is the same
line the matrix channel has, where `not-observed` and `probe-error` do not fail
either: `info` is the level for a note rather than a disagreement, and it is what
a check uses to say something without failing somebody's build. Nothing
registered today emits below `high`, so no run changes today — which is exactly
when a threshold should be fixed.

**And the verdict counts rows, by source, instead of reading `summary.byKind`.**
That map holds kinds of matrix discrepancy and check identifiers in one key
space. A check registered as `privilege-escalation` had its findings counted
there as matrix ones: reported to the reader as privilege escalations and read by
the exit code as such. Registering such a check is refused now —
`ReservedCheckIdError`, for the same reason the signal name `digest` is refused
when a configuration is parsed — but `runVerdict` takes a `RunReport` from
anywhere, and a consumer assembling one by hand never passes the registry. Both
guards, because they cover different callers.

The test helper had to be fixed to see any of this. It set the counters from
numbers and left `findings` empty — a report `buildReport` cannot produce — so a
verdict reading counters instead of rows looked correct. It now builds the rows
and counts the map from them, which is what B-14 is about and half of what it
asked for.

Found by the audit of 14 August 2026 (B-3, B-4).

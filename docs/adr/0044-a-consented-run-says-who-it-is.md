# 0044. A consented run says who it is

- **Status:** accepted
- **Date:** 2026-08-21

## Context

README and `docs/guide.md` both open the subject of running against somebody
else's platform with the same requirement — get the owner's agreement in writing,
naming the deployment and the window — and both are honest about why: "that is
what an intrusion looks like from the inside — from the logs, from a WAF, from
whoever is on call". README ends the section with the sentence this ADR is
about: *someone has to know that the traffic in their logs is yours.*

Nothing made that possible. Review of 21 August 2026, two findings.

**M-6 — the run was not signed on the wire.** `grep -ri "user-agent" src/`
answered nothing, so every request this tool has ever made went out under node's
own default, `user-agent: node`. The `runId` the report is filed under is minted
by `buildReport` and never left the file. There was no way to add a header to
every request either: `contexts[]` is a separate matrix row with a mandatory list
of endpoints (ADR-0019), which is a declaration about what is being measured and
not a signature on the traffic.

So the owner who gave permission could not do any of the four things permission
is given in order to make possible: pick the run out of a SIEM, filter it out of
an availability graph, keep it from tripping an anti-fraud rule, or match their
own records against the report they were handed — except by time. Meanwhile the
report keeps `x-request-id`, `x-correlation-id`, `x-trace-id`, `traceparent` off
the **response** on the value allowlist, added specifically so that a finding can
be matched against a record on the platform's side. Correlation had already been
judged worth having, and had been provided in one direction only.

**M-7 — the report goes to stdout when `--report` is absent**, and nothing said
so: not README, not the guide, not `docs/report.md`. The same document written to
a path is created `0600` through a staging file, with a comment beside it
explaining exactly why — it "carries every request address, every response header
and the identifiers of accounts, resources and tenants". Left to the default it
goes to the build log, which is readable by everyone who can see the build and
kept for as long as the build is. The stronger of the two paths was the one an
operator had to know to ask for.

## Decision

**A run names itself on the wire, by default, in `user-agent`.**

The value is composed by the tool and carries three things:

```
barbican/0.4.0 (+https://github.com/Tarnellion/barbican#readme; run=<runId>)
```

what this is and which release of it; where to read about it at three in the
morning; and which run — where `run=` is the identifier the report is filed
under, so a filter in the platform's own tooling leads back to the specific
artifact.

`--no-identify` turns it off.

**The identifier is minted at the start of the run, in `src/cli.ts`.**
`buildReport` mints one too and has to keep doing so — a report without a `runId`
cannot be told from the next one, and a consumer of the library may build a
report having sent nothing. But it runs after the last response has come back,
which is the wrong end of a run for a value that must be on the first request.
Where a run happened, the run's identifier is the one the report carries.

**The header is applied in the HTTP client**, not by the code that builds each
request. That is the same seam ADR-0032 moved the address grammar to, for the
same reason: `send` is the one place every request of a run passes through — the
walk, `probeCanaries`, and a consumer of the library holding a client of their
own. A marking applied at three of four doors is a marking absent from the
fourth, and the canaries go first, so that fourth would have been the platform's
first impression of the run.

**A request that already carries the name is refused before the wire**, with
`RunIdentityConflictError`. A device condition is plausibly declared as a
`user-agent` attribute, and HTTP folds two values under one name into one
comma-joined string: neither the declared condition nor the run's identity would
then arrive as written. The operator renames the attribute or passes
`--no-identify`.

**The flag is a boolean, and the value is not an operator's to write.** This is
the load-bearing half of the design rather than a simplification. A string from
the command line going into every request of a run is precisely the channel
`assertAttributesKeepTheBasis` guards — exact names, family prefixes, and a check
**by value**, which is what catches a method override smuggled under a vendor
header nobody has heard of. Because nothing here arrives from outside, that check
has nothing to catch: the name is a hardcoded constant and the value is assembled
from this package's own `version` and `homepage` and a `randomUUID`. The grammar
is still asked — `runIdentity` builds the pair through `headerName` and
`headerValue`, so `RunIdentity` cannot be assembled out of raw strings from
either door (ADR-0024) — but it is asked of the tool's own composition, which is
a guard against a mistake rather than against an adversary. If this ever takes an
operator's string, it becomes a request condition by another name and has to live
by ADR-0019's three layers.

**And the CLI warns when the report is going to stdout on a real run**, before
the walk, where the answer can still be changed without spending someone else's
traffic twice. Not on `--dry-run`, which produces no report to misplace.

### Why the default is on

The same side this project takes everywhere else. Only `GET` and `HEAD` without
`--unsafe-methods`; no run at all without an explicit host allowlist; throttling
that cannot be switched off. Each of those defaults protects the party that did
not choose to be in the conversation — the owner of the platform — and costs the
operator a flag when they want the other thing.

Here the party harmed by silence is that owner, who cannot separate a consented
audit from an attack in their own logs. The party helped by silence is an
operator deliberately measuring what an unannounced sweep looks like, which is a
decision, and a decision can say so on the command line.

It is also not a header being added. `user-agent: node` was going out already: a
value this project never chose, would not defend, and could not have told anyone
about. What changes is that the field says something true.

### Why `user-agent`

The question is what the *other* side records. `$http_user_agent` is in nginx's
`combined` format, in Apache's `combined`, in an ALB access log, and in every
pipeline built on top of those. A header of this tool's own invention —
`x-barbican-run` — appears in none of them until somebody on the platform's side
changes a log format first, which is work asked of exactly the person the marking
is a courtesy to.

## Alternatives

**Off by default.** Considered seriously, and it is the honest counter-argument:
a marked run tells the target it is being scanned, and a WAF may answer it
differently — in which case the run measures the WAF's opinion of a known tool
rather than the platform's access control. That is real, and it is the reason the
flag exists at all. It is not a reason to make it the default: the case it serves
is a deliberate red-team exercise, and this tool's documented purpose is the
audit somebody signed for.

**A dedicated header, in addition or instead.** Rejected above: invisible where
it needs to be seen, and two headers is twice the surface for one fact.

**Let the operator supply the string** — a ticket number, a change-request id.
Genuinely useful, and refused here: it is a header value from outside on every
request, which is the shape ADR-0019's three layers exist for, and it would drag
the whole of that check into a place that currently needs none of it. If it is
wanted, it is its own decision.

**Reuse `contexts[]`.** A set of request conditions is a matrix row with a
declared scope, not a signature. Making it run-wide would break what a context
means.

**Refuse to run without `--report`**, instead of warning. Rejected:
`barbican run … > report.json` and piping into `jq` are legitimate and common.
What is not legitimate is not knowing.

## Consequences

Runs against a platform that filters by `user-agent` may be answered differently
from before, which is the point and can be undone with `--no-identify`. A
platform that rejects unknown agents outright will now be met with a name it does
not know instead of `node`; neither was on an allowlist, so this changes nothing
for it.

A configuration that declares a `user-agent` attribute in `contexts[]` stops at
the first request with `RunIdentityConflictError` rather than silently sending
both values. The message names the header and both ways out.

**The report does not record whether the run announced itself.** That is an
asymmetry with `throttle`, which is in the report precisely so that "throttling
is always on" need not be taken on trust, and it should be closed the same way —
a field beside `runId`. It is deliberately not done here: `src/report/build.ts`
belongs to another change in flight, and adding a field to `RunReport` moves
`schemaVersion` and the generated JSON Schema with it. Until then the operator's
own transcript is the only record: the summary prints the exact string the run
was named by, or says that `--no-identify` was given, and `--dry-run` prints it
before anything is sent.

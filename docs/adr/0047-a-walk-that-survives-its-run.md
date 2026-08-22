# 0047. A walk that survives the run that made it

- **Status:** accepted
- **Date:** 2026-08-21

## Context

Nothing this tool observes reached disk until the walk was over. `collectObservations`
held its observations in an array and returned them, `buildReport` turned them
into a document, and `src/cli.ts` wrote that document — one write, at the end,
after the last response had come back. Every way of ending a process short of
that line returned nothing at all: Ctrl-C, often because the owner of the
platform asked for it; the OOM killer, at a measured peak of 11–13 KB of resident
memory per cell; a CI job cancelled on its timeout, which arrives as SIGTERM; the
network going away. `grep -rn "SIGINT\|process.on" src/` matched nothing.

What is lost in that moment is not compute. It is traffic already sent against a
deployment that is not ours, inside a window somebody agreed to in writing, and
that window may not be open again this week. The project has said as much for
some time — `src/cli.ts` already argues it beside the failed report write: "the
run is already paid for in traffic against someone else's deployment: losing the
result now would mean spending it twice." That argument was applied to the last
step of a run and not to the step before it.

The same fact from the other end: an operator whose run met `--max-requests` on
the 1900th cell of 9000 had exactly one answer available, which was to start
again and spend those 1900 requests a second time. `truncated: true` told them
honestly that the tail was untested; it did nothing to keep the head.

## Decision

**The walk is written to disk as it happens, and a run can be continued from what
is there.** Four decisions, each with a reason it went the way it did.

**1. NDJSON beside the report, and only where there is a report.**
`<report>.stream.ndjson`, one JSON document per line, created `0600` and appended
as each cell finishes. A line per cell is what makes the file usable after a
process is killed mid-write: the last line may be half a document, and dropping
exactly that one costs one cell.

Where `--report` is absent there is no stream. The report then goes to stdout,
which is the operator's own decision about where a document of this sensitivity
may live — it carries every request address, every account, tenant and resource
identifier, and a map of the places the platform's authorization does not hold.
Inventing a path in the working directory would put the same data somewhere
nobody asked for. The run says so instead, in the same breath as the existing
warning about stdout: without `--report` nothing is written until the walk is
over, and an interruption takes every request with it.

A completed walk removes its stream. The report is the artifact; a second copy of
the same data that nothing ever deletes is not. It survives only a walk that did
not finish — including the case where the report itself could not be written and
went to stdout.

**2. A signal leaves a report, and still ends the way a signal ends a process.**
SIGINT and SIGTERM abort the walk instead of killing the process. The cells
already answered become a report with `truncated: true`, which `runVerdict`
already reads: the run ends at code 2 with "the tail of the matrix was never
probed, and the absence of findings there means nothing". Then the handler is
removed — restoring the default disposition — and the signal is raised again, so
a shell and a pipeline still see 130 and 143. A second signal goes straight
through, because the second Ctrl-C means the operator has stopped negotiating.

The verdict is the point, not the file. A report that a stopped walk produced and
that came back `0` would be the worst of both: an artifact saying "clean" about a
matrix nobody finished. `truncated` is checked ahead of everything except "not a
single cell was probed", and a walk stopped in its first seconds earns that one
instead — also 2, and also true.

A cell the stop caught in flight is **not** recorded and not counted. Recording
it would file a request the platform never answered as an answer, and `--resume`
would then skip it. The same holds for a cell that ended in a terminal error — an
exhausted budget, a tripped breaker: it stays in this run's report as the failure
it was, and it is left for whoever resumes to probe.

**3. `--resume` refuses anything but the same declaration.** The stream's first
line is a header carrying a digest, and a run given `--resume` compares its own
before the canaries and before the walk. A mismatch stops the run, exit 2,
nothing sent.

The digest is not `configDigest`, and the difference is worth stating because
`docs/report.md` sells that field as the way to tell "the platform changed" from
"we changed the declaration" — which is the question here. Two reasons it cannot
be the one used. It is minted by `buildReport`, at the end of a run, and this gate
has to hold before the first request of the next one. And it covers the run
configuration alone, while which cells exist is decided by the configuration
**and** the endpoint document, and what is sent inside them by `--unsafe-methods`
and `--no-identify`.

So the stream's digest is taken over the documents themselves — sha256 of the
configuration text and of the endpoint source, plus the two flags, plus the
resolved values of the request conditions, plus the tool's version. Over the text
rather than over what the text parses into, deliberately: `parseRunConfig` is a
function of its source, so one text gives one configuration and a changed
configuration cannot come out of an unchanged text. Where the two overlap this
digest is therefore strictly stronger than `configDigest`. It also refuses a
reformatted file with no change of meaning, and that direction is the right one
to be wrong in — a false refusal costs a fresh run, traffic the operator was
about to spend anyway, while a missed change costs a report assembled out of two
declarations and presented as one. Those two prices are not comparable.

The version is in it because what a status means, which cells exist and how a
verdict is reached are all a particular build's to decide, and half a matrix
decided by another build is not a run this one can answer for.

Behind the digest sits a second lock that does not depend on it:
`collectObservations` refuses a resumed record that fits no cell of the matrix it
is about to walk (`ResumeDoesNotFitError`), after the task list exists and before
the first request.

A resumed run **adopts the interrupted run's `runId` and `startedAt`.** Both
halves of the walk then carry one identifier on the wire and the one report they
produce is filed under it, which is the whole of what ADR-0045 bought: the owner
of the platform filters one run out of their logs, not two, and lands on one
document. The cells taken from the stream are placed at the index the walk would
have put them at, so the report's `observations` array is in the same order an
uninterrupted run would have produced.

**4. The bytes of the report do not change.** No field was added to `RunReport`.
The polygon's oracle parses the file and compares it cell for cell, and a reader
diffing two runs would see an unrelated change in every line. The consequence is
named under Consequences below: the report cannot say *what* cut a run short.

## Alternatives

**Streaming to a temporary directory when `--report` is absent.** Rejected. The
stream holds what the report holds, and choosing a location for that on the
operator's behalf is the decision `--report` exists to make. Saying plainly that
there is no safety net is the honest half of the same choice.

**A `--stream <path>` flag of its own.** Rejected: a second path could only ever
be a way to point the report and the stream at two different runs.

**Opt-in streaming.** Rejected. Protection you have to remember to ask for is
protection you do not have on the run that needed it, and the cost of having it
always is one small file that a completed run deletes.

**Rebuilding the report out of the stream.** Rejected, and firmly. The stream
must not become a second source of truth: the report is assembled from
observations, and what the stream does is carry observations from a run that died
into a run that continues it. A second assembly path is how two documents that
disagree about one matrix get made.

**Appending to the existing stream on resume.** Rejected. Opening an existing
path for append follows a symlink sitting there, and this file carries every
address the run touched — the finding V-7 of 21 August made about
`<report>.partial`, in a second file. A resumed run rewrites the stream through a
staging file and a rename, exactly as `writeReportFile` does, which also compacts
the half-written last line a killed process left behind.

**A field naming the reason for truncation.** Rejected for now: it changes the
bytes of every report, and the oracle compares them. What matters for trust is
that the tail was not probed, which `truncated` already says.

**Hashing token values into the digest.** Rejected. A token is a secret and this
digest lives in a file. The gap it leaves is named below.

**`fsync` per cell.** Rejected: the write reaches the operating system, which is
what survives a process being killed, and a per-cell `fsync` would cost more than
the request it accompanies. A machine that loses power loses the tail.

## Consequences

An interrupted or killed run now leaves two files where it left none: a report
that says the tail was never probed, and a stream to continue from. `--resume`
turns 1900 wasted requests into 1900 requests not made again.

What it costs:

- **The report cannot say what stopped the run.** A walk cut short by SIGTERM and
  one cut short by an exhausted budget produce the same `truncated: true`. The
  terminal says which; the file does not. Revisit if the report's shape changes
  for another reason anyway.
- **A different, still valid token for the same account passes the gate.** The
  digest covers the names of the environment variables and not their values. The
  canary confirms that the token in force works, which is not the same as
  confirming it is the same token. An operator resuming a run must be resuming it
  as the same principals.
- **A resumed report's `startedAt` is the first leg's**, so the interval between
  it and `finishedAt` includes the time the operator spent away. That is the
  honest reading — the observations really do start there — and it makes the two
  timestamps a poor measure of how long the walk took.
- **A stream left behind by a run nobody resumes is a file at the sensitivity of
  a report, sitting in the operator's directory.** A fresh run at the same
  `--report` path replaces it and says so.
- **The walk carries a write per cell.** It is one small append against a
  request, and it is awaited, so a slow disk applies backpressure to the walk
  rather than growing a buffer. A stream that cannot be written disables itself
  and says so once: the run's traffic is already spent, and losing the safety net
  is not a reason to lose what it was there to catch.

## Note of 2026-08-22: what Windows can and cannot answer for

The release of 0.5.0 turned the Windows job red on three of this ADR's tests, and
the failures were right: two of the promises above are POSIX promises, and the
tests asserted them everywhere.

**A signal cannot be delivered.** `subprocess.kill("SIGINT")` on Windows does not
signal anything — POSIX signals do not exist there, and node maps the call onto
`TerminateProcess`, which ends the target outright. The handler cannot run, so
the graceful half of this decision — stop the walk, write what was observed,
re-raise the signal — is unreachable from CI and from a test. A `SIGINT` typed
into a console window still reaches a node process, so the behaviour is not
absent on Windows; it is unreachable from anything that can be automated, which
for the purpose of a gate is the same thing.

What Windows does answer for is the half that needs no handler, and it is the
half this ADR was written for: the stream is written as the walk goes, so a
process killed outright still leaves the cells it had walked, and `--resume`
still has something to continue from. That is what the Windows test asserts now.

**`mode: 0o600` on the stream is POSIX only.** `chmod` there sets and clears one
attribute — read-only — and ignores every other bit, so the file comes back
`0o666` whatever was asked for. This is the same boundary ADR-0038 records for
the report itself. The test checks the mode on POSIX and the file's existence on
Windows, rather than asserting a promise the platform does not let the tool make.

The third failure was not a boundary but a test that leaned on one: the
`--resume` case reached its half-walked state by interrupting a run. It reaches
it by exhausting `--max-requests` now — which is the case this ADR is written
from, and which every platform can produce.

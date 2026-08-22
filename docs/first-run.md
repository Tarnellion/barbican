# The first run against a platform you do not own

Eleven things to settle **before the first request**. None of them is new — each
one is a decision this tool has already made and written down somewhere, in
[guide.md](guide.md), in [report.md](report.md) or in an ADR. What is new is the
order, and the fact that they are in one place: spread across a long guide they
are findable by somebody who has already read it, which is not the person about
to make the traffic.

The guide answers *how to declare*. This answers *what you are about to do to
somebody else's system, and what the answer will be worth*.

If you are running against the reference platform in `polygon/`, or against a
disposable stand of your own, most of this does not apply and you should skip to
the guide. The subject here is a deployment with real accounts on it, real
monitoring, and somebody on call.

---

## 1. Permission, in writing, naming the deployment and the window

Not a Slack "sure, go ahead". A message that names the deployment, the window,
and — because these are the two things that outlive the run — whether
`--unsafe-methods` is in scope and where the report will live.

The reason is not paperwork. Several accounts sweeping a surface for places where
one reaches another's data is, from the logs, from a WAF, from whoever is on
call, indistinguishable from the thing this tool is used to find. Nothing in the
defaults changes that; they keep the traffic small, not permitted.

Include in that message:

- **the account identifiers the run will use.** They are the ones that may need
  unlocking — see item 11 and "The run's own blast radius" in the guide;
- **the `runId`**, or the promise to send it when the run starts (item 8);
- **`--unsafe-methods`, in its own sentence**, if you intend to pass it. A
  cancelled order stays cancelled after the report is written; barbican does not
  undo what it did.

## 2. Scope: `allowedHosts`, and a `label` that names the system

`allowedHosts` is mandatory and the run refuses to start without it. An entry
without a port allows any port; an entry with one allows exactly that port. Every
tenant `baseUrl` has to be in the same list.

This is the boundary of "a check" versus "a scan of somebody else's system", and
it is the reason redirects are not followed: a `3xx` to another host would take
the request outside the list you agreed.

`target.label` is optional and its absence is meaningful. `https://api.example.test`
does not tell a production-like deployment from a demo stand, so a report with no
label cannot be filed as a ticket against anything. Write what the owner calls
the environment, plus the release if they version it.

## 3. `exclude`: the only guard against a GET that does something

Safe mode is a check on the **method**. It is not a promise about the endpoint: a
GET is not obliged to be safe in practice, and `/createdb` resets a database
while remaining one. The tool called exactly such an address on the VAmPI
polygon, which is why `exclude` exists.

Nothing derives that list for you. Read the endpoint list you are about to feed
in, and exclude by id anything whose name suggests it acts: reset, seed, rotate,
sync, export, purge, anything ending in an imperative verb. `--dry-run` prints
every endpoint with what will happen to it, and reading that list out loud is the
cheapest review this tool offers.

## 4. A canary per account, and one a stranger cannot pass

A canary is an endpoint the account is known to reach, probed before the walk and
again after it. **Every account with a `tokenEnv` needs its own**; without one
the run exits `2` and names the accounts. A run that cannot confirm it
authenticated has not tested what it claims: a deployment answering `401` to
everything, against a policy made of denials, produces a report with no findings
where every cell says "tested and agreed".

The trap is choosing the canary. `/health`, `/version`, `/api/status` answer 2xx
to anybody, and they are exactly what comes to mind when a document asks for "an
endpoint this account can reach". A dead token passes such a canary, and the run
comes back clean having tested nothing. So each canary now also goes out **with
no credentials at all**, and a 2xx to that request stops the run by name
([ADR-0040](adr/0040-a-canary-has-to-tell-somebody-from-nobody.md)).

Pick an endpoint that returns *this account's* data and that the account's own
role is not denied by the policy. If a role is denied everywhere by design — a
blocked customer, say — it needs one door the block leaves open, or nothing can
tell that account from a wrong token.

## 5. The arithmetic: how many requests this actually is

```
requests  =  cells  +  3 × (accounts with a canary)
cells     ≈  accounts × endpoints × resources, per set of request conditions
```

Three per canary, not two: before the walk, after the walk, and the one with no
credentials from item 4.

`--dry-run` prints the exact number, and sends nothing:

```
Matrix rows: 27 (declared accounts 9)
Cells a run would probe: 144, plus 24 canary requests (8 accounts, probed before
the walk and again after it, plus one request each with no credentials to show
the canary tells them apart)
```

It also warns when `--max-requests` on the same command line is below that total.
The default is `2000`, which is a ceiling on the *run*, not a target: exceed it
and the walk stops part-way, the report says `truncated: true`, and the exit code
is `2` — the tail was never probed, so the absence of findings there means
nothing.

**Run `--dry-run` first, and paste its output into the agreement.** It is the
answer to "what exactly are you going to touch", given before the first request
rather than after the last.

## 6. The walk against the lifetime of a token

At the default `--rps 5` a walk of `N` cells takes about `N / 5` seconds: 1 800
cells is six minutes, 7 000 is a little under half an hour. Compare that with how
long the credentials live. A token that expires mid-walk turns every remaining
cell into a `401` — a denial, which agrees with a policy of denial and is counted
as tested and agreed.

The safety net is the canary probed after the walk: such a run exits `2` and the
account is named in `staleCredentials`. That is a way of finding out afterwards.
The way of not needing to is to keep `cells / rps` comfortably inside the token's
lifetime, and to cut the matrix rather than raise `--rps` when it is not.

**From code there is a third option.** `CredentialProvider.headersFor` is called
for **every** request, the canary ones included, so an implementation of that
port can mint or refresh a token as the walk runs — that is the same seam request
signing lives on ([ADR-0018](adr/0018-request-signing-is-a-port-concern.md)). The
CLI's own provider cannot: it reads the variables named by `tokenEnv` once, at
startup, and sends what it read.

## 7. How large a matrix stays practical

Roughly:

- **up to ~7 000 cells** is comfortable — about 5 MB of report at the measured
  0.72 KB a cell, and under half an hour at the default rate;
- **from ~30 000 cells** it stops being practical: a 30 MB report needs about
  1.3 GB to parse back, which is a problem for whoever receives it rather than
  for the run;
- **where the hard wall stands is the target's decision, not yours.** The report
  is written in chunks now, so the old ceiling on the file is gone, but it moves
  with how many headers the platform answers with: **692 000** cells at six
  response headers, **74 000** at 126
  ([ADR-0038](adr/0038-the-report-is-written-in-chunks.md)).

None of these is a limit the tool enforces, and the number that binds first is
usually `--max-requests`. The practical advice is the one in the guide: twenty
endpoints with the relations declared honestly say more than two hundred where
every scope was guessed — and on a first run against somebody else's deployment,
a small matrix is also the polite one.

## 8. How they will recognise the traffic

Every request carries a `user-agent` naming the tool, its version and the run:

```
barbican/0.4.0 (+https://github.com/Tarnellion/barbican#readme; run=3f2a…)
```

`run=` is the `runId` of the report the run produces, and that is the point of
it. The owner who agreed to this can pull the run out of an access log or a SIEM,
keep it out of an availability graph, show an anti-fraud rule what it was, and
tie all of that to the exact JSON document you hand them
([ADR-0045](adr/0045-a-consented-run-says-who-it-is.md)). Without it the only
thing connecting your report to their records is the clock.

So: send them the identifier, or agree that you will when the run starts. It is
printed in the run's summary and by `--dry-run`.

`--no-identify` sends the run unannounced. There is one honest reason for it —
you are deliberately measuring what an unmarked sweep looks like, WAF included —
and it is a thing to say out loud in the agreement, along with what will stand in
for the identifier. A set of request conditions that declares a `user-agent`
attribute of its own stops the run rather than folding two values into one.

## 9. Where the report goes

**Without `--report` the report goes to stdout**, which in a pipeline is the
build log: readable by everyone who can see the build, kept as long as the build
is kept, and copied into whatever collects logs. With `--report` it is written to
that path and created `0600`, owner only.

The difference matters because of what the document is. No response bodies, no
credentials — those are kept out by construction — but every request address,
every account, tenant and resource identifier, and a list of the places where the
platform's authorization does not hold. On somebody else's platform that is a map
of their unlocked doors, and it is yours to keep until they have it.

Name a path, or redirect it, and agree where it will live before it exists.

## 10. What an interruption costs, and `--resume`

The expensive part of a run is not the time. It is traffic already spent inside a
window that may not open again this week.

A run with `--report` streams each finished cell to `<report>.stream.ndjson`
beside it, `0600` like the report. Two things follow
([ADR-0047](adr/0047-a-walk-that-survives-its-run.md)):

- **Ctrl-C and SIGTERM still leave a report.** The walk stops, what was observed
  is written, and the process then ends the way the signal would have — `130` and
  `143`. The report says `truncated: true` and carries exit code `2`.
- **`--resume` continues where it stopped**, adopting the interrupted run's
  `runId` and start time so both halves of the traffic lead to one document. It
  refuses, before the first request, if the declaration is not the one the stream
  was written under. A completed walk deletes its stream.

Two things `--resume` cannot check, and they are yours: it hashes the *names* of
the environment variables, never their values, so resume as the same principals;
and it says nothing about what the platform deployed in between.

**Without `--report` there is no stream**, and an interruption costs the whole
run. On a deployment you do not own, that is reason enough to always pass it.

## 11. What the run will not see, whatever the report says

A clean report is a statement about what was asked. These are the things the tool
**structurally cannot see**, and each of them makes a green run mean less than it
looks:

- **A platform that refuses with 200** and puts the outcome in the body reads as
  "allowed" everywhere — every denied cell becomes a privilege escalation, and
  the body checks are poisoned with it. One look at a cell you are certain about
  settles it. See "A platform that refuses with 200" in the guide.
- **Four statuses it cannot read**: a refusal that redirects (`302` to a sign-in
  page, which is how an operator console on a session cookie refuses); `202`,
  where admission to a queue is not the same as permission; a soft delete, where
  `404` and `410` answer everybody alike; and `405`, which is about the endpoint
  and not about who asked. Those cells drop out of the verdict rather than into
  it.
- **One probe per cell.** Every row is a single sample, retried only on `429`,
  `5xx` and a failure on the wire. One `200` off a stale replica is a `critical`
  that is not there; one `403` off the node that has the rule hides one that is.
- **Whether a request condition arrived.** A proxy can strip the header, and then
  the conditioned requests simply repeat the baseline ones while the report says
  the restriction does not work.
- **Granted access.** The five relations describe belonging. On a platform with
  sharing, an ACL or guest links, a legitimate share and a leak are the same
  `same-tenant` cell.
- **How much API there is.** `endpointsTotal` counts the list you handed in. If
  the platform has a hundred endpoints and you gave six, the report does not know
  that and cannot.
- **The write half**, unless `--unsafe-methods` was passed —
  `coverage.writeMethodsProbed` says which.

And two costs of the run itself, which belong on this list because they are also
invisible in the file: the job holds every role's live credentials at once, and a
run is shaped like a credential attack. Both are written up under "The run's own
blast radius" in the [guide](guide.md#the-runs-own-blast-radius) and in
[report.md](report.md).

---

## The short version

1. Permission in writing: deployment, window, accounts, `--unsafe-methods`, where
   the report lives.
2. `allowedHosts` set, every tenant host in it, `target.label` written.
3. `exclude` read off the endpoint list by hand.
4. A canary per account with credentials — one that returns that account's own
   data.
5. `--dry-run`, and its output pasted into the agreement.
6. `cells / rps` well inside the token's lifetime.
7. A matrix small enough to be worth reading.
8. The `runId` sent to whoever is on call.
9. `--report <path>`, never the build log.
10. `--resume` available, because `--report` is set.
11. Everybody who reads the result knows what it does not cover.

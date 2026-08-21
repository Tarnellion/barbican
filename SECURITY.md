# Security policy

`barbican` is pointed at somebody else's platform, from a terminal that holds
live credentials for several roles at once. It reads documents it did not write —
an OpenAPI specification, a Postman collection, a list of endpoints — and turns
them into requests. It is published to npm with provenance, so whatever it ships
runs on machines that never read this repository.

That is a tool with an attack surface of its own, and until 21 August 2026 the
only way to tell anyone about a hole in it was a public issue — which is
publishing the exploit before the fix.

## Where to report

**GitHub → the [Security tab](https://github.com/Tarnellion/barbican/security) →
Report a vulnerability.** The report is private to the maintainer until it is
published, no account beyond GitHub is needed, and it carries its own thread for
the back-and-forth.

**Please do not open an issue.** `bugs.url` points at the public tracker and that
is where ordinary bugs belong; a report filed there is a disclosure, and it is
one nobody can take back.

**Email:** *PLACEHOLDER — this repository declares no security address.* Nothing
here is a working mailbox, and this line stays marked as a placeholder until the
owner replaces it with one. Until then GitHub is the only private channel, and if
private reporting is turned off on the repository, say so in a public issue
**without the finding** and the maintainer will open the channel.

## What counts as a vulnerability in this tool

Not what barbican reports about your platform — that is the tool working. What
matters here is barbican doing something it promised not to:

- **A request the run was not told to make.** A write with `--unsafe-methods`
  absent, a request to a host outside the allowlist, a redirect followed off it,
  a path that reaches an endpoint the configuration excluded. Three adversarial
  reviews have found this class in the address grammar and its callers — see
  [ADR-0032](docs/adr/0032-the-grammar-sits-at-the-seam.md).
- **Data leaving where it must not.** A response body, a header value that is not
  on the allowlist, a token or a customer's data reaching the report, the logs or
  the terminal. The report is meant to be shareable; the guarantee is
  [ADR-0011](docs/adr/0011-response-body-signals.md) and
  [ADR-0005](docs/adr/0005-tool-safety-invariants.md).
- **A clean verdict over something that was never tested.** An account whose
  token is dead reading as denied everywhere, a truncated run reported as a whole
  one, a cell counted that was never sent. A false `match: true` from a tool
  people use to decide their platform is safe is the worst thing this project can
  ship — see [ADR-0033](docs/adr/0033-a-canary-is-per-account.md).
- **A document that takes over the run.** A crash, a hang, a file read or a
  network call out of an OpenAPI or Postman document — external `$ref`s are not
  resolved for exactly this reason, and a hole in that is a report.
- **The supply chain.** The published tarball not matching this repository, a
  lifecycle script, a dependency pulled in without the cooldown, provenance that
  does not verify.

Not a vulnerability: a finding barbican reports about the platform you pointed it
at, a vulnerability in that platform, or a documented limitation — a platform
that refuses with `200`, an undeclared tenant tree, anything under "Not yet" in
the README. Those are worth an issue, in the open, where they can be argued.

## Please do not send credentials

A report needs the shape of the problem, not a run against a real platform: a
minimal configuration, a fixture, the endpoint list that triggers it. Real tokens,
real host names and a real report file make the maintainer's inbox a place where
your production credentials sit — and rotating them afterwards is your work, not
the maintainer's. Redact, or reproduce it against one of the
[polygons](docs/polygons/).

## What to expect, honestly

This is a personal open-source project with one maintainer and no security team
behind it. What can be promised is only what one person can keep:

- **An acknowledgement within 7 days.** If nothing arrives in that time, assume
  it did not reach anybody and say so publicly — without the finding.
- **An assessment within 14 days:** whether it is accepted, what it affects, and
  which released versions are involved.
- **A fix when there is one.** No date is promised, because a date one person
  cannot keep is worse than no date. Where a fix will be slow, you will be told
  so and told why.
- **Coordinated disclosure.** The advisory goes out with the release that fixes
  it, naming you if you want to be named. If 90 days pass without a fix, publish;
  that is your call to make and you do not need permission for it.
- **No bounty.** There is no money behind this project.

Only the newest published version is fixed. There is no long-term support branch,
and there will not be one while this is one person's project.

## The cost of all this

A private channel means the report is invisible while it is open: nobody else can
see it, correct it, or notice that it went unanswered. That is a real cost, and
it is paid to a single maintainer's attention. The 7-day line above exists so
that the cost has a limit — after it, going public is the right move rather than
a breach of etiquette.

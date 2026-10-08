# 0076. A permissive cross-origin policy is a registered check

- **Status:** accepted
- **Date:** 2026-10-01

## Context

Module 1 finds what a status code shows: who reached what, against a declared
policy. Module 2 (the evidence pack) was added by registering a check and a
catalogue rather than by rewriting the core, which is the prediction ADR-0003
made the two-module split on. `identical-response-across-tenants` was the first
check to read something a status code cannot show — the response body, as an
irreversible digest — and it proved the shape: a new class of defect arrives as
a `Check` over the matrix, not as a change to the walk.

A permissive cross-origin resource sharing (CORS) policy is the next such class,
and it is squarely in this tool's lane: it is an access-control failure read off
the response, not a payload crafted into the request. A platform that answers a
cross-origin request with `Access-Control-Allow-Credentials: true` and an
`Access-Control-Allow-Origin` that trusts the wrong origin is telling the browser
to hand an authenticated response to script on another origin. That is a
cross-origin authorization defect, and the status code is 200 either way.

Three things about it decide the design, and two of them are boundaries:

- **Most CORS layers answer only a request that names an `Origin`.** Nothing this
  tool sends carries one on its own initiative — the address and the headers are
  the tool's to build, and it does not invent probes. An operator declares a
  request condition with `{ headers: { origin: "..." } }`; `origin` is not among
  the names a condition may not set (it is neither a credential, nor a transport
  header, nor a routing family), so this is expressible today. The check reads
  **every answered cell**, the baseline included, so a platform that sends the
  headers unasked is reported with no declaration, and a platform that sends them
  only to a named origin is reported where a declared condition names one.
- **The dangerous origins divide into the conclusive and the contextual.** `*`
  and `null` with credentials are wrong whatever origin was asked: the Fetch
  standard forbids a wildcard in credentials mode, and the `null` origin is what
  a sandboxed iframe, a `data:` document and a `file:` page send — any attacker
  can put script in one. A **specific** origin echoed back with credentials is
  the common and more dangerous case (reflection), and it is **not** conclusive
  from the response alone: an echoed `https://app` could be a reflection of
  whatever was sent, or a legitimately allowlisted partner.
- **The core does not carry the sent origin.** An observation holds the response
  — status and allowlisted headers — but not the request's `Origin`. In the core
  a request condition is a `contextId` label; the attribute itself lives in the
  adapters (ADR-0019). So the reflection case cannot be settled where a check
  runs, and settling it would mean guessing.

## Decision

**`permissive-cors` is a registered check over the matrix**, citing OWASP
API8:2023 (security misconfiguration). It reads `access-control-allow-origin` and
`access-control-allow-credentials` off each observation and reports one finding
per endpoint × condition for the two conclusive shapes:

- `*` with credentials — **medium**. Browser-rejected as it stands, so not
  directly reachable, but a CORS layer that emits it is not reasoning about
  credentials and is the kind that reflects a real origin once the wildcard is
  removed.
- `null` with credentials — **high**. Reachable from a browser as it stands.

The two response headers are added to the value allowlist in
`src/adapters/http.ts`. Neither carries a secret — an origin is a host and a
scheme, the credentials flag is a boolean spelled as a word — and without their
values the check reads `[REDACTED]` and finds nothing, which is the false "clean"
a redacted signal always is. This is an ADR-0005 decision because the allowlist
is one: the names that may ever carry a secret cannot be enumerated, so the list
grows one reviewed entry at a time.

**Reflection of an arbitrary origin is out of scope and out of the claim.** The
check does not flag a specific origin, and says so in its own description and in
its module comment. Closing that gap needs the sent origin in the matrix — either
carried onto the observation, or reached by comparing the echoed origin against
the origin the declared condition sent — and that is a decision of its own, left
for when a second reason to carry it arrives. A guess about access is the
false-positives risk `plan.md` is written against; the two conclusive shapes need
no guess.

The check reads `observation.headers` by its own fixed header names and only as
own properties (`Object.hasOwn`): a report read back from JSON carries
`Object.prototype`, and a consumer feeding observations from their own harness
may hand over an object whose prototype carries one of the names. This is the
concern `lookup()` answers in `src/io/untrusted.ts`, open in the core by hand
because the core may not import `src/io` — the ring ADR-0024 keeps from closing.

## Alternatives

- **The matrix channel answers for it.** Rejected: `standardsForDiff` maps a
  *discrepancy between the declared policy and the platform* onto a clause, and a
  CORS policy is not a discrepancy of that kind — it is a property of the response
  headers, not a verdict about who access was granted to. ADR-0041 drew exactly
  this line for the matrix channel, and this is the other side of it. Making
  `permissive-cors` a check is what ADR-0003 is for, and it makes API8 the first
  clause a check carries that the matrix channel does not — recorded in
  `tests/invariants/a-clause-nothing-answers.test.ts`, which predicted this day.
- **Flag a reflected specific origin too.** Rejected for now: not conclusive from
  the response alone (see Context), so it would be a guess. Deferred until the
  sent origin is in the matrix.
- **Cite CWE-942 (permissive cross-domain policy) as well.** Not done: the bundled
  CWE definition is scoped to the CWE-284 access-control hierarchy, and 942 sits
  outside it (under CWE-668). Widening that definition is a separate decision, and
  API8 is a sufficient and honest mapping for the pilot.
- **Send the `Origin` from the tool rather than from a declared condition.**
  Rejected: the tool does not invent probes, and the address and headers are its
  to build from what a human declared. A condition is how a human asks for this
  one.

## Consequences

- A new class of defect ships as a check and a clause, touching neither the walk
  nor the core — the Module 2 shape, used a second time.
- The OWASP API 2023 catalogue grows from three clauses to four; the pack lists
  seventeen catalogued clauses rather than sixteen, and `permissive-cors` answers
  API8 down the check channel alone.
- A clean result is not a proof of absence, and the coverage cannot make it one for
  the two shapes that need no declaration. A correct platform answers an origin it
  does not trust with no CORS headers at all, exactly as one with no CORS layer, or
  one that was never sent an origin, does, so an empty coverage for this check does
  not say which. Whether a condition that sends an origin was walked is in
  `coverage.contextsProbed`. ADR-0078 adds a declaration for which the question
  *can* be told apart, `foreignOriginCellsAnswered`.
- The evidence pack has no denominator for the check channel
  ([ADR-0052](0052-a-clause-can-be-reported-as-exercised.md)), and API8 is the
  first clause only a check reaches. It reads `answered-without-findings` on any
  run where the check ran and reported nothing, **including a run in which no
  request carried an origin**, and the row's own text says that this is not the same
  as there being nothing to report. An earlier version of this record said the pack
  reads an empty coverage as "the question was not asked". It does not read the
  coverage at all.
- On upgrade from 0.7.0 a configuration that declares nothing about origins can
  start to exit 1, because the check is registered by default and reads baseline
  cells: a target that decorates every response with `*` and credentials is now
  reported. That is a true statement about the response, and the release notes say
  it.
- Three new exported values — `createCorsCheck`, `CORS_CHECK_ID` and
  `API_SECURITY_MISCONFIGURATION` — and two response-header names kept by the
  allowlist.

### Limits

What this check does **not** catch, written down because a gate is described by
what it misses as much as by what it holds (ADR-0065):

- **Reflection of an arbitrary origin with credentials** — the common case, out
  of reach until the sent origin is in the matrix. This is the largest gap and it
  is deliberate.
- **A policy that answers only a named origin, on an endpoint no declared condition
  names an origin for.** The platform sends nothing back, so nothing is read, and
  the coverage looks the same as for a correct platform. The check does not go
  looking.
- **A credentials flag spelled other than the exact lower-case `true`.** `True`
  and `1` enable nothing in a browser, so they are correctly not flagged — but a
  platform that reflects while writing a non-standard flag is invisible here, and
  that is the same "the browser is the arbiter" reasoning that keeps `*` below
  `null`.
- **`Access-Control-Allow-Methods` and the preflight.** The check reads the
  simple-request response, not the `OPTIONS` preflight; a policy permissive only
  on a non-simple method is not seen.

## Addendum: reflection, closed under a declaration (ADR-0078)

The first limit above, reflection of an arbitrary origin, is no longer wholly out of
reach. [ADR-0078](0078-an-origin-is-called-foreign-by-the-operator.md) adds a
context field by which an operator declares the origin it sends to be one the
platform must not trust, and the check then judges a platform that echoes it. What
this record decided stands as written: the check still does not flag a specific
origin that nobody declared foreign, for the reason given, and that case is still
the largest gap. What changed is that the premise this record could not supply, which
origin is not to be trusted, now has a place to be declared.

## Addendum: a header finding does not judge the cell (second pre-release review)

The alternative rejected above, that the matrix channel answers for a cross-origin
policy, was rejected in the record and quietly accepted by the report. A check
finding narrows the cell it names ([ADR-0022](0022-one-verdict-per-cell.md)),
so a platform whose every cell agreed with the declared policy, with one header
finding, had those cells flipped to `match: false` and the evidence pack called
ASVS 8.1.1 and 8.2.1 breached, "the platform and the declared policy disagree",
above "evidence rows: 0 recording a disagreement". That sentence is false of this
platform.

A finding may now say `aboutAccess: false`, and `permissive-cors` says it on every
finding. Such a finding leaves the cell's verdict as the walk gave it, and still
counts in the exit code, the defect groups and its own clause: API8 is breached by
it, and the access-control clauses are not. It keeps its cell for the request that
reproduces it, and a finding that names no resource now carries the request of the
account's first cell by resource on an endpoint that takes an object, which it did
not before. `Finding.aboutAccess` and `docs/report.md` carry the details.

## Addendum: the check says whether it was asked (ADR-0079)

The consequence above, that the pack reads API8 as `answered-without-findings` on a run
in which no request carried an origin, no longer holds. `permissive-cors` declares a
reach (`crossOriginCellsAnswered`, fed by the contexts the CLI says send an origin),
and a pack reads a run where that total is zero as `inconclusive`: the check ran and
was never asked. A clean result is still not a proof of absence, and a positive total
is not a statement that the platform is sound. See
[ADR-0079](0079-a-check-says-whether-it-was-asked.md).


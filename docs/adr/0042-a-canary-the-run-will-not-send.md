# 0042. A canary the run will not send is a configuration error

- **Status:** accepted
- **Date:** 2026-08-21

## Context

`assertCanariesUsable` checked four things before a run: a canary on an unknown
endpoint, on a templated one, on an excluded one, and on one the policy denies
that account's role. It did not check the method.

`planEndpoints` has four reasons for not probing an endpoint —
`excluded`, `path-parameters`, `unsafe-method`, `escapes-target` — and a canary
pointing at an endpoint the run will not probe is a mistake in the declaration
whichever reason applies. Three of the four were covered. `unsafe-method` was
not, and the two halves of the tool then said different things about the same
file. Adversarial review, 21 August 2026 (V-5), on `canary: login` where `login`
is `POST /login` and `--unsafe-methods` is absent:

    DRY RUN exit 0
      login  (POST /login)  skip: a write method, and --unsafe-methods was not given
      Cells a run would probe: 1, plus 3 canary requests

    REAL RUN exit 2
    Run aborted: The canaries did not pass, the run stopped:
      bob: login did not answer (TRANSPORT)
    The platform did not answer at all: nothing reached the application, so this
    says nothing about the tokens. Check the address, the port and that the
    deployment is up.

Nothing went on the wire: `UnsafeMethodError` fires inside the client, and
safe-by-default held exactly as written. What failed was the diagnosis.
`failureCode` walks the cause chain looking for a transport code, an error this
project threw itself carries none, and the reason falls through to `TRANSPORT` —
the one code whose sentence sends the reader to check an address, a port and the
liveness of a deployment. All three were fine. The defect was three lines up in
their own configuration, and the tool had every fact needed to say so before the
first request.

The preview was inconsistent with itself in the same breath: it printed the
endpoint as skipped for its method and counted three canary requests against that
same endpoint in the summary below — an arithmetic describing a run nobody can
perform.

## Decision

A fifth check in `assertCanariesUsable`: a canary whose endpoint's method is
outside `SAFE_METHODS`, while `allowUnsafeMethods` is not set, raises
`UnsafeCanaryError` — naming the account, the endpoint, the method, and the flag
that would change the answer.

It sits after the checks that read the endpoint list alone and before the one
that needs the policy. Ahead of the policy check deliberately: it is the more
fundamental of the two, so an operator who acts on it is left with a canary that
can actually be sent, while one who acts on a policy contradiction first would
meet this error next.

`allowUnsafeMethods` is threaded through `probeCanaries` as well as the CLI, and
absent means no. A consumer of the library reaching `probeCanaries` directly is
the same door `collectObservations` turned out to be in
[ADR-0032](0032-the-grammar-sits-at-the-seam.md), and it gets the same sentence
the CLI does rather than the platform's silence.

Because the function is called from `--dry-run` and from the walk, the message
has to be true of both. It states what the run would do and never that a request
was made or that a platform answered — which is precisely the direction the
sentence it replaces got wrong.

## Alternatives

**Carry the real cause through to the summary** — teach `failureCode` about
`UnsafeMethodError` so the canary line says "a write method" instead of
`TRANSPORT`. It fixes the sentence and keeps the shape: a configuration mistake
discovered by attempting it, reported as a property of the run rather than of the
file, after the tool has already decided to start. It also leaves `--dry-run`
saying exit 0 about a run that cannot happen. The rule this project already
applies to the exclusion list is the better one: refuse before the traffic.

**Skip the canary instead of refusing.** A canary that is silently skipped is an
account whose credentials nothing confirms, which is the state
[ADR-0033](0033-a-canary-is-per-account.md) exists to end. The run would then
exit 2 for a missing canary, one layer further from the cause.

**Let `--unsafe-methods` be implied for canaries.** A canary is a request like
any other; issuing a `POST` because it was nominated as a canary is exactly the
write that flag exists to withhold, and it would be issued up to three times per
run.

**Cover `escapes-target` as a sixth check.** It is the one skip reason still not
mirrored here, and it was left alone after checking why: every path that reaches
it is already refused at the door by `isUsablePathTemplate`, so no endpoint
source can produce one. The door a hand-built `Endpoint[]` comes through can, and
there `joinUrl` raises `PathEscapesTargetError` before any request, naming the
path and the address it resolved to. A second check would duplicate a guard that
already says the true thing at the right time.

## Consequences

Configurations naming a write endpoint as a canary stop working, and stop before
the first request, in the preview as well as in the run. They were already not
working; they were reporting it as the platform's fault.

The preview no longer contradicts itself. Every canary request it counts is one
the run would make, because each of the other three skip reasons is refused
earlier in the same function and the fourth cannot be produced by an endpoint
source.

`probeCanaries` now refuses a write canary unless the caller passes
`allowUnsafeMethods`. For a library consumer running with unsafe methods
permitted this is a behaviour change, and it is the safe-by-default direction:
forgetting the flag produces a named configuration error rather than a canary
quietly cleared for a method the client would refuse.

Revisit if `SAFE_METHODS` ever becomes per-endpoint rather than per-run: the
check asks one question of the whole run, and a per-endpoint permission would
need the same question asked per canary.

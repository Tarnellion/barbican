# 0033. A canary is per account

- **Status:** accepted
- **Date:** 2026-08-19

## Context

A canary is an endpoint an operator nominates as "this account can reach this,
and it needs its credentials to". It exists because a run that authenticated as
nobody produces a matrix of refusals, and a matrix of refusals agrees with a
policy of denials. ADR-0014 gives that case exit code 2: what was not tested is
never clean.

The rule was written per run. `runVerdict` asked `canariesChecked === 0`, and one
canary on one account satisfied it for every account of the run.

Adversarial review, 19 August 2026: two accounts, alice with a working token and
a canary, mallory with `POC_TOKEN_MALLORY=THIS-TOKEN-IS-DEAD` and no canary of
its own. Every cell of mallory's answered 401, the policy declares mallory denied
everywhere, so the matrix agreed with the policy — `match: true` on every row.
Exit 0, no warning, and the claim the run was making about that account is the
most valuable one this tool produces: *a guest reaches nothing*.

The `findUnauthenticated` safeguard cannot reach this by construction. It is
"declared accessible, and granted nowhere", and it needs `expectedAllowed > 0`.
An account the policy denies everywhere has zero, so the safeguard stays silent
on exactly the account nothing else can speak for.

The two texts had also drifted from the rule. The warning said "no account has a
canary", the sentence beside the exit code said the accounts were not
authenticated at all, and both were computed from a count.

## Decision

Every account with credentials needs a canary of its own that passed. Where one
does not have it, the run exits 2 and the verdict names the accounts.

The answer is computed once, in `unconfirmedCredentials`, and read by both the
warning and the verdict — the pair that was written twice is what drifted within
four days.

Three details the implementation is deliberate about:

- **A row under request conditions is not a separate principal.** It is the same
  account with the same token making a differently shaped request, so the base
  account's canary clears it. Otherwise the rule would demand a canary on a row
  no operator can declare one on.
- **Anonymous accounts are outside the rule.** There is nothing to confirm, and
  demanding a canary of "check that nobody at all can get in here" would forbid a
  legitimate run.
- **The outcomes decide, not the count.** `canariesChecked` stays in the report
  as a number to read; the verdict reads `canaries[].authenticated`. A canary
  that came back 401 confirms nothing, and a fixture carrying a count beside an
  empty list is a report `buildReport` cannot produce — which is what let the
  per-run rule pass every test in the repository.

## Alternatives

**Accept "the account was granted access somewhere" as confirmation.** It is
unsound: a public endpoint answers 200 to anyone, so a 200 does not show the
token was accepted. The canary is the only declaration that says "this needs
credentials".

**Warn without changing the exit code.** A warning on a run that exits 0 is read
as "clean, with a note". This project's own reference platform and its examples
already declare a canary on every credentialed account, so the strict rule
matches the practice the documentation teaches.

**Infer a canary — pick some endpoint the policy declares accessible.** That
would derive the check from the same declaration it is meant to test, which is
the mistake ADR-0006 exists against.

## Consequences

A configuration that ran on 0.4.0 with fewer canaries than credentialed accounts
now exits 2 until the missing lines are added. The preview names them:
`--dry-run` lists the accounts owed a canary, in the colour the finished run uses
for the same warning.

`report.warnings[]` carries a different `noCanary` string. A consumer matching on
its text will not match; the field to read is `verdict.reason`, which names the
accounts.

**There is a configuration this rule cannot satisfy, and it is worth naming.** An
account that carries a token and that the policy denies *everywhere* has nowhere
to put a canary: `assertCanariesUsable` refuses a canary on an endpoint the policy
denies to that role — rightly, since the two declarations would contradict — and
without one the run now exits 2. Found by the second adversarial pass of the same
day, on the fix itself.

That is not a hole to be plugged with an escape hatch. It is the tool saying
something true: where a platform grants an account nothing at all, no request
distinguishes a dead token from a lawful denial, and the run's central claim
about that account — "it reaches nothing" — rests on the token having been live.
The ways out are both declarations of fact rather than concessions: name the one
endpoint the account *is* allowed to reach and make it the canary, or drop
`tokenEnv` and run the account anonymously, which is the honest shape of "check
that nobody at all can get in here". The verdict's reason says both.

What would change this is a way to confirm authentication that does not go
through the access policy — an endpoint declared as "answers 2xx to a valid token,
whatever the policy says about access". That is a new declaration, and it needs
its own ADR rather than a field added in passing.

Revisit if an authentication scheme appears where no single endpoint can serve as
a canary. The shape of the answer then is a declaration that says how to confirm
authentication, not the removal of the requirement.

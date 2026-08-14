# 0008. Run configuration format

- **Status:** accepted
- **Date:** 2026-08-12

## Context

ADR-0006 ruled that expected access is declared by a human, but did not say what
it is declared in. A run needs four things: where the system under test is, which
accounts to make requests as, what those accounts are meant to get, and which
specification describes the endpoints.

A separate difficulty: accounts need credentials, while the declaration of
expected access is, by the intent of ADR-0006, an artifact that gets reviewed and
versioned. These two properties conflict: a file with tokens in it cannot go into
a repository.

## Decision

**One configuration file** in YAML or JSON — parsed by the same `yaml` that parses
specifications (JSON is a subset of YAML 1.2), and no new dependency is required.
The specification is passed separately: it is a document of the system under test,
not our configuration.

```yaml
target:
  baseUrl: https://staging.example.test
  allowedHosts: [staging.example.test]

accounts:
  - id: player-a
    role: player
    tenant: tenant-a
    tokenEnv: BARBICAN_TOKEN_PLAYER_A

policy:
  fallback: denied
  rules:
    - roles: "*"
      endpoints: [profile.read]
      outcome: allowed
```

**Credentials are not stored in the file.** An account names *the name of an
environment variable* (`tokenEnv`), not the token. This follows directly from the
conflict above: a file that holds no secrets can be committed and reviewed, and so
the declaration stays the checkable artifact it was created to be. A missing
variable is an error at startup, not an empty authorization header in the middle
of a run.

**`allowedHosts` is declared explicitly**, and the host from `baseUrl` must be in
it. Trusting the host from `baseUrl` automatically is not allowed: a typo in the
address would then silently widen the scope. The match is checked when the
configuration is read — so that the run fails before the first request, not halfway
through.

The schema is validated with `zod` (4.4.3, zero dependencies). Configuration is
untrusted input, and a message like "field `accounts[1].role` is missing" is worth
the dependency: a hand-rolled check would either not reach that precision or turn
out longer than the schema.

## Alternatives

- **Tokens directly in the file.** One step simpler, but it makes the configuration
  non-secret in words only: it can neither be committed, nor shown in review, nor
  attached to a report — that is, the whole point of the declaration as an artifact
  is lost.
- **Separate files for scope, accounts and policy.** More flexible for large
  installations, but for a run against a single deployment it gives three files
  instead of one and three ways to let them drift apart.
- **JSON only.** Uniform with the report format, but the policy is written by a
  human, and YAML is noticeably more pleasant for that — especially the comments
  explaining why a role is meant to have access.
- **A hand-written schema, without `zod`.** Saves a dependency at the cost of worse
  error messages in the very place where a live human will make a mistake.

## Consequences

The configuration can be kept in the repository of the system under test next to
its code: a change of permissions is then visible in the same review as a change of
the access policy.

The price: environment variables have to be set before a run, and the more accounts
there are, the more of them. For a role × endpoint matrix this is unavoidable —
there are exactly as many accounts as there are roles and tenants to cover.

Revisit if a need appears for several targets in one run: `target` would then
become a list, and the rule "the host from `baseUrl` is in `allowedHosts`" would
have to be stated for each target separately.

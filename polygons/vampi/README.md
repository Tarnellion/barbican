# VAmPI as a reproducible polygon

A public, deliberately vulnerable API ([erev0s/VAmPI](https://github.com/erev0s/VAmPI)).
Everything needed to make a run against it repeatable with one command is here:
starting the deployment, obtaining the tokens, the run configuration and the oracle.

The polygon is single-tenant: there is no "other tenant" in it, and a cross-tenant
leak cannot be modelled — the reference platform in `polygon/` exists for that.
VAmPI tests the other half — **BOLA inside a tenant, and endpoints that are public
while they must not be** — on a real application rather than on a synthetic one.

## Quick start

```
docker pull erev0s/vampi:latest   # the image is pulled explicitly, not mid-verification
pnpm run build                    # verify.mjs runs the built dist/cli.js
node polygons/vampi/verify.mjs    # both modes, verification against the oracle
```

Exit code: 0 — everything matched the oracle, 1 — there are discrepancies, 2 —
the run could not be made.

```
node polygons/vampi/verify.mjs vulnerable   # only the named mode
node polygons/vampi/verify.mjs --keep       # do not shut the deployment down afterwards
```

## What is inside

| File | What it is |
|---|---|
| `docker-compose.yaml` | the deployment: one container, the mode is set by a variable |
| `tokens.mjs` | creates the users and the books, issues the tokens |
| `barbican.run.yaml` | the run configuration in the format of [ADR-0008](../../docs/adr/0008-run-configuration-format.md) |
| `endpoints.yaml` | a manual list of VAmPI endpoints |
| `ground-truth.json` | the oracle: known defects and the findings that are required |
| `verify.mjs` | brings the deployment up, runs the tool, verifies against the oracle |

## Accounts

| Account | Role | Token from variable | Canary |
|---|---|---|---|
| `alice` | user | `VAMPI_TOKEN_ALICE` | `me` |
| `bob` | user | `VAMPI_TOKEN_BOB` | `me` |
| `anonymous` | anonymous | no token | — |

Two equal users are the minimum on which BOLA is distinguishable at all: one of
them needs a resource, the other needs someone else's resource. The anonymous
account tests the claim "this endpoint is not public": almost half of the findings
here are its own.

No administrator is created, and that is deliberate. In VAmPI the admin role
grants exactly one permission — `DELETE /users/v1/{username}`, that is, an unsafe
method the tool does not go to. Such an account would give a matrix column
identical to the user one, and would create the appearance that the role is covered.

The canary for both is `GET /me`: it is the only VAmPI endpoint where connexion
itself checks the token. The others would answer 200 even with garbage in the
header, so they cannot be canaries.

## Resources

| Resource | Owner | Substitution |
|---|---|---|
| `user-alice` | alice | `{username}` = `alice` |
| `user-bob` | bob | `{username}` = `bob` |
| `book-alice` | alice | `{book_title}` = `alice-secret-book` |
| `book-bob` | bob | `{book_title}` = `bob-secret-book` |

`tokens.mjs` creates the users and the books before the run; the identifiers are
declared in the configuration rather than fished out of responses — we do not read
bodies. The names in the script and in the configuration must match, and
`verify.mjs` verifies that: a resource that was not created gives 404 on every
request, 404 reads as a denial, the denial agrees with the policy — and the report
comes out clean having tested nothing.

## Tokens

The tool does not obtain tokens: a login is a POST, and without `--unsafe-methods`
the tool does not issue POST. The operator obtains the credentials — `tokens.mjs`.

```
docker compose -f polygons/vampi/docker-compose.yaml up -d
eval "$(node polygons/vampi/tokens.mjs)"

node dist/cli.js run \
  --config polygons/vampi/barbican.run.yaml \
  --endpoints polygons/vampi/endpoints.yaml \
  --report /tmp/vampi.report.json \
  --rps 25 --concurrency 4

docker compose -f polygons/vampi/docker-compose.yaml down -v
```

The script generates the passwords at random for every run and writes them
nowhere: not into a file, not into the output. Only the tokens go outside — they
cannot not be issued, they are the very subject of the work. There are no
credentials in the repository files and there cannot be: the configuration names
**the name of an environment variable**, not a value.

Before registering, the script calls `GET /createdb`. That is not a whim: a user
name and a book title are unique in VAmPI, a second run in a row would hit
"User already exists", and the password of that account is no longer known — it is
random and is not saved. On a freshly started container there is no database at
all: without `/createdb` registration answers 500.

The token lifetime is set by `VAMPI_TOKEN_TTL` (3600 by default). VAmPI's own
default is 60 seconds: the token expires in the middle of a run, the responses
become 401, the denial agrees with the policy wherever access is not meant to be
granted — and the report looks clean. A canary will not catch this: it is checked
before the run, while the token is still alive.

## Two modes, not "defects on/off"

VAmPI has a global switch `vulnerable=0/1`. [ADR-0009](../../docs/adr/0009-validation-oracle.md)
measured that the modes are indistinguishable to the tool: all they change is
response bodies, and bodies are not read. It was written down at the same time:
revisit once substitution of values into templated paths exists.

It appeared ([ADR-0010](../../docs/adr/0010-resources-and-tenancy.md)), and the
modes stopped being indistinguishable — in exactly one place. With `vulnerable=1`,
`GET /books/v1/{book_title}` hands out the secret of someone else's book (200);
with `vulnerable=0` it filters the selection by owner and answers 404. The other
defects are the same in both modes.

So the modes here are **two different non-empty lists of findings** (13 and 11),
not "there are findings / there are none". Checking for zero in the secure mode is
still no good: zero is not reached there and must not be.

## How to read ground-truth.json

The oracle is written by hand from VAmPI's access model — its README and the
`if vuln:` branches in the sources. This is a matter of principle: a reference
taken from the tool's output would be testing the tool for consistency with itself.

```
defects{}          — known defects of the polygon
  title            — what is broken
  owasp            — the OWASP API Security Top 10 item
  visibility       — whether the tool sees it, and why
  note             — caveats

modes[]
  id               — the name of the mode, and the argument to verify.mjs
  vulnerable       — the value of VAmPI's switch
  expectedExitCode — 1 in both modes: there are always findings
  findings[]       — the cells required to produce a finding
    account        — account id from barbican.run.yaml
    endpoint       — endpoint id from endpoints.yaml
    resource       — resource id; null for endpoints without path parameters
    kind           — always privilege-escalation
    defect         — a reference to a defect from defects{}
```

Values of `visibility`:

| Value | Meaning |
|---|---|
| `status` | visible in the response status — only these land in `findings` |
| `body-only` | distinguishable by the body only; bodies are not read ([ADR-0005](../../docs/adr/0005-tool-safety-invariants.md)) |
| `unsafe-method` | lives on POST/PUT/DELETE, where the tool does not go |
| `excluded` | would be visible, but the endpoint is excluded: a request to it destroys the deployment |
| `out-of-scope` | not about the role × endpoint matrix at all |

The comparison is made over sets, the order in the file does not matter. A finding
that is not in the list is as much a discrepancy as a missing one: a false positive
devalues the tool no less than a miss does.

The oracle is checked for internal consistency as well: a reference to a defect
that does not exist, and a finding attributed to a defect whose `visibility` is
not `status`, stop the verification before the deployment is started.

## `GET /createdb` is excluded by name

`SAFE_METHODS` protects against the semantics of a method, but not against an
endpoint that breaks those semantics: an endpoint that resets the database is
still a GET. A request to it in the middle of a run wipes alice and bob together
with the books, and the rest of the matrix is probed against an empty database —
with findings that can no longer be there.

This endpoint was actually called by the tool on the first, manual run against
VAmPI; the `exclude` list appeared because of it. `verify.mjs` checks separately
that the report lists it as skipped with the reason `excluded`.

## The verification result

Run of 12 August 2026, image `erev0s/vampi@sha256:0a5a224b…`, Docker Desktop 4.46:

```
=== vulnerable === vulnerable=1
  cells probed: 27, canaries: 2, findings: 13 (expected 13)
  MATCHED the oracle, exit code 1

=== secure === vulnerable=0
  cells probed: 27, canaries: 2, findings: 11 (expected 11)
  MATCHED the oracle, exit code 1

Total: modes 2, discrepancies 0.
```

Details of the run — [docs/polygons/vampi.md](../../docs/polygons/vampi.md).

The verification has been tested for its ability to fail — otherwise it is useless:

| Tampering | What the verification said | Code |
|---|---|---|
| a finding that does not exist, `bob × me`, added to the oracle | `not found (1)` | 1 |
| a real finding, `alice × books.read × book-bob`, removed from the oracle | `found beyond the oracle (1)` | 1 |
| a finding attributed to a defect with `visibility: body-only` | stopped before the deployment was started | 2 |
| a finding references a defect that does not exist | stopped before the deployment was started | 2 |
| a typo in the book title in `tokens.mjs` | stopped before the deployment was started | 2 |
| an artificial failure of the setup | the deployment was shut down, the verification did not say "matched" | 2 |

The last row is not about the oracle but about cleaning up: leaving a deliberately
vulnerable API that hands out passwords without a token running is a bad way to
finish a verification.

## Boundaries

Cross-tenant isolation is not tested here: VAmPI is single-tenant. Nor is the
tool's behaviour on a **correct** platform tested: even in the secure mode VAmPI
keeps a public `_debug` with passwords and an open list of users. The claim "the
tool does not fabricate findings on a clean deployment" is tested in `polygon/`,
where the defects are switched off completely.

## If something does not start

- **`docker pull` hangs with no output.** On macOS this is usually the Docker
  Desktop credential helper waiting for keychain access in a non-interactive
  session. Work around it with a temporary `DOCKER_CONFIG` pointing at a directory
  with an empty `config.json`.
- **`verify.mjs` says "image not found" right away.** That is by design: there is
  no reason to pull an image silently in the middle of a verification, `docker pull`
  is run separately.
- **Registration answers 500.** The database was not created: `tokens.mjs` was run
  with `--no-reset` on a fresh container.

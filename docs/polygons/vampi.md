# VAmPI as a polygon

A run of 12 August 2026 against a live deployment: the image `erev0s/vampi@sha256:0a5a224b…`,
Docker Desktop 4.46, the port published on `127.0.0.1` only. Below is what was
measured, not what was inferred from the documentation.

The deployment, the tokens, the configuration and the oracle are gathered in [`polygons/vampi/`](https://github.com/Tarnellion/barbican/blob/main/polygons/vampi/README.md):
the run is repeated with `node polygons/vampi/verify.mjs`. It used to be assembled by hand.

The oracle is a hand-written list of defects ([ADR-0009](../adr/0009-validation-oracle.md)),
not the difference between the polygon's modes. Why not the difference — below.

## Authentication

`Authorization: Bearer <JWT>`, HS256, the signing key `random` — that is, forgeable,
but that is not our area. The token lifetime is set when the container starts;
VAmPI's default is **60 seconds**, and that is a trap: the token expires in the
middle of a run, the responses become 401, the denial agrees with the policy
wherever access is not meant to be granted, and the report looks clean. A canary
will not catch this — it is checked before the run, while the token is still alive.
The polygon's `docker-compose.yaml` sets an hour.

The login is `POST /users/v1/login` only, so in safe mode the tool cannot obtain a
token. The operator logs in outside the tool and puts the tokens into environment
variables — exactly the model described in [ADR-0008](../adr/0008-run-configuration-format.md).
Here the operator is `tokens.mjs`: it recreates the database, registers two users
with random passwords, logs in as them and creates a book for each.

The specification sits in the image (`/vampi/openapi_specs/openapi3.yml`, OpenAPI 3.0.1).
The run does not use it: the endpoint list is written by hand ([ADR-0006](../adr/0006-expected-access-declaration.md)),
and it is written **complete** — including the endpoints the tool will not reach. A
row "a PUT that changes anyone's password" in the report as a skip is more honest
than its absence.

## The denials are not uniform

| Request | Response |
|---|---|
| `GET /me` without a token | **401** — the only place where connexion itself checks authorization |
| `GET /books/v1/{book_title}` without a token | **401** — the same place |
| `GET /users/v1`, `/users/v1/_debug`, `/books/v1`, `/users/v1/{username}` | **200** to anyone, no token required at all |
| `GET /books/v1/{book_title}`, someone else's book, `vulnerable=0` | **404** — "not found" instead of "not allowed" |

The last row matters: a denial disguised as a 404 is marked by the tool as
`not-found`, not `denied`. Reduced to binary it is a denial all the same, and the
verdict does not change, but the label is imprecise.

## What the tool finds

A run against the vulnerable mode: **13 cells, five classes of defect**.

| Defect | Cells | How it is visible |
|---|---|---|
| `GET /users/v1` — the list of all users with their email, without a token | 3 | 200 where the policy declared a denial |
| `GET /users/v1/_debug` — all users with their passwords and the admin flag | 3 | the same |
| `GET /users/v1/{username}` — any user's profile to anyone | 4 | the same, with substitution into the path |
| `GET /books/v1` — the list of all books with their owners, without a token | 1 | the same, only anonymously |
| `GET /books/v1/{book_title}` — the secret of someone else's book (BOLA) | 2 | the same, only with a token |

Three of the five are reachable only because substitution of values into templated
paths appeared ([ADR-0010](../adr/0010-resources-and-tenancy.md)); the
two-dimensional role × endpoint matrix did not see them.

The negative controls worked: `GET /me` without a token gives 401, someone else's
book to an anonymous caller gives 401 too, one's own book to its owner gives 200.
Not a single finding where the policy and the behaviour agree.

## The mode switch: what it gives now

ADR-0009 measured that `vulnerable=0/1` are indistinguishable to the tool: all the
switch changes is response bodies. The condition for revisiting was written down in
the same place — the appearance of substitution into templated paths.

Measured again, after it appeared. The modes differ by **exactly one defect and
exactly in the status**:

| Cell | `vulnerable=1` | `vulnerable=0` |
|---|---|---|
| alice → `books.read` × `book-bob` | **200** | **404** |
| bob → `books.read` × `book-alice` | **200** | **404** |
| everything else | the same | the same |

The result: 13 findings against 11. The conclusion of ADR-0009 stands — "zero
findings in the secure mode" still does not work as a criterion, because zero is
not reachable there: `_debug` with the passwords and the open list of users remain
in both modes, and VAmPI does not count them as switchable in the first place. But
the two modes now give **two different non-empty lists**, and both go into the oracle.

## What the tool will never find here

| VAmPI defect | Why it is unreachable |
|---|---|
| Changing any user's password (`PUT …/password`) | an unsafe method; and even with `--unsafe-methods` a meaningful body would be required |
| Mass assignment `admin: true` at registration | the same plus confirmation only in the body |
| ReDoS and BOLA in `PUT …/email` | the same; the single cell where ADR-0009 measured a difference between the modes (204 against 400) is exactly this one |
| Enumeration of users and passwords at login | both responses are 200, the difference is only in the text of the message |
| SQL injection in `/users/v1/{username}` | the tool addresses declared identifiers and does not guess payloads |
| A weak JWT signing key | the tool does not forge credentials |
| No rate limit | the tool throttles itself, and that is an invariant, not an option |

A row of its own — `GET /createdb`. Formally it is visible in the status: 200 to an
anonymous caller where the policy declares a denial. But a request to it wipes the
users and the books, and the rest of the matrix is probed against an empty database.
The endpoint is excluded by name; in the report it is listed as a skip with the
reason `excluded`, and the verification separately checks that it was left untouched.

## Run of 12 August 2026: the result

```
=== vulnerable === vulnerable=1
  cells probed: 27, canaries: 2, findings: 13 (expected 13)
  MATCHED the oracle, exit code 1

=== secure === vulnerable=0
  cells probed: 27, canaries: 2, findings: 11 (expected 11)
  MATCHED the oracle, exit code 1

Total: modes 2, discrepancies 0.
```

The tool's summary in the vulnerable mode:

```
Probed: 27 pairs, endpoints 14, accounts 3
Endpoints not probed: 7 (excluded by hand 1, use an unsafe method 6)
Privilege escalation: 13
Other discrepancies: unexpected denials 0, not observed 0, probe errors 0
```

The oracle was written before the run, from VAmPI's access model, and matched cell
for cell the first time — including the prediction that the secure mode would lose
exactly two findings. There are no false positives: 0 out of 13, every finding is a
200 where the policy declared a denial.

The verification has been tested for its ability to fail. A non-existent finding
(`bob × me`) planted in the oracle gave "not found (1)", a real one removed
(`alice × books.read × book-bob`) gave "found beyond the oracle (1)", exit code 1
in both cases. A finding attributed to a defect marked "visible in the body only",
and a reference to a defect that does not exist, stop the verification before the
deployment is started, with code 2.

## The bottom line

VAmPI covers what our own platform cannot: findings on a real application, written
by other people and with defects nobody tailored to the tool's capabilities. Five
classes of defect, 13 cells, zero false ones.

What it does not cover: cross-tenant isolation — the polygon is single-tenant, and
there is no "other tenant" in it. And the check "the tool does not fabricate
findings on a correct deployment": even in the secure mode VAmPI stays vulnerable.
Both of those are for the reference platform in [`polygon/`](https://github.com/Tarnellion/barbican/blob/main/polygon/README.md).

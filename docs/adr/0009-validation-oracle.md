# 0009. The validation oracle — a list of known defects, not the polygon's switch

- **Status:** accepted
- **Date:** 2026-08-12

## Context

The roadmap put VAmPI first as a polygon, with this reasoning: it has a global
vulnerability switch (`vulnerable=0/1`), which means there is an oracle not only
for misses but also for false positives — a run with the defects switched off must
produce an empty report.

The premise was tested by measurement and **turned out to be wrong for our tool**.

## Measurement

Two instances of VAmPI were brought up: `vulnerable=1` and `vulnerable=0`. Response
statuses were compared across all endpoints available to the tool.

| Request | `vulnerable=1` | `vulnerable=0` |
|---|---|---|
| `GET /`, `/books/v1`, `/users/v1`, `/users/v1/_debug` | 200 | 200 |
| `GET /me` with no token | 401 | 401 |
| `GET /users/v1/{username}` as another user | 200 | 200 |
| `PUT /users/v1/{username}/email` as another user | **204** | **400** |

There is exactly one difference, and it sits on an unsafe method and a templated
path — that is, in the two places the tool does not go: `PUT` requires
`--unsafe-methods`, and there is nothing to substitute into `{username}`.

Everything else differs **only in response bodies**: `/users/v1/_debug` hands out
the passwords of all users in both modes, and `vulnerable=0` does not fix that.
We do not read bodies as a matter of principle (ADR-0005), so for us the modes are
indistinguishable.

Full runs confirmed it: against both instances the tool produces the same three
findings and the same exit code.

## Decision

**The oracle is a hand-written list of the polygon's known defects**, not the
difference between its modes. Validation consists of two assertions: the tool finds
the listed defects, and it finds nothing beyond the declared policy.

"Zero findings in protected mode" is dropped as a criterion: for us it holds
trivially, because the modes are indistinguishable — and therefore it proves
nothing. A criterion that passes for free is worse than a missing one: it creates
the appearance of a check.

## Alternatives

- **Read response bodies to see the difference between the modes.** Rejected: this
  is a direct abandonment of the invariant "bodies are not stored", the very thing
  the invariant was created for. The value of the polygon does not justify moving a
  client's PII into reports.
- **Declare VAmPI unusable and move straight to our own platform.** Rejected: even
  in this shape VAmPI yields real findings (see below), and fast feedback on a real
  application is worth more than the purity of a criterion.
- **Compare the reports of the two modes against each other.** Rejected for the
  same reason: there is nothing to compare, the reports match byte for byte in their
  substantive part.

## Consequences

VAmPI stays useful: the run found three real discrepancies with the declared
policy — `/users/v1/_debug` is open to both accounts (a documented password leak)
and `/users/v1` is available to an ordinary user (user enumeration). These are true
positives on a real application, not on a synthetic one.

Phase 3 grows in importance. Our own reference platform is now needed not "for
multi-tenancy" but as **the only source of switchable defects visible by response
status**. The requirement on it is made more precise: defects must show up in
response codes, otherwise the platform will repeat the uselessness of VAmPI's switch.

Revisit if the tool learns to substitute values into templated paths:
`PUT /users/v1/{username}/email` would then become reachable, and VAmPI's switch
would acquire meaning — but as a check of one specific defect, not as a general
oracle.

## Clarification of 2026-08-12: the revision condition fired

The last paragraph above named a condition: "revisit if the tool learns to
substitute values into templated paths". After ADR-0010 it learned. The condition
fired, and the measurement this ADR stood on is no longer true.

**What changed.** VAmPI's modes are distinguishable by status — on exactly one
endpoint:

```
GET /books/v1/{book_title}, someone else's book
  vulnerable=1 -> 200     vulnerable=0 -> 404
```

Checked by a reproducible run (`polygons/vampi/verify.mjs`), both modes, with the
oracle written before the run: vulnerable — 13 findings, protected — 11. Exactly
two cells diverge: `alice × books.read × book-bob` and
`bob × books.read × book-alice`.

The earlier measurement, "the reports match byte for byte", was true **for the tool
of that time**: without substitution into the path, that endpoint was not probed at
all, and the modes had nowhere to diverge. What was being measured was not the
indistinguishability of VAmPI's modes but the tool's blindness to them.

**The prediction about which endpoint exactly would "acquire meaning" did not come
true.** The one named was `PUT /users/v1/{username}/email` — but PUT is unsafe and
is not performed without explicit permission, so that endpoint gained no meaning.
The modes diverged on `GET /books/v1/{book_title}`, which the paragraph said
nothing about.

**The decision nevertheless stands, and for a different reason than before.** The
mode switch is still no good as an oracle — but no longer because it changes
nothing; rather because it changes too little: 2 cells out of 13. In protected mode
11 findings remain, including three on `/users/v1/_debug`, which hands out
passwords in both modes. "Zero findings in protected mode" is unreachable, and
without that criterion the switch does not answer the question "are there any false
positives".

The oracle stays hand-written. Its shape has changed: it is now two lists, one per
mode, rather than one list of known defects.

The requirement on our own reference platform (`polygon/`) is not relaxed: there the
switch gives a real zero in clean mode, which VAmPI gives in no mode at all.

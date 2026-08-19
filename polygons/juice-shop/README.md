# Juice Shop as a reproducible polygon

OWASP Juice Shop, brought up in one container and checked against a hand-written
oracle: the tool must find the defects listed in `ground-truth.json`, all of
them, and nothing beyond what the declared policy allows.

The recon this is built on — what was measured and why the polygon is worth
having — is in [docs/polygons/juice-shop.md](../../docs/polygons/juice-shop.md).

## Quick start

```
pnpm run build
node polygons/juice-shop/verify.mjs
```

It recreates the container, registers two customers, runs the tool and compares
the result cell by cell. `--keep` leaves the deployment running afterwards.

It is not part of `pnpm run check` and does not run in CI: it needs docker and
about a minute of container start. The reference polygon under `polygon/` is the
one that gates every commit.

## What is inside

| File | What it is |
|---|---|
| `docker-compose.yaml` | one container, loopback only, pinned by digest |
| `barbican.run.yaml` | the accounts, the resources and the policy — a human's declaration |
| `endpoints.yaml` | the hand-written endpoint list |
| `tokens.mjs` | registers the customers and hands out their tokens |
| `ground-truth.json` | the ten defects and the twenty-five cells that must produce a finding |
| `verify.mjs` | brings it up, runs the tool, compares, tears down |

## Accounts

Two customers and an anonymous caller.

Two customers, because ownership needs somebody who is not the owner: reading
another customer's basket is the defect this polygon is best at, and with one
account it is invisible. The anonymous caller is not decoration either — six of
the ten defects are of the form "this endpoint answers a request with no token",
and without it none of them can be reached.

**The administrator is deliberately absent.** `admin@juice-sh.op` exists and its
token says `role: admin`, and across seventeen GET endpoints not one status
differs between it and an ordinary customer. An admin account would add a matrix
column identical to the customer's and create the appearance of a role being
covered.

## The identifiers are the image's to assign

Juice Shop numbers users and baskets itself. On a freshly recreated container
alice becomes user 25 with basket 6 and bob user 26 with basket 7 — checked
twice on 18 August 2026.

**The basket id is not the user id.** That is the single easiest mistake here,
and it is why the basket identifier is taken from the `bid` field of the login
response rather than derived from anything.

Both numbers are declared in `barbican.run.yaml` and asserted **against their
owner**: `tokens.mjs` parses the `resources` block and requires that the resource
owned by alice carry alice's basket and alice's user id.

That is the second version. The first asked only whether the numbers appeared
somewhere in the file, and adversarial review pointed all four resources at the
administrator's objects, left 6, 7, 25 and 26 in a comment, and got a full match
out of a run that never touched alice's or bob's basket — the four cells this
polygon exists for comparing the administrator's basket with itself. A
declaration is a structure, and checking it by substring is what let a comment
stand in for one. An image that seeds differently would otherwise leave this
polygon quietly probing somebody else's basket and reporting that everything
agrees.

This is also why `verify.mjs` recreates the container rather than starting it.
There is no reset endpoint — VAmPI has `/createdb`, this application has nothing
of the kind — so a leftover container already holds alice, and the fresh database
is what makes the numbering deterministic in the first place.

## Nothing is excluded by name

VAmPI needs `exclude: [db.createdb]`: a GET there wipes its database, and every
finding after it would have been taken against an empty one. Juice Shop has no
destructive GET on this list. Said here rather than left as an absence somebody
has to notice and then wonder about.

## One variant

There is no vulnerability switch: the defects are what the application is for.
Nothing is lost by that — ADR-0009 had already settled that the oracle is a
hand-written list of a polygon's defects rather than the difference between two
of its modes, after VAmPI's two modes turned out to differ only in response
bodies.

## What it finds

Twenty-eight cells over eleven defects, all of them visible in the response
status, all on GET. Two shapes, and both are what module 1 exists for.

**An object read by somebody who does not own it.** Another customer's basket
(Juice Shop's own list calls this one "View Basket") and another customer's
profile by number. Four cells: the policy allows both endpoints with `scope:
own`, so the cells where a customer reads their own agree and only the crossed
pairs are findings.

**An endpoint open to somebody who should not have it.** Served to any logged-in
customer: the full user directory with every registered email address, the items
of every basket, and other customers' complaints. Served to anybody at all: the
configuration the application itself calls `admin`, customer feedback, recycling
requests, stock levels, uploaded photographs, and a directory listing at `/ftp`.

The three that changed on 19 August are worth naming. `/api/BasketItems` and
`/api/Complaints` were declared allowed to a customer as "lists scoped to the
caller" and are nothing of the kind — measured, they hand over every basket's
items and another customer's complaint. Four real cross-customer reads were
unfindable because of a line in the policy rather than anything about the tool.
And `whoami` was declared a defect and is not one: it answers 200 to everybody
and `{"user":{}}` to everybody, so an authenticated caller learns nothing an
anonymous one does not. It is still the reason it cannot be the canary.

## What it does not find, and must not be read as covering

**Anything across tenants.** Juice Shop is single-tenant. Four of the five
resource relations never arise, and the tenant hierarchy — the strongest thing
this project models — is untouched here. That stays covered by `polygon/` alone.

**Anything visible only in a body.** `/api/Users` is caught because it answers
200 where it must refuse; had it refused with 200 and an empty list, nothing
would have been seen without a declared body signal (ADR-0011).

**Anything behind a write.** "Manipulate Basket", "Forged Feedback", "Product
Tampering" and the rest sit on POST and PUT, which the tool does not issue
without `--unsafe-methods`. The two writes are in `endpoints.yaml` anyway, so
that the report names them as skipped rather than staying silent about them.

## If something does not start

The image is pinned by digest, so `compose up` will not quietly pull something
newer. To move it: pull the tag you want, take
`docker image inspect --format '{{index .RepoDigests 0}}'`, put it in
`docker-compose.yaml` — and then re-derive the user and basket ids on a freshly
recreated container, because a new build may number them differently. The run
will stop and say so if you forget.

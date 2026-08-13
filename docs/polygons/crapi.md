# crAPI as a polygon

The reconnaissance was done on 12 August 2026 against a live deployment (the
official docker-compose, ports on `127.0.0.1` only). Below is what was checked with
`curl`, not what was inferred from the documentation.

The oracle is this list, not a mode switch: crAPI does not have one. The reasoning
behind the approach is in [ADR-0009](../adr/0009-validation-oracle.md).

## Authentication

`Authorization: Bearer <JWT>`, RS256, a lifetime of 7 days — one token is enough
for a whole run. The login is `POST /identity/api/auth/login` only; `GET` and `HEAD`
give 405, so in safe mode the tool cannot obtain a token. The operator logs in
outside the tool and puts the tokens into environment variables — exactly the model
described in [ADR-0008](../adr/0008-run-configuration-format.md).

The specification sits in the crAPI repository (`openapi-spec/crapi-openapi-spec.json`,
OpenAPI 3.0.1, 40 paths) and is not served over HTTP. It is taken from the file.

## The denials are not uniform — that matters more than it seems

| Service | Response to a request without a token |
|---|---|
| identity (Java), `…/user/dashboard` | **404** |
| identity (Java), `…/vehicle/vehicles` | 401 |
| workshop (Django), most of them | 401 |
| workshop, `…/mechanic_report` without a required parameter | 500 |

A denial disguised as a 404 is marked by the tool as `not-found`, not `denied`. It
will still see the discrepancy with the policy, but the label will be imprecise.

Something else is more dangerous: solid 404s are a typical sign of **a wrong
`baseUrl` or path prefix**. The diff will read them as denials, the denials will
agree with the policy, and the run will report "everything is clean" without having
reached a single endpoint. Because of this finding, the authenticity check in
`src/report/authenticity.ts` stopped looking at 401 alone and now catches any
across-the-board denial.

## What the tool finds today

One reliable finding — **BFLA**: `GET /workshop/api/management/users/all` gives
the `user` role a 200 with the list of all users. Neither identifiers nor reading
the body are needed; declaring `user → denied` in the policy is enough.

Plus a cosmetic one: `GET /workshop/api/shop/return_qr_code` answers without a
token, but there is no sensitive data in it.

## What opens up once parameters are substituted

Three BOLAs become visible **in the response status** — as "200 where a denial was
declared":

| Defect | Request | What to fill it with |
|---|---|---|
| Someone else's car location | `GET /identity/api/v2/vehicle/{vehicleId}/location` | a real UUID of someone else's; a non-existent one gives 404 |
| Someone else's service report | `GET /workshop/api/mechanic/mechanic_report?report_id=N` | a numeric id **in the query** |
| Someone else's order | `GET /workshop/api/shop/orders/{order_id}` | a numeric id |

The last one is handed out **without a token at all** on top of that — broken
authentication, also visible in the response status.

From this follows a requirement that was not in the plan: **substitution is needed
not only into the path but into the query as well**. Otherwise `mechanic_report` is
unreachable.

## What the tool will not find without reading bodies

This section was written before ADR-0011. Signals over the body closed one case —
"the same response for different tenants" — but against crAPI it gives not a single
finding, and that is not a gap in the tool but a property of the deployment: crAPI's
list endpoints are filtered by owner correctly, the digests of different users
diverge (the re-run is below). What stayed unreachable is what lives in the fields
of a lawful response:

- **Excessive Data Exposure** — extra fields in a lawful 200 to the owner. There is
  no status signal for it at all.
- **Attribution of a leak** — the tool sees "a 200 arrived where a denial was
  expected", but cannot say whose data exactly arrived.
- **Mass Assignment** — confirmation exists in the body only.

Entirely outside the scope of module 1: SSRF, injections in coupons, JWT forgery,
OTP brute-forcing.

## The bottom line

Today — 1 reliable finding. After identifier substitution — plus 3 BOLAs and 1
broken authentication. Fundamentally unreachable without reading bodies — the whole
class of excessive data exposure.


## Run of 12 August 2026: the result

Performed after ADR-0010 (identifier substitution). The oracle was built
independently: the status matrix was taken with `curl` over all cells before the
run, and the tool's observations matched it cell for cell.

```
Probed: 72 pairs, endpoints 44, accounts 4
Not probed: 30 (use an unsafe method 28, have path parameters 1, excluded 1)
Privilege escalation: 17
Other discrepancies: unexpected denials 0, not observed 0, probe errors 0
```

**Everything marked "visible in the response status" or "requires id substitution"
was found:** the BFLA on the list of users, three BOLAs (someone else's car
location, someone else's service report through a query parameter, someone else's
order) and broken authentication — the order is handed out without a token at all.
The last one was found only thanks to the anonymous account: a two-dimensional
model with a mandatory token missed that.

**There are no false positives: 0 out of 17.** Every finding corresponds to a
manually verified 200 where the policy declared a denial. The negative controls
worked too: ownership is checked on videos, someone else's gives 404, and there is
no finding.

A caveat about the number 17: six rows are the same three BOLAs, observed from the
admin's point of view. In crAPI these endpoints have no role check at all, so the
policy declared a denial the same way for every role. Three defects, six rows — the
tool cannot collapse observations of one defect made from different points of view.

Not found, exactly as the reconnaissance predicted: Excessive Data Exposure,
attribution of a leak and mass assignment — the whole class that requires reading
bodies.

## Re-run of 12 August 2026 with signals over the body (ADR-0011)

The deployment was brought up again (the same official docker-compose, ports on
`127.0.0.1` only; the chatbot is excluded — a heavy image and an external LLM, of
no relation to the scope of the check). The configuration was assembled anew from
the same model: every crAPI user is declared its own tenant, so someone else's order
or car is `foreign-tenant`. The oracle was again taken with `curl` before the run,
and the observations matched cell for cell.

```
Probed: 64 pairs, endpoints 44, accounts 4
Endpoints not probed: 30 (use an unsafe method 28, have path parameters 2)
Privilege escalation: 16
Other discrepancies: unexpected denials 0, not observed 0, probe errors 4
Check findings: 0
```

All six classes visible in the response status were reproduced: the BFLA on the
list of users (2 rows), the BOLA on someone else's car location (4), the BOLA on
someone else's order (4) together with the broken authentication on it — the order
is handed out to an anonymous caller (2), the BOLA on the service report through
the query (3), the QR code answered without a token (1). Each of the 16 rows is a
manually verified 200 where the policy declared a denial; false positives 0. The
four "probe errors" are `receive_report` without a required parameter, 400 for every
account: not a defect but a `probe-error`.

Sixteen against seventeen last time is a difference in the set of resources, not a
missed defect: the original configuration is not in the repository, and the one
assembled anew gives five rows from the admin's point of view instead of six. The
classes are the same.

**The main point is about signals over the body. No new class of findings against
crAPI was added, and that is the correct result, not a miss.** The three list
endpoints that must differ between users are declared in
`responseMustDifferByTenant` (at the time of the run the field was called `tenantScoped`):
`get_vehicles`,
`get_orders`, `get_dashboard`. Their bodies were read and the digest computed — and
for adam, pogba and admin it is **different** on each of the three. The
response-match check `identical-response-across-tenants` compared pairs from
different tenants, found no matches and stayed silent. It is
silent on the merits: crAPI filters these lists by owner correctly, and the defect
it looks for — "the same data for different principals" — simply is not here.

What stayed unreachable stayed unreachable: **Excessive Data Exposure** (extra
fields in a lawful 200 to the owner), **attribution of a leak**, **mass assignment**.
The digest and `count` see that the responses are *different*, but not *what* in
them is extra. In crAPI this class lives at the level of fields, not at the level of
"whose list is this", and stays out of the reach of signals.

**The noise check was a separate run.** Declare `responseMustDifferByTenant` by
mistake for the public feed `get_recent_posts` (its body is the same for everyone,
`curl` confirms that),
and the check immediately gives three findings: the pairs adam↔pogba, adam↔admin,
pogba↔admin with a matching digest. The mechanism works and is able to fire — so
the silence on a correct configuration is not the consequence of a breakage. The
boundary follows from the same place: only the endpoints that *must* differ should
be declared; declaring a public one is an operator error that produces false
positives. That is why `responseMustDifferByTenant` is a human's statement
(ADR-0011), not something derived from the specification.

After the first run, two defects in the tool itself were fixed (see the
clarification in [ADR-0005](../adr/0005-tool-safety-invariants.md)); the re-run with
signals uncovered no new defects in the tool.

## Run of 13 August 2026: the oracle became machine-readable

Until that day crAPI was the only polygon without a machine-readable oracle: the
matrix was taken with `curl` by hand and verified by eye. Now it has
`polygons/crapi/ground-truth.json` in the format of [ADR-0012](../adr/0012-ground-truth-format.md)
and `polygons/crapi/verify.mjs`, which brings the deployment up, logs the users in,
runs the tool and verifies the findings with the shared `tools/oracle` module — the
same one VAmPI and the reference platform are verified with. The polygon has no
comparison code of its own.

The oracle is written by hand from the access model: crAPI's own official list of
challenges (eighteen of them), the declared policy, and the status matrix taken by
an independent client before the run. It is not taken from barbican's output —
otherwise it would be testing the tool for consistency with itself.

### The numbers of the run

```
Probed: 60 pairs, endpoints 44, accounts 4
Endpoints not probed: 31 (use an unsafe method 28, have path parameters 2, excluded by hand 1)
Privilege escalation: 16
Other discrepancies: unexpected denials 0, not observed 0, probe errors 0
By severity: critical 13, high 3, medium 0, low 0
Distinct defects: at least 5 (observations 16)
Check findings: 0
```

Verification: `variants 1, discrepancies 0`, the tool's exit code 1 — exactly as
declared in the oracle. Sixteen cells matched the expected ones one for one; there
are no extras.

Probe errors became 0 instead of the previous 4. The reason is not in the tool: the
endpoint `create_service_report` (`GET /workshop/api/mechanic/receive_report`) is
excluded by name. By the specification this is the creation of a service report — a
write performed with the GET method and declared without authentication; safe mode
will not stop it, because the method is safe by the letter. Without the required
parameters it answered 400 for all four accounts, that is, gave four cells the tool
has nothing to say about.

### Defects: twenty-two declared, six findable

The oracle lists twenty-two defects — all eighteen challenges of crAPI itself plus
three found by the reconnaissance (the BFLA on the list of users, the BOLA on
someone else's order, and the write performed with GET), and one crAPI challenge —
"an endpoint with no authentication check" — is split into two different defects.

| Visibility | How many | What it means |
|---|---|---|
| `status` | 6 | the tool finds it in the response status |
| `body-only` | 2 | the difference is only in the fields of a lawful 200 |
| `unsafe-method` | 5 | lives on a write method |
| `excluded` | 1 | would be visible, but must not be touched |
| `out-of-scope` | 8 | the question is not about the role × endpoint matrix |

The six findable ones give sixteen cells: the BOLA on someone else's car location
(4), the BOLA on someone else's order (6 — two of them, the anonymous ones, are
also explained by broken authentication), the BOLA on the service report through
the query (3), the BFLA on the list of users (2), the public QR code (1).

The two unreachable classes are now named explicitly, with a verified reason, rather
than described in general terms:

- **extra fields in the feed of posts.** `GET /community/api/v2/community/posts/recent`
  returns an `author` on every post with the fields `nickname`, `email`, `vehicleid`,
  `profile_pic_url`, `created_at`. Verified by reading the response. The status is a
  lawful 200, and the feed really is meant for an authenticated caller — the
  difference is only in the set of fields, and a scalar over the body does not take
  it: the digest says the responses are different, but not what in them is extra;
- **an internal property of a video.** `GET /identity/api/v2/user/videos/{video_id}`
  returns the keys `id`, `video_name`, `conversion_params`, `profileVideo` to the
  owner. Verified by reading the response. The response is lawful — it is the
  owner's own video.

The eight `out-of-scope` ones are SSRF, denial of service, two injections in
coupons, JWT forgery and three challenges about the chatbot, whose container is not
brought up on the polygon at all. The five `unsafe-method` ones are resetting
someone else's password, deleting someone else's video through an administrative
endpoint, mass assignment on a video, and two abuses of the shop's business flow.

### Six defects, five signatures

The tool reports "distinct defects: at least 5" against six declared in the oracle.
The discrepancy is not an error but a consequence of how grouping is built: it
reduces discrepancies to the signature "endpoint × kind × relation", while the BOLA
on someone else's order and the broken authentication on it live on the same
endpoint with the same relation. From the outside they are indistinguishable — which
is why the report says "at least". The oracle tells them apart because a human tells
them apart: in the first case there is no ownership check, in the second there is no
authentication at all, and they are fixed differently. That is why the two anonymous
cells are attributed to both defects at once.

### The verification is able to fail

Tested by corrupting the oracle: a real finding (`adam` on the list of users) was
removed from it and a non-existent one (`pogba` on `get_mechanics`) was written in.
The total number of findings stayed the same — sixteen against sixteen — and a
verification by count would have stayed silent. The comparison over sets saw both
sides:

```
DISCREPANCY: not found (1):
  pogba × get_mechanics × — [privilege-escalation]
DISCREPANCY: found beyond the oracle (1):
  adam × get_workshop_users_all × — [privilege-escalation]
Total: variants 1, discrepancies 1.
```

After the oracle was restored, the verification came out with no discrepancies again.

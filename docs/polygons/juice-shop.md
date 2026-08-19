# Juice Shop as a polygon

Recon of 18 August 2026 against `bkimminich/juice-shop:20.2.0`, one container on
loopback. Everything below was measured, not read off the project's challenge
list: what matters here is not which flaws Juice Shop advertises but which of
them **this** tool can see, and those are two different sets.

The short answer: it is the best of the three polygons so far. VAmPI's two modes
turned out to differ only in response bodies (ADR-0009) and crAPI needs a
specification from outside the repository, while Juice Shop hands over a broad
set of access-control defects that are visible in the **response status** on
**GET** — which is the whole of what the tool looks at by default.

## Authentication

`POST /rest/user/login` with an email and a password returns

```json
{"authentication": {"token": "eyJ0…", "bid": 6, "umail": "alice@juice.invalid"}}
```

and the token goes in `Authorization: Bearer`. Registration is
`POST /api/Users/`. Both are writes, so both are the operator's job and not the
tool's — the same division as VAmPI (ADR-0008).

**`bid` is the basket identifier, and it is not the user identifier.** Alice
registered as user 25 and got basket 6. This matters more than it looks: the
basket is the one owned resource on this platform worth addressing, so the id
has to be taken from the login response rather than derived from anything.

The token's payload carries the user's id, email, role — and the bcrypt hash of
the password, which is Juice Shop's own "Password Hash Leak". Nothing for the
tool to find, but worth knowing for whoever writes the provisioning: that token
is a secret in a stronger sense than usual.

## The denials are uniform, and one of them is a lie

Across the endpoints this polygon walks there is one denial code: **401**. An
anonymous request to a protected endpoint gets 401; an authenticated request that
should have been refused gets 200.

That was written as "no 403 anywhere, for anybody" and was too wide. Measured
19 August 2026 by adversarial review and confirmed: `GET /rest/order-history/orders`
and `GET /api/Quantitys/1` answer **403** to everyone, anonymous, customer and
administrator alike. Neither is on this polygon's endpoint list, so the sentence
is true of what is walked and was false of the application.

`GET /api/SecurityAnswers` answers 401 to everyone, authenticated or not, which
is the only endpoint on the list that is closed properly.

The lie is `GET /rest/basket/{id}` on a basket that does not exist: **200**, with
`{"status":"success","data":null}`. The status does not distinguish "there is no
such basket" from "here is somebody else's". For the oracle this is a trap rather
than a defect — a resource pointing at a basket that was never created would
produce a finding that says nothing — so the provisioning has to materialise the
baskets it declares and take their ids from the login response.

## The admin role is indistinguishable, and is therefore not modelled

`admin@juice-sh.op` works and its token carries `role: admin`. Measured across
the endpoints this polygon walks — twenty-one of them in twenty-five request
forms, including `/api/Users`, `/api/Quantitys`,
`/rest/admin/application-configuration` and `/api/Cards`: **not one status
differs between the administrator and an ordinary customer.**

Not true of the application as a whole, and the earlier wording claimed it was.
`GET /rest/deluxe-membership` answers a customer 200 and the administrator 400
("you are not eligible"), which is a status that distinguishes them — in the
direction of the administrator having *less*. It changes nothing about the
decision below, and the claim is now the size of its measurement.

So an admin account would add a column of the matrix identical to the customer's
and would create the appearance of a role being covered. It is left out, for the
same reason and in the same words as VAmPI's configuration leaves out its own.

The two roles that earn their place are `customer` — twice over, because BOLA
inside one tenant needs two equal accounts — and `anonymous`, without which half
the findings here ("this must not be public") cannot be reached at all.

## What the tool can find

Measured as anonymous, as customer alice, and as customer bob.

| Request | anon | customer | What a correct shop would do |
|---|---|---|---|
| `GET /rest/basket/{id}` of another customer | 401 | **200** | refuse: the basket is the owner's |
| `GET /api/Users` | 401 | **200** | refuse: it returns all 25 users with their email addresses |
| `GET /api/Users/{id}` of another user | 401 | **200** | refuse |
| `GET /api/Quantitys` | **200** | 200 | refuse to the public: stock levels are the shop's business |
| `GET /rest/admin/application-configuration` | **200** | 200 | refuse to the public |
| `GET /ftp` | **200** | 200 | refuse: it is a directory listing |
| `GET /api/Feedbacks` | **200** | 200 | refuse to the public |
| `GET /rest/memories` | **200** | 200 | refuse to the public |
| `GET /api/Recycles` | **200** | 200 | refuse to the public |
| `GET /api/Deliverys` | **200** | 200 | arguable — a shop may publish its delivery options |
| `GET /api/BasketItems` | 401 | **200** | refuse: it returns the items of every basket, byte for byte the same to each customer |
| `GET /api/Complaints` | 401 | **200** | refuse: it returns other customers' complaints |

Two shapes, and both are what module 1 exists for: an object read by somebody who
does not own it, and an endpoint open to somebody who has not authenticated.
Juice Shop's own list agrees with the first one by name — "View Basket", under
Broken Access Control.

The expectations in the right-hand column are a human's declaration and are not
derived from Juice Shop's behaviour or from its challenge list. That is ADR-0006,
and it is not a formality here: the challenge list describes what its authors
planted, while the policy has to describe what a correct shop does, and the run
is the comparison of the two.

## What must be declared as allowed, or the oracle proves nothing

`GET /api/Cards` and `/api/Addresss` answer 401 to anonymous and 200 to a
customer, with the caller's own records and nothing else. That is correct
behaviour for a scoped list and has to be declared allowed — a ground truth in
which every cell is a finding cannot tell a tool that works from a tool that
flags everything.

**`/api/BasketItems` and `/api/Complaints` were on that list until 19 August 2026
and did not belong.** They answer 401 to anonymous and 200 to a customer in the
same shape, which is what put them there — and their bodies are global.
Adversarial review measured eight basket items out of baskets 1 to 5 returned to
a customer who owns none of them, identical for both customers, and a complaint
belonging to user 3. Declaring them allowed made four genuine cross-customer
reads unfindable: the defect was hidden by the declaration, not by the tool,
which is the failure this format is most exposed to and the reason ADR-0006 puts
the declaration in a human's hands and then asks somebody else to attack it.

## What the tool will not find here

**Anything across tenants.** Juice Shop is single-tenant, like VAmPI: there is no
holding, no brand, no partner. Four of the five resource relations do not arise,
and the strongest thing this project does — the tenant hierarchy — is untested
by this polygon. That is a reason to keep the reference platform, not a reason to
skip Juice Shop.

**Everything that is a difference in the body only.** `/api/Users` returning
other people's email addresses is visible here because the endpoint answers 200
where it must refuse; if it had refused with 200 and an empty list, the tool
would have seen nothing without a declared body signal (ADR-0011).

**Everything behind a write.** "Manipulate Basket", "Forged Feedback", "Product
Tampering" and the rest of Juice Shop's access-control challenges sit on POST and
PUT, which the tool does not issue without `--unsafe-methods`.

## The bottom line

Worth adding, and worth adding for a reason the other two polygons do not give:
a broad set of **status-visible** access-control defects of exactly the two kinds
module 1 declares itself to check, with two customers to make ownership mean
something. What it does not give is tenancy, and nothing here should be read as
covering it.

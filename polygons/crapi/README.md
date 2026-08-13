# crAPI as a polygon: a reproducible run

The reconnaissance and its conclusions — [docs/polygons/crapi.md](../../docs/polygons/crapi.md).
Here is only what the run is repeated and verified with. crAPI (OWASP) is not
vendored into the repository: it is an external project under its own license.
It is taken from the original source.

## What is here

| File | What for |
|---|---|
| `barbican.run.yaml` | the run configuration: accounts, resources, the declared policy |
| `ground-truth.json` | the oracle in the format of [ADR-0012](../../docs/adr/0012-ground-truth-format.md): defects with a visibility marker, and the cells required to produce a finding |
| `verify.mjs` | bring the deployment up, get the tokens, run the tool, verify against the oracle |
| `tokens.mjs` | logging in crAPI's pre-seeded users |
| `docker-compose.override.yaml` | a stub for the chatbot upstream on top of the official compose |

## What is needed from outside

From the `OWASP/crAPI` repository (branch `develop`):

- the `deploy/docker` directory in full — `docker-compose.yml`, `.env`, `keys/jwks.json`;
- `openapi-spec/crapi-openapi-spec.json` — the source of endpoints for `--spec`.

Pull the images in advance, about 2.5 GB:

```
docker compose pull crapi-web crapi-identity crapi-community crapi-workshop
```

The verification checks that they are present and refuses to work if an image is
missing: there is no reason to pull a gigabyte and a half silently in the middle
of a run.

## Verification in one command

```
pnpm run build
CRAPI_DEPLOY_DIR=/path/to/crAPI/deploy/docker node polygons/crapi/verify.mjs
```

The script brings the deployment up (`LISTEN_IP` is set to `127.0.0.1` explicitly:
the polygon is deliberately vulnerable and is not published outward), waits for
`GET /health`, logs in three pre-seeded users, runs `dist/cli.js run` and compares
the findings against the oracle in both directions — what is missing and what is
extra. When it is done it shuts the deployment down together with the volumes;
`--keep` leaves it running.

Run of 13 August 2026 against a live deployment:

```
=== default ===
  setup: adam: logged in
  setup: pogba: logged in
  setup: admin: logged in
  cells probed: 60, canaries: 3, findings: 16 (expected 16)
  MATCHED the oracle, exit code 1

Total: variants 1, discrepancies 0.
```

Environment variables:

- `CRAPI_DEPLOY_DIR` — required, the `deploy/docker` directory of the crAPI tree;
- `CRAPI_SPEC` — if the specification is not in the same tree.

## Why there is one variant

VAmPI has two modes (`vulnerable=0/1`), the reference platform has nineteen
combinations of flags. crAPI has no switch at all: the defects are compiled in,
a "fixed" build does not exist. Its two environment variables,
`ENABLE_SHELL_INJECTION` and `ENABLE_LOG4J`, toggle defects of other classes and
change not a single cell of the access matrix.

That is why the variant's `selector` is empty — and this is declared in the oracle
in words, not left to guesswork. `verify.mjs` additionally fails if `selector`
turns out to be non-empty: that means the oracle changed, while there is nothing
to pass that change to the deployment with.

## Why `receive_report` is excluded

`GET /workshop/api/mechanic/receive_report` is named `create_service_report` in
the specification, described as "Create and Assign a Service Report" and declared
without authentication. This is a write hidden behind a method that is safe by the
letter: `--unsafe-methods` will not stop it, because the method is GET.

The endpoint is excluded by name through `exclude`. A request without the required
parameters gives 400 and a `probe-error` for every account — a cell the tool has
nothing to say about; a request with parameters would create a service report on
the deployment. `verify.mjs` checks that the endpoint is listed in the report as
skipped with the reason `excluded`: probed, it would change state in the middle of
a run.

In the oracle it is declared a defect with visibility `excluded` — the gap in
coverage is recorded as a statement, not passed over in silence.

## By hand, without the verification

`barbican` does not obtain tokens: crAPI's login is `POST` only, and safe mode
sends `GET`/`HEAD` alone. The operator logs in themselves:

```
eval "$(node polygons/crapi/tokens.mjs)"
```

The passwords of the pre-seeded users are published by crAPI itself
(`adam007!123`, `pogba006!123`, `Admin!123`) and sit in `tokens.mjs`: this is a
constant of a deployment on loopback, not a secret.

```
node dist/cli.js run \
  --config polygons/crapi/barbican.run.yaml \
  --spec  /path/to/crapi-openapi-spec.json \
  --report /tmp/crapi.report.json \
  --rps 20 --concurrency 4
```

## About signals over the body (ADR-0011)

`bodySignals.responseMustDifferByTenant` names three list endpoints that must
differ between users: `get_vehicles`, `get_orders`, `get_dashboard`. crAPI filters
them by owner correctly — the digests of different users diverge, and the
`identical-response-across-tenants` check stays silent. This is a correct zero:
the defect it looks for is not in crAPI. The public `get_recent_posts`/`get_products`
and the BFLA `get_workshop_users_all` are deliberately not put on this list —
their response, the same for everyone, is lawful, and declaring them would give
false positives.

## Cleaning up

`verify.mjs` shuts the deployment down itself. After `--keep` — by hand, from the
crAPI tree:

```
docker compose down -v
```

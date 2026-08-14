# Tasks

Phases and exit criteria — in [plan.md](plan.md).

## Session 2 — the core (closed)

- [x] **ADR-0006:** the expected matrix is declared by a human, not derived from the spec.
- [x] Policy types (`ExpectedAccessPolicy`) separate from the observed matrix.
- [x] `buildAccessMatrix` — assembly with an integrity check on the input.
- [x] `diffAccess` — a diff with a classification: escalation, unexpected denial,
      uncovered pair, probe error.
- [x] Fixtures: two tenants, three roles, four endpoints, a "clean" set of observations.
- [x] `@vitest/coverage-v8` and coverage thresholds for the core, a gate in CI.

Left over from this topic:

- [x] Endpoint selectors by a pattern of method and path. A rule element is either
      an identifier or `{ method?, path }`; `*` inside a segment, `**` across.
      Patterns are expanded into identifiers **before** the diff, so `resolveExpected`
      and the trustworthiness check are not touched at all.
- [x] The declared and the expanded policy are **different types**. The expanded one is
      assignable to the declared one but not the other way round, so the compiler will
      not let an unexpanded policy be passed where an expanded one is needed. Otherwise
      a pattern would survive to the comparison and silently match nothing.
      The compiler caught exactly this case in the CLI.
- [x] A pattern that matched no endpoint stops the run: the rule would never have
      applied, the pairs would have fallen through to `fallback`, and the report would
      have stayed clean. Checked on the platform — a typo gives code 2 before the first request.
- [x] The platform was moved onto a pattern in the administrator rule: 19 combinations
      agreed cell for cell, that is, the pattern expresses exactly the same set.
- [x] Detection of cross-tenant leaks — ADR-0010, the matrix became three-dimensional.

## Session 3a — the specification parser (closed 12 August 2026)

- [x] `SpecParser` on `@apidevtools/swagger-parser` with `resolve: { external: false }`.
      The port takes **the text of the document**, not a path: the parser has nothing to open.
- [x] **Blocking:** proof tests. They check not "was an error thrown" but that no request
      went out — the http server received not a single request, and the contents of the
      file did not reach the result.
- [x] Protection against a YAML bomb through `maxAliasCount`, plus size and depth limits.
- [x] `yaml` 2.9.0 and `@apidevtools/swagger-parser` 12.1.0 were vetted and added.

Established by experiment: the barriers close off different things. `resolve.external = false`
is protection against SSRF (with the explicit check removed the request still does not go
out), while an explicit refusal on an external `$ref` is protection against silent
degradation, because otherwise swagger-parser returns a result with no error and an
unresolved reference.

## Session 3b — HTTP and throttling (closed 12 August 2026)

- [x] `Throttle`: concurrency, a sliding rate window, a ceiling per run.
      A hand-written implementation instead of `p-queue` — the reasoning is in ADR-0001.
- [x] `HttpClient` on the built-in global fetch: a mandatory host allowlist,
      `SAFE_METHODS` only unless explicitly permitted, `redirect: "manual"`,
      the body is not read, sensitive headers are redacted.
- [x] Exponential backoff with jitter, `Retry-After` takes priority,
      a circuit breaker on a series of 5xx/429.
- [x] Coverage thresholds for `src/adapters` — separate from the core, so that a
      hundred-percent core does not mask a drop in the adapters.

Established by experiment: with `redirect: "follow"` the request really does go to a host
outside the allowlist. This is not a theoretical risk but a working bypass of the scope.

Left over from this topic:

- [ ] Retries and the circuit breaker currently live in the HTTP client. If a second
      transport appears, move them into a decorator over the port.
- [x] The allowlist tells entries with a port from entries without: `api.test` allows any
      port, `api.test:8443` exactly one.
- [x] The circuit breaker counts failed requests, not attempts. Before, with the
      defaults, a run stalled after two requests instead of five.
- [x] `pnpm run check` includes the coverage gate — the same one as in CI. Before, the
      local check said "all good" where CI failed.

## Session 4 — the CLI and the output (closed 12 August 2026)

- [x] **ADR-0008:** the configuration format. One YAML or JSON file; credentials are not
      stored in it — an account names an environment variable.
- [x] `src/io/config.ts`: parsing and validation through `zod`, a mandatory `allowedHosts`,
      and the host from `baseUrl` must be in it.
- [x] `src/runner.ts`: the walk over the account × endpoint matrix, reducing a status to
      an outcome about access, an explicit list of what was skipped and what failed.
- [x] `src/report/build.ts`: the JSON report and the exit code.
- [x] The `barbican run` CLI with the wiring and the throttling flags.
- [x] End-to-end tests: a planted defect is found, on a clean deployment there are no findings.

Checked by running the built CLI against a live server: the escalation was found, the exit
code was 1, and neither tokens nor `set-cookie` are in the report.

Left over from this topic:

- [x] The authentication scheme was moved into the configuration: `bearer`, `header`,
      `cookie`, `basic` (ADR-0008). The entry went stale and was closed after the fact.
- [x] Endpoints with parameters in the path are probed: the values are declared in the
      configuration.
- [x] `picocolors`, `pino` and `fast-redact` were not needed: colour comes from the
      built-in `node:util styleText`, and there are no tokens in the report by
      construction. This is a decision, not a task.

## Phase 2 — validation on public polygons

- [x] **ADR-0009:** the oracle is a hand-written list of known defects, not the polygon's
      switch. Measured: the VAmPI modes are indistinguishable by status.
- [x] A run against the real VAmPI. Three real discrepancies were found; two defects in
      the tool itself were fixed as a result (see below).
- [x] **ADR-0012:** a single oracle format. The VAmPI shape was taken as the basis, being
      the more complete one: a finding refers to a named defect, and a defect has a
      visibility mark (`status` / `body-signal` / `invisible`).
- [x] Both verifications were rewritten onto the shared module `tools/oracle/`: parsing
      the format, comparing as sets in both directions, trustworthiness checks and a check
      that the oracle is complete. The module is covered by 21 tests — it is load-bearing
      for every claim of the form "0 discrepancies".
- [x] The platform: 19 variants agreed after the rewrite. VAmPI: 2 modes,
      13 and 11 findings — the same ones as before it.
- [x] **The format was corrected twice in the course of the move.** `defect` became
      `defects`: with nested defects a shared cell is explained by both, and attributing
      it to one means declaring the other unverifiable — the completeness check
      surfaced this at once. Visibility grew from three kinds to six: `invisible` erased
      the difference between four different gaps.
- [x] crAPI got a machine-readable oracle in the ADR-0012 format: 22 defects,
      each with a declared visibility, verification through the shared module. It was
      checked for its ability to fail by tampering in both directions — the number of
      findings stayed 16 against 16, so on a count the verification would have stayed
      silent, while as sets it noticed.
- [x] The six kinds of visibility paid off exactly here: 6 `status`, 2 `body-only`,
      5 `unsafe-method`, 1 `excluded`, 8 `out-of-scope`. A single `invisible` would have
      erased the difference between four different gaps.
- [x] The deployment's passwords are overridden through the environment. The values are
      not secret — they are published in crAPI itself — but a "password as a literal"
      sample does not belong in the repository: a reader copies the shape, not the caveat.
- [x] `exclude: [create_service_report]` — **checked against the specification itself**
      on 13 August 2026, not taken on an agent's reading: in `crapi-openapi-spec.json`
      the `GET /workshop/api/mechanic/receive_report` carries `operationId:
      create_service_report` and the summary "Create and Assign a Service Report".
      A write behind a method that is safe by the letter — the same class as `GET /createdb`.
- [x] Collapsing inside the report itself was decided separately — ADR-0015, grouping by
      the signature "endpoint × kind × relation". It works on someone else's deployment
      because it needs no declared defects; the price is a lower bound instead of an exact
      number, and that is how it is worded.
- [x] The run against VAmPI is reproducible: `polygons/vampi/` with a docker-compose, a
      script that obtains the tokens and a verification over both modes. 0 discrepancies.
- [x] **The conclusion of ADR-0009 was refuted by its own revision condition.** Once
      values are substituted into the path, the VAmPI modes are distinguishable by status
      on `GET /books/v1/{book_title}` (200 against 404). The earlier "the reports match
      byte for byte" was measuring the tool's blindness, not a property of the polygon.
      The decision stood, the measurement did not; a dated clarification is in ADR-0009.
- [x] Substitution of values into templated paths.
- [x] An unauthenticated account: `tokenEnv` became optional.
- [x] Recon of crAPI was done on a live deployment — [docs/polygons/crapi.md](docs/polygons/crapi.md).
      As things stand the tool will find 1 reliable defect there (the BFLA `management/users/all`),
      and after identifiers are substituted — 3 BOLAs and 1 broken authentication on top.
- [x] Substitution into query parameters. A resource whose identifier is in the query
      string is tied to an endpoint by an explicit list: matching names cannot bind it.
- [x] A run against crAPI: everything marked visible by status was found — 6 classes of
      defect, 0 false positives. The details are in [docs/polygons/crapi.md](docs/polygons/crapi.md).
- [x] **ADR-0015: grouping by the signature** "endpoint × kind × relation".
      Role is not part of the signature: an endpoint open to everyone is one defect, not two.
      Relation is part of it: BOLA inside a tenant and a cross-tenant leak live on the same
      endpoint but break independently. On the platform 24 rows collapsed to 4 signatures.
- [x] The wording "at least N": the group of 12 cells on the platform is in fact
      **two** defects (`cross-tenant` 10 + `cross-holding` 2) with different branches in
      the code and one and the same signature from the outside. A lower bound called an
      exact number would be a lie in our own favour.
- [x] **ADR-0014: the severity of discrepancies and the semantics of exit codes.**
      Severity is derived from the kind of discrepancy and the relation, not declared:
      a leak into a foreign tenant is `critical`, BOLA inside a tenant and access to a
      function are `high`, access to one's own resource is `medium` (almost always a
      mistake in the policy, not a hole). On the platform this gave 12 critical and 9 high
      instead of a flat list of 21 rows.
- [x] **`unexpected-denial` now gives exit code 1.** A discrepancy is a discrepancy
      whichever way it points; the tool cannot know which side is wrong — the platform or
      the declaration — and since it cannot, it has no right to stay silent. Found by
      checking against the oracle: the holding was denied its own brand, and the run returned 0.
- [ ] Juice Shop — on leftover time.
- [x] **Both external polygons were re-verified on 13 August 2026** after request
      conditions, verdicts next to observations and the report edits: VAmPI — 2 modes,
      crAPI — 60 cells, 16 findings, 0 discrepancies. Along the way both got a
      `target.label`: the crAPI report did not name the system under test, and by my own
      rule you cannot file a ticket from a report like that.
- [ ] A VAmPI flake: `GET /createdb` answered 500 twice in a row, and the third run went
      through with no edits. It looks like container state rather than the tool —
      but if it repeats, the deployment is worth restarting between modes.

Found by the run against VAmPI and fixed:

- [x] A refusal to issue an unsafe method was recorded in `failures` — normal operation
      looked like a breakage. Now it is a skip with the reason `unsafe-method`.
- [x] The `exclude` list in the configuration. `SAFE_METHODS` protects against the
      semantics of the method, but not against an endpoint that violates them:
      `GET /createdb` resets the database and was actually called by the tool.
- [x] The CLI summary spells out the reasons for skips: a single number read as
      "something was not checked" with no explanation.

## Debt after the adversarial review (closed 12 August 2026)

- [x] A typo in a tenant hid a finding: whitespace is trimmed, and the optional
      `tenants` list turns on strict verification.
- [x] `..` in a resource value led above the base path: the address is assembled
      before the scope check, and both the origin and the path prefix are verified.
- [x] `{constructor}` latched onto any object through the prototype — `Object.hasOwn`.
- [x] Credentials in `baseUrl` are forbidden, and the URL in the text of a failure is redacted.
- [x] The canary respects the exclude list.
- [x] `allowedHosts` with a port is understood by the configuration, not only by the client.

## Phase 3 — multi-tenancy

The ownership model is implemented (ADR-0010) and checked by an end-to-end run:
on a deployment with a leak both sides are found, with the resource and the relation named,
and on a correct deployment there are no findings. What is left is the platform with
switchable defects.

- [x] The reference platform `polygon/`: 4 endpoints, two tenants, three defects
      switchable through env. Zero runtime dependencies, listens on `127.0.0.1` only.
- [x] A machine-readable ground truth for all 8 flag combinations, written by hand from
      the access model rather than taken from the tool's output. `verify.mjs` is the verification.
- [x] All 8 combinations matched the oracle, 0 discrepancies. Zero findings in the clean
      mode is not free here, unlike in VAmPI: turn a flag on and the findings are there.
- [x] The oracle was checked for its ability to fail with a defect **planted in the
      platform** (the admin endpoint open to everyone): 4 findings beyond the oracle in
      exactly those combinations where the defect is not declared, and the clean mode
      changed its exit code from 0 to 1.
- [x] A duplicate resource identifier reported `DuplicateAccountIdError` and sent the
      reader to the `accounts` section, where everything was fine. Found while building the platform.

## Signals over the response body (closed 12 August 2026)

- [x] **ADR-0011:** the invariant was refined from "the body is not read" to "the body is
      not stored". It is read in transit for the sake of irreversible scalars;
      `SignalValue` is only a number or a boolean, so a body structurally does not fit into it.
- [x] `src/adapters/signals.ts`: `digest` (48 bits, the salt is random per run),
      `count`, `present`. A path is segments separated by dots, no expressions.
- [x] A size ceiling: beyond it there are no signals at all. A digest over a prefix
      would claim a match between responses that differ past the cut-off.
- [x] The `identical-response-across-tenants` check is the first one in `CheckRegistry`,
      which means the ADR-0003 architecture has finally been tested in practice, not on paper.
- [x] The `responseMustDifferByTenant` declaration is made by a human; a typo in it is
      caught by `assertReferencesResolve` — otherwise the failure would be silent and hidden.
- [x] A check finding affects the exit code: otherwise a run with a cross-tenant leak
      found would look successful in CI.
- [x] The platform's fourth defect: `GET /v1/orders` with no tenant filter.
      It changes not a single status. The oracle was extended to 10 combinations, all matched.
- [x] Checked by mutations: `Object.hasOwn` → `in`, the ceiling → a prefix, a body
      planted into a signal bypassing the types — each one is caught. The mutation
      "the default salt is empty" **was not caught** until a test for the default was added.
- [x] Checked by removing the `responseMustDifferByTenant` declaration: 6 findings
      disappear, the exit code drops from 1 to 0. The declaration is load-bearing, not decorative.

Left over from this topic:

- [x] `count` and `present` are declared in the configuration (`bodySignals.signals`).
      They deliberately produce no findings — their consumer is the human digging into
      a digest finding. Checked on the platform: in the clean mode every account
      sees 2 records, with the defect — 4. A counter cannot be a finding: in the clean
      mode it matches across different tenants too, only the digest tells them apart.
- [x] A repeated signal name is rejected: names are keys of an observation, and a repeat
      would silently overwrite the previous scalar.
- [x] crAPI was re-run with signals on a live deployment. The isolation check
      stayed silent — and that is **a correct zero, not a gap**: three list endpoints
      are marked, the bodies were read, and the digests differ between users.
      crAPI filters those lists correctly; the defect being looked for simply is not there.
      Proved by contradiction: mistakenly marking the public feed immediately
      gives 3 findings. The run configuration is in `polygons/crapi/`.

## The limits of the model (analysis of 12 August 2026)

The analysis — [docs/research/coverage-model.md](docs/research/coverage-model.md).
Confirmed by running it, not by reasoning.

- [x] Established: `tenantId` is flat, there is no hierarchy of tiers. With a holding above
      two brands the tool is wrong **twice in one run**: it declares a lawful read of its
      own brand an escalation and does not notice a leak into a brand of a different
      holding. Pinned down by the witness test `tests/core/tenant-hierarchy.test.ts`.
- [x] **ADR-0013 and the implementation: the tenant hierarchy.** Explicit parent links
      rather than a path inside the identifier: a typo in the parsed prefix would
      silently reassign a tenant's kinship. `ResourceRelation` grew from three values to five —
      `descendant-tenant` and `ancestor-tenant` were added.
- [x] Full compatibility: with no links declared the behaviour is as before, and all
      polygon configurations work without edits.
- [x] The tree is checked at startup: an unknown parent, a cycle, a duplicate.
- [x] The holding scenario was run through the CLI: the platform gained a fifth
      defect `POLYGON_DEFECT_CROSS_HOLDING`, the oracle grew to 13 combinations,
      0 discrepancies. The previous 10 gave the previous results.
- [x] **The blocker this run found:** `relationSchema` in the configuration parsing
      was a hand-written duplicate of `ResourceRelation` and stayed
      three-valued. The whole hierarchy was unreachable through the CLI, even though the
      core understood it. The unit tests did not catch it: they build the policy as a
      TypeScript object, bypassing zod. The enum became the single source of truth
      in the core, plus a test for every relation through YAML.
- [x] The `identical-response-across-tenants` check was taught the tree: pairs
      related by kinship are not compared. Otherwise a lawful rollup of a holding
      with a single brand would be declared a leak on a healthy platform.
- [x] `ancestor-tenant` is covered by an end-to-end run: a holding-level resource
      on an endpoint of its own, the sixth flag `POLYGON_DEFECT_ANCESTOR_LEAK` —
      the mirror of `CROSS_HOLDING` (that one breaks the top-down view, this one the bottom-up).
      16 combinations, 0 discrepancies, no regression. The relation made it through
      parsing, the matrix and the diff to a report row with severity `high`.
- [x] The closing of the loop was checked on a live run: the mutation "the holding is
      denied its own document" gave code 0 before ADR-0014 and was caught only by set-based
      verification; now it gives code 1.

Left over from this topic:

- [x] A third tier: `holding-1 → tenant-a → affiliate-a1`. The seventh defect
      `POLYGON_DEFECT_PARENT_LEAK` climbs **one** level, whereas
      `ANCESTOR_LEAK` climbs the whole chain. 19 combinations, 0 discrepancies.
- [x] Proved by ablation, not by reasoning: removing the third tier **from the tool's
      model** while the deployment stays unchanged gives matching sets (3 and 3
      cells), while with three tiers they differ by exactly one cell: the affiliate
      reading the holding's document two steps up. Reproduced personally.
- [ ] A new honest limit: three tiers tell a step from a chain, but do not tell
      "exactly two steps" from an arbitrary number.
- [x] **Conditions with a query parameter are covered by a polygon cell.** The tenth flag
      `POLYGON_DEFECT_SCOPE_ALL_HONORED`: a hidden `?scope=all` removes the tenant
      filter. An attribute in the query string travels a different path than a header
      (through assembling the address), and the claim "it reaches the platform" rested
      on a single unit test. 25 combinations, 0 discrepancies.
- [x] The oracle caught a mistake in my own reasoning: the earlier list defect is
      visible under the new conditions too, because the brand branch hands out everything
      in both cases. Six pairs across seven combinations I had not foreseen. The consequence
      is written down in docs/report.md: two defect groups that differ only by
      conditions are almost certainly one breakage in the platform.
- [x] `present` did not see a field inside a list element and answered `false` instead of
      "there is no signal" — a wrong signal, indistinguishable from an honest negative.
      A numeric index in the path. Found by research into affiliate cabinets.
- [x] **A brand on a subdomain.** A tenant got a `baseUrl` of its own. The address
      is chosen by the **resource's** tenant, not the account's: we ask for someone else's
      data, and it lives on someone else's host. The canary goes to the host of its own
      brand — otherwise on a spread-out platform the run would stall with the false alarm
      "the token does not work". The scope does not widen: a tenant's host must be
      in `allowedHosts`, and credentials in the address are forbidden.
- [x] **Context attributes as a dimension of the matrix** — ADR-0019. Conditions are
      declared as a named set with a mandatory scope, a policy rule
      names them explicitly, and an account under conditions is a separate matrix row
      (`alice-a@geo-blocked`) with the same credentials. The platform's decision logic
      is not modelled: the outcomes of two declared sets are compared.
      On the polygon the ninth flag is `POLYGON_DEFECT_GEO_BYPASS`, the first defect
      that permissions cannot express at all; 23 combinations, 0 discrepancies.
      Three things were found along the way, each of which gave a green light on something false:
      the trustworthiness safeguard knew nothing about conditions and declared a **healthy**
      run untrustworthy; the rule schema was not strict, and the old build silently
      dropped `context`, turning "deny under these conditions" into "deny
      always" (19 findings on a clean platform); `verify.mjs` printed the sum of
      two counters, counting findings by body twice — 88 against 76 rows —
      and the verification stayed green through it, because it compares sets.
- [x] 451 is recognized as a denial on a par with 401 and 403: "unavailable for legal
      reasons" is a decision not to serve, not a failure. Without this, geo restrictions
      would give a wall of `probe-error` right where the platform does work.
- [ ] SoD is **not to be done** in this module: it requires writes and state, and belongs
      to a different class of tool. Record the decision if it is ever disputed.

## Readiness for different authentication surfaces

- [x] **ADR-0016: an authentication scheme per account.** Named schemes at the root,
      a reference by name on the account. The shape was not chosen for brevity: the
      scheme's parameters belong to the surface, not to the account, and repeated on
      every one of them they will drift apart through a typo — and a typo in a
      **parameter** cannot be caught by anything (`opsi` is just as legitimate a cookie name).
      A typo in a **reference** is caught: a name is either declared or it is not.
      Having both ways at once is deliberately not allowed.
- [x] The platform is split across three surfaces: customer accounts by Bearer,
      the operator console by the `opsid` cookie, the affiliate cabinet by a header.
      A token presented over the wrong transport is not accepted by the platform — otherwise
      the check would be a stage prop.
- [x] Checked by a mutation: `matchesScheme → return true` makes a trimmed-down
      configuration come out clean, which means the transport check is load-bearing, not decorative.
- [x] Every account's scheme is visible in the report (`accounts[].auth`). Without it
      the reader cannot tell "the endpoint is closed" from "we knocked with the wrong transport".

## The second cold read (13 August 2026)

The report together with both guides was handed to a reader with no access to the project.
The rating rose from 2 out of 5 to **3 out of 5**, but new real defects turned up.

- [x] **`summary.findings` counted only matrix discrepancies** — 18 against 24
      rows, while `byKind`, `bySeverity` and the sum of `violations` gave 24.
      The same class as the earlier `bySeverity` mistake, **in the same object**:
      I was fixing the neighbouring counter and did not notice this one.
- [x] An account without credentials is marked `anonymous: true`. Without the mark
      the report's only positive conclusion — "the anonymous account was denied everywhere" —
      is unprovable: an account whose token was passed wrongly would look the same.
- [x] `coverage.checksRun` — the list of checks that ran, including the ones that found
      nothing. Otherwise a check that someone forgot to register, or that crashed,
      gives a report indistinguishable from a clean one.
- [x] `connection`, `keep-alive`, `transfer-encoding` are no longer redacted.
      They carry no secrets, and a "redacted" mark on them undermined trust
      in the whole list: if these ended up here, what else did?
- [x] A self-contradiction in `docs/report.md` was removed: the "what is missing" section
      listed `runId` and `schemaVersion`, which are described two sections above.

Left over from the second read, in decreasing order of payoff:

- [x] `target.label` names the system under test. It is declared by a human —
      the tool cannot know it. Its absence is meaningful, and the CLI warns
      at startup: you cannot file a ticket against the platform from a report with no label.
- [x] `defectsBySeverity` next to `bySeverity`, and the summary prints both lines:
      "by severity of rows: critical 10" and "by severity of defects:
      critical 1". Rows are for working through, defects are for deciding.
- [x] The HTTP status in a finding: `actual: "allowed"` means no more than "2xx".
- [x] **A check finding carries the values, not only their comparison.** The scalars
      of both sides are held apart by the prefixes `own.` and `other.`, and the digest is
      given as a number: "admin-a sees 4 orders, carol-b from another tenant sees the same 4"
      now reads out of the finding itself instead of being assembled by joining observations.
- [x] The linking rule is documented: an observation is identified by the triple `accountId` +
      `endpointId` + `resourceId`, and the same triple links a finding to an observation.
      Observations deliberately have no identifier of their own — the triple is the cell.
- [x] **`coverage.bodyComparison`: the compared pairs separately from the ones skipped
      by kinship.** On the polygon run — 8 compared and 13 skipped out of 21.
      The skip rule was moved into a single function next to the check itself: a duplicate
      inside the coverage counter would have drifted from the check silently.
- [x] The structure of `observations[]` is documented. The claim "an observation passes no
      verdicts" was overturned by the third read and ADR-0020: the price turned out to be
      higher than the benefit.
- [x] The documentation says where the severity of findings by body comes from: they have
      no `relation`, and the check itself assigns the severity.
- [x] The ADR links point to GitHub rather than to a neighbouring file, and the document
      says outright: no conclusion requires following a link.
- [x] Stated: a set of tenants systematically **lowers** severity, because
      you declared the membership and the tool compares behaviour against the declaration.
      A set wider than the real one silently weakens the report — there is nobody to check what it holds.

## The third cold read (13 August 2026)

The report of a run with request conditions and both guides were handed to a reader with
no access to the project. The rating was 3 out of 5. Four mistakes turned up, each of
which changed the **numbers** rather than the convenience — and all four came from one place:
an account under conditions had no reference back to the original one.

- [x] **Ownership of a resource was lost.** The owner is recorded as `alice-a`, the row
      is called `alice-a@geo-blocked`, the check went by the row — and an account's own
      order became `same-tenant`: severity from medium to high on four
      findings, and the `own` defect group vanished from the report entirely.
      Fixed with `baseAccountId` and a single `principalOf`.
- [x] **The authentication scheme printed for a row under conditions was the root one.**
      `admin-a` goes by cookie, while `admin-a@geo-blocked` in the report goes by bearer.
      The field lied in exactly the place where it is the only thing that helps:
      "the endpoint is closed" against "we knocked with the wrong transport".
- [x] **Check findings had no `contextId`.** Fields were carried over one by one by name,
      so a new one was silently lost — and the grouping merged a finding under conditions
      with the baseline one, declaring two breakages to be one.
- [x] **The `request` of a finding under conditions reproduced the baseline case.** An attribute
      in the address is visible, an attribute in a header is not. 43% of the run's findings
      reproduced with the wrong request. `request.contextHeaders` was added;
      there are no credential headers there and there never will be.
- [x] `defects[].accountIds` named one side of a paired finding out of two:
      the second was in the `evidence` of every row.
- [x] `summary.accountRows` next to `accounts`: 9 accounts × 6 endpoints did not give
      144 cells, and the reader's arithmetic did not add up.
- [x] `coverage.cellsMatched` — "tested and agreed" as a number, not as the reader's
      own subtraction.
- [x] A limit that was not there before is named: **the tool cannot check the delivery of
      context attributes**. A header stripped by a proxy gives requests
      indistinguishable from the baseline ones, and the report will say "the restriction
      does not work" where it was never checked.

Left over from the third read:

- [x] **The verdict next to the observation** — ADR-0020, the project owner's decision
      out of four proposed variants. `expected`, `match`, `relation`,
      `ruleIndex` in every observation; the source is the same walk that gives the
      findings (`describeCells` and `diffAccess` call a shared `walk`).
      The report grew from 148 to 161 KB, not doubled as I had guessed by eye.
      The earlier principle "an observation passes no verdicts" was overturned deliberately:
      in the report the policy is frozen together with the run, and the verdict is determined.
      The first version of the invariant test was empty — the fixture had no resources,
      and the mutation "a discrepancy involving a resource is declared matched" passed green.
- [x] An observation has `at` — the moment of the request in ISO-8601. Along the way
      correlation headers (`x-request-id`, `traceparent` and the like) are no longer
      redacted: they carry no credentials, and without them a finding cannot be matched
      against a record on the platform's side.
- [x] `accounts[].tokenEnv` in the report: the name of the variable, not the value.
- [x] A paired finding prints both requests: `request` and `relatedRequest`.
- [x] `inputs.exclude` — what the operator excluded by hand.
- [x] `inputs.throttle` — the limits that were in force, as throttling itself resolved them.
      The port declares them outward: a second merge of the defaults with the CLI flags
      would have drifted from the real behaviour silently.

## Adversarial review of request conditions (13 August 2026)

Run by the rule in CLAUDE.md — after edits in `src/adapters` and `src/report`.
It broke through **four holes, all of them in what was done the same day**. Each one
with a reproducible PoC; all of them reproduced by me personally before and after the fix.

- [x] **Conditions performed a write without `--unsafe-methods`** (critical). The header
      `x-http-method-override: DELETE` — and the deployment **deleted a resource** while
      a GET went out on the wire, and the report wrote `writeMethodsProbed: false`. The
      `SAFE_METHODS` gate looks at the request method and does not see a bypass like that.
      In the same place `x-original-url` led a request past the declared path,
      and `x-forwarded-host` past the ban on substituting the host.
      Fixed with three layers: exact names, family prefixes, **a check
      by value** (the value equals the name of a method → refuse). The last one catches
      a vendor header nobody has heard of as well.
- [x] **A token in the query string substituted the account** (high). `access_token`
      in the conditions — the platform served the request as a different account,
      while the report named the original one. On top of that the value went into the report
      in plain text: request addresses are printed there.
- [x] **An attribute rewrote a resource's key** (high). The verdict was computed
      from the declared resource while a different one was requested: a cross-tenant leak
      landed in the report as "own resource, tested and agreed" and got
      into `cellsMatched`.
- [x] **A run that got in nowhere produced a clean report and code 0** (high).
      A policy of denials only + stale tokens + no canaries:
      `findUnauthenticated` stays silent by construction, because nothing
      was declared accessible. Now `canariesChecked: 0` means code 2; accounts
      without credentials are excluded from the rule.
- [x] **`!!omap` and `!!set` were invisible to the specification walk** (medium).
      An external `$ref` under such a node slipped past the barrier, and `paths` under it
      gave **zero endpoints without a single error** — a hundred percent coverage of nothing.
      Psych emits such documents as a matter of course. They are now rejected.
- [x] **`cellsMatched` disagreed with the number of verdicts** (low), even though ADR-0020
      promises equality: the subtraction included `not-observed` cells, which have
      no observation at all.
- [x] Small things from the same place: the ban list became a `Map` (the header
      `constructor` produced a message about `[native code]`); attribute names and values
      are checked for being fit to send — before, every cell of such a
      run died with an opaque failure.

Not broken (targeted attempts): substituting a credential header through case,
whitespace, unicode and a duplicate key; substituting `credentialAccountId`; the secret
from `tokenEnv` in the report and the logs; redirects; the host allowlist (18 cases);
the absence of a body in `HttpResponse`; throttling with no "no limits" mode;
a divergence between `describeCells` and `diffAccess`.

- [x] **The value of a context attribute can come from the environment**: the form
      `{ env: NAME }` next to a literal, exactly like `tokenEnv` on an account.
      What goes into the report is the **name** of the variable; the value lives only in the
      environment. An important implementation detail: the method-substitution check was moved
      onto the **resolved** values — a declaration `{ env: VERB }` with `VERB=DELETE`
      would otherwise have slipped past it. A skipped resolution step is also a refusal,
      not a silent object in a header.

## Cold read of the README and the path "from zero to a run" (13 August 2026)

The exit criterion of phase 4, taken literally: the reader was forbidden to open
`src/`, the tests, `tasks.md` and the ADRs — only the README and wherever it sends him.
He got to a meaningful run in ~11 minutes and 22 commands, but **not by the path
the README proposes**. Rating 3 out of 5, five guesses.

- [x] **Blocker: the first two commands in the README do not work.** The published
      `barbican@0.1.0` is a stub: its `dist/cli.js` is 1299 bytes with not a single
      registered command, while in the repository under the same version number it is
      19907 bytes with the `run` command. Checked by unpacking the package from npm.
      The README now says so outright and leads through a build from source.
- [x] **The format of the `--endpoints` file was documented nowhere.** The reader
      reconstructed it from a TypeScript snippet in a neighbouring document — "guessed
      right, but that is luck, not documentation". The source of endpoints is mandatory and
      there is exactly one.
- [x] `target.label` was not mentioned in the configuration guide, even though the CLI
      complains about its absence on every run.
- [x] Raw zod messages on the two loudest invariants: "the mandatory
      allowlist" answered `expected array, received undefined`, and `fallback` answered
      `Invalid option`. Both are spelled out in the guide in whole paragraphs, while what
      the reader got was a quibble about a type.
- [x] The numbers in `polygon/README.md` went stale: 8 rows of the table out of 21 are wrong,
      the number of defects diverged in four places, the accounts table was printed
      twice, and two "Verification result" paragraphs were glued together. Re-taken from a run.
- [x] `README`: the YAML says `role`/`tenant`, TypeScript says `roleId`/`tenantId`;
      nowhere was it said that these are the same thing.

What the reader marked as working: the README explains well **what the tool
does not do** ("a rare and strong point"); the error texts name the consequence,
not the fact; every promised stop at startup really does fire; the claims in
`report.md` that can be checked on the spot all held, every one.

Left over:

- [x] The version was raised to `0.2.0`, the package was built and **checked as if by an
      outsider**: the tarball was installed into a separate directory, and `barbican run`
      from `node_modules/.bin` was run against the polygon with `CROSS_TENANT` switched on —
      10 findings, exit code 1, and its own version in the report. That is, what gets
      published is not a stub.
- [x] **`barbican@0.2.0` was published on 13 August 2026 through a release by tag.**
      The trusted publisher is declared on npmjs.com, and the publish went through OIDC
      without a single long-lived token. Checked by installing **from the registry**,
      not by the CI log: the `run` command is in place, the version is its own,
      and `npm audit signatures` confirms SLSA provenance.
- [x] The README was rewritten for a working package: `npm install barbican` is back
      at the top, with the caveat that `0.1.0` is a stub.

The very first run of the new CI job found a real vulnerability, and that knocked
two of the project's defences against each other:

- [x] **GHSA-2v37-7h3g-55p8 in `nanoid` 3.3.17** (CVSS 8.2): an infinite loop
      in `customAlphabet`/`customRandom` when `size = 0`. It is not reachable,
      and that was checked: the dependency is transitive and development-only
      (vitest → vite → postcss → nanoid), the `0.2.0` tarball holds not one of its files,
      and postcss calls `nanoid(6)` with a constant.
- [x] The fix 3.3.18 came out on 7 August — **younger than our own 7-day cooldown** —
      and `pnpm update` silently left the old version. Lowering the threshold for the sake
      of an unreachable finding would mean trading protection against a compromised fresh
      release for protection against a DoS that does not exist.
      The decision: an `osv-scanner.toml` with an exception **for two days** and a written
      reachability analysis. Checked that the exception is targeted: another
      vulnerability with the same config still fails the scanner.
- [ ] 🔴 **MANDATORY, 14 August 2026 after 16:41 UTC.** Update the lockfile
      to `nanoid` 3.3.18 and delete the entry from `osv-scanner.toml` entirely.
      Check that the lockfile really holds 3.3.18: when the cooldown fires,
      pnpm silently leaves the old version. The deadline is not invented — it is the moment
      `minimumReleaseAge` expires, counted from the publication on 7 August at 16:41 UTC.
      After `ignoreUntil = 2026-08-15` the scanner will start failing CI on its own, and if
      the item is not closed, a red CI becomes normal — and a normally red
      CI is not read.
- [ ] `pnpm update` says nothing when the cooldown has fired: it prints
      "Lockfile passes supply-chain policies" and leaves the old version.
      You cannot tell "there are no updates" from "the update was blocked by the threshold"
      from the output — exactly the class of silence the whole project is written against.
- [x] The example numbers in `docs/report.md` are marked with the run they were taken from,
      and it is said outright: they show the shape of the output, not a reference to compare
      against, and a difference is not a discrepancy. Generation does not cure this: the numbers
      are embedded in prose that explains what they mean.
- [x] **The verification table is printed by the run.** `--update-readme` writes it between
      the markers, `--check-readme` fails the verification on a discrepancy, and CI runs
      exactly that one. Checked by a mutation: I changed 10 to 11 in the table — exit
      code 1; rolled it back — 0.
- [x] **All user documentation is in English**: the README, both
      guides, the READMEs of all three polygons, the crAPI analysis, `examples/`.
      Along the way the output of the verification and oracle scripts themselves was
      translated — otherwise the documents would describe output that does not exist:
      the translation pointed this out honestly.
- [x] The translation turned up two mistakes that were there in the Russian too: a heading
      about the "hash sign" in an account name (it is about `@`) and a link to ADR-0017 where
      the reasoning is about authentication schemes, that is, about ADR-0016.
- [x] **The volume of traffic is given in numbers in the README** — the section "How much
      traffic it makes": one cell equals one request, the cost of a run is
      roughly "accounts × endpoints × resources", the defaults are 2 / 5 / 2000.
      The table **is checked by a test** against `DEFAULT_THROTTLE_LIMITS`: a promise
      to the user that has drifted from the code is the same class as everything else.
- [x] **Rejected after review: an extra declared tenant does not need to be caught.**
      The cold read called it "the same class as a typo in an account's tenant,
      only from the other side". The premise did not survive scrutiny.
      A typo in **use** is already caught by `UnknownTenantError`, so
      an unused tenant hides nothing. And describing the platform's tree
      in full while testing three brands out of ten with accounts is a legitimate
      and frequent case: `foreign-tenant` relations are computed on that tree.
      I implemented the check, saw that it fails three legitimate fixtures,
      and rolled it back. The comparison with an unused authentication scheme is wrong:
      there an account silently falls through to the default scheme and gets a 401,
      here nothing happens at all.

## Review of 13 August 2026 (after the messages were translated)

- [x] **Verified against the libraries' documentation (context7), not from memory.** zod 4:
      `z.enum(values, { error })`, `z.array(schema, { error })` and
      `z.url({ protocol })` are existing API, and the message applies to a
      missing field as well. The `yaml` package: `maxAliasCount` is the standard
      protection against exponential alias expansion, and `uniqueKeys` is on
      by default.
- [x] **There is no prototype pollution through YAML** — checked on three vectors
      (`__proto__`, a merge key, `constructor.prototype`): the parser puts them down
      as own properties, and the global prototype is not touched.
- [x] **But the `__proto__` key silently disappeared during validation**: a declared
      condition header did not go out on the wire and did not complain. Now the raw document
      is checked before parsing and such a key is rejected with an explanation.
      A small thing by probability, but exactly the class the whole project stands against.
- [x] **Verification against the oracle was added to CI** as a separate job. 25 combinations,
      plain Node with no Docker, about a minute and a half. The strongest correctness check
      in the project used to run only on my machine and only when I remembered it.

## Write methods (closed 14 August 2026)

`--unsafe-methods` had existed since the CLI did, and not one oracle cell ever
walked the path behind it. A flag that turns on untested code is a claim, not a
capability.

- [x] **The polygon gained a write endpoint** — `POST /v1/orders/{orderId}/cancel` —
      and two switches behind it: a cross-tenant write and a write with no owner
      check. Cancelling rather than a mutation the traversal can observe:
      authorization never reads `cancelled`, so the oracle does not depend on the
      order in which cells are walked.
- [x] **The policy declares the read/write asymmetry.** A holding may read a rollup
      across its brands and may not cancel their orders — an explicit `denied`
      rather than a fall-through to `fallback`, because that difference is the
      whole reason the endpoint exists here.
- [x] **Three oracle variants carry `unsafeMethods: true`.** 28 combinations, 0
      mismatches; 180 cells with the flag against 144 without, the findings carry
      `"method": "POST"` and `writeMethodsProbed: true`.
- [x] The guide got a section on write methods: what the flag turns on, what it
      costs to be wrong, and what a policy needs before it is passed.

## The fourth cold read (14 August 2026)

A read from the position of someone installing 0.2.0 from npm and never opening
the repository. Everything the tool promises about safety held up under
experiment — write methods skipped without the flag, the redirect trap on a
second port got zero requests, `set-cookie` and the tokens absent from a 21 KB
report, the budget cut giving `truncated: true` and exit 2. What did not hold up
was the packaging.

- [x] **The tarball of 0.2.0 carries a pre-release README.** The tag was cut from a
      commit that still said "build from source until `0.2.0` is published", and
      npm shows the README of the tagged commit — so the package page talked
      readers out of the package it was serving. Closed by a test rather than by
      care: `tests/docs/release-readme.test.ts`.
- [x] **The package contained no documentation and no example.** `files: ["dist"]`,
      so every relative link in the README was dead for anyone who installed
      rather than cloned, and the one thing a new user needs first — a whole valid
      configuration to copy — was outside the package. Now `docs` and `examples`
      ship; `polygon/` deliberately does not (ADR-0021).
- [x] **The canonical template tripped its own warning:** `examples/minimal/` had no
      `target.label`, which the tool warns about on every start.
- [x] **The guide never said where endpoint identifiers come from.** With `--spec`
      the `id` is the `operationId`, and an operation without one gets
      `"GET /v1/admin/users"` — a name with a space that a rule has to quote. The
      reader worked this out by reverse-engineering `endpoints[]` in the report.
- [x] **The README's library example printed an object that the library does not
      print** — `severity` was missing and the key order was wrong. A "run this,
      see that" claim is the cheapest kind to check and the most embarrassing to
      get wrong.
- [ ] **The error "endpoint is not among the parsed ones" does not list the parsed
      ones.** It explains why the mismatch matters and leaves the reader to guess
      what the right name was. The list is right there at the point the error is
      raised.
- [ ] **The canary blames a stale token for a dead port.** `ECONNREFUSED` produces
      "401 reads as a refusal, and the report would have looked clean" — the
      reader went looking for a token problem. Transport failure and a refusal are
      different facts and deserve different sentences.
- [ ] **The summary says "at least 1 defect" next to exit code 0.** Correct by the
      contract — a low-severity `probe-error` does not fail a run — and still reads
      in CI as "a defect was found and the build is green".
- [ ] **No JSON schema for the configuration ships with the package**, so an editor
      offers no completion for a format whose every field is hand-written.

## Blockers for a run on someone else's platform

They lay mixed in with everything else, which made them read as equals. They are not equals:
without them the only person who can run the tool is its author.

- [x] ~~The authentication scheme~~ — four schemes in the configuration: `bearer`, `header`,
      `cookie`, `basic` (ADR-0008).
- [x] **Request signing is a case for the library, and now that is true** (ADR-0018).
      The earlier entry claimed that a consumer of the library could implement
      its own scheme: the port is exported. **The claim was false** —
      `headersFor(accountId)` saw neither the method nor the address, and on top of that `runner`
      computed the headers once per account. There was nothing to sign and nothing to sign with.
      The port got `SignedRequest { method, url }` and is called for every
      request, the canary one included. The signature format is still not described
      in the configuration — invented blind it would come out matching a real platform
      halfway, and a half-correct signature gives 401
      everywhere, that is, a report saying "there is no access anywhere".
      The example from the guide was checked against the **built** package: `tsc --noEmit`
      with code 0 and a live run, not a reading of the code.
- [ ] A `signature` scheme in the configuration — once **two** platforms
      with signing show up. One will not reveal what is common, and a mini-language for
      canonicalization derived from one would turn into a bad templating engine.
      The revision condition is in ADR-0018.
- [x] ~~Endpoint selectors by pattern~~ — closed, the platform was moved
      onto `path: /v1/admin/**`, and 19 combinations agreed.
- [x] **User documentation** — [docs/guide.md](docs/guide.md) and
      [docs/report.md](docs/report.md). Written **from the cold reader's
      misunderstandings**, not from the structure of the configuration: otherwise it would
      have come out as a field reference instead of a guide. The examples in the guide were
      checked by parsing them.
- [x] The user documentation was checked by a cold read twice — the second
      and the third, both times together with a real report. The rating of the report rose
      from 2 out of 5 to 3 out of 5; the questions the guides had settled did not
      come back the second time.
- [ ] The README and the path "from zero to the first run" have **never** been checked
      by a cold read: what was read was the report and the guides, not the installation.
      That is exactly the exit criterion of phase 4 — an outsider following the README gets
      `npx barbican` to a meaningful run.
- [x] **The assumption was checked by a cold read.** A real report of a defective
      run was handed to a reader with no access to the project (two files only, with
      everything else forbidden to open). The report's self-assessment: **2 out of 5**.

Fixed straight away, all of it confirmed by measurement:

- [x] **`bySeverity` did not count check findings** — the summary showed high: 5
      where there are 11. A dashboard built on the summary lost six findings, and among them
      the most exploitable one. This was a counting defect, not a matter of taste.
- [x] Canaries — a verdict by name instead of a counter. "7 checked" without "did they pass"
      is indistinguishable from canaries that failed silently.
- [x] The summary lied with arithmetic: "80 pairs, 6 endpoints, 8 accounts", while 6×8=48.
      A cell is the triple "account × endpoint × resource", and that is how it is written now.
- [x] `cache-control` and `date` are no longer redacted. The first changes **the assessment
      of the damage**: a cross-tenant leak with `public` multiplies through a CDN. The second
      is the only handle for matching a finding against the server log. Neither of them carries
      credentials; `set-cookie` is still cut.

Left over from the cold read, in decreasing order of payoff:

- [x] **The inputs in the report** — the `inputs` section: the expanded policy (the one that
      passed the verdicts, not the one in the file), the tenant tree, the kind of authentication
      scheme. There are no credential values there and there cannot be.
- [x] **A way to reproduce next to every finding** — the method and the address with the
      values substituted. The joining is done when the report is assembled; the core still
      knows nothing about addresses.
- [x] A finding names the rule: `ruleIndex` points into `inputs.policy.rules`.
      A missing field is the meaningful answer "the `fallback` fired", not an omission.
      The number points at the last rule that matched, because that is the one that wins.
- [x] **The taxonomies were merged.** One `findings` list, with the `source` field
      distinguishing the means of detection. A difference in the means is no longer passed off
      as a difference in the nature of the finding.
- [x] Three symptoms closed themselves out of this: `byKind` counts the checks,
      `bySeverity` needs no patch, the ADR-0015 grouping works
      on everything. Six clones collapsed into one signature — checked by a run:
      33 findings, 5 signatures instead of the previous four plus six rows.
- [x] `defects[].observations` was renamed to `violations`: one word in two
      meanings read as "the defect was observed on 10 probes out of some number".
- [x] `identicalBody` claimed more than was checked: the digests matched, not
      the bodies. Renamed to `bodyDigestsEqual`; the finding's title now speaks of the
      digest too, not of an "identical response".
- [x] `tenantScoped` was called a property of the API while it encoded the operator's
      declaration: `orders.read` did not carry it, although it is tenant-scoped by its very
      meaning and is precisely the one that leaks. Renamed to `responseMustDifferByTenant` —
      everywhere, including the key in `bodySignals`. See the clarification in ADR-0011.
- [x] The coverage denominator in the `coverage` section: how many endpoints were probed
      out of how many, how many cells were observed and not observed, and why they were not probed.
- [x] It is stated where no check was made: `bodiesComparedOn` names the endpoints
      one by one, `writeMethodsProbed` says whether write methods were issued. On every
      other endpoint the absence of a finding means "no comparison was made".
- [x] The sentinel is gone: `tenant` on an account is optional, and an account without it is
      outside of tenants. Its relation to any resource is `foreign-tenant`, and a sixth
      value was deliberately not introduced: it would **silently narrow the existing
      rules**, because `scope: foreign-tenant`, written to mean "an outsider must not",
      would stop covering the anonymous account, and the cell would fall through to `fallback`.
      Exactly the finding-hiding mechanism ADR-0013 was written against.
- [x] In `examples/minimal/` the anonymous account was attributed to `tenant-a` — a mistake
      worse than the sentinel: it counted as **one of their own** for a real tenant.
- [x] The stale warning in the README about flat tenants was rewritten.
      The hierarchy is implemented, but it is declared by a human — without a declared
      tree the old failure mode remains, and that is said outright.
- [x] `schemaVersion`, `runId` and `configDigest`. The fingerprint is computed over the
      parsed configuration rather than over the text: comments and indentation do not affect
      a run, while they would affect a hash of the text.

## Phase 4 — stabilization and publishing

- [x] **`publishConfig.provenance: true` is back**, and publishing was moved
      to trusted publishing: `.github/workflows/release.yml` on a `v*` tag,
      credentials through OIDC, not a single long-lived token. The recorded
      blocker went stale: npm locally is 11.19.0 against the required 11.5.1.
      The tag is checked against the package version before publishing — otherwise something
      other than what is tagged in the history would go to the registry.
- [x] The trusted publisher is declared on npmjs.com, and `barbican@0.1.0` — the
      stub whose CLI registered no commands — is deprecated in the registry with a
      message pointing at 0.2.0. Both done by the owner on 14 August 2026.
- [ ] Changesets for versioning — **a new dependency, and I am against it**.
      Vetted by the project's rules (13 August 2026): `@changesets/cli`,
      MIT, 2 maintainers, 126 releases; the latest, 3.0.0 of 11 August, is younger than
      the 7-day cooldown threshold, so the real candidate is 2.31.1 of 15 July.
      **21 direct dependencies and 40 transitive packages** — against the current
      256 in the whole lockfile, that is, growth of the tree by roughly 16%.
      What it gives in return: change-description files and an automatic changelog.
      Here the version is moved by hand every few days, a release is made with a tag,
      and the check "the tag equals the package version" is already done by the release.
      My proposal is not to take it on; revisit if a second package appears in the repository
      or releases become more frequent than one a week.
- [x] User documentation — closed above (docs/guide.md, docs/report.md).
      The entry here was a duplicate from the old phase 4 plan.

## Open Dependabot PRs (closed 12 August 2026)

Two out of three proposed rolling back deliberate decisions — normal Dependabot
behaviour, but merging them was not an option.

- [x] **#2 Biome 2.5.6 → 2.5.7** — updated locally, the schema in `biome.json` was migrated.
- [x] **#1 TypeScript 7.0.2** — rejected: a preview with `API: not ready`, while `tsc --noEmit`
      is a CI gate. The reasoning: [ADR-0001](docs/adr/0001-stack-and-versions.md).
- [x] **#3 `@types/node` 26.1.1** — rejected: the 22 line is pinned under `engines: >=22.12.0`.
- [x] `ignore` for `typescript` (>=7) and `@types/node` (>=23) in `.github/dependabot.yml`.

Lift these bans together with the corresponding ADR, not "along for the ride" with an update.

## Publishing

- [x] `barbican@0.1.0` was published on 12 August 2026, and the GitHub link appeared on the
      package page. The version has no provenance: the publish was manual — see
      the clarification in [ADR-0004](docs/adr/0004-supply-chain-hardening.md).

## Infrastructure, not urgent

- [x] **OSV-Scanner in CI** as a separate job. The binary is installed directly
      and verified against a pinned checksum — the same reason as with gitleaks:
      an action pulls its own version, and the verdicts drift apart silently. Version 2.4.0,
      one step behind the latest on purpose: 2.5.0 came out a week ago, while the cooldown
      threshold in this project is 7 days. Checked locally on this same
      lockfile: 128 packages, no findings.
- [ ] Keep the gitleaks version in CI (`GITLEAKS_VERSION` in ci.yml) in agreement with the
      local one from Homebrew. When the local one is updated, update the version and
      `GITLEAKS_SHA256`, otherwise CI and pre-commit will start to differ in their verdicts.
- [ ] A quarterly review of the thresholds for revisiting decisions — the table in [plan.md](plan.md).
      The nearest one expected: `@apidevtools/swagger-parser` around April 2027.
- [ ] Revisit TypeScript 7 once it leaves preview and stabilizes its public API.

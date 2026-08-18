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

## Walking through adoption on a real platform (14 August 2026)

Not a review and not a run: a walk through the questions someone asks when they
already have a platform, an OpenAPI document and a Roles & Access Matrix, and
want to know what else it will cost them. Two contours — staff with their own
accesses, customers with roles and **statuses**. The exercise found gaps of two
kinds, and the second kind is the larger one: places where the tool can do the
thing and nowhere says so.

### The model cannot express it

- [ ] **A contour has no address of its own.** A base address can be declared on a
      **tenant** (brands are spread across subdomains), never on an authentication
      scheme. Contours split across subdomains — `admin.example.com` beside
      `api.example.com` — therefore need two runs, and two runs lose the surface ×
      surface matrix: whether the operator's cookie opens a customer endpoint, and
      whether the customer's token reaches an administrative one. That matrix is
      the reason ADR-0016 exists, so the gap cancels the feature exactly where it
      was meant to pay off. The obvious workaround — declaring a contour as a
      tenant to borrow its `baseUrl` — must stay forbidden: it would make `own`,
      `same-tenant` and `foreign-tenant` mean something else, and the findings
      would be noise rather than wrong. Likely shape: an optional `baseUrl` on an
      entry in `authSchemes`, with the host still required to be in
      `allowedHosts`.
- [ ] **Granted access is not a relation.** The five relations describe **belonging**
      — whose the resource is and how the tenants are related. They cannot say
      "Anna shared this document with Boris". On any platform with sharing, an ACL
      or a guest link, the whole class is out of reach: a legitimate share and a
      leak are the same `same-tenant` cell. Needs thought before it is promised
      anywhere.
- [ ] **Permissions that depend on the resource's state** — a draft may be edited, a
      published one may not. Works around to declaring two resources with different
      identifiers and separate rules, which is honest and costs a line. Worth a
      paragraph so nobody concludes it is impossible.
- [ ] **Permissions that depend on the request body.** Conditions carry headers and
      query parameters only. A deliberate boundary today, and it is the boundary a
      platform reaches the moment an endpoint decides by a field in the payload.

- [x] **A role a rule names and no account carries fails in silence.** Found while
      checking the two items below against the code: the guide said "read a role
      selector twice; nothing else will", and that was accurate. Measured on the
      reference platform — `roles: [admin]` misspelled `admni` takes a clean run
      from exit 0 and no findings to exit 1 with a privilege escalation against
      `admin-a × admin.accounts` that is not there, `warnings: []`, and no line
      saying a rule matched nothing. The evidence is in the report and unsurfaced:
      that finding's `basis` is `fallback` where a rule was meant to decide.
      The quieter direction is worse. Misspell the role on a rule declaring
      `outcome: denied` and the expectation disappears; the cell agrees with the
      fallback, and the finding the rule was written to catch is not reported.
      Refused at startup like every other declaration that matches nothing — an
      unknown endpoint id, an empty rule selector, a policy pattern fitting no
      endpoint, a resource fitting no endpoint. The reverse direction is left
      alone deliberately: an account whose role no rule mentions is a real
      statement, and with `fallback: denied` a useful one.

### The documentation does not say it

- [x] **What `role` actually is.** It is a label for a group of accounts expected to
      have the **same** access — it need not match the platform's own role names,
      and nothing in the guide says so. The whole question of how to model customer
      statuses hangs off this sentence, and today a reader has to infer it.
      Closed 18 August: `docs/guide.md` gains "A role is a group of accounts, and a
      status is not a condition", which says it in the first line and gives the case
      that forces the point — a brand administrator and a holding administrator are
      one word in the platform's table and must be two labels here, because under a
      single label every rule about one is a rule about the other.
      Marked open until today though the section had been written: the eleventh
      checkbox this month whose work was already done.
- [x] **A status of an account is not a condition of a request, and the two are easy
      to confuse.** A blocked customer, an unverified one, a VIP tier — persistent
      state, expressed as separate accounts under distinct role labels, and each
      needs a real account in that state. A customer from a prohibited country, an
      unrecognised device — conditions of the request, expressed as a `context`
      over one account. Pick the wrong one and you either cannot get the accounts,
      or you check a restriction where you meant to check an entitlement.
      Closed 18 August, in the same section: the same platform and the same
      endpoint modelled both ways, side by side, and what each declaration ends up
      asserting.
- [x] **How to carry over an existing Roles & Access Matrix.** Closed 18 August:
      `docs/guide.md` gains "Carrying over a matrix you already have". One row of a
      spreadsheet — three ticks — becomes five rules, and the section says what the
      transcription forces somebody to decide: a tick means *own* or *anyone's*,
      the sheet cannot tell them apart, and that gap is where BOLA lives.
      Three things it states that the sheet never records. The `denied` rules are
      not redundant even under `fallback: denied` — a matched rule is named in
      `basis` and `ruleIndex`, so a finding cites the line somebody wrote instead
      of "no rule matched", which is the difference between a ticket a team
      accepts and one they argue with. A missing `scope` is not `own` but "any
      relation", the widest reading and the one that hides BOLA. And a matrix
      exported from the code compares an implementation with itself and would pass
      with every check removed — ADR-0006.
      Plus the advice that keeps a large sheet from being transcribed pointlessly:
      only rows whose path takes a resource identifier have a relation to get
      wrong, so twenty well-declared endpoints say more than two hundred guessed.
      The example is parsed and its references resolved by a test that reads it out
      of the document, because a guide whose only configuration example does not
      parse teaches the format wrong — which is what E-2 was.
      **Two wrong guesses on the way, both recorded in that test**, and both the
      same shape this project keeps finding: `parseRunConfig` does not resolve
      endpoint names and `expandPolicy` does not either — it expands pattern
      objects and passes a literal through untouched. A deliberate typo survived
      both. `assertReferencesResolve` is the step that catches it.

## Full audit of 14 August 2026

Twelve tracks run in parallel, 130 findings. Every claim below was produced by a
run or points at a line; the working copy with each command and its full output
lives outside the repository. Six findings are blockers, and four of those are
one class: **a run that tested nothing looks exactly like a clean one** — the
thing this whole tool exists to prevent.

Nothing here is fixed yet. The order of work is at the end.

### Blockers

- [x] **C-1. The signal name `digest` is not reserved.** Closed 14 August: the name
      is refused at parsing (`ReservedSignalNameError`), and the extractor writes
      digests after the declared scalars so the library path cannot lose one
      either. Both halves proven by mutation — removing either makes a new test
      red.
      Original finding: One line in a user's
      configuration — `{ name: digest, kind: present, path: orders, endpoints:
      [orders.list] }` — turns 18 cross-tenant findings into 0 and leaves
      `coverage.checksRun` claiming the check ran. With `kind: count` the mirror
      case: 16 fabricated `high` findings on a healthy platform. The implied
      digest goes into `specs` first (`runner.ts:537`), the extractor writes by
      order (`signals.ts:202`), a later spec overwrites it, and `digestOf` then
      drops the observation from the check entirely. `DuplicateSignalNameError`
      compares declared signals against each other only — the implied `digest`
      never enters `seenNames`. The text of that very error describes this
      failure.
- [x] **A-1. An exhausted budget never reaches the verdict.** Closed 14 August: the
      whole `cause` chain is examined instead of the outer name, the failure
      carries the terminal error's own words, and the canary tells a ceiling of
      our own from a platform that is down. Proven through the real client, not a
      fake — the fake is what hid it. Original finding: `--max-requests
      149` against a 144-cell matrix leaves three cells unprobed and reports
      `truncated: false`, exit 0. `http.ts:391` wraps everything in
      `RequestFailedError` with the cause attached; `runner.ts:572` matches
      terminality on the **outer** error's name and never unwraps `cause`.
      `CircuitOpenError` is thrown directly and so is recognised;
      `RunBudgetExhaustedError` never leaves the client. Recorded as closed in
      the ADR-0005 addendum of 12 August — it is not. The test that "covers" it
      feeds a fake client an error the real client cannot produce.
- [x] **L-2. A resource that does not exist yields "isolation verified."** Closed 14
      August through `coverage.resourcesNotFound` rather than a resource canary:
      the fact is derived from the walk that already happened, costs no traffic,
      and covers resources with no declared owner too. Half the class turned out
      to be caught already — where an owner is granted access, a missing object
      gives that account an unexpected denial. Original finding: A 404
      becomes `not-found`, `toBinary` folds that into `denied`, and the cell
      reports `MATCH: true`. The tool's central claim — "carol cannot read
      alice's order" — is proved by the order not existing. Credentials get a
      canary, the existence of a resource gets nothing, though identifiers are
      written by hand and go stale faster than tokens. The comment above
      `toBinary` names the gap and defers it to "separate checks" that do not
      exist.
- [x] **L-1. A token that expires mid-walk.** Closed 14 August: the canaries are
      probed again after the walk, and an account that passed before and fails now
      is named in `staleCredentials` and gives exit 2. A terminal failure on the
      second pass is not counted as stale — that is our own ceiling, not a dead
      token. Original finding: Canaries are probed once, before
      the walk. Every remaining cell then answers 401, matches a policy of
      denial, and lands in `cellsMatched`; exit 0. `findUnauthenticated` requires
      "refused everywhere" and stays silent by construction once the first half
      succeeded. At the default 5 rps a matrix of 10 accounts x 60 endpoints x 3
      resources takes about an hour — longer than a typical JWT.
- [x] **A-3. A secret from the environment reaches the report in the clear.** Closed
      14 August: the schema admits a literal only under `query`, so the form is
      unrepresentable rather than filtered by name. The denylist stays for what it
      is actually for — impersonation through a credential in the query string.
      Original finding: A
      context attribute declared under `query` as `{ env: NAME }` is substituted
      into the address, and addresses are printed verbatim: 24 occurrences of a
      live token across 9 accounts. The same secret declared as a **header**
      leaks nothing — headers travel as the declared form. `config.ts:475` claims
      the opposite in a comment. The only guard is `FORBIDDEN_QUERY_KEYS`, a
      **denylist of 13 names**; `sig`, `hmac`, `key`, `secret` pass freely. This
      is structurally the mistake the project already corrected once: the
      ADR-0005 addendum called the response-header denylist "structurally wrong:
      every name that will ever carry a secret cannot be enumerated" and replaced
      it with an allowlist.
- [x] **D-1. A resource value of `.` or `..` walks out of `exclude`.** Closed 14
      August: `isUsablePathSegment` in the core, refused at parsing and again while
      the address is assembled. The scope guard was never the defence here and
      could not be — nothing leaves the target, the request goes somewhere else
      inside it. Original finding:
      `encodeURIComponent` escapes the slash and not the dot, so a `.` segment
      survives and navigates. The guard in `joinUrl` compares
      `resolved.pathname.startsWith(base.pathname)`, and with a `baseUrl` that
      has no path `base.pathname` is `"/"` — the condition is always true, in the
      default case and in every example the project ships. Two consequences: the
      exclusion list is bypassed, and the verdict for one endpoint is computed
      from another endpoint's answer. An empty value passes too — `min(1)` in the
      params schema sits on the key, not on the value.

### A string from outside lands in a slot with its own grammar

Eleven point fixes of one shape across four files, two of which have already
drifted apart (`CONTEXT_VALUE_SAFE` uses `*` where `HEADER_SAFE` uses `+`).

- [x] **D-2.** Closed 15 August with the whole class, [ADR-0024](docs/adr/0024-strings-from-outside.md):
      `openRecord()` from `src/io/untrusted.ts`.
      Original finding: a signal named `__proto__` disappears from every
      observation: `signals.ts:173` builds a plain object literal, and the
      assignment calls the prototype setter.
- [x] **D-3.** Closed 15 August with the whole class: `lookup()` instead of
      indexing, at both sites that read a name from the configuration.
      Original finding: `tokenEnv: constructor` gives `TypeError: value.trim is
      not a function` instead of `MissingCredentialError`. The same class is
      already recognised and closed elsewhere in that file (`config.ts:914`).
- [x] **D-4.** Closed 15 August with the whole class. The test sets the header
      with `setHeader`, not in an object literal — where `__proto__:` is syntax
      rather than a key, so the first version of it sent nothing and passed.
      Original finding: a response header named `__proto__` vanishes, breaking
      the promise made ten lines above it that the name is kept even for redacted
      headers.
- [x] **D-6.** Closed 15 August: `HttpRequest.headers` and
      `CredentialProvider.headersFor` ask for the branded `HeaderValue`, whose
      only producer is `safeHeaders()`. Proven by `pnpm run typecheck`, which
      reads the test: removing the brand makes tsc report the
      `@ts-expect-error` as unused and the gate fails.
      Original finding: the class is closed on the CLI path only. A library
      consumer building a request themselves passes all four regular expressions
      by and gets `RequestFailedError` with "Cannot convert argument to a
      ByteString" after three attempts.
- [x] **A-4.** Closed 15 August: a request against a URL with userinfo and a
      query fails, and the message is checked to carry the path and neither the
      key nor the password. Making `safeUrl` return its argument turns it red.
      Original finding: the redaction of URLs inside error text (`safeUrl`) is
      covered by no test: making it return the URL unchanged leaves 574 tests
      green.
- [x] **The cure, done 15 August rather than a fifth point fix:**
      `src/io/untrusted.ts` with branded constructors — `HeaderValue`,
      `HeaderName`, `PathSegment`, `safeRecord()`, `lookup()` — and
      `HttpRequest.headers: Readonly<Record<HeaderName, HeaderValue>>` in
      `ports.ts`. After that a raw `Record<string, string>` cannot reach
      `createHttpClient` from anywhere, the two duplicated name regexes collapse
      into one, and the `*`/`+` divergence becomes impossible by construction.
      `substitute` calling `pathSegment` fixes D-1 in the line where it lives.
      The technique is already used twice here and stated as a principle:
      `SignalValue = number | boolean` and the `Account` union — "a duplicate the
      compiler cannot check drifts apart sooner or later."

### Two channels of results, never joined below the report type

The shared type already exists (`ReportFinding` with `source`). What diverges is
everything downstream of it.

- [x] **B-1.** Closed 15 August with L-4: nothing is dropped. The interim counter
      `coverage.checksWithUnusableFindings` is gone with the drop — a field that
      could only ever be empty is its own kind of lie.
      Original finding: a check finding naming neither an account nor an endpoint
      is dropped (`build.ts:614`), and the counter that the comment promises will
      keep it visible counts the already-filtered list. Latent today; a blocker
      for Module 2, where run-level findings are the point.
- [x] **B-2 / H-3.** Closed 15 August, [ADR-0022](docs/adr/0022-one-verdict-per-cell.md):
      a cell is `match: true` only when nothing was found on it by either
      channel, `findingKinds` names the reason on the row itself, and
      `coverage.cellsWithFindings` makes the documented identity checkable —
      `cellsMatched + cellsWithFindings === cellsObserved` — because
      `summary.findings` counts rows and one cell can carry several. The oracle
      asserts both numbers and the contradiction itself on all 28 combinations;
      reverting the fix turns it red naming the six offending cells. On the
      reference run `cellsMatched` went 80 → 74.
      Original finding: a cell is `match: true` and carries a body finding at the
      same time — 12 of 18 on the reference run. `cellsMatched 100 + findings 98
      = 198` against `cellsObserved 180`, which breaks the self-check
      `docs/report.md` teaches the reader to perform, and contradicts ADR-0020 in
      the same file.
- [x] **B-3.** Closed 15 August, addendum to
      [ADR-0014](docs/adr/0014-severity-and-exit-codes.md): a check finding fails
      the run at any severity but `info`, the same line the matrix channel has,
      where `not-observed` and `probe-error` do not fail either. Nothing
      registered today emits below `high`, so no run changes today — which is
      when a threshold is cheapest to fix.
      Original finding: different thresholds per channel: any matrix discrepancy
      exits 1, a check finding needs `high|critical`. ADR-0014 states the
      opposite principle.
- [x] **B-4.** Closed 15 August, two guards for two callers. Registering a check
      under one of the four matrix kinds is refused (`ReservedCheckIdError`), for
      the same reason the signal name `digest` is refused when a configuration is
      parsed. And `runVerdict` counts rows by `source` instead of reading
      `summary.byKind`, because it takes a `RunReport` from anywhere and a
      consumer assembling one by hand never passes the registry.
      The second half was invisible until the test helper was fixed: it set the
      counters from numbers and left `findings` empty — a report `buildReport`
      cannot produce — so the mutation "read the map again" stayed green. It now
      builds the rows and counts the map from them.
      Original finding: `summary.byKind` is one flat key space for diff kinds and
      check ids, and `runVerdict` reads escalations out of it. A check registered
      as `privilege-escalation` reports as one.
- [x] **B-5.** Closed 15 August: the list is filtered to endpoints a request
      actually went to. The flag is read from `options.endpoints` and `probed`
      only selects by id — the first version read `responseMustDifferByTenant`
      off the `probed` entries, and a test fixture whose copy did not carry it
      caught that immediately. Two copies of one endpoint is the same shape as
      everything else in this file.
      Original finding: `coverage.bodiesComparedOn` names endpoints that were
      never probed: it filters all endpoints where the check filters probed
      ones.
- [x] **B-6.** Closed 17 August, [ADR-0030](docs/adr/0030-a-defect-is-not-its-channel.md).
      The signature was `endpoint × kind × relation × conditions`, and `kind` is a
      kind of matrix discrepancy on one channel and a check identifier on the
      other — so the two could never merge. An endpoint with no authorization on
      it at all refuses nothing **and** returns one body to every tenant: two
      groups, two keys, two tickets to one team, the second closed as a duplicate.
      That is the one thing a lower bound may never do, and `defectGroups` is
      documented as a lower bound in two places.
      Measured before deciding, on the reference polygon rather than on a
      fixture: it happens in **3 of the 28 combinations**, taking 7 defects to 6
      and 13 to 11 — and both flavours occur, a check merging with a status
      discrepancy (`orders.list any-resource geo-blocked`) and two matrix kinds
      merging with each other (`orders.read same-tenant baseline`).
      `kind` leaves the signature; each group carries `kinds`, sorted, every way
      its cells were found broken. Deliberately **not** in the `key`: the key
      exists so a ticket still points at the defect next month, and a defect
      noticed a second way would otherwise be renamed by the run that learned more
      about it. `relation` and `conditions` stay — they say which cells, not how
      the tool noticed.
      Mutations: putting `kind` back in the signature, and not adding to `kinds`,
      each fail two named tests — and the second also fails the **oracle on the
      real polygon**, naming the group. "Merging is only right if nothing is lost
      by it" is asserted on all 28 combinations rather than argued in the ADR.
- [x] **B-7.** Closed 15 August: a cell that could not be addressed leaves a row
      with status 0 — which is what this report already means by "no answer" —
      and no `url` or `method`, because the address is exactly what could not be
      built and inventing one would say a request went somewhere. It then becomes
      a `probe-error` like any other and the threshold sees it. Covered by a test
      that spans the walk, the diff and the verdict, because that is where the
      defect lived: each piece was defensible on its own.
      Original finding: a failure before the address is built produces no
      observation, hence no `probe-error`, hence the untrustworthiness threshold
      cannot see it: four failed cells out of five exit 0.
- [x] **B-9.** Closed 16 August: severity first, then endpoint, account,
      resource and kind. The tie-breakers are what make it stable — severity alone
      leaves eighty rows free to shuffle between two runs of one matrix.
- [x] **B-16.** Closed 16 August with item 12 of the second ranking; the box here
      was left ticked open until 17 August, when it was checked against the code
      rather than against either mark. `bySeverityLine` walks the keys of
      `SEVERITY_ORDER` and prints all five — `critical, high, medium, low, info` —
      so the level introduced for registry checks reaches the screen. Both the
      row counts and the defect counts go through it.
- [x] The cure is not a shared type but a **single source for the per-cell
      verdict** and a single threshold rule in `runVerdict`. Both landed with
      B-2 / H-3 on 15 August ([ADR-0022](docs/adr/0022-one-verdict-per-cell.md));
      this line was the prescription and stayed unticked until 17 August, when it
      was checked against the code. `withVerdicts` computes `match` in one place
      and from both channels at once — `cell.match && kinds === undefined` —
      `src/core/diff.ts` produces the cells and the discrepancies in a single
      pass rather than two that could drift, and the threshold is the one named
      constant `UNTRUSTWORTHY_ERROR_SHARE`, read at exactly one site.

### Terminal errors lost at a layer boundary

- [x] **A-2.** Closed 15 August with L-9: `RunBudgetExhaustedError` and
      `CircuitOpenError` are rethrown out of the retry loop instead of being
      swallowed into `lastCause`. A decision to stop is not a network condition,
      and the breaker no longer counts one as a failed response — which is what
      made it fire from the fifth exhausted cell and report the wrong reason.
      Proven on the pauses the client asked for, not on wall time: the first
      version of that test measured elapsed milliseconds and **passed with the
      retries put back**, because the backoff carries jitter and a timing
      threshold is a coin toss dressed as a proof.
      Original finding: past an exhausted budget each cell still makes three
      attempts with two sleeps. `--max-requests 149` takes **32.1 s** against
      30.3 s for the full run while making three fewer requests. The throttle
      counter does not advance — `admit()` throws before `started += 1` — so the
      budget cannot recover and the retries are futile by construction. The
      silence boundary is exactly **4 cells**: from the fifth the circuit breaker
      fires and masks A-1.
- [x] **G-4.** An exhausted budget sends the reader to check the port. Closed with
      A-1: the canary now names `RunBudgetExhaustedError` and the message says to
      raise the ceiling rather than to check the deployment. Original finding:
      `RunBudgetExhaustedError` carries no `code`, `failureCode()` falls back to
      `"TRANSPORT"`, and the canary prints "The platform did not answer at all…
      Check the address, the port". The error's own text — "a guard against
      uncontrolled load, not a configuration error" — goes into `cause` and never
      reaches the reader.
- [x] **L-9.** Closed 15 August: the first terminal error sets a flag and no
      worker takes another cell. Measured on 610 cells with a budget of 149 —
      3 184 ms and a **512 KB report against 322 KB for the complete run** became
      1 181 ms and 193 KB. The 461 rows are still there and have changed kind:
      `not-observed`, "we never asked", instead of `probe-error`, "we asked and
      it broke" about a request that was never sent. Up to `concurrency - 1`
      requests are in flight when the flag is set and they finish, which is
      bounded by the limit the operator agreed to.
      Original finding: after a truncation the loop has no `break` and walks the
      rest of the matrix. At 18 040 cells with the default budget: 5 267 ms spent
      on 16 040 dead cells, 16 139 finding rows against 109, and a report of
      **16.3 MB against 12.8 MB for the complete run**. A truncated run costs more
      than a full one.

### The shape of data described twice

- [x] **B-10.** Closed 17 August, and the count was exact. Five places: the
      `HttpMethod` definition, the lower-case list in `openapi.ts`, the
      `z.enum([...])` in `config.ts`, and `Record<HttpMethod, true>` in both
      endpoint sources. Measured before touching anything — adding `TRACE` to the
      domain produced errors in exactly two files, the two adapters; the OpenAPI
      parser and the configuration schema said nothing, so a new method would
      have been skipped by the parser without a word and refused by the schema as
      invalid.
      One source now: `HTTP_METHODS: Readonly<Record<HttpMethod, HttpMethod>>` in
      the core, read by all four consumers. `Record` rather than
      `satisfies readonly HttpMethod[]`, because `satisfies` checks that entries
      belong to the set and never that the set is covered. The value repeats the
      key because `Object.keys` hands back plain strings and it is the values
      that carry the type onward — which also removed a cast in the parser. The
      generated JSON Schema is byte-identical.
      Mutations: `+TRACE` in the domain now gives one error, in `types.ts`,
      naming the missing key; restoring both old copies leaves `typecheck`
      silent and fails 5 of the 6 tests in the new
      `tests/http-method-set.test.ts` — the finding reproduced in full. That file
      reads the set from `HTTP_METHODS` rather than listing it, since a list
      would be a sixth copy, and its hand-written half is `TRACE`, a method the
      domain does not have: without it the tests would agree with any set.
- [x] **B-11.** Closed 17 August, and the finding understates it. `z.infer`
      occurred nowhere in `src`, `tests` or `docs`. Measured by breaking the
      schema: adding a field to `accounts`, **required or optional**, left
      `typecheck` silent, and so did removing an optional one; only the
      disappearance of a required field was caught. A value with extra fields is
      still assignable to a narrower type, so "the schema grew, the interface did
      not" was invisible in the one direction that matters.
      **Tied rather than derived, deliberately.** These are the package's
      published types — `src/index.ts` re-exports the module in full — and
      `z.infer` returns mutable shapes: `readonly allowedHosts: readonly string[]`
      would become `allowedHosts: string[]`, buying a rule with a guarantee a
      consumer already has. The prose over each field does not survive inference
      either, and hovering a name is where most of it is read. So `SameFields` /
      `Tied` relate five types to their schemas by field name and the error type
      **names the field that drifted and in which direction**.
      Left hand-written with the reason beside them: `TenantConfig` and
      `RequestContextConfig`, which are the result of a conversion rather than a
      mirror (`parent` → `parentId`, `endpoints` → `endpointIds`, the short form
      expanded), and `ContextAttributeValue`, a union where field names say
      nothing — already tied by the call into `normalizeContexts`, and that is
      tested.
      Mutations, each naming its field in the compiler error: a field added to
      `accounts`, `target`, `bodySignals`, `signals[]` and `contexts[]`; a field
      removed from `accounts`; a third member added to the attribute union.
      **Not proved:** the tie is over field *names*. Narrowing a field's type in
      a schema — `z.string()` to `z.literal("x")` — passes both halves, leaving
      the published type wider than reality. Reasoned, not measured.
- [x] **B-12.** Closed 17 August. Eight places in `src/report/build.ts` rebuild a
      structure by naming its fields; three of them exist **to keep something
      out** — a `RequestRecord` takes 4 of an observation's 12 fields, and adding
      one "for convenience" would put headers, statuses and signals into a
      reproduction line — and those stay. Five could lose a field by accident and
      are now held by `nothingLeftUnnamed`, which takes the rest of a
      destructuring and does not compile if anything is in it: a field added
      upstream must be either carried or withheld with a reason beside it. The
      report is not widened — no source object is spread into it anywhere.
      **The finding named the wrong place.** Contexts and accounts are indeed
      copied field by field, and neither had lost anything: all six context
      fields are carried, and the two missing from accounts are withheld on
      purpose. The place where the loss had **already happened** is one B-12 does
      not mention — `withVerdicts` named four fields of the cell verdict and not
      `basis`, the field the core computes on every cell precisely because "no
      `ruleIndex`" cannot be told from "the tool did not fill it in". Findings
      carried it through a spread; observations did not, so the grounds were on
      the rows that disagreed and missing from the rows that agreed.
      Closed on the way, one layer down: `AccessDiff` in the core never declared
      `basis` either, though `diffAccess` has written it since cell verdicts
      existed — a library consumer could not read `finding.basis` at all. Now
      declared, and asserted by an annotation rather than a `toEqual`, which
      compares values and never names a type. `docs/report.md` had two examples
      showing `ruleIndex` with the wording `basis` replaces; both corrected.
      Mutations: a field added to `ConfiguredAccountRow`, `RequestContextConfig`,
      `RunTarget`, `ResolvedFinding` or `CellVerdict` fails the compile at a named
      line; dropping `basis` fails two named tests; removing the declaration from
      `AccessDiff` fails the typecheck in `tests/core/diff.test.ts`.
      **One mutation did not fail at first** — removing `tenants` — because no
      fixture had an account with a tenant set, so the test would have stayed
      silent about losing it. An account was added and it fails now; recorded in
      the test.
- [x] **B-13.** Closed 17 August, and it had spread: three `.d.mts` files, not
      one — `tools/oracle/index.d.mts`, and the two added on 17 August for
      `is-main` and `managed-block`, each written by hand beside the module it
      described. TypeScript reads the declaration and never looks at the code, so
      nothing related them; tests typed against the description while CI ran the
      implementation, in the module that decides whether the strongest gate this
      project has passed at all.
      The cure is not a better description. `tools/**/*.mjs` joins
      `tsconfig.include` with `allowJs` and `checkJs`, the shapes move into the
      modules as JSDoc, and the three declarations are gone: one source, and
      drift has nowhere to happen. `tsconfig.build.json` is untouched and still
      compiles `src` alone, so nothing of this ships.
      Closed on the way, because the compiler asked: `cause.message` on an
      `unknown` catch binding, `loadGroundTruth` discarding the value
      `requireObject` returns and then reading fields off the raw parse.
      `tests/tools/typed-from-source.test.ts` guards the arrangement rather than
      the types — the compiler has those. Mutations: dropping a `.d.mts` back in
      fails "carries no hand-written declaration", and demonstrates the defect
      while it is there, since `moduleUrl: number` in a declaration makes tsc
      report errors in the **tests** and none in the code it contradicts; taking
      `tools/**/*.mjs` out of `include` fails "is inside what the typecheck
      reads".
- [x] **J-16.** Closed 16 August. A dated note in ADR-0001 says Biome is 2.5.7,
      raised on 12 August (`858acfd`) once `minimumReleaseAge` released it, with
      `biome.json` migrated by Biome's own command in the same commit. The 2.5.6
      in the Decision section stays: it records the version the decision was taken
      on, and a patch bump inside the pinned major is the maintenance this ADR
      describes, not a change to it. Original finding: ADR-0001 pins Biome 2.5.6;
      `package.json` has 2.5.7.

### A document describing an invariant weaker than the code

The dangerous class: a fix made *by the document* reopens a hole adversarial
review already closed.

- [x] **J-2.** Closed 15 August. Original finding: CLAUDE.md calls response-header redaction "a hardcoded list" — a
      denylist. The code says "An allowlist, precisely, and not a denylist". The
      header of `http.ts` repeats the wrong version twenty lines above its own code.
- [x] **J-3.** Closed 15 August. Original finding: CLAUDE.md describes the context-attribute ban as one layer.
      ADR-0019 says the first version "was **wrong**" and was rewritten into
      three; the code holds three.
- [x] **J-4.** Closed 15 August. Original finding: The header of `http.ts` says the response body is "never read";
      line 323 reads it. ADR-0011 changed the invariant from "not read" to "not
      stored" and the header stayed.
- [x] **J-11.** Closed 16 August by a dated addendum on each. ADR-0016: the
      report carries `accounts[].auth` per account, resolved by the **base**
      account so a row under conditions cannot print the root scheme, and since
      `83f5769` the schemes enter `configDigest` too. ADR-0017: `src/report/build.ts`
      writes `tenants` beside `tenant`. Both debt paragraphs are left standing —
      they record what was true when the decision was taken — with the addendum
      saying what changed. Original finding: two ADRs describe debts in the report
      that the code has since paid, with no dated note; a reader of ADR-0017
      concludes today that an account with a set of tenants is indistinguishable
      from an anonymous one.
- [x] **J-12.** Closed 16 August. A dated note on ADR-0021 records that `files` is
      four entries plus a negation — `dist`, `docs`, `examples`, `schema`,
      `!dist/**/*.map` — and that both additions came from that ADR's own addendum
      of 15 August rather than from later drift. The three-entry Decision section
      stays as decided. Original finding: ADR-0021, written specifically about
      what ships, lists three directories where `package.json` has four.
- [x] **J-13.** Closed 16 August: [ADR-0027](docs/adr/0027-per-tenant-base-url.md)
      is written, and ADR-0008 gained a dated note saying its revision condition
      fired and was answered in a different shape — a `baseUrl` on a tenant node
      rather than a list of targets. The ADR is four days late: the code shipped
      on 12 August (`6eb4c97`). It records the rule (the address comes from the
      **resource's** tenant), the three fallbacks, the canary going to its own
      brand, the scope staying one list, and the honest gap: the polygon is one
      host, so end-to-end this path is unproven and only unit-tested. Original
      finding: a per-tenant `baseUrl` — several hosts in one run — has no ADR,
      although ADR-0008 named exactly that as its condition for revisiting.

### Numbers woven into sentences have gone stale

The project has caught this class twice and cured it by generating a table from
the run. Generation does not reach a number inside a sentence.

- [x] **J-7.** Closed 16 August, and three of the five places had closed
      themselves first. The CI job is `name: oracle (reference polygon)` — the
      count was deliberately removed, with a comment saying a number woven into
      prose is one no test can keep honest — and `plan.md` was corrected in
      `ef471b1`, the commit that wrote this audit down, so it reads "twelve
      switchable defects and 28 combinations" in both places. Fixed here:
      `polygon/README.md` said "twenty-five" twice, in the run instructions and in
      the sentence introducing a generated table that says 28 three lines below;
      the second also mis-dated the run as 13 August when the table was written by
      the run of 14 August (`819b071`). **Still open and not fixable from a
      documentation file:** the `note` at the head of `polygon/ground-truth.json`
      says "There are 25 combinations, not 256", and that file holds the 28. It is
      data, not documentation, and needs a source edit. Original finding: "25
      combinations" survives in five places including the name of the CI job.
- [x] **J-8.** Already closed before this pass, in `047d34f` of 15 August: the
      block reads `"endpointsTotal": 7` and `"notProbed": { "unsafe-method": 1 }`, which
      is what a run with `orders.cancel` in the list and no `--unsafe-methods`
      gives. Original finding: the `coverage` example in `docs/report.md` promised
      `endpointsTotal: 6` and `notProbed: {}`.
- [x] **J-9.** Closed 16 August. The prose now says 24 pairs of 210 compared, 39
      skipped as related, 147 skipped for differing conditions — the same three
      numbers as the `byCheck` block above it — and a paragraph records what the
      old figures were and why they were not nonsense: 8 + 13 = 21 is every pair
      among the seven comparable rows this endpoint had before request conditions
      existed. Original finding: the JSON block said 24/39 and the prose thirty
      lines below said 8 of 21 and 13.
- [x] **J-5.** Closed 16 August. The endpoint table gained its seventh row,
      `orders.cancel` (`POST /v1/orders/{orderId}/cancel`), with its rules — the
      holding is denied here while allowed on `orders.read`, which is the point of
      the endpoint — and a note that the write is inert so the oracle does not
      become a function of the traversal order. The "Boundaries" claim is replaced
      by a "was: 405 on all of them" subsection in the form the two notes above it
      already use. Original finding: `polygon/README.md` stated the platform
      implements no unsafe methods (405), and the endpoint table listed 6 of 7.
- [x] **J-6.** Closed 16 August: the section describes the ADR-0012 shape the file
      actually has — `note`, `cellKey`, `target`, `defects` keyed by flag with
      `title`/`visibility`/`note`, and `variants[]` with `selector`,
      `expectedExitCode`, `unsafeMethods` and findings carrying `defects[]`. The
      six visibility values are listed, and so is why `defects` on a finding is an
      array. The vanished `tenancy`/`ancestry`/`depth` keys are accounted for
      rather than dropped: that prose moved into `defects[].note`. Original
      finding: the section described the format as it was before ADR-0012, and a
      fourth polygon written from it would not parse.
- [x] **J-10.** Closed 16 August — see the entry in the phase-4 list, now marked
      done. The fourth cold read of 14 August is exactly the missing read: an
      installation from npm with the repository never opened. Original finding:
      `tasks.md` still held open "the README has never been checked by a cold
      read" while containing two sections about such reads.
- [x] **J-14.** Closed 16 August. "What the report still does not have" no longer
      points at `tasks.md`: the coverage denominator shipped and is described in
      this same document. The half that survives is named as a boundary rather
      than a debt — how many endpoints the API has in total cannot be known from a
      run, and no field added later closes it. Original finding: `docs/report.md`
      sent the reader to `tasks.md` for an open item recorded there as closed.
- [x] **J-15.** Already closed before this pass, in `ef471b1` — the same commit
      that wrote this audit down. The link reads `[docs/adr/](docs/adr/)` and
      names no range; `src/report` reads "exists since phase 1;
      HTML/PDF rendering is phase 5"; `tests/integration` reads "Never created …
      dropped", with the reason. Original finding: `plan.md` said "ADR 0001-0010"
      against 21 files, listed `src/report` as phase 5 work, and named a
      `tests/integration` that does not exist.

Found in passing, same class, fixed with them:

- [x] `polygon/README.md` did the union arithmetic for the composite combinations
      as 10+7+4+2+6+6 = 35 and all-eight = 37, while the generated table in the
      same file says 41 and 43. The `list-no-filter` term had stayed at its 6 base
      pairs after request conditions doubled it to 12. Both the sum and the "Cells"
      column of the defect table now say 12, split as 6 base and 6 under
      `wide-scope`.

### `--dry-run` does not do what it promises

- [x] **G-1.** Closed 15 August: the three canary checks moved out of
      `probeCanaries` into `assertCanariesUsable`, which both the walk and the
      dry run call. The walk gained something too — they now run before the first
      request instead of inside the loop.
- [x] **G-2.** Closed 15 August: a red line when no account with credentials
      declares one, saying what will happen — the whole matrix walked, then
      exit 2.
- [x] **G-3.** Closed 15 August: the preview compares the matrix against the
      budget in force and says how much of it fits. The throttle is built before
      the dry run returns and its `limits` are passed in, so the preview reads
      the same numbers the run will — not a second copy of the defaults.
- [x] **G-7.** Closed 15 August: the dry run names the path and says it is left
      as it was. The gate also asserts no file appears.
- [x] **G-8 / K-3.** Closed 14 August: the path is checked before the first
      request and before `--dry-run` returns, and a write that still fails prints
      the report to stdout rather than losing a run already paid for in traffic.
      Proved in `verify.mjs` against a platform that is not up, so a check running
      after the walk would fail on the connection instead. Original finding: an
      unusable `--report` path is checked neither at startup nor
      in the dry run. `writeFile` sits 86 lines below `collectObservations`: the
      run spends 152 requests on someone else's deployment and then dies on
      ENOENT with nothing to show.
- [x] **I-4.** Closed together with I-3 — see above. Original finding: the dry run is quadratic — 20 992 000 calls to `resourceApplies` at
      1600 endpoints — and takes 5.48 s where the real run reaches its first
      request in 0.606 s. The preview costs nine times more than starting the
      thing it previews.

### The artifact is guarded by nothing

- [x] **F-2.** A release publishes having run **one CI gate out of four**. Closed 14
      August: `ci.yml` gained `workflow_call`, and `release.yml` calls it as a
      job the publish depends on, rather than repeating a part of it. A test
      asserts the call is there and that no verification step crept back into the
      release. Original finding:
      `release.yml` runs `pnpm run check` and nothing else: no gitleaks over the
      history, no oracle verification, no vulnerability scan. Its own comment
      promises "The same gate as CI".
- [x] **E-7.** Packaging is checked by nothing in CI — closed 14 August by the
      `package` job: pack, publint, attw and an install from the tarball into an
      empty directory, driven from there. `attw` runs under `--profile esm-only`
      because its two default complaints are inapplicable to this package, and a
      job that is always red is a job somebody deletes. Original finding: — no `publint`, no `attw`, no
      pack, no install from the tarball. Every packaging finding below would have
      passed a release unnoticed.
- [x] **C-3.** The **content** of the report is guarded by nothing — closed 14 August
      on both sides. The oracle now checks the report against itself, which catches
      a group that lost `relation` and a finding that lost `contextId`; the
      evidence is pinned by a unit test, because the oracle cannot see it by
      construction. Original finding: Three
      mutations that gut `evidence` pass the unit suite **and the oracle**: the
      digest leaks into evidence in place of the declared scalars, a finding loses
      `contextId`, a defect group loses `relation`. `cellKey()` compares
      coordinates and never looks at `relation`, `contextId` or evidence.
- [x] **B-15.** The oracle reads four summary counters — closed 14 August together
      with C-3: `checkReportConsistency` in `tools/oracle/index.mjs` compares the
      counters against the body and the defect signatures against the findings',
      for all three polygons. The identity over cells was added on 15 August with
      B-2; the note that stood here — "documented and does not hold" — is gone
      with the defect.
      Original finding: and the exit code;
      `bySeverity`, `defectGroups` and `coverage.cellsMatched` are not checked. It
      compares **sets**, so duplicated rows are invisible by construction.
- [x] **E-3.** Closed 15 August: all nine are absolute GitHub addresses now, and
      the guard gained the assertion that was missing — a link in a document that
      ships must point at something that also ships. Reverting one link turns it
      red.
      Original finding: the published package carries **9 broken relative links**
      (`polygon/`, `tasks.md`, `plan.md`, `tests/…`, `.github/…`). The guard test
      resolves them against the repository root and stays green.
- [x] **K-5.** Closed 15 August: the guard reads `git ls-files`, like its
      neighbour always did. Measured today rather than carried over — 41 of the
      93 markdown files it visited were not the repository; the audit's 135 of
      182 was the same defect with more worktrees lying around, which is itself
      the point: the number depended on what was checked out.
- [x] **F-6.** Closed 16 August: `pnpm audit --audit-level moderate` runs in the
      vulnerabilities job beside the OSV scan. They read different databases, so
      two layers is now two. **The finding's last sentence had expired**: "It
      exits 1 today" — it exits 0, and has since the nanoid override landed.

### Tests that do not prove what is claimed

Track A: 40 mutations of the invariants, 34 killed. Track C over the core: 148
mutations, 80.4 % killed; after an honest re-triage (equivalent mutants, and
mutants the type checker rejects) **7 real gaps**, not 29.

- [x] **C-2.** Six defaults of twelve are caught by nothing — closed 14 August by
      `tests/adapters/defaults.test.ts`; each of the six mutations that survived
      the audit now turns it red. The digest width is pinned by behaviour rather
      than by exporting the constant: 500 distinct bodies bound it from both
      sides. Original finding: retry `maxAttempts`
      and `baseDelayMs`, the **breaker threshold 5 -> 5000** (the 5xx/429 guard
      effectively off), the request timeout, `maxBodyBytes`, and `DIGEST_BYTES
      6 -> 1` — an eight-bit digest, roughly one collision in 256 per pair. The
      throttle limits are caught because they have an exact `toEqual`; the others
      have nothing.
- [x] **C-4.** Closed 15 August: three tests next to the check — nothing is found
      between a baseline account and one under conditions, the pair is counted as
      skipped **for conditions** rather than for kinship, and the control shows
      the same two digests do produce the finding when the conditions match.
      Disabling the guard turns two of them red in milliseconds instead of
      showing up as "15 extra findings" at the end of a ninety-second run.
- [x] **C-5.** Closed 15 August. Measured before fixing: only the `endpointIds`
      branch was unprotected — the same mutation in the branch below it already
      failed five tests. A resource on the list whose parameters do not cover the
      path would have been probed with an empty segment in the address.
- [x] **C-6.** Closed 15 August: `expect(seen).toHaveLength(3)` before the loop.
      Three, not the two the two `toContain` lines above imply — the run also
      probes the canary, which is exactly the sort of thing an unasserted length
      hides. A client that recorded nothing now fails four tests in that file.
- [x] **C-7.** Closed 15 August: both messages are asserted with and without the
      optional part. The message is the whole of what a human gets from either
      error, and an inverted branch sends the reader to the wrong cell or looking
      for a rule they did not write.
- [x] **A-5.** Closed 15 August: a stream whose `cancel` sets a flag, asserted
      cancelled and unlocked. This is the default path — no `bodySignals`, no
      reading — and an uncancelled body holds the connection until the socket
      times out.
- [x] **A-6.** Already closed by the time it was re-measured on 15 August:
      `Object.hasOwn` to `in` fails "does not pick up a resource by a name from
      the prototype chain" in `tests/runner.test.ts`. Recorded rather than
      re-fixed — the audit's claim was true when written.
- [x] **The third `$ref` barrier.** Closed 17 August, addendum to
      [ADR-0005](docs/adr/0005-tool-safety-invariants.md). The invariant holds and
      always did; the account of **why** was wrong. `src/adapters/openapi.ts`
      called `resolve.external = false` "the defence against SSRF proper",
      verified by removing barrier 2 and seeing no request go out — true, and it
      proves nothing, because **no request goes out with the option on either**.
      Measured over six configurations (the document as an object, as a file path,
      and as an object with a base path, each with the option both ways):
      swagger-parser 12.1.0 never fetches an http `$ref` at all. Off, the
      reference is silently left in place — precisely the degradation barrier 2
      exists to catch; on, the call throws "Unable to resolve $ref pointer".
      So what holds today is barrier 1: the adapter is handed text and never a
      location, and nothing has a base to resolve from. The option stays, for the
      version of the library where it will matter.
      Two tests, saying different things. One pins the invariant under the call
      the adapter makes. The other is a **tripwire** asserting something the
      project does not want — that the option is not currently what stops the
      request — and it fails the day swagger-parser gains a working http
      resolver, which is the only way that header stops being a guess. A third
      asserts the option is still passed, on the source, because with barrier 2
      in front of it nothing else would notice its deletion — and the header now
      says out loud that it is not load-bearing, which is an invitation to remove
      it. Mutations: deleting the option and inverting it each fail that test.
      **A hand verification that cannot separate two mechanisms has verified
      neither.** The earlier check was a real experiment with the wrong
      conclusion attached to it.
- [x] **B-14.** Closed 17 August. The first half went on 15 August with B-3 and
      B-4: the helper builds finding rows and counts `byKind` from them, so it no
      longer assembles objects `buildReport` cannot produce — which is what hid
      the second half of B-4. The second half is `tests/report/verdict-seam.test.ts`,
      which reaches every branch of `runVerdict` through the three steps the CLI
      takes and nothing else — `buildAccessMatrix`, `diffAccess`, `buildReport` —
      with the discrepancies produced by the core rather than supplied as
      literals. The hand-built file stays, and now says why: it asks "given this
      report, what is the verdict", which is cheap and is half the question; it
      cannot tell whether a run produces that report at all.
      **The demonstration**, which is the point of the whole item: make
      `buildReport` drop `truncated` — a run cut short reported as complete,
      turning exit 2 into exit 0 on a matrix whose tail was never walked — and
      all 68 assertions in `exit-code.test.ts` pass while two in the new file
      fail. Same for `staleCredentials` not reaching the report and for
      `canariesChecked` overwritten with 1: one seam test each, 79 hand-built
      ones green. The branch **order** is asserted too — `truncated` outranks a
      finding, because a leak in the part that was walked says nothing about the
      part that was not — and `if (report.truncated && summary.findings === 0)`
      fails exactly the test written for it. Moving the findings branch above
      `truncated` outright does not compile, so the language holds part of the
      order by itself.
      Original finding: the exit-code tests assemble a `RunReport` by hand,
      bypassing `buildReport`, and assemble objects `buildReport` cannot produce.
      The seam `buildReport -> runVerdict` is uncovered — which is where B-3 and
      B-4 live.
- [x] **K-6.** Closed 17 August: a link target is checked against the set of
      paths `git ls-files` records, plus every directory on the way to one, and
      not against the file system. Git records one spelling, so the answer is the
      same on every operating system. The rewrite of 15 August (K-5) changed
      where the **list of documents** comes from and nothing about how targets
      are checked, which is why this outlived it. The claim "answers from the
      index, not from the disk" is put to a set made up for the occasion — one
      file on disk and in it, one on disk and out of it — because that is the one
      form of it that means the same thing on macOS and on Linux CI.

### The report is not self-sufficient for a ticket

Six of six criteria pass as of 15 August. The arithmetic is exact — 22
quantities recomputed independently, zero divergence — and seven of seven `curl`
commands assembled from the report reproduced on the first attempt. The sixth,
readability, failed on B-2 / H-3 above and was closed with it.

- [x] **H-1.** Closed 14 August: `basis` says `"rule"` or `"fallback"` in a field of
      its own, filled where the verdict is resolved rather than derived a second
      time downstream. On the reference run all 37 indexless findings now carry a
      reason, and none of the 34 critical ones is without one. Original finding:
      **37 of 80** matrix findings carry no `ruleIndex`, and **22 of 34
      critical**. The basis for "access was not expected" is expressed by the
      absence of a field, and "the fallback applied" cannot be told from "the tool
      forgot to fill it in".
- [x] **H-2.** Closed 14 August: `tool.documentation` points at `docs/report.md`
      for the version that wrote the file — a tag for a release, `main` for a
      development build, because a link into nothing is worse than a link into the
      newest text. Original finding: the JSON contains no reference to its own
      documentation or schema.
      Everything the reader is missing is described in `docs/report.md`, and the
      artifact does not say where to find it. The cheapest fix on this list.
- [x] **H-4.** Closed 16 August: `warnings` travels with the report. Only what
      is derivable from the report itself, and from the same constants the
      console prints, so the file and the terminal cannot say different things.
      The `--report` path warning stays where it is — it happens before there is
      a report to put it in.
- [x] **H-5.** Closed 16 August, and half of it was already done: `accountRows`
      has existed since a cold read found the same thing. What was missing is the
      note on `summary.accounts` itself — the field a distrustful reader lands on
      — and a line in `docs/report.md` saying 9 against 27 is the conditions
      rather than a bug.
- [x] **H-6.** Closed 16 August. The lookup was never wrong — it already read the
      **other** account's observation. On a list endpoint both sides ask the same
      address and differ only by the credentials, which are not in the report and
      will not be, so the two records were genuinely identical. `RequestRecord`
      now carries `as`, the account id, which is what turns a `curl` into the
      right `curl`. The "does not name the other side" half closed earlier with
      `Finding.relatedAccountId` (L-4).
- [x] **H-7.** Closed 16 August: a finding carries the response headers,
      redacted as everywhere else. The e2e test asserts them apart from the
      finding's shape, because they carry a `date`; what it pins is that they are
      there and that `set-cookie` is `[REDACTED]`.
- [x] **H-8.** Closed 16 August: the report writes `header` on every scheme —
      `authorization` for bearer and basic, `cookie` for cookie, the declared name
      for header. The configuration keeps its shape, where `kind: bearer` and
      nothing else is the right thing to write.
- [x] **H-9.** Closed 16 August: `verdict` is in the report, both the code and
      the reason. `runVerdict` takes `VerdictInputs` — the report without its
      conclusion — which is also the honest signature: it reads inputs and does
      not read the field it produces.
- [x] **H-10.** Closed 16 August: `defects[].key` is the signature the grouping
      already uses — endpoint, kind, relation, conditions — in a form a person can
      paste into a ticket. Readable rather than hashed, for the same reason a
      finding carries a `request` and not an identifier.
- [x] **H-11.** Closed 15 August, and **the finding's premise was wrong while its
      conclusion was right**. Key order was measured first and does not affect the
      digest: `parseRunConfig` builds its result in a fixed order, so reordering
      the YAML already gave the same value. What does not enter the digest at all
      is `accountAuth` — a `Map`, and `JSON.stringify` renders a `Map` as `{}`.
      Two runs presenting entirely different credentials, one as an `x-api-key`
      header and one as a `sid` cookie, had the same fingerprint. Changing how the
      accounts authenticate is exactly "we changed the declaration", which is the
      one question this field exists to answer.
      Now over a canonical serialisation: `Map` and `Set` are serialised by
      content, keys are sorted as insurance rather than as the fix, and arrays
      keep their order because a policy is ordered — the last rule that matched
      wins, so the same rules in a different order are a different declaration.
      Three tests; reverting to `JSON.stringify` reddens one, sorting the arrays
      reddens another. The first version of that second test compared two policies
      that differed in content as well as in order and passed either way.

### Scale: a sequential walk and quadratic post-processing

| Cells | Cold start | Walk | Post | Peak RSS | Report |
|---|---|---|---|---|---|
| 605 | 253 ms | 243 ms | 83 ms | 129 MB | 0.36 MB |
| 9 020 | 284 ms | 2 127 ms | 549 ms | 229 MB | 6.4 MB |
| 36 080 | 391 ms | 7 469 ms | 6 053 ms | 409 MB | 26.1 MB |
| 144 320 | 875 ms | 28 570 ms | **104 112 ms** | 1 003 MB | 102.4 MB |

- [x] **I-1.** Closed 15 August, [ADR-0023](docs/adr/0023-the-walk-is-parallel.md):
      the walk pulls from a flat list of cells with a pool of workers sized by
      `throttle.limits.concurrency`. 610 cells at 20 ms latency with the rate
      ceiling lifted: 14 127 ms at 1, 3 776 at 4, 1 137 at 16, 543 at 64, all 610
      observed in an identical order every time. At the defaults nothing changes
      — 60 cells at `--rps 5` take 11 407 ms at 1 and 11 308 at 8, the rate binds
      first. The in-flight peak equals the limit and never exceeds it; reverting
      the pool to sequential turns one test red, removing the cap turns three.
      Original finding: `--concurrency` does nothing: `await client.send(request)`
      sits inside the nested loop, one request in flight always. 615 requests at
      20 ms latency take 13 766 ms at `--concurrency 1` and 13 754 ms at 128. The
      flag is documented **and written into the report**, so the report asserts
      something about the run that did not happen.
- [x] **I-8.** Closed 15 August, [ADR-0026](docs/adr/0026-the-rate-is-a-shape-not-only-a-count.md):
      admissions are spaced `1000 / rps` apart, the window stays the authority.
      Measured at `--rps 5`, worst wall-clock second at the target: 6 / 7 / 9 at
      concurrency 1 / 2 / 8 became 6 / 6 / 6; at `--rps 50` with concurrency 16,
      66 became 49. **"Costs no throughput" was wrong** — the estimate in this
      entry, corrected by running it: 60 cells at `--rps 5` went 11.4 s → 12.1 s,
      and at `--rps 50` with concurrency 8, 1.31 s → 1.50 s. A short run pays for
      the shape.
      **And spacing at every rate was wrong too:** below a 2 ms gap a millisecond
      clock cannot express it, and `--rps 5000` and `--rps 100000` both delivered
      ~850/s — the flag lying about what it does, which is I-1 in a new place.
      Above 500/s the window is the only bound, and that edge is in the README.
      Original finding: what the target sees in a wall-clock second exceeds
      `--rps`, and the parallel walk widened it. The throttle's own admissions
      are exact, so the excess is arrival compression between admission and the
      socket. Found while closing I-1.
- [x] **I-3 and I-4.** Closed 14 August by hoisting rather than by caching: which
      resources apply to an endpoint does not depend on the account, so it is
      computed once per endpoint in `walk` and in `describePlan`. A memo inside
      `resourceApplies` would have fixed the same number and put mutable state in
      the core, which has none by design. Measured: `describeCells` 692.5 -> 326.3
      ms on an identical 664 200 cells, and `--dry-run` on 1600 endpoints x 41
      accounts x 320 resources 7.06 s -> 0.47 s for the same answer of 20 992 000
      cells. Original finding: `resourceApplies` parses the endpoint path with a regex on every
      call, and is called accounts x endpoints x resources times — the main
      quadratic source. Control: trimming the policy from 440 rules to 2 takes
      `describeCells` from 622 ms to 344 ms, and the remainder is exactly the
      measured 333.6 ms of regex work.
- [x] **I-2.** Closed 16 August, addendum to
      [ADR-0020](docs/adr/0020-verdict-next-to-observation.md): `describeMatrix`
      returns both answers from one walk and is what the run calls;
      `describeCells` and `diffAccess` stay for a consumer who wants one of them.
      Measured on 41 accounts x 200 endpoints x 20 resources (47 150 cells): the
      pair 100.7 ms, the single call 49.8 ms, the same 47 150 verdicts and 21 639
      discrepancies digest for digest. On the build before I-7 the same pair cost
      2 204.4 ms against a single walk of 1 095.6. Two guards in `tests/one-walk.test.ts`,
      because the halves do not imply each other — that asking for both answers
      walks once (counted on the input; the walk is not exported), and that
      `src/cli.ts` asks for them at once. Reverting either turns two named tests
      red. Nothing came out wrong while it stood, and that is the point: a pure
      walk agrees with itself, so only the bill showed.
      Original finding: the walk happens twice: `describeCells` and `diffAccess`
      are called on consecutive lines with identical arguments and each performs
      its own `walk`. The comment above `describeCells` — "One walk for both
      answers… Two independent passes would drift" — describes an intent the call
      site cancels.
- [x] **I-7.** Closed 16 August, [ADR-0028](docs/adr/0028-the-policy-is-indexed-once.md):
      the policy is arranged once per run — by conditions, then by endpoint — and
      the arrangement is passed in, the caller holding it exactly as I-3 has the
      caller hold the applicable resources. On the same 47 150 cells with a
      440-rule policy: `describeCells` 1 095.6 -> 51.6 ms, `findUnauthenticated`
      1 118.3 -> 46.0 ms, verdicts unchanged digest for digest. With the policy
      trimmed to 2 rules the walk takes 32.8 ms before and 34.4 after, so the
      policy's share of it went from about 1 063 ms to about 17 ms.
      **"Never breaks" was the wrong diagnosis** — the missing `break` is not the
      defect and must not be added: the last rule that matches wins, so a forward
      loop cannot stop, and the backward scan that could stop reaches the broad
      opening rule of a policy last, which is the shape policies are written in.
      The cost was scanning the policy at all. Mutations, each caught by a named
      test: preferring an endpoint-specific rule over a later broad one (1),
      keeping the first match instead of the last (3), ignoring a rule's scope
      (11), not consulting the rules that name any endpoint (18), answering
      unknown conditions from the baseline rules (1), not grouping by conditions
      (4). The price paid: the one-shot `resolveExpectedVerdict` now builds an
      index and drops it — 0.21 -> 1.83 us on a 5-rule policy, 17.7 -> 98.4 us on
      a 440-rule one — and the alternative was a second way to resolve a cell,
      which ADR-0020 forbids.
      Original finding: `resolveExpectedVerdict` scans every policy rule per cell
      and never breaks. Control: 440 rules to 2 takes `findUnauthenticated` from
      275 ms to 21 ms.
- [x] **I-5 + I-6.** Closed 17 August, [ADR-0029](docs/adr/0029-evidence-rows-have-a-budget.md).
      Measured first, and the measurement found something the finding did not:
      the failure is **reachable inside the default request budget**. One
      endpoint, every account in its own tenant, every response identical —
      100 accounts give 4 950 rows and 1.65 MB, 200 give 19 900 and 6.64 MB, and
      2 000 accounts are 2 000 requests, exactly `--max-requests`, and 1 999 000
      rows, at which point `JSON.stringify` throws `RangeError: Invalid string
      length`. The walk finishes, the checks finish, the defect is correctly
      identified, and the run is then lost at its last step to an error naming a
      string length. The one guard that bounds a run is linear in accounts and
      the check is quadratic in them.
      Two things made the cure cheap, and both were measured rather than assumed:
      the report **already** collapses all 4 950 rows into one defect group, and
      every number a verdict rests on is computed before a row is written. So the
      report now carries at most 50 rows per defect with `findingsOmitted` saying
      how many it left out, and `findings.length + findingsOmitted ===
      summary.findings`. Per defect and not over the flat list — otherwise the
      endpoint leaking to two thousand accounts spends the whole budget and the
      rarer defect arrives with no evidence to cite. The constant is decided by
      the many-defects case: 200 endpoints leaking to 50 accounts is 245 000 rows
      across 200 defects, 4.5 MB at fifty and 13.9 MB at two hundred. A warning
      and not exit 2: unlike `truncated`, everything here was probed and counted,
      and the verdict is the one an unabridged file would carry — asserted.
      2 000 accounts now give a 0.55 MB report, exit 1, `summary.findings`
      1 999 000. Mutations, each caught: a flat cap instead of a per-defect one,
      counting the summary after the cap rather than before, dropping the warning.
      **Left open on purpose:** one finding per collision class instead of per
      pair, which is the information-theoretically right shape. It moves every
      expected count in the hand-written `polygon/ground-truth.json`, and
      rewriting the oracle to agree with a code change is what CLAUDE.md forbids.
      The cap does not preclude it and nothing is on fire without it.
- [~] **The practical ceiling is about 20 000 cells** — 400 endpoints x 40
      accounts at 80 resources. What bound first was walk time, because the walk
      was sequential: 15 minutes at 50 ms RTT, and nothing shortened it. Since
      I-1 the walk is parallel and that number now moves with `--concurrency`;
      the rest of this entry stands and has not been re-measured. Then report
      size (0.72 KB per cell), then quadratic post-processing, which overtakes the
      walk between 36 000 and 72 000 cells. **Memory does not bind at all** in the
      range measured — a useful negative result. Note that the default
      `--max-requests 2000` makes the ceiling 2 000 cells unless it is raised.
      **Corrected 17 August:** "quadratic post-processing overtakes the walk
      between 36 000 and 72 000 cells" measures the wrong quantity. The
      quadratic term is in **accounts**, not cells, and it lands in the report
      rather than in the clock: 2 000 accounts on one endpoint is 2 000 cells —
      a tenth of this ceiling and exactly the default budget — and it used to end
      in `RangeError` while writing the file. Cells were never the binding
      dimension for it. See I-5 + I-6 and ADR-0029.

### The public surface

- [x] **E-1 / B-8.** Closed 17 August: `src/adapters/signals.js` joins the
      re-exports. The finding holds exactly as written — every other adapter was
      there, `createHttpClient` takes a public `signalExtractor?: SignalExtractor`
      whose type a consumer could not write down, and the body-signal half of the
      tool was unreachable from the library while the check consuming its output
      was exported in full.
      The cure is not the line, it is `tests/public-surface.test.ts`: the list of
      adapters is read off the directory rather than repeated, because a comment
      cannot notice the next module and a second list would be the same fact
      written twice — which is how this one went stale. The name is asserted
      through a real import, and the **type** through an annotation that does not
      compile without the export, since the type is the half that made
      `signalExtractor?:` unusable. Mutation: removing the re-export fails two
      named tests and gives three compiler errors.
- [x] **E-2.** Closed 15 August. The example calls `expandPolicy` and says in two
      lines why the endpoint list is declared separately. It is no longer a copy
      of anything: `tests/docs/readme-example.test.ts` carries the same text
      between markers, runs it, asserts the printed result, and compares the
      region with the README block character for character — exactly one
      substitution allowed, the module specifier, because a reader installs the
      package and the test sits inside it. `pnpm run typecheck` is the compile
      half. Editing either side alone turns one of the two tests red; restoring
      `diffAccess(matrix, policy)` fails the gate at `tsc`.
      Biome formats the marked region, so the block grew from 34 lines to 53.
      Accepted rather than suppressed: a reader copying it gets code that passes
      this project's own linter, and the alternatives were a tooling comment in
      the front-door document or an unguarded copy.
      Original finding: the only library example in the README does not compile:
      `diffAccess` takes a `ResolvedAccessPolicy`, the example passes an
      `ExpectedAccessPolicy`, and `expandPolicy` is never called. It runs, which
      is why it reads as correct.
- [x] **E-6.** Closed 17 August, and the numbers had grown: **266 exported names
      and 78 error classes** against the audit's 217 and 66 — a quarter more in
      three days, this session's own work included.
      **`configSchema` is no longer exported**, and the cost of exporting it was
      measured rather than argued: its declaration was 100 lines of
      `z.ZodObject<…>` in `config.d.ts`, 18% of the file, and it named
      `z.core.$strip` — zod's **internal** namespace. A zod major would have
      changed the package's own published types and broken every consumer's
      build, for a value none of them needs: `parseRunConfig` validates and
      returns a `RunConfig`, `configJsonSchema()` hands out the JSON Schema.
      After the change `import { z } from "zod"` is gone from every shipped
      declaration, and **no `.d.ts` in the build names a package at all** — a CI
      step on the packed artifact asserts it, checked in both directions locally.
      A unit test asserts the property rather than the name — no exported value
      may be a zod schema — so the next one is caught too.
      **The other half was that nothing said what the contract is.** 266 names,
      five of them anywhere in the documentation and all five in one README
      example. `docs/library.md` names the four entry points, says which group
      each remaining name belongs to, and says plainly that the third group —
      some forty helpers the CLI shares with itself — is not a contract. The 75
      error classes are public on purpose: `instanceof` needs the class, and that
      is the only way to tell a configuration mistake from a network failure.
      Not curated down to a short list, deliberately: removing names a consumer
      may already use is a decision for the owner, and the defect was the silence,
      not the size. A test keeps the document honest in both directions — a name
      it invents fails, and a name renamed in the code while the document lags
      fails too.
- [x] **E-4.** Closed 15 August: both are declared, and the package job resolves
      them **by name** from a real install rather than reading them off the disk —
      what is under test is `exports`, and a file that exists is not the same as
      a file a tool can ask for. Removing `./schema/*` gives
      `ERR_PACKAGE_PATH_NOT_EXPORTED`, verified.
- [x] **E-5.** Closed 15 August: `files` gains `!dist/**/*.map`. The build keeps
      emitting them for local debugging and the tarball went 308 KB to 264 KB.
      Measured today: 52 maps, 212 KB of a 658 KB `dist`, none with
      `sourcesContent`. The alternatives — `inlineSources` or shipping `src` —
      roughly double the tarball to make debugging work for a library whose
      compiled output reads very much like its source. See the addendum to
      ADR-0021.
- [x] **L-8.** Closed 17 August by wiring both up, not by deleting them — the
      state `standards` was in until 15 August, answered the same way, and
      ADR-0003 names both fields in the interface it records. `Finding.severity`
      became optional and `ResolvedFinding` has it required; `runChecks` in the
      core is the one place a finding's severity is settled, and the report is
      built from `ResolvedFinding[]`, so a `?? "medium"` further downstream does
      not compile. The literal `severity: "high"` inside the tenant-isolation
      check is gone — one declaration. `describeChecks` builds `checksRun` from
      `id`, `description` and `standards`; `CheckRun` moved from
      `src/report/build.ts` to the core, because every field of it is the check's
      own, and the two-field mapping written out in `src/cli.ts` is where
      `description` had been left behind. Severity is deliberately **not** in
      `CheckRun`: that would move the duplication into the artifact. The oracle
      now treats a `checksRun` entry with no description as a problem, as it
      already did one with no clause.

### Module 2 is not architecturally ready

- [x] **L-4.** Closed 15 August in full, [ADR-0025](docs/adr/0025-checks-are-plugins-in-fact.md).
      All five gaps and the registry: clauses reach the report in both directions
      (`checksRun` holds `{ id, standards }`, every check finding carries its
      own); a finding with no cell is carried like any other and deliberately not
      grouped as a defect; `Check.coverage` replaces a function exported from one
      check and imported by the report layer; `Finding.relatedAccountId` is a
      field; `CheckContext.scope` carries what the run touched; and
      `CheckRegistry.select` plus `--checks` make ADR-0003's per-run registry
      reachable, validated before the first request. `REPORT_SCHEMA_VERSION` is
      `2`.
      **Found while doing it, and worth keeping:** reverting
      `tenant-isolation.ts` by accident removed `relatedAccountId` from the real
      check and all 28 oracle combinations stayed green while every leak in the
      report lost the account it leaked to. The oracle now fails on that.
      **Still not done, by design:** no registered check produces a run-level
      finding and none reads `scope`. The shapes exist and are tested; their
      first user is the evidence pack.
      Original finding: `plan.md` says the evidence pack is added by registering
      checks without touching the core. Five gaps: `standards` is declared,
      filled and **read by no line of code**; run-level findings vanish (B-1);
      the report layer imports a specific check; `evidence.otherAccountId` is an
      undocumented cross-layer contract; and `CheckContext` carries only the
      matrix, so the whole class "was enough tested for this clause" is
      inexpressible rather than unwritten. The registry is also assembled
      hard-coded, with no way to select checks.

- [x] **L-12.** Decided 15 August: the digest value is not carried in a finding.
      It was in `evidence` while a note eighteen lines below in the same object
      said it was not, and it was an exact duplicate of `signals.digest` on the
      observation for that very cell — verified on the reference run, same
      number. The salt is random, so in a ticket it compares with nothing, and
      `evidence` is documented as statuses, flags and identifiers. Reverting the
      line turns a named test red. Raised by the audit of 14 August and left
      open twice rather than decided in passing.

### Hygiene of files, process and repository

- [x] **K-1.** Closed 15 August: all three polygons remove the directory unless
      `--keep-reports` is given, and the path is printed only when it survives.
      Original finding: `verify.mjs` on all three polygons creates a temporary directory
      and never removes it: **209 directories, 2 440 report files, 214 MB** on this
      machine — the very files `.gitignore` describes as possibly carrying a
      customer's personal data.
- [x] **K-2.** Closed 14 August: `{ encoding: "utf8", mode: 0o600 }`. Original
      finding: the report is written 0644, world-readable: `writeFile(path, json,
      "utf8")` with no `{ mode }`. It holds full request URLs, all response
      headers, and account, resource and tenant identifiers.
- [x] **L-10.** Closed 16 August: `.claude/settings.local.json` is in the
      project `.gitignore`. It was excluded only by the owner's global ignore,
      which does not travel with a clone — so on any other machine it would have
      been committed.
- [x] **F-3.** Closed 16 August: `engineStrict: true` moved to
      `pnpm-workspace.yaml` and `.npmrc` is deleted — it held only dead keys.
      Proven in an isolated package with `engines.node` of `>=99`: pnpm refuses
      from the workspace file and says "Already up to date" from `.npmrc`. The
      documentation agrees: under pnpm 11 that file is auth and registry only.
- [x] **F-4.** Closed 17 August, and it paid for itself twice.
      `node: 22` in the matrix resolves to the newest 22.x, so `>=22.12.0` — the
      one version the package promises to work on — was the one version nothing
      ran on. A floor nothing runs on is a number, not a bound.
      **Putting `22.12.0` into the gate's matrix failed on both operating
      systems**, which is the second finding: `pnpm@11.20.0` declares `>=22.13`,
      so the project's own declared floor cannot install the project's own
      dependencies. Those are two floors for two audiences. The consumer's is set
      by `commander@15`, which asks for exactly `>=22.12.0` — that is where the
      number came from — and the contributor's by the package manager. Lowering
      the promise to 22.13 to make a job go green would have refused installation
      to a consumer for whom the package works, so the promise stays and the way
      it is checked changed: a `floor` job builds on the development version and
      then runs the **built CLI** on the declared floor, which is what a consumer
      receives anyway. `--version`, `run --help` and `schema` between them load
      commander, the configuration parser with zod and the report layer, with no
      network and no target.
      Node **26** is in the matrix too (v26.7.0, 5 August 2026): `>=22.12.0` names
      no upper bound, so it promises every release above it, and the LTS pair
      alone left the version a fresh `nvm install node` gives promised and
      untested.
      `tests/workflows/portable-gate.test.ts` relates the workflow to
      `package.json` rather than pinning a third copy of the number — it asserts
      the job **reads** `engines.node` and feeds it to setup-node, and that what
      runs there is `dist/` and not the sources. Mutations: pinning the version as
      a literal in the job fails "exercised at exactly that lower bound"; running
      `pnpm run test` there instead of the built CLI fails "run the built artifact
      on it"; dropping the 26 entry fails "exercised above the current LTS".
- [x] **F-5.** Closed 16 August, though not the way the finding suggests: **no
      dependabot ecosystem covers a binary fetched by URL**, and that is why the
      official actions were rejected here in the first place. The pin now carries
      its own condition for removal instead, as the `overrides` entries and the
      `osv-scanner.toml` exceptions do. osv-scanner raised 2.4.0 -> 2.5.0 with a
      fresh sha256; 2.5.1 was published the same day and is younger than the
      seven-day cooldown this project applies to everything else. gitleaks 8.30.1
      is the current release and needed nothing.
- [x] **F-7.** Closed 16 August: `packageManager` carries the corepack integrity
      hash, written by `corepack use` rather than by hand.
- [x] **F-9.** Closed 16 August: `docs/dependencies.md` records the four figures
      CLAUDE.md asks for — release age, maintainers, transitive dependencies,
      provenance — for every package, with why each is there and what was
      considered and rejected. A package with no row has not been vetted,
      whatever anybody remembers.
- [x] **K-7.** Closed 17 August: `chmod +x dist/cli.js` became
      `node tools/executable-bit.mjs`, and `ci.yml` grew a `windows-latest` entry
      in the `check` matrix. Both halves, because either alone is worse than
      useless. The bit matters on POSIX and nowhere else — `dist/cli.js` has a
      shebang and `bin` links it onto the path — while on Windows the package
      manager writes `.cmd` shims and `chmodSync` touches only the read-only
      flag, which `0o755` leaves clear; so it is the same operation, spelled in
      the one language both platforms have. Making it portable without a job to
      run it on would have been a claim about a platform nobody here has, which
      is the shape of defect this tool exists to find.
      `tests/workflows/portable-gate.test.ts` holds both: no script may use a
      command only a POSIX shell has, and the Windows entry must be in the
      matrix. The first is a list of names and therefore always short of the
      truth — the second is why that is survivable.

      **What the job found on its first run**, which is the argument for having
      added it rather than documenting the limitation: six failures, none of them
      in `src/`, all six fixtures written in a shape only a POSIX path has. Two
      of them were the proving tests for a security invariant — "external `$ref`s
      are not resolved through the file system" interpolates the path into a
      double-quoted YAML scalar, and `C:\Users\RUNNER~1\...` makes `\U` an
      invalid escape, so the document failed to parse and the test passed on an
      error from a step before its own subject. The invariant holds; the guard is
      a string comparison with no platform in it. The proof did not, and the
      distinction between those two is the whole argument of this project. Two
      more asked one question as two claims no platform answers together — a real
      file with a canary in it, and a value the parser accepts; on POSIX one
      absolute path is both, on Windows nothing is. And the test for K-9 repeated
      K-9: it passed the absolute path as an ESM specifier, which is valid on
      POSIX and read as the scheme `d:` on Windows, so the spawned process died
      before reaching the module and "it printed nothing" was true of a stack
      trace nobody looked at. Fixed in `c5b7e4a`; the whole matrix is green.
- [x] **K-4.** Closed 17 August: `tools/managed-block.mjs` reads, compares and
      replaces the block between two markers, normalising line endings in one
      place instead of in each caller. `.gitattributes` is the other half —
      `* text=auto eol=lf`, and `eol=lf` rather than `text=auto` alone, because
      the latter settles what goes **into** the repository and leaves the
      checkout to `core.autocrlf`, which Git for Windows turns on by itself; the
      gates read the working tree. Measured: on a CRLF copy of
      `polygon/README.md` the old `current === block` is false and the new
      comparison is true, while a genuinely stale table is still refused in both.
      Two more closed on the way — `text.replace(current, block)` treated `$&`
      and `$1` in the rendered table as substitutions, and markers in the wrong
      order silently gave an empty block.
- [x] **K-8.** Closed 17 August: `SharedCredentialError`, thrown by
      `resolveTokens` before the first request. Two accounts presenting one token
      means every cross-account check compares an account with itself and reports
      the match as isolation — a clean run that cannot mean what it says, which
      is worse than no run, so it is a refusal and not a warning. The message
      names both accounts and both variables, says the "both read one variable"
      case separately, and carries no part of the token: a value that reaches an
      error message reaches a log. Declared accounts only — the ones derived for
      request conditions share their principal's credential by design.
- [x] **K-9.** Closed 17 August: `tools/is-main.mjs`, called by both polygons'
      `tokens.mjs`. Reproduced first — through a symlink the script decided it
      had been imported, did nothing, said nothing and exited 0. `realpath` on
      **both** sides, not only on `process.argv[1]`: under
      `--preserve-symlinks-main` it is `import.meta.url` that keeps the symlink,
      and resolving one side alone only swaps which invocation is broken.
      `import.meta.main` says this in one line and is node 24; the floor here is
      22.12. The tests run the real scripts through a symlink and require the
      message and exit 2, and require silence on import — otherwise a "fix" that
      makes `main()` unconditional would pass everything else.
- [x] **G-5.** Closed 15 August, addendum to
      [ADR-0014](docs/adr/0014-severity-and-exit-codes.md): a usage error exits
      **64** (`EX_USAGE`), set through `exitOverride` on every command — commander
      does not pass the callback down, and it is the subcommand that handles
      `barbican run`. `--help` and `--version` stay 0 by their `exitCode`.
      `process.exitCode` rather than `process.exit()`, so a report going to stdout
      cannot be truncated. The polygon gate checks seven invocations; removing the
      loop over the subcommands turns it red naming the case.
      Original finding: a CLI usage error exits **1** — the same code as "checked,
      and it does not match". A typo in a flag name reports as a privilege
      escalation.
- [x] **G-6.** Closed 15 August with G-5: both tables now list 64 and 130, and
      say that the line runs at the start of the run — the parser rejects with 64,
      anything after it is 2. 130 was measured, not assumed: SIGINT part-way
      through a walk against the polygon.
      Original finding: the exit-code table covers neither a failed startup nor
      `SIGINT`, which gives **130**.
- [x] **G-9.** Closed with item 12 of the second ranking on 16 August; the box
      here stayed open until 17 August, when it was settled against the code
      rather than against either mark. `describeRule` in `src/core/expected.ts`
      names a rule by its path plus its position from the top, and the comment
      records why one-based numbering was rejected: the same number travels into
      the report as `ruleIndex`, where it is an index a consumer reads
      `policy.rules[ruleIndex]` with, so renumbering the message alone would give
      one rule two numbering schemes.
- [x] **G-10.** Closed with the same item; the box was likewise stale.
      `readNamedFile(flag, path)` in `src/cli.ts` wraps the read and names both
      the flag and the path, listing the four flags a run can carry and pointing
      at a directory as the usual cause — because `EISDIR: illegal operation on a
      directory, read` tells an operator that one of their paths is wrong and not
      which.
- [x] **D-5.** Closed 16 August: the extractor sets `bodyOverLimit` when a body
      was too large to read, so "no comparison was made" and "the bodies
      differed" stop looking the same in the report — which is the pair this
      whole check exists to keep apart. A second reserved signal name, for the
      reason the first one is: a declared scalar of that name would take its
      place and the check would read something else in silence.
- [x] **D-7.** Closed 16 August: `maxBytes` (1 MB) and `maxDepth` (32), with the
      depth walk copied from the OpenAPI parser rather than written a second way.
      **The finding overstates it** — `maxAliasCount` was already there, so this
      path was not without limits, it was without two of the three. Smaller
      numbers than a specification's, because a specification is generated and a
      configuration is written by a human.

### Legal, language, and platform assumptions

- [x] **J-1.** Closed 15 August by decision: the history stays, the rule holds
      from 13 August 2026, and `tools/commit-msg-language.mjs` guards the next
      message through a lefthook `commit-msg` job. Original finding: **100 of 131 commits are written in Russian**, which CLAUDE.md
      forbids without exception, commit messages included. **J-18**: the guard
      reads `git ls-files`, that is the contents of tracked files; the history is
      outside its scope entirely and there is no `commit-msg` hook. Thirteen merge
      commits also fail conventional commits. The last Russian commit is `1b3ed47`
      of 13 August, so the rule holds de facto from that date — the decision to
      make is whether to say so in CLAUDE.md and add the hook, or rewrite history.
- [x] **L-6.** Closed 15 August: a section in the README before the safety
      defaults, and a shorter one in the guide before "What the tool does not do".
      Original finding: Not one line anywhere in the user documentation says that testing
      someone else's system needs their permission. The README says outright
      "meant to run against systems you do not own outright" and answers that with
      technical defaults. A search for `permission | authoriz | consent | legal`
      matches only the licence text and the `Authorization` header. The package
      ships with the keywords `bola`, `idor`, `api-security`.
- [x] **L-7.** Closed 16 August. A 404 on a state-changing endpoint whose object
      this run has already changed is recorded as `error` — no conclusion — with
      the reason in `failures`, instead of `not-found`, which folds into a denial
      and reads as proof of protection. Narrow on purpose: state-changing methods
      only, only after a 2xx on the same endpoint and resource in the same run,
      and a 403 is untouched because that is the platform answering.
      **Best effort, and said so in the guide:** the walk is parallel, so two
      accounts can be inside one cell at once and neither sees the other's write.
      What this removes is the silent conclusion, not the race.
      The finding's own note held — nothing caught the class, because the
      polygon's one write endpoint was chosen to sidestep it. The new test builds
      a platform that really deletes.
      Original finding: traversal order is assumed not to matter, and with
      `--unsafe-methods` that is false: a `DELETE` performed by the first account
      gives every later one a 404, which folds into `denied` and matches a policy
      of denial.
- [x] **L-3.** Documented 15 August in the README, `docs/guide.md`,
      `docs/report.md` and at `classifyStatus` itself, with a guard test so the
      warning survives the next edit. **The finding was understated**: the body
      checks are poisoned too, which was measured rather than reasoned — they run
      only on cells whose outcome is `allowed`, and there that is every cell, so
      two accounts both *refused* get the same envelope, the same digest and a
      cross-tenant leak that is not there. A six-cell demo platform gave four
      false escalations, one false leak and exit code 1. An earlier draft of the
      documentation claimed the opposite before the claim was run.
      **Not fixed, and cannot be with what exists**: there is no way to declare
      what a refusal looks like — see L-11 below.
      Original finding: a platform that refuses with `200` and an error envelope
      produces a hundred per cent false positives: `classifyStatus` treats any 2xx
      as allowed. The risk named first in `plan.md` — "a tool that finds things
      that do not exist loses trust on the first run" — realised in full, and the
      guide's "What the tool does not do" says nothing about it.
- [~] **L-11.** Half built on 15 August, and the other half is blocked on a
      decision rather than on work.
      **The negative canary does not work, and that was my error in this entry**,
      not a detail: an endpoint an account must not reach, answering 200, is
      indistinguishable from a genuine privilege escalation. It has to be —
      **from status codes alone "refuses with 200" and "grants everything" are
      the same picture**, and no declaration changes that. Only reading the body
      does, which is the second shape and a change to ADR-0011.
      **What was built instead:** `coverage.outcomes` counts the observations by
      conclusion, and a run where `denied` is 0 with observations present says so
      on stderr, in red, naming both readings. Not an exit code: a genuinely
      wide-open platform is the worst finding there is, and hiding it behind
      "cannot be trusted" is the opposite mistake.
      **Still open:** a declared refusal predicate over a body scalar, which
      would make the matrix work on such a platform. It needs an ADR against
      ADR-0011 first — the tool would be reading a body to decide access.
      **Not covered by a gate:** the stderr line itself. `coverage.outcomes` is
      unit-tested and it is the whole of the condition, but the three lines
      wiring it into the summary are not. Three cheap routes to a polygon
      assertion were tried and each cost more than the assertion is worth; the
      fourth was to add an "authorization off entirely" flag to the reference
      platform, and editing the thing the ground truth rests on to test a
      stderr line is the wrong trade. Said here rather than left as a silent gap.
      Came out of L-3 on 15 August.

### A contradiction between tracks, left unreconciled

Track A's verdict table records "scope is not widened through substituted values —
holds". Track D demonstrated by running that a `.` in a resource value walks the
request onto an excluded endpoint's path, and that the `joinUrl` guard is inert
when `baseUrl` has no path (D-1).

There is no disagreement about facts — A mutated `Object.hasOwn`, D supplied a
hostile **value**, and the two probed different things in the same line. But A's
verdict is refuted by D's run, and the invariant should be counted as breached.

### What could not be checked

Windows, locally: there is nothing here to run it on. As of 17 August CI has a
`windows-latest` job, so the gate is answered there rather than reasoned about —
but K-4's `.gitattributes` is still checked through `git check-attr`, the rules
actually in force, and not by a checkout on the platform it exists for. Branch
protection on GitHub, so it is unknown whether the three missing release gates
block a merge in practice. Real network latency — localhost only, so the scale
numbers are extrapolation from a model confirmed at two latencies. OpenAPI
parsing at scale. A matrix with request conditions at scale. Node 22.12.0 exactly.
The published 0.2.0 tarball from the registry. The crAPI and VAmPI polygons.
Mutation testing of `src/io`, `src/adapters` and `src/report` — `config.ts` at
1 718 lines was not covered. An interrupt landing exactly inside the report write
(13 attempts, no hit). Terminal state after an interrupt.

### Order of work, by risk over cost

Struck through means closed and proven; the rest is the remaining work in the
order it was ranked on 14 August. Item 9 is the one exception to "closed means
finished" — see B-1.

1. ~~**nanoid** — tonight, in the window 16:41-24:00 UTC.~~
2. ~~**C-1** reserve the name `digest`.~~
3. ~~**A-3** allowlist instead of a denylist for query attributes, or redact the
   value inside the printed URL.~~
4. ~~**A-1** unwrap `cause` when matching terminal errors.~~
5. ~~**D-1** `pathSegment` instead of `encodeURIComponent`.~~
6. ~~**L-2** a canary for resources.~~
7. ~~**L-1** re-probe the canaries at the end of the walk.~~
8. ~~**F-2** the release runs all four gates.~~
9. ~~**B-1** stop discarding registry findings.~~ Closed in full with L-4.
10. ~~**I-3** cache the path parse in `resourceApplies` — also fixes I-4.~~
11. ~~**C-2** an exact `toEqual` on the four remaining default constants.~~
12. ~~**H-1 + H-2** `basis: "fallback"` beside `expected`, and a documentation
    link in the JSON.~~
13. ~~**G-8 / K-3** check the report path before the first request.~~
14. ~~**J-2, J-3, J-4** bring CLAUDE.md and the `http.ts` header back to the
    code.~~
15. ~~**K-1 + K-2** clean the temporary directories, write the report `0o600`.~~
16. ~~**L-6** a paragraph about the system owner's permission.~~
17. ~~**G-5 + G-6** a distinct exit code for usage errors, and the table says
    what the tool actually returns.~~
18. ~~**B-2 / H-3** a single source for the per-cell verdict.~~
19. ~~**I-1** a parallel walk, or drop the flag honestly.~~ Parallel; I-8 came
    out of it.
20. ~~**D-6** branded types in `src/io/untrusted.ts`.~~ With D-2, D-3, D-4 and
    A-4, which are the same mistake.
21. ~~**J-1** decide about the history, and add a `commit-msg` hook.~~
22. ~~**L-4** rework `Finding` and `CheckContext` before phase 5 is scheduled.~~
    Taken in full on 15 August, after the rest of the ranked plan.
23. ~~**L-3** a warning about platforms that refuse with an envelope.~~ Warned
    in four places and guarded by a test; L-11 is the fix, and is not done.

- [x] **E-8.** Closed 17 August: both are optional now. The weighing came out
      one-sided once measured — `headers` is read by exactly one line of the
      report and by nothing in the core, and **`durationMs` is read by no code
      anywhere**: the runner writes it, the file carries it, and it is there for
      a person wondering whether a denial came back instantly or after a timeout.
      What settles it is not the convenience: an empty header map is a claim that
      the response carried no headers worth keeping, when the truth is that
      nobody recorded any, and a report cannot tell those apart. A required field
      the producer cannot supply becomes a false statement in the artifact —
      absence says the true thing, and `url` and `method` are already optional
      for exactly this reason (B-7). The README example lost eight lines and now
      compiles as a consumer would actually write it; the character-for-character
      guard kept the two in step. Mutation: making the fields required again
      fails the typecheck on `tests/core/observation-shape.test.ts`, which is the
      right gate for a claim about a shape.
      One thing found while doing it: `headers: observation.headers` in
      `mergeFindings` survives `exactOptionalPropertyTypes` only because the
      literal has no contextual type to be checked against. Replaced with the
      conditional spread the rest of the file uses — a guarantee resting on the
      absence of a check is not one.

### Second ranking, 15 August — what is left

The first list was written on 14 August over everything the audit produced and is
finished. This one ranks the 71 items below that cut, by the same criterion: how
badly the **artifact or the gate lies**, over what it costs to stop it.

Two claims were re-checked before ranking rather than carried over. E-2 holds —
the README's only library example still does not compile, `diffAccess` wants a
`ResolvedAccessPolicy`. F-6 has half rotted: `pnpm audit` is clean as of today,
so it is no longer "a declared layer that would fail", only one that runs
nowhere, and it drops accordingly.

1. ~~**E-2** — the only library example in the README does not compile.~~ Done
   15 August: it is compiled, run and compared with the README by a test.
2. ~~**L-9 + A-2** — after a truncation the walk does not stop, and past an
   exhausted budget every remaining cell still makes three attempts with two
   sleeps.~~ Done 15 August: a truncated run is now cheaper than a full one
   instead of dearer, and its rows say "never asked" rather than "asked and it
   broke".
3. ~~**B-3 + B-4** — the exit code is the CI contract and it has two thresholds
   and one flat key space.~~ Done 15 August; B-14 is half closed with them.
4. ~~**B-7** — a failure before the address is built yields no observation,
   hence no `probe-error`.~~ Done 15 August.
5. ~~**B-5** — `bodiesComparedOn` names endpoints that were never probed.~~ Done
   15 August.
6. ~~**C-5 + C-4 + C-6 + C-7 + A-5 + A-6** — assertions that do not assert.~~
   Done 15 August. Every one was re-measured first: A-6 and half of C-5 were
   already closed, the other six survived the whole suite. B-14's remaining half —
   the uncovered `buildReport -> runVerdict` seam — was closed on 17 August.
7. ~~**G-1 + G-2 + G-3 + G-7** — the dry run lies in four ways.~~ Done
   15 August; four mutations, four distinct failures in the polygon gate.
8. ~~**K-5, then E-3 + E-4 + E-5** — the link guard walks the file system instead
   of git, which is why nine broken links ship.~~ Done 15 August, taken ahead of
   items 5–7 because it is what separated `main` from the `0.3.0` release that
   closes phase 4.
9. ~~**H-11** — `configDigest` answers nothing.~~ Done 15 August. Key order was
   never the problem; a `Map` serialising to `{}` was.
10. ~~**I-2 + I-7** — the walk happens twice, and the policy is scanned per
    cell.~~ Done 16 August. I-7's diagnosis was wrong — the missing `break` is
    not the defect and must not be added — and the fix is an index built once.
11. ~~**J-5 … J-16** — twelve documents that contradict the code.~~ Done
    16 August. Three and a half were already closed when re-checked, which is why
    each was verified against the code before being touched.
12. ~~**H-4 … H-10, B-9, B-16, G-9, G-10** — what a reader cannot do with the
    artifact.~~ Done 16 August in three commits. H-5 was half closed already.
13. ~~**D-5 + D-7** — a body over the ceiling silently zeroes the comparison;
    `parseRunConfig` has no size or depth limit.~~ Done 16 August. D-7's wording
    overstated it: the alias limit was already in place.
14. ~~**L-7** — traversal order is assumed not to matter, and with
    `--unsafe-methods` it is not.~~ Done 16 August.
15. ~~**F-6, F-3, F-5, F-7, F-9, K-4, K-6, K-7, K-8, K-9, L-8, L-10** — supply
    chain and hygiene.~~ Done 16–17 August. Two settings had been off since the
    pnpm 11 upgrade and nothing said so; F-5 asked for a dependabot ecosystem
    that does not exist for a binary fetched by URL, and F-6's "it exits 1 today"
    had expired.
16. ~~**I-5 + I-6** — scale past the present ceiling.~~ Done 17 August. This
    entry said "nothing to measure against until somebody runs it at that size" —
    so it was run at that size, and the answer was not a ceiling but a hard
    failure inside the default request budget: `RangeError` at the moment of
    writing the file, after a complete and correct run. Measuring first is what
    turned a parked item into a fixed defect.

## Adversarial review of 17 August 2026 (after the release of 0.3.0)

Two attackers, one on the request side and one on the report, each required to
bring a reproducible PoC. Run because phase 4 had just closed, `0.4.0` was about
to be cut, and `src/adapters` and `src/report` had both changed that day.

- [x] **The evidence cap reached the verdict.** `runVerdict` filtered
      `report.findings`, ADR-0029 made that the capped array, and the denominator
      `summary.observations` was not capped: **101 cells that all failed to answer
      exited 0**, inside the default request budget, and shipped in `0.3.0`. The
      counts now travel in `summary.verdictInputs`, taken before the cap and
      separated by source — `byKind` could not serve, that is B-4. Closed with the
      second half of it: the 50-row budget was shared between kinds on one
      endpoint, so the heavier kind starved the quieter one out of the file.
- [x] **The cell that received a leak was printed as agreed.** A finding by body
      is about a pair, and only `accountId` narrowed a verdict — twelve cells on
      the reference run, the same twelve ADR-0022 quotes for the defect it closed
      on 15 August. That fix taught the loop to read check findings and left it
      reading one end of them.
- [x] **The address was not the tool's to build.** Three sources fed a query
      string straight into the request — OpenAPI `paths`, the endpoint list, the
      array form of Postman's `url.path` — so `?_method=DELETE` performed a write
      with `--unsafe-methods` absent, and `..` reached a different endpoint past
      the exclusion list. `resources[].query`, the twin of `contexts[].query`, had
      no guard at all: a credential there is printed in `observations[].url`.
      `pathTemplate` in `untrusted.ts` is the grammar, per ADR-0024.

Open, from the same review, in the order they were ranked:

- [x] **`SharedCredentialError` is removed by a trailing space.** Closed
      17 August: the comparison is over the trimmed value, which is what a
      platform sees — a header value may carry surrounding whitespace and every
      parser drops it, the reference platform in this repository in the regular
      expression that reads `Authorization`. Trimming is the only normalisation
      applied: what a platform does beyond it is unknown here, and guessing would
      trade a refusal that is right for one that is plausible.
- [x] **`--checks ""` disables the body channel in silence.** Closed 17 August,
      and it was two defects. An empty selection is now refused like a
      misspelling — there is deliberately no way to spell "run no checks", since
      the flag narrows a run rather than disarming it. And `bodiesComparedOn` now
      requires a check to have run: it was built from the declarations and the
      walk and never from whether anything ran, so it named every declared
      endpoint as compared with `checksRun: []` beside it. The same lie B-5 closed
      from the other side, in the field whose own comment says it exists to
      prevent exactly this.
- [x] **The response-header allowlist leaks through two names.** Closed
      17 August. `www-authenticate` is on the list for its **scheme** — a 401
      asking for `Bearer` and one asking for `Basic` are different facts about
      access — and the rest is free text the platform composes, with RFC 6750
      putting `error_description` there by design. The first token is kept and
      the rest dropped.
      `sanitizeLocation` stripped query and fragment and kept the path, which is
      an enumeration of the two places a secret was expected to be: a
      password-reset link, a magic link and a device-code flow all carry their
      token in the path, so the redaction mark went into the report sitting
      beside the secret. **The same mistake as a denylist of header names, one
      field down** — the places a secret can be cannot be enumerated. Only the
      origin survives now, which is the part a verdict rests on, since a 3xx to
      another host is a scope escape. A relative location keeps nothing but the
      mark: `/reset/TOKEN` and `/login` are indistinguishable to that function and
      only one of them is safe to print.
- [x] **`content-length` is on the allowlist.** Weighed on 17 August and **kept**,
      with the documentation corrected instead. Measured first, on the reference
      platform's clean run: `orders.read`, where nothing is declared, shows three
      distinct lengths across seven responses, so the channel is real. It stays
      because the tool never reads a body to obtain it — the server volunteers it
      in a header — because it carries no credential, and because an empty 200 and
      a four-kilobyte 200 are different findings to whoever is triaging. What was
      wrong is that `docs/report.md` let a reader conclude the file says nothing
      about body content unless they asked for it. It now says the opposite in the
      place that promise lives, so a reader can decide whether the file may
      travel.
- [x] **`Retry-After: 0` removes the backoff.** Closed 17 August: the header may
      only make the tool wait **longer**, never shorter, and never past its own
      ceiling. A ceiling was added when a huge value removed the delay —
      `setTimeout` clamps above 2^31-1 ms — and the same bound was missing
      underneath, so `0`, a negative value or a past timestamp all gave
      `sleep(0)`. Measured against a deployment answering 503: 15 requests in
      5 255 ms became 15 in 2 817 ms, doubling the rate at a system already
      failing. The floor is the tool's own formula, because that is what the
      header means — "not before" is a minimum the server asks for, and nothing
      in it entitles a target to shorten a delay this tool decided on.
- [x] **`--dry-run` fails on a configuration that runs.** Closed 17 August:
      `describePlan` built its accounts with an empty map, so any context
      attribute written as `{ env: NAME }` threw `MissingContextValueError` — the
      dry run refused a configuration the real run executes, and named a variable
      that was set the whole time. Both paths resolve from `process.env` now, and
      a genuinely missing variable still stops the dry run, which is what the
      command is for. The command a reader is told to try first on somebody
      else's deployment was the one that failed and blamed them for it.
- [x] **`Finding.evidence` admits strings** where `SignalValue` does not, so the
      PII ban is structural on one and disciplinary on the other. **Named rather
      than closed, on 17 August**, and the reasoning is in the type: `string` has
      to be allowed there — a counterpart account id, an endpoint, a reason are
      all strings, and Module 2's evidence pack is built out of them. Narrowing
      the type would close the extension point the registry exists for; bounding
      a value's length would stop a body and not a credential, which is a bound
      rather than a guarantee and belongs in an ADR before it goes into an
      interface a future module is built on. What was wrong was the comment
      claiming a rule that nothing enforced; it now says which of the two channels
      the type system closes and which one review does.
      **The spread that made it possible is closed**, 17 August: matrix findings
      are named field by field like the check mapping beside them, and
      `nothingLeftUnnamed` guards the rest. `ReportFinding` does not extend
      `AccessDiff` — it merges two sources and re-declares what they share — so
      `{ ...diff }` carried whatever the core put on a discrepancy, declared here
      or not, which is exactly how `basis` and `ruleIndex` reached every report
      and were named by that interface nowhere. Mutation: a field added to
      `AccessDiff` now fails the compile at a named line.
      `withVerdicts` keeps its spread **on purpose**: `ReportedObservation`
      extends `AccessObservation`, so carrying every field is what the type says
      it does. A spread is wrong where the target re-declares its fields and right
      where it inherits them — which is the distinction the finding did not
      draw.
- [x] **`defectGroups` is not a lower bound across `contextId`.** Closed
      17 August as a documentation defect, which is what it was: the design is
      deliberate and already defended in the section on conditions — a defect
      visible with a declared attribute and without it may be two paths in the
      code, and conditions are in the signature precisely because the country
      check and the permission check break independently. What contradicted it was
      the summary table calling the number a lower bound with no qualification,
      two hundred lines above the paragraph admitting it can exceed the truth on
      that one axis. Both now say the same thing, and the caveat sits where the
      number is defined rather than where a reader might not reach.
- [x] **The file half of the `$ref` invariant is held by barriers 2 and 3**, not
      by barrier 1 as the module header now says — an absolute path and `file://`
      need no base. The header was rewritten on 17 August from a measurement that
      covered http only, and the tripwire counts http requests alone.
      Closed 18 August. Measured rather than reasoned, and the premise turned out
      to understate it: swagger-parser 12.1.0 resolves `./package.json` and even
      `package.json` from a document handed over as an object, taking the
      **process's working directory** as the base — so the header's "a relative
      `$ref` has nothing to count from" was false in every form, not only for
      absolute ones.
      Which barrier holds it, by removing them one at a time against a canary file:
      barrier 2 off with `external: false` kept — nothing read; barrier 2 on with
      `external: true` — refused before swagger-parser is called. Both hold
      independently; barrier 1 holds neither. A third stale claim fell out of the
      same measurement: the test guarding the option said it protects nothing
      today and is kept for a future version, which is true of the http half only.
      The file half is covered by two tests of the shape the http tripwire uses —
      they assert the danger is real now, so the day the library stops reading
      files by absolute path, somebody has to read the header again.
- [x] **`ReportFinding` declares neither `basis` nor `ruleIndex`** though every
      matrix finding carries them; `staleCredentials` is a sixth reason for exit 2
      and `docs/report.md` lists five.
      Both halves closed 17 August. The sixth reason is in the table in
      `docs/report.md`, with a note saying it was missing until that day, and
      `ReportFinding` declares `basis` and `ruleIndex` with the reasoning beside
      them.
      I recorded the opposite here earlier on 18 August — "the fields went onto
      `ReportedObservation` and the finding still has neither" — from a listing of
      the interface that stopped short of them; they are 45 lines further down.
      Both interfaces carry the pair. The claim was wrong, not the code.

## Adversarial review of 18 August 2026 (the gate itself)

Two more attackers, on what the reviews of 17 August did not touch: the polygon
and its oracle, the tenancy and relation core, and the CLI's terminal output.

- [x] **The oracle could not see a cell it expects no finding on.** `compareVariant`
      compares **sets of cells a finding is expected on**, so a cell named in no
      variant's findings is outside the comparison entirely — on this platform
      that is some 34 of 144: the anonymous account, `health`, `affiliate.stats`,
      and the accounts under `wide-scope`. Demonstrated and reproduced: one line
      dropping the anonymous account from every run leaves `tsc` clean, 859 tests
      green, and the gate reporting 28 combinations and 0 mismatches with the
      matrix down to 128 cells. The account whose entire purpose is the claim
      "this endpoint is not public" stopped being asked and nothing said so.
      Closed: every variant declares `expectedCells`, written by hand like the
      rest of the ground truth, `loadGroundTruth` refuses a variant without it,
      and `compareVariant` reports a size change as a mismatch that names why a
      finding comparison could not have caught it.
- [x] **The one coverage number came from the first combination.** The README
      table said "Cells probed per combination: 144", taken from `rows[0]` — and
      it was already wrong for the three write combinations, which probe 180. It
      was also the only measure of coverage anywhere in the gate, so a regression
      halving the matrix in 27 of 28 combinations reproduced the committed table
      byte for byte. The count is now a column, row by row.
- [x] **A canary the policy denies.** Found by the other agent while writing the
      guide, in its own example: `assertCanariesUsable` checked existence,
      templating and exclusion, and nobody checked that the policy declares the
      endpoint reachable for that role. Two of the operator's own statements that
      cannot both be true, and the run reported the contradiction as a
      `privilege-escalation` on the platform. Refused before the first request.

Open, from the same review:

- [x] **`relationOf` can be broken so that severity drops and the gate stays
      green.** Replacing the final `foreign-tenant` with `ancestor-tenant` takes
      every cross-tenant leak from `critical` to `high`, and 28 combinations still
      match: `cellKey` carries no relation, the signature checks compare the report
      with itself, and `severity` is only ever checked as a sum. Unit tests in
      `tests/core/tenancy.test.ts` do catch this particular mutation — so the
      weight of a finding rests on hand-written fixtures rather than on the gate,
      and the polygon README's claim that a relation "travelled all the way to a
      line of the report" is prose, not a check.
      Closed 18 August, commit 981a561. The ground truth now carries a
      hand-written `relations` table — 34 entries, keyed by the account without
      its request conditions — and `compareVariant` checks each finding's
      relation against it and its severity against the one ADR-0014's table gives
      for that relation and kind. Verified by my own mutation: the same
      `foreign-tenant` → `ancestor-tenant` edit took the gate from MATCHES on
      every variant to 16 mismatches, each naming both the relation and the
      weight. The relation is deliberately not in `cellKey`: there the mutation
      prints 24 lines of "missing and unexpected" with the word relation in none
      of them.
- [x] **A typo in a resource parameter name silently removes its cells.** Closed
      18 August: `assertReferencesResolve` refuses a resource that fits no
      endpoint, which is what this project already does with every other
      declaration matching nothing — a policy pattern that fits nothing stops the
      run, so does an empty rule selector, both because staying silent about them
      is not allowed. A resource was the one left out, and a typo in its
      **endpoint list** was already refused while a typo in a **parameter name**
      was not. The message names the parameters the resource carries, since that
      is where the typo is.
      Verified on the polygon's own configuration: `orderId` → `orderid` used to
      take a run from 144 cells to 126 in silence and now stops it before the
      first request. Four cases covered, including the two that must still pass —
      a query-only resource naming an endpoint that takes no parameter — and the
      one that must not: a resource naming an endpoint whose parameter it does not
      carry, which is the same hole in a different spelling.
- [x] **`checkCoverage` proves something narrower than its own header claims.** It
      checks that each `status`/`body-signal` defect is named in at least one
      finding, not "is everything declared tested at all". Downgrading one defect
      to `out-of-scope` and deleting its two variants leaves the gate reporting 26
      combinations, 0 mismatches, and coverage complete — nothing records how many
      defects or variants there should be. Separately: `PRIMARY_TENANT_ONLY` also
      breaks a write, and no variant exercises it with `--unsafe-methods`, so an
      independent oracle finds two cells the ground truth does not record.
      Closed 18 August, commit 981a561, by doing both halves. The header is
      narrowed to what the function proves, and the missing half is a new test
      that counts the switches out of `polygon/server.mjs` itself — the set of
      `POLYGON_DEFECT_*` must equal the oracle's defect keys, each must be on in
      some variant, and each variant must state every flag rather than some,
      because `verify.mjs` inherits the environment and an unnamed flag is a flag
      in whatever state the operator's shell had. It could not live in
      `checkCoverage`: the ADR-0012 format knows nothing about how a polygon
      switches a defect on. Verified by mutation: renaming one flag in the
      platform fails three of them. `PRIMARY_TENANT_ONLY` got its write variant —
      180 cells, 4 findings, written out by hand before the run.
- [x] **The terminal and the file disagree, under a comment saying they cannot.**
      `build.ts` says the warnings are "the same ones the console shows, from the
      same constants"; `WARNINGS` does not occur in `src/cli.ts` at all, two of the
      texts have already drifted apart, and `findingsCapped` is never printed on
      screen — a run whose evidence rows were dropped says so only in the file.
      Closed 18 August, commit 2a01626. The CLI prints `report.warnings` itself,
      so `warningsFor` is the one place that decides what is warned about; this
      file keeps only the colour, as a total `Record` over the keys of `WARNINGS`,
      which is the half of the guard `findingsCapped` lacked. Verified by
      mutation: a fifth key added to `WARNINGS` fails `tsc` twice.
      I found one direction untested and closed it: the fix proves every warning
      in the file reaches the screen, and nothing proved the reverse — making
      `needsCanary` return `true` unconditionally left all ten tests green, which
      is the same disagreement told by the half that leaves no artifact behind.
      The anonymous run is now a case of its own.
- [x] **A green line on a run with twelve cross-tenant leaks.** "No privilege
      escalation found" is literally true — `byKind` there counts matrix kinds
      only — and it is the headline of the screen, coloured green, with "Of those,
      found by body rather than status: 12" below it referring to the ones it just
      called absent.
      Closed 18 August, commit 2a01626. Green now requires nothing found at all
      **and** a verdict of 0 — not "zero escalations", which is one counter of
      several, and not the verdict alone, which is 0 on a run whose findings were
      all notes. Otherwise the same fact in plain words with what contradicts it
      named on the same line. Both directions are held: a run that genuinely found
      nothing and proved it still says so unqualified, or the line stops meaning
      anything and the next reader learns to skip it.
- [x] **Stale claims in `polygon/server.mjs`.** The header still says "every defect
      must show itself in the response status", untrue since ADR-0011; the comment
      on `DEFECT_FLAGS` says "eight of the ten" where the object holds twelve. The
      README beside it was corrected and the numbers in the source were not.

      Closed 18 August, commit 981a561. Both numbers are now counted out of the
      file by a test rather than kept by hand. Verified by mutation: changing "ten
      of the twelve" to "nine" in the prose fails two tests.
- [x] **Two polygons' oracles had stopped parsing, and no test opened them.**
      Found by an agent while working the item above, and it is mine: making
      `expectedCells` mandatory on 17 August was tried against
      `polygon/ground-truth.json` alone, and both files under `polygons/` began
      throwing at their first variant. The suite stayed green because nothing
      loads them — they are run by hand against a polygon in Docker, so this would
      have surfaced whenever somebody next brought one up.
      Closed 18 August, commit 08c88c1. crAPI cannot carry the number at all: its
      endpoints come from an OpenAPI document inside the crAPI checkout, so the
      count is a property of a file this repository does not hold. The field is
      optional again and checked when present; which polygons owe it, and crAPI's
      exemption in as many words, are a test. VAmPI declares 27, counted by hand
      and confirmed against `--dry-run`, which plans the matrix without sending
      anything and needs no Docker.
      The guard that would have caught it: every tracked `ground-truth.json` is
      found by `git ls-files` and loaded. Found rather than listed — a list is the
      same defect one level up.

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
- [x] 🔴 **MANDATORY, 14 August 2026 after 16:41 UTC.** Done: the lockfile holds
      `nanoid` 3.3.18, that is what installs, and `osv-scanner.toml` has no
      entries left — only the rule about not having silent ones. Verified on
      17 August rather than taken from the box, which was still open.
      **And the `overrides` entry is gone with it.** It carried its own condition
      for removal — "when postcss itself moves past 3.3.17 in a version this
      project installs, the override stops changing anything and only hides the
      fact that it stopped" — and that was measured, not assumed: with the entry
      deleted, pnpm resolves 3.3.18 anyway, because postcss asks for `^3.3.16`.
      `pnpm audit` is clean, `--frozen-lockfile` passes, and if a future
      resolution ever did pick 3.3.17 the OSV scan would say so, which is the
      safety net the removal condition was written against.
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
- [x] **The error "endpoint is not among the parsed ones" now lists them**, nearest
      first: a typo keeps the prefix, so on a truncated list the intended name comes
      out on top. An empty list says so instead — that is a different fact and a
      worse one.
- [x] **The canary no longer blames a stale token for a dead port.** The transport
      failure's code travels with the result (`ECONNREFUSED`, `ENOTFOUND`), and the
      message says "the platform did not answer at all — this says nothing about the
      tokens". A code and never the error text: the field is serialized, and a
      bounded vocabulary cannot carry a URL with a token in it.
- [x] **The exit code now explains itself.** `runVerdict` returns the reason
      alongside the code, derived where the code is derived, and the CLI prints it
      as the last line. "Distinct defects: at least 1" is now followed by "Exit code
      0: no discrepancy that fails a run — the rows above are notes, not access
      holes".
- [x] **A JSON Schema ships with the package** and `barbican schema` prints it,
      derived from the same zod schema that validates a run. A test compares the
      checked-in copy against the generated one; the starter config carries a
      `$schema` line.
- [x] **`--dry-run`** — the answer to "what exactly will you touch", given before
      the first request. Prints the identifiers, what is skipped and why, the matrix
      rows and the exact number of cells; sends nothing. The plan comes from
      `planEndpoints`, the same function the run uses, so the preview cannot drift.
      Proved in `verify.mjs` the only way that admits no argument: the run is made
      against a platform that is not up.

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
- [x] **The README and the path "from zero to the first run" were checked by a cold
      read.** Closed 14 August 2026 by the fourth cold read — see that section
      below: a reader installed 0.2.0 from npm, never opened the repository, read
      the README and the two guides, wrote their own configuration and reached a
      meaningful run on the first attempt (25 cells, a deliberate cross-tenant
      defect found, exit 1). The path held; the **package** did not — a
      pre-release README in the tarball, no `docs` and no `examples` inside it,
      nine relative links dead on install. Those are recorded separately and
      closed. Original finding: the README and the path from zero to the first
      run had never been read cold, only the report and the guides had, and that
      is exactly the exit criterion of phase 4.
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
- [x] Keep the gitleaks version in CI (`GITLEAKS_VERSION` in ci.yml) in agreement with the
      local one from Homebrew. When the local one is updated, update the version and
      `GITLEAKS_SHA256`, otherwise CI and pre-commit will start to differ in their verdicts.
      Closed 18 August, and not by remembering: the pre-commit hook reads the pin out
      of `ci.yml` and says so when the local binary is a different version. Silent when
      they agree, which today they do (8.30.1 both sides). Non-blocking on purpose —
      CI scans the full history on every push and, since `release.yml` calls `ci.yml`
      whole, on every release, so a mismatch costs a differing verdict and not a hole;
      a hook that refuses for a reason the committer cannot fix teaches `--no-verify`,
      which switches off the scan itself. A missing pin does fail: that is the
      repository being wrong rather than the machine.
      The half a machine can check without the binary is a test — the pin exists, the
      download URL is built from the variable rather than from a second copy of the
      number, and **the hook actually runs the comparison**. That last one is the
      guard that matters: a guard nobody calls passes review and is invisible.
- [ ] A quarterly review of the thresholds for revisiting decisions — the table in [plan.md](plan.md).
      The nearest one expected: `@apidevtools/swagger-parser` around April 2027.
- [ ] Revisit TypeScript 7 once it leaves preview and stabilizes its public API.

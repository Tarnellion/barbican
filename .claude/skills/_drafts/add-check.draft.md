---
name: add-check
description: Add a new check to the barbican registry — the check file, its registration, a fixture, a test and a mapping onto clauses of external standards. Use when a new detector is needed (privilege escalation, BOLA/IDOR, cross-tenant) or a check for the Module 2 evidence pack.
---

**DRAFT — not active. Review and move by hand.**

# Adding a check

Checks are plugins (ADR-0003). A new check does not change the core.

## Steps

1. Create `src/core/checks/<name>.ts`, exporting an object of type `Check`:
   - `id` — stable, in the form `<area>.<what-is-checked>`, for example `tenant.cross-read`.
     It is part of the public contract: it goes into reports, renaming it breaks stored
     runs and requires an ADR.
   - `description` — what exactly it detects, in one phrase.
   - `severity` — from `Severity`.
   - `standards` — a list of `StandardRef`. Fill it in right away, even if Module 2 has not
     started: a mapping added later drifts away from the code.
   - `run(context)` — **synchronous and pure**. No network, no file system, no `Date.now()`,
     no randomness. Only `context.matrix`.

2. Put only scalars into a finding's `evidence`, and only non-confidential ones: statuses,
   flags, endpoint and account identifiers. Response bodies and authorization headers —
   never.

3. A fixture in `tests/fixtures`: a set of observations on which the check must fire,
   and a set on which it must stay silent. The second matters more than the first — false
   positives make the tool worthless.

4. A test: it fires, it does not fire, an edge case.

5. Registration where the registry is assembled. Check that the `id` is not taken — a repeat
   registration throws `DuplicateCheckIdError`.

## Check before committing

- `run` reaches for nothing outside its argument.
- The test for the absence of a false positive exists.
- `standards` is filled in.
- `pnpm run check` passes.

---
name: new-adr
description: Create the next ADR by number in docs/adr from the template. Use when a non-trivial architectural decision has been made, a package chosen or a security invariant changed.
---

**DRAFT — not active. Review and move by hand.**

# New ADR

## Steps

1. Work out the next number: `ls docs/adr | sort | tail -1`.
2. Copy `docs/adr/0000-template.md` to `docs/adr/NNNN-short-title.md`.
3. Fill in: status, date, context, decision, alternatives, consequences.

## What to write

**Context** — the facts and constraints that forced a decision. Not a retelling of the obvious.

**Decision** — what was decided, one or two paragraphs. Specific versions and settings, if they
are part of the decision.

**Alternatives** — what was rejected and why. The phrasing "we considered X, rejected it
because Y" is worth more than a list of options.

**Consequences** — what this gives and what we pay for it. Required: under what conditions
the decision should be revisited.

## When an ADR is mandatory

- Weakening any security invariant from CLAUDE.md.
- Changing `SAFE_METHODS`.
- Allowing lifecycle scripts for a package (`allowBuilds`).
- Lowering `minimumReleaseAge`.
- Renaming the `id` of an existing check.
- Changing a key package or build tool.

# 0003. Checks as plugins through a registry

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Module 1 finds privilege escalation, BOLA/IDOR and cross-tenant leaks. Module 2 is the
evidence pack, where the same checks and new ones have to be mapped onto clauses of
external standards. If the detectors are hardcoded into the pipeline, Module 2 will demand
a rewrite of the core, and the mapping onto standards will spread out into a separate table
that drifts out of sync with the code.

## Decision

One `Check` interface: `id`, `description`, `severity`, `standards`, `run(context)`. The
`CheckRegistry` registers checks and hands them out by `id`; registering the same `id`
twice is a `DuplicateCheckIdError`, not a silent overwrite.

The mapping onto external standards (`StandardRef`) is declared in the check itself.
Module 2 is added by registering new checks and reading their `standards`, not by changing
the core.

A finding (`Finding`) carries `evidence` — a dictionary of scalars. Response bodies and
authorization headers do not get in there.

## Alternatives

- **Hardcode the set of detectors:** faster at the start, but Module 2 then becomes a
  rewrite.
- **A separate mapping file, "check → clause of a standard":** convenient to read as a
  whole, but it diverges from the code on any rename of an `id`.
- **Auto-loading checks from a directory:** less manual registration, but implicit side
  effects on import and no way to assemble a registry for a particular run.

## Consequences

A new check is a new file plus one line of registration; the core does not change. A
registry can be assembled for a particular run, and `DuplicateCheckIdError` keeps coverage
from being lost when checks are copied.

The price: an `id` becomes part of the public contract — renaming one breaks stored reports
and mappings, so it changes only through an ADR.

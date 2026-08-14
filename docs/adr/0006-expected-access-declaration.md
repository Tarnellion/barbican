# 0006. The expected matrix is declared, not derived from the specification

- **Status:** accepted
- **Date:** 2026-08-11

## Context

The tool compares actual access against expected access. The expected has to come from
somewhere. Three sources were considered: a human declaration, derivation from the
specification of the API under test, and a combination of the two. The decision determines
the input format, so it is made before the core is written.

## Decision

The expected matrix is **declared by a human** in a separate document and is an input to
the tool on the same footing as the list of endpoints and accounts.

The model of the declaration:

- `fallback` — the outcome for pairs covered by no rule. Declared **explicitly**, with no
  default value: a silent "everything is allowed" and a silent "everything is denied" are
  equally dangerous when the verdict about a vulnerability depends on it.
- `rules` — a list of rules, each mapping roles and endpoints to an expected outcome.
- Conflict resolution: **the last rule that matched wins**. That makes it possible to set a
  broad rule and narrow it with later ones, which matches the way access policies are
  written in practice.

The expected outcome is binary — `allowed` or `denied`. The actual one is richer
(`not-found`, `error`), and reducing the actual to the expected is the job of the diff, not
of the declaration.

## Alternatives

**Derivation from the `security` sections of OpenAPI.** Rejected for two reasons. The
first: `security` describes **authentication** — which mechanism is needed to reach an
endpoint — not authorization by roles and tenants. The statement "role X may read endpoint
Y" is simply not there. The second, more fundamental: the specification is usually
generated from the same code we are checking. By deriving expectations from it, we would be
comparing an implementation against itself and would get a tool incapable of finding
anything but a discrepancy between the code and its own annotation.

**A combination: the spec as a draft, corrected by a human.** Tempting, but it inherits the
circular dependency: a generated draft looks authoritative, and a mistake in the
implementation that made it into the spec will most likely stay uncorrected in the
"reviewed" declaration.

**A full enumeration of the "role × endpoint" matrix.** Rejected: with a hundred endpoints
and five roles that is five hundred lines nobody will keep in agreement with reality.

## Consequences

The declaration is human work, and the tool is useless without it. That is a deliberate
price: it is also what makes the tool able to find discrepancies between **intent** and
implementation rather than between an implementation and its own reflection.

The declaration becomes an artifact in its own right: it can be reviewed, versioned and
discussed separately from the code. For Module 2 it is exactly the document the evidence
pack rests on.

Revisit if a source of intent appears that is independent of the code under test — a
machine-readable authorization policy, for instance, that is not generated from the
implementation.

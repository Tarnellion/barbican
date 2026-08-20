# 0034. What main carries beyond the release is written down as it lands

- **Status:** accepted
- **Date:** 2026-08-19

## Context

Three times in nine days the same shape cost something.

`v0.2.0` was tagged from a commit whose README still said "build from source
until `0.2.0` is published", so the npm page argued against the package it was
serving. A guard was written: the README must name the version being shipped and
must not describe it as unavailable.

`0.3.0` shipped three changes to the report — `defects[].kind` became
`defects[].kinds`, `findingsOmitted` appeared, `coverage.checksRun[]` gained a
`description` — and the section describing that version mentioned none of them.
The first is breaking for a reader of schema 2. All three were written down in
ADRs, which is not a place a consumer looks. The guard had nothing to say: it
reads the lines that mention the version, and those lines were fine.

On 19 August 2026 the third instance was found by an audit rather than by a
release. `package.json` said `0.4.0`, the tag `v0.4.0` had been cut twenty-one
commits earlier, and main carried three new startup refusals, a changed string in
`report.warnings[]`, and the fixes for a path that reached an endpoint the
configuration had excluded. Every one of them was fixed for a reader of the
repository and open for everyone running `npm install barbican`. Nothing said so,
and nothing could: to every guard in the repository a version equal to an
existing tag reads as released.

The common cause is not carelessness at tag time. It is that the description of
what changed was being **reconstructed** at tag time, from a log of twenty
commits, by the person who wrote them. That reconstruction failed twice.

## Decision

The difference between `main` and the newest tag is written where a consumer
reads it, as it lands: a `### Unreleased` section in README.md. The release
renames that section to `### What changed in <version>`.

Two machine checks, in `tests/docs/release-readme.test.ts` beside the three that
were already there:

- A change under `src/` or `schema/` since the newest `v*` tag requires an
  `### Unreleased` section with something under it. `docs/` and `polygon/` are
  not in the list: they change without changing what a consumer runs, and a guard
  that fires on a typo fix is one people learn to satisfy with an empty line.
- On a release commit — the one the tag `v<version>` points at — the section must
  be gone and `### What changed in <version>` must be present.

The guard needs tags and history, so the CI job that runs the tests checks out
with `fetch-depth: 0`. A shallow checkout would make every one of these
assertions pass by knowing nothing, which is the shape of guard this repository
keeps finding in its own CI.

**The version in `package.json` stays where it is between releases.** It names
the last version this tree shipped, and the release commit moves it.

## Alternatives

**Bump the version on the first commit after a release** — main would then always
declare a version nobody has published. It contradicts the guard written after
`v0.2.0`: the Install section names `package.json`'s version as "the current
release, and the one to install", and that sentence would be false for days at a
time. Making it true would take a second fact — the published version — kept
beside the first, and two facts about one thing drift. That is the failure this
whole tool is written against.

**A `-dev` or `-next` suffix on main.** Same objection, with the addition that
every reader of a report from a clone would see a version string no registry can
resolve.

**Changesets.** Vetted on 13 August and rejected: 40 transitive packages against
a lockfile of 256, for a changelog on a project whose version is moved by hand
every few days. Nothing about that arithmetic changed. The problem here was never
the tooling for assembling a changelog — it was that nobody wrote the entry.

**A CHANGELOG.md.** A second file that says what the README's "What changed"
sections already say, for a package whose npm page shows the README and not the
changelog. One place, and it is the one a consumer already reads.

## Consequences

A commit that changes `src/` or `schema/` after a release also writes a line in
the README, or CI fails with the list of changed files in the message. That is
the intended cost: the description is written by the person holding the change in
their head.

The release procedure gains one step, and it is in README's Releasing section:
rename the section, bump the version, tag.

This does not make `main` installable, and does not claim to. What it makes
visible is the difference — including, as of today, that the fixes for a run that
performs an undeclared write are on main and not on npm.

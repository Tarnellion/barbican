# 0049. The release gate answers for the tag, not only for the tree

- **Status:** accepted
- **Date:** 2026-08-21

## Context

The audit of 14 August found that a release ran a quarter of CI, and the cure was
that `release.yml` calls `ci.yml` whole rather than repeating parts of it. That
settled everything about the **tree**: a tag is linted, typechecked, tested,
scanned, verified against the oracle and packed exactly as a pull request is.

It settled nothing about the **tag**, and the audit of 20 August 2026 found why:
CI cannot be asked about a tag, because on a pull request there is none. Five
findings, all proven:

1. **The gate did not hold itself.** One step compared `GITHUB_REF_NAME` with
   `package.json`'s version. `tests/workflows/release-gate.test.ts` asserted the
   call to `ci.yml`, the `needs`, and the absence of CI's own commands — and
   named that step in nothing. Delete it and the whole suite stayed green. This
   is the fourth time this repository has found a guard of its own held by
   nothing.
2. **A tag did not have to point at `main`.** The trigger is the glob `v*`. A tag
   on a branch that never merged, or on a commit that a rebase left behind,
   publishes — with provenance attesting to a repository whose `main` never
   carried that code.
3. **A prerelease would have taken `latest`.** `v0.5.0-rc.1` matches `v*`, and
   `npm publish` with no `--tag` writes `latest`. A release candidate would
   become what `npm install barbican` hands out, for a tool that is pointed at
   other people's production with live credentials.
4. **The registry was asked last.** That a version was already published arrived
   as a 409 from npm, after four CI jobs, a build and a pack.
5. **The description of a release only had to exist.** ADR-0034 requires
   `### Unreleased` to carry a body of substance and the release to rename it to
   `### What changed in <version>`. The renamed section was asserted with
   `toContain` on the heading alone: rename, delete the paragraphs, tag — and
   `0.3.0` happens again, which was three breaking report changes shipped with
   nothing said about them anywhere a consumer reads.

## Decision

The release-only questions are functions in `tools/release-gate.mjs`, each
returning **the reason it refuses, or `undefined`**, and one step in the publish
job calls the script before anything is installed or built:

- `whyTagDisagrees` — the tag is `v<semver>` and names the version the package
  declares. The trigger is a glob and not a grammar; the grammar is here.
- `whyNotOnMain` — `git merge-base --is-ancestor` against `main`. A checkout with
  no `main` in it is a **refusal**, not a pass: an ancestry question asked of a
  one-commit history answers "I cannot see", and taking that as agreement is the
  shape of guard this repository keeps finding in its own CI. The publish job
  checks out with `fetch-depth: 0` for this.
- `distTagOf` — `latest` for a release, the prerelease's own first identifier for
  a prerelease, and a refusal when that identifier is not a word (`0.5.0-1` would
  give `--tag 1`) or is `latest` itself. `npm publish --tag` gets the result.
- `whyRegistryRefuses` — the version is not published, and a publish that takes
  `latest` is newer than every published release. The second rule is the one a
  409 does not cover: `latest` is what `npm install barbican` resolves to, so
  moving it backwards walks every new consumer back with it.
- `whyNotDescribed` — the README carries `### What changed in <version>` with a
  body over the same length `### Unreleased` has to reach, and no `### Unreleased`
  is left standing.

Two guards, and neither substitutes for the other. `tests/tools/release-gate.test.ts`
holds the answers — weaken a decision and it goes red. `tests/workflows/release-gate.test.ts`
holds the questions — delete the step, drop `--tag`, or shallow the checkout, and
it goes red. **Removing a protection has to fail the suite**; that property is
what finding 1 was about, and it is the point of splitting the guards this way.

`whyNotDescribed` has one implementation and two callers: this script and
`tests/docs/release-readme.test.ts`. The rule about describing a release is then
enforced both by the test suite and by the release itself, and cannot drift
between them — a test in the suite is deleted by whoever finds it inconvenient,
and a step in the gate is not.

Two smaller decisions:

**`publishConfig.tag` is `unreviewed`.** It is what npm uses when `--tag` is
absent, and left unset that is `latest`. The gate passes the real channel
explicitly on every run, so this value is only ever the value of a mistake — and
a mistake that lands on a channel nobody installs from is a version to deprecate,
where the same mistake landing on `latest` is an incident. Seeing
`unreviewed: 0.5.0` in `npm dist-tag ls` says exactly what went wrong.

**The registry is read with `fetch`, not with `npm view`.**
`tests/workflows/portable-gate.test.ts` refuses a spawn of `npm` by name, because
npm installs its launchers on Windows as `.cmd` shims that libuv will not
resolve. `fetch` needs no executable at all, and it separates the two answers
that matter — a 404, which is a package nobody has published and must be
allowed to be a first release, from a failure, which must never read as an empty
registry.

## Alternatives

**Leave the checks as shell in the workflow.** That was the state, and finding 1
is what it costs: the only thing a test can assert about a shell snippet is its
text, and asserting on text is one rename away from asserting on a comment. A
function has a behaviour to put a case to.

**Tighten the trigger to `v[0-9]*.[0-9]*.[0-9]*`.** It would stop finding 3 by
making a release candidate unreleasable rather than correctly channelled, and it
would not stop it cleanly anyway: a glob is not a grammar, and `v1.2.3.4` matches
that one. The grammar belongs where a refusal can carry a sentence explaining
itself.

**Rely on npm's 409, and on a GitHub ruleset for the tag.** Both move the answer
out of the repository. The 409 arrives after the whole gate has run and says
nothing about `latest` moving backwards. A ruleset requiring tags on `main` is a
setting in a web interface: unversioned, invisible in a clone, and untestable —
the same objection as "the branch is protected, so it is fine".

**A semver dependency.** A package, its transitive tree and a cooldown wait, for
a comparison this needs in twenty lines and calls five times per release. The
project's rule is to minimise aggressively and to vet what is added; the two
cases a hand-rolled comparison gets wrong — `0.10.0` against `0.9.0`, and a
prerelease against its release — are pinned in the unit tests instead.

**A `release` job that only prints warnings.** Rejected on the same grounds as
every other soft gate here: a check that does not stop the thing it checks is a
sentence, and this repository has a file of sentences that turned out to be
false.

## Consequences

The release procedure keeps its shape — rename the section, move the version,
tag — and gains one refusal it can hit before anything is built. The cost is one
HTTPS request to the registry and a `git fetch` of `main` per release.

A prerelease becomes a real option rather than a hazard: `v0.5.0-rc.1` publishes
under `rc`, and `npm install barbican` still gives the stable release. A patch on
an older line now needs a dist-tag of its own, and the refusal says so.

If the registry cannot be reached, the release refuses. That is deliberate: the
alternative is a gate whose verdict depends on whether npm was up, which is a
gate that goes green on a bad morning.

Revisit when the project has more than one maintainer, or more than one supported
release line: the `latest` rule assumes releases move forward in one line, and a
maintained `0.4.x` alongside `0.5.x` would want a rule per line rather than one
for the package.

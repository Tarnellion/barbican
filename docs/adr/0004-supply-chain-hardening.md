# 0004. Supply chain hardening

- **Status:** accepted
- **Date:** 2026-08-11

## Context

The main risk to the project is not a CVE in the code of a dependency but a compromise of
the npm supply chain: takeover of maintainer accounts and malicious lifecycle scripts. The
incidents of 2025–2026 (chalk/debug, Shai-Hulud 1.0 and 2.0, Glassworm) showed a common
pattern: malicious versions live in the registry for hours, are published under a trusted
name, and run on `preinstall`/`postinstall`, including in CI.

The tool is meant to be run against client environments and works with access secrets — the
cost of a compromised build environment is higher here than usual.

## Decision

Four independent layers, fixed in `pnpm-workspace.yaml` and `.npmrc`:

1. **Cooldown.** `minimumReleaseAge: 10080` — do not install versions younger than 7 days.
   Compromised versions are usually withdrawn within hours, so a week-long delay intercepts
   the main class of attacks. Emergency patches are let in one at a time through
   `minimumReleaseAgeExclude`.
2. **Lifecycle scripts forbidden.** `strictDepBuilds: true` with an empty `allowBuilds`:
   installation fails if a dependency has build scripts, and demands an explicit decision.
   `lefthook` was examined separately — its `postinstall` only runs `lefthook install` and
   does not touch the network, so instead of allowing the script the same step was moved
   into an explicit `pnpm run hooks:install` command.
3. **Deterministic installation.** The lockfile in the repository, `--frozen-lockfile` in CI.
4. **Exact versions.** `save-exact` and `savePrefix: ''` — ranges get around the intent of
   the lockfile on re-resolution.

gitleaks is installed system-wide (Homebrew) rather than as an npm package: the npm
wrappers download the binary in `postinstall`, that is, they reproduce exactly the vector
layer 2 protects against. If gitleaks is not installed, pre-commit fails — secret scanning
must not be skipped silently.

Minimizing dependencies is part of the same defence: every transitive dependency widens the
trust boundary. A new package is added only after checking the age of the release, the
number of maintainers, the size of the transitive set and the presence of provenance.

## Alternatives

- **Only `npm audit` and Dependabot:** they catch known CVEs, but not a fresh malicious
  version of a trusted package — and that is the main vector.
- **The default pnpm 11 cooldown (1 day):** better than nothing, but a week-long window
  covers the time between publication and withdrawal more reliably.
- **Allow `lefthook` to run `postinstall`:** one command more convenient, at the price of
  the first exception in the policy, which then becomes a precedent.

## Consequences

`pnpm` will not install the freshest versions — at the start, for instance, Biome 2.5.8 and
2.5.7 were cut off and 2.5.6 was installed. That is expected behaviour, not a failure.

Installation requires an external step (`brew install gitleaks`) and an explicit
`pnpm run hooks:install`. In exchange, the project has not a single package with the right
to run lifecycle scripts.

Revisit if: the cooldown starts blocking a critical security patch (use
`minimumReleaseAgeExclude` for that one case rather than lowering the threshold globally).

## Addendum of 2026-08-13: provenance is back, publishing moves to CI

The entry below describes a state that no longer exists and is kept as the history of the
decision — not as a description of today.

`publishConfig.provenance: true` is back in `package.json`, and publishing has been moved
to npm trusted publishing: the release is done by `.github/workflows/release.yml` on a
`v*` tag, npm credentials are issued over OIDC, they live for minutes, and there is not a
single long-lived token in the repository secrets. The npm >= 11.5.1 requirement is met —
11.19.0 locally, and in the release the version is pinned explicitly.

Three things that follow from this and are easy to forget:

- **Publishing by hand from a laptop no longer works.** That is not a side effect but the
  goal: provenance is unreachable without a CI witness, which means publishing around the
  release is not allowed either. If you need to get around it, take the flag off
  deliberately first.
- **Configuration on the npmjs.com side is mandatory.** Until the package has declared a
  trusted publisher (the repository and the workflow name), the release will fail at the
  publish step. That is the right side to fail on: not publishing is safer than publishing
  without provenance.
- **The tag must match the version in `package.json`** — checked by a separate step before
  publishing. Otherwise what goes to the registry is not what is marked in the history.

## Addendum of 2026-08-11: provenance is off right now

The layers described above are in force. But one declared element of the defence **does not
work**, and it is more honest to write that here than to leave the ADR as a description of
what was wished for.

`publishConfig.provenance: true` has been removed from `package.json`. Provenance is a
signature tying a published package to a particular commit and build; it relies on an OIDC
token issued by CI. From a local machine there is no such witness, and publishing with the
flag is simply impossible. The name `barbican` was claimed by hand from a laptop, so the
flag had to come off.

The practical consequence: versions published by hand have no checkable link to the
repository. Against exactly the attack this ADR is about — publishing a malicious version
with a stolen token — this particular layer does not protect right now.

The return is planned for phase 4 together with the move to npm trusted publishing, where
provenance is generated automatically and long-lived tokens are not needed at all. The task
is recorded in `tasks.md`. Until then, publishing by hand is a knowingly accepted risk, not
an oversight.

Secret scanning in CI is a separate decision — see
[ADR-0007](0007-secret-scanning-in-ci.md).

## Addendum of 2026-08-16: two settings that were off, and a pin nobody would revisit

**`.npmrc` was dead and is gone.** It carried `engine-strict=true` and
`save-exact=true`, and under pnpm 11 that file is read for authentication and the
registry only — every other setting has to be in `pnpm-workspace.yaml` under a
camelCase key. So the engine guard had been off since the upgrade to 11 and
nothing said so. `savePrefix: ''` already covered the second one, which is why
only `engineStrict: true` moved.

Measured rather than argued: in an isolated package with `engines.node` set to
`>=99`, `pnpm install` refuses when the setting is in `pnpm-workspace.yaml` and
answers "Already up to date" when it is in `.npmrc`.

**`packageManager` carries a corepack integrity hash.** It was
`pnpm@11.20.0` — a version and nothing to verify it against, the one gap in a
scheme where every action is pinned by commit SHA and both CI binaries by
sha256. Written by `corepack use`, not by hand.

**The osv-scanner pin now states when to raise it.** It sat at v2.4.0 behind a
note saying v2.5.0 "came out a week ago"; by the time anyone read that, it had
been true for two months. No dependabot ecosystem covers a binary fetched by
URL — there is no such ecosystem, which is why the actions were rejected here in
the first place — so nothing will announce a new release. The pin therefore
carries its own condition, exactly as the `overrides` entries and the
`osv-scanner.toml` exceptions do: raise it whenever a release is more than seven
days old, which is the same cooldown `minimumReleaseAge` applies to everything
else. It is at v2.5.0 now; v2.5.1 was published the same day this was written and
is younger than the cooldown allows.

**`pnpm audit` runs in CI.** ADR-0004 declares two layers of vulnerability
scanning and only one ran — not in CI, not in the hooks. They read different
databases: osv-scanner reads OSV, `pnpm audit` reads the npm advisory database,
and an advisory reaches one before the other.

**Vetting results are written down** in `docs/dependencies.md`. The rule above
names four figures to check before adding a package, and they were checked and
recorded nowhere, so the rule could not be audited after the fact — a habit
rather than a rule. A package with no row in that file has not been vetted,
whatever anybody remembers.

Found by the audit of 14 August 2026 (F-3, F-5, F-6, F-7, F-9).

## Addendum of 2026-08-18: the cooldown holds versions nothing reports

`minimumReleaseAge` works. What was missing is any way to see it working, and
the two commands one would reach for say the opposite of what they mean.

`pnpm update` prints "Lockfile passes supply-chain policies" and "Already up to
date". That is true and it is not an answer: this project pins exact versions,
so nothing is ever in range for `update` to move, and the sentence reads as an
all-clear whatever is actually behind. On the day this was written three direct
dependencies had newer versions.

`pnpm outdated` is the worse of the two, because it looks like the answer.
It reports the newest version the cooldown **allows**, not the newest published:
it named `@biomejs/biome` 2.5.8 while 2.5.9 existed and was four days old, and
with the window widened to 41 days as an experiment `@types/node` changed from
"26.2.0 available" to "26.1.0 available" while the two packages whose only newer
versions fell inside the window disappeared from the list entirely. So the tool
that exists to say what is behind is precisely the one that hides what a cooldown
is holding.

Neither is a defect in pnpm — both answer the question they were asked. But the
consequence for this policy is that "nothing to update" and "held for six more
days" were indistinguishable from the outside, which is the class of silence this
project is written against.

`pnpm run deps:behind` answers it: for every direct dependency, the version
pinned here against `dist-tags.latest` from the registry, and one of three
states — nothing newer, available, or held with the date the wait ends. It asks
the registry rather than reading `pnpm outdated`, for the reason above: a report
built on that source could never print the middle state, and a state that cannot
be reached is a comment rather than a state.

Deliberately not part of `pnpm run check`. It needs the network and it turns red
the day any maintainer publishes, and a gate that is red for something nobody is
expected to fix today is a gate people stop reading. The decision of when to take
an available update stays a person's.

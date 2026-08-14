---
name: dep-vetting
description: Vet an npm package before adding it to barbican — release age, maintainers, transitive dependencies, lifecycle scripts, provenance. Use always, before installing any new dependency.
---

**DRAFT — not active. Review and move by hand.**

# Vetting a package before installing

The main risk is not a CVE but a supply-chain compromise (ADR-0004). Vet
every package, including the "small and obvious" ones.

## Collect the data

```bash
npm view <pkg> version time.modified maintainers dependencies
npm view <pkg> time --json   # the date of a specific version
```

You need four numbers and one fact:

1. **The age of the version.** Younger than 7 days — do not install: `minimumReleaseAge` will not let you.
   For an urgent patch — a targeted entry in `minimumReleaseAgeExclude`, not a lowered threshold.
2. **The number of maintainers.** One maintainer is not a ban, but a reason to look closer.
3. **Transitive dependencies.** Count all of them, not only the direct ones. Each one widens
   the trust boundary. Zero-dependency is preferable, all else being equal.
4. **Lifecycle scripts.** If there is a `preinstall`/`postinstall`/`install` — read its code
   before installing. `strictDepBuilds` will stop the install and demand an explicit decision;
   the default decision is **not to allow it**, but to perform the needed action with an explicit command.
5. **Provenance.** An attestation is a plus; its absence is not a blocker in itself.

## Before adding — ask

Can the task be solved with Node's built-ins? If it can, the dependency is not needed.
Dropping the bundler in favour of `tsc` removed 17 transitive dependencies (ADR-0001) —
such forks in the road come up more often than it seems.

## Record it

The package, the version and the reasoning — in an ADR or in a session note. If the package is not
in the original technical report, agree on it separately.

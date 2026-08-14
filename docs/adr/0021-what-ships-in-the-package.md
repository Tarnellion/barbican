# 0021. What ships in the npm package

- **Status:** accepted
- **Date:** 2026-08-14

## Context

`files: ["dist"]` had been the whole answer since the first publish, and two
things came back from someone installing 0.2.0 cold and trying to use it from
the package alone.

The README is the package page on npm, and every relative link in it —
`docs/guide.md`, `examples/minimal/`, `polygon/` — resolves against the GitHub
repository when npm renders it and against nothing at all once the package is
installed. The tarball contained no configuration example of any kind, so the
one thing a new user needs first, a whole valid config file to copy, was
reachable only by leaving the package.

Separately, the tagged commit for `v0.2.0` carried a README that still said
"build from source until `0.2.0` is published". npm shows the README of the
tagged commit, so the page for 0.2.0 talked readers out of installing 0.2.0.
That is a release-process defect rather than a packaging one, but it surfaced
in the same reading and belongs with it.

## Decision

`files` becomes `["dist", "docs", "examples"]`. Both are text, together they add
about 300 KB unpacked, and they make the guide and a working template available
without a network round trip — the guide in particular is what someone reaches
for after the first validation error.

`polygon/` stays out. It is a deliberately vulnerable HTTP server, and shipping
it would place one in the `node_modules` of everyone who installs barbican,
including transitively. It binds loopback and only runs when invoked by hand,
which makes the risk small rather than absent; the benefit — being able to run
`node polygon/verify.mjs` without a clone — does not pay for a vulnerable server
distributed by default in a security tool. The README now says the polygon comes
with a clone and shows the clone.

The version-in-the-README failure is closed by a test rather than by care:
`tests/docs/release-readme.test.ts` asserts that the README names the version in
`package.json` and does not describe that version as unavailable.

## Alternatives

**Ship everything, `polygon/` included.** It makes every path in the README true
after `npm i`, which is the tidiest possible story. Rejected on the vulnerable
server alone; no wording in a README removes it from an installed tree.

**Ship nothing but `dist` and drop the links.** A package page with no links to
a guide is honest and useless. The links are not the problem — their being dead
inside the tarball is.

**Generate a `docs/` subset at pack time.** Solves a size problem this package
does not have, at the cost of a build step whose output nobody reviews.

**Guard the release README by checking the tarball in CI.** A tarball-level diff
against the repository would catch more, but the failure that actually happened
is entirely visible in the working tree: the README described an unpublished
version. A unit test catches it at the commit that introduces it rather than at
the release, which is earlier and cheaper.

## Consequences

The package roughly doubles in size, from 140 KB packed to 242 KB. That is
uninteresting for a development-time CLI.

`docs/` is now published, which makes ADR text part of the distributed artifact.
It is already public, and having the reasoning travel with the tool is the point
of writing it down.

The README now describes two different starting points — an install and a clone —
and must keep saying which is which. The `examples/` path in the CLI invocation
is written for a clone; the sentence after it says where the same files live
after an install.

Revisit if the polygon grows a variant that is safe by construction (a recorded
transcript rather than a server), or if `docs/` grows past a size where shipping
it stops being free — a few megabytes, not a few hundred kilobytes.

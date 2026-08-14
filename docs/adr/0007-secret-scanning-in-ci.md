# 0007. Secret scanning in CI without a third-party action

- **Status:** accepted
- **Date:** 2026-08-11

## Context

The pre-commit hook catches secrets before a commit, but it is bypassed with `--no-verify`,
so CI needs a second layer over the full history. `gitleaks/gitleaks-action`, pinned by
SHA, was taken for that at first.

It failed on the very first push. The reason is not a licensing one — the log says outright
`[Tarnellion] is an individual user. No license key is required.` The action computes a
commit range of the form `<first>^..<last>` and passes it to `git log`. The first commit of
a repository has no parent, `git log` writes to stderr, and the scan breaks off with
`failed to scan Git repository error="stderr is not empty"`.

Something more unpleasant came out along the way: the action downloads its own version of
gitleaks — 8.24.3, while pre-commit uses 8.30.1 installed through Homebrew. Two layers of
defence would be handing down verdicts from different versions with different rule sets.

## Decision

The binary is installed in CI directly: download the release from GitHub and **check the
pinned SHA-256** before unpacking. The version and the checksum are set by variables in
`ci.yml` (`GITLEAKS_VERSION`, `GITLEAKS_SHA256`) and match the local version.

The full history is scanned (`fetch-depth: 0`) with the same command as in the hook:
`gitleaks git --redact --no-banner .`. No computing of ranges — on a full clone it is not
needed, and it was exactly what caused the breakage.

Downloading a binary from the network is an attack vector in itself, so the checksum check
here is not a formality but a mandatory condition: without it the step would contradict
[ADR-0004](0004-supply-chain-hardening.md).

## Alternatives

- **Keep the action and work around the breakage** — for example, run it only on a
  schedule, where it does a full scan. Rejected: the version mismatch does not go away, and
  the action's behaviour depends on the type of event, which makes the defence
  unpredictable.
- **The official Docker image by digest.** It gives the same immutability as a checksum, but
  adds running a container for the sake of one command.
- **Drop scanning in CI** and rely on pre-commit. Rejected: the local hook is bypassed with
  a single flag, and that is exactly what CI insures against.

## Consequences

A third-party action has left the trust boundary — only `actions/checkout` and
`actions/setup-node` remain in the workflow, both pinned by SHA.

The price: the version and the checksum have to be updated by hand whenever the local
gitleaks is updated. The task is recorded in `tasks.md`; if the versions diverge, CI and
pre-commit will start judging differently again, and that will be a silent degradation, not
an explicit error.

Revisit if an official way appears to run gitleaks in CI with exactly the same version as
the one installed locally, without manual syncing.

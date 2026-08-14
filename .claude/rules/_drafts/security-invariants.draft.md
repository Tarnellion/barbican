---
name: security-invariants
description: barbican's security invariants, which must not be weakened along the way.
---

**DRAFT — not active. Review and move by hand.**

# Security invariants

The full text and the reasoning are in CLAUDE.md and ADR-0005. What is here is what is easy
to break unnoticed while caught up in a task.

## Do not weaken without an ADR

- **`SAFE_METHODS`.** Without `--unsafe-methods`, GET and HEAD only. Adding a method to
  the constant changes the default behaviour on someone else's deployment.
- **The absence of a body in `HttpResponse`.** This is not a forgotten field. Adding a body "to make
  debugging easier" means making the report file a carrier of PII. With ADR-0011 the body
  is read in transit for the sake of scalars, but it is still not stored: the guarantee rests
  on `SignalValue` being a number or a boolean only. A string variant holds the whole body,
  so extending this type requires an ADR of its own.
- **External `$ref` resolution stays off.** Neither http nor the file system. Turning it on
  makes spec parsing an SSRF primitive. Do not delete the proving tests and
  do not mark them `skip`.
- **Throttling.** A port, not an option. There must be no "no limits" mode.
- **A mandatory scope.** Without a host allowlist the tool refuses to work.
  Do not introduce a default "allow everything".
- **`minimumReleaseAge`, `strictDepBuilds`, the empty `allowBuilds`.** An install that failed
  because of a lifecycle script is not an obstacle but the protection firing. The right reaction is
  to read the script and perform the needed action with an explicit command, not to add the package
  to the allowlist.

## Always

- Redaction paths for sensitive data are hardcoded only, never from user input.
- Secrets only through environment variables. Not into the repository, not into the logs, not into the reports.
- A new dependency only after vetting (see the `dep-vetting` draft).

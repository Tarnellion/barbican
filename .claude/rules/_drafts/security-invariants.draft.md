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
- **The address grammar.** `isAddressablePath` in `src/io/untrusted.ts`, applied in
  `joinUrl` — the seam where the address is built, which is what makes it cover the
  library door as well as the three adapters. Do not move the check back into the
  sources, and do not "normalise" a backslash or a control character instead of
  refusing it: the URL parser reads those differently than a split on `/` does,
  and modelling its normalisation is how the first version was wrong (ADR-0032).
- **The identifier grammar.** `identifier` in `src/core/identifiers.ts`, applied in
  `joinKey` — the seam where a key is built — and at the eight doors that name
  the field and the file. It refuses the C0 controls, DEL, the C1 controls, the two
  Unicode line separators and the empty string. Do not narrow it to the NUL: that
  makes the sentence in `keys.ts` true by naming one character, and only until the
  separator moves. Do not escape one of these on the way to a terminal or into the
  report instead of refusing it — escaping is modelling somebody else's terminal,
  and it leaves the tool holding an id it can never print back (ADR-0066).
- **A canary per account.** Every account with a `tokenEnv` needs one that passed, or
  the run exits 2. Weakening this to "the run has a canary" is exactly the state
  ADR-0033 was written from: an account with a dead token, denied everywhere by the
  policy, reads as tested and clean.
- **`minimumReleaseAge`, `strictDepBuilds`, an `allowBuilds` that permits nothing.** It is not
  an empty map: it holds `lefthook: false`, an explicit refusal with the reasoning beside it,
  and the effect is the same. An install that failed
  because of a lifecycle script is not an obstacle but the protection firing. The right reaction is
  to read the script and perform the needed action with an explicit command, not to add the package
  to the allowlist.

## Always

- Redaction paths for sensitive data are hardcoded only, never from user input.
- Secrets only through environment variables. Not into the repository, not into the logs, not into the reports.
- A new dependency only after vetting (see the `dep-vetting` draft).

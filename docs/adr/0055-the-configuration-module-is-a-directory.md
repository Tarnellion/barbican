# 0055. The configuration module is a directory

- **Status:** accepted
- **Date:** 2026-08-23

## Context

`src/io/config.ts` had grown to 2832 lines and was doing seven separable things:
the zod schema, the guards on the document itself, the published types and the
ties that hold them to the schema, the three tables that keep a request
attribute from replacing the substance of the request, the resolution of secrets
out of the environment, the conversion of a validated document into a
`RunConfig`, and the reference checks that only the parsed endpoint list can
answer.

Two constraints shaped where the cuts could go.

**The file is a published surface.** `src/index.ts` re-exports it in full, and
`docs/library.md` states the counts. Any split had to leave the same 58 names
leaving `src/io/config.js` and no import in the repository changed.

**No shipped declaration may name a package.** The CI job "No dependency in the
published types" reads `dist` for a non-relative import in a `.d.ts`; it exists
because `configSchema` was once exported and put 100 lines of `z.ZodObject<…>`
into `config.d.ts` (the audit of 14 August 2026, E-6). A zod-inferred type
therefore cannot cross a module boundary, which decides one of the seams by
itself.

## Decision

**`src/io/config.ts` stays, as a barrel of explicit named re-exports**, and the
seven modules live in `src/io/config/`. Explicit rather than `export *`: the
modules export more than the package does — a shape one hands to another — and a
star would publish all of it.

The cut is by the question each module answers.

- **`types.ts`** — the shapes a configuration is read into and the ones a
  consumer names. Types only, no runtime import.
- **`schema.ts`** — what a configuration may say, and what stops a file before
  anyone believes it: the size and depth limits, the `__proto__` guard, the zod
  schema, the JSON Schema an editor completes from. **The only module that names
  zod**, and it hands nothing zod-shaped out.
- **`basis.ts`** — the rule of ADR-0019 and ADR-0037 with its three tables. It
  was already one subject spread over four places in the file.
- **`environment.ts`** — the two values that live in the environment and nowhere
  else: an account's token and an attribute declared `{ env: NAME }`.
- **`contexts.ts`** — request conditions from the declaration to the matrix rows
  they add. `toAccounts` is here because the rows it adds are the conditions'
  doing.
- **`references.ts`** — the checks that need the endpoint list. The old file
  already drew this line in prose: "here rather than beside the duplicate-name
  check in `assertReferencesResolve`: this one needs nothing but the
  configuration".
- **`parse.ts`** — the document becomes a `RunConfig`. Everything answerable
  from the file alone, at the one gate a library consumer cannot walk past.

**The boundary out of `schema.ts` is a hand-written type.**
`parseConfigDocument` returns `DeclaredConfig` from `types.ts`, not
`z.infer<typeof configSchema>`. This is the CI rule about the package's own edge,
applied one level in — and it cost three shapes that had to be written down and
tied: `DeclaredConfig`, `DeclaredResource`, `DeclaredTenant`. Two of them nothing
had tied before, so the tie discipline B-11 introduced now covers the whole
document rather than five sections of it.

## Alternatives

**Flat modules — `src/io/config-schema.ts` and so on.** Refused by
`tests/public-surface.test.ts`: it reads `src/io` and demands a line in
`src/index.ts` for every `.ts` file it finds. A subdirectory is invisible to that
read, which is the correct answer here — the modules are not the surface, the
barrel is.

**`export *` in the barrel.** Would publish `configSchema`'s neighbours,
`DeclaredContext` and the `FORBIDDEN_*` tables, and would grow the surface by
whatever the next cross-module helper turns out to be. The whole point of the E-6
finding is that nobody notices a name that leaves by accident.

**Keeping the schema and `parseRunConfig` together** to avoid writing
`DeclaredConfig` by hand. That is a 1400-line module holding the two largest and
least related things in the file, bought for eighty lines of type.

**Cutting by size into a dozen small modules.** Rejected on the rule this
repository already follows for its tables and its grammars: one place per
subject. Two modules of eighty lines with five functions travelling between them
are harder to read than one of three hundred.

## Consequences

**Nothing observable moved.** The same 58 names leave `src/io/config.js`; 227
runtime exports and 96 error classes, unchanged; `schema/barbican.run.schema.json`
byte-identical under `pnpm run schema`; the oracle 29 combinations, 0 mismatches,
with all 29 reports byte-identical once the runId, the timestamps, the durations
and the salted digests are normalised.

The one test that moved is `tests/docs/release-readme.test.ts`, and it moved for
the reason it exists: a change under `src/` since the newest tag owes a
description in README's `### Unreleased` (ADR-0034). It is red until that section
is written, which is the release owner's line to write and not this change's.

**Two deprecated zod calls went with the move.** `.refine(fn, { message })` at
two sites became `{ error }`, which is what zod 4's own typings say
(`@deprecated This parameter is deprecated. Use 'error' instead.`). Verified to
print the same bytes before the change was made, and the messages are asserted
verbatim by tests. Nothing else in the module needed the migration: it composes
no schemas with `.extend()` or `.merge()`, so zod 4's advice to spread `.shape`
instead has no site here.

**A comment that had drifted was put back.** The JSDoc for `parseRunConfig` sat
above `UncarriableKeyError`, twelve hundred lines from the function it describes;
the split sent the two to different modules and the comment went with its
subject. Three other comments of the same kind — for `ReservedSignalNameError`,
`FORBIDDEN_QUERY_KEYS` and `RequestContextConfig` — landed in the same module as
the declaration they were glued to, and were left exactly as they were: moving
them is a fix, and a fix does not belong in a move.

**The next thing to revisit** is `parse.ts`, which was 659 lines at `b75afa8`.
Nineteen of its error classes are one paragraph each, and the argument for
splitting them off is that they are read in the terminal rather than in the file.
The argument against is that an error that fires where nobody can see the reason
is exactly what this repository keeps finding, and the reason is in the class.

> **Note, 23 August 2026, corrected 26 August 2026.** This split distributed some
> of the error classes to the modules that throw them — five to `schema.ts`, five
> to `environment.ts`, four each to `contexts.ts`, `references.ts` and `basis.ts`.
> Whether nineteen paragraphs of error prose want a module of their own is now a
> question about those modules as much as about this one, and nobody has asked it.
>
> Two things this note said until the second date were wrong, and both are the
> subject of ADR-0075. It said the pointer above sends a reader to a file that
> "contains the string `Error` not once": at `bea20d6`, the commit this note was
> written in, `parse.ts` held sixteen exported error classes of its own and the
> string eighty-four times — a claim about the tree that was false on the day it
> was written, in the note whose whole purpose was correcting one. And the pointer
> above read "`parse.ts` at 660 lines", which the file was later that day and not
> at `b75afa8`, the commit this decision landed in. The decision stands; what was
> wrong was twice the prose around it.

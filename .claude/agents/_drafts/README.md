# Subagent drafts

**Not active.** To enable one, move the `.draft.md` into `.claude/agents/`
with a plain `.md` extension. The `_drafts` subdirectory is not scanned: our skill
drafts sit the same way and do not show up in the list of available ones.

The file format is YAML frontmatter plus a system prompt. The only required fields are
`name` and `description`; `description` decides when Claude delegates a task to
this agent. The full list of fields is in the
[documentation](https://code.claude.com/docs/en/sub-agents).

## What is here and why

| Agent | When to run | Proven on |
|---|---|---|
| `invariant-attacker` | before closing a phase, before publishing, after edits in the adapters | found 3 real breaks on 12 August 2026 |
| `polygon-recon` | before a run against a new polygon | VAmPI, crAPI |
| `port-implementer` | a new implementation of an existing port | `endpoint-list.ts` |

## What the first attempt taught

**A subagent's value is in the independence of its view, not in the volume of work.**
The author would have written the adapter implementation himself in comparable time.
But the breaks in the invariants were found precisely because the attacker did not
know the intent and did not treat comments as proof.

**There is mostly nothing to parallelize in the implementation.** The stages of work
on the core touch the same files; only the implementation behind a port is isolated.
Hence `port-implementer`, with an explicit ban on the wiring files.

**A worktree is created inside the repository**, in `.claude/worktrees/`. A copy of
`biome.json` there breaks the linter with a nested root config — the directory has been
added to `.gitignore`. Remove the worktree after merging:
`git worktree remove … --force && git branch -D worktree-agent-…`.

**Check an agent's work before merging it in.** Not "did the tests pass", but: did any
dependencies appear, were forbidden files touched, is there any `any` or `!`, does the
code reach for the network or the file system where it must not.

## About GitHub Actions

The official [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
can run a review on every PR. We are not taking it for this project yet: it requires
a long-lived key in the repository secrets, which conflicts with the premise of ADR-0004,
and a review on a solo project with one author and no incoming PRs brings little.
Revisit if external contributors appear.

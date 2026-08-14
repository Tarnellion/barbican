---
name: no-employer-sources
description: A hard boundary between this personal project and the employer's tools.
---

**DRAFT — not active. Review and move by hand.**

# No employer sources

`barbican` is a personal open-source project. It has nothing to do with the employer.

## Forbidden

MCP servers connected with the day job: do not read them, do not call them, do not refer to them.
The specific list is in `.claude/rules/_local/employer-mcp-servers.md`. That file
is deliberately not versioned: the repository is public, and the names of internal
tools have no place in it.

Nothing from there may end up in the repository — neither directly nor "in the same spirit":
code, configs, endpoint names, data structures, names of roles and permissions, tenant
schemas, requirement texts.

This applies as well to the cases where something there could be "just peeked at to go faster".
It cannot.

## When in doubt

If it is unclear whether a tool or a source is one of the forbidden ones — do not use it
and ask.

## Allowed

`context7` — for checking current library documentation. Use it actively:
do not write from memory what can be verified.

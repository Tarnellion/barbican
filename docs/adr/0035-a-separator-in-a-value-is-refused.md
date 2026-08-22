# 0035. A separator in a value is refused, not escaped

- **Status:** accepted
- **Date:** 2026-08-20

## Context

A resource declares the values a path template takes: `{playerId}` becomes
`1001`. `pathSegment` checks each value and escapes it with
`encodeURIComponent`, which turns `/` into `%2F` and `\` into `%5C`.

Three places in this repository said that escaping settled the question. The
test in `tests/io/untrusted.test.ts` put it plainly — "the slash is escaped, and
that was never the hole: the dot is" — and `isUsablePathSegment` refused exactly
three values: the empty string, `.` and `..`.

The audit of 20 August 2026 (A-2) showed the sentence is true only of a target
that reads its own path the way this tool does. `..%2F..%2Fadmin` is one segment
here. It is `../../admin` to Spring MVC with `UrlPathHelper.urlDecode` left at
its default, and to Tomcat with `ALLOW_ENCODED_SLASH` turned on: both decode
before they match a route. The request then reaches an endpoint the run never
named, past an exclusion list that works on ids, and the verdict for one
endpoint is computed from another one's answer.

The project had already decided this question in the other half of the same
rule. `isUsablePathTemplate` reads `%2e`, `%2f` and `%5c` and refuses them, with
the reason written beside it: the target decodes them, and the target is where
the navigation happens. The value grammar did not, so two halves of one rule
disagreed — the seam refused a template spelling that it accepted as a value.

## Decision

`isUsablePathSegment` refuses any value containing `/` or `\`, in addition to
the empty string, `.` and `..`. The cell fails with `UnusablePathValueError`
rather than being addressed.

The refusal is literal, on the raw declared value, and deliberately not on its
encoded form: the values reaching this function come from the configuration and
from a consumer of the library, and both hand over the characters themselves.

## Alternatives

**Escape and rely on the target.** What was in place. It requires knowing how
somebody else's router is configured, and getting it wrong is silent: the run
addresses a neighbour and reports the answer as the named endpoint's.

**Refuse only `..%2F` and its spellings.** Narrower, and it models the parser
again — the failure mode ADR-0032 was written from. A value that carries a
separator is one this tool cannot address predictably, whatever the segments
around it look like.

**Encode the separator twice** (`%252F`). The target then sees a literal `%2F`
in the path, which is not what the operator declared either. Silently changing
the value is worse than refusing it.

## Consequences

A hierarchical identifier can no longer be declared as one value:
`docs/report.pdf` for `/v1/files/{path}` is refused. Where the depth is fixed,
the template takes two parameters instead — `/v1/files/{dir}/{name}`. Where it
is not, that endpoint is out of reach of a resource declaration, and this ADR is
the record that it was traded for the guarantee that a declared cell addresses
the endpoint it names.

Three tests changed their assertion rather than their expectation, and the
sentence "the slash is escaped, and that was never the hole" is gone from the
repository. The two halves of the grammar now answer the same question the same
way, which is what ADR-0024 asks for in the first place.

Revisit if a legitimate platform is found whose identifiers carry separators and
whose router does not decode them before matching. The evidence needed is the
router's configuration, not the identifier.

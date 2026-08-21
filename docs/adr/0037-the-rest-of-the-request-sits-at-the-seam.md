# 0037. The rest of the request sits at the seam too

- **Status:** accepted
- **Date:** 2026-08-21

## Context

[ADR-0032](0032-the-grammar-sits-at-the-seam.md) moved one rule from the doors to
the seam: a path is checked in `joinUrl`, the single place an address is built,
so it covers a consumer of the library as well as the three adapters that read a
document. It moved that rule and no other.

Everything else a request carries stayed at the door.
`assertContextsCannotWrite`, `FORBIDDEN_CONTEXT_HEADERS`, `FORBIDDEN_QUERY_KEYS`
and the resource-key check are called from `src/cli.ts` and from inside
`src/io/config.ts`; `collectObservations` called none of them. The audit of
20 August 2026 walked through that door (A-1, A-1b, E-02, E-03) and put on the
wire, with `allowUnsafeMethods: false`:

    GET /v1/orders/42?_method=DELETE&api_key=SECRET-TOKEN-42
    x-http-method-override: DELETE

and, separately, `authorization: Bearer ADMIN-TOKEN` declared as a condition
attribute — which the run then presented instead of the account's own
credentials while the report named the original account.

The second one had a comment defending it. The attributes were spread **after**
the credentials, described as "the second line of the same defence, not a matter
of style". A later spread wins: the order was the substitution, not the defence.
The first line it leaned on — "that is checked when the configuration is parsed"
— is true of the configuration door and of no other.

## Decision

`assertAttributesKeepTheBasis` is exported from `src/io/config.ts`, beside the
tables it reads, and called in `collectObservations` for every request that
carries condition attributes: forbidden names by exact match and by family
prefix, forbidden query keys, and — unless the run was given
`--unsafe-methods` — any value that names a method that writes.

The merge order is reversed: attributes go in first, the tool's own credential
headers over them. A collision now loses to the tool rather than winning against
it, and that is structural — it needs no list of header names to be complete.

The door keeps its checks. It knows the context id, the declared authentication
schemes and the resource keys, so it fails earlier and says more; the seam says
less and says it for every door there will ever be. This is the same division
`isHeaderName`/`headerName` already uses.

## Alternatives

**Move the tables into a module of their own.** Correct if a third caller
appears. Two callers do not justify a third file, and the tables live where the
door's error types live; the seam imports them rather than copying them, which
is the property that matters.

**Check inside the HTTP client instead.** The client sees a finished
`HttpRequest` and cannot tell an attribute from a credential — exactly the
distinction both rules are about.

**Brand `ContextAttributes` the way `HeaderValue` is branded.** It would move
the check to compile time for TypeScript consumers and leave JavaScript ones
unguarded, and the run-time check would still be needed. Worth revisiting if
attributes grow a third source.

## Consequences

A consumer of the library now gets an exception where it used to get a request
on the wire. That is a behaviour change and it is the point: the four doors
answer the same way, and `writeMethodsProbed: false` in a report means what it
says whichever door the run came through.

The cost is a set lookup and a prefix scan over the attributes of one request,
next to a network call.

What is still on the door alone: the check that a condition does not rewrite a
key some resource already declares, which needs the resource list, and the
refusal of `{ env: NAME }` in a query, which needs the declaration rather than
the resolved value. Both are about the configuration as a whole rather than
about one request, and neither can be asked at the seam.

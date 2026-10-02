# 0077. What a check may be admitted to find

- **Status:** accepted
- **Date:** 2026-10-01

## Context

The check registry ([ADR-0003](0003-check-registry.md)) is an extension point,
and the first thing anybody asks of an extension point is how far it goes. The
question arrived in this form: could the library be widened to help find
penetration-style vulnerabilities in general? [ADR-0076](0076-a-permissive-cross-origin-policy-is-a-registered-check.md)
answered it for one class by building it, and it is the second check to read
something a status code cannot show. It did not say where the line is, and a
line left to be inferred from two examples is drawn again, differently, by every
reader.

The registry itself has no opinion. A `Check` is a function over a matrix, and
nothing in its type stops one from being written for any class of defect at all.
What stops a class is not the registry. It is the invariants the tool was built
to keep, because this tool is mechanically the same thing as a vulnerability
scanner ([ADR-0005](0005-tool-safety-invariants.md)) and is safe to point at
somebody else's deployment only because those invariants hold by construction.
So the question is not "what can a check be written to do" but "what can it be
written to do without taking one of them away".

Most of the classes people mean by penetration testing do take one away. They
fall into five groups, and each group breaks a different invariant.

## Decision

**A check is admitted when all four of these hold.** They are the conditions
under which a new class of defect is a registration and not a change to the
tool.

1. **It is a pure function over the matrix.** No network, no file system, no
   state. A check reads what a run already collected and never asks for more.
2. **It reads only what the invariants already let into an observation:** the
   status, response headers kept by the allowlist, and the scalar signals a
   human declared ([ADR-0011](0011-response-body-signals.md)). It does not widen
   what an observation carries in order to have something to judge. Adding a
   header to the allowlist is a reviewed decision with its own entry, as
   ADR-0076 did for two; adding a body or a string-valued signal is not
   available to a check at all.
3. **Every request it depends on is one the tool builds from what a human
   declared.** An operator asks a question by declaring a set of request
   conditions ([ADR-0019](0019-request-contexts.md)); the tool does not invent
   probes, and the address and headers remain the tool's to build
   ([ADR-0032](0032-the-grammar-sits-at-the-seam.md)). What the check reads is
   whatever those declared requests drew from the platform. Written first as
   "without the declaration the check examines nothing", which stopped being true
   the same day: `permissive-cors` reads every answered cell, the baseline
   included, and what an operator's declaration adds is the question of whether an
   origin was ever sent (ADR-0076, ADR-0078).
4. **Its verdict is conclusive from the response alone, or it says it cannot be.**
   A check that would have to guess whether a response is a defect does not
   report one. The reflected origin in ADR-0076 is the worked example: the case
   is real and out of reach, so the check stays silent about it and says why,
   rather than reporting what it cannot tell from a partner's allowlist.
   [ADR-0078](0078-an-origin-is-called-foreign-by-the-operator.md) is the other way to
   meet this condition for the same case: the verdict is conclusive once a human has
   declared the premise, which is what the expected-access policy already does for
   access.

Findings of an admitted check cite a clause, are counted in coverage the way the
isolation check's are, and are weighed by a severity the check declares once.

**The classes that are not admitted, and what each would take away.**

- **Injection of any kind** — SQL, command, template, XSS, SSRF payloads. A
  payload is content the tool would have to compose into the request, and the
  address and headers are the tool's to build from what a human declared, under
  a grammar applied at the one place an address is built
  ([ADR-0024](0024-strings-from-outside.md), [ADR-0032](0032-the-grammar-sits-at-the-seam.md)).
  A payload is not something a human declared. Seeing the result would usually
  mean reading the body too, and a body is kept only as the scalars a human
  named.
- **Brute force, enumeration at volume, and rate-limit testing.** Throttling is a
  port with no off state ([ADR-0005](0005-tool-safety-invariants.md),
  [ADR-0026](0026-the-rate-is-a-shape-not-only-a-count.md)), and a test whose
  whole point is volume is a request to remove it.
- **Fuzzing.** The verdict of this tool is a comparison against access a human
  declared ([ADR-0006](0006-expected-access-declaration.md)). A fuzzer has no
  declared expectation to compare against, which is the property that makes its
  output a list of anomalies and not a list of findings.
- **Writes and before-and-after state, including mass assignment.** Writes are
  off without an explicit flag, and a comparison of one account's state before
  and after a request is not a cell of the matrix, which is one account against
  one endpoint under one set of conditions ([ADR-0071](0071-an-identifier-from-a-body-is-not-worth-a-pool.md)).
- **Scanning response bodies for content.** The absence of a body in
  `HttpResponse` is what the ban on personal data in the report rests on.

**Forging a credential is not admitted by this decision, and is not ruled out for
all time.** A forged or stripped token — `alg: none`, a removed signature, a
foreign key identifier — is the tool constructing the credential, not reading a
response, which conditions 3 and 4 do not obviously cover, and a condition is
forbidden to replace the credentials a request is made with
([ADR-0019](0019-request-contexts.md)). It is a new kind of
door, and it needs its own ADR with its own account of how the credential is
built, where it can reach, and what it does to the per-account canary rule
([ADR-0033](0033-a-canary-is-per-account.md)). Until that ADR exists the answer
is no.

## Alternatives

- **Become a general scanner.** Rejected. It would give up, one class at a time,
  the properties that make the tool safe to run on a deployment its operator
  does not own, and it would arrive as a worse version of tools that already do
  the job. The honest answer for these classes is to point at them.
- **Stay with Module 1 only.** Rejected: ADR-0076 shows the registry carries a
  second class without touching the core, and a tool that declined every class
  its own registry could hold would be leaving the claim ADR-0003 makes unused.
- **Leave the boundary to review of each check.** Rejected. Review catches a
  check that breaks an invariant after it is written; stating the conditions
  catches the proposal before anyone writes it, and gives a contributor a
  sentence to quote rather than an argument to win.

## Consequences

- A proposal for a new check is read against four conditions, and a proposal
  that fails one is told which, and what would have to be decided first.
- The classes outside the line are named in the guide, so an operator is not
  left to discover them by a run that comes back clean and means less than it
  looks.
- The line is a statement about what a check may do, not a gate. Nothing in the
  tree reads a check's source and refuses one that breaks condition 3, and
  [ADR-0065](0065-what-a-source-scan-can-hold.md) is the reason to be sceptical of
  a scan that claimed to.

### Limits

- **Conditions 1 and 3 are held by the shape of the interface and by review, not
  by a test.** A check is handed a matrix and returns findings, so it has no
  network handle to misuse; a check written outside this repository and
  registered from code is outside any review this repository does, and the
  registry does not inspect it.
- **Condition 4 is a judgement.** What is conclusive from a response is argued
  case by case, and two people can reasonably disagree about a header. The
  mitigation is the one ADR-0076 used: the check states what it does not claim
  in its own description.
- **The list of excluded classes is a list of those considered.** A class absent
  from it is not thereby admitted; it is read against the four conditions.

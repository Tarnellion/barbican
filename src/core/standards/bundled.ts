/**
 * The standards this repository carries as data.
 *
 * All three are public documents, and all three were already in the tree as
 * prose: `docs/research/tenancy-models.md` section 6 is titled "Identifiers for
 * mapping findings" and tabulates exactly these clauses, with sources. No line
 * of code read it. That is the whole of what changes here — the identifiers stop
 * being a table a human consults and become a list something can iterate over,
 * which is the difference between "here is what we checked" and "here is what
 * nothing checked".
 *
 * ## What a clause carries, and what it does not
 *
 * An identifier, one line of our own, and the address of the published text.
 * Never the requirement's own wording. The repository is public and these
 * documents are distributed under their own terms; a summary written here is a
 * pointer, and `url` is mandatory so that the pointer resolves. Where the
 * paraphrase and the standard disagree, the standard is right.
 *
 * ## Why each catalogue is a subset, and why it says so
 *
 * None of the three is transcribed whole. ASVS 5.0 has seventeen chapters — not
 * the fourteen this comment and ADR-0043 both said until 24 August 2026 — and CWE has
 * no bottom at all; a catalogue that swallowed either would be a transcription
 * project, and one transcribed from memory would be worse than none. Each
 * definition states its own boundary in `scope`, and every row of
 * `findUnansweredClauses` carries that sentence, because "answered by nothing
 * here" read against an unstated boundary is a claim about the whole standard.
 *
 * ## What a clause says when nothing here answers it
 *
 * `unansweredBecause`, and it is filled on exactly the clauses `clauseAnswers`
 * finds neither a registered check nor the matrix channel citing. The note under
 * the CWE definition below is where that field came from: it said the two
 * weaknesses a status code cannot tell apart are worth standing here as clauses
 * nothing covers, and that "the reason belongs in the pack rather than in a
 * source comment nobody reading a report will see". It was in a source comment
 * for three days. `tests/invariants/a-clause-nothing-answers.test.ts` holds the
 * field and the derivation to agree in both directions. See ADR-0069.
 *
 * ## The paraphrases were checked against the published documents
 *
 * On 24 August 2026, clause by clause, against ASVS v5.0.0 chapter V8, the three
 * OWASP API 2023 entry pages and the five CWE definitions. Four ASVS
 * paraphrases said more or less than their requirement does and were narrowed;
 * what was found, and the two divergences left standing on purpose, are in
 * ADR-0069. A paraphrase that has not been checked against the published text is
 * worse than none, because it is the sentence a reader will quote.
 *
 * ## Adding one
 *
 * A public standard: another `StandardDefinition` below and a line in
 * `createBundledCatalog`. A standard whose numbering may not be published —
 * GLI-19, the AGCO requirements — is not added here at all. It is registered at
 * run time, from a source outside this repository, by whoever holds it and beside
 * the private checks that cite it. `StandardCatalog.register` is the same door
 * for both. See ADR-0043.
 */

import { StandardCatalog } from "./catalog.js";
import type { StandardDefinition } from "./types.js";

/**
 * The chapter page. Every clause below points at it rather than at an anchor
 * inside it: the anchors are generated from the headings and are not part of
 * what the standard publishes, so a guessed one is a link that quietly leads to
 * the top of the page — or, worse, reads as precision it does not have.
 */
const ASVS_V8 = "https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x17-V8-Authorization.md";

/**
 * OWASP ASVS 5.0, chapter V8 (Authorization).
 *
 * The first standard, and the choice was made for us three times over: it is
 * public, it is distributed under CC BY-SA, its numbering is stable across a
 * released version, and `identical-response-across-tenants` already cites 8.4.1.
 * `docs/research/coverage-model.md` reaches the same conclusion from the other
 * end — for isolating one brand from another "the anchor for mapping here will
 * be ASVS 8.4.1, not a gambling standard", because no licensing document
 * requires it.
 */
export const OWASP_ASVS_5_0: StandardDefinition = {
  id: "OWASP-ASVS-5.0",
  scope:
    "Eight of the thirteen requirements of chapter V8, Authorization: the rules " +
    "being declared, and access being restricted at the function, record and " +
    "field level. Not catalogued: 8.1.2 and 8.1.4 on what else the documentation " +
    "has to define, 8.2.4 on adaptive controls, 8.3.2 on a changed value taking " +
    "effect, and 8.4.2 on administrative interfaces. The other sixteen chapters " +
    "are outside this catalogue too, so a clause absent here is not thereby " +
    "absent from the standard.",
  clauses: [
    {
      id: "8.1.1",
      title:
        "The access rules are written down: which functions and which data a consumer may " +
        "reach, by its permissions and the resource's attributes.",
      url: ASVS_V8,
    },
    {
      id: "8.1.3",
      title:
        "The environment and context attributes a decision depends on are written down as well.",
      url: ASVS_V8,
      unansweredBecause:
        "Nothing here reads a platform's documentation. A run configuration declares the " +
        "condition sets the tool will try and compares their outcomes; a decision that turns " +
        "on an attribute nobody declared is invisible to it, which is the boundary ADR-0019 " +
        "drew when it refused to model the platform's decision logic.",
    },
    {
      id: "8.2.1",
      title: "Reaching an operation takes a permission granted for that operation.",
      url: ASVS_V8,
    },
    {
      id: "8.2.2",
      title: "Reaching one particular record takes a permission granted for that record.",
      url: ASVS_V8,
    },
    {
      id: "8.2.3",
      title: "Reading or writing one particular field takes a permission granted for that field.",
      url: ASVS_V8,
      unansweredBecause:
        "A field of a record is in the response body, and the body is deliberately not stored: " +
        "a signal is a number or a boolean, which is what the ban on personal data in the " +
        "report rests on (ADR-0011). Answering this clause means undoing that, and the trade " +
        "is not worth making.",
    },
    {
      id: "8.3.1",
      title:
        "The decision is enforced at a trusted service layer, not by anything an untrusted " +
        "consumer can manipulate.",
      url: ASVS_V8,
      unansweredBecause:
        "Which layer took a decision is not visible from outside. A probe sees the answer; a " +
        "platform that enforces on the server and one that enforces in the browser give the " +
        "same status code as long as the answers agree.",
    },
    {
      id: "8.3.3",
      title:
        "Access is decided by the originating subject's permissions, not by those of an " +
        "intermediary acting on their behalf.",
      url: ASVS_V8,
      unansweredBecause:
        "Nothing here declares one principal acting for another. An account under conditions " +
        "carries a `baseAccountId`, but that is the same principal with attributes added " +
        "(ADR-0019), not an intermediary carrying somebody else's rights, so the tool cannot " +
        "say which of two subjects a decision was taken for.",
    },
    {
      id: "8.4.1",
      title:
        "Cross-tenant controls keep one consumer's operations from affecting a tenant it has " +
        "no permission to interact with.",
      url: ASVS_V8,
    },
  ],
};

/**
 * OWASP API Security Top 10, 2023 edition.
 *
 * Three of the ten. The other seven are about rate limits, inventory,
 * consumption of third-party APIs and the rest — nothing this tool observes, and
 * carrying them would mean reporting seven permanent gaps that no check will
 * ever close because no check should.
 */
export const OWASP_API_2023: StandardDefinition = {
  id: "OWASP-API-2023",
  scope:
    "The three authorization entries of the 2023 Top 10. The other seven are " +
    "about other properties of an API and are deliberately not catalogued.",
  clauses: [
    {
      id: "API1",
      title:
        "Broken object level authorization: somebody else's record is reachable by naming its id.",
      url: "https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/",
    },
    {
      id: "API3",
      title:
        "Broken object property level authorization: a field of a record is readable or writable " +
        "when it should not be.",
      url: "https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/",
      unansweredBecause:
        "The same wall as ASVS 8.2.3. `identical-response-across-tenants` dropped this claim " +
        "because it knows nothing about fields — it compares a response as a whole — and " +
        "nothing else can take it up either: a property of an object is in the body, and the " +
        "body is not stored (ADR-0011). A check credited with a class of finding it cannot " +
        "find inflates the coverage of every pack built on it.",
    },
    {
      id: "API5",
      title:
        "Broken function level authorization: an operation meant for one group is reachable from " +
        "another.",
      url: "https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/",
    },
  ],
};

/**
 * CWE, the access-control weaknesses under 284.
 *
 * The hierarchy is 284 to 285 to {862, 863}, with 639 a child of 863 — checked
 * against the published definitions on 24 August 2026, where 284 is a Pillar and
 * the rest are Classes under it. All five are here although this tool can
 * honestly claim only one of them, and that is the point rather than an
 * oversight: `tenant-isolation.ts` says in a comment why it cites 285 and not
 * 862 or 863 — "from the outside 'there is no check' and 'there is a check but
 * it is wrong' give an indistinguishable answer" — and the four it cannot claim
 * are worth standing in the catalogue as clauses nothing answers. A gap that
 * exists for a reason is still a gap, and the reason belongs in the pack rather
 * than in a source comment nobody reading a report will see: since ADR-0069 each
 * of the four carries its own in `unansweredBecause`, and this comment is no
 * longer the only place it is written.
 */
export const CWE_ACCESS_CONTROL: StandardDefinition = {
  id: "CWE",
  scope:
    "The access-control weaknesses of the CWE-284 hierarchy. CWE is not " +
    "enumerable and is not enumerated here: an identifier outside that hierarchy " +
    "is absent by construction rather than by judgement.",
  clauses: [
    {
      id: "284",
      title:
        "Access to a resource is not restricted, or restricted wrongly. The pillar the rest hang " +
        "from.",
      url: "https://cwe.mitre.org/data/definitions/284.html",
      unansweredBecause:
        "The pillar of the hierarchy, and everything this tool finds has a narrower class under " +
        "it that fits — 285, which is what the matrix channel and the isolation check both " +
        "cite. Naming the pillar as well would be one finding under two names, and a pack that " +
        "carries both reads as two.",
    },
    {
      id: "285",
      title:
        "The authorization check is absent or wrong. The honest class for a verdict read off a " +
        "status code, which cannot tell those two apart.",
      url: "https://cwe.mitre.org/data/definitions/285.html",
    },
    {
      id: "862",
      title: "No authorization check is performed at all.",
      url: "https://cwe.mitre.org/data/definitions/862.html",
      unansweredBecause:
        "Claiming this means claiming no check ran, and from outside the platform a check that " +
        "never ran and one that ran and answered wrongly give the same status code. The tool " +
        "only ever sees the outside, so it stops at the parent class, 285.",
    },
    {
      id: "863",
      title: "An authorization check runs and reaches the wrong answer.",
      url: "https://cwe.mitre.org/data/definitions/863.html",
      unansweredBecause:
        "The other half of the pair 285 covers, and unanswerable for the same reason: a status " +
        "code does not say whether a check ran. Nothing will close this without a channel that " +
        "sees inside the platform, which is not what this tool is.",
    },
    {
      id: "639",
      title:
        "Somebody else's record is reached by editing the identifier that names it in the request.",
      url: "https://cwe.mitre.org/data/definitions/639.html",
      unansweredBecause:
        "This is what the tool does find, and it is a child of 863, so claiming it means " +
        "claiming a check ran and answered wrongly. That is the distinction a status code " +
        "cannot make. The finding itself is reported as 285 and API1, which are true whichever " +
        "of the two happened.",
    },
  ],
};

/**
 * A catalogue of what this repository ships, assembled fresh for each caller.
 *
 * Fresh because the catalogue is mutable by design: a caller registers a private
 * standard into it, and a shared instance would carry that registration into the
 * next run and into every test in the file.
 */
export function createBundledCatalog(): StandardCatalog {
  const catalog = new StandardCatalog();
  catalog.register(OWASP_ASVS_5_0);
  catalog.register(OWASP_API_2023);
  catalog.register(CWE_ACCESS_CONTROL);
  return catalog;
}

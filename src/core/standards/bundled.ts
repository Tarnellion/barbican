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
 * None of the three is transcribed whole. ASVS has fourteen chapters and CWE has
 * no bottom at all; a catalogue that swallowed either would be a transcription
 * project, and one transcribed from memory would be worse than none. Each
 * definition states its own boundary in `scope`, and every row of
 * `findUncoveredClauses` carries that sentence, because "covered by no check"
 * read against an unstated boundary is a claim about the whole standard.
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
    "Chapter V8, Authorization: the requirements a black-box probe over HTTP can " +
    "speak to at all. The remaining requirements of V8 and the other thirteen " +
    "chapters are outside this catalogue, so a clause absent here is not thereby " +
    "absent from the standard.",
  clauses: [
    {
      id: "8.1.1",
      title:
        "The access rules are written down: which functions and which data each role may reach.",
      url: ASVS_V8,
    },
    {
      id: "8.1.3",
      title:
        "The environment and context attributes a decision depends on are written down as well.",
      url: ASVS_V8,
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
    },
    {
      id: "8.3.1",
      title: "The decision is taken on a server-side layer the caller cannot reach around.",
      url: ASVS_V8,
    },
    {
      id: "8.3.3",
      title:
        "An intermediary acting for somebody gets that somebody's rights, not its own wider ones.",
      url: ASVS_V8,
    },
    {
      id: "8.4.1",
      title: "One tenant's operations never reach a tenant it has no permission to interact with.",
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
 * The hierarchy is 284 to 285 to {862, 863}, with 639 a child of 863. All five
 * are here although this tool can honestly claim only two of them, and that is
 * the point rather than an oversight: `tenant-isolation.ts` says in a comment
 * why it cites 285 and not 862 or 863 — "from the outside 'there is no check'
 * and 'there is a check but it is wrong' give an indistinguishable answer" — and
 * the two it cannot tell apart are worth standing in the catalogue as clauses
 * nothing covers. A gap that exists for a reason is still a gap, and the reason
 * belongs in the pack rather than in a source comment nobody reading a report
 * will see.
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
        "Access to a resource is not restricted, or restricted wrongly. The parent of the rest.",
      url: "https://cwe.mitre.org/data/definitions/284.html",
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
    },
    {
      id: "863",
      title: "An authorization check runs and reaches the wrong answer.",
      url: "https://cwe.mitre.org/data/definitions/863.html",
    },
    {
      id: "639",
      title:
        "Somebody else's record is reached by editing the identifier that names it in the request.",
      url: "https://cwe.mitre.org/data/definitions/639.html",
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

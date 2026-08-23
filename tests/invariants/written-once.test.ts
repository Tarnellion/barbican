/**
 * Three decisions this repository makes once, held to being made once.
 *
 * ADR-0024 states the principle and `src/io/untrusted.ts` opens with the count
 * that produced it: eleven point fixes of one shape across four files, two of
 * them already drifted apart. The sweep of 22 August 2026 found the principle
 * broken in three more places, one of them inside that very file:
 *
 * - the address grammar was written twice — a conjunction of predicates for the
 *   seam, the same predicates re-listed as `if` blocks for the door — so a sixth
 *   rule could be added to the door alone and never reach `joinUrl`, which is
 *   the only thing between a consumer of the library and the wire (ADR-0032);
 * - the refusal of a scheme-relative path was written three times, under a
 *   comment saying it was written once. One of the three had been dead since the
 *   day the grammar took the rule over;
 * - two sets of statuses and error names that must agree were left to agree by
 *   inspection: `TERMINAL_ERROR_NAMES` against the client's own `instanceof`
 *   pair and against a second set in the CLI, and `classifyStatus`'s `not-found`
 *   list against a copy of it in the self-inflicted-404 guard.
 *
 * Each of them was repaired by making one side derive from the other. What is
 * here is the other half of that: a test that goes red when a member is added to
 * one place and not the other, so that the derivation cannot be quietly undone
 * by the next edit. Where a constant is deliberately unexported it is read out
 * of the source, the way `tests/invariants/transport.test.ts` reads the
 * response-header allowlist out of `http.ts` — a gate does not get to widen the
 * surface it is guarding.
 *
 * See ADR-0061.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCredentialProvider, DEFAULT_AUTH_SCHEME } from "../../src/adapters/credentials.js";
import { createEndpointListParser } from "../../src/adapters/endpoint-list.js";
import { CircuitOpenError } from "../../src/adapters/http.js";
import { createPostmanCollectionParser } from "../../src/adapters/postman.js";
import { RunBudgetExhaustedError } from "../../src/adapters/throttle.js";
import type { Account, Endpoint, Resource } from "../../src/core/index.js";
import {
  isAddressablePath,
  isUsablePathTemplate,
  pathTemplate,
  UnusablePathTemplateError,
} from "../../src/io/untrusted.js";
import { TERMINAL_ERROR_NAMES, terminalCause } from "../../src/runner/outcome.js";
import { classifyStatus, collectObservations } from "../../src/runner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const sourceOf = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

/**
 * The text of one top-level function, signature included.
 *
 * From the signature to the first line that is a lone `}` — which is what a
 * top-level function's closing brace looks like under this repository's
 * formatting, and nothing nested reaches column zero.
 */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is not in the source`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}", start);
  expect(end, `${signature} does not close`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * The address grammar: one table, two entry points.
 *
 * The gate is the witness list. Every rule in `ADDRESS_RULES` must have a path
 * here that it refuses, and that path must be refused by **both** entry points
 * with **that rule's** sentence — so a rule added to the table without being
 * thought about is a red test, and a rule that reaches only one of the two
 * cannot be spelled at all while they share the list.
 */
describe("the address grammar is one list", () => {
  const source = sourceOf("src/io/untrusted.ts");

  /**
   * A path that breaks exactly one rule, and the sentence that rule answers
   * with. Distinct sentences are what make "which rule fired" observable from
   * outside a module that exports neither the table nor the predicates.
   */
  const WITNESSES: Readonly<Record<string, { readonly path: string; readonly says: RegExp }>> = {
    "query-or-fragment": {
      path: "/v1/orders/{orderId}?_method=DELETE",
      says: /carries a query string or a fragment/,
    },
    "unaddressable-character": {
      // Backslashes, which the URL parser reads as separators and a split on
      // `/` reads as ordinary characters. No `/` in it beyond the first, so
      // `navigates` has nothing to say and the sentence can only come from
      // this rule.
      path: "/v1\\reports\\..\\..\\danger",
      says: /carries a backslash or a control character/,
    },
    address: {
      path: "//api.test/v1/danger",
      says: /is an address rather than a path/,
    },
    navigates: {
      path: "/v1/reports/../danger",
      says: /navigates with/,
    },
  };

  /** The ids, off the table itself. */
  const declared = (): readonly string[] => {
    const table = /const ADDRESS_RULES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(source);
    // A guard on the guard: a renamed constant must not read as an empty table
    // and pass everything below by having nothing to check.
    expect(table).not.toBeNull();
    return [...(table?.[1] ?? "").matchAll(/^\s*id: "([^"]+)",$/gm)].map((match) => match[1] ?? "");
  };

  it("has a witness for every rule it states, and states every rule witnessed here", () => {
    expect([...declared()].sort()).toEqual(Object.keys(WITNESSES).sort());
  });

  it("refuses each witness through both entry points, with that rule's sentence", () => {
    for (const id of declared()) {
      const witness = WITNESSES[id];
      expect(witness, `no witness for the rule "${id}"`).toBeDefined();
      const path = witness?.path ?? "";

      // The seam. A rule that reaches only `pathTemplate` is a rule `joinUrl`
      // does not apply, and `joinUrl` is the door a consumer of the library
      // comes through — ADR-0032, the whole of it.
      expect(isAddressablePath(path), `${id}: the seam admits ${path}`).toBe(false);
      expect(isUsablePathTemplate(path), `${id}: the door admits ${path}`).toBe(false);

      // And the door says which rule, in words an operator can act on. These
      // sentences are the reason the table holds pairs rather than predicates.
      let thrown: unknown;
      try {
        pathTemplate(path);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown, `${id}: the door admits ${path}`).toBeInstanceOf(UnusablePathTemplateError);
      expect((thrown as Error).message).toMatch(witness?.says ?? /$^/);
    }
  });

  /**
   * And neither entry point decides anything of its own.
   *
   * The witness test above cannot see a fifth `if` written beside the table:
   * such a rule has no id, so nothing demands a witness for it. This is what
   * does — one `every` on one side, one throw on the other.
   */
  it("asks the table and nothing besides", () => {
    const seam = bodyOf(source, "export function isAddressablePath");
    expect(seam).toContain("ADDRESS_RULES.every");
    // The conjunction this replaced. Its return was five predicates joined by
    // `&&`, and that is the shape a sixth would be appended to.
    expect(seam).not.toContain("&&");

    const door = bodyOf(source, "export function pathTemplate");
    expect(door).toContain("ADDRESS_RULES.find");
    // Exactly one place a refusal is worded, so a new message cannot be written
    // anywhere but into the table.
    expect([...door.matchAll(/new UnusablePathTemplateError\(/g)]).toHaveLength(1);
  });
});

/**
 * The scheme-relative refusal, now that two of the three copies are accounted
 * for.
 *
 * `//host/x` joined to the base becomes a request to somebody else's host, or —
 * because `joinUrl` strips leading slashes — to `/v1/host/x`, an endpoint the
 * configuration never named, reported as if it were the one it did. The grammar
 * refuses it for every door at once. The Postman parser's own copy sat after
 * `pathTemplate` and could not be reached; the endpoint list's runs before it
 * and is what answers there.
 */
describe("a scheme-relative path is refused once, and by the grammar", () => {
  const SCHEME_RELATIVE = "//evil.test/v1/users";

  it("is the grammar's answer at the Postman door, not a copy's", async () => {
    const collection = JSON.stringify({
      item: [{ name: "a", request: { method: "GET", url: { path: ["", "evil.test", "x"] } } }],
    });

    await expect(createPostmanCollectionParser().parse(collection)).rejects.toThrow(
      /an address rather than a path/,
    );
  });

  /**
   * The dead copy, held dead by its own wording.
   *
   * It was unreachable by construction: `pathTemplate` returns its argument
   * unchanged and throws when the decoded form is an address, and decoding
   * replaces `%2e`, `%2f` and `%5c` with one character each without deleting
   * anything — so a string that starts with `//` still does after it, and never
   * comes back from that call. v8 agreed, at zero hits over the whole suite.
   * What made it worth removing rather than leaving is that its comment claimed
   * it was holding the scope open.
   *
   * The sentence now lives in one adapter. A third file using it is either a new
   * copy or the old one back.
   */
  it("is worded in exactly one adapter", () => {
    const wording = "addresses another host";
    const carrying = [
      "src/adapters/endpoint-list.ts",
      "src/adapters/openapi.ts",
      "src/adapters/postman.ts",
      "src/io/untrusted.ts",
      "src/runner/address.ts",
    ].filter((file) => sourceOf(file).includes(wording));

    expect(carrying).toEqual(["src/adapters/endpoint-list.ts"]);
  });

  /**
   * The live copy, held to being a subset.
   *
   * It is kept because it runs first and answers about the entry rather than the
   * template. What it must never become is a second, laxer reading: everything
   * it refuses, the grammar refuses too, so if it were deleted tomorrow the
   * refusal would still happen one line later. This is the assertion that goes
   * red if the grammar's `address` rule is ever dropped while the endpoint
   * list's wording stays behind to suggest the scope is still held.
   */
  it("agrees with the grammar at the endpoint list, which refuses it first", async () => {
    expect(isUsablePathTemplate(SCHEME_RELATIVE)).toBe(false);
    expect(isAddressablePath(SCHEME_RELATIVE)).toBe(false);

    await expect(
      createEndpointListParser().parse(
        `endpoints: [{ id: a, method: GET, path: ${JSON.stringify(SCHEME_RELATIVE)} }]`,
      ),
    ).rejects.toThrow(/addresses another host/);
  });
});

/**
 * The names by which a client says the walk cannot go on.
 *
 * Three readings of one fact: the set the runner matches by name, the second set
 * the CLI matched by name, and the client's own `instanceof` pair. The two sets
 * are one set now. The pair cannot be — an adapter sits below the runner and
 * must not import from it, and where the classes are in hand `instanceof` is the
 * stronger test — so the agreement between the set and the pair is held here.
 */
describe("the terminal errors are one list", () => {
  /** Every class the client refuses to retry, by the identifier it names. */
  const KNOWN: Readonly<Record<string, new (n: number) => Error>> = {
    RunBudgetExhaustedError,
    CircuitOpenError,
  };

  const retried = (): readonly string[] => {
    const source = sourceOf("src/adapters/http.ts");
    const guard = /if \((cause instanceof [\s\S]*?)\) \{\s*\n\s*throw cause;/.exec(source);
    // The same guard on the guard: a rewritten condition must not read as an
    // empty list of classes and pass by having nothing to compare.
    expect(guard).not.toBeNull();
    return [...(guard?.[1] ?? "").matchAll(/instanceof\s+([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1] ?? "",
    );
  };

  it("names the same errors in the client's retry guard and in the runner's set", () => {
    const identifiers = retried();
    expect(identifiers.length).toBeGreaterThan(0);

    const named = identifiers.map((identifier) => {
      const errorClass = KNOWN[identifier];
      // A fourth class added to the client's guard lands here: the test cannot
      // say whether the runner knows about it, so it says so out loud rather
      // than passing. Add it to `KNOWN` above, and to `TERMINAL_ERROR_NAMES`.
      expect(errorClass, `${identifier} is not one of the classes this test knows`).toBeDefined();
      // The identifier itself when there is no class for it: the assertion above
      // has already failed, and this only keeps the comparison below readable.
      return errorClass === undefined ? identifier : new errorClass(1).name;
    });

    // Both directions. A name added to the set with no class refusing retry
    // fails on the second line: the walk would call it terminal while the
    // client spent three attempts and two backoffs on it first.
    expect([...named].sort()).toEqual([...TERMINAL_ERROR_NAMES].sort());
  });

  it("is what terminalCause reads, through the wrapper the client throws", () => {
    for (const identifier of retried()) {
      const errorClass = KNOWN[identifier];
      expect(errorClass, `${identifier} is not one of the classes this test knows`).toBeDefined();
      if (errorClass === undefined) {
        continue;
      }
      const inner = new errorClass(1);
      // `RequestFailedError` wraps everything on its way out of the client, and
      // a match on the outer name is how this went unnoticed once already.
      const wrapped = new Error("request failed", { cause: inner });

      expect(terminalCause(wrapped)).toBe(inner);
    }

    expect(terminalCause(new Error("connection refused"))).toBeUndefined();
  });

  /**
   * And the names are spelled in one place besides the classes themselves.
   *
   * A quoted `"CircuitOpenError"` in a fourth file is a second list starting.
   * The two that are allowed: the class's own `this.name`, and the set.
   */
  it("is spelled where the class is defined and in the set, nowhere else", () => {
    const files = [
      "src/adapters/credentials.ts",
      "src/adapters/endpoint-list.ts",
      "src/adapters/http.ts",
      "src/adapters/openapi.ts",
      "src/adapters/postman.ts",
      "src/adapters/signals.ts",
      "src/adapters/throttle.ts",
      "src/cli/canaries.ts",
      "src/cli/preview.ts",
      "src/cli/run.ts",
      "src/report/build.ts",
      "src/report/verdict.ts",
      "src/runner/canaries.ts",
      "src/runner/outcome.ts",
      "src/runner/walk.ts",
    ];

    expect(files.filter((file) => sourceOf(file).includes('"RunBudgetExhaustedError"'))).toEqual([
      "src/adapters/throttle.ts",
      "src/runner/outcome.ts",
    ]);
    expect(files.filter((file) => sourceOf(file).includes('"CircuitOpenError"'))).toEqual([
      "src/adapters/http.ts",
      "src/runner/outcome.ts",
    ]);
  });
});

/**
 * The statuses that mean the object is not there.
 *
 * `classifyStatus` folds them into `not-found`, and `toBinary` folds `not-found`
 * on into a denial — so a status this run caused with its own write reads as
 * protection observed, which is the L-7 false negative. The guard in `walk.ts`
 * had the list written out a second time; ADR-0046 moved it once already, by
 * hand, when 410 joined 404.
 */
describe("the not-found statuses are one list", () => {
  const ACCOUNTS: readonly Account[] = [
    { id: "first", roleId: "r", tenantId: "t" },
    { id: "second", roleId: "r", tenantId: "t" },
  ];
  const CREDENTIALS = createCredentialProvider(
    DEFAULT_AUTH_SCHEME,
    new Map(ACCOUNTS.map((account) => [account.id, `token-${account.id}`])),
  );
  const DELETE_ORDER: Endpoint = {
    id: "orders.delete",
    method: "DELETE",
    path: "/v1/orders/{orderId}",
  };
  const ORDER: readonly Resource[] = [{ id: "order-1", tenantId: "t", params: { orderId: "1" } }];

  /** The list, computed rather than typed: whatever the classifier says today. */
  const notFound = (): readonly number[] => {
    const found: number[] = [];
    for (let status = 100; status < 600; status += 1) {
      if (classifyStatus(status) === "not-found") {
        found.push(status);
      }
    }
    return found;
  };

  /** A platform that really deletes: the first caller wins, the rest get `after`. */
  async function afterOurOwnWrite(after: number) {
    const gone = new Set<string>();
    return collectObservations({
      baseUrl: "https://a.test",
      endpoints: [DELETE_ORDER],
      accounts: ACCOUNTS,
      credentials: CREDENTIALS,
      resources: ORDER,
      client: {
        send(request) {
          const { pathname } = new URL(request.url);
          if (gone.has(pathname)) {
            return Promise.resolve({ status: after, headers: {} });
          }
          gone.add(pathname);
          return Promise.resolve({ status: 200, headers: {} });
        },
      },
      allowUnsafeMethods: true,
      // One at a time: "earlier" has to mean something for the guard to have
      // anything to say.
      concurrency: 1,
    });
  }

  /**
   * The list itself, spelled out once so that adding to it is a decision.
   *
   * The same reasoning as the response-header allowlist in
   * `tests/invariants/transport.test.ts`: a third status folding into
   * `not-found` changes what a denial means in every report this tool writes,
   * and it should cost an edit here and a line in an ADR.
   */
  it("folds exactly 404 and 410", () => {
    expect(notFound()).toEqual([404, 410]);
  });

  /**
   * The agreement, driven off the classifier rather than off a list.
   *
   * Whatever `classifyStatus` calls `not-found` is what the walk must call
   * self-inflicted after its own write. Add a status to the classifier and this
   * loop asks about it on the next run; a guard that re-hardcodes 404 and 410
   * then fails here instead of shipping a false "tested and agreed".
   */
  it("is what the self-inflicted guard recognises, every member of it", async () => {
    for (const status of notFound()) {
      const { observations, failures } = await afterOurOwnWrite(status);

      expect(observations[0]?.outcome, `${status}: the first write`).toBe("allowed");
      // Not `not-found`, which is the value that folds into a denial and made
      // the run report a protection it had manufactured itself.
      expect(observations[1]?.outcome, `${status}: the second`).toBe("error");
      expect(failures.at(-1)?.reason).toContain("already changed the object");
    }
  });

  /**
   * And nothing else is swept in with them. A refused write is a refusal, and a
   * 409 or a 500 after our own write says something the tool must not discard as
   * its own doing.
   */
  it("leaves every other status to mean what it means", async () => {
    for (const status of [403, 409, 500]) {
      const { failures } = await afterOurOwnWrite(status);

      for (const failure of failures) {
        expect(failure.reason, `${status}`).not.toContain("already changed the object");
      }
    }
  });

  /** And the guard reads it off the classifier rather than restating it. */
  it("is asked of classifyStatus in the guard, with no status written there", () => {
    const walk = sourceOf("src/runner/walk.ts");
    const guard = /} else if \((.*)\) \{\n\s*selfInflicted = true;/.exec(walk);
    expect(guard).not.toBeNull();

    const condition = guard?.[1] ?? "";
    expect(condition).toContain('classifyStatus(status) === "not-found"');
    expect(condition).not.toMatch(/\d/);
  });
});

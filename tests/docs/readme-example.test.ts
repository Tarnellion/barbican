/**
 * The library example in the README compiles, runs, and prints what it claims.
 *
 * It did none of the three. `diffAccess` takes a `ResolvedAccessPolicy` and the
 * example passed an `ExpectedAccessPolicy`, so the only piece of library code a
 * reader is offered did not type-check — and the missing step, `expandPolicy`,
 * was named nowhere near it. Found by the audit of 14 August 2026 (E-2).
 *
 * The example is copied here between markers and compared with the README
 * character for character, so the two cannot drift. Copying is what the audit
 * says fails; the copy is only safe because the comparison is mechanical.
 * Without it this would pin a snippet nobody reads while the README kept its own.
 *
 * `pnpm run typecheck` reads this file, which is the compile half. The run half
 * is below.
 */

// biome-ignore-all assist/source/organizeImports: the marked region below is a
// copy of the README compared with it character for character, and sorting the
// imports moves lines out of it — which silently narrows what is guarded to
// whatever survived the move.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// #region readme-example
import { ANY, buildAccessMatrix, diffAccess, expandPolicy } from "../../src/index.js";
import type { Endpoint, ExpectedAccessPolicy } from "../../src/index.js";

// Declared once: `expandPolicy` needs them to turn patterns into names, and a
// pattern that matches nothing has to fail there rather than quietly stop
// applying.
const endpoints: Endpoint[] = [
  { id: "profile.read", method: "GET", path: "/v1/players/{playerId}" },
  { id: "users.list", method: "GET", path: "/v1/admin/users" },
];

const matrix = buildAccessMatrix({
  endpoints,
  accounts: [{ id: "player-1", roleId: "player", tenantId: "tenant-a" }],
  observations: [
    {
      accountId: "player-1",
      endpointId: "profile.read",
      status: 200,
      headers: {},
      outcome: "allowed",
      durationMs: 12,
    },
    {
      accountId: "player-1",
      endpointId: "users.list",
      status: 200,
      headers: {},
      outcome: "allowed",
      durationMs: 15,
    },
  ],
});

// Anything not granted by a rule falls through to `fallback`.
const policy: ExpectedAccessPolicy = {
  fallback: "denied",
  rules: [{ roles: ANY, endpoints: ["profile.read"], outcome: "allowed" }],
};

const found = diffAccess(matrix, expandPolicy(policy, endpoints));
// #endregion readme-example

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** What the README prints under the snippet, as data. */
const CLAIMED = [
  {
    accountId: "player-1",
    endpointId: "users.list",
    expected: "denied",
    kind: "privilege-escalation",
    severity: "high",
    actual: "allowed",
  },
];

describe("the library example in the README", () => {
  /** The half that was broken: it did not even compile, let alone print this. */
  it("produces exactly what the README says it produces", () => {
    expect(found).toHaveLength(1);
    expect(found).toMatchObject(CLAIMED);
  });

  /**
   * And it is the same code. Only the module specifier differs — a reader
   * installs the package, this file is inside it — so exactly one substitution
   * is allowed and nothing else.
   */
  it("is the same code the README shows", () => {
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");

    const shown = readme.slice(readme.indexOf("```ts\n") + 6, readme.indexOf("\n// found = ["));
    const tested = source.slice(
      source.indexOf("// #region readme-example\n") + 26,
      source.indexOf("\n// #endregion readme-example"),
    );

    expect(tested).toBe(shown.replaceAll('from "barbican"', 'from "../../src/index.js"'));
  });
});

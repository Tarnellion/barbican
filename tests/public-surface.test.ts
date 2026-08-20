/**
 * Every adapter the package builds is one a consumer can reach.
 *
 * `src/index.ts` opens by stating the policy: "adapter implementations are
 * exported alongside the ports: otherwise they would end up in the build but
 * stay unreachable for a consumer." It was stated and not checked, and one
 * module was missing — `src/adapters/signals.js`. The cost was not one absent
 * name. `createHttpClient` takes `signalExtractor?: SignalExtractor`, a public
 * option whose type a consumer could not write down, and the body-signal half of
 * the tool was unusable from the library while the check that consumes its
 * output was exported in full. Found by the audit of 14 August 2026 (E-1 / B-8).
 *
 * A comment cannot notice the next adapter. This file reads the directory, so
 * the module added tomorrow is in the list whether or not anybody remembered.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ADAPTERS = readdirSync(join(ROOT, "src/adapters"))
  .filter((one) => one.endsWith(".ts"))
  .map((one) => one.replace(/\.ts$/, ""));

const INDEX = readFileSync(join(ROOT, "src/index.ts"), "utf8");

describe("the public surface", () => {
  it("has adapters to answer for", () => {
    // A test that read an empty directory would agree with any surface.
    expect(ADAPTERS.length).toBeGreaterThan(5);
  });

  /**
   * Read off the directory rather than listed here: a second list would be the
   * same fact written twice, and the point of the exercise is that one such
   * fact went stale unnoticed.
   */
  it("re-exports every adapter module", () => {
    const missing = ADAPTERS.filter(
      (one) => !INDEX.includes(`export * from "./adapters/${one}.js";`),
    );

    expect(missing).toEqual([]);
  });

  /**
   * And nothing a dependency owns is in it.
   *
   * `configSchema` was exported, so zod's own types were in the published
   * surface: 100 lines of `z.ZodObject<…>` in `config.d.ts`, 18% of the file,
   * naming `z.core.$strip` — zod's **internal** namespace. A zod major would have
   * changed those types and broken every consumer's build, for a value none of
   * them needs: `parseRunConfig` validates and returns a `RunConfig`, and
   * `configJsonSchema()` hands out the JSON Schema an editor completes from.
   * A dependency in a public type is a version of that dependency the package
   * has promised to keep. Found by the audit of 14 August 2026 (E-6).
   *
   * The property rather than the name, so the next schema is caught too. The CI
   * job that packs the tarball asserts the general form of this — no shipped
   * declaration imports from a package at all.
   */
  it("exports no validator of somebody else's making", () => {
    const schemas = Object.entries(api).filter(
      ([, value]) => value !== null && typeof value === "object" && "_zod" in value,
    );

    expect(schemas.map(([name]) => name)).toEqual([]);
  });

  /**
   * And the specific name the finding was about, asserted through a real import
   * rather than by reading the source: what a consumer gets is the module, not
   * the text of the re-export.
   */
  /**
   * And the document that names the entry points names real ones.
   *
   * 266 exported names and five of them anywhere in the documentation, all five
   * in one README example — so nothing told a consumer which names were a
   * contract. `docs/library.md` is the answer, and this is what keeps it from
   * becoming a second stale list: every name it writes in backticks and calls
   * with parentheses has to be something the package actually exports.
   *
   * Only the called names, deliberately. The document also mentions types, which
   * do not exist at runtime, and prose words in backticks like `0.x` — a guard
   * that tried to resolve those would be either wrong or full of exceptions.
   * Found by the audit of 14 August 2026 (E-6).
   */
  it("exports every function docs/library.md tells a consumer to call", () => {
    const document = readFileSync(join(ROOT, "docs/library.md"), "utf8");
    const called = new Set(
      [...document.matchAll(/`([A-Za-z][A-Za-z0-9]*)\(/g)].map((match) => match[1] ?? ""),
    );

    // A regex that matched nothing would agree with any document.
    expect(called.size).toBeGreaterThan(5);

    const missing = [...called].filter((name) => !(name in api));

    expect(missing).toEqual([]);
  });

  it("lets a consumer build a signal extractor and name its type", () => {
    expect(typeof api.createSignalExtractor).toBe("function");
    expect(typeof api.parseSignalPath).toBe("function");
    expect(api.DEFAULT_MAX_BODY_BYTES).toBeGreaterThan(0);

    // The type is the half that mattered: this line does not compile if
    // `SignalExtractor` is not exported, which is what made `signalExtractor?:`
    // on the http client an option nobody could type.
    const extractor: api.SignalExtractor = api.createSignalExtractor();

    expect(extractor).toHaveProperty("extract");
  });
});

/**
 * The two numbers `docs/library.md` states about this surface.
 *
 * They were 156 and 75 against an actual 160 and 79, and they had been wrong
 * since before 0.4.0 — a count written by hand once and then left beside a file
 * that grows. A number in prose is a claim like any other; this is the cheapest
 * place to hold it, because the count is one line away from the import.
 *
 * If a change makes them move, move them: the point is that the file says what
 * the package is, not that the package stops growing.
 */
describe("the counts in docs/library.md", () => {
  const LIBRARY = readFileSync(join(ROOT, "docs/library.md"), "utf8");
  const names = Object.keys(api);

  const stated = (pattern: RegExp): number => {
    const found = LIBRARY.match(pattern)?.[1];
    // A guard that read no number would agree with every number.
    expect(found, `not found in docs/library.md: ${pattern}`).toBeDefined();
    return Number(found);
  };

  it("say how many values the package exports", () => {
    expect(stated(/The package exports (\d+) values/)).toBe(names.length);
  });

  it("say how many of them are error classes", () => {
    const errors = names.filter(
      (name) => /Error$/.test(name) && typeof (api as Record<string, unknown>)[name] === "function",
    );

    expect(stated(/\*\*(\d+) error classes\.\*\*/)).toBe(errors.length);
  });
});

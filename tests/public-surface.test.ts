/**
 * Every module the package builds against is one a consumer can reach.
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
 *
 * It read **one** directory, `src/adapters`, and that is how the same defect
 * survived here in another layer until 21 August 2026: `src/io/untrusted.ts` was
 * re-exported from neither index, so `HeaderValue` — the brand
 * `CredentialProvider.headersFor` is declared to return — had no reachable
 * constructor, and the signing provider ADR-0018 calls implementable on top of
 * the exported port did not compile for anyone outside this repository. A test
 * that reads a directory still only sees the directory it was given; the layers
 * are named below, and the error classes are checked across all of `src`
 * regardless of layer.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The layers whose every module is part of the library surface.
 *
 * `adapters` because an implementation shipped behind a port a consumer cannot
 * reach is dead weight in the build; `io` because the grammar for a string from
 * outside is written once and has to be reachable from both doors — the CLI
 * builds a `HeaderValue` through it, and so must a consumer, or the brand is a
 * wall rather than a check (ADR-0024).
 *
 * `core`, `report` and `runner` are not here because they are re-exported
 * through a barrel of their own rather than module by module — `src/runner.ts`
 * being the one over `src/runner/` since ADR-0057, and deliberately a list of
 * names rather than a star, so that what those modules hand each other does not
 * become surface. The error-class guard at the bottom of this file covers all
 * three without caring how a module reaches the surface.
 */
const LAYERS = ["adapters", "io"] as const;

const MODULES = LAYERS.flatMap((layer) =>
  readdirSync(join(ROOT, `src/${layer}`))
    .filter((one) => one.endsWith(".ts"))
    .map((one) => `./${layer}/${one.replace(/\.ts$/, "")}.js`),
);

const INDEX = readFileSync(join(ROOT, "src/index.ts"), "utf8");

describe("the public surface", () => {
  it("has modules to answer for, from every layer named", () => {
    // A test that read an empty directory would agree with any surface.
    expect(MODULES.length).toBeGreaterThan(5);

    // And one that read only the first directory would agree with the state
    // this half of the file was written from: `src/io` present in the build and
    // absent from the surface.
    for (const layer of LAYERS) {
      expect(MODULES.some((one) => one.startsWith(`./${layer}/`))).toBe(true);
    }
  });

  /**
   * Read off the directories rather than listed here: a second list would be the
   * same fact written twice, and the point of the exercise is that one such
   * fact went stale unnoticed.
   */
  it("re-exports every module of those layers", () => {
    const missing = MODULES.filter((one) => !INDEX.includes(`export * from "${one}";`));

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
 * An error thrown across the boundary of the library is part of the surface.
 *
 * `docs/library.md` states it as a promise: the error classes "are public on
 * purpose: catching an error and naming it is the only way to tell a
 * configuration mistake from a network failure, and `instanceof` needs the
 * class". Four of them were not public — the ones `src/io/untrusted.ts` throws —
 * because the module they live in was re-exported from nowhere. The
 * `UnusablePathTemplateError` ADR-0032 tells a consumer to expect could then be
 * recognised only by comparing `err.name` against a string literal: the class
 * name written a second time, in somebody else's codebase, out of reach of both
 * compilers. This repository has a rule about duplicates a compiler cannot check.
 *
 * The list is read off `src/` for the same reason the module list above is, and
 * across every layer rather than the named ones: how a module reaches the
 * surface is not what this guard is about.
 */
describe("the errors a consumer has to catch", () => {
  const DECLARED = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" })
    .filter((one) => one.endsWith(".ts") && one !== "cli.ts")
    .flatMap((one) => [
      ...readFileSync(join(ROOT, "src", one), "utf8").matchAll(/export class (\w+Error)\b/g),
    ])
    .map((match) => match[1] ?? "");

  it("has error classes to answer for", () => {
    // A regex that matched nothing would agree with any surface.
    expect(DECLARED.length).toBeGreaterThan(50);
  });

  it("exports every one the source declares", () => {
    expect(DECLARED.filter((name) => !(name in api))).toEqual([]);
  });

  /**
   * And the one the address seam throws, out of a real call rather than out of
   * the source text: what a consumer catches is the class the module exported,
   * not the name a regex found in a file.
   *
   * `joinUrl` is the seam ADR-0032 moved the grammar to, and every request of a
   * run passes through it. The walk turns the refusal into a skipped endpoint;
   * `probeCanaries`, which goes first, lets it out — a canary on such an endpoint
   * stops the run before any traffic. Either way the class is what a consumer
   * needs in a `catch`, and until 21 August 2026 the package did not name it.
   *
   * The provider below is written against the public surface alone, which is the
   * other half of the same finding: `safeHeaders` is the only constructor of the
   * `HeaderValue` this port asks for, and it was unreachable from outside.
   */
  it("hands the seam's refusal to a consumer as a class", async () => {
    const walked: string[] = [];
    let thrown: unknown;

    try {
      await api.probeCanaries({
        baseUrl: "https://api.test",
        endpoints: [{ id: "whoami", method: "GET", path: "/v1/me?_method=DELETE" }],
        canaries: [{ accountId: "a", endpointId: "whoami" }],
        credentials: { headersFor: () => api.safeHeaders([["x-token", "t"]]) },
        client: {
          send(request) {
            walked.push(request.url);
            return Promise.resolve({ status: 200, headers: {} });
          },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(api.UnusablePathTemplateError);
    // Before the wire, not after it.
    expect(walked).toEqual([]);
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

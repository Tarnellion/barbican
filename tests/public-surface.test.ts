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
   * And the specific name the finding was about, asserted through a real import
   * rather than by reading the source: what a consumer gets is the module, not
   * the text of the re-export.
   */
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

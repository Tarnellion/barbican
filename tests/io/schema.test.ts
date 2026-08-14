/**
 * The published JSON Schema of the run configuration.
 *
 * Every field of this format is written by hand, and until now an editor offered
 * completion for none of it: a cold read of 14 August spent its first minutes
 * guessing at the shape of a file that appears nowhere as a whole file.
 *
 * The schema is derived from the zod schema that validates a run, never written
 * out by hand — a second description of one format disagrees with the first
 * silently, and in the direction of whichever one the reader happened to open.
 * It is checked in rather than generated at pack time so that a diff shows what
 * changed for whoever writes configurations, and this test is what keeps the
 * checked-in copy honest.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_ID, configJsonSchema } from "../../src/io/config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLISHED = resolve(ROOT, "schema/barbican.run.schema.json");

describe("the JSON Schema of the configuration", () => {
  const generated = configJsonSchema();

  it("describes the fields a run configuration is made of", () => {
    // A schema that described nothing would agree with any file on disk.
    const properties = generated.properties as Record<string, unknown>;

    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["target", "accounts", "policy", "resources"]),
    );
  });

  /**
   * `io: "input"` — the schema describes what a person writes, before defaults
   * are applied. With the output shape it would demand fields the validator
   * fills in, and an editor would underline a correct file.
   */
  it("describes what is written, not what validation returns", () => {
    const target = (generated.properties as { target: { required: readonly string[] } }).target;

    expect(target.required).toEqual(["baseUrl", "allowedHosts"]);
  });

  it("matches the copy checked into the repository", () => {
    const published: unknown = JSON.parse(readFileSync(PUBLISHED, "utf8"));

    // Regenerate with `pnpm run schema` after changing the configuration format.
    // The comparison is of parsed values, so formatting is not part of it.
    expect(published).toEqual(generated);
  });

  it("answers at the address a configuration would point $schema at", () => {
    expect(generated.$id).toBe(CONFIG_SCHEMA_ID);
    expect(CONFIG_SCHEMA_ID).toContain("schema/barbican.run.schema.json");
  });
});

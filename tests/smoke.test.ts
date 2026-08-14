/**
 * A smoke test: it proves the TypeScript -> tests -> build chain works and that
 * the core imports as a library.
 *
 * There is no business logic here — that arrives in session 2 with the fixtures.
 */

import { describe, expect, it } from "vitest";
import type { Check } from "../src/core/index.js";
import { CheckRegistry, DuplicateCheckIdError, SAFE_METHODS } from "../src/core/index.js";

const stubCheck: Check = {
  id: "stub.noop",
  description: "A stub for checking the registry",
  severity: "info",
  standards: [{ standard: "OWASP-API-2023", clause: "API1" }],
  run: () => [],
};

describe("the check registry", () => {
  it("registers a check and returns it by id", () => {
    const registry = new CheckRegistry();
    registry.register(stubCheck);

    expect(registry.size).toBe(1);
    expect(registry.get("stub.noop")).toBe(stubCheck);
    expect(registry.list()).toEqual([stubCheck]);
  });

  it("rejects registering the same id twice", () => {
    const registry = new CheckRegistry();
    registry.register(stubCheck);

    expect(() => {
      registry.register(stubCheck);
    }).toThrow(DuplicateCheckIdError);
  });

  it("shares no state between instances", () => {
    const first = new CheckRegistry();
    const second = new CheckRegistry();
    first.register(stubCheck);

    expect(second.size).toBe(0);
  });
});

describe("the security invariants", () => {
  it("without an explicit flag only GET and HEAD count as safe", () => {
    expect([...SAFE_METHODS]).toEqual(["GET", "HEAD"]);
  });
});

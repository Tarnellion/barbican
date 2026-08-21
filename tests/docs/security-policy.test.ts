/**
 * There is a way to report a hole in this tool that is not publishing it.
 *
 * Found by the audit of 20 August 2026 (M-8). The repository had no
 * `SECURITY.md`, and `bugs.url` in `package.json` points at the public issue
 * tracker — so the only route a finder had was an issue everybody can read,
 * which is a 0-day published before the fix. For a tool that runs against other
 * people's platforms with live credentials for several roles, reads documents it
 * did not write, and ships to npm with provenance, that is not a missing file:
 * it is a missing channel.
 *
 * What this guard holds is the part that rots. A policy document goes stale by
 * naming a contact nobody reads — a mailbox that was never created, an address
 * that stopped forwarding — and it goes stale silently, because the only person
 * who finds out is the one whose report went nowhere.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY = readFileSync(resolve(ROOT, "SECURITY.md"), "utf8");

/** Anything shaped like an address a reporter would write to. */
const ADDRESS = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** The line an address sits on, which is where its label would be. */
function lineWith(text: string, needle: string): string {
  return text.split("\n").find((line) => line.includes(needle)) ?? "";
}

describe("the way to report a hole in this tool", () => {
  it("is written down where GitHub looks for it", () => {
    // Tracked, not merely on disk: an untracked file is a policy nobody outside
    // this machine has. The language guard next door reads git for the same
    // reason.
    const tracked = execFileSync("git", ["ls-files", "SECURITY.md"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();

    expect(tracked).toBe("SECURITY.md");
    expect(POLICY.length).toBeGreaterThan(1000);
  });

  /**
   * And it is a private one. The finding was not "no document" — a document
   * saying "open an issue" would have satisfied that and changed nothing.
   */
  it("is private, and is not the public issue tracker", () => {
    expect(POLICY).toContain("Report a vulnerability");
    expect(POLICY).toMatch(/do not open an issue/i);
  });

  it("says what counts as a vulnerability in a tool that reports vulnerabilities", () => {
    // Without this the channel receives every finding barbican prints about
    // somebody's platform, and the one report that matters is lost among them.
    expect(POLICY).toMatch(/not what barbican reports about your platform/i);
  });

  /**
   * Any contact it carries is either real or marked as not being real.
   *
   * No security address exists in this repository — `author` is a GitHub profile
   * and `bugs.url` is the public tracker — so the document carries a placeholder
   * rather than an invented mailbox. A placeholder that stops looking like one is
   * the failure this assertion exists for: a reporter writes to it, nothing
   * arrives, and both sides believe the channel worked.
   */
  it("marks every address it cannot vouch for as a placeholder", () => {
    for (const [address] of POLICY.matchAll(ADDRESS)) {
      expect(lineWith(POLICY, address).toLowerCase(), address).toContain("placeholder");
    }
  });

  /**
   * Put to a document written for the occasion, because the assertion above is
   * green today by finding nothing at all — the policy names no address yet, and
   * a guard that agrees with an empty list is the shape this repository keeps
   * finding in its own tests.
   */
  it("would notice an address that arrives unlabelled", () => {
    const invented =
      "Email: security@barbican.invalid\nEmail: nobody@example.invalid (placeholder)\n";
    const found = [...invented.matchAll(ADDRESS)].map(([address]) => address);

    expect(found).toEqual(["security@barbican.invalid", "nobody@example.invalid"]);
    expect(lineWith(invented, "security@barbican.invalid")).not.toContain("placeholder");
    expect(lineWith(invented, "nobody@example.invalid")).toContain("placeholder");
  });

  /**
   * The document promises a limit on the wait, because the cost of a private
   * channel is that nobody but the maintainer can see the report going
   * unanswered. A policy with no number in it asks a reporter to wait forever
   * and call it coordination.
   */
  it("puts a number on how long a reporter waits before going public", () => {
    expect(POLICY).toMatch(/within 7 days/);
    expect(POLICY).toMatch(/\b90 days\b/);
  });
});

/**
 * Proof tests for the specification parser.
 *
 * The invariant from ADR-0005: external `$ref`s are resolved neither over http
 * nor through the file system. These tests do not check "was an error thrown" —
 * they check that no request to the outside **happened**: the http server
 * received no request at all, and the file's content never reached the result.
 *
 * They must not be deleted or marked `skip`.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenApiParser,
  DEFAULT_SPEC_LIMITS,
  ExternalRefError,
  SpecParseError,
  SpecTooDeepError,
  SpecTooLargeError,
  UnsupportedYamlTagError,
} from "../../src/adapters/openapi.js";

const parser = createOpenApiParser();

const MINIMAL_SPEC = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /v1/players/{playerId}:
    get:
      operationId: players.read
      responses: { "200": { description: ok } }
  /v1/admin/users:
    get:
      responses: { "200": { description: ok } }
    delete:
      responses: { "204": { description: ok } }
`;

describe("parsing a valid specification", () => {
  it("extracts endpoints with a method and a path", async () => {
    const endpoints = await parser.parse(MINIMAL_SPEC);

    expect(endpoints).toEqual([
      {
        id: "players.read",
        method: "GET",
        path: "/v1/players/{playerId}",
        operationId: "players.read",
      },
      { id: "GET /v1/admin/users", method: "GET", path: "/v1/admin/users" },
      { id: "DELETE /v1/admin/users", method: "DELETE", path: "/v1/admin/users" },
    ]);
  });

  it("accepts JSON: it is a subset of YAML", async () => {
    const json = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
    });

    const endpoints = await parser.parse(json);

    expect(endpoints).toEqual([{ id: "GET /ping", method: "GET", path: "/ping" }]);
  });

  it("resolves internal references", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    $ref: "#/components/pathItems/shared"
components:
  pathItems:
    shared:
      get:
        operationId: shared.read
        responses: { "200": { description: ok } }
`;

    const endpoints = await parser.parse(spec);

    expect(endpoints).toEqual([
      { id: "shared.read", method: "GET", path: "/a", operationId: "shared.read" },
    ]);
  });

  it("returns an empty list for a valid specification with no paths", async () => {
    const spec = 'openapi: "3.0.0"\ninfo: { title: t, version: "1" }\npaths: {}';

    await expect(parser.parse(spec)).resolves.toEqual([]);
  });

  // Silently returning zero endpoints on an invalid spec means reporting "no
  // discrepancies" where no check took place at all.
  it("rejects a document that is not a specification instead of returning an empty list", async () => {
    await expect(
      parser.parse('openapi: "3.0.0"\ninfo: { title: t, version: "1" }'),
    ).rejects.toThrow(SpecParseError);
    await expect(parser.parse("just: a string")).rejects.toThrow(SpecParseError);
  });
});

describe("external $refs are not resolved over http", () => {
  let hits = 0;
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    hits = 0;
    server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/yaml" });
      response.end("type: object\n");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not start the test server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it("performs no request to the address in a $ref", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "${baseUrl}/evil.yaml"
`;

    await expect(parser.parse(spec)).rejects.toThrow(ExternalRefError);

    // The main claim: nothing went out.
    expect(hits).toBe(0);
  });

  it("does not follow a reference at the root of the document either", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  $ref: "${baseUrl}/paths.yaml"
`;

    await expect(parser.parse(spec)).rejects.toThrow(ExternalRefError);
    expect(hits).toBe(0);
  });

  /**
   * The third barrier, and what it actually does.
   *
   * The two tests above prove nothing goes out, and they cannot say which
   * barrier stopped it: the second one refuses the document before
   * swagger-parser sees it. The module header called the third —
   * `resolve.external = false` — "the defence against SSRF proper", and
   * "verified separately: with barrier 2 removed, a request to the address from
   * the `$ref` still does not go out".
   *
   * That verification was done by hand and it could not tell the two apart,
   * because **no request goes out with the option on either**. Measured on
   * 17 August 2026 across six configurations — the document as an object, as a
   * file path, and as an object with a base path, each with the option both ways
   * — and in swagger-parser 12.1.0 an http `$ref` is never fetched at all. With
   * `external: false` it is left in place in silence; with `external: true` the
   * call throws "Unable to resolve $ref pointer". Neither opens a socket.
   *
   * So the two assertions below say different things. The first pins the
   * invariant under the call this adapter actually makes. The second is a
   * tripwire on a dependency, and it asserts something the project does not
   * want: that the option is currently not what stops the request. The day
   * swagger-parser gains a working http resolver, that test fails, and whoever
   * sees it has to come back here — which is the only way the header above stops
   * being a guess about which barrier is holding.
   *
   * Found by the audit of 14 August 2026, which noted that the mutation
   * `resolve: { external: true }` breaks no test.
   */
  const withHttpRef = () => ({
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    paths: {
      "/a": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: `${baseUrl}/evil.yaml` } } },
            },
          },
        },
      },
    },
  });

  it("makes no request under the options this adapter passes", async () => {
    await SwaggerParser.dereference(withHttpRef(), { resolve: { external: false } }).catch(
      () => undefined,
    );

    expect(hits).toBe(0);
  });

  it("makes none with the option on either, which is a tripwire and not a wish", async () => {
    await SwaggerParser.dereference(withHttpRef(), { resolve: { external: true } }).catch(
      () => undefined,
    );

    // When this fails, swagger-parser has started resolving http references and
    // `resolve.external` has become load-bearing. Read the header of
    // src/adapters/openapi.ts before changing this number.
    expect(hits).toBe(0);
  });

  /**
   * And the option is still passed.
   *
   * Asserted on the source because there is no other way: with barrier 2 in
   * front of it, deleting the option changes nothing any test can observe today.
   *
   * The reason given here used to be that the option protects nothing and is kept
   * for the version of the library where it would. That is true of the http half
   * only. Measured on 18 August 2026 by removing the barriers one at a time: over
   * the file system the option is load-bearing right now — with barrier 2 gone
   * and the option kept, a `$ref` naming a file by absolute path is left
   * unresolved and nothing is read, and swagger-parser reads that same file
   * happily when the option is turned on. So this line guards a live defence and
   * not a dormant one, which is a stronger reason than the one it had.
   */
  it("is still asked for, which nothing else here would notice", () => {
    const source = readFileSync(
      resolvePath(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/openapi.ts"),
      "utf8",
    );

    expect(source).toContain("resolve: { external: false }");
  });

  it("reports which reference exactly was rejected", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "${baseUrl}/evil.yaml"
`;

    await expect(parser.parse(spec)).rejects.toMatchObject({ ref: `${baseUrl}/evil.yaml` });
    expect(hits).toBe(0);
  });
});

describe("external $refs are not resolved through the file system", () => {
  let directory = "";
  let secretPath = "";
  const CANARY = "canary-6f2a1b9c-must-not-leak";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "barbican-spec-"));
    secretPath = join(directory, "secret.yaml");
    await writeFile(secretPath, `type: object\ndescription: ${CANARY}\n`, "utf8");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("does not read a file by absolute path and lets none of it into the result", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: ${JSON.stringify(secretPath)}
`;

    const attempt = parser.parse(spec);

    await expect(attempt).rejects.toThrow(ExternalRefError);
    await expect(attempt.catch((error: unknown) => JSON.stringify(error))).resolves.not.toContain(
      CANARY,
    );
  });

  it("does not resolve directory traversal through ../", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "../../../../etc/passwd"
`;

    await expect(parser.parse(spec)).rejects.toThrow(ExternalRefError);
  });

  it("does not resolve file://", async () => {
    const spec = `
openapi: 3.0.0
info: { title: t, version: "1" }
paths:
  /a:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: ${JSON.stringify(pathToFileURL(secretPath).href)}
`;

    await expect(parser.parse(spec)).rejects.toThrow(ExternalRefError);
  });

  /**
   * Which barrier is holding this half, measured rather than assumed.
   *
   * The three tests above prove the adapter refuses. They do not say what would
   * happen without the refusal, and the module header answered that from a
   * measurement that had covered http only: it credited barrier 1 — "the parser
   * knows no paths" — with the file system too.
   *
   * Over http that reading is fair enough, because swagger-parser 12.1.0 fetches
   * nothing whichever way the option is set; the tripwire above watches for the
   * version that does. The file system is the opposite case. The library reads
   * files, an absolute path and a `file://` URL need no base to be read, and a
   * relative one takes the process's working directory as its base — so a
   * document handed over as an object, with no location of its own, still
   * resolves `./package.json`. Barrier 1 keeps this adapter from naming a
   * directory. It does not keep the library from reading a file.
   *
   * So this asserts something the project does not want, in the shape the http
   * tripwire uses: the danger is real today, and barrier 2 is what stands in
   * front of it. The day these fail, swagger-parser has stopped reading files by
   * absolute path — and the header above has to be read again before anyone
   * relaxes the rejection on the strength of it.
   */
  it("is held by the rejection: the library itself reads the file when asked to", async () => {
    const document = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": { get: { responses: { "200": { $ref: secretPath } } } },
      },
    };

    const resolved = await SwaggerParser.dereference(document, {
      resolve: { external: true },
    });

    expect(JSON.stringify(resolved)).toContain(CANARY);
  });

  it("and takes the working directory as the base for a relative one", async () => {
    const document = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": { get: { responses: { "200": { $ref: "./package.json" } } } },
      },
    };

    const resolved = await SwaggerParser.dereference(document, {
      resolve: { external: true },
    });

    // This repository's own manifest, read because the process happens to be
    // running here — the document said nothing about where it lives.
    expect(JSON.stringify(resolved)).toContain('"name":"barbican"');
  });
});

describe("limits on the size and shape of a document", () => {
  it("rejects a YAML bomb before it expands", async () => {
    const bomb = `
openapi: 3.0.0
info: { title: t, version: "1" }
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]
paths: {}
`;

    await expect(parser.parse(bomb)).rejects.toThrow(SpecParseError);
  });

  it("rejects a document over the limit", async () => {
    const small = createOpenApiParser({ maxBytes: 64 });

    await expect(small.parse(MINIMAL_SPEC)).rejects.toThrow(SpecTooLargeError);
  });

  it("rejects nesting that is too deep", async () => {
    let nested = "1";
    for (let i = 0; i < DEFAULT_SPEC_LIMITS.maxDepth + 10; i += 1) {
      nested = `[${nested}]`;
    }

    await expect(parser.parse(`{"paths":{},"deep":${nested}}`)).rejects.toThrow(SpecTooDeepError);
  });

  it("does not count subtrees shared through aliases as depth", async () => {
    const shared = `
openapi: 3.0.0
info: { title: t, version: "1" }
shared: &shared { type: object }
a: *shared
b: *shared
c: *shared
paths:
  /a:
    get:
      responses: { "200": { description: ok } }
`;

    await expect(parser.parse(shared)).resolves.toHaveLength(1);
  });

  it("reports an unparseable document instead of crashing", async () => {
    await expect(parser.parse("{ this: [is, unclosed")).rejects.toThrow(SpecParseError);
  });
});

/**
 * Found by adversarial review. The parser gives nodes tagged `!!omap` and
 * `!!set` as Map and Set, and a walk over `Object.values` does not enter them:
 * an external reference under such a node slipped past the barrier, and `paths`
 * under one gave **zero endpoints with not a single error** — a hundred percent
 * coverage of nothing. Psych emits such documents as a matter of course, so the
 * case is not invented.
 */
describe("nodes invisible to the walk", () => {
  const parser = createOpenApiParser();

  it("rejects an external reference hidden under !!omap", async () => {
    await expect(
      parser.parse(`
openapi: 3.0.0
info: { title: t, version: "1" }
components: !!omap
  - schemas:
      Order: { $ref: "http://127.0.0.1:9/x.yaml#/c" }
paths:
  /v1/orders:
    get: { operationId: orders.list, responses: { "200": { description: ok } } }
`),
    ).rejects.toThrow(UnsupportedYamlTagError);
  });

  it("rejects endpoints hidden under !!omap instead of a silent zero", async () => {
    await expect(
      parser.parse(`
openapi: 3.0.0
info: { title: t, version: "1" }
paths: !!omap
  - /v1/admin/accounts:
      get: { operationId: admin.accounts, responses: { "200": { description: ok } } }
`),
    ).rejects.toThrow(UnsupportedYamlTagError);
  });

  it("rejects !!set as well", async () => {
    await expect(
      parser.parse(`
openapi: 3.0.0
info: { title: t, version: "1" }
components: !!set
  ? $ref
paths:
  /v1/orders:
    get: { operationId: orders.list, responses: { "200": { description: ok } } }
`),
    ).rejects.toThrow(UnsupportedYamlTagError);
  });
});

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchema, UnsupportedSchema } from "../src/lib/openapi.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * O13: the API contract. `docs/openapi.json` is the committed copy of what `GET /api/openapi.json` serves. After a
 * deliberate route change, refresh it with `pnpm --filter @tasees/api contract` and review the diff.
 */
const FILE = join(__dirname, "..", "..", "..", "docs", "openapi.json");

describe("the API contract", () => {
  let env: TestEnv;
  let doc: any;
  beforeAll(async () => {
    env = await makeEnv();
    doc = (await env.call("ops", "GET", "/api/openapi.json")).body;
    if (process.env.UPDATE_CONTRACT === "1") writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
  });
  afterAll(() => env.db.close());

  it("matches the committed docs/openapi.json", () => {
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    expect(doc).toEqual(committed);
  });

  it("declares a body for every route that changes something, and a valid shape", () => {
    expect(doc.openapi).toBe("3.1.0");
    const ops = Object.entries(doc.paths as Record<string, Record<string, any>>).flatMap(([path, methods]) => Object.entries(methods).map(([m, op]) => ({ path, m, op })));
    expect(ops.length).toBeGreaterThan(130);
    const ids = new Set<string>();
    for (const { path, m, op } of ops) {
      expect(ids.has(op.operationId), `${m} ${path} operationId`).toBe(false);
      ids.add(op.operationId);
      for (const p of path.match(/\{(\w+)\}/g) ?? []) expect(op.parameters.some((x: any) => x.in === "path" && `{${x.name}}` === p), `${m} ${path} ${p}`).toBe(true);
    }
    // Every change states what it reads: a schema, or explicitly nothing (no route takes an unchecked body).
    const undeclared = ops.filter(({ m, op }) => m !== "get" && op.requestBody === undefined && !op["x-no-body"]);
    expect(undeclared.map(({ m, path }) => `${m} ${path}`)).toEqual([]);
    // Sign-in, the public intake, health and the webhook need no session; everything else does.
    expect(doc.paths["/api/auth/verify"].post.security).toEqual([]);
    expect(doc.paths["/api/ops/queue"].get.security).toBeUndefined();
  });

  it("is for MKW staff only", async () => {
    for (const who of ["anon", "client", "setup"]) expect((await env.call(who, "GET", "/api/openapi.json")).status).toBeGreaterThanOrEqual(401);
  });

  it("is built from the schema each handler parses with", () => {
    // Every declared body schema is the one its handler parses: `config: { body: X }` with `X.parse(req.body`.
    const dir = join(__dirname, "..", "src", "routes");
    const unused: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const m of text.matchAll(/config: \{ body: ([A-Za-z]+)(?:\.optional\(\))?[,} ]/g)) {
        if (m[1] !== "null" && !new RegExp(`${m[1]}\\.parse\\(req\\.body`).test(text)) unused.push(`${f}: ${m[1]}`);
      }
    }
    expect(unused).toEqual([]);
  });

  it("describes the schemas the handlers parse with", () => {
    const body = doc.paths["/api/milestones/{id}/review"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({
      type: "object",
      properties: { approve: { type: "boolean" }, reason: { type: "string", maxLength: 2000 } },
      required: ["approve"],
    });
    expect(doc.paths["/api/client/offers/{id}/accept"].post.requestBody.required).toBe(false);
    expect(doc.paths["/api/ops/search"].get.parameters).toEqual([{ name: "q", in: "query", required: false, schema: { type: "string", maxLength: 100, default: "" } }]);
  });

  it("converts the zod features the routes use and refuses others", () => {
    expect(jsonSchema(z.object({ a: z.string().uuid().nullish(), b: z.number().int().positive(), c: z.enum(["x", "y"]).default("x"), d: z.array(z.string().email()).min(1).max(3), e: z.literal(true) }))).toEqual({
      type: "object",
      properties: {
        a: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
        b: { type: "integer", exclusiveMinimum: 0 },
        c: { type: "string", enum: ["x", "y"], default: "x" },
        d: { type: "array", items: { type: "string", format: "email" }, minItems: 1, maxItems: 3 },
        e: { const: true },
      },
      required: ["b", "d", "e"],
    });
    expect(jsonSchema(z.object({ a: z.string() }).strict())).toMatchObject({ additionalProperties: false });
    expect(() => jsonSchema(z.date())).toThrow(UnsupportedSchema);
  });
});

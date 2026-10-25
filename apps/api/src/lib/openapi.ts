/**
 * The API contract (O13). Every route declares the body it reads (`config: { body: Schema }`, or `body: null` when it
 * reads none) and, where it has one, its query; `GET /api/openapi.json` serves an OpenAPI 3.1 document built from those
 * declarations, and `docs/openapi.json` is the committed copy a test keeps equal. The zod schemas the handlers parse
 * with are the same objects the contract is built from, so the two cannot drift.
 */
import type { FastifyInstance, RouteOptions } from "fastify";
import { z } from "zod";

/** The contract's version: raise it with any change a caller would notice. */
export const API_VERSION = "1.0.0";

export interface RouteDoc {
  method: string;
  url: string;
  body?: z.ZodType | null;
  query?: z.ZodType;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** The body this route reads: a zod schema, or null when it reads none (O13). */
    body?: unknown;
    /** The query this route reads, as a zod object. */
    query?: unknown;
  }
}

/** Collect every route as it is registered. Call before any route is added. */
export function collectRoutes(app: FastifyInstance): RouteDoc[] {
  const routes: RouteDoc[] = [];
  app.addHook("onRoute", (r: RouteOptions) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    const config = (r.config ?? {}) as { body?: z.ZodType | null; query?: z.ZodType };
    for (const method of methods) {
      if (method === "HEAD" || r.url === "/*") continue;
      routes.push({ method, url: r.url, body: config.body, query: config.query });
    }
  });
  return routes;
}

type Json = { [k: string]: unknown };

export class UnsupportedSchema extends Error {}

/**
 * A zod schema as JSON Schema 2020-12 (what OpenAPI 3.1 uses), from zod 4's own export (S1). Input form: a field with
 * a default is optional, as a caller sees it. A schema JSON cannot describe (a date, a transform) is refused.
 */
export function jsonSchema(schema: z.ZodType): Json {
  try {
    const { $schema: _drop, ...out } = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "throw" }) as Json;
    return out;
  } catch (e) {
    throw new UnsupportedSchema((e as Error).message);
  }
}

/** Routes anyone may call without signing in. */
const PUBLIC = [/^\/api\/auth\//, /^\/api\/public\//, /^\/api\/health/, /^\/api\/upload-rules$/, /^\/api\/webhooks\//];

export function openApiDocument(routes: RouteDoc[], version: string): Json {
  const paths: Record<string, Json> = {};
  const sorted = [...routes].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
  for (const r of sorted) {
    const path = r.url.replace(/:([A-Za-z_]+)/g, "{$1}");
    const params = [...r.url.matchAll(/:([A-Za-z_]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    if (r.query) {
      const q = jsonSchema(r.query) as { properties?: Record<string, Json>; required?: string[] };
      for (const [name, schema] of Object.entries(q.properties ?? {})) params.push({ name, in: "query", required: (q.required ?? []).includes(name), schema } as never);
    }
    const op: Json = {
      operationId: `${r.method.toLowerCase()}${path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))}`,
      tags: [r.url.split("/")[2] ?? "api"],
      ...(params.length ? { parameters: params } : {}),
      ...(r.body === null ? { "x-no-body": true } : {}),
      ...(r.body ? { requestBody: { required: !r.body.isOptional(), content: { "application/json": { schema: jsonSchema(r.body) } } } } : {}),
      responses: {
        "200": { description: "Success" },
        "4XX": { description: "Refused: the message says why", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "5XX": { description: "Server error, with a request id to quote", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
      ...(PUBLIC.some((p) => p.test(r.url)) ? { security: [] } : {}),
    };
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Tasees platform API",
      version,
      description: "Generated from the routes' own schemas (apps/api/src/lib/openapi.ts). Money is integer fils; rates are basis points.",
    },
    servers: [{ url: "/" }],
    security: [{ session: [] }, { bearer: [] }],
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "tasees_session" },
        bearer: { type: "http", scheme: "bearer" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" }, message: { type: "string" }, requestId: { type: "string" } },
          required: ["error", "message"],
        },
      },
    },
    paths,
  };
}

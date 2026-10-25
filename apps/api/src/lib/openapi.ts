/**
 * The API contract (O13). Every route declares the body it reads (`config: { body: Schema }`, or `body: null` when it
 * reads none) and, where it has one, its query; `GET /api/openapi.json` serves an OpenAPI 3.1 document built from those
 * declarations, and `docs/openapi.json` is the committed copy a test keeps equal. The zod schemas the handlers parse
 * with are the same objects the contract is built from, so the two cannot drift.
 *
 * The converter covers the zod features the routes use (objects, strings with their checks, numbers, booleans, enums,
 * literals, arrays, records, optional, nullable, defaults, refinements); anything else fails the contract test.
 */
import type { FastifyInstance, RouteOptions } from "fastify";
import { z } from "zod";

/** The contract's version: raise it with any change a caller would notice. */
export const API_VERSION = "1.0.0";

export interface RouteDoc {
  method: string;
  url: string;
  body?: z.ZodTypeAny | null;
  query?: z.ZodTypeAny;
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
    const config = (r.config ?? {}) as { body?: z.ZodTypeAny | null; query?: z.ZodTypeAny };
    for (const method of methods) {
      if (method === "HEAD" || r.url === "/*") continue;
      routes.push({ method, url: r.url, body: config.body, query: config.query });
    }
  });
  return routes;
}

type Json = { [k: string]: unknown };

export class UnsupportedSchema extends Error {}

/** zod 3 to JSON Schema (2020-12, as OpenAPI 3.1 uses). */
export function jsonSchema(schema: z.ZodTypeAny): Json {
  const def = schema._def as { typeName: string; [k: string]: any };
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const properties: Json = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = jsonSchema(v);
        if (!v.isOptional()) required.push(k);
      }
      return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: def.unknownKeys === "passthrough" };
    }
    case "ZodString": {
      const out: Json = { type: "string" };
      for (const c of def.checks as Array<{ kind: string; value?: number; regex?: RegExp }>) {
        if (c.kind === "min") out.minLength = c.value;
        else if (c.kind === "max") out.maxLength = c.value;
        else if (c.kind === "length") out.minLength = out.maxLength = c.value;
        else if (c.kind === "email") out.format = "email";
        else if (c.kind === "uuid") out.format = "uuid";
        else if (c.kind === "url") out.format = "uri";
        else if (c.kind === "regex") out.pattern = c.regex!.source;
        else if (c.kind === "datetime") out.format = "date-time";
        else if (c.kind === "date") out.format = "date";
        else if (c.kind !== "trim" && c.kind !== "toLowerCase" && c.kind !== "toUpperCase") throw new UnsupportedSchema(`string check ${c.kind}`);
      }
      return out;
    }
    case "ZodNumber": {
      const out: Json = { type: "number" };
      for (const c of def.checks as Array<{ kind: string; value?: number; inclusive?: boolean }>) {
        if (c.kind === "int") out.type = "integer";
        else if (c.kind === "min") out[c.inclusive ? "minimum" : "exclusiveMinimum"] = c.value;
        else if (c.kind === "max") out[c.inclusive ? "maximum" : "exclusiveMaximum"] = c.value;
        else if (c.kind === "finite") continue;
        else throw new UnsupportedSchema(`number check ${c.kind}`);
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: [...(def.values as string[])] };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodArray": {
      const out: Json = { type: "array", items: jsonSchema(def.type) };
      if (def.minLength) out.minItems = def.minLength.value;
      if (def.maxLength) out.maxItems = def.maxLength.value;
      return out;
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: jsonSchema(def.valueType) };
    case "ZodOptional":
      return jsonSchema(def.innerType);
    case "ZodNullable": {
      const inner = jsonSchema(def.innerType);
      return { anyOf: [inner, { type: "null" }] };
    }
    case "ZodDefault":
      return { ...jsonSchema(def.innerType), default: def.defaultValue() };
    case "ZodEffects":
      return jsonSchema(def.schema);
    case "ZodUnion":
      return { anyOf: (def.options as z.ZodTypeAny[]).map(jsonSchema) };
    case "ZodUnknown":
    case "ZodAny":
      return {};
    default:
      throw new UnsupportedSchema(def.typeName);
  }
}

/** Routes anyone may call without signing in. */
const PUBLIC = [/^\/api\/auth\//, /^\/api\/public\//, /^\/api\/health/, /^\/api\/upload-rules$/, /^\/api\/webhooks\//, /^\/api\/openapi\.json$/];

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

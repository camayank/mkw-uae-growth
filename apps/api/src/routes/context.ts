import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Database } from "../lib/db.ts";
import type { RouteDoc } from "../lib/openapi.ts";
import type { Deps } from "../services/engagements.ts";
import type { AppOptions } from "../server.ts";

/** What every route module receives from `buildApp` (O13). */
export interface RouteContext {
  app: FastifyInstance;
  /** The database, on the request clock in tests. */
  db: Database;
  opts: AppOptions;
  deps: Deps;
  /** Per-IP limit on a bucket of public endpoints, per 15 minutes. */
  throttle: (req: FastifyRequest, bucket: string, max: number) => void;
  /** A file sent as base64 in a JSON body. */
  fileBody: z.ZodObject<{ fileName: z.ZodString; contentBase64: z.ZodString }>;
  /** Store a file through the storage adapter; its refusals become a 400 with the adapter's reason. */
  putFile: (folder: string, fileName: string, contentBase64: string) => Promise<string>;
  routeDocs: RouteDoc[];
  /** The Arabic sign-off flag as health last read it; reset when the review is recorded. */
  arabic: { flag: { value: boolean; at: number } | null };
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Database, Queryable } from "../lib/db.ts";
import type { SessionUser } from "../lib/context.ts";
import type { UploadDeps } from "../lib/uploads.ts";
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
  /**
   * Store an upload in the caller's transaction (E22): its content is checked against its name, it is scanned, and its
   * scan is recorded. A refusal is a 400 with the reason. Returns the storage key.
   */
  putFile: (tx: Queryable, actor: SessionUser, folder: string, fileName: string, contentBase64: string) => Promise<string>;
  /** What the upload checks and the download guard need: storage, the scanner, and the owner's T6 choice. */
  uploads: UploadDeps;
  routeDocs: RouteDoc[];
  /** The Arabic sign-off flag as health last read it; reset when the review is recorded. */
  arabic: { flag: { value: boolean; at: number } | null };
}

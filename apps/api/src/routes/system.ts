import { asPlatform } from "../lib/context.ts";
import { API_VERSION, openApiDocument } from "../lib/openapi.ts";
import { arabicStatus } from "../services/locale.ts";
import { jobHealth } from "../services/system.ts";
import type { RouteContext } from "./context.ts";

/** Health checks and the API contract. */
export function registerSystemRoutes(ctx: RouteContext) {
  const { app, db, opts, routeDocs } = ctx;

  // System: health and the contract (O13) ----------------------------------------------------------
  // Health stays cheap: the Arabic flag is read at most every 30 seconds (reset when the review is recorded).
  app.get("/api/health", async () => {
    if (!ctx.arabic.flag || Date.now() - ctx.arabic.flag.at > 30_000) ctx.arabic.flag = { value: (await asPlatform(db, null, (tx) => arabicStatus(tx))).reviewed, at: Date.now() };
    return { ok: true, db: db.kind, devLogin: !!opts.devLogin, arabic: ctx.arabic.flag.value };
  });

  // The API contract, built from the routes' own schemas (O13). docs/openapi.json is the committed copy.
  app.get("/api/openapi.json", async () => openApiDocument(routeDocs, API_VERSION));

  // For an external monitor (O13): 503 when the scheduled jobs have not completed for 45 minutes. Times only.
  app.get("/api/health/jobs", async (_req, reply) => {
    const health = await asPlatform(db, null, (tx) => jobHealth(tx, opts.startedAt ?? null));
    return reply.status(health.ok ? 200 : 503).send(health);
  });
}

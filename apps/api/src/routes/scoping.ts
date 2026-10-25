import { z } from "zod";
import { aed } from "@tasees/core";
import { PLATFORM_ROLES, requireRole } from "../lib/auth.ts";
import { asPlatform } from "../lib/context.ts";
import { approveAdvice, recomputeAdvice, requestScoping, scopingOverview, search, verifyRule, verifyZone } from "../services/scoping.ts";
import { listDrafts, reviewDraft } from "../services/drafts.ts";
import { markPaymentPaid } from "../services/engagements.ts";
import type { RouteContext } from "./context.ts";

/** Public intake, leads, scoping advice, AI drafts, search and the payment webhook. */
export function registerScopingRoutes(ctx: RouteContext) {
  const { app, db, opts, deps, throttle } = ctx;

  // Scoping intelligence (O5) --------------------------------------------------------------------
  app.get("/api/admin/scoping", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => scopingOverview(tx));
  });

  const AdminScopingRulesBody = z.object({ confidence: z.enum(["verified", "rule_of_thumb", "UNCERTAIN"]), verifiedBy: z.string().max(120).optional(), sourceUrl: z.string().max(500).optional(), statement: z.string().max(1000).optional() });
  app.put<{ Params: { key: string } }>("/api/admin/scoping/rules/:key", { config: { body: AdminScopingRulesBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminScopingRulesBody.parse(req.body);
    return asPlatform(db, user, (tx) => verifyRule(tx, user, req.params.key, body));
  });

  const AdminScopingZonesBody = z.object({
      confidence: z.enum(["verified", "rule_of_thumb", "UNCERTAIN"]),
      verifiedBy: z.string().max(120).optional(),
      sourceUrl: z.string().max(500).optional(),
      costMinAed: z.number().min(0).optional(),
      costMaxAed: z.number().min(0).optional(),
      visaQuota: z.number().int().min(0).max(100).optional(),
      timelineDays: z.number().int().min(1).max(365).optional(),
      active: z.boolean().optional(),
    });
  app.put<{ Params: { name: string } }>("/api/admin/scoping/zones/:name", { config: { body: AdminScopingZonesBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminScopingZonesBody.parse(req.body);
    return asPlatform(db, user, (tx) =>
      verifyZone(tx, user, req.params.name, { ...body, costMinFils: body.costMinAed === undefined ? undefined : aed(body.costMinAed), costMaxFils: body.costMaxAed === undefined ? undefined : aed(body.costMaxAed) }),
    );
  });

  app.get<{ Params: { id: string } }>("/api/ops/requests/:id/scoping", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => requestScoping(tx, req.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/ops/requests/:id/scoping/recompute", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => recomputeAdvice(tx, user, req.params.id));
  });

  const OpsRequestsScopingApproveBody = z.object({
      removeRuleKeys: z.array(z.string().max(80)).max(50).optional(),
      structure: z.enum(["free_zone", "mainland", "offshore", "difc_adgm"]).optional(),
      removePlaces: z.array(z.string().max(80)).max(20).optional(),
      note: z.string().max(500).optional(),
    });
  app.post<{ Params: { id: string } }>("/api/ops/requests/:id/scoping/approve", { config: { body: OpsRequestsScopingApproveBody.optional() } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsRequestsScopingApproveBody.parse(req.body ?? {});
    return asPlatform(db, user, (tx) => approveAdvice(tx, user, req.params.id, body));
  });

  const OpsDraftsQuery = z.object({ status: z.enum(["pending", "approved", "discarded"]).default("pending") });
  app.get("/api/ops/drafts", { config: { query: OpsDraftsQuery.optional() } }, async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    const { status } = OpsDraftsQuery.parse(req.query ?? {});
    return asPlatform(db, user, (tx) => listDrafts(tx, status));
  });

  const OpsDraftsReviewBody = z.object({ decision: z.enum(["approve", "discard"]), note: z.string().max(500).default(""), keepCodes: z.array(z.string().max(20)).max(40).optional() });
  app.post<{ Params: { id: string } }>("/api/ops/drafts/:id/review", { config: { body: OpsDraftsReviewBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsDraftsReviewBody.parse(req.body);
    return asPlatform(db, user, (tx) => reviewDraft(tx, user, req.params.id, body.decision, body.note, body.keepCodes));
  });

  const OpsSearchQuery = z.object({ q: z.string().max(100).default("") });
  app.get("/api/ops/search", { config: { query: OpsSearchQuery.optional() } }, async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    const { q } = OpsSearchQuery.parse(req.query ?? {});
    return asPlatform(db, user, (tx) => search(tx, q));
  });

  // Payment provider webhook: a signed message from the provider is the one automated path that records money.
  app.post("/api/webhooks/payments", { config: { body: null } }, async (req, reply) => {
    let event;
    // Unauthenticated callers must not be able to grow the audit chain: refusals are logged and rate-limited, not audited.
    throttle(req, "webhook", 60);
    try {
      event = opts.provider.verifyWebhook(req.rawBody ?? "", req.headers);
    } catch (e) {
      app.log.warn({ ip: req.ip, reason: (e as Error).message }, "payment webhook refused");
      return reply.status(401).send({ error: "unauthorised", message: `Webhook refused: ${(e as Error).message}` });
    }
    await asPlatform(db, null, (tx) => markPaymentPaid(tx, null, event.paymentId, event.reference, deps, event.amountFils));
    return { ok: true };
  });
}

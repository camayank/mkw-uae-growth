import { z } from "zod";
import { aed, type Tier } from "@tasees/core";
import { PLATFORM_ROLES, requireRole, requireUser } from "../lib/auth.ts";
import { asPlatform, audit } from "../lib/context.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { openQueueItem, opsQueue, syncQueueTimings } from "../services/queue.ts";
import { resolveOutbox } from "../lib/outbox.ts";
import { markPaymentPaid, openQuoteRequest, qaMilestone, releasePayout, resolveDispute, runAllocation } from "../services/engagements.ts";
import { runJobs } from "../jobs/run.ts";
import { systemOverview } from "../services/system.ts";
import { buildOffers, overrideLinePrice, publishOffer } from "../services/pricing.ts";
import { auditTrail, deliveryLog, myNotifications, opsOffer, opsOverview } from "../services/views.ts";
import type { RouteContext } from "./context.ts";

/** MKW's own screens: the queue, offers, QA, payments, jobs, the System page, notifications. */
export function registerOpsRoutes(ctx: RouteContext) {
  const { app, db, opts, deps } = ctx;

  // Platform -----------------------------------------------------------------
  app.get("/api/ops/overview", async (req) => opsOverview(db, requireRole(req, ...PLATFORM_ROLES)));

  // The ops command centre (O11): the ranked queue. Computing it also keeps the queue timings in step.
  app.get("/api/ops/queue", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, async (tx) => {
      const items = await opsQueue(tx, user, opts.now ? opts.now() : new Date());
      await syncQueueTimings(tx, items);
      return { items };
    });
  });
  const OpsQueueOpenBody = z.object({ id: z.string().min(3).max(120) });
  app.post("/api/ops/queue/open", { config: { body: OpsQueueOpenBody } }, async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    const { id } = OpsQueueOpenBody.parse(req.body);
    return asPlatform(db, user, (tx) => openQueueItem(tx, user, id));
  });
  const OpsOutboxResolveBody = z.object({ action: z.enum(["retry", "mark_delivered", "cancel"]), note: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/outbox/:id/resolve", { config: { body: OpsOutboxResolveBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsOutboxResolveBody.parse(req.body);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw badRequest("Unknown message");
    if (body.action !== "retry" && !body.note.trim()) throw badRequest("Say why: it goes into the record");
    return asPlatform(db, user, (tx) => resolveOutbox(tx, user, id, body.action, body.note.trim()));
  });
  app.get<{ Params: { id: string } }>("/api/ops/offers/:id", async (req) => opsOffer(db, requireRole(req, ...PLATFORM_ROLES), req.params.id));

  app.get("/api/ops/clients", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, async (tx) => (await tx.query("select id, name from orgs where type = 'client' order by name")).rows);
  });

  const OpsClientsBody = z.object({ company: z.string().min(2).max(200), ownerName: z.string().min(2).max(120), ownerEmail: z.string().email() });
  app.post("/api/ops/clients", { config: { body: OpsClientsBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsClientsBody.parse(req.body);
    return asPlatform(db, user, async (tx) => {
      const org = (await tx.query<{ id: string }>("insert into orgs (type, name) values ('client', $1) returning id", [body.company])).rows[0]!;
      await tx.query("insert into users (org_id, email, name, role) values ($1, $2, $3, 'client_owner')", [org.id, body.ownerEmail.toLowerCase(), body.ownerName]);
      await audit(tx, user, "client.created", "org", org.id, { company: body.company });
      return { id: org.id };
    });
  });

  const OpsRequestsBuildOffersBody = z.object({ tiers: z.array(z.enum(["essential", "standard", "priority"])).min(1).optional() });
  app.post<{ Params: { id: string } }>("/api/ops/requests/:id/build-offers", { config: { body: OpsRequestsBuildOffersBody.optional() } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsRequestsBuildOffersBody.parse(req.body ?? {});
    return asPlatform(db, user, (tx) => buildOffers(tx, user, req.params.id, body.tiers as Tier[] | undefined));
  });

  const OpsRequestsRfqBody = z.object({ codes: z.array(z.string()).min(1) });
  app.post<{ Params: { id: string } }>("/api/ops/requests/:id/rfq", { config: { body: OpsRequestsRfqBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { codes } = OpsRequestsRfqBody.parse(req.body);
    return asPlatform(db, user, (tx) => openQuoteRequest(tx, user, req.params.id, codes, deps));
  });

  const OpsOffersPublishBody = z.object({ acknowledgeReview: z.boolean().default(false) });
  app.post<{ Params: { id: string } }>("/api/ops/offers/:id/publish", { config: { body: OpsOffersPublishBody.optional() } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { acknowledgeReview } = OpsOffersPublishBody.parse(req.body ?? {});
    await asPlatform(db, user, async (tx) => {
      await publishOffer(tx, user, req.params.id, acknowledgeReview);
      const o = (await tx.query<{ client_org_id: string; id: string }>("select client_org_id, id from offers where id = $1", [req.params.id])).rows[0]!;
      const owners = (await tx.query<{ email: string }>("select email from users where org_id = $1 and role = 'client_owner' and status = 'active'", [o.client_org_id])).rows;
      for (const u of owners) await opts.notify.send({ to: u.email, channel: "email", template: "offer_ready", vars: { offerId: o.id } });
    });
    return { ok: true };
  });

  const OpsOffersLinesPriceBody = z.object({ clientUnitAed: z.number().positive() });
  app.post<{ Params: { id: string; code: string } }>("/api/ops/offers/:id/lines/:code/price", { config: { body: OpsOffersLinesPriceBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { clientUnitAed } = OpsOffersLinesPriceBody.parse(req.body);
    await asPlatform(db, user, (tx) => overrideLinePrice(tx, user, req.params.id, req.params.code, aed(clientUnitAed)));
    return { ok: true };
  });

  const OpsMilestonesQaBody = z.object({ pass: z.boolean(), note: z.string().max(2000).optional() });
  app.post<{ Params: { id: string } }>("/api/ops/milestones/:id/qa", { config: { body: OpsMilestonesQaBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsMilestonesQaBody.parse(req.body);
    await asPlatform(db, user, (tx) => qaMilestone(tx, user, req.params.id, body.pass, body.note, deps));
    return { ok: true };
  });

  const OpsMilestonesResolveBody = z.object({ outcome: z.enum(["rework", "approve"]) });
  app.post<{ Params: { id: string } }>("/api/ops/milestones/:id/resolve", { config: { body: OpsMilestonesResolveBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { outcome } = OpsMilestonesResolveBody.parse(req.body);
    await asPlatform(db, user, (tx) => resolveDispute(tx, user, req.params.id, outcome, deps));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/ops/engagements/:id/reallocate", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => runAllocation(tx, user, req.params.id, deps));
  });

  const OpsPaymentsMarkPaidBody = z.object({ reference: z.string().min(3).max(120) });
  app.post<{ Params: { id: string } }>("/api/ops/payments/:id/mark-paid", { config: { body: OpsPaymentsMarkPaidBody } }, async (req) => {
    const user = requireRole(req, "finance", "founder");
    const { reference } = OpsPaymentsMarkPaidBody.parse(req.body);
    await asPlatform(db, user, (tx) => markPaymentPaid(tx, user, req.params.id, reference, deps));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/ops/payouts/:id/release", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "finance", "founder");
    await asPlatform(db, user, (tx) => releasePayout(tx, user, req.params.id, deps));
    return { ok: true };
  });

  const Profile = z.object({
    quality: z.number().min(0).max(100).optional(),
    capacity: z.number().int().min(0).max(500).optional(),
    licenceActive: z.boolean().optional(),
    agreementSigned: z.boolean().optional(),
    emirates: z.array(z.string()).optional(),
    codes: z.array(z.string()).optional(),
    ftaTaxAgent: z.boolean().optional(),
    licensedLawFirm: z.boolean().optional(),
    regulatoryAdviser: z.boolean().optional(),
    approvedAuditorZones: z.array(z.string()).optional(),
    registeredLiquidator: z.boolean().optional(),
  });
  app.put<{ Params: { id: string } }>("/api/ops/partners/:id", { config: { body: Profile } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    // Status moves go through POST /api/ops/partners/:id/status only: that route checks the licence and agreement
    // gates, records why, tells the firm and (O10) sends the held invitation when the firm reaches pilot.
    if (req.body && typeof req.body === "object" && "status" in (req.body as object)) throw badRequest("Move a partner through onboarding with the status move, not the profile edit");
    const patch = Profile.parse(req.body);
    return asPlatform(db, user, async (tx) => {
      const r = await tx.query("update orgs set profile = profile || $2::jsonb where id = $1 and type = 'partner' returning id", [req.params.id, JSON.stringify(patch)]);
      if (r.rows.length === 0) throw notFound("Partner not found");
      await audit(tx, user, "partner.updated", "org", req.params.id, patch);
      return { ok: true };
    });
  });

  app.get("/api/ops/audit", async (req) => auditTrail(db, requireRole(req, "finance", "founder", "ops")));

  app.post("/api/ops/jobs/run", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    return runJobs(db, deps, user, { alertEmail: opts.alertEmail, log: (line) => req.log.info(line) });
  });

  // The platform watching itself (O13): runs, steps, the outbox backlog, alerts and the audit checks. No personal data.
  app.get("/api/ops/system", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => systemOverview(tx));
  });

  // Notifications: each person's own bell ---------------------------------------------------------
  app.get("/api/notifications", async (req) => {
    const user = requireUser(req);
    return myNotifications(db, user);
  });

  const NotificationsReadBody = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });
  app.post("/api/notifications/read", { config: { body: NotificationsReadBody.optional() } }, async (req) => {
    const user = requireUser(req);
    const body = NotificationsReadBody.parse(req.body ?? {});
    return asPlatform(db, user, async (tx) => {
      const r = await tx.query(
        body.ids?.length
          ? "update notifications set read_at = app_now() where user_id = $1 and read_at is null and id = any($2::uuid[]) returning id"
          : "update notifications set read_at = app_now() where user_id = $1 and read_at is null returning id",
        body.ids?.length ? [user.id, body.ids] : [user.id],
      );
      return { ok: true, marked: r.rows.length };
    });
  });

  app.get("/api/admin/notifications", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return deliveryLog(db, user);
  });
}

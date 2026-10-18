import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { aed, type Tier } from "@tasees/core";
import {
  CLIENT_ROLES,
  issueLoginCode,
  PARTNER_ROLES,
  PLATFORM_ROLES,
  requireRole,
  requireUser,
  revokeSession,
  userFromToken,
  verifyLoginCode,
} from "./lib/auth.ts";
import { asPlatform, asUser, audit } from "./lib/context.ts";
import { withClock, type Database } from "./lib/db.ts";
import { badRequest, HttpError, notFound } from "./lib/errors.ts";
import type { Notifier } from "./lib/notify.ts";
import type { Storage } from "./lib/storage.ts";
import {
  acceptOffer,
  addEvidence,
  clientReviewMilestone,
  decideChangeOrder,
  markPaymentPaid,
  openQuoteRequest,
  postMessage,
  proposeChangeOrder,
  qaMilestone,
  releasePayout,
  resolveDispute,
  respondToAllocation,
  runAllocation,
  startMilestone,
  submitMilestone,
  submitQuote,
  type Deps,
} from "./services/engagements.ts";
import { runJobs } from "./jobs/run.ts";
import { buildOffers, overrideLinePrice, publishOffer } from "./services/pricing.ts";
import { createRequest, IntakeSchema } from "./services/requests.ts";
import {
  changeRole,
  confirmRetention,
  createPartner,
  deactivateUser,
  erasePerson,
  exportPerson,
  getRetention,
  inviteUser,
  listOrganisations,
  reactivateUser,
} from "./services/admin.ts";
import { auditTrail, clientHome, clientOffer, deliveryLog, myNotifications, opsEngagement, opsOffer, opsOverview, partnerHome, partyEngagement } from "./services/views.ts";

export interface AppOptions {
  db: Database;
  notify: Notifier;
  storage: Storage;
  now?: () => Date;
  /** Return one-time login codes in the response. Development only. */
  devLogin?: boolean;
  webhookSecret?: string;
  webDir?: string;
  logger?: boolean;
}

const COOKIE = "tasees_session";

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  const db = withClock(opts.db, opts.now);
  const deps: Deps = { notify: opts.notify, now: opts.now };

  // Queued notifications go out once the response is on its way, after every transaction of the request.
  app.addHook("onResponse", async () => {
    await opts.notify.flush();
  });

  app.addHook("onRequest", async (req) => {
    const token = bearer(req) ?? cookie(req, COOKIE);
    if (token) req.user = (await userFromToken(db, token)) ?? undefined;
  });

  // Per-IP limit on the sign-in endpoints, per 15 minutes. In-process; put a shared limiter at the proxy when running
  // more than one instance.
  const hits = new Map<string, { n: number; until: number }>();
  const throttle = (req: FastifyRequest, bucket: string, max: number) => {
    const key = `${bucket}:${req.ip}`;
    const t = Date.now();
    const h = hits.get(key);
    if (!h || h.until < t) hits.set(key, { n: 1, until: t + 15 * 60 * 1000 });
    else if (++h.n > max) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.", "too_many_requests");
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < t) hits.delete(k);
  };

  // Security headers for every response. The web app uses only same-origin scripts and styles.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!opts.devLogin) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "bad_request", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    if ((err as Error).name === "TransitionError") return reply.status(409).send({ error: "conflict", message: (err as Error).message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: "server_error", message: "Something went wrong on our side. Try again in a minute." });
  });

  // Auth ---------------------------------------------------------------------
  app.post("/api/auth/request-code", async (req) => {
    throttle(req, "request-code", 20);
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const { code, known, limited } = await issueLoginCode(db, email);
    const issued = known && !limited;
    if (issued) await opts.notify.send({ to: email.toLowerCase(), channel: "email", template: "login_code", vars: { code } });
    // Same answer whether or not the email has an account (or was throttled), so it cannot be used to probe accounts.
    return { ok: true, ...(opts.devLogin && issued ? { devCode: code } : {}) };
  });

  app.post("/api/auth/verify", async (req, reply) => {
    throttle(req, "verify", 30);
    const body = z.object({ email: z.string().email(), code: z.string().min(4).max(10) }).parse(req.body);
    const { token, user } = await verifyLoginCode(db, body.email, body.code);
    reply.header("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${opts.devLogin ? "" : "; Secure"}`);
    return { token, user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = bearer(req) ?? cookie(req, COOKIE);
    if (token) await revokeSession(db, token);
    reply.header("set-cookie", `${COOKIE}=; Path=/; Max-Age=0`);
    return { ok: true };
  });

  app.get("/api/me", async (req) => publicUser(requireUser(req)));

  // Catalogue (any signed-in user) ------------------------------------------------
  app.get("/api/deliverables", async (req) => {
    const user = requireUser(req);
    return asUser(db, user, async (tx) =>
      (await tx.query("select code, name, category, model, billing from deliverables order by category, code")).rows,
    );
  });

  // Client -------------------------------------------------------------------
  app.get("/api/client/home", async (req) => clientHome(db, requireRole(req, ...CLIENT_ROLES)));

  app.post("/api/requests", async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES, "ops", "founder");
    const body = z
      .object({ answers: IntakeSchema, clientOrgId: z.string().uuid().optional(), sourcedByPartnerId: z.string().uuid().nullish() })
      .parse(req.body);
    return asPlatform(db, user, (tx) => createRequest(tx, user, body.answers, body.clientOrgId, body.sourcedByPartnerId));
  });

  app.get<{ Params: { id: string } }>("/api/client/offers/:id", async (req) =>
    clientOffer(db, requireRole(req, ...CLIENT_ROLES), req.params.id),
  );

  app.post<{ Params: { id: string } }>("/api/client/offers/:id/accept", async (req) => {
    const user = requireRole(req, "client_owner");
    const engagementId = await asPlatform(db, user, (tx) => acceptOffer(tx, user, req.params.id, deps));
    return { engagementId };
  });

  app.post<{ Params: { id: string } }>("/api/milestones/:id/review", async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES);
    const body = z.object({ approve: z.boolean(), reason: z.string().max(2000).optional() }).parse(req.body);
    await asPlatform(db, user, (tx) => clientReviewMilestone(tx, user, req.params.id, body.approve, body.reason, deps));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/change-orders/:id/decide", async (req) => {
    const user = requireRole(req, "client_owner");
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
    await asPlatform(db, user, (tx) => decideChangeOrder(tx, user, req.params.id, approve, deps));
    return { ok: true };
  });

  // Shared engagement view and messages -----------------------------------------------
  app.get<{ Params: { id: string } }>("/api/engagements/:id", async (req) => {
    const user = requireUser(req);
    if (user.orgType === "platform") return opsEngagement(db, user, req.params.id);
    return partyEngagement(db, user, req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/engagements/:id/messages", async (req) => {
    const user = requireUser(req);
    const { body } = z.object({ body: z.string() }).parse(req.body);
    await asPlatform(db, user, (tx) => postMessage(tx, user, req.params.id, body));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/evidence/:id/file", async (req, reply) => {
    const user = requireUser(req);
    // The visibility check runs under the user's own database role.
    const row =
      user.orgType === "platform"
        ? await asPlatform(db, user, async (tx) => (await tx.query<{ file_key: string; file_name: string }>("select file_key, file_name from evidence where id = $1", [req.params.id])).rows[0])
        : await asUser(db, user, async (tx) => (await tx.query<{ id: string; file_name: string }>("select id, file_name from evidence where id = $1", [req.params.id])).rows[0]);
    if (!row) throw notFound("File not found");
    const key = await asPlatform(db, user, async (tx) => (await tx.query<{ file_key: string }>("select file_key from evidence where id = $1", [req.params.id])).rows[0]!.file_key);
    const data = await opts.storage.get(key);
    reply.header("content-disposition", `attachment; filename="${row.file_name.replace(/"/g, "")}"`);
    return reply.type("application/octet-stream").send(data);
  });

  // Partner ------------------------------------------------------------------
  app.get("/api/partner/home", async (req) => partnerHome(db, requireRole(req, ...PARTNER_ROLES)));

  app.post<{ Params: { id: string } }>("/api/allocations/:id/respond", async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = z.object({ decision: z.enum(["accept", "decline"]), reason: z.string().max(500).optional() }).parse(req.body);
    await asPlatform(db, user, (tx) => respondToAllocation(tx, user, req.params.id, body.decision, body.reason, deps));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/milestones/:id/start", async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES);
    await asPlatform(db, user, (tx) => startMilestone(tx, user, req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/milestones/:id/evidence", async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES);
    const body = z
      .object({ type: z.string().min(2).max(60), fileName: z.string().min(1).max(200), contentBase64: z.string().min(1) })
      .parse(req.body);
    const m = await asUser(db, user, async (tx) =>
      (await tx.query<{ engagement_id: string }>("select engagement_id from milestones where id = $1", [req.params.id])).rows[0],
    );
    if (!m) throw notFound("Milestone not found");
    let key: string;
    try {
      key = await opts.storage.put(m.engagement_id, body.fileName, Buffer.from(body.contentBase64, "base64"));
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    await asPlatform(db, user, (tx) => addEvidence(tx, user, req.params.id, { type: body.type, key, name: body.fileName }));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/milestones/:id/submit", async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES);
    await asPlatform(db, user, (tx) => submitMilestone(tx, user, req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/engagements/:id/change-orders", async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = z.object({ description: z.string().min(3).max(2000), partnerCostAed: z.number().positive().max(10_000_000) }).parse(req.body);
    const id = await asPlatform(db, user, (tx) => proposeChangeOrder(tx, user, req.params.id, body.description, aed(body.partnerCostAed), deps));
    return { id };
  });

  app.post<{ Params: { id: string } }>("/api/rfqs/:id/quote", async (req) => {
    const user = requireRole(req, "partner_admin");
    const Line = z.object({
      code: z.string(),
      professionalAed: z.number().min(0),
      govStatedAed: z.number().min(0).default(0),
      thirdPartyAed: z.number().min(0).default(0),
      workingDays: z.number().int().min(1).max(365),
      exclusions: z.array(z.string().max(200)).max(20).default([]),
      assumptions: z.string().max(2000).default(""),
    });
    const { lines } = z.object({ lines: z.array(Line).min(1).max(30) }).parse(req.body);
    const id = await asPlatform(db, user, (tx) =>
      submitQuote(
        tx,
        user,
        req.params.id,
        lines.map((l) => ({
          code: l.code,
          professionalFils: aed(l.professionalAed),
          govStatedFils: aed(l.govStatedAed),
          thirdPartyFils: aed(l.thirdPartyAed),
          workingDays: l.workingDays,
          exclusions: l.exclusions,
          assumptions: l.assumptions,
        })),
        deps,
      ),
    );
    return { id };
  });

  app.put("/api/partner/rate-cards", async (req) => {
    const user = requireRole(req, "partner_admin");
    const Card = z.object({
      code: z.string(),
      professionalAed: z.number().min(0),
      govStatedAed: z.number().min(0).default(0),
      thirdPartyAed: z.number().min(0).default(0),
      workingDays: z.number().int().min(1).max(365),
      exclusions: z.array(z.string().max(200)).max(20).default([]),
    });
    const { cards } = z.object({ cards: z.array(Card).min(1).max(40) }).parse(req.body);
    return asPlatform(db, user, async (tx) => {
      const known = new Set((await tx.query<{ code: string }>("select code from deliverables")).rows.map((r) => r.code));
      for (const c of cards) {
        if (!known.has(c.code)) throw badRequest(`Unknown service code ${c.code}`);
        // Cards last 90 days, as the partner agreement says.
        await tx.query(
          `insert into rate_cards (partner_org_id, code, professional_fils, gov_stated_fils, third_party_fils, working_days, exclusions, valid_to)
           values ($1,$2,$3,$4,$5,$6,$7, app_now()::date + 90)
           on conflict (partner_org_id, code) do update set professional_fils = excluded.professional_fils,
             gov_stated_fils = excluded.gov_stated_fils, third_party_fils = excluded.third_party_fils,
             working_days = excluded.working_days, exclusions = excluded.exclusions, valid_to = excluded.valid_to, updated_at = app_now()`,
          [user.orgId, c.code, aed(c.professionalAed), aed(c.govStatedAed), aed(c.thirdPartyAed), c.workingDays, c.exclusions],
        );
      }
      await audit(tx, user, "rate_cards.updated", "org", user.orgId, { codes: cards.map((c) => c.code) });
      return { ok: true, updated: cards.length };
    });
  });

  // Platform -----------------------------------------------------------------
  app.get("/api/ops/overview", async (req) => opsOverview(db, requireRole(req, ...PLATFORM_ROLES)));
  app.get<{ Params: { id: string } }>("/api/ops/offers/:id", async (req) => opsOffer(db, requireRole(req, ...PLATFORM_ROLES), req.params.id));

  app.get("/api/ops/clients", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, async (tx) => (await tx.query("select id, name from orgs where type = 'client' order by name")).rows);
  });

  app.post("/api/ops/clients", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = z.object({ company: z.string().min(2).max(200), ownerName: z.string().min(2).max(120), ownerEmail: z.string().email() }).parse(req.body);
    return asPlatform(db, user, async (tx) => {
      const org = (await tx.query<{ id: string }>("insert into orgs (type, name) values ('client', $1) returning id", [body.company])).rows[0]!;
      await tx.query("insert into users (org_id, email, name, role) values ($1, $2, $3, 'client_owner')", [org.id, body.ownerEmail.toLowerCase(), body.ownerName]);
      await audit(tx, user, "client.created", "org", org.id, { company: body.company });
      return { id: org.id };
    });
  });

  app.post<{ Params: { id: string } }>("/api/ops/requests/:id/build-offers", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = z.object({ tiers: z.array(z.enum(["essential", "standard", "priority"])).min(1).optional() }).parse(req.body ?? {});
    return asPlatform(db, user, (tx) => buildOffers(tx, user, req.params.id, body.tiers as Tier[] | undefined));
  });

  app.post<{ Params: { id: string } }>("/api/ops/requests/:id/rfq", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { codes } = z.object({ codes: z.array(z.string()).min(1) }).parse(req.body);
    return asPlatform(db, user, (tx) => openQuoteRequest(tx, user, req.params.id, codes, deps));
  });

  app.post<{ Params: { id: string } }>("/api/ops/offers/:id/publish", async (req) => {
    const user = requireRole(req, "ops", "founder");
    await asPlatform(db, user, async (tx) => {
      await publishOffer(tx, user, req.params.id);
      const o = (await tx.query<{ client_org_id: string; id: string }>("select client_org_id, id from offers where id = $1", [req.params.id])).rows[0]!;
      const owners = (await tx.query<{ email: string }>("select email from users where org_id = $1 and role = 'client_owner' and status = 'active'", [o.client_org_id])).rows;
      for (const u of owners) await opts.notify.send({ to: u.email, channel: "email", template: "offer_ready", vars: { offerId: o.id } });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string; code: string } }>("/api/ops/offers/:id/lines/:code/price", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { clientUnitAed } = z.object({ clientUnitAed: z.number().positive() }).parse(req.body);
    await asPlatform(db, user, (tx) => overrideLinePrice(tx, user, req.params.id, req.params.code, aed(clientUnitAed)));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/ops/milestones/:id/qa", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = z.object({ pass: z.boolean(), note: z.string().max(2000).optional() }).parse(req.body);
    await asPlatform(db, user, (tx) => qaMilestone(tx, user, req.params.id, body.pass, body.note, deps));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/ops/milestones/:id/resolve", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { outcome } = z.object({ outcome: z.enum(["rework", "approve"]) }).parse(req.body);
    await asPlatform(db, user, (tx) => resolveDispute(tx, user, req.params.id, outcome, deps));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/ops/engagements/:id/reallocate", async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => runAllocation(tx, user, req.params.id, deps));
  });

  app.post<{ Params: { id: string } }>("/api/ops/payments/:id/mark-paid", async (req) => {
    const user = requireRole(req, "finance", "founder");
    const { reference } = z.object({ reference: z.string().min(3).max(120) }).parse(req.body);
    await asPlatform(db, user, (tx) => markPaymentPaid(tx, user, req.params.id, reference, deps));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/ops/payouts/:id/release", async (req) => {
    const user = requireRole(req, "finance", "founder");
    await asPlatform(db, user, (tx) => releasePayout(tx, user, req.params.id, deps));
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/ops/partners/:id", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const Profile = z.object({
      status: z.enum(["prospect", "contacted", "pilot", "signed", "paused"]).optional(),
      quality: z.number().min(0).max(100).optional(),
      capacity: z.number().int().min(0).max(500).optional(),
      licenceActive: z.boolean().optional(),
      agreementSigned: z.boolean().optional(),
      emirates: z.array(z.string()).optional(),
      codes: z.array(z.string()).optional(),
      ftaTaxAgent: z.boolean().optional(),
      approvedAuditorZones: z.array(z.string()).optional(),
      registeredLiquidator: z.boolean().optional(),
    });
    const patch = Profile.parse(req.body);
    return asPlatform(db, user, async (tx) => {
      const r = await tx.query("update orgs set profile = profile || $2::jsonb where id = $1 and type = 'partner' returning id", [req.params.id, JSON.stringify(patch)]);
      if (r.rows.length === 0) throw notFound("Partner not found");
      await audit(tx, user, "partner.updated", "org", req.params.id, patch);
      return { ok: true };
    });
  });

  app.get("/api/ops/audit", async (req) => auditTrail(db, requireRole(req, "finance", "founder", "ops")));

  app.post("/api/ops/jobs/run", async (req) => {
    const user = requireRole(req, "ops", "founder");
    return runJobs(db, deps, user);
  });

  // Notifications: each person's own bell ---------------------------------------------------------
  app.get("/api/notifications", async (req) => {
    const user = requireUser(req);
    return myNotifications(db, user);
  });

  app.post("/api/notifications/read", async (req) => {
    const user = requireUser(req);
    const body = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).parse(req.body ?? {});
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

  // Administration: organisations, people, PDPL data requests, retention --------------------------
  // Route guards admit platform staff; services/admin.ts decides who may change which organisation.
  const RoleSchema = z.enum(["client_owner", "client_member", "partner_admin", "partner_staff", "ops", "finance", "founder", "agent"]);

  app.get("/api/admin/orgs", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => listOrganisations(tx));
  });

  app.post("/api/admin/partners", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = z
      .object({
        name: z.string().min(2).max(200),
        adminName: z.string().min(2).max(120),
        adminEmail: z.string().email(),
        emirates: z.array(z.string().max(40)).max(7).optional(),
        codes: z.array(z.string().max(20)).max(100).optional(),
        capacity: z.number().int().min(0).max(500).optional(),
      })
      .parse(req.body);
    const { notification, ...result } = await asPlatform(db, user, (tx) => createPartner(tx, user, body));
    await opts.notify.send(notification); // after commit: the account exists before the invitation goes out
    return result;
  });

  app.post<{ Params: { id: string } }>("/api/admin/orgs/:id/users", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = z.object({ email: z.string().email(), name: z.string().min(2).max(120), role: RoleSchema }).parse(req.body);
    const { notification, ...result } = await asPlatform(db, user, (tx) => inviteUser(tx, user, req.params.id, body));
    await opts.notify.send(notification);
    return result;
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/role", async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { role } = z.object({ role: RoleSchema }).parse(req.body);
    return asPlatform(db, user, (tx) => changeRole(tx, user, req.params.id, role));
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/deactivate", async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => deactivateUser(tx, user, req.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/reactivate", async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => reactivateUser(tx, user, req.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/export", async (req, reply) => {
    const user = requireRole(req, "ops", "founder");
    const data = await asPlatform(db, user, (tx) => exportPerson(tx, user, req.params.id));
    reply.header("content-disposition", `attachment; filename="person-${req.params.id}.json"`);
    return data;
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/erase", async (req) => {
    const user = requireRole(req, "founder");
    const { confirm } = z.object({ confirm: z.literal("ERASE") }).parse(req.body);
    void confirm;
    return asPlatform(db, user, (tx) => erasePerson(tx, user, req.params.id));
  });

  app.get("/api/admin/settings/retention", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => getRetention(tx));
  });

  app.put("/api/admin/settings/retention", async (req) => {
    const user = requireRole(req, "founder");
    const Period = z.object({ years: z.number().int().min(0).max(100).nullable().optional(), days: z.number().int().min(0).max(36500).nullable().optional() });
    const body = z.object({ periods: z.record(Period).default({}), note: z.string().min(3).max(500) }).parse(req.body);
    return asPlatform(db, user, (tx) => confirmRetention(tx, user, body.periods, body.note));
  });

  // Payment provider webhook ------------------------------------------------------
  app.post("/api/webhooks/payments", async (req, reply) => {
    const secret = opts.webhookSecret;
    const given = String(req.headers["x-webhook-secret"] ?? "");
    if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return reply.status(401).send({ error: "unauthorised", message: "Bad webhook secret" });
    }
    const body = z.object({ paymentId: z.string().uuid(), status: z.literal("paid"), reference: z.string().min(3) }).parse(req.body);
    await asPlatform(db, null, (tx) => markPaymentPaid(tx, null, body.paymentId, body.reference, deps));
    return { ok: true };
  });

  app.get("/api/health", async () => ({ ok: true, db: db.kind, devLogin: !!opts.devLogin }));

  // Web app ------------------------------------------------------------------
  if (opts.webDir) registerStatic(app, opts.webDir);

  return app;
}

const publicUser = (u: NonNullable<FastifyRequest["user"]>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  orgId: u.orgId,
  orgName: u.orgName,
  orgType: u.orgType,
});

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

function cookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function registerStatic(app: FastifyInstance, dir: string) {
  const root = resolve(dir);
  app.get("/*", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = (req.params as { "*": string })["*"] || "index.html";
    if (url.startsWith("api/")) return reply.status(404).send({ error: "not_found", message: "No such endpoint" });
    let path = normalize(join(root, url));
    if (!path.startsWith(root)) return reply.status(404).send();
    try {
      if (!(await stat(path)).isFile()) path = join(root, "index.html");
    } catch {
      path = join(root, "index.html");
    }
    reply.header("cache-control", "no-cache");
    return reply.type(TYPES[extname(path)] ?? "application/octet-stream").send(await readFile(path));
  });
}

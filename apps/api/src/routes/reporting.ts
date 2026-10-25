import { z } from "zod";
import { CLIENT_ROLES, PARTNER_ROLES, PLATFORM_ROLES, requireRole, requireUser } from "../lib/auth.ts";
import { asPlatform, asUser } from "../lib/context.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { supersedeChecks } from "../services/doccheck.ts";
import { publicIntake, PublicIntakeSchema, listLeads, handleLead } from "../services/intake.ts";
import { accountingExport, dashboard, exportLog, partnerDashboard } from "../services/reporting.ts";
import { addObligation, clientCalendar, confirmObligation, markObligationMet, obligationFile, opsCalendar, uploadObligationEvidence, waiveObligation } from "../services/compliance.ts";
import type { RouteContext } from "./context.ts";

/** Dashboards, accounting exports and compliance calendars. */
export function registerReportingRoutes(ctx: RouteContext) {
  const { app, db, opts, fileBody, putFile, throttle } = ctx;

  // Reporting and compliance (O8) ------------------------------------------------------------------
  app.get<{ Querystring: { period?: string } }>("/api/admin/dashboard", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    const period = req.query.period ?? new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 7); // Gulf time
    return asPlatform(db, user, (tx) => dashboard(tx, user, period));
  });
  app.get("/api/partner/dashboard", async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES);
    return asPlatform(db, user, (tx) => partnerDashboard(tx, user));
  });
  const AdminAccountingExportQuery = z.object({ set: z.enum(["sales", "payments", "payouts", "margin"]), from: z.string(), to: z.string() });
  app.get<{ Querystring: { set?: string; from?: string; to?: string } }>("/api/admin/accounting/export", { config: { query: AdminAccountingExportQuery } }, async (req, reply) => {
    const user = requireRole(req, "ops", "finance", "founder");
    const q = AdminAccountingExportQuery.parse(req.query);
    const { csv, fileName } = await asPlatform(db, user, (tx) => accountingExport(tx, user, q.set, q.from, q.to));
    reply.header("content-disposition", `attachment; filename="${fileName}"`);
    return reply.type("text/csv; charset=utf-8").send(csv);
  });
  app.get("/api/admin/accounting/exports", async (req) => {
    const user = requireRole(req, "ops", "finance", "founder");
    return asPlatform(db, user, (tx) => exportLog(tx));
  });

  app.get("/api/client/compliance", async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES);
    return asUser(db, user, (tx) => clientCalendar(tx));
  });
  app.get<{ Querystring: { client?: string } }>("/api/ops/compliance", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    const client = req.query.client && z.string().uuid().safeParse(req.query.client).success ? req.query.client : undefined;
    return asPlatform(db, user, (tx) => opsCalendar(tx, client));
  });
  const OpsClientsObligationsBody = z.object({
      kind: z.enum(["licence_renewal", "visa_expiry", "vat_return", "ct_return", "esr_notification", "ubo_update", "audit_filing", "custom"]),
      title: z.string().min(3).max(200),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      recurrence: z.enum(["none", "monthly", "quarterly", "yearly"]).default("none"),
      basis: z.string().max(500).optional(),
      periodLabel: z.string().max(60).optional(),
    });
  app.post<{ Params: { id: string } }>("/api/ops/clients/:id/obligations", { config: { body: OpsClientsObligationsBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsClientsObligationsBody.parse(req.body);
    return asPlatform(db, user, (tx) => addObligation(tx, user, req.params.id, body));
  });
  const OpsObligationsConfirmBody = z.object({ dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), title: z.string().max(200).optional(), periodLabel: z.string().max(60).optional(), note: z.string().min(1).max(500), allowPast: z.boolean().optional() });
  app.post<{ Params: { id: string } }>("/api/ops/obligations/:id/confirm", { config: { body: OpsObligationsConfirmBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsObligationsConfirmBody.parse(req.body);
    return asPlatform(db, user, (tx) => confirmObligation(tx, user, req.params.id, body));
  });
  const OpsObligationsWaiveBody = z.object({ reason: z.string().min(3).max(500) });
  app.post<{ Params: { id: string } }>("/api/ops/obligations/:id/waive", { config: { body: OpsObligationsWaiveBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { reason } = OpsObligationsWaiveBody.parse(req.body);
    return asPlatform(db, user, (tx) => waiveObligation(tx, user, req.params.id, reason));
  });
  const OpsObligationsMetBody = z.object({ note: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/obligations/:id/met", { config: { body: OpsObligationsMetBody.optional() } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { note } = OpsObligationsMetBody.parse(req.body ?? {});
    return asPlatform(db, user, (tx) => markObligationMet(tx, user, req.params.id, note));
  });
  app.post<{ Params: { id: string } }>("/api/obligations/:id/evidence", { config: { body: fileBody } }, async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES, "ops", "founder");
    const body = fileBody.parse(req.body);
    const o = await asPlatform(db, user, async (tx) => (await tx.query<{ client_org_id: string; status: string }>("select client_org_id, status from obligations where id = $1", [req.params.id])).rows[0]);
    if (!o || (user.orgType === "client" && o.client_org_id !== user.orgId)) throw notFound("Obligation not found");
    if (!["open", "evidence_uploaded"].includes(o.status)) throw conflict(`Evidence can be attached to an open obligation only (this one is ${o.status})`);
    const key = await putFile(o.client_org_id, body.fileName, body.contentBase64);
    return asPlatform(db, user, async (tx) => {
      const r = await uploadObligationEvidence(tx, user, req.params.id, { key, name: body.fileName });
      await supersedeChecks(tx, "obligation", req.params.id);
      await opts.notify.emit("document_check", { subject: "obligation", id: req.params.id });
      return r;
    });
  });
  app.get<{ Params: { id: string } }>("/api/obligations/:id/file", async (req, reply) => {
    const user = requireUser(req);
    const f = await asPlatform(db, user, (tx) => obligationFile(tx, user, req.params.id));
    const data = await opts.storage.get(f.key);
    reply.header("content-disposition", `attachment; filename="${f.name.replace(/"/g, "")}"`);
    return reply.type("application/octet-stream").send(data);
  });

  // Public intake (O5): the Tasees lead page posts here. Rate-limited per IP; consent required; honeypot.
  app.post("/api/public/intake", { config: { body: PublicIntakeSchema } }, async (req) => {
    throttle(req, "public-intake", 10);
    const body = PublicIntakeSchema.parse(req.body);
    return asPlatform(db, null, (tx) => publicIntake(tx, body, req.ip, opts.notify, opts.model));
  });
  app.get("/api/ops/leads", async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => listLeads(tx, user));
  });
  const OpsLeadsHandleBody = z.object({ note: z.string().max(300).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/leads/:id/handle", { config: { body: OpsLeadsHandleBody.optional() } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { note } = OpsLeadsHandleBody.parse(req.body ?? {});
    return asPlatform(db, user, (tx) => handleLead(tx, user, req.params.id, note));
  });
}

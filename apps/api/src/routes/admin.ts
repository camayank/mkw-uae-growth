import { z } from "zod";
import { aed } from "@tasees/core";
import { PLATFORM_ROLES, requireRole, requireUser } from "../lib/auth.ts";
import { asPlatform } from "../lib/context.ts";
import { acceptPartnerAgreement, assertMayRead, currentLegal, legalOverview, recordLegalSignOff } from "../services/legal.ts";
import { listHolidays, removeHoliday, setHoliday } from "../services/calendar.ts";
import { addFee, catalogue, feesOverview, retireFee, rulesOverview, scheduleRule, updatePricingSettings, verifyFee } from "../services/rules.ts";
import { changeRole, confirmRetention, createPartner, deactivateUser, erasePerson, exportPerson, getRetention, inviteUser, listOrganisations, reactivateUser } from "../services/admin.ts";
import type { RouteContext } from "./context.ts";

/** Organisations, people, PDPL, retention, legal texts, holidays, catalogue and rules. */
export function registerAdminRoutes(ctx: RouteContext) {
  const { app, db, opts } = ctx;

  // Administration: organisations, people, PDPL data requests, retention --------------------------
  // Route guards admit platform staff; services/admin.ts decides who may change which organisation.
  const RoleSchema = z.enum(["client_owner", "client_member", "partner_admin", "partner_staff", "ops", "finance", "founder", "agent"]);

  app.get("/api/admin/orgs", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => listOrganisations(tx, user.role !== "ops"));
  });

  const AdminPartnersBody = z.object({
      name: z.string().min(2).max(200),
      adminName: z.string().min(2).max(120),
      adminEmail: z.string().email(),
      emirates: z.array(z.string().max(40)).max(7).optional(),
      codes: z.array(z.string().max(20)).max(100).optional(),
      capacity: z.number().int().min(0).max(500).optional(),
    });
  app.post("/api/admin/partners", { config: { body: AdminPartnersBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = AdminPartnersBody.parse(req.body);
    const { notification, ...result } = await asPlatform(db, user, (tx) => createPartner(tx, user, body));
    await opts.notify.send(notification); // after commit: the account exists before the invitation goes out
    return result;
  });

  const AdminOrgsUsersBody = z.object({ email: z.string().email(), name: z.string().min(2).max(120), role: RoleSchema });
  app.post<{ Params: { id: string } }>("/api/admin/orgs/:id/users", { config: { body: AdminOrgsUsersBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = AdminOrgsUsersBody.parse(req.body);
    const { notification, ...result } = await asPlatform(db, user, (tx) => inviteUser(tx, user, req.params.id, body));
    await opts.notify.send(notification);
    return result;
  });

  const AdminUsersRoleBody = z.object({ role: RoleSchema });
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/role", { config: { body: AdminUsersRoleBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { role } = AdminUsersRoleBody.parse(req.body);
    return asPlatform(db, user, (tx) => changeRole(tx, user, req.params.id, role));
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/deactivate", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => deactivateUser(tx, user, req.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/reactivate", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => reactivateUser(tx, user, req.params.id));
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/export", { config: { body: null, idempotency: false } }, async (req, reply) => {
    const user = requireRole(req, "ops", "founder");
    const data = await asPlatform(db, user, (tx) => exportPerson(tx, user, req.params.id));
    reply.header("content-disposition", `attachment; filename="person-${req.params.id}.json"`);
    return data;
  });

  const AdminUsersEraseBody = z.object({ confirm: z.literal("ERASE") });
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/erase", { config: { body: AdminUsersEraseBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const { confirm } = AdminUsersEraseBody.parse(req.body);
    void confirm;
    return asPlatform(db, user, (tx) => erasePerson(tx, user, req.params.id));
  });

  app.get("/api/admin/settings/retention", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => getRetention(tx));
  });

  const Period = z.object({ years: z.number().int().min(0).max(100).nullable().optional(), days: z.number().int().min(0).max(36500).nullable().optional() });
  const AdminSettingsRetentionBody = z.object({ periods: z.record(Period).default({}), note: z.string().min(3).max(500) });
  app.put("/api/admin/settings/retention", { config: { body: AdminSettingsRetentionBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminSettingsRetentionBody.parse(req.body);
    return asPlatform(db, user, (tx) => confirmRetention(tx, user, body.periods, body.note));
  });

  // Legal texts and the holiday calendar (O10) ----------------------------------------------------
  app.get<{ Params: { kind: string } }>("/api/legal/:kind", async (req) => {
    const user = requireUser(req);
    const kind = z.enum(["client_terms", "partner_agreement"]).parse(req.params.kind);
    assertMayRead(user, kind);
    return asPlatform(db, user, async (tx) => (await currentLegal(tx, kind)) ?? { kind, version: null });
  });
  const PartnerAgreementAcceptBody = z.object({ version: z.number().int().positive() });
  app.post("/api/partner/agreement/accept", { config: { body: PartnerAgreementAcceptBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = PartnerAgreementAcceptBody.parse(req.body);
    return asPlatform(db, user, (tx) => acceptPartnerAgreement(tx, user, body.version));
  });
  app.get("/api/admin/legal", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => legalOverview(tx));
  });
  const AdminLegalSignOffBody = z.object({ lawyer: z.string().min(2).max(120), approvedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
  app.post<{ Params: { kind: string; version: string } }>("/api/admin/legal/:kind/:version/sign-off", { config: { body: AdminLegalSignOffBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const kind = z.enum(["client_terms", "partner_agreement"]).parse(req.params.kind);
    const body = AdminLegalSignOffBody.parse(req.body);
    const version = z.coerce.number().int().positive().parse(req.params.version);
    return asPlatform(db, user, (tx) => recordLegalSignOff(tx, user, kind, version, body.lawyer, body.approvedOn));
  });
  app.get("/api/admin/holidays", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => listHolidays(tx));
  });
  const AdminHolidaysBody = z.object({ date: z.string(), name: z.string().max(120), status: z.enum(["expected", "confirmed"]), note: z.string().max(300).optional(), reason: z.string().min(3).max(300) });
  app.put("/api/admin/holidays", { config: { body: AdminHolidaysBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminHolidaysBody.parse(req.body);
    return asPlatform(db, user, (tx) => setHoliday(tx, user, body, body.reason));
  });
  const AdminHolidaysDeleteBody = z.object({ reason: z.string().min(3).max(300) });
  app.delete<{ Params: { date: string } }>("/api/admin/holidays/:date", { config: { body: AdminHolidaysDeleteBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminHolidaysDeleteBody.parse(req.body);
    return asPlatform(db, user, (tx) => removeHoliday(tx, user, req.params.date, body.reason));
  });

  // Catalogue, margin rules and government fees (O4) ----------------------------------------------
  app.get("/api/admin/catalogue", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    // Rates and floors are margin policy: finance and the founder see them, ops does not.
    return asPlatform(db, user, (tx) => catalogue(tx, user.role !== "ops"));
  });

  app.get("/api/admin/rules", async (req) => {
    const user = requireRole(req, "finance", "founder");
    return asPlatform(db, user, (tx) => rulesOverview(tx));
  });

  app.get("/api/admin/fees", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => feesOverview(tx));
  });

  const AdminRulesBody = z.object({ rateBp: z.number().int().min(0).max(10_000), floorAed: z.number().min(0).max(1_000_000), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().min(3).max(500) });
  app.put<{ Params: { category: string } }>("/api/admin/rules/:category", { config: { body: AdminRulesBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminRulesBody.parse(req.body);
    return asPlatform(db, user, (tx) => scheduleRule(tx, user, { category: req.params.category, rateBp: body.rateBp, floorFils: aed(body.floorAed), effectiveFrom: body.effectiveFrom, note: body.note }));
  });

  const AdminPricingSettingsBody = z.object({ capFactorBp: z.number().int().optional(), roundToAed: z.number().optional(), note: z.string().min(3).max(500) });
  app.put("/api/admin/pricing-settings", { config: { body: AdminPricingSettingsBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminPricingSettingsBody.parse(req.body);
    return asPlatform(db, user, (tx) =>
      updatePricingSettings(tx, user, { ...(body.capFactorBp !== undefined ? { capFactorBp: body.capFactorBp } : {}), ...(body.roundToAed !== undefined ? { roundTo: aed(body.roundToAed) } : {}) }, body.note),
    );
  });

  const AdminFeesBody = z.object({
      code: z.string().min(2).max(20),
      emirate: z.string().min(2).max(40),
      freeZone: z.string().max(60).nullish(),
      feeAed: z.number().min(0).max(10_000_000),
      sourceUrl: z.string().max(500).refine((u) => u === "" || /^https?:\/\/\S+$/i.test(u), "Source must be an http(s) link").default(""),
      sourceNote: z.string().max(500).default(""),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    });
  app.post("/api/admin/fees", { config: { body: AdminFeesBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = AdminFeesBody.parse(req.body);
    return asPlatform(db, user, (tx) => addFee(tx, user, { ...body, feeFils: aed(body.feeAed) }));
  });

  const AdminFeesVerifyBody = z.object({ verifiedBy: z.string().min(2).max(120) });
  app.post<{ Params: { id: string } }>("/api/admin/fees/:id/verify", { config: { body: AdminFeesVerifyBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const { verifiedBy } = AdminFeesVerifyBody.parse(req.body);
    return asPlatform(db, user, (tx) => verifyFee(tx, user, req.params.id, verifiedBy));
  });

  const AdminFeesRetireBody = z.object({ reason: z.string().min(3).max(300) });
  app.post<{ Params: { id: string } }>("/api/admin/fees/:id/retire", { config: { body: AdminFeesRetireBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { reason } = AdminFeesRetireBody.parse(req.body);
    return asPlatform(db, user, (tx) => retireFee(tx, user, req.params.id, reason));
  });
}

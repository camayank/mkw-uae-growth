import { z } from "zod";
import { aed } from "@tasees/core";
import { PARTNER_ROLES, requireRole } from "../lib/auth.ts";
import { asPlatform, asUser, audit } from "../lib/context.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { addEvidence, proposeChangeOrder, respondToAllocation, startMilestone, submitMilestone, submitQuote } from "../services/engagements.ts";
import { partnerHome } from "../services/views.ts";
import type { RouteContext } from "./context.ts";

/** Partner screens: allocations, milestones, evidence, quotes, rate cards. */
export function registerPartnerRoutes(ctx: RouteContext) {
  const { app, db, opts, deps } = ctx;

  // Partner ------------------------------------------------------------------
  app.get("/api/partner/home", async (req) => partnerHome(db, requireRole(req, ...PARTNER_ROLES)));

  const AllocationsRespondBody = z.object({ decision: z.enum(["accept", "decline"]), reason: z.string().max(500).optional() });
  app.post<{ Params: { id: string } }>("/api/allocations/:id/respond", { config: { body: AllocationsRespondBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = AllocationsRespondBody.parse(req.body);
    await asPlatform(db, user, (tx) => respondToAllocation(tx, user, req.params.id, body.decision, body.reason, deps));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/milestones/:id/start", { config: { body: null } }, async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES);
    await asPlatform(db, user, (tx) => startMilestone(tx, user, req.params.id));
    return { ok: true };
  });

  const MilestonesEvidenceBody = z.object({ type: z.string().min(2).max(60), fileName: z.string().min(1).max(200), contentBase64: z.string().min(1) });
  app.post<{ Params: { id: string } }>("/api/milestones/:id/evidence", { config: { body: MilestonesEvidenceBody } }, async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES);
    const body = MilestonesEvidenceBody.parse(req.body);
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
    // The document checker's event commits with the upload (O11).
    await asPlatform(db, user, async (tx) => {
      const ev = await addEvidence(tx, user, req.params.id, { type: body.type, key, name: body.fileName });
      await opts.notify.emit("document_check", { subject: "evidence", id: ev.id });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/milestones/:id/submit", { config: { body: null } }, async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES);
    await asPlatform(db, user, (tx) => submitMilestone(tx, user, req.params.id));
    return { ok: true };
  });

  const EngagementsChangeOrdersBody = z.object({ description: z.string().min(3).max(2000), partnerCostAed: z.number().positive().max(10_000_000) });
  app.post<{ Params: { id: string } }>("/api/engagements/:id/change-orders", { config: { body: EngagementsChangeOrdersBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = EngagementsChangeOrdersBody.parse(req.body);
    const id = await asPlatform(db, user, (tx) => proposeChangeOrder(tx, user, req.params.id, body.description, aed(body.partnerCostAed), deps));
    return { id };
  });

  const Line = z.object({
    code: z.string(),
    professionalAed: z.number().min(0),
    govStatedAed: z.number().min(0).default(0),
    thirdPartyAed: z.number().min(0).default(0),
    workingDays: z.number().int().min(1).max(365),
    exclusions: z.array(z.string().max(200)).max(20).default([]),
    assumptions: z.string().max(2000).default(""),
  });
  const RfqsQuoteBody = z.object({ lines: z.array(Line).min(1).max(30) });
  app.post<{ Params: { id: string } }>("/api/rfqs/:id/quote", { config: { body: RfqsQuoteBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const { lines } = RfqsQuoteBody.parse(req.body);
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

  const Card = z.object({
    code: z.string(),
    professionalAed: z.number().min(0),
    govStatedAed: z.number().min(0).default(0),
    thirdPartyAed: z.number().min(0).default(0),
    workingDays: z.number().int().min(1).max(365),
    exclusions: z.array(z.string().max(200)).max(20).default([]),
  });
  const PartnerRateCardsBody = z.object({ cards: z.array(Card).min(1).max(40) });
  app.put("/api/partner/rate-cards", { config: { body: PartnerRateCardsBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const { cards } = PartnerRateCardsBody.parse(req.body);
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
}

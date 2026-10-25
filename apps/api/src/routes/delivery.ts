import { z } from "zod";
import { CLIENT_ROLES, PARTNER_ROLES, PLATFORM_ROLES, requireRole, requireUser } from "../lib/auth.ts";
import { asPlatform, asUser } from "../lib/context.ts";
import { forbidden, notFound } from "../lib/errors.ts";
import { supersedeChecks } from "../services/doccheck.ts";
import { DOCUMENT_KINDS, invitePartnerStaff, movePartner, partnerOnboarding, recomputeScorecards, reviewDocument, setPartnerStaffActive, submitApplication, uploadDocument as uploadPartnerDocument, scorecardHistory } from "../services/partners.ts";
import { addDocumentRequest, allocateManually, attributeDelay, decideCredit, decideDocument, delayQueue, documentFileKey, offerDocument, rateEngagement, settleCredit, uploadDocument as uploadClientDocument } from "../services/delivery.ts";
import type { RouteContext } from "./context.ts";

/** Partner onboarding, documents, staff, client document requests, delays, ratings. */
export function registerDeliveryRoutes(ctx: RouteContext) {
  const { app, db, opts, deps, fileBody, putFile } = ctx;

  // Partners and delivery (O6) -------------------------------------------------------------------------

  // Onboarding: the partner's own firm, or any firm for MKW staff.
  app.get<{ Params: { id: string } }>("/api/partners/:id/onboarding", async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => partnerOnboarding(tx, user, req.params.id));
  });
  const PartnerApplicationBody = z.object({
      emirates: z.array(z.string().max(40)).max(8),
      codes: z.array(z.string().max(20)).max(100),
      capacity: z.number().int().min(0).max(500),
      licenceNumber: z.string().min(2).max(60),
      licenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      ftaTaxAgent: z.boolean().optional(),
      licensedLawFirm: z.boolean().optional(),
      regulatoryAdviser: z.boolean().optional(),
      registeredLiquidator: z.boolean().optional(),
      approvedAuditorZones: z.array(z.string().max(40)).max(20).optional(),
      about: z.string().max(2000).optional(),
    });
  app.put("/api/partner/application", { config: { body: PartnerApplicationBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = PartnerApplicationBody.parse(req.body);
    return asPlatform(db, user, (tx) => submitApplication(tx, user, body));
  });
  const PartnersDocumentsBody = fileBody.extend({ kind: z.enum(DOCUMENT_KINDS as [string, ...string[]]), reference: z.string().max(80).optional(), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
  app.post<{ Params: { id: string } }>("/api/partners/:id/documents", { config: { body: PartnersDocumentsBody } }, async (req) => {
    const user = requireRole(req, "partner_admin", "ops", "founder");
    const body = PartnersDocumentsBody.parse(req.body);
    if (user.orgType === "partner" && user.orgId !== req.params.id) throw forbidden("Not your firm");
    const key = await putFile(req.params.id, body.fileName, body.contentBase64); // the firm's own folder
    return asPlatform(db, user, async (tx) => {
      const doc = await uploadPartnerDocument(tx, user, req.params.id, { kind: body.kind as (typeof DOCUMENT_KINDS)[number], key, name: body.fileName, reference: body.reference, expiresOn: body.expiresOn });
      await opts.notify.emit("document_check", { subject: "partner_document", id: doc.id });
      return doc;
    });
  });
  const OpsPartnerDocumentsReviewBody = z.object({ decision: z.enum(["verified", "rejected"]), note: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/partner-documents/:id/review", { config: { body: OpsPartnerDocumentsReviewBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsPartnerDocumentsReviewBody.parse(req.body);
    return asPlatform(db, user, (tx) => reviewDocument(tx, user, req.params.id, body.decision, body.note, opts.notify));
  });
  app.get<{ Params: { id: string } }>("/api/partner-documents/:id/file", async (req, reply) => {
    const user = requireRole(req, "partner_admin", ...PLATFORM_ROLES);
    const row = await asPlatform(db, user, async (tx) => (await tx.query<{ partner_org_id: string; file_key: string; file_name: string }>("select partner_org_id, file_key, file_name from partner_documents where id = $1", [req.params.id])).rows[0]);
    if (!row || (user.orgType === "partner" && row.partner_org_id !== user.orgId)) throw notFound("File not found");
    const data = await opts.storage.get(row.file_key);
    reply.header("content-disposition", `attachment; filename="${row.file_name.replace(/"/g, "")}"`);
    return reply.type("application/octet-stream").send(data);
  });
  const OpsPartnersStatusBody = z.object({ status: z.enum(["prospect", "contacted", "applied", "under_review", "pilot", "signed", "paused"]), note: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/partners/:id/status", { config: { body: OpsPartnersStatusBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsPartnersStatusBody.parse(req.body);
    return asPlatform(db, user, (tx) => movePartner(tx, user, req.params.id, body.status, body.note, opts.notify));
  });
  app.get<{ Params: { id: string } }>("/api/partners/:id/scorecards", async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES, ...PLATFORM_ROLES);
    if (user.orgType === "partner" && user.orgId !== req.params.id) throw forbidden("Not your firm");
    return asPlatform(db, user, (tx) => scorecardHistory(tx, req.params.id));
  });
  app.post("/api/ops/scorecards/recompute", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, async (tx) => ({ partners: await recomputeScorecards(tx, user) }));
  });

  // Partner staff
  const PartnerStaffBody = z.object({ email: z.string().email(), name: z.string().min(2).max(120) });
  app.post("/api/partner/staff", { config: { body: PartnerStaffBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = PartnerStaffBody.parse(req.body);
    const { notification, ...result } = await asPlatform(db, user, (tx) => invitePartnerStaff(tx, user, body));
    await opts.notify.send(notification);
    return result;
  });
  const PartnerStaffActiveBody = z.object({ active: z.boolean() });
  app.post<{ Params: { id: string } }>("/api/partner/staff/:id/active", { config: { body: PartnerStaffActiveBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const { active } = PartnerStaffActiveBody.parse(req.body);
    return asPlatform(db, user, (tx) => setPartnerStaffActive(tx, user, req.params.id, active));
  });

  // Client document requests
  const MilestonesDocumentRequestsBody = z.object({ kind: z.string().min(3).max(60), note: z.string().max(300).default("") });
  app.post<{ Params: { id: string } }>("/api/milestones/:id/document-requests", { config: { body: MilestonesDocumentRequestsBody } }, async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES);
    const body = MilestonesDocumentRequestsBody.parse(req.body);
    return asPlatform(db, user, (tx) => addDocumentRequest(tx, user, req.params.id, body.kind, body.note, deps));
  });
  app.post<{ Params: { id: string } }>("/api/document-requests/:id/upload", { config: { body: fileBody } }, async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES);
    const body = fileBody.parse(req.body);
    const r = await asUser(db, user, async (tx) => (await tx.query<{ engagement_id: string }>("select engagement_id from document_requests where id = $1", [req.params.id])).rows[0]);
    if (!r) throw notFound("Document request not found");
    const key = await putFile(r.engagement_id, body.fileName, body.contentBase64);
    return asPlatform(db, user, async (tx) => {
      const r = await uploadClientDocument(tx, user, req.params.id, { key, name: body.fileName }, deps);
      await supersedeChecks(tx, "document_request", req.params.id);
      await opts.notify.emit("document_check", { subject: "document_request", id: req.params.id });
      return r;
    });
  });
  const DocumentRequestsDecideBody = z.object({ decision: z.enum(["received", "rejected"]), note: z.string().max(300).default("") });
  app.post<{ Params: { id: string } }>("/api/document-requests/:id/decide", { config: { body: DocumentRequestsDecideBody } }, async (req) => {
    const user = requireRole(req, ...PARTNER_ROLES, "ops", "founder");
    const body = DocumentRequestsDecideBody.parse(req.body);
    return asPlatform(db, user, (tx) => decideDocument(tx, user, req.params.id, body.decision, body.note, deps));
  });
  app.get<{ Params: { id: string } }>("/api/document-requests/:id/file", async (req, reply) => {
    const user = requireUser(req);
    const f = await asPlatform(db, user, (tx) => documentFileKey(tx, user, req.params.id));
    const data = await opts.storage.get(f.key);
    reply.header("content-disposition", `attachment; filename="${f.name.replace(/"/g, "")}"`);
    return reply.type("application/octet-stream").send(data);
  });

  // Delay watch and service guarantee
  app.get("/api/ops/delays", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => delayQueue(tx));
  });
  const OpsDelaysAttributeBody = z.object({ cause: z.enum(["partner", "client", "government", "mkw"]), note: z.string().min(1).max(500) });
  app.post<{ Params: { id: string } }>("/api/ops/delays/:id/attribute", { config: { body: OpsDelaysAttributeBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsDelaysAttributeBody.parse(req.body);
    return asPlatform(db, user, (tx) => attributeDelay(tx, user, req.params.id, body.cause, body.note));
  });
  const OpsCreditsDecideBody = z.object({ decision: z.enum(["approve", "waive"]), note: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/credits/:id/decide", { config: { body: OpsCreditsDecideBody } }, async (req) => {
    const user = requireRole(req, "finance", "founder");
    const body = OpsCreditsDecideBody.parse(req.body);
    return asPlatform(db, user, (tx) => decideCredit(tx, user, req.params.id, body.decision, body.note, deps));
  });
  const OpsCreditsSettleBody = z.object({ reference: z.string().min(3).max(120) });
  app.post<{ Params: { id: string } }>("/api/ops/credits/:id/settle", { config: { body: OpsCreditsSettleBody } }, async (req) => {
    const user = requireRole(req, "finance", "founder");
    const { reference } = OpsCreditsSettleBody.parse(req.body);
    return asPlatform(db, user, (tx) => settleCredit(tx, user, req.params.id, reference));
  });

  // Ratings
  const EngagementsRatingBody = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(1000).default("") });
  app.post<{ Params: { id: string } }>("/api/engagements/:id/rating", { config: { body: EngagementsRatingBody } }, async (req) => {
    const user = requireRole(req, "client_owner");
    const body = EngagementsRatingBody.parse(req.body);
    return asPlatform(db, user, (tx) => rateEngagement(tx, user, req.params.id, body.stars, body.comment, deps));
  });

  // Manual allocation
  const OpsEngagementsAllocateBody = z.object({ partnerId: z.string().uuid(), codes: z.array(z.string().max(20)).min(1).max(50), reason: z.string().min(5).max(500) });
  app.post<{ Params: { id: string } }>("/api/ops/engagements/:id/allocate", { config: { body: OpsEngagementsAllocateBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = OpsEngagementsAllocateBody.parse(req.body);
    return asPlatform(db, user, (tx) => allocateManually(tx, user, req.params.id, body.partnerId, body.codes, body.reason, deps));
  });

  // Offer document
  app.get<{ Params: { id: string } }>("/api/client/offers/:id/pdf", async (req, reply) => {
    const user = requireRole(req, ...CLIENT_ROLES, ...PLATFORM_ROLES);
    const { pdf, fileName } = await asPlatform(db, user, (tx) => offerDocument(tx, user, req.params.id));
    reply.header("content-disposition", `attachment; filename="${fileName}"`);
    return reply.type("application/pdf").send(pdf);
  });
}

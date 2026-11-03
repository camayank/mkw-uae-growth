import { z } from "zod";
import { cleanAttribution, type AdviceInput } from "@tasees/core";
import { PLATFORM_ROLES, requireRole } from "../lib/auth.ts";
import { asPlatform } from "../lib/context.ts";
import { publicAssess } from "../services/public.ts";
import { publicReportPdf } from "../services/report.ts";
import { IntakeSchema } from "../services/requests.ts";
import { addLeadNote, assignLead, bookConsultation, completeFollowup, CONSENT_TEXTS, FUNNEL_STAGES, funnelReport, getRouting, leadAnalytics, leadDetail, LEAD_STATUSES, listLeads, recordFunnelEvents, recoverAssessment, saveAssessment, SEGMENTS, setFollowup, setLeadStatus, setNextAction, setRouting, withdrawConsent } from "../services/leads.ts";
import type { RouteContext } from "./context.ts";

/** Lead intelligence (E4): saved assessments, the lead pipeline, routing, analytics. Nothing here sends anything. */
export function registerLeadRoutes(ctx: RouteContext) {
  const { app, db, throttle } = ctx;

  const Attribution = z.object({ source: z.string().max(80).optional(), medium: z.string().max(80).optional(), campaign: z.string().max(80).optional(), term: z.string().max(120).optional(), content: z.string().max(120).optional(), referrer: z.string().max(300).optional(), landing: z.string().max(200).optional(), visitor: z.string().max(32).optional() }).partial();
  const AnswersBody = IntakeSchema.omit({ mode: true, addOns: true, services: true, description: true });

  // Saving is the founder's own action and takes no contact details; the code comes back once, never by email.
  const PublicAssessmentsBody = z.object({ answers: AnswersBody, attribution: Attribution.optional() });
  app.post("/api/public/assessments", { config: { body: PublicAssessmentsBody } }, async (req) => {
    throttle(req, "public-save", 20);
    const body = PublicAssessmentsBody.parse(req.body);
    return asPlatform(db, null, async (tx) => {
      const answers = { ...body.answers, mode: "new_company" } as AdviceInput;
      const result = await publicAssess(tx, answers);
      const summary = { recommendation: result.structure.recommendation, confirmed: result.structure.confirmed, approvedStatements: result.approved.statements, approvedPlaces: result.approved.places, noViableOption: result.noViableOption };
      const saved = await saveAssessment(tx, answers, summary, cleanAttribution(body.attribution), { engineVersion: result.engineVersion, asOf: result.asOf });
      return { code: saved.code };
    });
  });
  // Recovery re-runs the assessment on today's rules and says when it was saved.
  app.get<{ Params: { code: string } }>("/api/public/assessments/:code", async (req) => {
    throttle(req, "public-recover", 30);
    const code = String(req.params.code ?? "").trim();
    if (!/^[A-Za-z0-9]{10}$/.test(code)) return { found: false };
    return asPlatform(db, null, async (tx) => {
      const saved = await recoverAssessment(tx, code);
      if (!saved) return { found: false };
      const result = await publicAssess(tx, saved.answers);
      return { found: true, answers: saved.answers, savedAt: saved.savedAt, recovered: saved.recovered, result };
    });
  });
  // The consent texts the public pages show, so the page and the record always agree on the version.
  app.get("/api/public/consent-texts", async () => CONSENT_TEXTS);
  // E7D: the preliminary report for a saved result, as a PDF; the recovery code is the capability, as for recovery.
  app.get<{ Params: { code: string } }>("/api/public/assessments/:code/report.pdf", async (req, reply) => {
    throttle(req, "public-report", 30);
    const code = String(req.params.code ?? "").trim();
    if (!/^[A-Za-z0-9]{10}$/.test(code)) return reply.code(404).send({ error: "not_found", message: "No saved result with that code" });
    const { pdf, filename } = await asPlatform(db, null, (tx) => publicReportPdf(tx, code));
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    return reply.type("application/pdf").send(pdf);
  });
  // E7C: anonymous funnel measurement from the public page. A random per-session id, the stage and a step key; the
  // attribution is the same the page already sends. Nothing identifies a person; repeats are ignored.
  const FunnelBody = z.object({ visitor: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/), events: z.array(z.object({ stage: z.enum(FUNNEL_STAGES), key: z.string().max(40).optional() })).min(1).max(40), attribution: Attribution.optional() });
  app.post("/api/public/events", { config: { body: FunnelBody } }, async (req) => {
    throttle(req, "public-events", 300);
    const body = FunnelBody.parse(req.body);
    return asPlatform(db, null, (tx) => recordFunnelEvents(tx, body.visitor, body.events, cleanAttribution(body.attribution ?? {})));
  });
  // E7C: the conversion dashboard and the adviser's override of the next best action.
  app.get("/api/ops/pipeline/funnel", async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => funnelReport(tx, user));
  });
  // E7D: the adviser books the call a lead asked for; a follow-up due at that time reaches the queue.
  const ConsultationBody = z.object({ at: z.string().min(8).max(40), note: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/pipeline/leads/:id/consultation", { config: { body: ConsultationBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = ConsultationBody.parse(req.body);
    return asPlatform(db, user, (tx) => bookConsultation(tx, user, z.string().uuid().parse(req.params.id), body.at, body.note));
  });
  const NextActionBody = z.object({ action: z.string().max(120).nullable(), reason: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/pipeline/leads/:id/next-action", { config: { body: NextActionBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = NextActionBody.parse(req.body);
    return asPlatform(db, user, (tx) => setNextAction(tx, user, z.string().uuid().parse(req.params.id), body.action, body.reason));
  });

  // The pipeline (ops and the founder) ----------------------------------------------------------------
  const Id = z.string().uuid();
  const leadId = (req: { params: { id: string } }) => Id.parse(req.params.id);
  const ListQuery = z.object({ status: z.enum(LEAD_STATUSES).optional(), segment: z.enum(SEGMENTS as [string, ...string[]]).optional(), owner: z.enum(["me"]).optional() });
  app.get("/api/ops/pipeline/leads", { config: { query: ListQuery.optional() } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const q = ListQuery.parse(req.query ?? {});
    return asPlatform(db, user, (tx) => listLeads(tx, user, q));
  });
  app.get("/api/ops/pipeline/leads/analytics", async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => leadAnalytics(tx, user));
  });
  app.get<{ Params: { id: string } }>("/api/ops/pipeline/leads/:id", async (req) => {
    const user = requireRole(req, "ops", "founder");
    return asPlatform(db, user, (tx) => leadDetail(tx, user, leadId(req)));
  });
  const AssignBody = z.object({ ownerUserId: z.string().uuid().nullable(), note: z.string().max(300).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/pipeline/leads/:id/assign", { config: { body: AssignBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = AssignBody.parse(req.body);
    return asPlatform(db, user, (tx) => assignLead(tx, user, leadId(req), body.ownerUserId, body.note));
  });
  const StatusBody = z.object({ status: z.enum(LEAD_STATUSES), note: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/pipeline/leads/:id/status", { config: { body: StatusBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = StatusBody.parse(req.body);
    return asPlatform(db, user, (tx) => setLeadStatus(tx, user, leadId(req), body.status, body.note));
  });
  const NoteBody = z.object({ body: z.string().min(1).max(2000) });
  app.post<{ Params: { id: string } }>("/api/ops/pipeline/leads/:id/note", { config: { body: NoteBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = NoteBody.parse(req.body);
    return asPlatform(db, user, (tx) => addLeadNote(tx, user, leadId(req), body.body));
  });
  const FollowupBody = z.object({ dueAt: z.string().min(8).max(40), body: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/pipeline/leads/:id/followup", { config: { body: FollowupBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = FollowupBody.parse(req.body);
    return asPlatform(db, user, (tx) => setFollowup(tx, user, leadId(req), body.dueAt, body.body));
  });
  const DoneBody = z.object({ note: z.string().max(500).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/pipeline/followups/:id/done", { config: { body: DoneBody.optional() } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = DoneBody.parse(req.body ?? {});
    return asPlatform(db, user, (tx) => completeFollowup(tx, user, z.coerce.number().int().positive().parse(req.params.id), body.note));
  });
  const WithdrawBody = z.object({ purpose: z.enum(["marketing", "partner_disclosure"]), note: z.string().min(1).max(500) });
  app.post<{ Params: { id: string } }>("/api/ops/pipeline/leads/:id/consent-withdraw", { config: { body: WithdrawBody } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const body = WithdrawBody.parse(req.body);
    return asPlatform(db, user, (tx) => withdrawConsent(tx, user, leadId(req), body.purpose, body.note));
  });

  // Routing (the founder sets it; platform roles read it, with the people it can name) ----------------------
  app.get("/api/admin/settings/lead-routing", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, async (tx) => ({
      segments: SEGMENTS,
      routing: await getRouting(tx),
      owners: (await tx.query<{ id: string; name: string; role: string }>("select u.id, u.name, u.role from users u join orgs o on o.id = u.org_id where o.type = 'platform' and u.role in ('ops', 'founder') and u.status = 'active' order by u.name")).rows,
      consentTexts: CONSENT_TEXTS,
    }));
  });
  const RoutingBody = z.object({ routing: z.record(z.string(), z.string().uuid().nullable()) });
  app.put("/api/admin/settings/lead-routing", { config: { body: RoutingBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = RoutingBody.parse(req.body);
    return asPlatform(db, user, (tx) => setRouting(tx, user, body.routing));
  });
}

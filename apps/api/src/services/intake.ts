import { z } from "zod";
import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { badRequest } from "../lib/errors.ts";
import type { Notifier } from "../lib/notify.ts";
import type { AiModel } from "../lib/ai.ts";
import { draftScopeForRequest } from "./drafts.ts";
import { createRequest, IntakeSchema } from "./requests.ts";
import { CONSENT_TEXTS, createLead, firstTouchAttribution } from "./leads.ts";
import { adviseNow } from "./scoping.ts";
import { cleanAttribution, type AdviceInput } from "@tasees/core";
import { conflict, forbidden, notFound } from "../lib/errors.ts";

/**
 * Public intake (O5): the Tasees lead page posts here. No sign-in. Creates the client company, its owner and
 * the request, records PDPL consent with a timestamp and the text version shown, refuses without consent or
 * with the honeypot filled, and tells the new owner how to sign in. Rate limiting is applied by the route.
 */
export const CONSENT_VERSION = "2026-10-privacy-v1";
/** The consent texts the platform shows, by version: the record names which one the person agreed to (PDPL). */
export const CONSENT_VERSIONS: Record<string, string> = {
  "2026-10-privacy-v1": "intake.html: process the details to prepare offers, store in the UAE, contact about the request",
  "2026-11-selector-v1": "selector.html: process the details and the answers to review the case, store in the UAE, contact about the request",
};

export const PublicIntakeSchema = z.object({
  company: z.string().min(2).max(200),
  name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  consent: z.boolean(),
  consentVersion: z.string().max(40).default(CONSENT_VERSION).refine((v) => v in CONSENT_VERSIONS, "unknown consent text version"),
  /** Honeypot: humans never see this field; bots fill it. */
  website: z.string().max(200).optional(),
  campaign: z.string().max(80).optional(),
  referrer: z.string().max(300).optional(),
  answers: IntakeSchema,
  // E4: attribution, the saved assessment this came from, the other consents (never pre-ticked), a call request.
  attribution: z.object({ source: z.string().max(80).optional(), medium: z.string().max(80).optional(), campaign: z.string().max(80).optional(), term: z.string().max(120).optional(), content: z.string().max(120).optional(), referrer: z.string().max(300).optional(), landing: z.string().max(200).optional() }).partial().optional(),
  assessmentCode: z.string().max(12).optional(),
  marketingConsent: z.boolean().default(false),
  partnerDisclosureConsent: z.boolean().default(false),
  consultation: z.object({ wanted: z.boolean(), times: z.string().max(300).optional() }).optional(),
});
export type PublicIntake = z.infer<typeof PublicIntakeSchema>;

export async function publicIntake(tx: Queryable, input: PublicIntake, ip: string, notify: Notifier, model?: AiModel): Promise<{ ok: true }> {
  if (input.website && input.website.trim()) {
    // A filled honeypot is a bot: say thanks and do nothing (no record, no email).
    return { ok: true };
  }
  if (!input.consent) throw badRequest("We need your consent to process your details before we can send offers");
  const email = input.email.trim().toLowerCase();
  const company = input.company.trim();
  const consent = { given: true, at: new Date().toISOString(), version: input.consentVersion, channel: "public_intake", ip };
  // First touch wins: a saved result's campaign stays with the lead and the request it becomes.
  const attribution = await firstTouchAttribution(tx, input.assessmentCode, cleanAttribution({ ...(input.attribution ?? {}), campaign: input.attribution?.campaign ?? input.campaign, referrer: input.attribution?.referrer ?? input.referrer }));
  const source = { channel: "public_intake", campaign: attribution.campaign, referrer: attribution.referrer, phone: input.phone ? "provided" : "none", attribution };
  // What the engine makes of the answers feeds the lead's complexity: contradictions, missing facts, no viable option.
  const assessed = input.answers.mode === "new_company" ? await adviseNow(tx, input.answers as AdviceInput) : null;
  const signals = assessed ? { contradictions: assessed.contradictions?.length ?? 0, missingFacts: assessed.missingFacts?.length ?? 0, noViableOption: !!assessed.noViableOption } : {};
  const lead = (outcome: { clientOrgId?: string | null; requestId?: string | null; intakeLeadId?: string | null }) =>
    createLead(tx, {
      email, name: input.name, company, phoneGiven: !!input.phone, answers: input.answers, attribution, assessmentCode: input.assessmentCode, signals,
      consents: { service: { version: input.consentVersion }, marketing: { given: input.marketingConsent, version: CONSENT_TEXTS.marketing.version }, partnerDisclosure: { given: input.partnerDisclosureConsent, version: CONSENT_TEXTS.partner_disclosure.version } },
      consultation: input.consultation ?? null, ip, outcome,
    });
  const existing = (await tx.query<{ id: string }>("select id from users where email = $1", [email])).rows[0];
  if (existing) {
    // Held for a person. Nothing is written as the account holder, their consent record stays as it was, and
    // the only email is a neutral sign-in note carrying none of the submitted text.
    const createLeadRecord = lead;
    const held = (
      await tx.query<{ id: string }>(
        "insert into intake_leads (email, company, name, phone_given, answers, consent, source, ip) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
        [email, company, input.name.trim(), !!input.phone, JSON.stringify(input.answers), JSON.stringify(consent), JSON.stringify(source), ip],
      )
    ).rows[0]!.id;
    await audit(tx, null, "intake.lead_held", "intake_lead", held, { reason: "email already has an account" });
    await createLeadRecord({ intakeLeadId: held });
    await notify.send({ to: email, channel: "email", template: "intake_signin", vars: {} });
    return { ok: true };
  }
  const orgId = (await tx.query<{ id: string }>("insert into orgs (type, name) values ('client', $1) returning id", [company])).rows[0]!.id;
  const userId = (
    await tx.query<{ id: string }>("insert into users (org_id, email, name, role, consent) values ($1, $2, $3, 'client_owner', $4) returning id", [orgId, email, input.name.trim(), JSON.stringify(consent)])
  ).rows[0]!.id;
  await audit(tx, null, "client.created", "org", orgId, { company, via: "public_intake" });
  const actor: SessionUser = { id: userId, orgId, orgType: "client", orgName: company, role: "client_owner", email, name: input.name.trim() };
  const req = await createRequest(tx, actor, input.answers, undefined, null, source);
  await audit(tx, actor, "intake.consent_recorded", "user", userId, { version: input.consentVersion });
  await lead({ clientOrgId: orgId, requestId: req.id });
  // A free-text description gets an AI draft into the review queue; nothing changes until ops approves it.
  if (model && input.answers.description?.trim()) await draftScopeForRequest(tx, actor, req.id, model);
  await notify.send({ to: email, channel: "email", template: "intake_received", vars: { company, newAccount: 1 } });
  return { ok: true };
}

/** Held leads for ops: a person decides whether to call, merge or discard. */
export async function listLeads(tx: Queryable, actor: SessionUser) {
  if (!["ops", "founder"].includes(actor.role)) throw forbidden("Only ops sees held leads");
  return (await tx.query("select id, email, company, name, phone_given, answers, source, status, created_at from intake_leads order by created_at desc limit 100")).rows;
}

export async function handleLead(tx: Queryable, actor: SessionUser, id: string, note: string) {
  if (!["ops", "founder"].includes(actor.role)) throw forbidden("Only ops handles held leads");
  const l = (await tx.query<{ status: string }>("select status from intake_leads where id = $1", [id])).rows[0];
  if (!l) throw notFound("Lead not found");
  if (l.status !== "held") throw conflict("This lead was already handled");
  await tx.query("update intake_leads set status = 'handled', handled_by = $2, handled_at = app_now() where id = $1", [id, actor.id]);
  await audit(tx, actor, "intake.lead_handled", "intake_lead", id, { note });
  return { ok: true };
}

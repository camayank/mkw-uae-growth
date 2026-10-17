import { z } from "zod";
import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { badRequest } from "../lib/errors.ts";
import type { Notifier } from "../lib/notify.ts";
import type { AiModel } from "../lib/ai.ts";
import { draftScopeForRequest } from "./drafts.ts";
import { createRequest, IntakeSchema } from "./requests.ts";
import { conflict, forbidden, notFound } from "../lib/errors.ts";

/**
 * Public intake (O5): the Tasees lead page posts here. No sign-in. Creates the client company, its owner and
 * the request, records PDPL consent with a timestamp and the text version shown, refuses without consent or
 * with the honeypot filled, and tells the new owner how to sign in. Rate limiting is applied by the route.
 */
export const CONSENT_VERSION = "2026-10-privacy-v1";

export const PublicIntakeSchema = z.object({
  company: z.string().min(2).max(200),
  name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().max(40).optional(),
  consent: z.boolean(),
  consentVersion: z.string().max(40).default(CONSENT_VERSION),
  /** Honeypot: humans never see this field; bots fill it. */
  website: z.string().max(200).optional(),
  campaign: z.string().max(80).optional(),
  referrer: z.string().max(300).optional(),
  answers: IntakeSchema,
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
  const source = { channel: "public_intake", campaign: input.campaign ?? null, referrer: input.referrer ?? null, phone: input.phone ? "provided" : "none" };
  const existing = (await tx.query<{ id: string }>("select id from users where email = $1", [email])).rows[0];
  if (existing) {
    // Held for a person. Nothing is written as the account holder, their consent record stays as it was, and
    // the only email is a neutral sign-in note carrying none of the submitted text.
    const lead = (
      await tx.query<{ id: string }>(
        "insert into intake_leads (email, company, name, phone_given, answers, consent, source, ip) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
        [email, company, input.name.trim(), !!input.phone, JSON.stringify(input.answers), JSON.stringify(consent), JSON.stringify(source), ip],
      )
    ).rows[0]!.id;
    await audit(tx, null, "intake.lead_held", "intake_lead", lead, { reason: "email already has an account" });
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

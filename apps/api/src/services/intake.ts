import { z } from "zod";
import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { badRequest } from "../lib/errors.ts";
import type { Notifier } from "../lib/notify.ts";
import { createRequest, IntakeSchema } from "./requests.ts";

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

export async function publicIntake(tx: Queryable, input: PublicIntake, ip: string, notify: Notifier) {
  if (input.website && input.website.trim()) {
    // A filled honeypot is a bot: say thanks and do nothing (no record, no email).
    return { ok: true, created: false, reason: "honeypot" as const };
  }
  if (!input.consent) throw badRequest("We need your consent to process your details before we can send offers");
  const email = input.email.trim().toLowerCase();
  const existing = (await tx.query<{ id: string; org_id: string; status: string; role: string }>("select id, org_id, status, role from users where email = $1", [email])).rows[0];
  let orgId: string;
  let userId: string;
  let newAccount = false;
  const consent = { given: true, at: new Date().toISOString(), version: input.consentVersion, channel: "public_intake", ip };
  if (existing) {
    if (existing.status !== "active" || !existing.role.startsWith("client_")) {
      // Never reveal account state to the public: accept the lead quietly for ops to look at.
      await audit(tx, null, "intake.refused_quietly", "user", existing.id, { reason: "account not an active client" });
      return { ok: true, created: false, reason: "existing_account" as const };
    }
    orgId = existing.org_id;
    userId = existing.id;
    await tx.query("update users set consent = $2 where id = $1", [userId, JSON.stringify(consent)]);
  } else {
    orgId = (await tx.query<{ id: string }>("insert into orgs (type, name) values ('client', $1) returning id", [input.company.trim()])).rows[0]!.id;
    userId = (
      await tx.query<{ id: string }>("insert into users (org_id, email, name, role, consent) values ($1, $2, $3, 'client_owner', $4) returning id", [orgId, email, input.name.trim(), JSON.stringify(consent)])
    ).rows[0]!.id;
    newAccount = true;
    await audit(tx, null, "client.created", "org", orgId, { company: input.company.trim(), via: "public_intake" });
  }
  const actor: SessionUser = { id: userId, orgId, orgType: "client", orgName: input.company.trim(), role: "client_owner", email, name: input.name.trim() };
  const req = await createRequest(tx, actor, input.answers, undefined, null, { channel: "public_intake", campaign: input.campaign ?? null, referrer: input.referrer ?? null, phone: input.phone ? "provided" : "none" });
  await audit(tx, actor, "intake.consent_recorded", "user", userId, { version: input.consentVersion });
  if (input.phone) await tx.query("update requests set source = source || $2::jsonb where id = $1", [req.id, JSON.stringify({ phoneGiven: true })]);
  await notify.send({ to: email, channel: "email", template: "intake_received", vars: { company: input.company.trim(), newAccount: newAccount ? 1 : 0 } });
  return { ok: true, created: true, requestId: req.id, newAccount };
}

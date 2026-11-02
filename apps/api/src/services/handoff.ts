import { createHash } from "node:crypto";
import type { AdviceInput, IntakeAnswers } from "@tasees/core";
import { audit, lockAuditChain, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { createRequest } from "./requests.ts";
import { RENEWAL_LIVE, rollForward } from "./compliance.ts";

const codeHash = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");



/**
 * The handoff into Tasees (E5). What a founder answered on the public selector becomes a request for the same
 * customer on a person's action: the client's, from a saved result; or ops', from a held enquiry. The request's
 * advice is always computed afresh on today's rules (E2's data version); nothing from the public result is copied.
 * A renewal is asked for from the obligation that is due, and goes through the ordinary quote, offer and delivery.
 */

/** A signed-in client starts a request from a saved assessment's code: the answers pre-fill, nothing is re-typed. */
export async function requestFromAssessment(tx: Queryable, user: SessionUser, code: string, extras: { description?: string; addOns?: string[] } = {}) {
  if (user.orgType !== "client") throw forbidden("A saved result becomes a request for the client who signs in");
  // The assessment row is locked for the check and the use, so two uses of one code cannot both pass.
  const row = (await tx.query<{ id: string; answers: AdviceInput; created_at: string; recovered: number; source: unknown }>("select id, answers, created_at, recovered, source from assessments where code_hash = $1 and status <> 'anonymised' for update", [codeHash(code)])).rows[0];
  if (!row) throw notFound("No saved result with that code (saved results are kept for a limited time)");
  const already = (await tx.query<{ id: string }>("select id from requests where assessment_id = $1", [row.id])).rows[0];
  if (already) throw conflict("This saved result already became a request");
  await tx.query("update assessments set recovered = recovered + 1, last_seen_at = app_now() where id = $1", [row.id]);
  const saved = { id: row.id, answers: row.answers, savedAt: row.created_at, recovered: num(row.recovered) + 1 };
  const a = saved.answers as AdviceInput & { ownerType?: string };
  const answers: IntakeAnswers = { ...a, mode: "new_company", jurisdiction: a.jurisdiction ?? "not_sure", ...(extras.description ? { description: extras.description.slice(0, 2000) } : {}), ...(extras.addOns?.length ? { addOns: extras.addOns } : {}) } as IntakeAnswers;
  const source = { channel: "console", from: "saved_assessment", assessmentId: saved.id, savedAt: saved.savedAt, attribution: row.source ?? null };
  const created = await createRequest(tx, user, answers, undefined, null, source);
  await tx.query("update requests set assessment_id = $2 where id = $1", [created.id, saved.id]);
  await tx.query("update assessments set status = 'request' where id = $1", [saved.id]);
  // A lead of this same person (an email on this client's account) that pointed at the assessment now points at the
  // request; a stranger's lead that quoted the same code is left alone.
  await tx.query(
    "update leads set request_id = coalesce(request_id, $2), client_org_id = coalesce(client_org_id, $3), updated_at = app_now() where assessment_id = $1 and lower(email) in (select lower(email) from users where org_id = $3)",
    [saved.id, created.id, user.orgId],
  );
  await audit(tx, user, "request.from_assessment", "request", created.id, { assessmentId: saved.id, savedAt: saved.savedAt, recovered: saved.recovered });
  return created;
}

/** Ops turns a held enquiry (an email that already has an account) into a request for that client. Nothing is sent. */
export async function convertHeldLead(tx: Queryable, actor: SessionUser, intakeLeadId: string, note: string) {
  if (!["ops", "founder"].includes(actor.role)) throw forbidden("Only ops converts a held enquiry into a request");
  await lockAuditChain(tx);
  const held = (await tx.query<{ id: string; email: string; status: string; answers: IntakeAnswers; source: Record<string, unknown>; company: string }>("select id, email, status, answers, source, company from intake_leads where id = $1 for update", [intakeLeadId])).rows[0];
  if (!held) throw notFound("Enquiry not found");
  if (held.status !== "held") throw conflict("This enquiry was already handled");
  const user = (await tx.query<{ org_id: string; org_type: string; status: string }>("select u.org_id, o.type as org_type, u.status from users u join orgs o on o.id = u.org_id where u.email = $1", [held.email])).rows[0];
  if (!user) throw conflict("No account with the enquiry's email any more (it may have been erased); handle it by hand");
  if (user.org_type !== "client") throw conflict("The enquiry's email belongs to a partner or MKW account, not a client; handle it by hand");
  if (user.status !== "active") throw conflict("The client account is not active; handle the enquiry by hand");
  const source = { channel: "public_intake", from: "held_enquiry", intakeLeadId: held.id, attribution: (held.source as { attribution?: unknown })?.attribution ?? null, campaign: (held.source as { campaign?: unknown })?.campaign ?? null };
  const created = await createRequest(tx, actor, held.answers, user.org_id, null, source);
  await tx.query("update intake_leads set status = 'handled', handled_by = $2, handled_at = app_now(), request_id = $3 where id = $1", [held.id, actor.id, created.id]);
  await tx.query("update leads set request_id = coalesce(request_id, $2), client_org_id = coalesce(client_org_id, $3), updated_at = app_now() where intake_lead_id = $1", [held.id, created.id, user.org_id]);
  await audit(tx, actor, "intake.lead_converted", "intake_lead", held.id, { requestId: created.id, clientOrgId: user.org_id, note: note.trim() });
  return { ...created, clientOrgId: user.org_id, description: (held.answers as { description?: string }).description?.trim() || null };
}

/** What the scoping review shows for a request that came from a saved assessment: then versus now. */
export async function assessmentContext(tx: Queryable, requestId: string) {
  const r = (
    await tx.query<Record<string, unknown>>(
      `select a.id, a.created_at as saved_at, a.summary, a.source, a.engine_version, a.data_as_of::text as data_as_of, a.recovered
       from requests r join assessments a on a.id = r.assessment_id where r.id = $1`,
      [requestId],
    )
  ).rows[0];
  if (!r) return null;
  return { id: r.id, savedAt: r.saved_at, summary: r.summary, source: r.source, engineVersion: r.engine_version, dataAsOf: r.data_as_of, recovered: num(r.recovered) };
}

/**
 * A renewal offer, asked for from the obligation that is due: a services request with the renewal line for the
 * client, linked both ways. The client asks for their own; ops may ask for any. One open request per obligation.
 */
export async function renewalRequest(tx: Queryable, actor: SessionUser, obligationId: string) {
  const o = (await tx.query<{ id: string; client_org_id: string; engagement_id: string | null; kind: string; status: string }>("select id, client_org_id, engagement_id, kind, status from obligations where id = $1 for update", [obligationId])).rows[0];
  if (!o) throw notFound("Obligation not found");
  const engagementEmirate = o.engagement_id ? ((await tx.query<{ emirate: string | null }>("select emirate from engagements where id = $1", [o.engagement_id])).rows[0]?.emirate ?? null) : null;
  const own = actor.orgType === "client" && actor.orgId === o.client_org_id && ["client_owner", "client_member"].includes(actor.role);
  const ops = ["ops", "founder"].includes(actor.role);
  if (!own && !ops) throw forbidden("Only the client or MKW ops asks for a renewal offer");
  if (o.kind !== "licence_renewal") throw badRequest("Only a trade licence renewal is offered as a service here");
  if (o.status !== "open") throw conflict(`The obligation is ${o.status.replace("_", " ")}; a renewal offer is asked for while it is open`);
  const live = (await tx.query<{ id: string }>(`select r.id from requests r where r.obligation_id = $1 and ${RENEWAL_LIVE}`, [obligationId])).rows[0];
  if (live) throw conflict("A renewal for this obligation is already in progress (being quoted, offered or delivered)");
  const emirate = engagementEmirate ?? (await tx.query<{ e: string | null }>("select answers->>'emirate' as e from requests where client_org_id = $1 order by created_at desc limit 1", [o.client_org_id])).rows[0]?.e ?? "Dubai";
  const answers: IntakeAnswers = { mode: "services", emirate, services: ["SET-RENEW"] };
  const created = await createRequest(tx, actor, answers, ops ? o.client_org_id : undefined, null, { channel: own ? "client" : "console", from: "obligation", obligationId });
  await tx.query("update requests set obligation_id = $2 where id = $1", [created.id, obligationId]);
  await audit(tx, actor, "obligation.renewal_requested", "obligation", obligationId, { requestId: created.id });
  return created;
}

/**
 * When an engagement that renews a licence completes, the obligation it was asked for is met by that delivery (its
 * evidence is the renewed licence on the engagement), and the next one rolls forward as today.
 */
export async function completeRenewal(tx: Queryable, engagementId: string): Promise<string | null> {
  const r = (await tx.query<{ obligation_id: string | null; request_id: string }>("select r.obligation_id, r.id as request_id from engagements e join requests r on r.id = e.request_id where e.id = $1", [engagementId])).rows[0];
  if (!r?.obligation_id) return null;
  const o = (await tx.query<Record<string, unknown>>("select *, due_date::text as due_date from obligations where id = $1 for update", [r.obligation_id])).rows[0];
  if (!o || ["met", "waived"].includes(String(o.status))) return null;
  // The engagement must actually have delivered the renewal: ops may have re-scoped the request to something else.
  const renewed = (await tx.query("select 1 from engagement_lines where engagement_id = $1 and code = 'SET-RENEW'", [engagementId])).rows.length;
  if (!renewed) {
    await audit(tx, null, "obligation.renewal_delivered_without_line", "obligation", String(o.id), { engagementId, requestId: r.request_id });
    return null;
  }
  await tx.query("update obligations set status = 'met', met_at = app_now(), met_note = $2 where id = $1", [o.id, `Renewed through Tasees (engagement ${engagementId.slice(0, 8)})`]);
  await audit(tx, null, "obligation.met", "obligation", String(o.id), { via: "renewal_engagement", engagementId, requestId: r.request_id });
  await rollForward(tx, null, o);
  return String(o.id);
}

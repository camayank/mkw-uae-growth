import { scorePartner, type PartnerStatus, type ScorecardInputs } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import type { Notifier } from "../lib/notify.ts";
import { addDays, dbToday } from "./repo.ts";

/**
 * Partner network (O6): onboarding pipeline with document gates, licence watch, weekly scorecard and the
 * partner's own staff. Partners read only their own firm; MKW decides every status move and records why.
 */

export type DocumentKind = "trade_licence" | "insurance" | "bank_letter" | "agreement" | "other";
export const DOCUMENT_KINDS: DocumentKind[] = ["trade_licence", "insurance", "bank_letter", "agreement", "other"];

/** Allowed status moves. `paused` is reachable from any live state and returns to the state before it. */
const MOVES: Record<PartnerStatus, PartnerStatus[]> = {
  prospect: ["contacted", "applied"],
  contacted: ["applied", "prospect"],
  applied: ["under_review", "contacted"],
  under_review: ["pilot", "applied", "contacted"],
  pilot: ["signed", "paused", "under_review"],
  signed: ["paused", "pilot"],
  paused: ["pilot", "signed"],
};

const WARN_DAYS = 30;

type Profile = Record<string, unknown> & { status?: PartnerStatus; licenceExpiry?: string | null; licenceActive?: boolean; agreementSigned?: boolean; pausedFrom?: PartnerStatus | null; licenceWarnedFor?: string | null };

async function loadPartner(tx: Queryable, orgId: string) {
  const r = (await tx.query<{ id: string; name: string; profile: Profile; status: string }>("select id, name, profile, status from orgs where id = $1 and type = 'partner'", [orgId])).rows[0];
  if (!r) throw notFound("Partner not found");
  return r;
}

const isStaff = (u: SessionUser) => ["ops", "founder"].includes(u.role);
const ownFirm = (u: SessionUser, orgId: string) => u.orgType === "partner" && u.orgId === orgId;

async function patchProfile(tx: Queryable, orgId: string, patch: Record<string, unknown>) {
  await tx.query("update orgs set profile = profile || $2::jsonb where id = $1", [orgId, JSON.stringify(patch)]);
}

// Application ------------------------------------------------------------------------------------------

export interface Application {
  emirates: string[];
  codes: string[];
  capacity: number;
  licenceNumber: string;
  licenceExpiry: string;
  ftaTaxAgent?: boolean;
  licensedLawFirm?: boolean;
  regulatoryAdviser?: boolean;
  registeredLiquidator?: boolean;
  approvedAuditorZones?: string[];
  about?: string;
}

/** The partner admin describes the firm. Moves prospect/contacted to applied; later edits stay in the same state. */
export async function submitApplication(tx: Queryable, actor: SessionUser, app: Application) {
  if (actor.role !== "partner_admin") throw forbidden("Only the firm's admin submits the application");
  const p = await loadPartner(tx, actor.orgId);
  const status = p.profile.status ?? "prospect";
  // Once MKW has reviewed the firm, what it may do is MKW's record: coverage, services, capacity and
  // capabilities change only through ops (PUT /api/ops/partners/:id), never by the firm's own say-so.
  if (!["prospect", "contacted", "applied", "under_review"].includes(status)) throw conflict("Your application is on record; ask MKW Advisors to change coverage, services or capacity");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(app.licenceExpiry)) throw badRequest("Licence expiry must be a date (YYYY-MM-DD)");
  if (app.licenceExpiry <= (await dbToday(tx))) throw badRequest("The trade licence has already expired; renew it first");
  if (!app.emirates.length || !app.codes.length) throw badRequest("Say which emirates you cover and which services you offer");
  const next: PartnerStatus = status === "prospect" || status === "contacted" ? "applied" : status;
  await patchProfile(tx, actor.orgId, {
    emirates: app.emirates,
    codes: app.codes,
    capacity: app.capacity,
    licenceNumber: app.licenceNumber.trim(),
    // What the firm declares; the licence watch runs on `licenceExpiry`, which only a verified document sets.
    declaredLicenceExpiry: app.licenceExpiry,
    ftaTaxAgent: !!app.ftaTaxAgent,
    licensedLawFirm: !!app.licensedLawFirm,
    regulatoryAdviser: !!app.regulatoryAdviser,
    registeredLiquidator: !!app.registeredLiquidator,
    approvedAuditorZones: app.approvedAuditorZones ?? [],
    about: (app.about ?? "").slice(0, 2000),
    status: next,
    appliedAt: status === next ? (p.profile.appliedAt ?? null) : new Date().toISOString(),
  });
  await audit(tx, actor, "partner.applied", "org", actor.orgId, { from: status, to: next, emirates: app.emirates, codes: app.codes.length, licenceExpiry: app.licenceExpiry });
  return { ok: true, status: next };
}

// Documents --------------------------------------------------------------------------------------------

export async function uploadDocument(tx: Queryable, actor: SessionUser, orgId: string, doc: { kind: DocumentKind; key: string; name: string; reference?: string; expiresOn?: string }) {
  if (!ownFirm(actor, orgId) && !isStaff(actor)) throw forbidden("Only the firm or MKW Advisors uploads its documents");
  if (actor.orgType === "partner" && actor.role !== "partner_admin") throw forbidden("Only the firm's admin uploads documents");
  await loadPartner(tx, orgId);
  if (!DOCUMENT_KINDS.includes(doc.kind)) throw badRequest("Unknown document kind");
  if (doc.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(doc.expiresOn)) throw badRequest("Expiry must be a date (YYYY-MM-DD)");
  if (doc.kind === "trade_licence" && !doc.expiresOn) throw badRequest("A trade licence needs its expiry date");
  // A new document of the same kind supersedes any earlier one still waiting; verified ones stay until replaced.
  await tx.query("update partner_documents set status = 'superseded' where partner_org_id = $1 and kind = $2 and status = 'uploaded'", [orgId, doc.kind]);
  const row = (
    await tx.query<{ id: string }>(
      "insert into partner_documents (partner_org_id, kind, file_key, file_name, uploaded_by, reference, expires_on) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [orgId, doc.kind, doc.key, doc.name, actor.id, doc.reference?.trim() || null, doc.expiresOn ?? null],
    )
  ).rows[0]!;
  await audit(tx, actor, "partner.document_uploaded", "partner_document", row.id, { orgId, kind: doc.kind, name: doc.name, expiresOn: doc.expiresOn ?? null });
  return { id: row.id };
}

export async function reviewDocument(tx: Queryable, actor: SessionUser, docId: string, decision: "verified" | "rejected", note: string, notify: Notifier) {
  if (!isStaff(actor)) throw forbidden("Only MKW Advisors verifies partner documents");
  const d = (await tx.query<Record<string, unknown>>("select *, expires_on::text as expires_on from partner_documents where id = $1", [docId])).rows[0];
  if (!d) throw notFound("Document not found");
  if (d.status !== "uploaded") throw conflict(`This document is already ${String(d.status)}`);
  if (decision === "rejected" && !note.trim()) throw badRequest("Say why the document is rejected");
  const orgId = String(d.partner_org_id);
  if (decision === "verified") {
    await tx.query("update partner_documents set status = 'superseded' where partner_org_id = $1 and kind = $2 and status = 'verified' and id <> $3", [orgId, d.kind, docId]);
  }
  await tx.query("update partner_documents set status = $2, verified_by = $3, verified_at = app_now(), note = $4 where id = $1", [docId, decision, actor.id, note || null]);
  const p = await loadPartner(tx, orgId);
  const effects: Record<string, unknown> = {};
  if (decision === "verified" && d.kind === "trade_licence") {
    const expiresOn = String(d.expires_on).slice(0, 10);
    const active = expiresOn > (await dbToday(tx));
    Object.assign(effects, { licenceExpiry: expiresOn, licenceActive: active, licenceWarnedFor: null });
    // A paused firm whose licence lapsed comes back when the new licence is verified.
    if (active && p.profile.status === "paused" && p.profile.pausedReason === "licence_expired" && p.profile.pausedFrom) {
      Object.assign(effects, { status: p.profile.pausedFrom, pausedFrom: null, pausedReason: null });
    }
  }
  if (decision === "verified" && d.kind === "agreement") Object.assign(effects, { agreementSigned: true, agreementSignedAt: new Date().toISOString() });
  if (Object.keys(effects).length) await patchProfile(tx, orgId, effects);
  await audit(tx, actor, decision === "verified" ? "partner.document_verified" : "partner.document_rejected", "partner_document", docId, { orgId, kind: d.kind, note, effects });
  await notifyPartner(tx, notify, orgId, "partner_document_reviewed", { kind: String(d.kind), status: decision, note });
  return { ok: true, effects };
}

// Status pipeline ------------------------------------------------------------------------------------------

export async function movePartner(tx: Queryable, actor: SessionUser, orgId: string, to: PartnerStatus, note: string, notify: Notifier) {
  if (!isStaff(actor)) throw forbidden("Only MKW Advisors moves a partner through onboarding");
  const p = await loadPartner(tx, orgId);
  const from = p.profile.status ?? "prospect";
  if (from === to) return { ok: true, changed: false, status: to };
  if (!MOVES[from]?.includes(to)) throw conflict(`A partner cannot go from ${from} to ${to}`);
  if (!note.trim()) throw badRequest("Record why");
  const docs = (await tx.query<{ kind: string; expires_on: string | null }>("select kind, expires_on::text as expires_on from partner_documents where partner_org_id = $1 and status = 'verified'", [orgId])).rows;
  const today = await dbToday(tx);
  if (to === "pilot" || to === "signed") {
    const licence = docs.find((d) => d.kind === "trade_licence");
    if (!licence || !licence.expires_on || String(licence.expires_on).slice(0, 10) <= today) throw conflict("A verified, unexpired trade licence is needed first");
    if (!p.profile.emirates || !(p.profile.emirates as string[]).length || !(p.profile.codes as string[] | undefined)?.length) throw conflict("The application (emirates and services) is needed first");
  }
  if (to === "signed") {
    if (!docs.some((d) => d.kind === "agreement")) throw conflict("A verified signed Partner Network Agreement is needed first");
    if (!docs.some((d) => d.kind === "insurance")) throw conflict("Verified professional indemnity insurance is needed first");
  }
  const patch: Record<string, unknown> = { status: to };
  if (to === "paused") Object.assign(patch, { pausedFrom: from, pausedReason: "manual", pausedAt: new Date().toISOString() });
  else Object.assign(patch, { pausedFrom: null, pausedReason: null });
  if (to === "signed") patch.signedAt = new Date().toISOString();
  await patchProfile(tx, orgId, patch);
  await audit(tx, actor, "partner.status_changed", "org", orgId, { from, to, note });
  // An admin added by the import waits as `invite_pending` and cannot sign in; MKW moving the firm to pilot is
  // the action that invites them. The status notice below then reaches them as an active user too.
  const invited = to === "pilot" ? (await tx.query<{ id: string; email: string }>("update users set status = 'active' where org_id = $1 and status = 'invite_pending' returning id, email", [orgId])).rows : [];
  for (const u of invited) {
    await audit(tx, actor, "user.invited", "user", u.id, { orgId, role: "partner_admin", on: "moved_to_pilot" });
    await notify.send({ to: u.email, channel: "email", template: "user_invited", vars: { orgName: p.name, role: "partner_admin" } });
  }
  await notifyPartner(tx, notify, orgId, "partner_status_changed", { firm: p.name, status: to, note });
  return { ok: true, changed: true, status: to, invited: invited.length };
}

// Licence watch ----------------------------------------------------------------------------------------------

/** Daily: warn 30 days ahead once; on expiry switch the licence off and pause a live partner. Returns rows touched. */
export async function sweepLicences(tx: Queryable, notify: Notifier): Promise<number> {
  const today = await dbToday(tx);
  const warnFrom = addDays(today, WARN_DAYS);
  const partners = (await tx.query<{ id: string; name: string; profile: Profile }>("select id, name, profile from orgs where type = 'partner'")).rows;
  const opsEmails = (await tx.query<{ email: string }>("select email from users where role in ('ops', 'founder') and status = 'active' order by email")).rows.map((r) => r.email);
  let touched = 0;
  for (const p of partners) {
    const expiry = p.profile.licenceExpiry;
    if (!expiry) continue;
    const admins = (await tx.query<{ email: string }>("select email from users where org_id = $1 and role = 'partner_admin' and status = 'active'", [p.id])).rows.map((r) => r.email);
    if (expiry <= today && p.profile.licenceActive !== false) {
      const live = p.profile.status === "signed" || p.profile.status === "pilot";
      const patch: Record<string, unknown> = { licenceActive: false };
      if (live) Object.assign(patch, { status: "paused", pausedFrom: p.profile.status, pausedReason: "licence_expired", pausedAt: new Date().toISOString() });
      await patchProfile(tx, p.id, patch);
      await audit(tx, null, "partner.licence_expired", "org", p.id, { expiry, paused: live, from: p.profile.status });
      for (const to of [...admins, ...opsEmails]) await notify.send({ to, channel: "email", template: "licence_expired", vars: { firm: p.name, expiresOn: expiry } });
      touched++;
    } else if (expiry > today && expiry <= warnFrom && p.profile.licenceWarnedFor !== expiry) {
      await patchProfile(tx, p.id, { licenceWarnedFor: expiry });
      await audit(tx, null, "partner.licence_expiring", "org", p.id, { expiry });
      for (const to of [...admins, ...opsEmails]) await notify.send({ to, channel: "email", template: "licence_expiring", vars: { firm: p.name, expiresOn: expiry } });
      touched++;
    }
  }
  return touched;
}

// Scorecard ----------------------------------------------------------------------------------------------------

const WINDOW_DAYS = 90;

export async function scorecardInputs(tx: Queryable, partnerId: string, from: string, to: string): Promise<ScorecardInputs> {
  // "Done" = approved by the client in the window (by the approval event's time, which later writes never move);
  // "on time" = the partner first submitted its evidence on or before the due date, since approval waits on
  // MKW and the client, which the partner does not control.
  const done = (
    await tx.query<{ n: number; on_time: number }>(
      `select count(*)::int as n,
         count(*) filter (where (m.first_submitted_at at time zone 'Asia/Dubai')::date <= m.due_date)::int as on_time
       from milestones m where m.partner_org_id = $1 and m.status = 'client_approved'
         and (select max(a.at) from audit_events a where a.entity = 'milestone' and a.entity_id = m.id::text and a.action in ('milestone.approved', 'milestone.dispute_approve'))::date between $2 and $3`,
      [partnerId, from, to],
    )
  ).rows[0]!;
  const qa = (
    await tx.query<{ submitted: number; rejected: number }>(
      `select count(distinct a.entity_id)::int as submitted,
         count(distinct a.entity_id) filter (where exists (select 1 from audit_events r where r.entity_id = a.entity_id and r.action = 'milestone.qa_rejected'))::int as rejected
       from audit_events a join milestones m on m.id::text = a.entity_id where a.action = 'milestone.submitted' and m.partner_org_id = $1 and a.at::date between $2 and $3`,
      [partnerId, from, to],
    )
  ).rows[0]!;
  const disputes = (
    await tx.query<{ n: number }>(
      `select count(distinct a.entity_id)::int as n from audit_events a join milestones m on m.id::text = a.entity_id
       where a.action = 'milestone.disputed' and m.partner_org_id = $1 and a.at::date between $2 and $3`,
      [partnerId, from, to],
    )
  ).rows[0]!;
  const rating = (await tx.query<{ avg: string | null }>("select avg(stars)::text as avg from ratings where partner_org_id = $1 and created_at::date between $2 and $3", [partnerId, from, to])).rows[0]!;
  const change = (
    await tx.query<{ engagements: number; changed: number }>(
      `select count(distinct e.id)::int as engagements,
         count(distinct e.id) filter (where exists (select 1 from change_orders c where c.engagement_id = e.id and c.status = 'approved'))::int as changed
       from engagements e join engagement_parties p on p.engagement_id = e.id and p.org_id = $1 where e.created_at::date between $2 and $3`,
      [partnerId, from, to],
    )
  ).rows[0]!;
  const strikes = (await tx.query<{ s: number }>("select coalesce((profile->>'slaStrikes')::int, 0) as s from orgs where id = $1", [partnerId])).rows[0]!;
  return {
    milestonesDone: num(done.n),
    milestonesOnTime: num(done.on_time),
    qaSubmissions: num(qa.submitted),
    qaFirstPass: num(qa.submitted) - num(qa.rejected),
    disputes: num(disputes.n),
    slaStrikes: num(strikes.s),
    rating: rating.avg === null ? null : Math.round(Number(rating.avg) * 100) / 100,
    changeOrderRate: num(change.engagements) === 0 ? 0 : Math.round((num(change.changed) / num(change.engagements)) * 100) / 100,
  };
}

/** Weekly: a scorecard row per partner from the last 90 days; the profile's quality follows it. */
export async function recomputeScorecards(tx: Queryable, actor: SessionUser | null = null): Promise<number> {
  const to = await dbToday(tx);
  const from = addDays(to, -WINDOW_DAYS);
  const partners = (await tx.query<{ id: string; profile: Profile }>("select id, profile from orgs where type = 'partner'")).rows;
  for (const p of partners) {
    const inputs = await scorecardInputs(tx, p.id, from, to);
    const card = scorePartner(inputs);
    // One card per partner per day: recomputing replaces today's.
    await tx.query("delete from scorecards where partner_org_id = $1 and computed_at::date = app_now()::date", [p.id]);
    await tx.query("insert into scorecards (partner_org_id, window_from, window_to, inputs, score, parts, provisional) values ($1,$2,$3,$4,$5,$6,$7)", [p.id, from, to, JSON.stringify(inputs), card.score, JSON.stringify(card.parts), card.provisional]);
    const deliveredOnTime = (await tx.query<{ n: number }>(
      `select count(*)::int as n from milestones m where m.partner_org_id = $1 and m.status = 'client_approved'
         and (m.first_submitted_at at time zone 'Asia/Dubai')::date <= m.due_date`,
      [p.id],
    )).rows[0]!;
    await patchProfile(tx, p.id, { quality: card.score, changeOrderRate: inputs.changeOrderRate, deliveredOnTime: num(deliveredOnTime.n), scorecardAt: new Date().toISOString() });
    await audit(tx, actor, "partner.scorecard", "org", p.id, { from, to, score: card.score, provisional: card.provisional, previous: p.profile.quality ?? null });
  }
  return partners.length;
}

const camel = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

export async function scorecardHistory(tx: Queryable, partnerId: string, limit = 26) {
  return (await tx.query("select id, computed_at, window_from::text as window_from, window_to::text as window_to, inputs, score, parts, provisional from scorecards where partner_org_id = $1 order by computed_at desc limit $2", [partnerId, limit])).rows.map(camel);
}

// Partner's view of its own firm -------------------------------------------------------------------------------

export async function partnerOnboarding(tx: Queryable, actor: SessionUser, orgId: string) {
  if (!ownFirm(actor, orgId) && !isStaff(actor)) throw forbidden("Not your firm");
  if (actor.orgType === "partner" && actor.role !== "partner_admin") throw forbidden("Only the firm's admin sees onboarding, documents and staff");
  const p = await loadPartner(tx, orgId);
  const docs = (await tx.query("select id, kind, file_name, uploaded_at, reference, expires_on::text as expires_on, status, verified_at, note from partner_documents where partner_org_id = $1 order by uploaded_at desc", [orgId])).rows;
  // Erased people are MKW's record, not the firm's list.
  const staff = (await tx.query(`select id, name, email, role, status from users where org_id = $1 ${isStaff(actor) ? "" : "and status <> 'erased'"} order by role, name`, [orgId])).rows;
  const scorecards = await scorecardHistory(tx, orgId, 12);
  const { conflicts: _c, bank: _b, importNotes, ftaTaxAgentClaim, ...rest } = p.profile as Record<string, unknown>;
  // MKW's own notes from the import stay with MKW; the firm sees its profile without them.
  const profile = isStaff(actor) ? { ...rest, importNotes, ftaTaxAgentClaim } : rest;
  return { org: { id: p.id, name: p.name }, profile, documents: docs.map(camel), staff, scorecards, moves: MOVES[p.profile.status ?? "prospect"] };
}

// Partner staff ----------------------------------------------------------------------------------------------------

export async function invitePartnerStaff(tx: Queryable, actor: SessionUser, input: { email: string; name: string }) {
  if (actor.role !== "partner_admin") throw forbidden("Only the firm's admin adds staff");
  const email = input.email.trim().toLowerCase();
  const taken = (await tx.query("select 1 from users where email = $1", [email])).rows.length > 0;
  if (taken) throw conflict("That email already has an account");
  const u = (await tx.query<{ id: string }>("insert into users (org_id, email, name, role, invited_by) values ($1, $2, $3, 'partner_staff', $4) returning id", [actor.orgId, email, input.name.trim(), actor.id])).rows[0]!;
  await audit(tx, actor, "user.invited", "user", u.id, { orgId: actor.orgId, role: "partner_staff" });
  return { id: u.id, notification: { to: email, channel: "email" as const, template: "user_invited" as const, vars: { orgName: actor.orgName, role: "partner_staff" } } };
}

export async function setPartnerStaffActive(tx: Queryable, actor: SessionUser, userId: string, active: boolean) {
  if (actor.role !== "partner_admin") throw forbidden("Only the firm's admin removes staff");
  const u = (await tx.query<{ id: string; org_id: string; role: string; status: string; email: string }>("select id, org_id, role, status, email from users where id = $1", [userId])).rows[0];
  if (!u || u.org_id !== actor.orgId) throw notFound("Person not found");
  if (u.role !== "partner_staff") throw forbidden("Admins are managed by MKW Advisors");
  if (u.status === "erased") throw conflict("An erased person cannot be changed");
  if (active) {
    await tx.query("update users set status = 'active', deactivated_at = null where id = $1", [userId]);
    await audit(tx, actor, "user.reactivated", "user", userId, {});
  } else {
    await tx.query("update users set status = 'deactivated', deactivated_at = app_now() where id = $1", [userId]);
    await tx.query("delete from sessions where user_id = $1", [userId]);
    await audit(tx, actor, "user.deactivated", "user", userId, {});
  }
  return { ok: true };
}

async function notifyPartner(tx: Queryable, notify: Notifier, orgId: string, template: Parameters<Notifier["send"]>[0]["template"], vars: Record<string, string | number | undefined>) {
  const admins = (await tx.query<{ email: string }>("select email from users where org_id = $1 and role = 'partner_admin' and status = 'active' order by email limit 3", [orgId])).rows;
  for (const a of admins) await notify.send({ to: a.email, channel: "email", template, vars });
}

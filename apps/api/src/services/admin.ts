import { ROLE_ORG, type OrgType, type Role } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import type { Notification } from "../lib/notify.ts";

/**
 * Console administration: partner organisations, people and their roles, and UAE PDPL data requests.
 * Every function runs inside a platform transaction after the route has checked the caller's role;
 * the finer rules (who may touch which organisation) live here so they are tested in one place.
 *
 *  founder  manages every organisation, including MKW Advisors itself; the only role that may erase
 *  ops      manages client and partner organisations
 *  finance  reads only
 */

interface OrgRow {
  id: string;
  type: OrgType;
  name: string;
  status: string;
}

interface UserRow {
  id: string;
  org_id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "deactivated" | "erased" | "invite_pending";
}

const WRITERS: Role[] = ["ops", "founder"];

async function loadOrg(tx: Queryable, orgId: string): Promise<OrgRow> {
  const r = await tx.query<OrgRow>("select id, type, name, status from orgs where id = $1", [orgId]);
  if (!r.rows[0]) throw notFound("Organisation not found");
  return r.rows[0];
}

async function loadUser(tx: Queryable, userId: string): Promise<UserRow & { org_type: OrgType }> {
  const r = await tx.query<UserRow & { org_type: OrgType }>(
    "select u.id, u.org_id, u.email, u.name, u.role, u.status, o.type as org_type from users u join orgs o on o.id = u.org_id where u.id = $1",
    [userId],
  );
  if (!r.rows[0]) throw notFound("User not found");
  return r.rows[0];
}

/** Who may change people in this organisation. Finance never; ops only outside MKW Advisors itself. */
export function assertCanManage(actor: SessionUser, orgType: OrgType): void {
  if (!WRITERS.includes(actor.role)) throw forbidden("Finance can view users but not change them");
  if (orgType === "platform" && actor.role !== "founder") throw forbidden("Only the founder manages MKW Advisors staff");
}

async function assertNotLastFounder(tx: Queryable, user: UserRow): Promise<void> {
  if (user.role !== "founder") return;
  const n = await tx.query<{ n: number }>("select count(*)::int as n from users where role = 'founder' and status = 'active' and id <> $1", [user.id]);
  if ((n.rows[0]?.n ?? 0) === 0) throw conflict("There must always be one active founder account");
}

// Organisations and people ------------------------------------------------------------

export async function listOrganisations(tx: Queryable, seesBank = false) {
  const orgs = await tx.query<OrgRow & { profile: Record<string, unknown>; created_at: string }>(
    "select id, type, name, status, profile, created_at from orgs order by case type when 'platform' then 0 when 'partner' then 1 else 2 end, name",
  );
  const users = await tx.query<UserRow & { created_at: string; deactivated_at: string | null }>(
    "select id, org_id, email, name, role, status, created_at, deactivated_at from users order by role, name",
  );
  return orgs.rows.map((o) => ({
    id: o.id,
    type: o.type,
    name: o.name,
    status: o.status,
    // Bank details are finance's business; everyone else sees the profile without them.
    profile: o.type === "partner" ? (seesBank ? o.profile : Object.fromEntries(Object.entries(o.profile ?? {}).filter(([k]) => k !== "bank"))) : undefined,
    createdAt: o.created_at,
    users: users.rows
      .filter((u) => u.org_id === o.id)
      .map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.created_at, deactivatedAt: u.deactivated_at })),
  }));
}

export interface NewPartner {
  name: string;
  adminName: string;
  adminEmail: string;
  emirates?: string[];
  codes?: string[];
  capacity?: number;
}

/** A partner firm and its first admin. The firm starts as a prospect with no licence or agreement on file. */
/** A message to send once the transaction has committed, so nothing goes out for a change that was rolled back. */
export type PendingNotification = Notification;

export async function createPartner(tx: Queryable, actor: SessionUser, p: NewPartner) {
  assertCanManage(actor, "partner");
  const email = p.adminEmail.trim().toLowerCase();
  await assertEmailFree(tx, email);
  const profile = {
    status: "prospect",
    licenceActive: false,
    agreementSigned: false,
    emirates: p.emirates ?? [],
    codes: p.codes ?? [],
    capacity: p.capacity ?? 10,
    quality: 60,
    changeOrderRate: 0,
    deliveredOnTime: 0,
  };
  const org = (await tx.query<{ id: string }>("insert into orgs (type, name, profile) values ('partner', $1, $2) returning id", [p.name.trim(), JSON.stringify(profile)])).rows[0]!;
  const user = (
    await tx.query<{ id: string }>("insert into users (org_id, email, name, role, invited_by) values ($1, $2, $3, 'partner_admin', $4) returning id", [
      org.id,
      email,
      p.adminName.trim(),
      actor.id,
    ])
  ).rows[0]!;
  await audit(tx, actor, "partner.created", "org", org.id, { name: p.name.trim(), adminUserId: user.id });
  await audit(tx, actor, "user.invited", "user", user.id, { orgId: org.id, role: "partner_admin" });
  const notification: PendingNotification = { to: email, channel: "email", template: "user_invited", vars: { orgName: p.name.trim(), role: "partner_admin" } };
  return { orgId: org.id, adminUserId: user.id, notification };
}

async function assertEmailFree(tx: Queryable, email: string) {
  const r = await tx.query("select 1 from users where email = $1", [email]);
  if (r.rows.length) throw conflict("A user with that email already exists");
}

export async function inviteUser(tx: Queryable, actor: SessionUser, orgId: string, input: { email: string; name: string; role: Role }) {
  const org = await loadOrg(tx, orgId);
  assertCanManage(actor, org.type);
  if (ROLE_ORG[input.role] !== org.type) throw badRequest(`The role ${input.role} does not belong to a ${org.type} organisation`);
  const email = input.email.trim().toLowerCase();
  await assertEmailFree(tx, email);
  const user = (
    await tx.query<{ id: string }>("insert into users (org_id, email, name, role, invited_by) values ($1, $2, $3, $4, $5) returning id", [
      org.id,
      email,
      input.name.trim(),
      input.role,
      actor.id,
    ])
  ).rows[0]!;
  await audit(tx, actor, "user.invited", "user", user.id, { orgId: org.id, role: input.role });
  const notification: PendingNotification = { to: email, channel: "email", template: "user_invited", vars: { orgName: org.name, role: input.role } };
  return { id: user.id, notification };
}

export async function changeRole(tx: Queryable, actor: SessionUser, userId: string, role: Role) {
  const user = await loadUser(tx, userId);
  assertCanManage(actor, user.org_type);
  if (user.id === actor.id) throw forbidden("You cannot change your own role");
  if (user.status === "erased") throw conflict("This person's data has been erased");
  if (ROLE_ORG[role] !== user.org_type) throw badRequest(`The role ${role} does not belong to a ${user.org_type} organisation`);
  if (user.role === role) return { ok: true, changed: false };
  await assertNotLastFounder(tx, user);
  await tx.query("update users set role = $2 where id = $1", [userId, role]);
  await audit(tx, actor, "user.role_changed", "user", userId, { from: user.role, to: role });
  return { ok: true, changed: true };
}

/** Deactivation ends every session and stops new sign-in codes. Reversible, unlike erasure. */
export async function deactivateUser(tx: Queryable, actor: SessionUser, userId: string) {
  const user = await loadUser(tx, userId);
  assertCanManage(actor, user.org_type);
  if (user.id === actor.id) throw forbidden("You cannot deactivate your own account");
  // An admin held by the import (O10) is cancelled here: deactivated, so the move to pilot does not invite them.
  if (user.status === "invite_pending") {
    await tx.query("update users set status = 'deactivated', deactivated_at = app_now() where id = $1", [userId]);
    await audit(tx, actor, "user.invitation_cancelled", "user", userId, {});
    return { ok: true, changed: true };
  }
  if (user.status !== "active") return { ok: true, changed: false };
  await assertNotLastFounder(tx, user);
  await tx.query("update users set status = 'deactivated', deactivated_at = app_now() where id = $1", [userId]);
  await tx.query("delete from sessions where user_id = $1", [userId]);
  await tx.query("update login_codes set used_at = now() where email = $1 and used_at is null", [user.email]);
  await audit(tx, actor, "user.deactivated", "user", userId, {});
  return { ok: true, changed: true };
}

export async function reactivateUser(tx: Queryable, actor: SessionUser, userId: string) {
  const user = await loadUser(tx, userId);
  assertCanManage(actor, user.org_type);
  if (user.status === "erased") throw conflict("An erased person cannot be reactivated; invite them again as a new user");
  if (user.status === "active") return { ok: true, changed: false };
  if (user.status === "invite_pending") throw conflict("This person's invitation is held until MKW moves the firm to pilot");
  await tx.query("update users set status = 'active', deactivated_at = null where id = $1", [userId]);
  await audit(tx, actor, "user.reactivated", "user", userId, {});
  return { ok: true, changed: true };
}

// UAE PDPL data requests ----------------------------------------------------------------

/**
 * Everything the platform holds about one person, as data they could take elsewhere. Rows that belong to
 * the person's organisation rather than to the person (offers, engagements, payments) are not personal data
 * and are listed only by reference.
 */
export async function exportPerson(tx: Queryable, actor: SessionUser, userId: string) {
  if (!WRITERS.includes(actor.role)) throw forbidden("Finance can view users but not export their data");
  const user = await loadUser(tx, userId);
  if (user.org_type === "platform" && actor.role !== "founder") throw forbidden("Only the founder exports MKW Advisors staff data");
  const org = await loadOrg(tx, user.org_id);
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = [userId]) => tx.query<T>(sql, params).then((r) => r.rows);
  const data = {
    exportedAt: new Date().toISOString(),
    person: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status, consent: (user as { consent?: unknown }).consent ?? null },
    organisation: { id: org.id, name: org.name, type: org.type },
    sessions: await q("select created_at, expires_at from sessions where user_id = $1 order by created_at"),
    signInCodes: await q("select expires_at, attempts, used_at from login_codes where email = $1 order by expires_at", [user.email]),
    messages: await q("select id, engagement_id, body_original as body, created_at from messages where author_user_id = $1 order by created_at"),
    evidenceUploaded: await q("select id, engagement_id, milestone_id, type, file_name, created_at from evidence where uploaded_by = $1 order by created_at"),
    requestsCreated: await q("select id, client_org_id, answers, source, created_at from requests where created_by = $1 order by created_at"),
    leadsHeld: await q("select id, company, name, answers, consent, source, created_at from intake_leads where email = $1 order by created_at", [user.email]),
    ratingsGiven: await q("select id, engagement_id, stars, comment_original as comment, created_at from ratings where author_user_id = $1 order by created_at"),
    documentsUploaded: await q("select id, engagement_id, kind, file_name, status, uploaded_at from document_requests where uploaded_by = $1 order by uploaded_at"),
    obligationEvidenceUploaded: await q("select id, kind, title, evidence_name, evidence_uploaded_at from obligations where evidence_uploaded_by = $1 order by evidence_uploaded_at"),
    payoutsReleased: await q("select id, engagement_id, stage, released_at from payouts where released_by = $1 order by released_at"),
    usersInvited: await q("select id, role, created_at from users where invited_by = $1 order by created_at"),
    dataRequests: await q("select id, kind, status, created_at from data_requests where user_id = $1 order by created_at"),
    notifications: await q("select id, template, subject, body, status, created_at, read_at from notifications where user_id = $1 order by created_at"),
    // Audit payloads are MKW's internal record of what was done and can carry figures (a change order's client
    // price under the partner who proposed it, margin under ops). The export lists what happened and when, never
    // the payload; the person's own words come from the live tables above.
    auditEventsAsActor: await q("select id, at, action, entity, entity_id from audit_events where actor_user_id = $1 order by id"),
    auditEventsAboutThem: await q("select id, at, action, entity from audit_events where entity = 'user' and entity_id = $1 order by id"),
  };
  const summary = {
    sessions: data.sessions.length,
    messages: data.messages.length,
    evidence: data.evidenceUploaded.length,
    auditEvents: data.auditEventsAsActor.length + data.auditEventsAboutThem.length,
  };
  await tx.query("insert into data_requests (user_id, kind, requested_by, summary) values ($1, 'export', $2, $3)", [userId, actor.id, JSON.stringify(summary)]);
  await audit(tx, actor, "pdpl.exported", "user", userId, summary);
  return data;
}

export const TOMBSTONE_NAME = "Erased person";
export const TOMBSTONE_TEXT = "[Removed at the person's request under the UAE PDPL]";
export const tombstoneEmail = (id: string) => `erased-${id}@erased.invalid`;

/**
 * Erase a person's identifying data while keeping what tax law and the audit chain need.
 * Replaces, never deletes: the user row stays (with tombstones) so every foreign key still resolves;
 * payments, payouts, offers and engagements are the organisation's records and stay; audit rows are never
 * touched because each hash covers the one before it. Founder only; irreversible.
 */
export async function erasePerson(tx: Queryable, actor: SessionUser, userId: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder may erase a person's data");
  const user = await loadUser(tx, userId);
  if (user.id === actor.id) throw forbidden("You cannot erase your own account from here");
  if (user.status === "erased") return { ok: true, changed: false };
  await assertNotLastFounder(tx, user);
  // "returning" so the counts are the same whichever driver runs the query.
  const sessions = await tx.query("delete from sessions where user_id = $1 returning token_hash", [userId]);
  const codes = await tx.query("delete from login_codes where email = $1 returning id", [user.email]);
  const messages = await tx.query("update messages set author_name = $2, body_original = $3, body_shown = $3 where author_user_id = $1 returning id", [
    userId,
    TOMBSTONE_NAME,
    TOMBSTONE_TEXT,
  ]);
  const notices = await tx.query(
    "update notifications set to_email = $2, subject = $3, body = '', vars = '{}'::jsonb where user_id = $1 or to_email = $4 returning id",
    [userId, tombstoneEmail(userId), TOMBSTONE_TEXT, user.email],
  );
  // Messages still in the outbox (O11): the address and the wording go; anything not yet sent is cancelled.
  const outbox = await tx.query(
    `update outbox set payload = jsonb_set(jsonb_set(payload, '{to}', to_jsonb($2::text)), '{vars}', '{}'::jsonb),
       last_error = null,
       status = case when status in ('pending', 'failed', 'unknown') then 'cancelled' else status end,
       resolution = case when status in ('pending', 'failed', 'unknown') then 'cancelled: recipient erased' when resolution is null then null else 'recipient erased' end
     where topic = 'notify' and payload->>'to' = $1 returning id`,
    [user.email, tombstoneEmail(userId)],
  );
  // The document checker's drafts about their uploads quote the file name: it goes, the verdict stays.
  await tx.query(
    `update ai_drafts set input = jsonb_set(input, '{fileName}', to_jsonb($2::text)), output = jsonb_set(output, '{summary}', to_jsonb($2::text))
     where kind = 'document_check' and ((subject_type = 'document_request' and subject_id in (select id from document_requests where uploaded_by = $1))
       or (subject_type = 'obligation' and subject_id in (select id from obligations where evidence_uploaded_by = $1)))`,
    [userId, TOMBSTONE_TEXT],
  );
  const leads = await tx.query("update intake_leads set email = $2, name = $3, company = $3, answers = '{}'::jsonb, ip = null where email = $1 returning id", [user.email, tombstoneEmail(userId), TOMBSTONE_NAME]);
  // Their words in ratings go; the stars stay (the partner's scorecard already counted them).
  const ratings = await tx.query("update ratings set comment_original = '', comment_shown = '' where author_user_id = $1 returning id", [userId]);
  // Identity documents they uploaded: the rows are detached from the files (name tombstoned, key cleared) and
  // the keys are listed in the summary so the storage objects can be purged; the request itself stays as the
  // engagement's record that a document was supplied.
  const docKeys = (await tx.query<{ file_key: string }>("select file_key from document_requests where uploaded_by = $1 and file_key is not null", [userId])).rows.map((r) => r.file_key);
  await tx.query("update document_requests set file_name = $2, file_key = null, note = null where uploaded_by = $1 and file_key is not null", [userId, TOMBSTONE_TEXT]);
  const obligationKeys = (await tx.query<{ evidence_key: string }>("select evidence_key from obligations where evidence_uploaded_by = $1 and evidence_key is not null", [userId])).rows.map((r) => r.evidence_key);
  // The obligation stays met (the organisation's record); only the person's file goes.
  await tx.query("update obligations set evidence_name = $2, evidence_key = null where evidence_uploaded_by = $1 and evidence_key is not null", [userId, TOMBSTONE_TEXT]);
  docKeys.push(...obligationKeys);
  await tx.query(
    "update users set name = $2, email = $3, status = 'erased', deactivated_at = coalesce(deactivated_at, app_now()), erased_at = app_now() where id = $1",
    [userId, TOMBSTONE_NAME, tombstoneEmail(userId)],
  );
  const summary = {
    sessionsDeleted: sessions.rows.length,
    signInCodesDeleted: codes.rows.length,
    messagesTombstoned: messages.rows.length,
    notificationsTombstoned: notices.rows.length,
    outboxTombstoned: outbox.rows.length,
    leadsTombstoned: leads.rows.length,
    ratingCommentsCleared: ratings.rows.length,
    documentFilesDetached: docKeys.length,
    documentFilesToPurge: docKeys,
    kept: ["payments", "payouts", "offers", "engagements", "evidence files", "audit events"],
  };
  await tx.query("insert into data_requests (user_id, kind, requested_by, summary) values ($1, 'erase', $2, $3)", [userId, actor.id, JSON.stringify(summary)]);
  await audit(tx, actor, "pdpl.erased", "user", userId, summary);
  return { ok: true, changed: true, ...summary };
}

// Retention settings ----------------------------------------------------------------------

export interface RetentionPeriod {
  years?: number | null;
  days?: number | null;
  basis: string;
  confidence: "UNCERTAIN" | "verified";
}
export interface Retention {
  confirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  periods: Record<string, RetentionPeriod>;
}

export async function getRetention(tx: Queryable): Promise<Retention> {
  const r = await tx.query<{ value: Retention }>("select value from settings where key = 'retention'");
  if (!r.rows[0]) throw notFound("Retention settings not found");
  return r.rows[0].value;
}

/**
 * The founder confirms the periods after legal advice. Confirming marks each period verified and records who
 * confirmed and when; every change is audited with the old and new values.
 */
export async function confirmRetention(tx: Queryable, actor: SessionUser, patch: Partial<Record<string, Partial<Pick<RetentionPeriod, "years" | "days">>>>, note: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder confirms retention periods");
  const current = await getRetention(tx);
  const periods: Record<string, RetentionPeriod> = {};
  for (const [key, p] of Object.entries(current.periods)) {
    const change = patch[key] ?? {};
    periods[key] = { ...p, ...change, confidence: "verified" };
  }
  for (const key of Object.keys(patch)) if (!(key in current.periods)) throw badRequest(`Unknown retention period ${key}`);
  const next: Retention = { confirmed: true, confirmedBy: actor.id, confirmedAt: new Date().toISOString(), periods };
  await tx.query("update settings set value = $1 where key = 'retention'", [JSON.stringify(next)]);
  await audit(tx, actor, "settings.retention_confirmed", "settings", "retention", { before: current.periods, after: periods, note });
  return next;
}

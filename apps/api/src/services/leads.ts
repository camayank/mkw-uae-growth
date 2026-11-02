import { createHash, randomInt } from "node:crypto";
import { cleanAttribution, scoreLead, type AdviceInput, type Attribution, type LeadSignals, type Segment } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { getRetention } from "./admin.ts";

/**
 * Lead intelligence (E4). A saved assessment is the founder's own action and holds no contact details. A lead is one
 * person who asked for a review: its own identity, with consents per purpose, the session and source it came from,
 * two scores, a segment and an owner. Everything here is internal: nothing is sent to a lead by any function in this
 * file (rule 6); follow-ups are tasks for a person.
 */

export const SEGMENTS: Segment[] = ["starter", "standard", "complex", "regulated", "cross_border"];
export const LEAD_STATUSES = ["new", "routed", "contacted", "consultation", "converted", "closed"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** The consent texts the public pages show, by purpose and version (the record names what the person agreed to). */
export const CONSENT_TEXTS: Record<"marketing" | "partner_disclosure", { version: string; text: string; confidence: "UNCERTAIN" }> = {
  marketing: { version: "2026-11-marketing-v1", text: "MKW Advisors may send me occasional updates about UAE company setup and its services. I can withdraw this at any time.", confidence: "UNCERTAIN" },
  partner_disclosure: { version: "2026-11-partner-v1", text: "MKW Advisors may name my company to a vetted partner firm it has chosen for my request before I accept an offer, so the firm can prepare. Until then partners see my request without my name.", confidence: "UNCERTAIN" },
};

const hash = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
/** A recovery code a person can type: 10 characters from an alphabet without look-alikes. */
export function newCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

/**
 * A lead "became a client" when an offer on its request was accepted (or an engagement exists for the organisation
 * it became). Submitting a form creates a client organisation and a request, which is not the same thing.
 */
const BECAME_CLIENT = `exists (select 1 from offers f where f.request_id = l.request_id and f.status = 'accepted')
  or exists (select 1 from engagements e where e.client_org_id = l.client_org_id)`;

export interface SavedSummary {
  recommendation: string | null;
  confirmed: boolean;
  approvedStatements: number;
  approvedPlaces: number;
  noViableOption: boolean;
}

/** Save an assessment: the answers, the public result's summary, the attribution. No contact details are taken. */
export async function saveAssessment(tx: Queryable, answers: AdviceInput, summary: SavedSummary, attribution: Attribution, versions: { engineVersion?: string; asOf?: string }): Promise<{ code: string; id: string }> {
  const code = newCode();
  const r = (
    await tx.query<{ id: string }>(
      "insert into assessments (code_hash, answers, summary, source, engine_version, data_as_of) values ($1,$2,$3,$4,$5,$6) returning id",
      [hash(code), JSON.stringify(answers), JSON.stringify(summary), JSON.stringify(attribution), versions.engineVersion ?? null, versions.asOf ?? null],
    )
  ).rows[0]!;
  return { code, id: r.id };
}

/** Recover a saved assessment by its code: the answers to run again on today's rules. */
export async function recoverAssessment(tx: Queryable, code: string): Promise<{ id: string; answers: AdviceInput; savedAt: string; recovered: number } | null> {
  const r = (await tx.query<{ id: string; answers: AdviceInput; created_at: string; recovered: number; status: string }>("select id, answers, created_at, recovered, status from assessments where code_hash = $1", [hash(code)])).rows[0];
  if (!r || r.status === "anonymised") return null;
  await tx.query("update assessments set recovered = recovered + 1, last_seen_at = app_now() where id = $1", [r.id]);
  return { id: r.id, answers: r.answers, savedAt: r.created_at, recovered: num(r.recovered) + 1 };
}

async function assessmentByCode(tx: Queryable, code: string | undefined): Promise<{ id: string; recovered: number } | null> {
  if (!code) return null;
  const r = (await tx.query<{ id: string; recovered: number }>("select id, recovered from assessments where code_hash = $1 and status <> 'anonymised'", [hash(code)])).rows[0];
  return r ? { id: r.id, recovered: num(r.recovered) } : null;
}

export interface NewLead {
  email: string;
  name: string;
  company: string;
  phoneGiven: boolean;
  answers: AdviceInput;
  attribution: Attribution;
  assessmentCode?: string;
  consents: { service: { version: string }; marketing?: { given: boolean; version: string }; partnerDisclosure?: { given: boolean; version: string } };
  consultation?: { wanted: boolean; times?: string } | null;
  signals?: Pick<LeadSignals, "contradictions" | "missingFacts" | "noViableOption">;
  ip: string | null;
  /** What the review request became. */
  outcome: { clientOrgId?: string | null; requestId?: string | null; intakeLeadId?: string | null };
}

/** Where a segment's leads go: a platform user per segment on Settings; unmapped segments go to the ops queue. */
export async function getRouting(tx: Queryable): Promise<Record<string, string | null>> {
  const r = await tx.query<{ value: Record<string, string | null> }>("select value from settings where key = 'lead_routing'");
  return r.rows[0]?.value ?? {};
}

export async function setRouting(tx: Queryable, actor: SessionUser, routing: Record<string, string | null>) {
  if (actor.role !== "founder") throw forbidden("Only the founder sets who owns each kind of lead");
  const clean: Record<string, string | null> = {};
  for (const seg of SEGMENTS) {
    const id = routing[seg] ?? null;
    if (id) {
      const u = (await tx.query<{ role: string; status: string }>("select u.role, u.status from users u join orgs o on o.id = u.org_id where u.id = $1 and o.type = 'platform'", [id])).rows[0];
      if (!u || !["ops", "founder"].includes(u.role) || u.status !== "active") throw badRequest(`The owner for ${seg.replace("_", " ")} must be an active MKW ops or founder user`);
    }
    clean[seg] = id;
  }
  const before = await getRouting(tx);
  await tx.query("insert into settings (key, value) values ('lead_routing', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(clean)]);
  await audit(tx, actor, "settings.lead_routing", "settings", "lead_routing", { before, after: clean });
  return clean;
}

/** Record a lead for a review request: identity, consents, scores, segment and owner. Nothing is sent. */
export async function createLead(tx: Queryable, input: NewLead): Promise<{ id: string; segment: Segment; owner: string | null }> {
  const session = await assessmentByCode(tx, input.assessmentCode);
  const score = scoreLead(input.answers, { ...input.signals, recovered: session?.recovered ?? 0, phoneGiven: input.phoneGiven, consultationRequested: !!input.consultation?.wanted });
  const routing = await getRouting(tx);
  const owner = routing[score.segment] ?? null;
  const status: LeadStatus = owner ? "routed" : "new";
  const r = (
    await tx.query<{ id: string }>(
      `insert into leads (email, name, company, phone_given, assessment_id, answers, source, segment, complexity, intent, high_intent, consultation, status, owner_user_id, client_org_id, request_id, intake_lead_id, ip)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
      [
        input.email.trim().toLowerCase(), input.name.trim(), input.company.trim(), input.phoneGiven, session?.id ?? null, JSON.stringify(input.answers), JSON.stringify(cleanAttribution(input.attribution as Record<string, unknown>)),
        score.segment, score.complexity, score.intent, score.highIntent, input.consultation?.wanted ? JSON.stringify({ times: (input.consultation.times ?? "").slice(0, 300), at: new Date().toISOString() }) : null,
        status, owner, input.outcome.clientOrgId ?? null, input.outcome.requestId ?? null, input.outcome.intakeLeadId ?? null, input.ip,
      ],
    )
  ).rows[0]!;
  if (session) await tx.query("update assessments set status = 'lead' where id = $1", [session.id]);
  // No IP on the consent record: the lead row holds it, and that row is tombstoned on erasure.
  const consent = async (purpose: "service" | "marketing" | "partner_disclosure", given: boolean, version: string) =>
    tx.query("insert into consents (subject_kind, subject_id, purpose, given, version, channel) values ('lead', $1, $2, $3, $4, 'public_intake')", [r.id, purpose, given, version]);
  await consent("service", true, input.consents.service.version);
  await consent("marketing", !!input.consents.marketing?.given, input.consents.marketing?.version ?? CONSENT_TEXTS.marketing.version);
  await consent("partner_disclosure", !!input.consents.partnerDisclosure?.given, input.consents.partnerDisclosure?.version ?? CONSENT_TEXTS.partner_disclosure.version);
  if (owner) await tx.query("insert into lead_notes (lead_id, author_user_id, kind, body) values ($1, null, 'assigned', $2)", [r.id, `Routed to the owner for ${score.segment.replace("_", " ")} leads`]);
  await audit(tx, null, "lead.created", "lead", r.id, { segment: score.segment, complexity: score.complexity, intent: score.intent, highIntent: score.highIntent, factors: score.factors, owner, session: !!session, consultation: !!input.consultation?.wanted, source: cleanAttribution(input.attribution as Record<string, unknown>) });
  return { id: r.id, segment: score.segment, owner };
}

const PIPELINE_ROLES = ["ops", "founder"];
const requirePipeline = (actor: SessionUser) => {
  if (!PIPELINE_ROLES.includes(actor.role)) throw forbidden("Only MKW ops and the founder work the lead pipeline");
};

const LEAD_COLUMNS = `l.id, l.email, l.name, l.company, l.phone_given, l.assessment_id, l.answers, l.source, l.segment, l.complexity, l.intent, l.high_intent, l.consultation, l.status,
  l.owner_user_id, u.name as owner_name, l.client_org_id, l.request_id, l.intake_lead_id, l.created_at, l.updated_at`;

export async function listLeads(tx: Queryable, actor: SessionUser, filter: { status?: string; segment?: string; owner?: string } = {}) {
  requirePipeline(actor);
  const where: string[] = ["l.status <> 'anonymised'"];
  const params: unknown[] = [];
  if (filter.status) (params.push(filter.status), where.push(`l.status = $${params.length}`));
  if (filter.segment) (params.push(filter.segment), where.push(`l.segment = $${params.length}`));
  if (filter.owner === "me") (params.push(actor.id), where.push(`l.owner_user_id = $${params.length}`));
  const r = await tx.query<Record<string, unknown>>(
    `select ${LEAD_COLUMNS},
       (select count(*)::int from lead_notes n where n.lead_id = l.id and n.kind = 'followup' and n.done_at is null) as open_followups,
       (select min(n.due_at) from lead_notes n where n.lead_id = l.id and n.kind = 'followup' and n.done_at is null) as next_followup,
       (select jsonb_object_agg(c.purpose, c.given) from (select distinct on (purpose) purpose, given from consents c where c.subject_kind = 'lead' and c.subject_id = l.id order by purpose, id desc) c) as consents
     from leads l left join users u on u.id = l.owner_user_id where ${where.join(" and ")} order by l.high_intent desc, l.intent desc, l.created_at desc limit 500`,
    params,
  );
  return r.rows.map(leadRow);
}

const leadRow = (x: Record<string, unknown>) => ({
  id: x.id,
  email: x.email,
  name: x.name,
  company: x.company,
  phoneGiven: x.phone_given,
  assessmentId: x.assessment_id,
  answers: x.answers,
  source: x.source,
  segment: x.segment,
  complexity: num(x.complexity),
  intent: num(x.intent),
  highIntent: x.high_intent,
  consultation: x.consultation,
  status: x.status,
  ownerUserId: x.owner_user_id,
  owner: x.owner_name,
  clientOrgId: x.client_org_id,
  requestId: x.request_id,
  intakeLeadId: x.intake_lead_id,
  createdAt: x.created_at,
  updatedAt: x.updated_at,
  openFollowups: num(x.open_followups ?? 0),
  nextFollowup: x.next_followup ?? null,
  consents: x.consents ?? {},
});

export async function leadDetail(tx: Queryable, actor: SessionUser, id: string) {
  requirePipeline(actor);
  const r = await tx.query<Record<string, unknown>>(
    `select ${LEAD_COLUMNS},
       (select count(*)::int from lead_notes n where n.lead_id = l.id and n.kind = 'followup' and n.done_at is null) as open_followups,
       (select min(n.due_at) from lead_notes n where n.lead_id = l.id and n.kind = 'followup' and n.done_at is null) as next_followup,
       (select jsonb_object_agg(c.purpose, c.given) from (select distinct on (purpose) purpose, given from consents c where c.subject_kind = 'lead' and c.subject_id = l.id order by purpose, id desc) c) as consents,
       (${BECAME_CLIENT}) as became_client
     from leads l left join users u on u.id = l.owner_user_id where l.id = $1 and l.status <> 'anonymised'`,
    [id],
  );
  if (!r.rows[0]) throw notFound("Lead not found");
  const lead = { ...leadRow(r.rows[0]), becameClient: !!r.rows[0].became_client };
  const notes = (await tx.query<Record<string, unknown>>("select n.id, n.kind, n.body, n.due_at, n.done_at, n.created_at, u.name as author from lead_notes n left join users u on u.id = n.author_user_id where n.lead_id = $1 order by n.id desc", [id])).rows;
  const consents = (await tx.query<Record<string, unknown>>("select purpose, given, version, channel, at from consents where subject_kind = 'lead' and subject_id = $1 order by id", [id])).rows;
  return { ...lead, notes, consentHistory: consents };
}

async function loadLead(tx: Queryable, id: string) {
  const l = (await tx.query<{ id: string; status: string; owner_user_id: string | null }>("select id, status, owner_user_id from leads where id = $1 for update", [id])).rows[0];
  if (!l) throw notFound("Lead not found");
  if (l.status === "anonymised") throw conflict("This lead was anonymised under the retention rule");
  return l;
}

export async function assignLead(tx: Queryable, actor: SessionUser, id: string, ownerUserId: string | null, note = "") {
  requirePipeline(actor);
  const l = await loadLead(tx, id);
  if (ownerUserId) {
    const u = (await tx.query<{ name: string }>("select u.name from users u join orgs o on o.id = u.org_id where u.id = $1 and o.type = 'platform' and u.role in ('ops', 'founder') and u.status = 'active'", [ownerUserId])).rows[0];
    if (!u) throw badRequest("The owner must be an active MKW ops or founder user");
  }
  await tx.query("update leads set owner_user_id = $2::uuid, status = case when status = 'new' and $2::uuid is not null then 'routed' else status end, updated_at = app_now() where id = $1", [id, ownerUserId]);
  await tx.query("insert into lead_notes (lead_id, author_user_id, kind, body) values ($1, $2, 'assigned', $3)", [id, actor.id, note || (ownerUserId ? "Assigned" : "Unassigned")]);
  await audit(tx, actor, "lead.assigned", "lead", id, { from: l.owner_user_id, to: ownerUserId });
  return { ok: true };
}

export async function setLeadStatus(tx: Queryable, actor: SessionUser, id: string, status: LeadStatus, note = "") {
  requirePipeline(actor);
  if (!LEAD_STATUSES.includes(status)) throw badRequest("Unknown lead status");
  const l = await loadLead(tx, id);
  if (l.status === "converted") throw conflict("A converted lead stays converted; what follows is on the client's engagement");
  if (status === "converted") {
    const became = (await tx.query(`select 1 from leads l where l.id = $1 and (${BECAME_CLIENT})`, [id])).rows.length;
    if (!became) throw conflict("A lead counts as converted only once an offer on its request is accepted; a submitted form is not a client yet");
  }
  await tx.query("update leads set status = $2, updated_at = app_now() where id = $1", [id, status]);
  await tx.query("insert into lead_notes (lead_id, author_user_id, kind, body) values ($1, $2, 'status', $3)", [id, actor.id, `${l.status} → ${status}${note ? `: ${note}` : ""}`]);
  await audit(tx, actor, "lead.status", "lead", id, { from: l.status, to: status });
  return { ok: true };
}

export async function addLeadNote(tx: Queryable, actor: SessionUser, id: string, body: string) {
  requirePipeline(actor);
  await loadLead(tx, id);
  if (!body.trim()) throw badRequest("Write the note");
  await tx.query("insert into lead_notes (lead_id, author_user_id, kind, body) values ($1, $2, 'note', $3)", [id, actor.id, body.trim().slice(0, 2000)]);
  await audit(tx, actor, "lead.note", "lead", id, {});
  return { ok: true };
}

/** A follow-up is a task for a person, due on a date: it appears in the ops queue when due. Nothing is sent. */
export async function setFollowup(tx: Queryable, actor: SessionUser, id: string, dueAt: string, body: string) {
  requirePipeline(actor);
  await loadLead(tx, id);
  if (Number.isNaN(Date.parse(dueAt))) throw badRequest("The follow-up needs a date");
  const r = (await tx.query<{ id: number }>("insert into lead_notes (lead_id, author_user_id, kind, body, due_at) values ($1, $2, 'followup', $3, $4) returning id", [id, actor.id, body.trim().slice(0, 500), new Date(dueAt).toISOString()])).rows[0]!;
  await audit(tx, actor, "lead.followup_set", "lead", id, { followupId: num(r.id), dueAt }); // the text stays in lead_notes, which erasure reaches
  return { id: num(r.id) };
}

export async function completeFollowup(tx: Queryable, actor: SessionUser, followupId: number, note = "") {
  requirePipeline(actor);
  const f = (await tx.query<{ id: number; lead_id: string; done_at: string | null }>("select id, lead_id, done_at from lead_notes where id = $1 and kind = 'followup' for update", [followupId])).rows[0];
  if (!f) throw notFound("Follow-up not found");
  if (f.done_at) throw conflict("This follow-up is already done");
  await tx.query("update lead_notes set done_at = app_now() where id = $1", [followupId]);
  await tx.query("insert into lead_notes (lead_id, author_user_id, kind, body) values ($1, $2, 'followup_done', $3)", [f.lead_id, actor.id, note.trim().slice(0, 500)]);
  await audit(tx, actor, "lead.followup_done", "lead", f.lead_id, { followupId });
  return { ok: true };
}

/** A person records that the lead withdrew a consent (by email, phone or in writing): a new record, never an edit. */
export async function withdrawConsent(tx: Queryable, actor: SessionUser, id: string, purpose: "marketing" | "partner_disclosure", note: string) {
  requirePipeline(actor);
  await loadLead(tx, id);
  if (!note.trim()) throw badRequest("Say how the person withdrew (recorded with the withdrawal)");
  const current = (await tx.query<{ version: string }>("select version from consents where subject_kind = 'lead' and subject_id = $1 and purpose = $2 order by id desc limit 1", [id, purpose])).rows[0];
  await tx.query("insert into consents (subject_kind, subject_id, purpose, given, version, channel) values ('lead', $1, $2, false, $3, 'ops')", [id, purpose, current?.version ?? CONSENT_TEXTS[purpose].version]);
  await tx.query("insert into lead_notes (lead_id, author_user_id, kind, body) values ($1, $2, 'note', $3)", [id, actor.id, `Consent withdrawn: ${purpose.replace("_", " ")}. ${note.trim()}`]);
  await audit(tx, actor, "lead.consent_withdrawn", "lead", id, { purpose });
  return { ok: true };
}

/** Per source and campaign: saved assessments, leads, requests, offers published and accepted, client revenue (fils). */
export async function leadAnalytics(tx: Queryable, actor: SessionUser) {
  requirePipeline(actor);
  const r = await tx.query<Record<string, unknown>>(
    `with src as (
       select coalesce(source->>'source', 'direct') as source, coalesce(source->>'campaign', '') as campaign, 'assessment' as what, 1 as n, 0::bigint as fils from assessments
       union all
       select coalesce(l.source->>'source', 'direct'), coalesce(l.source->>'campaign', ''), 'lead', 1, 0 from leads l
       union all
       select coalesce(l.source->>'source', 'direct'), coalesce(l.source->>'campaign', ''), 'request', 1, 0 from leads l where l.request_id is not null
       union all
       select coalesce(l.source->>'source', 'direct'), coalesce(l.source->>'campaign', ''), 'published', 1, 0 from leads l where exists (select 1 from offers f where f.request_id = l.request_id and f.status in ('published', 'accepted'))
       union all
       select coalesce(l.source->>'source', 'direct'), coalesce(l.source->>'campaign', ''), 'accepted', 1, (select sum(f.client_total_fils) from offers f where f.request_id = l.request_id and f.status = 'accepted') from leads l where exists (select 1 from offers f where f.request_id = l.request_id and f.status = 'accepted')
     )
     select source, campaign,
       sum(case when what = 'assessment' then n else 0 end)::int as assessments,
       sum(case when what = 'lead' then n else 0 end)::int as leads,
       sum(case when what = 'request' then n else 0 end)::int as requests,
       sum(case when what = 'published' then n else 0 end)::int as offers_published,
       sum(case when what = 'accepted' then n else 0 end)::int as offers_accepted,
       sum(case when what = 'accepted' then fils else 0 end)::bigint as revenue_fils
     from src group by source, campaign order by revenue_fils desc, leads desc, source, campaign`,
  );
  return r.rows.map((x) => ({ source: x.source, campaign: x.campaign, assessments: num(x.assessments), leads: num(x.leads), requests: num(x.requests), offersPublished: num(x.offers_published), offersAccepted: num(x.offers_accepted), revenueFils: num(x.revenue_fils) }));
}

/**
 * Retention (rule 9): leads and saved assessments that never became a client are anonymised after the confirmed
 * period. Runs only once the founder has confirmed the retention periods; until then it counts what it would do
 * and changes nothing. Counts stay for analytics (the rows remain, without personal data).
 */
export async function anonymiseOldLeads(tx: Queryable, actor: SessionUser | null): Promise<{ leads: number; assessments: number; applied: boolean }> {
  const retention = await getRetention(tx);
  const period = retention.periods.leads;
  const days = period?.days ?? null;
  if (!days || !Number.isFinite(days) || days < 1) return { leads: 0, assessments: 0, applied: false };
  const applied = !!retention.confirmed && period!.confidence === "verified";
  const cutoff = `app_now() - make_interval(days => ${Math.floor(days)})`;
  // Old enough, and never a client: no accepted offer on the lead's request and no engagement for its organisation.
  const dueLeads = `from leads l where l.status <> 'anonymised' and l.created_at < ${cutoff} and not (${BECAME_CLIENT})`;
  const dueAssessments = `from assessments a where a.status <> 'anonymised' and a.created_at < ${cutoff}
    and not exists (select 1 from leads l where l.assessment_id = a.id and (l.status = 'anonymised' or (${BECAME_CLIENT})) and l.status <> 'anonymised')`;
  if (!applied) {
    const l = (await tx.query<{ n: number }>(`select count(*)::int as n ${dueLeads}`)).rows[0]!.n;
    const a = (await tx.query<{ n: number }>(`select count(*)::int as n ${dueAssessments}`)).rows[0]!.n;
    return { leads: num(l), assessments: num(a), applied: false };
  }
  const leads = (
    await tx.query<{ id: string }>(
      `update leads set email = 'anonymised-' || id::text || '@erased.invalid', name = 'Anonymised', company = 'Anonymised', answers = '{}'::jsonb, consultation = null, ip = null, status = 'anonymised', updated_at = app_now()
       where id in (select l.id ${dueLeads}) returning id`,
    )
  ).rows;
  for (const l of leads) await tx.query("update lead_notes set body = '' where lead_id = $1", [l.id]);
  // Saved assessments: old open ones, and the ones behind leads that were just anonymised.
  const assessments = (
    await tx.query<{ id: string }>(
      `update assessments set answers = '{}'::jsonb, status = 'anonymised', code_hash = 'anonymised-' || id::text
       where status <> 'anonymised' and (id in (select a.id ${dueAssessments}) or id in (select assessment_id from leads where status = 'anonymised' and assessment_id is not null)) returning id`,
    )
  ).rows;
  if (leads.length || assessments.length) await audit(tx, actor, "leads.anonymised", "settings", "retention", { leads: leads.length, assessments: assessments.length, days });
  return { leads: leads.length, assessments: assessments.length, applied: true };
}

/** Everything the platform holds on an email address as a lead, for the PDPL export. */
export async function leadsForEmail(tx: Queryable, email: string) {
  const leads = (await tx.query<Record<string, unknown>>("select id, company, name, answers, source, segment, status, consultation, created_at from leads where email = $1 order by created_at", [email.toLowerCase()])).rows;
  const ids = leads.map((l) => l.id as string);
  const consents = ids.length ? (await tx.query<Record<string, unknown>>("select subject_id as lead_id, purpose, given, version, channel, at from consents where subject_kind = 'lead' and subject_id = any($1::uuid[]) order by id", [ids])).rows : [];
  const leadNotes = ids.length ? (await tx.query<Record<string, unknown>>("select lead_id, kind, body, due_at, done_at, created_at from lead_notes where lead_id = any($1::uuid[]) order by id", [ids])).rows : [];
  const assessments = ids.length ? (await tx.query<Record<string, unknown>>("select a.id, a.answers, a.summary, a.source, a.created_at from assessments a where a.id in (select assessment_id from leads where id = any($1::uuid[]) and assessment_id is not null)", [ids])).rows : [];
  return { leads, consents, leadNotes, assessments };
}

/** Erase a person's leads (PDPL): personal data tombstoned, the rows and the consent history kept. */
export async function eraseLeadsForEmail(tx: Queryable, email: string, tombstone: string): Promise<number> {
  const rows = (await tx.query<{ id: string; assessment_id: string | null }>("update leads set email = $2, name = 'Erased person', company = 'Erased person', answers = '{}'::jsonb, consultation = null, ip = null, updated_at = app_now() where email = $1 returning id, assessment_id", [email.toLowerCase(), tombstone])).rows;
  for (const l of rows) {
    await tx.query("update lead_notes set body = $2 where lead_id = $1", [l.id, "[Removed at the person's request under the UAE PDPL]"]);
    // The saved answers behind the lead are personal data too.
    if (l.assessment_id) await tx.query("update assessments set answers = '{}'::jsonb, status = 'anonymised', code_hash = 'anonymised-' || id::text where id = $1", [l.assessment_id]);
  }
  return rows.length;
}

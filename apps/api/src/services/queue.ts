import { addWorkingHours, QUEUE_POLICY, rankQueue, workingHoursBetween, type QueueKind, type QueueSignals, type WorkCalendar } from "@tasees/core";
import type { SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { badRequest } from "../lib/errors.ts";
import { loadCalendar } from "./calendar.ts";
import { latestChecks, type CheckSubject } from "./doccheck.ts";

/**
 * The ops command centre (O11): every item that needs a person, from every table that can produce one, ranked by
 * `rankQueue` in core. Each item says why it is here, what is at risk, shows the AI's draft where there is one, and
 * offers the obvious action when it needs no further input. The ranking orders; a person decides.
 */

/** Client documents count as overdue once requested this many working hours ago (three working days). */
export const DOCUMENTS_OVERDUE_HOURS = 27;
/** Partner licences show this many days before they expire. */
export const LICENCE_WARNING_DAYS = 30;

interface Row {
  kind: QueueKind;
  ref: string;
  subject_id: string;
  engagement_id: string | null;
  partner_org_id: string | null;
  detail: string;
  at: string;
  info: Record<string, unknown>;
  client_waiting: boolean;
  partner_waiting: boolean;
  money_waiting: boolean;
}

export interface QueueAction {
  label: string;
  method: "POST";
  path: string;
  body: Record<string, unknown>;
  /** Ask the person for a note first; it goes into the body under `note`. */
  prompt?: string;
  primary?: boolean;
}

export interface QueueItem {
  id: string;
  kind: QueueKind;
  label: string;
  ref: string;
  subjectId: string;
  engagementId: string | null;
  detail: string;
  why: string;
  at: string;
  dueAt: string;
  hoursLeft: number;
  level: "overdue" | "due_soon" | "on_track";
  risk: number;
  factors: string[];
  link: string;
  actions: QueueAction[];
  drafts: Array<{ id: string; status: string; check: Record<string, unknown>; at: string; subject: string }>;
}

const SOURCES = `
select 'system_alert' as kind, a.id::text as ref, a.id::text as subject_id, null::text as engagement_id, null::text as partner_org_id,
       a.summary as detail, a.opened_at as at, jsonb_build_object('summary', a.summary, 'severity', a.severity) as info,
       false as client_waiting, false as partner_waiting, false as money_waiting
  from alerts a where a.closed_at is null
union all
select 'offer_review', f.id::text as ref, f.id::text as subject_id, null::text as engagement_id, null::text as partner_org_id,
       'Offer needs review: ' || f.lines_needing_review || ' line(s)' as detail, f.created_at as at,
       jsonb_build_object('client', c.name, 'lines', f.lines_needing_review, 'tier', f.tier) as info, true as client_waiting, false as partner_waiting, false as money_waiting
  from offers f join orgs c on c.id = f.client_org_id where f.status = 'ops_review'
union all
select 'offer_ready', f.id::text, f.id::text, null, null, 'Draft offer ready to publish (' || f.tier || ')', f.created_at,
       jsonb_build_object('client', c.name, 'tier', f.tier), true, false, false
  from offers f join orgs c on c.id = f.client_org_id where f.status = 'draft'
union all
select 'needs_quote', r.id::text, r.id::text, null, null, 'No rate card for part of this request: open a request for quote', r.created_at,
       jsonb_build_object('client', c.name), true, false, false
  from requests r join orgs c on c.id = r.client_org_id where r.status = 'quoting'
union all
select 'qa', m.engagement_id::text, m.id::text, m.engagement_id::text, m.partner_org_id::text, 'Evidence to check: ' || m.name, m.updated_at,
       jsonb_build_object('step', m.name, 'partner', p.name, 'files', (select count(*) from evidence e where e.milestone_id = m.id)), true, true, false
  from milestones m left join orgs p on p.id = m.partner_org_id where m.status = 'evidence_submitted'
union all
select 'dispute', m.engagement_id::text, m.id::text, m.engagement_id::text, m.partner_org_id::text, 'Client raised an issue: ' || coalesce(m.dispute_reason, ''), m.updated_at,
       jsonb_build_object('step', m.name, 'reason', coalesce(m.dispute_reason, '')), true, true, false
  from milestones m where m.status = 'disputed'
union all
select 'unallocated', e.id::text, e.id::text, e.id::text, null, 'Lines with no partner and no open offer', e.created_at,
       jsonb_build_object('client', c.name), true, false, false
  from engagements e join orgs c on c.id = e.client_org_id
 where e.status = 'allocating' and exists (
   select 1 from engagement_lines l where l.engagement_id = e.id and l.partner_org_id is null
     and not exists (select 1 from allocations a where a.engagement_id = e.id and l.code = any(a.codes)
                     and a.accepted_at is null and a.declined_at is null and a.timed_out_at is null))
union all
select 'payout', p.engagement_id::text, p.id::text, p.engagement_id::text, p.partner_org_id::text, 'Payout ready to release: ' || p.stage, coalesce(p.eligible_at, app_now()),
       jsonb_build_object('stage', p.stage, 'partner', o.name), false, true, true
  from payouts p join orgs o on o.id = p.partner_org_id where p.status = 'eligible'
union all
select 'scoping', r.id::text, r.id::text, null, null, 'Scoping advice to review before the client sees it', r.created_at,
       jsonb_build_object('client', c.name), true, false, false
  from requests r join orgs c on c.id = r.client_org_id where r.advice_status = 'pending_review'
union all
select 'ai_draft', d.id::text, d.id::text, d.engagement_id::text, null, 'AI draft waiting for a decision (' || d.kind || ')', d.created_at,
       jsonb_build_object('draftKind', d.kind, 'summary', d.output->>'summary'), false, false, false
  from ai_drafts d where d.status = 'pending' and d.kind <> 'document_check'
union all
select 'document_check', d.id::text, d.id::text, d.engagement_id::text, null, 'Document check to confirm: ' || coalesce(dr.kind, 'document'), d.created_at,
       jsonb_build_object('file', dr.file_name, 'kind', dr.kind, 'summary', d.output->>'summary'), false, true, false
  from ai_drafts d left join document_requests dr on dr.id = d.subject_id
 where d.status = 'pending' and d.kind = 'document_check' and d.subject_type = 'document_request'
union all
select 'lead', l.id::text, l.id::text, null, null, 'Public lead for an email that already has an account: ' || l.company, l.created_at,
       jsonb_build_object('company', l.company), false, false, false
  from intake_leads l where l.status = 'held'
union all
select 'delay', d.id::text, d.id::text, m.engagement_id::text, m.partner_org_id::text, 'Late step to attribute: ' || m.name, d.noticed_at,
       jsonb_build_object('step', m.name), false, false, false
  from delays d join milestones m on m.id = d.milestone_id where d.cause is null and m.status <> 'client_approved'
union all
select 'credit', g.id::text, g.id::text, g.engagement_id::text, null, 'Service guarantee credit for finance to decide', g.created_at,
       '{}'::jsonb, true, false, true
  from guarantee_credits g where g.status = 'pending'
union all
select 'partner_document', pd.id::text, pd.id::text, null, pd.partner_org_id::text, 'Partner document to verify: ' || replace(pd.kind, '_', ' ') || ' (' || o.name || ')', pd.uploaded_at,
       jsonb_build_object('firm', o.name, 'docKind', pd.kind), false, true, false
  from partner_documents pd join orgs o on o.id = pd.partner_org_id where pd.status = 'uploaded'
union all
select 'obligation', ob.id::text, ob.id::text, ob.engagement_id::text, null, 'Compliance date to confirm: ' || ob.title || ' (' || c.name || ')', ob.created_at,
       jsonb_build_object('title', ob.title, 'client', c.name), false, false, false
  from obligations ob join orgs c on c.id = ob.client_org_id where ob.status = 'pending_review'
union all
select 'obligation_evidence', ob.id::text, ob.id::text, ob.engagement_id::text, null, 'Filing evidence to check: ' || ob.title || ' (' || c.name || ')', ob.evidence_uploaded_at,
       jsonb_build_object('title', ob.title, 'client', c.name), true, false, false
  from obligations ob join orgs c on c.id = ob.client_org_id where ob.status = 'evidence_uploaded'
union all
select 'partner_review', o.id::text, o.id::text, null, o.id::text, 'Partner application to review: ' || o.name, coalesce((o.profile->>'appliedAt')::timestamptz, o.created_at),
       jsonb_build_object('firm', o.name), false, true, false
  from orgs o where o.type = 'partner' and o.profile->>'status' = 'applied'
union all
select case ob.status when 'failed' then 'delivery_failed' else 'delivery_unknown' end, ob.id::text, ob.id::text, null, null,
       'Message ' || coalesce(ob.payload->>'template', '') || ' to ' || coalesce(ob.payload->>'to', ''), ob.created_at,
       jsonb_build_object('template', ob.payload->>'template', 'to', ob.payload->>'to', 'attempts', ob.attempts, 'error', ob.last_error), false, false, false
  from outbox ob where ob.topic = 'notify' and ob.status in ('failed', 'unknown')
union all
select 'licence_expiring', o.id::text, pd.id::text, null, o.id::text, 'Trade licence expires ' || pd.expires_on::text || ' (' || o.name || ')',
       greatest(pd.verified_at, (pd.expires_on - ${LICENCE_WARNING_DAYS})::timestamp at time zone 'Asia/Dubai'),
       jsonb_build_object('firm', o.name, 'expiresOn', pd.expires_on::text), false, false, false
  from partner_documents pd join orgs o on o.id = pd.partner_org_id
 where pd.kind = 'trade_licence' and pd.status = 'verified' and o.profile->>'status' in ('pilot', 'signed')
   and pd.expires_on <= (app_now() at time zone 'Asia/Dubai')::date + ${LICENCE_WARNING_DAYS}
   and not exists (select 1 from partner_documents n where n.partner_org_id = pd.partner_org_id and n.kind = 'trade_licence'
                   and n.status = 'verified' and n.expires_on > pd.expires_on)`;

const q = (s: string) => `“${s}”`;
const str = (v: unknown) => String(v ?? "");

function why(r: Row): string {
  const i = r.info;
  switch (r.kind) {
    case "system_alert":
      return `${str(i.summary)} The platform raised this (${str(i.severity)}); it closes on its own when the cause clears.`;
    case "offer_review":
      return `${str(i.lines)} line(s) of the ${str(i.tier)} offer for ${str(i.client)} fall below the margin floor or lack a price; the client sees no offer until a person decides them.`;
    case "offer_ready":
      return `The ${str(i.tier)} offer for ${str(i.client)} is priced and waiting; the client sees nothing until it is published.`;
    case "needs_quote":
      return `Part of the request from ${str(i.client)} has no partner rate card, so partners must be asked to quote before an offer can be built.`;
    case "qa":
      return `${str(i.partner)} handed in ${q(str(i.step))} with ${str(i.files)} file(s); the client cannot approve the step, and the partner is not paid for it, until MKW checks it.`;
    case "dispute":
      return `The client disputed ${q(str(i.step))}${i.reason ? `: ${str(i.reason)}` : ""}. The step and its payout are held until MKW resolves it.`;
    case "unallocated":
      return `Some lines for ${str(i.client)} have no partner and no open offer to one, so delivery cannot start on them.`;
    case "payout":
      return `The ${str(i.stage).replace("_", " ")} payout to ${str(i.partner)} is eligible; it goes out in the weekly payout run once the partner's invoice is in and finance releases it.`;
    case "scoping":
      return `Rules produced scoping advice for the request from ${str(i.client)}; the client sees it only after a person reviews it.`;
    case "ai_draft":
      return `The AI drafted a ${str(i.draftKind)} (${str(i.summary)}); nothing changes until a person approves or discards it.`;
    case "document_check":
      return `The document checker read ${q(str(i.file))}${i.kind ? ` for ${q(str(i.kind))}` : ""}: ${str(i.summary)} Agree or disagree so the record shows a person looked.`;
    case "lead":
      return `A public enquiry for ${str(i.company)} came from an email that already has an account; it was held so nobody gets a second account.`;
    case "delay":
      return `${q(str(i.step))} passed its due date; the cause decides whether the client gets a service guarantee credit and whether it counts against the partner.`;
    case "credit":
      return "A service guarantee credit was computed for a late step; finance decides whether it is granted.";
    case "partner_document":
      return `${str(i.firm)} uploaded a ${str(i.docKind).replace("_", " ")}; a firm cannot move to pilot, or keep working, on an unverified document.`;
    case "obligation":
      return `A rule produced the date for ${q(str(i.title))} (${str(i.client)}); the client sees it only after a person confirms it.`;
    case "obligation_evidence":
      return `${str(i.client)} attached filing evidence for ${q(str(i.title))}; the obligation is met only when MKW has checked it.`;
    case "partner_review":
      return `${str(i.firm)} applied to join the MKW Advisors Partner Network; MKW reviews the application before any work is offered.`;
    case "delivery_failed":
      return `The email provider refused ${str(i.template).replace(/_/g, " ")} ${str(i.attempts)} time(s)${i.error ? ` (${str(i.error).slice(0, 120)})` : ""}; it stays unsent until someone retries or cancels it.`;
    case "delivery_unknown":
      return `Sending ${str(i.template).replace(/_/g, " ")} started but its result was never recorded (the process stopped). It is not re-sent on its own, so it cannot arrive twice: check whether it arrived, then decide.`;
    case "documents_overdue":
      return `${str(i.count)} document(s) asked of ${str(i.client)} ${str(i.days)} working day(s) ago are still missing; the partner's step cannot finish without them.`;
    case "licence_expiring":
      return `${str(i.firm)}: trade licence expires on ${str(i.expiresOn)}; the firm is paused automatically if it lapses. Ask for the renewed licence.`;
  }
}

function linkFor(r: Row): string {
  switch (r.kind) {
    case "offer_review":
    case "offer_ready":
      return `#/offer/${r.ref}`;
    case "needs_quote":
      return "#/pipeline";
    case "scoping":
      return `#/request/${r.ref}`;
    case "ai_draft":
    case "lead":
      return "#/agent";
    case "delay":
    case "credit":
      return "#/delays";
    case "obligation":
    case "obligation_evidence":
      return "#/compliance";
    case "partner_document":
      return "#/partners";
    case "partner_review":
    case "licence_expiring":
      return `#/partner/${r.ref}`;
    case "delivery_failed":
    case "delivery_unknown":
      return "#/settings";
    case "system_alert":
      return "#/system";
    default:
      return r.engagement_id ? `#/engagement/${r.engagement_id}` : "#/queue";
  }
}

const review = (id: string): QueueAction[] => [
  { label: "Check is right", method: "POST", path: `/api/ops/drafts/${id}/review`, body: { decision: "approve" }, primary: true },
  { label: "Check is wrong", method: "POST", path: `/api/ops/drafts/${id}/review`, body: { decision: "discard" }, prompt: "What is wrong with the check? (optional)" },
];

function actionsFor(r: Row): QueueAction[] {
  const id = r.subject_id;
  switch (r.kind) {
    case "offer_ready":
      return [{ label: "Publish to the client", method: "POST", path: `/api/ops/offers/${id}/publish`, body: {}, primary: true }];
    case "qa":
      return [
        { label: "Pass", method: "POST", path: `/api/ops/milestones/${id}/qa`, body: { pass: true }, primary: true },
        { label: "Send back", method: "POST", path: `/api/ops/milestones/${id}/qa`, body: { pass: false }, prompt: "What does the partner need to fix?" },
      ];
    // Scoping advice, a scope draft and an obligation date are statutory or client-facing content the card does not
    // show: they open their own page, where the person reads what they approve (rule 5). Payouts go out in the
    // weekly run once the partner's invoice is in, from the payouts page.
    case "document_check":
      return review(id);
    case "lead":
      return [{ label: "Mark handled", method: "POST", path: `/api/ops/leads/${id}/handle`, body: {}, primary: true }];
    case "delay":
      return (["partner", "client", "government", "mkw"] as const).map((cause, n) => ({
        label: cause === "mkw" ? "MKW's delay" : `${cause[0]!.toUpperCase()}${cause.slice(1)}'s delay`,
        method: "POST" as const,
        path: `/api/ops/delays/${id}/attribute`,
        body: { cause },
        prompt: "What happened? (recorded with the attribution)",
        primary: n === 0,
      }));
    case "partner_document":
      return [
        { label: "Verify", method: "POST", path: `/api/ops/partner-documents/${id}/review`, body: { decision: "verified" }, primary: true },
        { label: "Reject", method: "POST", path: `/api/ops/partner-documents/${id}/review`, body: { decision: "rejected" }, prompt: "Why is it rejected?" },
      ];
    case "obligation_evidence":
      return [{ label: "Mark met", method: "POST", path: `/api/ops/obligations/${id}/met`, body: {}, primary: true }];
    case "delivery_failed":
      return [
        { label: "Retry", method: "POST", path: `/api/ops/outbox/${id}/resolve`, body: { action: "retry" }, prompt: "Note for the record (optional)", primary: true },
        { label: "Cancel", method: "POST", path: `/api/ops/outbox/${id}/resolve`, body: { action: "cancel" }, prompt: "Why is it not sent?" },
      ];
    case "delivery_unknown":
      return [
        { label: "Mark delivered", method: "POST", path: `/api/ops/outbox/${id}/resolve`, body: { action: "mark_delivered" }, prompt: "How did you confirm it arrived? (kept in the audit trail: no personal details)", primary: true },
        { label: "Send again", method: "POST", path: `/api/ops/outbox/${id}/resolve`, body: { action: "retry" }, prompt: "Note for the record (optional)" },
        { label: "Cancel", method: "POST", path: `/api/ops/outbox/${id}/resolve`, body: { action: "cancel" }, prompt: "Why is it not sent?" },
      ];
    default:
      return [];
  }
}

/** Client documents asked for three working days ago or more and still missing, one item per engagement. */
async function overdueDocuments(tx: Queryable, now: Date, cal: WorkCalendar): Promise<Row[]> {
  const r = await tx.query<{ id: string; engagement_id: string; partner_org_id: string; client: string; since: string }>(
    `select d.id, d.engagement_id, d.partner_org_id, c.name as client, coalesce(d.decided_at, d.created_at)::text as since
       from document_requests d join orgs c on c.id = d.client_org_id where d.status in ('requested', 'rejected') order by since`,
  );
  const byEngagement = new Map<string, { rows: typeof r.rows; first: Date }>();
  for (const d of r.rows) {
    const since = new Date(d.since);
    if (workingHoursBetween(since, now, cal) < DOCUMENTS_OVERDUE_HOURS) continue;
    const g = byEngagement.get(d.engagement_id) ?? { rows: [], first: since };
    g.rows.push(d);
    if (since < g.first) g.first = since;
    byEngagement.set(d.engagement_id, g);
  }
  return [...byEngagement.entries()].map(([engagementId, g]) => ({
    kind: "documents_overdue" as const,
    ref: engagementId,
    subject_id: engagementId,
    engagement_id: engagementId,
    partner_org_id: g.rows[0]!.partner_org_id,
    detail: `${g.rows.length} client document(s) overdue`,
    // The item arrives when the documents become overdue, not when they were asked for: its target runs from there.
    at: addWorkingHours(g.first, DOCUMENTS_OVERDUE_HOURS, cal).toISOString(),
    info: { count: g.rows.length, client: g.rows[0]!.client, days: Math.floor(workingHoursBetween(g.first, now, cal) / 9) },
    client_waiting: false,
    partner_waiting: true,
    money_waiting: false,
  }));
}

/** Partners below the allocation quality bar on their last scorecard. */
async function weakPartners(tx: Queryable): Promise<Set<string>> {
  const r = await tx.query<{ id: string }>("select id from orgs where type = 'partner' and profile ? 'scorecardAt' and (profile->>'quality')::int < 60");
  return new Set(r.rows.map((x) => x.id));
}

/** The ranked queue. `viewer` decides which buttons show; null (the jobs runner) gets none. */
export async function opsQueue(tx: Queryable, viewer: Pick<SessionUser, "role"> | null, now: Date): Promise<QueueItem[]> {
  const cal = await loadCalendar(tx);
  const rows = [...(await tx.query<Row>(SOURCES)).rows, ...(await overdueDocuments(tx, now, cal))];
  const weak = await weakPartners(tx);
  // Document checks shown beside the item they concern: evidence of a step in QA, a partner document, filing evidence.
  const evidence = (
    await tx.query<{ id: string; milestone_id: string }>("select id, milestone_id from evidence where milestone_id = any($1::uuid[])", [rows.filter((r) => r.kind === "qa").map((r) => r.subject_id)])
  ).rows;
  const subjects: Array<{ type: CheckSubject; id: string }> = [
    ...evidence.map((e) => ({ type: "evidence" as const, id: e.id })),
    ...rows.filter((r) => r.kind === "partner_document").map((r) => ({ type: "partner_document" as const, id: r.subject_id })),
    ...rows.filter((r) => r.kind === "obligation_evidence").map((r) => ({ type: "obligation" as const, id: r.subject_id })),
  ];
  const checks = await latestChecks(tx, subjects);
  const draftsFor = (r: Row): QueueItem["drafts"] => {
    const keys =
      r.kind === "qa"
        ? evidence.filter((e) => e.milestone_id === r.subject_id).map((e) => `evidence:${e.id}`)
        : r.kind === "partner_document"
          ? [`partner_document:${r.subject_id}`]
          : r.kind === "obligation_evidence"
            ? [`obligation:${r.subject_id}`]
            : [];
    return keys.flatMap((k) => {
      const c = checks.get(k);
      return c ? [{ id: String(c.id), status: String(c.status), check: c.check as Record<string, unknown>, at: String(c.at), subject: k.split(":")[0]! }] : [];
    });
  };
  const ranked = rankQueue(
    rows.map((r) => {
      const signals: QueueSignals = {
        clientWaiting: r.client_waiting,
        partnerWaiting: r.partner_waiting,
        moneyWaiting: r.money_waiting,
        weakPartner: !!r.partner_org_id && weak.has(r.partner_org_id),
      };
      const at = new Date(r.at);
      return { row: r, kind: r.kind, at: Number.isFinite(at.getTime()) ? at : now, signals };
    }),
    now,
    cal,
  );
  return ranked.map((t) => {
    const r = t.row;
    // Only ops and the founder act from the queue; finance reads it and opens items.
    const actions = ["ops", "founder"].includes(viewer?.role ?? "") ? actionsFor(r) : [];
    return {
      id: `${r.kind}:${r.subject_id}`,
      kind: r.kind,
      label: QUEUE_POLICY[r.kind].label,
      ref: r.ref,
      subjectId: r.subject_id,
      engagementId: r.engagement_id,
      detail: r.detail,
      why: why(r),
      at: t.at.toISOString(),
      dueAt: t.dueAt.toISOString(),
      hoursLeft: t.hoursLeft,
      level: t.level,
      risk: t.risk,
      factors: t.factors,
      link: linkFor(r),
      actions,
      drafts: draftsFor(r),
    };
  });
}

// Queue timings ----------------------------------------------------------------------------------------------------

/**
 * Keep `queue_timings` in step with the queue: a row per item while it is waiting, resolved when the item leaves.
 * Called whenever the queue is computed (each view, each jobs run), so resolution times are as fresh as the last look.
 */
export async function syncQueueTimings(tx: Queryable, items: QueueItem[]): Promise<void> {
  for (const i of items) {
    await tx.query(
      `insert into queue_timings (kind, ref, engagement_id, item_at, due_at) values ($1, $2, $3, $4, $5)
       on conflict (kind, ref) where resolved_at is null do nothing`,
      [i.kind, i.subjectId, i.engagementId, i.at, i.dueAt],
    );
  }
  await tx.query("update queue_timings set resolved_at = app_now() where resolved_at is null and not ((kind || ':' || ref) = any($1))", [items.map((i) => i.id)]);
}

/** A person opened (or acted on) an item from the queue: the start of their handling time. */
export async function openQueueItem(tx: Queryable, actor: SessionUser, id: string) {
  const [kind, ref] = id.split(/:(.*)/s);
  if (!kind || !ref || !(kind in QUEUE_POLICY)) throw badRequest("Unknown queue item");
  await tx.query("update queue_timings set opened_at = app_now(), opened_by = $3 where kind = $1 and ref = $2 and resolved_at is null and opened_at is null", [kind, ref, actor.id]);
  return { ok: true };
}

/** Handling time counts at most this long per item: a tab left open is not work. */
export const HANDLING_CAP_MINUTES = 30;

/** Queue figures for the founder dashboard over a period (Dubai dates; `from` inclusive, `to` exclusive, as `Period`). */
export async function queueStats(tx: Queryable, from: string, to: string) {
  const range = [from, to];
  const totals = (
    await tx.query<{ resolved: number; within: number; handled: number; minutes: number; engagements: number; engagement_minutes: number }>(
      `select count(*)::int as resolved,
         count(*) filter (where resolved_at <= due_at)::int as within,
         count(*) filter (where opened_at is not null)::int as handled,
         coalesce(sum(least(extract(epoch from resolved_at - opened_at) / 60, ${HANDLING_CAP_MINUTES})) filter (where opened_at is not null), 0)::float as minutes,
         count(distinct engagement_id)::int as engagements,
         coalesce(sum(least(extract(epoch from resolved_at - opened_at) / 60, ${HANDLING_CAP_MINUTES})) filter (where opened_at is not null and engagement_id is not null), 0)::float as engagement_minutes
       from queue_timings where resolved_at is not null and (resolved_at at time zone 'Asia/Dubai')::date >= $1::date and (resolved_at at time zone 'Asia/Dubai')::date < $2::date`,
      range,
    )
  ).rows[0]!;
  const byKind = (
    await tx.query<{ kind: string; resolved: number; median_hours: number; within: number }>(
      `select kind, count(*)::int as resolved,
         percentile_cont(0.5) within group (order by extract(epoch from resolved_at - item_at) / 3600)::float as median_hours,
         count(*) filter (where resolved_at <= due_at)::int as within
       from queue_timings where resolved_at is not null and (resolved_at at time zone 'Asia/Dubai')::date >= $1::date and (resolved_at at time zone 'Asia/Dubai')::date < $2::date
       group by kind order by kind`,
      range,
    )
  ).rows;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    resolved: totals.resolved,
    withinTargetRate: totals.resolved ? Math.round((totals.within / totals.resolved) * 1000) / 1000 : null,
    handled: totals.handled,
    opsMinutes: round1(totals.minutes),
    opsMinutesPerEngagement: totals.engagements ? round1(totals.engagement_minutes / totals.engagements) : null,
    byKind: byKind.map((k) => ({ kind: k.kind, resolved: k.resolved, medianHoursInQueue: round1(k.median_hours), withinTarget: k.within })),
  };
}

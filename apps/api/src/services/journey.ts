import { addWorkingDays, type WorkCalendar } from "@tasees/core";
import { num, type Queryable } from "../lib/db.ts";
import { CLIENT_REVIEW_DAYS } from "./engagements.ts";

/**
 * The client's journey (O12): the one thing Tasees needs from them, and where each engagement stands. Everything is
 * read under the client's own database role, so it can only ever describe their own rows; the working-time calendar
 * (public holidays) is loaded by the caller. Order matters: the first action is the one the screens pin.
 *
 *   offer      an offer to decide, before it expires
 *   payment    a payment due (the deposit starts the work; the balance closes it)
 *   approve    a step MKW has checked, waiting for the client (approved automatically after five working days)
 *   documents  documents a partner asked for, still missing or sent back
 *   filing     a confirmed compliance date within 30 days with no filing evidence yet
 */
export type NextActionKind = "offer" | "payment" | "approve" | "documents" | "filing";

export interface NextAction {
  kind: NextActionKind;
  title: string;
  why: string;
  link: string;
  /** The date this needs doing by, or happens on its own (YYYY-MM-DD, Dubai). */
  due: string | null;
  engagementId: string | null;
  /** Pay links, approve buttons: the id the action works on. */
  ref: string;
  /** A person's own words that go with it (why a document was sent back), shown as written, never translated. */
  detail?: string | null;
}

export interface TimelineEntry {
  kind: "accepted" | "payment" | "step" | "completed";
  label: string;
  /** done; now (waiting for the client); mkw (MKW is checking); partner (the partner is working); upcoming; issue. */
  state: "done" | "now" | "mkw" | "partner" | "upcoming" | "issue";
  /** When it happened, or the date it is expected or due. */
  date: string | null;
  note: string | null;
  ref: string | null;
  /** A person's own words (the issue the client raised), shown as written, never translated. */
  detail?: string | null;
}

const dubaiDate = (d: Date) => new Date(d.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
const fmt = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
const aed = (fils: number) => `AED ${(fils / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The date a step waiting for the client is approved automatically: five working days after MKW's check. */
export function autoApprovalDate(qaPassedAt: Date, cal: WorkCalendar): string {
  return dubaiDate(addWorkingDays(qaPassedAt, CLIENT_REVIEW_DAYS, cal));
}

export async function clientNextActions(tx: Queryable, now: Date, cal: WorkCalendar, engagementId: string | null = null): Promise<NextAction[]> {
  const today = dubaiDate(now);
  const actions: NextAction[] = [];
  // One engagement, or all of the client's: a bound parameter, null for all.
  const only = engagementId;
  if (!engagementId) {
    const offers = await tx.query<{ id: string; request_id: string; tier: string; valid_to: string | null }>(
      "select id, request_id, tier, valid_to::text from offers where status = 'published' and (valid_to is null or valid_to >= $1::date) order by valid_to nulls last, case tier when 'standard' then 0 else 1 end",
      [today],
    );
    const seen = new Set<string>();
    for (const o of offers.rows) {
      if (seen.has(o.request_id)) continue;
      seen.add(o.request_id);
      const n = offers.rows.filter((x) => x.request_id === o.request_id).length;
      actions.push({
        kind: "offer",
        title: n > 1 ? `Choose one of your ${n} offers` : "Review your offer",
        why: `Your ${n > 1 ? "offers are" : "offer is"} ready${o.valid_to ? ` and valid until ${fmt(o.valid_to)}` : ""}. Nothing starts until you accept one.`,
        link: `#/offer/${o.id}`,
        due: o.valid_to,
        engagementId: null,
        ref: o.id,
      });
    }
  }
  const payments = await tx.query<{ id: string; engagement_id: string; kind: string; amount_fils: number; pay_url: string | null; created_at: string }>(
    "select id, engagement_id, kind, amount_fils, pay_url, created_at::text from payments where status = 'pending' and ($1::uuid is null or engagement_id = $1) order by created_at",
    [only],
  );
  for (const p of payments.rows) {
    actions.push({
      kind: "payment",
      title: `Pay the ${p.kind === "deposit" ? "deposit" : p.kind === "balance" ? "balance" : "approved change"}: ${aed(num(p.amount_fils))}`,
      why:
        p.kind === "deposit"
          ? "Work starts when the deposit arrives: half the fees and VAT, and the government fees we pay on your behalf at cost."
          : p.kind === "balance"
            ? "Every step is approved; the balance closes the engagement and your tax invoice follows."
            : "You approved a change to the scope; it is delivered once paid.",
      link: p.pay_url ?? `#/pay/${p.id}`,
      due: null,
      engagementId: p.engagement_id,
      ref: p.id,
    });
  }
  const steps = await tx.query<{ id: string; engagement_id: string; name: string; qa_passed_at: string }>(
    "select id, engagement_id, name, qa_passed_at from milestones where status = 'qa_passed' and ($1::uuid is null or engagement_id = $1) order by qa_passed_at",
    [only],
  );
  for (const m of steps.rows) {
    const auto = autoApprovalDate(new Date(m.qa_passed_at), cal);
    actions.push({
      kind: "approve",
      title: `Approve: ${m.name}`,
      why: `MKW Advisors has checked the evidence. Approve it, or raise an issue; if you do nothing it is approved automatically on ${fmt(auto)}.`,
      link: `#/engagement/${m.engagement_id}`,
      due: auto,
      engagementId: m.engagement_id,
      ref: m.id,
    });
  }
  const docs = await tx.query<{ engagement_id: string; kind: string; status: string; decision_note: string | null; step: string }>(
    `select d.engagement_id, d.kind, d.status, d.decision_note, m.name as step from document_requests d join milestones m on m.id = d.milestone_id
      where d.status in ('requested', 'rejected') and ($1::uuid is null or d.engagement_id = $1) order by d.created_at`,
    [only],
  );
  const byEngagement = new Map<string, typeof docs.rows>();
  for (const d of docs.rows) byEngagement.set(d.engagement_id, [...(byEngagement.get(d.engagement_id) ?? []), d]);
  for (const [eid, list] of byEngagement) {
    const back = list.filter((d) => d.status === "rejected");
    // Each kind once (a passport copy asked for three steps is one thing to find), and how many steps wait.
    const kinds = [...new Set(list.map((d) => d.kind.replace(/_/g, " ")))];
    const steps = new Set(list.map((d) => d.step)).size;
    const waiting = steps > 1 ? `${steps} steps cannot finish without them` : `${list[0]!.step} cannot finish without ${list.length > 1 ? "them" : "it"}`;
    actions.push({
      kind: "documents",
      title: `Upload ${list.length} document${list.length > 1 ? "s" : ""}`,
      why: back.length
        ? `${[...new Set(back.map((d) => d.kind.replace(/_/g, " ")))].join(", ")} ${back.length > 1 ? "were" : "was"} sent back. ${waiting[0]!.toUpperCase()}${waiting.slice(1)}.`
        : `${kinds[0]![0]!.toUpperCase()}${kinds.join(", ").slice(1)}. ${waiting[0]!.toUpperCase()}${waiting.slice(1)}.`,
      link: `#/engagement/${eid}`,
      due: null,
      engagementId: eid,
      ref: eid,
      detail: back[0]?.decision_note ?? null,
    });
  }
  const filings = await tx.query<{ id: string; title: string; due_date: string; engagement_id: string | null }>(
    "select id, title, due_date::text, engagement_id from obligations where status = 'open' and due_date <= $1::date + 30 and ($2::uuid is null or engagement_id = $2) order by due_date",
    [today, only],
  );
  for (const o of filings.rows) {
    const late = o.due_date < today;
    actions.push({
      kind: "filing",
      title: `${late ? "Overdue" : "Due"}: ${o.title}`,
      why: `${late ? "This was due" : "This is due"} on ${fmt(o.due_date)}. When it is filed, upload the confirmation and we record it as met. We do not file for you.`,
      link: "#/compliance",
      due: o.due_date,
      engagementId: o.engagement_id,
      ref: o.id,
    });
  }
  return actions;
}

/** Where one engagement stands, for the client's timeline: acceptance, the deposit, every step, the balance, completion. */
export async function clientTimeline(tx: Queryable, engagementId: string, cal: WorkCalendar): Promise<TimelineEntry[]> {
  const e = (await tx.query<{ status: string; created_at: string; completed_at: string | null }>("select status, created_at::text, completed_at::text from engagements where id = $1", [engagementId])).rows[0];
  if (!e) return [];
  const payments = (await tx.query<{ id: string; kind: string; status: string; amount_fils: number; paid_at: string | null }>("select id, kind, status, amount_fils, paid_at::text from payments where engagement_id = $1 order by created_at", [engagementId])).rows;
  const steps = (
    await tx.query<{ id: string; name: string; status: string; due_date: string | null; qa_passed_at: string | null; updated_at: string; dispute_reason: string | null }>(
      "select id, name, status, due_date::text, qa_passed_at, updated_at::text, dispute_reason from milestones where engagement_id = $1 order by seq",
      [engagementId],
    )
  ).rows;
  const pay = (p: (typeof payments)[number]): TimelineEntry => ({
    kind: "payment",
    label: `${p.kind === "deposit" ? "Deposit" : p.kind === "balance" ? "Balance" : "Change to scope"}: ${aed(num(p.amount_fils))}`,
    state: p.status === "paid" ? "done" : p.status === "pending" ? "now" : p.status === "refunded" ? "done" : "upcoming",
    date: p.paid_at,
    note: p.status === "paid" ? "Paid" : p.status === "pending" ? "Due now" : p.status === "refunded" ? "Refunded" : p.kind === "balance" ? "Due when every step is approved" : null,
    ref: p.id,
  });
  const out: TimelineEntry[] = [{ kind: "accepted", label: "Offer accepted", state: "done", date: e.created_at, note: null, ref: null }];
  for (const p of payments.filter((x) => x.kind === "deposit")) out.push(pay(p));
  for (const m of steps) {
    const state: TimelineEntry["state"] =
      m.status === "client_approved" ? "done" : m.status === "qa_passed" ? "now" : m.status === "evidence_submitted" ? "mkw" : m.status === "disputed" ? "issue" : m.status === "pending" ? "upcoming" : "partner";
    const note =
      m.status === "client_approved"
        ? "Approved"
        : m.status === "qa_passed"
          ? `Checked by MKW Advisors: waiting for you (approved automatically on ${fmt(autoApprovalDate(new Date(m.qa_passed_at!), cal))})`
          : m.status === "evidence_submitted"
            ? "Evidence handed in: MKW Advisors is checking it"
            : m.status === "disputed"
              ? "You raised an issue; MKW Advisors is resolving it"
              : m.status === "qa_rejected"
                ? "Being redone after MKW's check"
                : m.status === "pending"
                  ? "Not started yet"
                  : "In progress";
    out.push({ kind: "step", label: m.name, state, date: m.status === "client_approved" ? m.updated_at : m.due_date, note, ref: m.id, detail: m.status === "disputed" ? m.dispute_reason : null });
  }
  for (const p of payments.filter((x) => x.kind !== "deposit")) out.push(pay(p));
  out.push({ kind: "completed", label: "Completed", state: e.status === "completed" ? "done" : "upcoming", date: e.completed_at, note: e.status === "completed" ? "Your compliance calendar is on the Compliance page" : null, ref: null });
  return out;
}

/** When nothing is needed: what is happening and when the next step is expected. */
export async function clientWhatsNext(tx: Queryable, engagementId: string | null = null): Promise<string> {
  const scope = engagementId ? " and m.engagement_id = $1" : "";
  const next = (
    await tx.query<{ name: string; due_date: string | null; status: string }>(
      `select m.name, m.due_date::text, m.status from milestones m join engagements e on e.id = m.engagement_id
        where e.status <> 'completed' and m.status in ('in_progress', 'evidence_submitted', 'qa_rejected', 'pending', 'disputed')${scope}
        order by case m.status when 'disputed' then 0 when 'evidence_submitted' then 1 when 'in_progress' then 2 when 'qa_rejected' then 3 else 4 end, m.seq limit 1`,
      engagementId ? [engagementId] : [],
    )
  ).rows[0];
  if (!next) return "There is nothing in progress. Start a new request whenever you need something.";
  if (next.status === "evidence_submitted") return `MKW Advisors is checking the evidence for ${next.name}. We will ask you to approve it next.`;
  if (next.status === "disputed") return `MKW Advisors is resolving the issue you raised on ${next.name}.`;
  return `${next.name} is ${next.status === "pending" ? "next" : "in progress"}${next.due_date ? `, expected by ${fmt(next.due_date)}` : ""}. We will tell you when it needs you.`;
}

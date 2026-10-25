import {
  addWorkingDays,
  allocate,
  checkEligibility,
  formatAed,
  guaranteeCredit,
  GUARANTEE_DAYS,
  maskContacts,
  MILESTONE_TEMPLATES,
  type DelayCause,
} from "@tasees/core";
import { audit, lockAuditChain, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { col, textPdf } from "../lib/pdf.ts";
import { attachPaymentLink, categoryOf, monthShares, notifyOrg, type Deps } from "./engagements.ts";
import { loadCompany } from "./invoices.ts";
import { loadCalendar } from "./calendar.ts";
import { loadDeliverables, loadPartners, loadRateCards, dbToday, today } from "./repo.ts";

/**
 * Delivery (O6): client document requests, delay watch and the service guarantee, ratings, manual
 * allocation and the client's offer document. Every money movement here needs finance's action; the rule
 * only computes what is owed.
 */

const nowOf = (deps: Deps) => (deps.now ? deps.now() : new Date());
const isOps = (u: SessionUser) => ["ops", "founder"].includes(u.role);
const isFinance = (u: SessionUser) => ["finance", "founder"].includes(u.role);

// Client document requests ---------------------------------------------------------------------------------

async function loadRequest(tx: Queryable, id: string) {
  await lockAuditChain(tx);
  const r = (await tx.query<Record<string, unknown>>("select * from document_requests where id = $1 for update", [id])).rows[0];
  if (!r) throw notFound("Document request not found");
  return r;
}

/** The partner asks the client for one more document on a step it owns. */
export async function addDocumentRequest(tx: Queryable, actor: SessionUser, milestoneId: string, kind: string, note: string, deps: Deps) {
  if (actor.orgType !== "partner") throw forbidden("Only the partner doing the work asks for documents");
  const m = (await tx.query<{ engagement_id: string; partner_org_id: string; name: string; status: string }>("select engagement_id, partner_org_id, name, status from milestones where id = $1", [milestoneId])).rows[0];
  if (!m || m.partner_org_id !== actor.orgId) throw notFound("Step not found");
  if (["client_approved", "evidence_submitted", "qa_passed"].includes(m.status)) throw conflict("This step is past the point of needing documents");
  const kindKey = kind.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (kindKey.length < 3 || kindKey.length > 60) throw badRequest("Name the document");
  const clientOrg = (await tx.query<{ client_org_id: string }>("select client_org_id from engagements where id = $1", [m.engagement_id])).rows[0]!.client_org_id;
  const r = (
    await tx.query<{ id: string }>("insert into document_requests (engagement_id, milestone_id, client_org_id, partner_org_id, kind, note, requested_by) values ($1,$2,$3,$4,$5,$6,$7) returning id", [m.engagement_id, milestoneId, clientOrg, actor.orgId, kindKey, maskContacts(note).text || null, actor.id])
  ).rows[0]!;
  await audit(tx, actor, "documents.requested", "document_request", r.id, { milestoneId, kind: kindKey });
  await notifyOrg(tx, deps, clientOrg, "documents_requested", { engagementId: m.engagement_id, step: m.name, count: 1, kinds: kindKey.replace(/_/g, " ") });
  return { id: r.id };
}

/** The client uploads the file; the route has already put it in storage under the engagement. */
export async function uploadDocument(tx: Queryable, actor: SessionUser, requestId: string, file: { key: string; name: string }, deps: Deps) {
  if (actor.orgType !== "client") throw forbidden("Only the client uploads its documents");
  const r = await loadRequest(tx, requestId);
  if (r.client_org_id !== actor.orgId) throw notFound("Document request not found");
  if (!["requested", "rejected"].includes(String(r.status))) throw conflict("This document has already been received");
  await tx.query("update document_requests set status = 'uploaded', file_key = $2, file_name = $3, uploaded_by = $4, uploaded_at = app_now(), decided_by = null, decided_at = null, decision_note = null where id = $1", [requestId, file.key, file.name, actor.id]);
  await audit(tx, actor, "documents.uploaded", "document_request", requestId, { kind: r.kind, name: file.name });
  const open = (await tx.query<{ n: number }>("select count(*)::int as n from document_requests where milestone_id = $1 and status in ('requested', 'rejected')", [String(r.milestone_id)])).rows[0]!;
  if (num(open.n) === 0) {
    const m = (await tx.query<{ name: string }>("select name from milestones where id = $1", [String(r.milestone_id)])).rows[0]!;
    await notifyOrg(tx, deps, String(r.partner_org_id), "documents_complete", { engagementId: String(r.engagement_id), step: m.name });
  }
  return { ok: true, complete: num(open.n) === 0 };
}

/** The partner (or MKW) marks a document received or asks again with a reason. */
export async function decideDocument(tx: Queryable, actor: SessionUser, requestId: string, decision: "received" | "rejected", note: string, deps: Deps) {
  const r = await loadRequest(tx, requestId);
  if (actor.orgType === "partner" ? r.partner_org_id !== actor.orgId : !isOps(actor)) throw forbidden("Only the partner doing the work or MKW Advisors checks documents");
  if (r.status !== "uploaded") throw conflict("Nothing has been uploaded for this request yet");
  if (decision === "rejected" && !note.trim()) throw badRequest("Say what is wrong with the document");
  await tx.query("update document_requests set status = $2, decided_by = $3, decided_at = app_now(), decision_note = $4 where id = $1", [requestId, decision, actor.id, maskContacts(note).text || null]);
  await audit(tx, actor, decision === "received" ? "documents.received" : "documents.rejected", "document_request", requestId, { kind: r.kind, note });
  if (decision === "rejected") {
    const m = (await tx.query<{ name: string }>("select name from milestones where id = $1", [String(r.milestone_id)])).rows[0]!;
    await notifyOrg(tx, deps, String(r.client_org_id), "documents_requested", { engagementId: String(r.engagement_id), step: m.name, count: 1, kinds: `${String(r.kind).replace(/_/g, " ")} (again: ${maskContacts(note.trim()).text})` });
  }
  return { ok: true };
}

/** Who may open a client document file: the client that uploaded it, the partner it is for, MKW staff. */
export async function documentFileKey(tx: Queryable, actor: SessionUser, requestId: string): Promise<{ key: string; name: string }> {
  const r = await loadRequest(tx, requestId);
  const allowed = (actor.orgType === "client" && r.client_org_id === actor.orgId) || (actor.orgType === "partner" && r.partner_org_id === actor.orgId) || actor.orgType === "platform";
  if (!allowed || !r.file_key) throw notFound("Document not found");
  await audit(tx, actor, "documents.opened", "document_request", requestId, {});
  return { key: String(r.file_key), name: String(r.file_name) };
}

// Delay watch and service guarantee ---------------------------------------------------------------------------

async function guaranteeBp(tx: Queryable): Promise<number> {
  const r = await tx.query<{ value: number }>("select value from settings where key = 'guarantee_bp'");
  return num(r.rows[0]?.value ?? 1000);
}

/** Daily: every in-flight step past its due date gets one delay record; past the guarantee window, a credit. */
export async function sweepDelays(tx: Queryable, deps: Deps): Promise<{ delays: number; credits: number }> {
  const today = await dbToday(tx);
  const cal = await loadCalendar(tx);
  const late = (
    await tx.query<{ id: string; engagement_id: string; partner_org_id: string; code: string; name: string; due_date: string; client_org_id: string }>(
      `select m.id, m.engagement_id, m.partner_org_id, m.code, m.name, m.due_date::text as due_date, e.client_org_id
       from milestones m join engagements e on e.id = m.engagement_id
       where m.status in ('pending', 'in_progress', 'qa_rejected') and m.due_date < $1::date
         and e.status in ('in_delivery', 'disputed')
         and not exists (select 1 from delays d where d.milestone_id = m.id)
       order by m.due_date, m.seq`,
      [today],
    )
  ).rows;
  let delays = 0;
  for (const m of late) {
    const expected = addWorkingDays(new Date(`${m.due_date}T14:00:00+04:00`), GUARANTEE_DAYS, cal).toISOString().slice(0, 10);
    const d = (
      await tx.query<{ id: string }>("insert into delays (milestone_id, engagement_id, partner_org_id, client_org_id, due_date, expected_date) values ($1,$2,$3,$4,$5,$6) returning id", [m.id, m.engagement_id, m.partner_org_id, m.client_org_id, m.due_date, expected])
    ).rows[0]!;
    await audit(tx, null, "delay.noticed", "delay", d.id, { milestoneId: m.id, engagementId: m.engagement_id, dueDate: m.due_date, expectedDate: expected });
    await notifyOrg(tx, deps, m.client_org_id, "step_delayed_client", { engagementId: m.engagement_id, step: m.name, dueDate: m.due_date, expectedDate: expected });
    await notifyOrg(tx, deps, m.partner_org_id, "step_delayed_partner", { engagementId: m.engagement_id, step: m.name, dueDate: m.due_date, expectedDate: expected });
    delays++;
  }
  // The guarantee: a step still open after the window earns the client a credit, once, by rule.
  const bp = await guaranteeBp(tx);
  const overdue = (
    await tx.query<{ delay_id: string; milestone_id: string; engagement_id: string; partner_org_id: string; client_org_id: string; code: string; name: string; expected_date: string; cause: DelayCause | null }>(
      `select d.id as delay_id, d.milestone_id, d.engagement_id, d.partner_org_id, d.client_org_id, m.code, m.name, d.expected_date::text as expected_date, d.cause
       from delays d join milestones m on m.id = d.milestone_id
       where d.credit_id is null and d.expected_date < $1::date and m.status in ('pending', 'in_progress', 'qa_rejected')`,
      [today],
    )
  ).rows;
  let credits = 0;
  for (const o of overdue) {
    // The line's professional fee to the client: client_unit_fils less MKW's own service fee (agent lines),
    // excluding government fees (passed at cost) and VAT.
    const line = (await tx.query<{ qty: number; client_unit_fils: number; mkw_fee_unit_fils: number }>("select qty, client_unit_fils, mkw_fee_unit_fils from engagement_lines where engagement_id = $1 and code = $2", [o.engagement_id, o.code])).rows[0];
    const steps = (await tx.query<{ n: number }>("select count(*)::int as n from milestones where engagement_id = $1 and code = $2", [o.engagement_id, o.code])).rows[0]!;
    const base = line ? num(line.qty) * Math.max(0, num(line.client_unit_fils) - num(line.mkw_fee_unit_fils)) : 0;
    const amount = guaranteeCredit(base, num(steps.n), bp);
    const borne = o.cause === "partner";
    const c = (
      await tx.query<{ id: string }>(
        "insert into guarantee_credits (engagement_id, milestone_id, client_org_id, partner_org_id, base_fils, guarantee_bp, amount_fils, borne_by_partner) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
        [o.engagement_id, o.milestone_id, o.client_org_id, o.partner_org_id, base, bp, amount, borne],
      )
    ).rows[0]!;
    await tx.query("update delays set credit_id = $2 where id = $1", [o.delay_id, c.id]);
    await audit(tx, null, "guarantee.credit_due", "guarantee_credit", c.id, { milestoneId: o.milestone_id, engagementId: o.engagement_id, baseFils: base, guaranteeBp: bp, amountFils: amount, cause: o.cause, stepsInLine: num(steps.n) });
    credits++;
  }
  return { delays, credits };
}

/** Ops records who bears a delay; the credit, if already created, follows. */
export async function attributeDelay(tx: Queryable, actor: SessionUser, delayId: string, cause: DelayCause, note: string) {
  if (!isOps(actor)) throw forbidden("Only ops attributes a delay");
  if (!note.trim()) throw badRequest("Say why");
  await lockAuditChain(tx);
  const d = (await tx.query<{ id: string; credit_id: string | null; cause: string | null }>("select id, credit_id, cause from delays where id = $1 for update", [delayId])).rows[0];
  if (!d) throw notFound("Delay not found");
  if (d.credit_id) {
    const c = (await tx.query<{ status: string }>("select status from guarantee_credits where id = $1", [d.credit_id])).rows[0]!;
    if (c.status !== "pending") throw conflict("Finance has already decided this step's guarantee credit; the attribution is fixed");
  }
  await tx.query("update delays set cause = $2, cause_note = $3, attributed_by = $4, attributed_at = app_now() where id = $1", [delayId, cause, note.trim(), actor.id]);
  if (d.credit_id) {
    const c = (await tx.query<{ status: string }>("select status from guarantee_credits where id = $1", [d.credit_id])).rows[0]!;
    if (c.status === "pending") await tx.query("update guarantee_credits set borne_by_partner = $2 where id = $1", [d.credit_id, cause === "partner"]);
  }
  await audit(tx, actor, "delay.attributed", "delay", delayId, { cause, note, previous: d.cause });
  return { ok: true };
}

/**
 * Finance decides a credit. Approve: if the client's balance is still unpaid the credit is deducted from it
 * (`applied`); otherwise it is `approved` for finance to settle by refund or transfer, recorded with a
 * reference. When the delay is the partner's, the completion payout is reduced by the same amount, never
 * below zero. Waive: with a reason, nothing moves.
 */
export async function decideCredit(tx: Queryable, actor: SessionUser, creditId: string, decision: "approve" | "waive", note: string, deps: Deps) {
  if (!isFinance(actor)) throw forbidden("Only finance decides guarantee credits");
  await lockAuditChain(tx);
  const c = (await tx.query<Record<string, unknown>>("select * from guarantee_credits where id = $1 for update", [creditId])).rows[0];
  if (!c) throw notFound("Credit not found");
  if (c.status !== "pending") throw conflict(`This credit is already ${String(c.status)}`);
  const amount = num(c.amount_fils);
  if (decision === "waive") {
    if (!note.trim()) throw badRequest("Say why the credit is waived");
    await tx.query("update guarantee_credits set status = 'waived', waive_reason = $2, decided_by = $3, decided_at = app_now() where id = $1", [creditId, note.trim(), actor.id]);
    await audit(tx, actor, "guarantee.waived", "guarantee_credit", creditId, { reason: note, amountFils: amount });
    return { ok: true, status: "waived" };
  }
  const balance = (await tx.query<{ id: string; amount_fils: number; status: string; pay_url: string | null; client_org_id: string }>("select id, amount_fils, status, pay_url, client_org_id from payments where engagement_id = $1 and kind = 'balance' and status in ('scheduled', 'pending')", [String(c.engagement_id)])).rows[0];
  let how: "applied" | "approved" = "approved";
  if (balance && amount > 0) {
    const newAmount = Math.max(0, num(balance.amount_fils) - amount);
    await tx.query("update payments set amount_fils = $2 where id = $1", [balance.id, newAmount]);
    await audit(tx, actor, "payment.reduced_by_credit", "payment", balance.id, { creditId, from: num(balance.amount_fils), to: newAmount });
    // A balance already linked for card payment gets a fresh link for the new amount (the webhook checks the
    // amount), and the client is told what is now due.
    if (balance.status === "pending" && balance.pay_url) {
      const payUrl = await attachPaymentLink(tx, deps, balance.id, String(c.engagement_id), "balance", newAmount);
      await notifyOrg(tx, deps, balance.client_org_id, "payment_due", { engagementId: String(c.engagement_id), amountFils: newAmount, kind: "balance", payUrl: payUrl ?? undefined });
    }
    how = "applied";
  }
  let payoutReduction = 0;
  if (c.borne_by_partner && amount > 0) {
    const payout = (await tx.query<{ id: string; amount_fils: number }>("select id, amount_fils from payouts where engagement_id = $1 and partner_org_id = $2 and stage = 'completion' and status in ('pending', 'eligible')", [String(c.engagement_id), String(c.partner_org_id)])).rows[0];
    if (payout) {
      payoutReduction = Math.min(amount, num(payout.amount_fils));
      await tx.query("update payouts set amount_fils = amount_fils - $2 where id = $1", [payout.id, payoutReduction]);
      await audit(tx, actor, "payout.reduced_by_guarantee", "payout", payout.id, { creditId, reductionFils: payoutReduction });
    }
  }
  await tx.query("update guarantee_credits set status = $2, payout_reduction_fils = $3, decided_by = $4, decided_at = app_now() where id = $1", [creditId, how, payoutReduction, actor.id]);
  await audit(tx, actor, "guarantee.approved", "guarantee_credit", creditId, { how, amountFils: amount, payoutReductionFils: payoutReduction, note });
  const step = (await tx.query<{ name: string }>("select name from milestones where id = $1", [String(c.milestone_id)])).rows[0]!;
  await notifyOrg(tx, deps, String(c.client_org_id), "guarantee_credit", { engagementId: String(c.engagement_id), step: step.name, amountAed: formatAed(amount).replace(/^AED\s*/, ""), how });
  return { ok: true, status: how, payoutReductionFils: payoutReduction };
}

/** Finance records how an approved credit was paid back to the client. */
export async function settleCredit(tx: Queryable, actor: SessionUser, creditId: string, reference: string) {
  if (!isFinance(actor)) throw forbidden("Only finance settles guarantee credits");
  await lockAuditChain(tx);
  const c = (await tx.query<{ status: string }>("select status from guarantee_credits where id = $1 for update", [creditId])).rows[0];
  if (!c) throw notFound("Credit not found");
  if (c.status !== "approved") throw conflict("Only an approved credit awaiting settlement can be settled");
  if (reference.trim().length < 3) throw badRequest("Record the refund or transfer reference");
  await tx.query("update guarantee_credits set status = 'settled', settled_reference = $2 where id = $1", [creditId, reference.trim()]);
  await audit(tx, actor, "guarantee.settled", "guarantee_credit", creditId, { reference });
  return { ok: true };
}

const camel = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));

export async function delayQueue(tx: Queryable) {
  const delays = (
    await tx.query(
      `select d.id, d.milestone_id, d.engagement_id, d.due_date, d.noticed_at, d.expected_date, d.cause, d.cause_note, d.attributed_at, d.credit_id,
         m.name as step, m.status as step_status, o.name as partner, c.name as client
       from delays d join milestones m on m.id = d.milestone_id join orgs o on o.id = d.partner_org_id join orgs c on c.id = d.client_org_id
       where m.status <> 'client_approved' or d.cause is null order by d.noticed_at desc limit 200`,
    )
  ).rows;
  const credits = (
    await tx.query(
      `select g.id, g.engagement_id, g.milestone_id, g.base_fils, g.guarantee_bp, g.amount_fils, g.status, g.borne_by_partner, g.payout_reduction_fils, g.settled_reference, g.created_at,
         m.name as step, o.name as partner, c.name as client, d.cause
       from guarantee_credits g join milestones m on m.id = g.milestone_id join orgs o on o.id = g.partner_org_id join orgs c on c.id = g.client_org_id
       left join delays d on d.credit_id = g.id order by g.created_at desc limit 200`,
    )
  ).rows;
  return { delays: delays.map(camel), credits: credits.map(camel) };
}

// Ratings ---------------------------------------------------------------------------------------------------------

export async function rateEngagement(tx: Queryable, actor: SessionUser, engagementId: string, stars: number, comment: string, deps: Deps) {
  if (actor.role !== "client_owner") throw forbidden("Only the account owner rates the work");
  const e = (await tx.query<{ client_org_id: string; status: string }>("select client_org_id, status from engagements where id = $1", [engagementId])).rows[0];
  if (!e || e.client_org_id !== actor.orgId) throw notFound("Engagement not found");
  if (e.status !== "completed") throw conflict("You can rate the work once it is complete");
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw badRequest("Give one to five stars");
  // One rating per engagement from the client; every partner that delivered part of it receives it.
  const partners = (await tx.query<{ org_id: string }>("select distinct org_id from engagement_parties where engagement_id = $1 and party = 'partner' order by org_id", [engagementId])).rows;
  if (!partners.length) throw conflict("No partner delivered this engagement");
  const exists = (await tx.query("select 1 from ratings where engagement_id = $1", [engagementId])).rows.length > 0;
  if (exists) throw conflict("This engagement has already been rated");
  const masked = maskContacts(comment.trim().slice(0, 1000));
  const ids: string[] = [];
  for (const p of partners) {
    const r = (
      await tx.query<{ id: string }>("insert into ratings (engagement_id, client_org_id, partner_org_id, author_user_id, stars, comment_original, comment_shown) values ($1,$2,$3,$4,$5,$6,$7) returning id", [engagementId, actor.orgId, p.org_id, actor.id, stars, comment.trim().slice(0, 1000), masked.text])
    ).rows[0]!;
    ids.push(r.id);
    await notifyOrg(tx, deps, p.org_id, "rating_received", { engagementId, stars });
  }
  await audit(tx, actor, "engagement.rated", "engagement", engagementId, { stars, masked: masked.masked, partners: partners.map((p) => p.org_id) });
  return { id: ids[0]!, ids };
}

// Manual allocation ---------------------------------------------------------------------------------------------

/** Ops offers specific open lines to a chosen partner. The hard filters and the priced-cost check still apply. */
export async function allocateManually(tx: Queryable, actor: SessionUser, engagementId: string, partnerId: string, codes: string[], reason: string, deps: Deps) {
  if (!isOps(actor)) throw forbidden("Only ops allocates by hand");
  if (reason.trim().length < 5) throw badRequest("Record why this partner, for the audit trail");
  // The same lock as the allocation engine (O13), so a manual offer and an automatic one never take the same line.
  await lockAuditChain(tx);
  await tx.query("select pg_advisory_xact_lock(777003)");
  const e = (await tx.query<Record<string, unknown>>("select * from engagements where id = $1", [engagementId])).rows[0];
  if (!e) throw notFound("Engagement not found");
  if (e.status !== "allocating") throw conflict("Lines can be allocated by hand only while the engagement is allocating");
  const lines = (
    await tx.query<Record<string, unknown>>(
      `select * from engagement_lines l where engagement_id = $1 and partner_org_id is null and code = any($2::text[])
         and not exists (select 1 from allocations a where a.engagement_id = l.engagement_id and l.code = any(a.codes)
                         and a.accepted_at is null and a.declined_at is null and a.timed_out_at is null)`,
      [engagementId, codes],
    )
  ).rows;
  if (lines.length !== codes.length) throw conflict("Some of those lines are already allocated or offered");
  const [partners, deliverables] = await Promise.all([loadPartners(tx), loadDeliverables(tx)]);
  const p = partners.get(partnerId);
  if (!p) throw notFound("Partner not found");
  const ctx = { codes, emirate: String(e.emirate), clientOrgId: String(e.client_org_id), freeZone: (e.free_zone as string | null) ?? null };
  const elig = checkEligibility(p, ctx, deliverables);
  if (!elig.eligible) throw conflict(`${p.name} is not eligible: ${elig.failures.join("; ")}`);
  const cards = await loadRateCards(tx, codes, today(nowOf(deps)));
  const over = lines.filter((l) => {
    if (l.quoting_partner_org_id === partnerId) return false;
    const c = cards.find((x) => x.partnerId === partnerId && x.code === l.code);
    return c ? c.professionalFee + c.thirdPartyCost > num(l.partner_unit_fils) : false;
  });
  if (over.length) throw conflict(`${p.name}'s cost for ${over.map((l) => l.code).join(", ")} is above the cost the client's price was built on`);
  const payoutLines = lines.map((l) => {
    const own = l.quoting_partner_org_id === partnerId ? null : cards.find((c) => c.partnerId === partnerId && c.code === l.code);
    return { code: String(l.code), qty: num(l.qty), unitFils: own ? own.professionalFee + own.thirdPartyCost : num(l.partner_unit_fils) };
  });
  // Reuse the engine only to record the fairness picture ops is overriding.
  const shares = await monthShares(tx, categoryOf(codes, deliverables));
  const auto = allocate({ codes, emirate: ctx.emirate, freeZone: ctx.freeZone, clientOrgId: ctx.clientOrgId, quotingPartnerId: (lines[0]?.quoting_partner_org_id as string | null) ?? null, rankedPartnerIds: [], monthShare: shares }, partners, deliverables);
  const deadline = addWorkingDays(nowOf(deps), 0.5, await loadCalendar(tx));
  const a = (
    await tx.query<{ id: string }>(
      `insert into allocations (engagement_id, partner_org_id, codes, reason, deadline, fallback_org_id, payout_lines, brief) values ($1,$2,$3,'manual_override',$4,$5,$6,$7) returning id`,
      [engagementId, partnerId, codes, deadline.toISOString(), auto.partnerId === partnerId ? auto.fallbackId : auto.partnerId, JSON.stringify(payoutLines), JSON.stringify({ emirate: e.emirate, freeZone: e.free_zone ?? null, lines: lines.map((l) => ({ code: l.code, name: deliverables.get(String(l.code))?.name ?? l.code, qty: l.qty })) })],
    )
  ).rows[0]!;
  await audit(tx, actor, "allocation.manual", "allocation", a.id, { engagementId, partnerId, codes, reason: reason.trim(), engineWouldHaveChosen: auto.partnerId, monthShare: shares.get(partnerId) ?? 0 });
  await notifyOrg(tx, deps, partnerId, "allocation_offered", { allocationId: a.id, deadline: deadline.toISOString() });
  return { allocationId: a.id };
}

// Offer document ----------------------------------------------------------------------------------------------

/** The client's branded offer: scope, prices, government fees, VAT, assumptions, timeline, validity. No partner. */
export async function offerDocument(tx: Queryable, actor: SessionUser, offerId: string): Promise<{ pdf: Buffer; fileName: string }> {
  const o = (await tx.query<Record<string, unknown>>("select o.*, c.name as client from offers o join orgs c on c.id = o.client_org_id where o.id = $1", [offerId])).rows[0];
  if (!o) throw notFound("Offer not found");
  if (actor.orgType === "client" && o.client_org_id !== actor.orgId) throw notFound("Offer not found");
  if (actor.orgType === "partner") throw forbidden("Offers are for clients");
  if (actor.orgType === "client" && !["published", "accepted", "expired"].includes(String(o.status))) throw notFound("Offer not found");
  const lines = (await tx.query<Record<string, unknown>>("select l.code, d.name, d.category, l.qty, l.model, l.gov_unit_fils, l.client_unit_fils from offer_lines l join deliverables d on d.code = l.code where l.offer_id = $1 order by d.category, l.code", [offerId])).rows;
  const company = await loadCompany(tx);
  const ref = String(o.id).slice(0, 8).toUpperCase();
  const money = (f: unknown) => formatAed(num(f));
  const out: string[] = [];
  out.push("TASEES, BY MKW ADVISORS", "Your UAE business services, one clear price", "", `Offer ${ref} (${String(o.tier)} tier)`, `Prepared for: ${String(o.client)}`, `Date: ${String(o.published_at ?? o.created_at).slice(0, 10)}    Valid until: ${String(o.valid_to).slice(0, 10)}`, "", "SCOPE AND PRICES (AED, excluding VAT)", "");
  out.push(col("Service", "Qty   Price"), "-".repeat(78));
  let maxDays = 0;
  for (const l of lines) {
    const t = MILESTONE_TEMPLATES[String(l.code)];
    const days = t ? Math.max(...t.map((m) => m.dueOffsetDays)) : 12;
    maxDays = Math.max(maxDays, days);
    const price = num(l.qty) * num(l.client_unit_fils);
    out.push(col(`${String(l.name)} (${String(l.code)})`, `${String(l.qty).padStart(3)}   ${money(price)}`));
    if (num(l.gov_unit_fils) > 0) out.push(col(`   Government fees at cost, no mark-up`, money(num(l.qty) * num(l.gov_unit_fils))));
  }
  out.push("-".repeat(78));
  out.push(col("Professional fees", money(o.professional_fils)), col("MKW Advisors service fee", money(o.mkw_fees_fils)), col("VAT 5% on fees", money(o.vat_fils)), col("Government fees (at cost, no VAT)", money(o.government_fils)), col("TOTAL", money(o.client_total_fils)), "");
  out.push("HOW PAYMENT WORKS", `  Deposit on acceptance: 50% of fees plus all government fees. Balance when the work is complete.`, `  Card or bank transfer; a tax invoice is issued for every payment.`, "");
  out.push("TIMELINE", `  About ${maxDays} UAE working days from the deposit and your documents, per service; each step has a`, `  due date you can follow online. Government processing times are outside our control.`, "");
  out.push("WHAT IS INCLUDED", "  Scope management, pricing, a vetted delivery partner from the MKW Advisors Partner Network,", "  quality checks on every step, and our service guarantee: a step more than five working days", "  late earns you a credit of part of the fee.", "");
  out.push("ASSUMPTIONS AND EXCLUSIONS", "  Government fees are as published on the offer date and are passed on at cost; changes by the", "  authority are charged at cost. Services not listed, attestations abroad, translations, courier", "  and bank charges are excluded unless listed. Statutory outcomes (approvals, visas, bank", "  accounts) are decided by the authority or bank, not by us; we manage the process.", "");
  out.push("HOW TO ACCEPT", `  The account owner accepts online; the offer stays valid until ${String(o.valid_to).slice(0, 10)}.`, "", `${company.legalName}${company.trn ? ` | TRN ${company.trn}` : ""}`, company.address.replace(/\s+/g, " ").slice(0, 78), "Tasees is a service of MKW Advisors.");
  return { pdf: textPdf(out, `Tasees offer ${ref}`), fileName: `tasees-offer-${ref}.pdf` };
}

import {
  addWorkingDays,
  addWorkingHours,
  allocate,
  applyBp,
  assertEngagement,
  assertMilestone,
  ceilTo,
  maskContacts,
  milestonesFor,
  payoutStagesEligible,
  paymentPlan,
  splitByShares,
  type AllocationReason,
  type EngagementStatus,
  type MilestoneStatus,
  type OfferTotals,
  type PayoutStage,
} from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import type { Notifier } from "../lib/notify.ts";
import { loadDeliverables, loadPartners, loadRateCards, loadRules, loadSettings, today } from "./repo.ts";

export const ALLOCATION_SLA_HOURS = 4;
export const CLIENT_REVIEW_DAYS = 5;
const PAYOUT_SHARES: [number, number, number] = [4_000, 4_000, 2_000];

export interface Deps {
  notify: Notifier;
  now?: () => Date;
}
const nowOf = (deps: Deps) => (deps.now ? deps.now() : new Date());

// Offers -> engagements --------------------------------------------------------

export async function acceptOffer(tx: Queryable, user: SessionUser, offerId: string, deps: Deps): Promise<string> {
  const o = (
    await tx.query<Record<string, unknown>>(
      `select o.*, r.answers from offers o join requests r on r.id = o.request_id where o.id = $1`,
      [offerId],
    )
  ).rows[0];
  if (!o) throw notFound("Offer not found");
  if (o.client_org_id !== user.orgId) throw forbidden("This offer belongs to another client");
  if (user.role !== "client_owner") throw forbidden("Only the account owner can accept offers");
  if (String(o.valid_to).slice(0, 10) < today(nowOf(deps))) throw conflict("This offer has expired. Ask for a fresh one.");
  if (o.status !== "published") throw conflict("This offer is not open for acceptance");

  await tx.query("update offers set status = 'accepted', accepted_at = app_now() where id = $1", [offerId]);
  await tx.query(
    "update offers set status = 'withdrawn' where request_id = $1 and id <> $2 and status in ('draft','ops_review','published')",
    [o.request_id, offerId],
  );
  await tx.query("update requests set status = 'closed' where id = $1", [o.request_id]);
  const answers = (o.answers ?? {}) as { emirate?: string; freeZone?: string | null };
  const eng = (
    await tx.query<{ id: string }>(
      `insert into engagements (offer_id, request_id, client_org_id, status, emirate, free_zone)
       values ($1,$2,$3,'awaiting_payment',$4,$5) returning id`,
      [offerId, o.request_id, o.client_org_id, answers.emirate ?? "Dubai", answers.freeZone ?? null],
    )
  ).rows[0]!;
  await tx.query("insert into engagement_parties (engagement_id, org_id, party) values ($1,$2,'client')", [eng.id, o.client_org_id]);
  await tx.query(
    `insert into engagement_lines (engagement_id, code, qty, quoting_partner_org_id, fallback_partner_org_id,
       partner_unit_fils, gov_unit_fils, client_unit_fils)
     select $1, code, qty, partner_org_id, fallback_partner_org_id, partner_unit_fils, gov_unit_fils, client_unit_fils + mkw_fee_unit_fils
     from offer_lines where offer_id = $2`,
    [eng.id, offerId],
  );
  const totals: OfferTotals = {
    professional: num(o.professional_fils),
    mkwFees: num(o.mkw_fees_fils),
    vat: num(o.vat_fils),
    government: num(o.government_fils),
    clientTotal: num(o.client_total_fils),
    partnerPayout: num(o.partner_payout_fils),
    margin: num(o.margin_fils),
    marginBp: num(o.margin_bp),
    linesNeedingReview: 0,
  };
  const plan = paymentPlan(totals);
  await tx.query(
    `insert into payments (engagement_id, client_org_id, kind, amount_fils, status) values ($1,$2,'deposit',$3,'pending'), ($1,$2,'balance',$4,'scheduled')`,
    [eng.id, o.client_org_id, plan.clientOnAcceptance, plan.clientOnCompletion],
  );
  await audit(tx, user, "offer.accepted", "engagement", eng.id, { offerId, deposit: plan.clientOnAcceptance });
  await deps.notify.send({ to: user.email, channel: "email", template: "payment_due", vars: { engagementId: eng.id, amountFils: plan.clientOnAcceptance } });
  return eng.id;
}

/** Called by the payment provider webhook (or finance in development). */
export async function markPaymentPaid(tx: Queryable, actor: SessionUser | null, paymentId: string, providerRef: string, deps: Deps) {
  const p = (await tx.query<Record<string, unknown>>("select * from payments where id = $1", [paymentId])).rows[0];
  if (!p) throw notFound("Payment not found");
  if (p.status === "paid") return; // idempotent: webhooks may repeat
  if (p.status !== "pending") throw conflict(`Payment is ${String(p.status)}, not pending`);
  await tx.query("update payments set status = 'paid', paid_at = app_now(), provider_ref = $2 where id = $1", [paymentId, providerRef]);
  await audit(tx, actor, "payment.paid", "payment", paymentId, { amount: num(p.amount_fils), kind: p.kind });
  const engagementId = String(p.engagement_id);
  if (p.kind === "deposit") {
    await setEngagementStatus(tx, engagementId, "allocating", "system");
    await runAllocation(tx, actor, engagementId, deps);
  }
  if (p.kind === "change_order") {
    await tx.query(
      "update payouts set status = 'eligible' where engagement_id = $1 and stage = 'change_order' and status = 'pending'",
      [engagementId],
    );
  }
}

async function setEngagementStatus(tx: Queryable, id: string, to: EngagementStatus, by: "system" | "platform" | "client" | "partner") {
  const e = (await tx.query<{ status: EngagementStatus }>("select status from engagements where id = $1", [id])).rows[0];
  if (!e) throw notFound("Engagement not found");
  if (e.status === to) return;
  assertEngagement(e.status, to, by);
  await tx.query(`update engagements set status = $2${to === "completed" ? ", completed_at = app_now()" : ""} where id = $1`, [id, to]);
}

// Allocation -------------------------------------------------------------------

/**
 * Offer every unassigned line group to a partner. Lines are grouped by the partner whose cost built them,
 * so a bundle can be split between firms. Partners that declined or timed out are excluded.
 */
export async function runAllocation(
  tx: Queryable,
  actor: SessionUser | null,
  engagementId: string,
  deps: Deps,
  retryReason?: "next_ranked_declined" | "next_ranked_sla_timeout",
): Promise<Array<{ allocationId: string | null; partnerId: string | null; reason: string; codes: string[] }>> {
  const e = (await tx.query<Record<string, unknown>>("select * from engagements where id = $1", [engagementId])).rows[0];
  if (!e) throw notFound("Engagement not found");
  const lines = (
    await tx.query<Record<string, unknown>>(
      `select * from engagement_lines l where engagement_id = $1 and partner_org_id is null
         and not exists (select 1 from allocations a where a.engagement_id = l.engagement_id and l.code = any(a.codes)
                         and a.accepted_at is null and a.declined_at is null and a.timed_out_at is null)`,
      [engagementId],
    )
  ).rows;
  if (lines.length === 0) return [];

  const [partners, deliverables] = await Promise.all([loadPartners(tx), loadDeliverables(tx)]);
  const tried = (
    await tx.query<{ partner_org_id: string; codes: string[] }>(
      "select partner_org_id, codes from allocations where engagement_id = $1 and (declined_at is not null or timed_out_at is not null)",
      [engagementId],
    )
  ).rows;
  const shares = await monthShares(tx);
  const sourced = (
    await tx.query<{ sourced_by_partner_id: string | null }>("select sourced_by_partner_id from requests where id = $1", [e.request_id])
  ).rows[0]?.sourced_by_partner_id;

  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const l of lines) {
    const k = String(l.quoting_partner_org_id ?? "none");
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }

  const results = [];
  for (const [quoting, group] of groups) {
    const codes = group.map((l) => String(l.code));
    const excluded = tried.filter((t) => t.codes.some((c) => codes.includes(c))).map((t) => t.partner_org_id);
    const fallback = group.map((l) => l.fallback_partner_org_id as string | null).find(Boolean) ?? null;
    const others = [...partners.values()]
      .filter((p) => codes.every((c) => p.codes.includes(c)))
      .sort((a, b) => b.quality - a.quality)
      .map((p) => p.id);
    // Margin protection: another partner may take these lines only at or below the cost the offer was priced on.
    const cards = await loadRateCards(tx, codes, today());
    const withinPricedCost = (pid: string) =>
      group.every((l) => {
        const c = cards.find((x) => x.partnerId === pid && x.code === l.code);
        return !c || c.professionalFee + c.thirdPartyCost <= num(l.partner_unit_fils);
      });
    const decision = allocate(
      {
        withinPricedCost,
        codes,
        emirate: String(e.emirate),
        freeZone: (e.free_zone as string | null) ?? null,
        clientOrgId: String(e.client_org_id),
        quotingPartnerId: quoting === "none" ? null : quoting,
        rankedPartnerIds: [...new Set([fallback, ...others].filter((x): x is string => !!x))],
        sourcedByPartnerId: sourced ?? null,
        excluded,
        monthShare: shares,
        retryReason,
      },
      partners,
      deliverables,
    );
    if (!decision.partnerId) {
      await audit(tx, actor, "allocation.none", "engagement", engagementId, { codes, skipped: decision.skipped });
      results.push({ allocationId: null, partnerId: null, reason: decision.reason, codes });
      continue;
    }
    const payoutLines = await payoutLinesFor(tx, decision.partnerId, group);
    const deadline = addWorkingHours(nowOf(deps), ALLOCATION_SLA_HOURS);
    const a = (
      await tx.query<{ id: string }>(
        `insert into allocations (engagement_id, partner_org_id, codes, reason, deadline, fallback_org_id, payout_lines, brief)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [
          engagementId,
          decision.partnerId,
          codes,
          decision.reason,
          deadline.toISOString(),
          decision.fallbackId,
          JSON.stringify(payoutLines),
          JSON.stringify({
            emirate: e.emirate,
            freeZone: e.free_zone ?? null,
            lines: group.map((l) => ({ code: l.code, name: deliverables.get(String(l.code))?.name ?? l.code, qty: l.qty })),
          }),
        ],
      )
    ).rows[0]!;
    await audit(tx, actor, "allocation.offered", "allocation", a.id, {
      engagementId,
      partnerId: decision.partnerId,
      reason: decision.reason as AllocationReason,
      codes,
      skipped: decision.skipped,
    });
    await notifyOrg(tx, deps, decision.partnerId, "allocation_offered", { allocationId: a.id, deadline: deadline.toISOString() });
    results.push({ allocationId: a.id, partnerId: decision.partnerId, reason: decision.reason, codes });
  }
  return results;
}

/** A partner other than the quoting one is paid its own active rate card where it has one, else the offer's cost. */
async function payoutLinesFor(tx: Queryable, partnerId: string, group: Array<Record<string, unknown>>) {
  const cards = await loadRateCards(tx, group.map((l) => String(l.code)), today());
  return group.map((l) => {
    const own = l.quoting_partner_org_id === partnerId ? null : cards.find((c) => c.partnerId === partnerId && c.code === l.code);
    return {
      code: String(l.code),
      qty: num(l.qty),
      unitFils: own ? own.professionalFee + own.thirdPartyCost : num(l.partner_unit_fils),
    };
  });
}

async function monthShares(tx: Queryable): Promise<Map<string, number>> {
  const r = await tx.query<{ partner_org_id: string; n: number }>(
    "select partner_org_id, count(*)::int as n from allocations where offered_at >= date_trunc('month', app_now()) group by 1",
  );
  const total = r.rows.reduce((a, b) => a + num(b.n), 0);
  return new Map(r.rows.map((x) => [x.partner_org_id, total === 0 ? 0 : num(x.n) / total]));
}

export async function respondToAllocation(
  tx: Queryable,
  user: SessionUser,
  allocationId: string,
  decision: "accept" | "decline",
  reason: string | undefined,
  deps: Deps,
) {
  const a = (await tx.query<Record<string, unknown>>("select * from allocations where id = $1", [allocationId])).rows[0];
  if (!a || a.partner_org_id !== user.orgId) throw notFound("Allocation not found");
  if (user.role !== "partner_admin") throw forbidden("Only a partner admin can accept or decline work");
  if (a.accepted_at || a.declined_at || a.timed_out_at) throw conflict("This allocation has already been answered or has lapsed");
  const engagementId = String(a.engagement_id);
  if (new Date(String(a.deadline)) < nowOf(deps)) {
    await timeOut(tx, allocationId, engagementId, deps);
    throw conflict("The time to accept has passed; the work has been offered to another partner");
  }
  if (decision === "decline") {
    if (!reason?.trim()) throw badRequest("Give a reason for declining");
    await tx.query("update allocations set declined_at = app_now(), decline_reason = $2 where id = $1", [allocationId, reason.trim()]);
    await audit(tx, user, "allocation.declined", "allocation", allocationId, { reason });
    await runAllocation(tx, user, engagementId, deps, "next_ranked_declined");
    return;
  }

  await tx.query("update allocations set accepted_at = app_now() where id = $1", [allocationId]);
  await tx.query(
    "insert into engagement_parties (engagement_id, org_id, party) values ($1,$2,'partner') on conflict do nothing",
    [engagementId, user.orgId],
  );
  const payoutLines = a.payout_lines as Array<{ code: string; qty: number; unitFils: number }>;
  let seq = num(
    (await tx.query<{ n: number }>("select coalesce(max(seq), 0)::int as n from milestones where engagement_id = $1", [engagementId])).rows[0]?.n,
  );
  const start = nowOf(deps);
  for (const pl of payoutLines) {
    await tx.query(
      "update engagement_lines set partner_org_id = $3, partner_unit_fils = $4 where engagement_id = $1 and code = $2",
      [engagementId, pl.code, user.orgId, pl.unitFils],
    );
    for (const m of milestonesFor(pl.code, pl.qty)) {
      seq += 1;
      await tx.query(
        `insert into milestones (engagement_id, partner_org_id, code, seq, name, is_key, due_date, evidence_required)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [engagementId, user.orgId, pl.code, seq, m.name, m.isKey, addWorkingDays(start, m.dueOffsetDays).toISOString().slice(0, 10), m.evidence],
      );
    }
  }
  const total = payoutLines.reduce((s, l) => s + l.unitFils * l.qty, 0);
  const amounts = splitByShares(total, PAYOUT_SHARES);
  const stages: PayoutStage[] = ["kickoff", "key_milestone", "completion"];
  for (const [i, stage] of stages.entries()) {
    await tx.query(
      "insert into payouts (engagement_id, partner_org_id, stage, amount_fils, status) values ($1,$2,$3,$4,$5)",
      [engagementId, user.orgId, stage, amounts[i] ?? 0, stage === "kickoff" ? "eligible" : "pending"],
    );
  }
  await audit(tx, user, "allocation.accepted", "allocation", allocationId, { engagementId, payout: total });
  const open = (
    await tx.query<{ n: number }>("select count(*)::int as n from engagement_lines where engagement_id = $1 and partner_org_id is null", [engagementId])
  ).rows[0];
  if (num(open?.n) === 0) await setEngagementStatus(tx, engagementId, "in_delivery", "partner");
}

async function timeOut(tx: Queryable, allocationId: string, engagementId: string, deps: Deps) {
  const a = (await tx.query<{ partner_org_id: string }>(
    "update allocations set timed_out_at = app_now() where id = $1 and accepted_at is null and declined_at is null and timed_out_at is null returning partner_org_id",
    [allocationId],
  )).rows[0];
  if (!a) return;
  // A missed acceptance SLA is a strike on the partner's scorecard.
  await tx.query(
    `update orgs set profile = jsonb_set(profile, '{slaStrikes}', to_jsonb(coalesce((profile->>'slaStrikes')::int, 0) + 1)) where id = $1`,
    [a.partner_org_id],
  );
  await audit(tx, null, "allocation.timed_out", "allocation", allocationId, { engagementId });
  await runAllocation(tx, null, engagementId, deps, "next_ranked_sla_timeout");
}

export async function sweepAllocationTimeouts(tx: Queryable, deps: Deps): Promise<number> {
  const due = (
    await tx.query<{ id: string; engagement_id: string }>(
      "select id, engagement_id from allocations where accepted_at is null and declined_at is null and timed_out_at is null and deadline < $1",
      [nowOf(deps).toISOString()],
    )
  ).rows;
  for (const a of due) await timeOut(tx, a.id, a.engagement_id, deps);
  return due.length;
}

// Milestones ---------------------------------------------------------------------

async function loadMilestone(tx: Queryable, id: string) {
  const m = (await tx.query<Record<string, unknown>>("select * from milestones where id = $1", [id])).rows[0];
  if (!m) throw notFound("Milestone not found");
  return m as Record<string, unknown> & { status: MilestoneStatus; engagement_id: string; partner_org_id: string };
}

export async function startMilestone(tx: Queryable, user: SessionUser, id: string) {
  const m = await loadMilestone(tx, id);
  if (user.orgType === "partner" && m.partner_org_id !== user.orgId) throw notFound("Milestone not found");
  assertMilestone(m.status, "in_progress", user.orgType === "partner" ? "partner" : "platform");
  await tx.query("update milestones set status = 'in_progress', updated_at = app_now() where id = $1", [id]);
  await audit(tx, user, "milestone.started", "milestone", id);
}

export async function addEvidence(
  tx: Queryable,
  user: SessionUser,
  milestoneId: string,
  file: { type: string; key: string; name: string },
) {
  const m = await loadMilestone(tx, milestoneId);
  if (user.orgType !== "partner" || m.partner_org_id !== user.orgId) throw notFound("Milestone not found");
  if (!["in_progress", "qa_rejected", "pending"].includes(m.status)) throw conflict("Evidence can only be added while work is in progress");
  await tx.query(
    "insert into evidence (milestone_id, engagement_id, type, file_key, file_name, uploaded_by) values ($1,$2,$3,$4,$5,$6)",
    [milestoneId, m.engagement_id, file.type, file.key, file.name, user.id],
  );
  if (m.status === "pending") await tx.query("update milestones set status = 'in_progress' where id = $1", [milestoneId]);
  await audit(tx, user, "evidence.added", "milestone", milestoneId, { type: file.type, name: file.name });
}

export async function submitMilestone(tx: Queryable, user: SessionUser, milestoneId: string) {
  const m = await loadMilestone(tx, milestoneId);
  if (user.orgType !== "partner" || m.partner_org_id !== user.orgId) throw notFound("Milestone not found");
  const required = (m.evidence_required as string[]) ?? [];
  const have = (await tx.query<{ type: string }>("select distinct type from evidence where milestone_id = $1", [milestoneId])).rows.map((r) => r.type);
  const missing = required.filter((r) => !have.includes(r));
  if (have.length === 0 || missing.length > 0) {
    throw badRequest(`Attach the evidence first: ${missing.join(", ") || "at least one file"}`);
  }
  assertMilestone(m.status, "evidence_submitted", "partner");
  await tx.query("update milestones set status = 'evidence_submitted', updated_at = app_now() where id = $1", [milestoneId]);
  await audit(tx, user, "milestone.submitted", "milestone", milestoneId);
}

export async function qaMilestone(tx: Queryable, user: SessionUser, milestoneId: string, pass: boolean, note: string | undefined, deps: Deps) {
  const m = await loadMilestone(tx, milestoneId);
  const to: MilestoneStatus = pass ? "qa_passed" : "qa_rejected";
  assertMilestone(m.status, to, "platform");
  if (!pass && !note?.trim()) throw badRequest("Say what needs fixing");
  await tx.query(
    `update milestones set status = $2, qa_note = $3, updated_at = app_now()${pass ? ", qa_passed_at = app_now()" : ""} where id = $1`,
    [milestoneId, to, note ?? null],
  );
  await audit(tx, user, pass ? "milestone.qa_passed" : "milestone.qa_rejected", "milestone", milestoneId, { note });
  if (pass) {
    const client = (await tx.query<{ client_org_id: string }>("select client_org_id from engagements where id = $1", [m.engagement_id])).rows[0];
    if (client) await notifyOrg(tx, deps, client.client_org_id, "milestone_ready_for_review", { milestoneId });
  } else {
    await notifyOrg(tx, deps, m.partner_org_id, "milestone_qa_rejected", { milestoneId, note: note ?? "" });
  }
}

export async function clientReviewMilestone(
  tx: Queryable,
  user: SessionUser | null,
  milestoneId: string,
  approve: boolean,
  reason: string | undefined,
  deps: Deps,
) {
  const m = await loadMilestone(tx, milestoneId);
  if (user) {
    const e = (await tx.query<{ client_org_id: string }>("select client_org_id from engagements where id = $1", [m.engagement_id])).rows[0];
    if (!e || e.client_org_id !== user.orgId) throw notFound("Milestone not found");
  }
  const by = user ? "client" : "system";
  if (approve) {
    assertMilestone(m.status, "client_approved", by);
    await tx.query("update milestones set status = 'client_approved', updated_at = app_now() where id = $1", [milestoneId]);
  } else {
    if (!reason?.trim()) throw badRequest("Tell us what is wrong so we can fix it");
    assertMilestone(m.status, "disputed", "client");
    await tx.query("update milestones set status = 'disputed', dispute_reason = $2, updated_at = app_now() where id = $1", [milestoneId, reason]);
  }
  await audit(tx, user, approve ? "milestone.approved" : "milestone.disputed", "milestone", milestoneId, {
    reason,
    auto: user === null,
  });
  await refreshPayouts(tx, m.engagement_id, deps);
}

/** Resolve a disputed milestone: send it back to the partner, or approve it. */
export async function resolveDispute(tx: Queryable, user: SessionUser, milestoneId: string, outcome: "rework" | "approve", deps: Deps) {
  const m = await loadMilestone(tx, milestoneId);
  assertMilestone(m.status, outcome === "rework" ? "in_progress" : "client_approved", "platform");
  await tx.query("update milestones set status = $2, updated_at = app_now() where id = $1", [
    milestoneId,
    outcome === "rework" ? "in_progress" : "client_approved",
  ]);
  await audit(tx, user, `milestone.dispute_${outcome}`, "milestone", milestoneId);
  await refreshPayouts(tx, m.engagement_id, deps);
}

/** Milestones QA-passed and not reviewed by the client within the review window count as approved. */
export async function sweepAutoApprovals(tx: Queryable, deps: Deps): Promise<number> {
  const candidates = (
    await tx.query<{ id: string; qa_passed_at: string }>("select id, qa_passed_at from milestones where status = 'qa_passed'")
  ).rows;
  let n = 0;
  for (const c of candidates) {
    if (addWorkingDays(new Date(c.qa_passed_at), CLIENT_REVIEW_DAYS) < nowOf(deps)) {
      await clientReviewMilestone(tx, null, c.id, true, undefined, deps);
      n++;
    }
  }
  return n;
}

async function refreshPayouts(tx: Queryable, engagementId: string, deps: Deps) {
  const ms = (
    await tx.query<{ partner_org_id: string; is_key: boolean; status: MilestoneStatus }>(
      "select partner_org_id, is_key, status from milestones where engagement_id = $1",
      [engagementId],
    )
  ).rows;
  const byPartner = new Map<string, Array<{ isKey: boolean; status: MilestoneStatus }>>();
  for (const m of ms) byPartner.set(m.partner_org_id, [...(byPartner.get(m.partner_org_id) ?? []), { isKey: m.is_key, status: m.status }]);
  for (const [partnerId, list] of byPartner) {
    for (const stage of payoutStagesEligible(true, list)) {
      await tx.query(
        "update payouts set status = 'eligible' where engagement_id = $1 and partner_org_id = $2 and stage = $3 and status = 'pending'",
        [engagementId, partnerId, stage],
      );
    }
  }
  const lines = (
    await tx.query<{ n: number }>("select count(*)::int as n from engagement_lines where engagement_id = $1 and partner_org_id is null", [engagementId])
  ).rows[0];
  const allApproved = ms.length > 0 && ms.every((m) => m.status === "client_approved") && num(lines?.n) === 0;
  if (allApproved) {
    await setEngagementStatus(tx, engagementId, "completed", "system");
    await tx.query("update payments set status = 'pending' where engagement_id = $1 and kind = 'balance' and status = 'scheduled'", [engagementId]);
    await audit(tx, null, "engagement.completed", "engagement", engagementId);
    void deps;
  }
}

export async function releasePayout(tx: Queryable, user: SessionUser, payoutId: string, deps: Deps) {
  if (!["finance", "founder"].includes(user.role)) throw forbidden("Only finance can release payouts");
  const p = (await tx.query<Record<string, unknown>>("select * from payouts where id = $1", [payoutId])).rows[0];
  if (!p) throw notFound("Payout not found");
  if (p.status !== "eligible") throw conflict(`This payout is ${String(p.status)}; only eligible payouts can be released`);
  await tx.query("update payouts set status = 'released', released_at = app_now(), released_by = $2 where id = $1", [payoutId, user.id]);
  await audit(tx, user, "payout.released", "payout", payoutId, { amount: num(p.amount_fils) });
  await notifyOrg(tx, deps, String(p.partner_org_id), "payout_released", { payoutId, amountFils: num(p.amount_fils) });
}

// Change orders ------------------------------------------------------------------

export async function proposeChangeOrder(tx: Queryable, user: SessionUser, engagementId: string, description: string, partnerFils: number) {
  if (user.orgType !== "partner") throw forbidden("Partners raise change orders");
  const isParty = (
    await tx.query("select 1 from engagement_parties where engagement_id = $1 and org_id = $2", [engagementId, user.orgId])
  ).rows.length;
  if (!isParty) throw notFound("Engagement not found");
  if (!description.trim()) throw badRequest("Describe the change");
  if (!Number.isInteger(partnerFils) || partnerFils <= 0) throw badRequest("Give the extra cost as a positive amount");
  const line = (
    await tx.query<{ code: string }>("select code from engagement_lines where engagement_id = $1 and partner_org_id = $2 limit 1", [engagementId, user.orgId])
  ).rows[0];
  const [deliverables, rules, settings] = await Promise.all([loadDeliverables(tx), loadRules(tx), loadSettings(tx)]);
  const rule = rules.get(deliverables.get(line?.code ?? "")?.category ?? "") ?? { rateBp: 2_000, floor: 0, category: "" };
  // Same margin rule as the original work; no market cap for one-off changes.
  const clientFils = ceilTo(Math.max(partnerFils + applyBp(partnerFils, rule.rateBp), partnerFils + rule.floor), settings.roundTo);
  const co = (
    await tx.query<{ id: string }>(
      `insert into change_orders (engagement_id, raised_by_org, description, partner_fils, client_fils, status)
       values ($1,$2,$3,$4,$5,'priced') returning id`,
      [engagementId, user.orgId, description.trim(), partnerFils, clientFils],
    )
  ).rows[0]!;
  await audit(tx, user, "change_order.proposed", "change_order", co.id, { partnerFils, clientFils });
  return co.id;
}

export async function decideChangeOrder(tx: Queryable, user: SessionUser, changeOrderId: string, approve: boolean, deps: Deps) {
  const co = (await tx.query<Record<string, unknown>>("select c.*, e.client_org_id from change_orders c join engagements e on e.id = c.engagement_id where c.id = $1", [changeOrderId])).rows[0];
  if (!co || co.client_org_id !== user.orgId) throw notFound("Change order not found");
  if (user.role !== "client_owner") throw forbidden("Only the account owner can approve extra costs");
  if (co.status !== "priced") throw conflict("This change order is not waiting for a decision");
  await tx.query("update change_orders set status = $2, decided_at = app_now() where id = $1", [changeOrderId, approve ? "approved" : "rejected"]);
  if (approve) {
    const settings = await loadSettings(tx);
    const client = num(co.client_fils);
    await tx.query(
      "insert into payments (engagement_id, client_org_id, kind, amount_fils, status) values ($1,$2,'change_order',$3,'pending')",
      [co.engagement_id, co.client_org_id, client + applyBp(client, settings.vatBp)],
    );
    await tx.query(
      "insert into payouts (engagement_id, partner_org_id, stage, amount_fils, status) values ($1,$2,'change_order',$3,'pending')",
      [co.engagement_id, co.raised_by_org, num(co.partner_fils)],
    );
  }
  await audit(tx, user, approve ? "change_order.approved" : "change_order.rejected", "change_order", changeOrderId);
  void deps;
}

// Messages -----------------------------------------------------------------------

export async function postMessage(tx: Queryable, user: SessionUser, engagementId: string, body: string) {
  const text = body.trim();
  if (!text) throw badRequest("Write a message first");
  if (text.length > 4_000) throw badRequest("Keep messages under 4,000 characters");
  if (user.orgType !== "platform") {
    const ok = (await tx.query("select 1 from engagement_parties where engagement_id = $1 and org_id = $2", [engagementId, user.orgId])).rows.length;
    if (!ok) throw notFound("Engagement not found");
  }
  const shown = user.orgType === "platform" ? { text, masked: false } : maskContacts(text);
  const author = user.orgType === "platform" ? "Tasees team" : user.orgType === "partner" ? user.orgName : user.name;
  await tx.query(
    `insert into messages (engagement_id, author_user_id, author_org_id, author_name, body_original, body_shown, masked)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [engagementId, user.id, user.orgId, author, text, shown.text, shown.masked],
  );
  if (shown.masked) await audit(tx, user, "message.contact_masked", "engagement", engagementId);
}

// Requests for quote -----------------------------------------------------------------

export async function openQuoteRequest(tx: Queryable, user: SessionUser, requestId: string, codes: string[], deps: Deps) {
  const partners = await loadPartners(tx);
  const invited = [...partners.values()]
    .filter((p) => (p.status === "signed" || p.status === "pilot") && p.licenceActive && codes.some((c) => p.codes.includes(c)))
    .sort((a, b) => b.quality - a.quality)
    .slice(0, 5);
  if (invited.length === 0) throw conflict("No signed partner offers these services yet");
  const deadline = addWorkingHours(nowOf(deps), 9);
  const qr = (
    await tx.query<{ id: string }>("insert into quote_requests (request_id, deadline) values ($1,$2) returning id", [requestId, deadline.toISOString()])
  ).rows[0]!;
  for (const p of invited) {
    await tx.query("insert into quote_invites (quote_request_id, partner_org_id) values ($1,$2)", [qr.id, p.id]);
  }
  await tx.query("update requests set status = 'quoting' where id = $1", [requestId]);
  await audit(tx, user, "rfq.opened", "quote_request", qr.id, { codes, invited: invited.map((p) => p.id) });
  return { id: qr.id, invited: invited.length, deadline: deadline.toISOString() };
}

export interface QuoteLineInput {
  code: string;
  professionalFils: number;
  govStatedFils: number;
  thirdPartyFils: number;
  workingDays: number;
  exclusions: string[];
  assumptions: string;
}

export async function submitQuote(tx: Queryable, user: SessionUser, quoteRequestId: string, lines: QuoteLineInput[], deps: Deps) {
  if (user.role !== "partner_admin") throw forbidden("Only a partner admin can submit quotes");
  const qr = (
    await tx.query<{ id: string; request_id: string; deadline: string; status: string; scope: { lines: Array<{ code: string }> } }>(
      `select q.id, q.request_id, q.deadline, q.status, r.scope from quote_requests q join requests r on r.id = q.request_id
       join quote_invites i on i.quote_request_id = q.id and i.partner_org_id = $2 where q.id = $1`,
      [quoteRequestId, user.orgId],
    )
  ).rows[0];
  if (!qr) throw notFound("Request for quote not found");
  if (qr.status !== "open" || new Date(qr.deadline) < nowOf(deps)) throw conflict("This request for quote has closed");
  const allowed = new Set(qr.scope.lines.map((l) => l.code));
  if (lines.length === 0) throw badRequest("Price at least one line");
  for (const l of lines) {
    if (!allowed.has(l.code)) throw badRequest(`${l.code} is not in this request`);
    for (const v of [l.professionalFils, l.govStatedFils, l.thirdPartyFils]) {
      if (!Number.isInteger(v) || v < 0) throw badRequest("Amounts must be whole fils and not negative");
    }
    if (!Number.isInteger(l.workingDays) || l.workingDays < 1) throw badRequest("Working days must be 1 or more");
  }
  const q = (
    await tx.query<{ id: string }>(
      `insert into partner_quotes (quote_request_id, partner_org_id) values ($1,$2)
       on conflict (quote_request_id, partner_org_id) do update set submitted_at = app_now() returning id`,
      [quoteRequestId, user.orgId],
    )
  ).rows[0]!;
  await tx.query("delete from partner_quote_lines where quote_id = $1", [q.id]);
  const deliverables = await loadDeliverables(tx);
  for (const l of lines) {
    // Excluded items the scope needs are priced at market mid, so exclusions cannot make a quote look cheaper.
    const gap = l.exclusions.length > 0 ? Math.round((deliverables.get(l.code)?.marketMid ?? 0) * 0.1 * l.exclusions.length) : 0;
    await tx.query(
      `insert into partner_quote_lines (quote_id, code, professional_fils, gov_stated_fils, third_party_fils, working_days, exclusions, gap_fils, assumptions)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [q.id, l.code, l.professionalFils, l.govStatedFils, l.thirdPartyFils, l.workingDays, l.exclusions, gap, l.assumptions],
    );
  }
  await audit(tx, user, "rfq.quote_submitted", "quote_request", quoteRequestId, { lines: lines.length });
  return q.id;
}

// Helpers -------------------------------------------------------------------------

async function notifyOrg(
  tx: Queryable,
  deps: Deps,
  orgId: string,
  template: Parameters<Notifier["send"]>[0]["template"],
  vars: Record<string, string | number>,
) {
  const users = (
    await tx.query<{ email: string }>(
      "select email from users where org_id = $1 and role in ('client_owner','partner_admin') order by email limit 3",
      [orgId],
    )
  ).rows;
  for (const u of users) await deps.notify.send({ to: u.email, channel: "email", template, vars });
}

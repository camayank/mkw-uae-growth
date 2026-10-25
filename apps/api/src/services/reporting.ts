import { queueStats } from "./queue.ts";
import { aedDecimal, csvLine, parsePeriod, previousPeriod, rate, shares, type Period } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, forbidden } from "../lib/errors.ts";

/**
 * Reporting (O8): the founder dashboard, the partner dashboard and the accounting export. Figures are read
 * from the same invoice, payment and payout rows the books are built from; margin only for finance and
 * founder, as everywhere.
 */

const seesMargin = (u: SessionUser) => ["finance", "founder"].includes(u.role);

export interface Figures {
  period: Period;
  revenueNetFils: number;
  vatFils: number;
  disbursementsFils: number;
  creditNotesNetFils: number;
  cashCollectedFils: number;
  refundedFils: number;
  payoutsPaidFils: number;
  payoutsDueFils: number;
  guaranteeCreditsFils: number;
  requests: number;
  offersPublished: number;
  offersAccepted: number;
  requestToAcceptance: number;
  engagementsCompleted: number;
  milestonesDone: number;
  milestonesOnTime: number;
  onTimeRate: number;
  partnerShareByCategory: Record<string, Record<string, number>>;
  marginFils?: number;
  marginBp?: number;
}

async function figures(tx: Queryable, p: Period, withMargin: boolean): Promise<Figures> {
  const one = async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql, [p.from, p.to])).rows[0]!;
  // Credit notes carry negative amounts, so plain sums are already net of them.
  const inv = await one<{ net: number; vat: number; disb: number; credits: number }>(
    `select coalesce(sum(net_fils), 0)::bigint as net,
            coalesce(sum(vat_fils), 0)::bigint as vat,
            coalesce(sum(disbursements_fils), 0)::bigint as disb,
            coalesce(-sum(net_fils) filter (where kind = 'credit_note'), 0)::bigint as credits
     from invoices where status = 'issued' and gulf(issued_at) >= $1::date and gulf(issued_at) < $2::date`,
  );
  const cash = await one<{ paid: number; refunded: number }>(
    `select coalesce(sum(amount_fils) filter (where gulf(paid_at) >= $1::date and gulf(paid_at) < $2::date), 0)::bigint as paid,
            coalesce(sum(amount_fils) filter (where gulf(refunded_at) >= $1::date and gulf(refunded_at) < $2::date), 0)::bigint as refunded
     from payments where status in ('paid', 'refunded')`,
  );
  const pay = await one<{ paid: number; due: number }>(
    `select coalesce(sum(amount_fils) filter (where status = 'released' and gulf(released_at) >= $1::date and gulf(released_at) < $2::date), 0)::bigint as paid,
            coalesce(sum(amount_fils) filter (where status = 'eligible'), 0)::bigint as due
     from payouts`,
  );
  const credits = await one<{ n: number }>(`select coalesce(sum(amount_fils), 0)::bigint as n from guarantee_credits where status in ('applied', 'approved', 'settled') and gulf(decided_at) >= $1::date and gulf(decided_at) < $2::date`);
  const funnel = await one<{ requests: number; published: number; accepted: number; completed: number }>(
    `select (select count(*) from requests where gulf(created_at) >= $1::date and gulf(created_at) < $2::date)::int as requests,
            (select count(distinct request_id) from offers where gulf(published_at) >= $1::date and gulf(published_at) < $2::date)::int as published,
            (select count(*) from offers where gulf(accepted_at) >= $1::date and gulf(accepted_at) < $2::date)::int as accepted,
            (select count(*) from engagements where gulf(completed_at) >= $1::date and gulf(completed_at) < $2::date)::int as completed`,
  );
  const onTime = await one<{ done: number; on_time: number }>(
    `select count(*)::int as done,
            count(*) filter (where (m.first_submitted_at at time zone 'Asia/Dubai')::date <= m.due_date)::int as on_time
     from milestones m where m.status = 'client_approved'
       and gulf((select max(a.at) from audit_events a where a.entity = 'milestone' and a.entity_id = m.id::text and a.action in ('milestone.approved', 'milestone.dispute_approve'))) >= $1::date
       and gulf((select max(a.at) from audit_events a where a.entity = 'milestone' and a.entity_id = m.id::text and a.action in ('milestone.approved', 'milestone.dispute_approve'))) < $2::date`,
  );
  const share = (
    await tx.query<{ category: string; partner: string; n: number }>(
      `select d.category, o.name as partner, count(*)::int as n
       from allocations a join orgs o on o.id = a.partner_org_id join deliverables d on d.code = any(a.codes)
       where gulf(a.accepted_at) >= $1::date and gulf(a.accepted_at) < $2::date group by 1, 2 order by 1, 2`,
      [p.from, p.to],
    )
  ).rows;
  const byCat: Record<string, Record<string, number>> = {};
  for (const r of share) (byCat[r.category] ??= {})[r.partner] = num(r.n);
  const partnerShareByCategory = Object.fromEntries(Object.entries(byCat).map(([c, m]) => [c, shares(m)]));
  const out: Figures = {
    period: p,
    // Revenue is net of credit notes as well as VAT, so it reconciles to the sales export total.
    revenueNetFils: num(inv.net),
    vatFils: num(inv.vat),
    disbursementsFils: num(inv.disb),
    creditNotesNetFils: num(inv.credits),
    cashCollectedFils: num(cash.paid),
    refundedFils: num(cash.refunded),
    payoutsPaidFils: num(pay.paid),
    payoutsDueFils: num(pay.due),
    guaranteeCreditsFils: num(credits.n),
    requests: num(funnel.requests),
    offersPublished: num(funnel.published),
    offersAccepted: num(funnel.accepted),
    requestToAcceptance: rate(num(funnel.accepted), num(funnel.requests)),
    engagementsCompleted: num(funnel.completed),
    milestonesDone: num(onTime.done),
    milestonesOnTime: num(onTime.on_time),
    onTimeRate: rate(num(onTime.on_time), num(onTime.done)),
    partnerShareByCategory,
  };
  if (withMargin) {
    // Margin on accepted offers in the period: what the client pays less what partners are owed, before VAT.
    const m = await one<{ margin: number; prof: number }>(
      `select coalesce(sum(margin_fils), 0)::bigint as margin, coalesce(sum(professional_fils + mkw_fees_fils), 0)::bigint as prof
       from offers where gulf(accepted_at) >= $1::date and gulf(accepted_at) < $2::date`,
    );
    out.marginFils = num(m.margin);
    out.marginBp = num(m.prof) === 0 ? 0 : Math.round((num(m.margin) * 10_000) / num(m.prof));
  }
  return out;
}

export async function dashboard(tx: Queryable, actor: SessionUser, periodInput: string) {
  if (actor.orgType !== "platform") throw forbidden("MKW Advisors staff only");
  let period: Period;
  try {
    period = parsePeriod(periodInput);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const withMargin = seesMargin(actor);
  const [current, previous] = await Promise.all([figures(tx, period, withMargin), figures(tx, previousPeriod(period), withMargin)]);
  const pipeline = (
    await tx.query<{ status: string; n: number }>("select status, count(*)::int as n from engagements group by status order by status")
  ).rows;
  const openObligations = (await tx.query<{ status: string; n: number }>("select status, count(*)::int as n from obligations group by status")).rows;
  // How the ops queue ran in the period (O11): no money in it, so every staff role sees it.
  const queue = await queueStats(tx, period.from, period.to);
  return { current, previous, pipeline, obligations: openObligations, queue, seesMargin: withMargin };
}

export async function partnerDashboard(tx: Queryable, actor: SessionUser) {
  if (actor.orgType !== "partner") throw forbidden("Partners only");
  const org = actor.orgId;
  const jobs = (
    await tx.query<{ status: string; n: number }>(
      `select e.status, count(distinct e.id)::int as n from engagements e join engagement_parties p on p.engagement_id = e.id
       where p.org_id = $1 and p.party = 'partner' group by e.status order by e.status`,
      [org],
    )
  ).rows;
  const onTime = (
    await tx.query<{ done: number; on_time: number; open: number; late: number }>(
      `select count(*) filter (where m.status = 'client_approved')::int as done,
              count(*) filter (where m.status = 'client_approved' and (m.first_submitted_at at time zone 'Asia/Dubai')::date <= m.due_date)::int as on_time,
              count(*) filter (where m.status in ('pending', 'in_progress', 'qa_rejected'))::int as open,
              count(*) filter (where m.status in ('pending', 'in_progress', 'qa_rejected') and m.due_date < gulf(app_now()))::int as late
       from milestones m where m.partner_org_id = $1`,
      [org],
    )
  ).rows[0]!;
  const payouts = (
    await tx.query<{ status: string; total: number; n: number }>("select status, coalesce(sum(amount_fils), 0)::bigint as total, count(*)::int as n from payouts where partner_org_id = $1 group by status", [org])
  ).rows;
  const scorecards = (await tx.query("select computed_at, score, provisional, inputs from scorecards where partner_org_id = $1 order by computed_at desc limit 12", [org])).rows;
  const ratings = (await tx.query<{ avg: string | null; n: number }>("select avg(stars)::text as avg, count(*)::int as n from ratings where partner_org_id = $1", [org])).rows[0]!;
  return {
    jobs,
    milestones: { done: num(onTime.done), onTime: num(onTime.on_time), onTimeRate: rate(num(onTime.on_time), num(onTime.done)), open: num(onTime.open), late: num(onTime.late) },
    payouts: payouts.map((p) => ({ status: p.status, total: num(p.total), n: num(p.n) })),
    scorecards: scorecards.map((s) => ({ computedAt: s.computed_at, score: s.score, provisional: s.provisional, inputs: s.inputs })),
    rating: { average: ratings.avg === null ? null : Math.round(Number(ratings.avg) * 100) / 100, count: num(ratings.n) },
  };
}

// Accounting export ---------------------------------------------------------------------------------------------

export type ExportSet = "sales" | "payments" | "payouts" | "margin";

/** CSV for the accounting system. Generic layout; the owner's system decides the final mapping. */
export async function accountingExport(tx: Queryable, actor: SessionUser, set: ExportSet, from: string, to: string): Promise<{ csv: string; fileName: string; rows: number }> {
  if (actor.orgType !== "platform" || actor.role === "agent") throw forbidden("MKW Advisors staff only");
  if (set === "margin" && !seesMargin(actor)) throw forbidden("Margin is for finance and the founder");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw badRequest("Give a date range as YYYY-MM-DD, from before to");
  const toExcl = to; // inclusive end: compare on ::date <= to
  let header: string[];
  let rows: Array<Array<string | number | null>>;
  if (set === "sales") {
    header = ["Date", "Type", "Number", "Reverses", "Client", "Engagement", "Net AED", "VAT AED", "Disbursements AED", "Gross AED", "Currency", "Supply date", "Status"];
    const r = (
      await tx.query<Record<string, unknown>>(
        `select gulf(i.issued_at)::text as d, i.kind, i.number, r.number as reverses, c.name as client, i.engagement_id, i.net_fils, i.vat_fils, i.disbursements_fils, i.gross_fils, i.currency, i.supply_date::text as supply, i.status
         from invoices i join orgs c on c.id = i.client_org_id left join invoices r on r.id = i.reverses_invoice_id
         where i.status = 'issued' and gulf(i.issued_at) >= $1::date and gulf(i.issued_at) <= $2::date order by i.issued_at, i.number`,
        [from, toExcl],
      )
    ).rows;
    rows = r.map((x) => [String(x.d), x.kind === "credit_note" ? "Credit note" : "Tax invoice", String(x.number ?? ""), (x.reverses as string | null) ?? "", String(x.client), String(x.engagement_id).slice(0, 8).toUpperCase(), aedDecimal(num(x.net_fils)), aedDecimal(num(x.vat_fils)), aedDecimal(num(x.disbursements_fils)), aedDecimal(num(x.gross_fils)), String(x.currency), String(x.supply), String(x.status)]);
  } else if (set === "payments") {
    header = ["Date", "Type", "Client", "Engagement", "Kind", "Amount AED", "Provider", "Reference", "Invoice"];
    const r = (
      await tx.query<Record<string, unknown>>(
        `select gulf(p.paid_at)::text as paid, gulf(p.refunded_at)::text as refunded, c.name as client, p.engagement_id, p.kind, p.amount_fils, p.provider, p.provider_ref, p.refund_reference,
                (select number from invoices i where i.payment_id = p.id and i.kind = 'tax_invoice' limit 1) as invoice
         from payments p join orgs c on c.id = p.client_org_id
         where (gulf(p.paid_at) >= $1::date and gulf(p.paid_at) <= $2::date) or (gulf(p.refunded_at) >= $1::date and gulf(p.refunded_at) <= $2::date) order by coalesce(p.paid_at, p.refunded_at)`,
        [from, toExcl],
      )
    ).rows;
    rows = [];
    for (const x of r) {
      const eng = String(x.engagement_id).slice(0, 8).toUpperCase();
      if (x.paid && String(x.paid) >= from && String(x.paid) <= to) rows.push([String(x.paid), "Received", String(x.client), eng, String(x.kind), aedDecimal(num(x.amount_fils)), (x.provider as string | null) ?? "bank", (x.provider_ref as string | null) ?? "", (x.invoice as string | null) ?? ""]);
      if (x.refunded && String(x.refunded) >= from && String(x.refunded) <= to) rows.push([String(x.refunded), "Refunded", String(x.client), eng, String(x.kind), aedDecimal(-num(x.amount_fils)), (x.provider as string | null) ?? "bank", (x.refund_reference as string | null) ?? "", (x.invoice as string | null) ?? ""]);
    }
  } else if (set === "payouts") {
    header = ["Date", "Partner", "Engagement", "Stage", "Amount AED", "Partner invoice", "Payout run", "Bank reference"];
    const r = (
      await tx.query<Record<string, unknown>>(
        `select gulf(p.released_at)::text as d, o.name as partner, p.engagement_id, p.stage, p.amount_fils, pi.number as invoice, r.reference as run, r.bank_reference
         from payouts p join orgs o on o.id = p.partner_org_id left join partner_invoices pi on pi.payout_id = p.id left join payout_runs r on r.id = p.run_id
         where p.status = 'released' and gulf(p.released_at) >= $1::date and gulf(p.released_at) <= $2::date order by p.released_at, o.name`,
        [from, toExcl],
      )
    ).rows;
    rows = r.map((x) => [String(x.d), String(x.partner), String(x.engagement_id).slice(0, 8).toUpperCase(), String(x.stage), aedDecimal(num(x.amount_fils)), (x.invoice as string | null) ?? "", (x.run as string | null) ?? "", (x.bank_reference as string | null) ?? ""]);
  } else {
    header = ["Accepted", "Client", "Engagement", "Offer tier", "Service", "Qty", "Client price AED", "Partner cost AED", "Margin AED", "Margin %"];
    const r = (
      await tx.query<Record<string, unknown>>(
        `select gulf(o.accepted_at)::text as d, c.name as client, e.id as engagement_id, o.tier, l.code, d.name, l.qty, l.client_unit_fils, l.partner_unit_fils, l.margin_unit_fils
         from offers o join orgs c on c.id = o.client_org_id join engagements e on e.offer_id = o.id join offer_lines l on l.offer_id = o.id join deliverables d on d.code = l.code
         where gulf(o.accepted_at) >= $1::date and gulf(o.accepted_at) <= $2::date order by o.accepted_at, l.code`,
        [from, toExcl],
      )
    ).rows;
    rows = r.map((x) => {
      const price = num(x.qty) * num(x.client_unit_fils);
      const margin = num(x.qty) * num(x.margin_unit_fils);
      return [String(x.d), String(x.client), String(x.engagement_id).slice(0, 8).toUpperCase(), String(x.tier), `${String(x.name)} (${String(x.code)})`, num(x.qty), aedDecimal(price), aedDecimal(num(x.qty) * num(x.partner_unit_fils)), aedDecimal(margin), price === 0 ? "0.00" : ((margin * 100) / price).toFixed(2)];
    });
  }
  const csv = [csvLine(header), ...rows.map(csvLine)].join("\r\n") + "\r\n";
  await tx.query("insert into accounting_exports (set_name, from_date, to_date, rows, exported_by) values ($1,$2,$3,$4,$5)", [set, from, to, rows.length, actor.id]);
  await audit(tx, actor, "accounting.exported", "accounting_export", null, { set, from, to, rows: rows.length });
  return { csv, fileName: `tasees-${set}-${from}-to-${to}.csv`, rows: rows.length };
}

export async function exportLog(tx: Queryable) {
  return (await tx.query<{ id: string; set_name: string; from_date: string; to_date: string; rows: number; exported_at: string; exported_by: string }>("select e.id, e.set_name, e.from_date::text as from_date, e.to_date::text as to_date, e.rows, e.exported_at, u.name as exported_by from accounting_exports e join users u on u.id = e.exported_by order by e.exported_at desc, e.id desc limit 50")).rows.map((r) => ({ id: r.id, setName: r.set_name, fromDate: r.from_date, toDate: r.to_date, rows: num(r.rows), exportedAt: r.exported_at, exportedBy: r.exported_by }));
}

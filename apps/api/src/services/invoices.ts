import { applyBp, DEFAULT_SETTINGS, splitByShares } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { col, textPdf } from "../lib/pdf.ts";
import type { Storage } from "../lib/storage.ts";
import type { Notifier } from "../lib/notify.ts";

/**
 * Tax invoices and credit notes (O3). One tax invoice per client payment, issued when the money is recorded,
 * numbered gap-free per year, with MKW's TRN; a full refund produces a credit note that reverses it. Until the
 * founder enters MKW's TRN, invoices are held as `pending_trn` and issued in one go afterwards: no document
 * without a TRN ever reaches a client. Government fees are passed through at cost as disbursements with no VAT;
 * that treatment is recorded as UNCERTAIN in settings until the tax adviser confirms it.
 */

export interface Company {
  legalName: string;
  trn: string | null;
  address: string;
  bankName: string;
  iban: string;
  swift: string;
  govFeesAsDisbursements: { value: boolean; confidence: "UNCERTAIN" | "verified"; basis: string };
}

export async function loadCompany(tx: Queryable): Promise<Company> {
  const r = await tx.query<{ value: Company }>("select value from settings where key = 'company'");
  if (!r.rows[0]) throw notFound("Company settings not found");
  return r.rows[0].value;
}

export async function updateCompany(tx: Queryable, actor: SessionUser, patch: Partial<Pick<Company, "legalName" | "trn" | "address" | "bankName" | "iban" | "swift">> & { govFeesConfirmed?: boolean }, note: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder changes company details");
  const before = await loadCompany(tx);
  const trn = patch.trn === undefined ? before.trn : patch.trn?.trim() || null;
  if (trn && !/^\d{15}$/.test(trn)) throw badRequest("A UAE TRN is 15 digits");
  const after: Company = {
    ...before,
    ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "govFeesConfirmed" && k !== "trn")),
    trn,
    govFeesAsDisbursements: patch.govFeesConfirmed ? { ...before.govFeesAsDisbursements, confidence: "verified" } : before.govFeesAsDisbursements,
  };
  await tx.query("update settings set value = $1 where key = 'company'", [JSON.stringify(after)]);
  await audit(tx, actor, "settings.company_changed", "settings", "company", { before: { ...before, iban: before.iban ? "set" : "" }, after: { ...after, iban: after.iban ? "set" : "" }, note });
  return after;
}

const fmt = (fils: number) => ((fils === 0 ? 0 : fils) / 100).toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function nextNumber(tx: Queryable, kind: "tax_invoice" | "credit_note", year: number): Promise<string> {
  // The counter row is locked for the rest of the transaction, so two payments recorded at once cannot share a number.
  await tx.query("insert into invoice_counters (kind, year, last) values ($1, $2, 0) on conflict do nothing", [kind, year]);
  const r = await tx.query<{ last: number }>("update invoice_counters set last = last + 1 where kind = $1 and year = $2 returning last", [kind, year]);
  const n = num(r.rows[0]!.last);
  return `${kind === "tax_invoice" ? "TI" : "CN"}-${year}-${String(n).padStart(6, "0")}`;
}

interface InvoiceLine {
  description: string;
  netFils: number;
  vatBp: number;
  vatFils: number;
  grossFils: number;
  kind: "fee" | "disbursement";
}

/**
 * The lines a client payment pays for. The payment amount is authoritative (it came from the payment plan):
 * government fees are taken off at cost as disbursements, the rest is fees including VAT, split into net and VAT
 * for the whole payment and then shared across the lines in proportion to their fees, so every total adds up to
 * the fils and VAT is 5% of net on the invoice as a whole.
 */
async function paymentLines(tx: Queryable, payment: Record<string, unknown>): Promise<InvoiceLine[]> {
  const engagementId = String(payment.engagement_id);
  const kind = String(payment.kind);
  const amount = num(payment.amount_fils);
  const vatBp = DEFAULT_SETTINGS.vatBp;
  const splitNetVat = (gross: number) => {
    const net = Math.round((gross * 10_000) / (10_000 + vatBp));
    return { net, vat: gross - net };
  };
  if (kind === "change_order") {
    const { net, vat } = splitNetVat(amount);
    return [{ description: "Approved change to scope", netFils: net, vatBp, vatFils: vat, grossFils: amount, kind: "fee" }];
  }
  const lines = (
    await tx.query<Record<string, unknown>>(
      `select l.code, d.name, l.qty, l.client_unit_fils, l.gov_unit_fils, o.mkw_fee_unit_fils
       from engagement_lines l join deliverables d on d.code = l.code
       join engagements e on e.id = l.engagement_id join offer_lines o on o.offer_id = e.offer_id and o.code = l.code
       where l.engagement_id = $1 order by l.code`,
      [engagementId],
    )
  ).rows;
  const out: InvoiceLine[] = [];
  let gov = 0;
  if (kind === "deposit") {
    for (const l of lines) {
      const g = num(l.gov_unit_fils) * num(l.qty);
      if (g > 0) {
        out.push({ description: `Government fees, ${String(l.name)} (at cost, disbursement)`, netFils: g, vatBp: 0, vatFils: 0, grossFils: g, kind: "disbursement" });
        gov += g;
      }
    }
  }
  const feesGross = amount - gov;
  if (feesGross < 0) throw conflict("Payment is smaller than the government fees it should carry");
  const { net, vat } = splitNetVat(feesGross);
  const weights = lines.map((l) => (num(l.client_unit_fils) + num(l.mkw_fee_unit_fils)) * num(l.qty));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const shares = totalWeight > 0 ? weights.map((w) => Math.round((w * 10_000) / totalWeight)) : lines.map(() => 0);
  if (totalWeight > 0) {
    // Rounded shares may miss 10000 by a point or two: the largest line absorbs the difference.
    const drift = 10_000 - shares.reduce((s, w) => s + w, 0);
    const biggest = shares.indexOf(Math.max(...shares));
    shares[biggest] = (shares[biggest] ?? 0) + drift;
  }
  // Largest-remainder split keeps every part a whole number of fils and the parts summing to the whole.
  const nets = totalWeight > 0 ? splitByShares(net, shares) : [];
  const vats = totalWeight > 0 ? splitByShares(vat, shares) : [];
  const fees: InvoiceLine[] = lines.map((l, i) => ({
    description: `${String(l.name)}${num(l.qty) > 1 ? ` x${num(l.qty)}` : ""} (${kind === "deposit" ? "50% on acceptance" : "50% on completion"})`,
    netFils: nets[i] ?? 0,
    vatBp,
    vatFils: vats[i] ?? 0,
    grossFils: (nets[i] ?? 0) + (vats[i] ?? 0),
    kind: "fee",
  }));
  return [...fees, ...out];
}

/** Issue the tax invoice for a payment that has just been recorded as paid. Held when MKW's TRN is missing. */
export async function issueInvoiceForPayment(tx: Queryable, actor: SessionUser | null, paymentId: string, storage: Storage, notify: Notifier) {
  const payment = (await tx.query<Record<string, unknown>>("select * from payments where id = $1", [paymentId])).rows[0];
  if (!payment) throw notFound("Payment not found");
  if (payment.status !== "paid") throw conflict("Only a paid payment is invoiced");
  const existing = await tx.query("select 1 from invoices where payment_id = $1 and kind = 'tax_invoice'", [paymentId]);
  if (existing.rows.length) return { issued: false, reason: "already invoiced" };
  const company = await loadCompany(tx);
  const client = (await tx.query<{ name: string; profile: Record<string, unknown> }>("select name, profile from orgs where id = $1", [String(payment.client_org_id)])).rows[0]!;
  const lines = await paymentLines(tx, payment);
  const net = lines.filter((l) => l.kind === "fee").reduce((s, l) => s + l.netFils, 0);
  const vat = lines.reduce((s, l) => s + l.vatFils, 0);
  const disb = lines.filter((l) => l.kind === "disbursement").reduce((s, l) => s + l.netFils, 0);
  const gross = net + vat + disb;
  const seller = { legalName: company.legalName, trn: company.trn, address: company.address };
  const buyer = { name: client.name, trn: (client.profile?.trn as string | undefined) ?? null };
  const held = !company.trn;
  const year = Number((await tx.query<{ y: number }>("select extract(year from app_now())::int as y")).rows[0]!.y);
  const number = held ? null : await nextNumber(tx, "tax_invoice", year);
  const row = (
    await tx.query<{ id: string }>(
      `insert into invoices (kind, number, status, payment_id, engagement_id, client_org_id, issued_at, seller, buyer, lines, net_fils, vat_fils, disbursements_fils, gross_fils)
       values ('tax_invoice', $1, $2, $3, $4, $5, case when $2 = 'issued' then app_now() end, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [number, held ? "pending_trn" : "issued", paymentId, String(payment.engagement_id), String(payment.client_org_id), JSON.stringify(seller), JSON.stringify(buyer), JSON.stringify(lines), net, vat, disb, gross],
    )
  ).rows[0]!;
  if (!held) await renderAndStore(tx, row.id, storage);
  await audit(tx, actor, held ? "invoice.held_no_trn" : "invoice.issued", "invoice", row.id, { number, paymentId, net, vat, disbursements: disb, gross });
  if (!held) {
    const owners = (await tx.query<{ email: string }>("select email from users where org_id = $1 and role = 'client_owner' and status = 'active'", [String(payment.client_org_id)])).rows;
    for (const u of owners) await notify.send({ to: u.email, channel: "email", template: "invoice_issued", vars: { number: number!, amountFils: gross, invoiceId: row.id, engagementId: String(payment.engagement_id) } });
  }
  return { issued: !held, id: row.id, number };
}

/** After the founder enters the TRN: number and issue every held invoice, oldest first. A person's action. */
export async function issueHeldInvoices(tx: Queryable, actor: SessionUser, storage: Storage, notify: Notifier) {
  if (actor.role !== "founder") throw forbidden("Only the founder issues held invoices");
  const company = await loadCompany(tx);
  if (!company.trn) throw conflict("Enter MKW's TRN first");
  // Tax invoices first (oldest first), then credit notes, so a credit note always follows the invoice it reverses.
  const held = (
    await tx.query<{ id: string; kind: "tax_invoice" | "credit_note"; client_org_id: string; engagement_id: string; gross_fils: number }>(
      "select id, kind, client_org_id, engagement_id, gross_fils from invoices where status = 'pending_trn' order by case kind when 'tax_invoice' then 0 else 1 end, created_at, id",
    )
  ).rows;
  const year = Number((await tx.query<{ y: number }>("select extract(year from app_now())::int as y")).rows[0]!.y);
  const issued: string[] = [];
  for (const inv of held) {
    const number = await nextNumber(tx, inv.kind, year);
    await tx.query("update invoices set number = $2, status = 'issued', issued_at = app_now(), seller = seller || $3::jsonb where id = $1", [inv.id, number, JSON.stringify({ trn: company.trn, legalName: company.legalName, address: company.address })]);
    await renderAndStore(tx, inv.id, storage);
    await audit(tx, actor, inv.kind === "credit_note" ? "credit_note.issued" : "invoice.issued", "invoice", inv.id, { number, heldUntilTrn: true });
    const owners = (await tx.query<{ email: string }>("select email from users where org_id = $1 and role = 'client_owner' and status = 'active'", [inv.client_org_id])).rows;
    for (const u of owners) await notify.send({ to: u.email, channel: "email", template: "invoice_issued", vars: { number, amountFils: Math.abs(num(inv.gross_fils)), invoiceId: inv.id, engagementId: inv.engagement_id, ...(inv.kind === "credit_note" ? { creditNote: 1 } : {}) } });
    issued.push(number);
  }
  return { issued };
}

/** Finance records a full refund of a paid payment: the payment is refunded and a credit note reverses the invoice. */
export async function refundPayment(tx: Queryable, actor: SessionUser, paymentId: string, reference: string, reason: string, storage: Storage, notify: Notifier) {
  if (!["finance", "founder"].includes(actor.role)) throw forbidden("Only finance records refunds");
  const payment = (await tx.query<Record<string, unknown>>("select * from payments where id = $1", [paymentId])).rows[0];
  if (!payment) throw notFound("Payment not found");
  if (payment.status !== "paid") throw conflict("Only a paid payment can be refunded");
  const released = await tx.query("select 1 from payouts where engagement_id = $1 and status = 'released'", [String(payment.engagement_id)]);
  if (released.rows.length) throw conflict("Partner payouts on this engagement have been released; settle those before refunding the client");
  const inRun = await tx.query("select 1 from payouts p join payout_runs r on r.id = p.run_id where p.engagement_id = $1 and r.status in ('open', 'exported')", [String(payment.engagement_id)]);
  if (inRun.rows.length) throw conflict("A payout on this engagement is in an open payout run; cancel the run before refunding the client");
  const inv = (await tx.query<Record<string, unknown>>("select * from invoices where payment_id = $1 and kind = 'tax_invoice' order by created_at desc limit 1", [paymentId])).rows[0];
  await tx.query("update payments set status = 'refunded', refunded_at = app_now(), refund_reference = $2 where id = $1", [paymentId, reference]);
  // Money the client has paid back is no longer "received": payouts not yet released lose their eligibility.
  await tx.query("update payouts set status = 'withheld' where engagement_id = $1 and status in ('eligible', 'pending')", [String(payment.engagement_id)]);
  let creditNote: { id: string; number: string | null } | null = null;
  if (inv) {
    const company = await loadCompany(tx);
    const year = Number((await tx.query<{ y: number }>("select extract(year from app_now())::int as y")).rows[0]!.y);
    const held = inv.status !== "issued" || !company.trn;
    const number = held ? null : await nextNumber(tx, "credit_note", year);
    const row = (
      await tx.query<{ id: string }>(
        `insert into invoices (kind, number, status, payment_id, engagement_id, client_org_id, reverses_invoice_id, issued_at, seller, buyer, lines, net_fils, vat_fils, disbursements_fils, gross_fils)
         values ('credit_note', $1, $2, $3, $4, $5, $6, case when $2 = 'issued' then app_now() end, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [number, held ? "pending_trn" : "issued", paymentId, String(payment.engagement_id), String(payment.client_org_id), String(inv.id), JSON.stringify(inv.seller), JSON.stringify(inv.buyer), JSON.stringify(inv.lines), -num(inv.net_fils), -num(inv.vat_fils), -num(inv.disbursements_fils), -num(inv.gross_fils)],
      )
    ).rows[0]!;
    if (!held) await renderAndStore(tx, row.id, storage);
    creditNote = { id: row.id, number };
  }
  await audit(tx, actor, "payment.refunded", "payment", paymentId, { amount: num(payment.amount_fils), reference, reason, creditNote });
  const owners = (await tx.query<{ email: string }>("select email from users where org_id = $1 and role = 'client_owner' and status = 'active'", [String(payment.client_org_id)])).rows;
  if (creditNote?.number) for (const u of owners) await notify.send({ to: u.email, channel: "email", template: "invoice_issued", vars: { number: creditNote.number, amountFils: num(payment.amount_fils), invoiceId: creditNote.id, engagementId: String(payment.engagement_id), creditNote: 1 } });
  return { ok: true, creditNote };
}

async function renderAndStore(tx: Queryable, invoiceId: string, storage: Storage) {
  const inv = (
    await tx.query<Record<string, unknown>>(
      "select i.*, r.number as reverses_number from invoices i left join invoices r on r.id = i.reverses_invoice_id where i.id = $1",
      [invoiceId],
    )
  ).rows[0]!;
  const pdf = textPdf(invoiceText(inv), `${inv.kind === "credit_note" ? "Credit note" : "Tax invoice"} ${String(inv.number)}`);
  const key = await storage.put(String(inv.engagement_id), `${String(inv.number)}.pdf`, pdf);
  await tx.query("update invoices set file_key = $2 where id = $1", [invoiceId, key]);
}

export function invoiceText(inv: Record<string, unknown>): string[] {
  const seller = inv.seller as { legalName: string; trn: string | null; address: string };
  const buyer = inv.buyer as { name: string; trn: string | null };
  const lines = inv.lines as InvoiceLine[];
  const isCredit = inv.kind === "credit_note";
  const sign = isCredit ? -1 : 1;
  const date = (v: unknown) => (v ? new Date(String(v)).toISOString().slice(0, 10) : "");
  const out: string[] = [
    isCredit ? "CREDIT NOTE" : "TAX INVOICE",
    "",
    `${seller.legalName}`,
    ...(seller.address ? seller.address.split("\n") : []),
    `TRN: ${seller.trn ?? "pending"}`,
    "",
    col(`${isCredit ? "Credit note" : "Invoice"} number: ${String(inv.number ?? "")}`, `Date: ${date(inv.issued_at)}`),
    col(`Date of supply: ${date(inv.supply_date)}`, `Currency: ${String(inv.currency)}`),
    ...(isCredit && inv.reverses_invoice_id ? [`Reverses tax invoice ${String((inv as { reverses_number?: string }).reverses_number ?? "")}`.trimEnd()] : []),
    "",
    `Bill to: ${buyer.name}`,
    `Customer TRN: ${buyer.trn ?? "not registered / not provided"}`,
    "",
    col("Description", "Net AED     VAT %   VAT AED      Total AED"),
    "-".repeat(78),
  ];
  for (const l of lines) {
    const desc = l.description.length > 34 ? l.description.slice(0, 31) + "..." : l.description;
    out.push(col(desc, `${fmt(sign * l.netFils).padStart(10)} ${l.kind === "disbursement" ? "   n/a" : `${(l.vatBp / 100).toFixed(0).padStart(5)}%`} ${fmt(l.vatFils === 0 ? 0 : sign * l.vatFils).padStart(9)} ${fmt(sign * l.grossFils).padStart(13)}`));
  }
  out.push("-".repeat(78));
  out.push(col("Total fees (net of VAT)", `AED ${fmt(num(inv.net_fils))}`));
  out.push(col("VAT at 5%", `AED ${fmt(num(inv.vat_fils))}`));
  if (num(inv.disbursements_fils) !== 0) out.push(col("Government fees passed through at cost (disbursements, no VAT)", `AED ${fmt(num(inv.disbursements_fils))}`));
  out.push(col(isCredit ? "TOTAL CREDITED" : "TOTAL", `AED ${fmt(num(inv.gross_fils))}`));
  out.push("");
  out.push(isCredit ? "This credit note reverses the tax invoice named above in full." : "Paid. Thank you. Tasees is a service of MKW Advisors.");
  return out;
}

/** Statement of account for one client: payments, invoices, credit notes and what is still due. */
export async function statement(tx: Queryable, clientOrgId: string) {
  const payments = (await tx.query<Record<string, unknown>>("select id, engagement_id, kind, amount_fils, status, paid_at, refunded_at, pay_url, created_at from payments where client_org_id = $1 order by created_at", [clientOrgId])).rows;
  const invoices = (await tx.query<Record<string, unknown>>("select id, kind, number, status, payment_id, engagement_id, issued_at, gross_fils, net_fils, vat_fils, disbursements_fils from invoices where client_org_id = $1 and status = 'issued' order by issued_at", [clientOrgId])).rows;
  const due = payments.filter((p) => p.status === "pending").reduce((s, p) => s + num(p.amount_fils), 0);
  const paid = payments.filter((p) => p.status === "paid").reduce((s, p) => s + num(p.amount_fils), 0);
  return {
    payments: payments.map((p) => ({ id: p.id, engagementId: p.engagement_id, kind: p.kind, amount: num(p.amount_fils), status: p.status, paidAt: p.paid_at, refundedAt: p.refunded_at, payUrl: p.pay_url, createdAt: p.created_at })),
    invoices: invoices.map((i) => ({ id: i.id, kind: i.kind, number: i.number, paymentId: i.payment_id, engagementId: i.engagement_id, issuedAt: i.issued_at, gross: num(i.gross_fils), net: num(i.net_fils), vat: num(i.vat_fils), disbursements: num(i.disbursements_fils) })),
    totals: { paid, due, invoiced: invoices.reduce((s, i) => s + num(i.gross_fils), 0) },
  };
}

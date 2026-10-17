import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import type { Notifier } from "../lib/notify.ts";
import type { Storage } from "../lib/storage.ts";

/**
 * Partner invoices and payout runs (O3). A payout becomes payable only when the partner has uploaded its invoice
 * for it; finance batches payable payouts into a run, downloads one bank bulk-transfer file, pays it at the bank
 * and marks the run paid, which releases every payout in it. Each step is a person's action and is audited.
 */

export interface BankDetails {
  beneficiary: string;
  iban: string;
  bank: string;
}

const ibanOk = (iban: string) => /^AE\d{21}$/.test(iban.replace(/\s+/g, "").toUpperCase());

export async function setPartnerBank(tx: Queryable, actor: SessionUser, bank: BankDetails) {
  if (actor.role !== "partner_admin") throw forbidden("Only a partner admin changes bank details");
  const iban = bank.iban.replace(/\s+/g, "").toUpperCase();
  if (!ibanOk(iban)) throw badRequest("Give a UAE IBAN: AE followed by 21 digits");
  if (bank.beneficiary.trim().length < 2) throw badRequest("Give the account name as the bank has it");
  const stored = { beneficiary: bank.beneficiary.trim(), iban, bank: bank.bank.trim() };
  await tx.query("update orgs set profile = profile || jsonb_build_object('bank', $2::jsonb) where id = $1 and type = 'partner'", [actor.orgId, JSON.stringify(stored)]);
  // The IBAN itself is a bank detail, not an audit fact: record the change and the last four digits only.
  await audit(tx, actor, "partner.bank_changed", "org", actor.orgId, { beneficiary: stored.beneficiary, bank: stored.bank, ibanEnding: iban.slice(-4) });
  return { ok: true };
}

export interface PartnerInvoiceInput {
  payoutId: string;
  number: string;
  amountFils: number;
  vatFils: number;
  fileName: string;
  content: Buffer;
}

/** The partner's invoice to MKW for one payout. The amount must equal the payout; VAT is the partner's own. */
export async function uploadPartnerInvoice(tx: Queryable, actor: SessionUser, input: PartnerInvoiceInput, storage: Storage) {
  if (actor.role !== "partner_admin") throw forbidden("Only a partner admin uploads invoices");
  const p = (await tx.query<Record<string, unknown>>("select * from payouts where id = $1 and partner_org_id = $2", [input.payoutId, actor.orgId])).rows[0];
  if (!p) throw notFound("Payout not found");
  if (!["eligible", "pending"].includes(String(p.status))) throw conflict(`This payout is ${String(p.status)}`);
  if (!input.number.trim()) throw badRequest("Give your invoice number");
  if (input.amountFils !== num(p.amount_fils)) throw badRequest(`Your invoice must be for the payout amount, AED ${(num(p.amount_fils) / 100).toFixed(2)} before VAT`);
  if (!Number.isInteger(input.vatFils) || input.vatFils < 0) throw badRequest("VAT must be zero or more");
  const existing = await tx.query("select 1 from partner_invoices where payout_id = $1", [input.payoutId]);
  if (existing.rows.length) throw conflict("An invoice has already been uploaded for this payout");
  const key = await storage.put(String(p.engagement_id), input.fileName, input.content);
  const row = (
    await tx.query<{ id: string }>(
      `insert into partner_invoices (payout_id, partner_org_id, number, amount_fils, vat_fils, file_key, file_name, uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [input.payoutId, actor.orgId, input.number.trim(), input.amountFils, input.vatFils, key, input.fileName, actor.id],
    )
  ).rows[0]!;
  await audit(tx, actor, "partner_invoice.uploaded", "payout", input.payoutId, { invoiceId: row.id, number: input.number.trim(), amount: input.amountFils, vat: input.vatFils });
  return { id: row.id };
}

/** Eligible payouts that have an invoice and are not in a run yet, with the partner's bank details. */
export async function payablePayouts(tx: Queryable) {
  const r = await tx.query<Record<string, unknown>>(
    `select p.id, p.engagement_id, p.partner_org_id, p.stage, p.amount_fils, o.name as partner, o.profile->'bank' as bank,
       pi.number as invoice_number, pi.vat_fils as invoice_vat_fils
     from payouts p join orgs o on o.id = p.partner_org_id left join partner_invoices pi on pi.payout_id = p.id
     where p.status = 'eligible' and p.run_id is null order by o.name, p.engagement_id, p.stage`,
  );
  return r.rows.map((p) => ({
    id: p.id,
    engagementId: p.engagement_id,
    partnerId: p.partner_org_id,
    partner: p.partner,
    stage: p.stage,
    amount: num(p.amount_fils),
    invoiceNumber: p.invoice_number ?? null,
    invoiceVat: p.invoice_vat_fils === null || p.invoice_vat_fils === undefined ? null : num(p.invoice_vat_fils),
    bank: (p.bank as BankDetails | null) ?? null,
    payable: !!p.invoice_number && !!(p.bank as BankDetails | null)?.iban,
    blocked: !p.invoice_number ? "no partner invoice" : !(p.bank as BankDetails | null)?.iban ? "no bank details" : null,
  }));
}

/** Finance opens a run with every payable payout. The total paid to a partner never exceeds its payouts' amounts plus its own VAT. */
export async function createPayoutRun(tx: Queryable, actor: SessionUser) {
  if (!["finance", "founder"].includes(actor.role)) throw forbidden("Only finance runs payouts");
  const open = await tx.query("select 1 from payout_runs where status in ('open', 'exported')");
  if (open.rows.length) throw conflict("Finish or cancel the open payout run first");
  const payable = (await payablePayouts(tx)).filter((p) => p.payable);
  if (!payable.length) throw conflict("No payouts are ready: each needs the partner's invoice and bank details");
  const seq = (await tx.query<{ n: number }>("select count(*)::int + 1 as n from payout_runs")).rows[0]!.n;
  const year = (await tx.query<{ y: number }>("select extract(year from app_now())::int as y")).rows[0]!.y;
  const reference = `PR-${year}-${String(seq).padStart(4, "0")}`;
  const total = payable.reduce((s, p) => s + p.amount + (p.invoiceVat ?? 0), 0);
  const run = (
    await tx.query<{ id: string }>("insert into payout_runs (reference, total_fils, payouts, created_by) values ($1,$2,$3,$4) returning id", [reference, total, payable.length, actor.id])
  ).rows[0]!;
  await tx.query("update payouts set run_id = $1 where id = any($2::uuid[])", [run.id, payable.map((p) => p.id)]);
  await audit(tx, actor, "payout_run.created", "payout_run", run.id, { reference, total, payouts: payable.map((p) => p.id) });
  return { id: run.id, reference, total, payouts: payable.length };
}

/** One bank bulk-transfer file: one row per partner, amounts summed. Generic columns until the bank's sample arrives. */
export async function exportPayoutRun(tx: Queryable, actor: SessionUser, runId: string, storage: Storage): Promise<{ csv: string; fileName: string }> {
  if (!["finance", "founder"].includes(actor.role)) throw forbidden("Only finance exports payout runs");
  const run = (await tx.query<Record<string, unknown>>("select * from payout_runs where id = $1", [runId])).rows[0];
  if (!run) throw notFound("Payout run not found");
  if (!["open", "exported"].includes(String(run.status))) throw conflict(`This run is ${String(run.status)}`);
  const rows = (
    await tx.query<Record<string, unknown>>(
      `select o.id, o.name, o.profile->'bank' as bank, sum(p.amount_fils + coalesce(pi.vat_fils, 0))::bigint as total, count(*)::int as n, string_agg(pi.number, ' ') as invoices
       from payouts p join orgs o on o.id = p.partner_org_id left join partner_invoices pi on pi.payout_id = p.id
       where p.run_id = $1 group by o.id, o.name, o.profile->'bank' order by o.name`,
      [runId],
    )
  ).rows;
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["Beneficiary name,IBAN,Bank,Amount AED,Currency,Payment reference,Payment details"];
  for (const r of rows) {
    const bank = r.bank as BankDetails;
    lines.push([esc(bank.beneficiary), esc(bank.iban), esc(bank.bank), (num(r.total) / 100).toFixed(2), "AED", esc(`${String(run.reference)}`), esc(`MKW Advisors payouts: ${String(r.invoices)}`)].join(","));
  }
  const csv = lines.join("\r\n") + "\r\n";
  const fileName = `${String(run.reference)}.csv`;
  const key = await storage.put(String(run.id), fileName, Buffer.from(csv, "utf8"));
  await tx.query("update payout_runs set status = 'exported', exported_at = coalesce(exported_at, app_now()), file_key = $2 where id = $1", [runId, key]);
  await audit(tx, actor, "payout_run.exported", "payout_run", runId, { fileName, partners: rows.length, total: num(run.total_fils) });
  return { csv, fileName };
}

/** Finance confirms the bank has paid the file: every payout in the run is released, and each partner gets a remittance advice. */
export async function markPayoutRunPaid(tx: Queryable, actor: SessionUser, runId: string, bankReference: string, notify: Notifier) {
  if (!["finance", "founder"].includes(actor.role)) throw forbidden("Only finance marks payout runs paid");
  if (bankReference.trim().length < 3) throw badRequest("Give the bank's reference for the transfer");
  const run = (await tx.query<Record<string, unknown>>("select * from payout_runs where id = $1", [runId])).rows[0];
  if (!run) throw notFound("Payout run not found");
  if (run.status !== "exported") throw conflict(run.status === "paid" ? "This run is already paid" : "Export the bank file before marking the run paid");
  const payouts = (await tx.query<Record<string, unknown>>("select id, partner_org_id, amount_fils from payouts where run_id = $1 and status = 'eligible'", [runId])).rows;
  await tx.query("update payouts set status = 'released', released_at = app_now(), released_by = $2 where run_id = $1 and status = 'eligible'", [runId, actor.id]);
  await tx.query("update payout_runs set status = 'paid', paid_at = app_now(), bank_reference = $2 where id = $1", [runId, bankReference.trim()]);
  await audit(tx, actor, "payout_run.paid", "payout_run", runId, { bankReference: bankReference.trim(), payouts: payouts.map((p) => p.id), total: num(run.total_fils) });
  for (const p of payouts) await audit(tx, actor, "payout.released", "payout", String(p.id), { amount: num(p.amount_fils), runId });
  const byPartner = new Map<string, { total: number; count: number }>();
  for (const p of payouts) {
    const cur = byPartner.get(String(p.partner_org_id)) ?? { total: 0, count: 0 };
    byPartner.set(String(p.partner_org_id), { total: cur.total + num(p.amount_fils), count: cur.count + 1 });
  }
  for (const [orgId, agg] of byPartner) {
    const admins = (await tx.query<{ email: string }>("select email from users where org_id = $1 and role = 'partner_admin' and status = 'active' order by email limit 3", [orgId])).rows;
    for (const u of admins) await notify.send({ to: u.email, channel: "email", template: "payout_remittance", vars: { amountFils: agg.total, count: agg.count, runReference: String(run.reference), bankReference: bankReference.trim() } });
  }
  return { ok: true, released: payouts.length };
}

export async function cancelPayoutRun(tx: Queryable, actor: SessionUser, runId: string, reason: string) {
  if (!["finance", "founder"].includes(actor.role)) throw forbidden("Only finance cancels payout runs");
  const run = (await tx.query<Record<string, unknown>>("select status from payout_runs where id = $1", [runId])).rows[0];
  if (!run) throw notFound("Payout run not found");
  if (run.status === "paid") throw conflict("A paid run cannot be cancelled");
  await tx.query("update payouts set run_id = null where run_id = $1", [runId]);
  await tx.query("update payout_runs set status = 'cancelled' where id = $1", [runId]);
  await audit(tx, actor, "payout_run.cancelled", "payout_run", runId, { reason });
  return { ok: true };
}

export async function listPayoutRuns(tx: Queryable) {
  const r = await tx.query<Record<string, unknown>>(
    `select r.*, u.name as created_by_name from payout_runs r left join users u on u.id = r.created_by order by r.created_at desc limit 50`,
  );
  return r.rows.map((x) => ({
    id: x.id,
    reference: x.reference,
    status: x.status,
    total: num(x.total_fils),
    payouts: num(x.payouts),
    createdBy: x.created_by_name,
    createdAt: x.created_at,
    exportedAt: x.exported_at,
    paidAt: x.paid_at,
    bankReference: x.bank_reference,
  }));
}

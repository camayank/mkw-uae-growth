import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { signWebhook } from "../src/lib/payments.ts";
import { textPdf } from "../src/lib/pdf.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/** O3: payment links, the signed webhook, tax invoices, credit notes, statements, partner invoices and payout runs. */

async function engagementWithDeposit(env: TestEnv, answers: Record<string, unknown> = { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 }) {
  const req = await env.call("client", "POST", "/api/requests", { answers });
  const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
  const offerId = built.body.offerIds[0];
  await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
  const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId as string;
  const eng = await env.call("finance", "GET", `/api/engagements/${engagementId}`);
  const deposit = eng.body.payments.find((p: any) => p.kind === "deposit");
  return { engagementId, deposit, offerId };
}

const webhook = (env: TestEnv, body: Record<string, unknown>, secret = "test-secret", at = env.clock.now) => {
  const raw = JSON.stringify(body);
  const sig = signWebhook(secret, raw, Math.floor(at.getTime() / 1000));
  return env.app.inject({ method: "POST", url: "/api/webhooks/payments", headers: { "content-type": "application/json", "x-webhook-timestamp": sig.timestamp, "x-webhook-signature": sig.signature }, payload: raw });
};

describe("payment links and the signed webhook", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("creates a card link on acceptance and tells the client about it", async () => {
    const { engagementId, deposit } = await engagementWithDeposit(env);
    expect(deposit.payUrl).toBe(`https://app.test/#/pay/${deposit.id}`);
    expect(env.provider.links).toHaveLength(1);
    const client = await env.call("client", "GET", `/api/engagements/${engagementId}`);
    expect(client.body.payments.find((p: any) => p.kind === "deposit").payUrl).toContain("/pay/");
    const email = env.emails.find((e) => e.subject.startsWith("Deposit of"))!;
    expect(email.text).toContain(deposit.payUrl);
    expect(email.text).toContain(engagementId.slice(0, 8).toUpperCase());
  });

  it("refuses an unsigned, mis-signed, stale, tampered or short-paid webhook and changes nothing", async () => {
    const { deposit } = await engagementWithDeposit(env);
    const good = { kind: "payment.paid", paymentId: deposit.id, amountFils: deposit.amount, reference: "PSP-1" };
    expect((await env.call("anon", "POST", "/api/webhooks/payments", good)).status).toBe(401);
    expect((await webhook(env, good, "wrong-secret")).statusCode).toBe(401);
    expect((await webhook(env, good, "test-secret", new Date(env.clock.now.getTime() - 6 * 60_000))).statusCode).toBe(401);
    // Signed body, then tampered: the signature covers the bytes as sent.
    const raw = JSON.stringify(good);
    const sig = signWebhook("test-secret", raw, Math.floor(env.clock.now.getTime() / 1000));
    const tampered = await env.app.inject({
      method: "POST",
      url: "/api/webhooks/payments",
      headers: { "content-type": "application/json", "x-webhook-timestamp": sig.timestamp, "x-webhook-signature": sig.signature },
      payload: raw.replace(`"amountFils":${deposit.amount}`, `"amountFils":1`),
    });
    expect(tampered.statusCode).toBe(401);
    const short = await webhook(env, { ...good, amountFils: deposit.amount - 100 });
    expect(short.statusCode).toBe(409);
    const still = await env.call("finance", "GET", `/api/engagements/${deposit.engagementId ?? ""}`).catch(() => null);
    void still;
    const row = await asPlatform(env.db, null, (tx) => tx.query<any>("select status from payments where id = $1", [deposit.id]));
    expect(row.rows[0].status).toBe("pending");
    const rejected = await asPlatform(env.db, null, (tx) => tx.query<any>("select count(*)::int as n from audit_events where action = 'webhook.rejected'"));
    expect(rejected.rows[0].n).toBeGreaterThanOrEqual(4);
    expect((await webhook(env, good)).statusCode).toBe(200);
    expect((await webhook(env, good)).statusCode).toBe(200); // replay within the window is idempotent
    const paid = await asPlatform(env.db, null, (tx) => tx.query<any>("select status, provider_ref from payments where id = $1", [deposit.id]));
    expect(paid.rows[0]).toMatchObject({ status: "paid", provider_ref: "PSP-1" });
  });
});

describe("tax invoices, credit notes and statements", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("holds invoices while MKW's TRN is missing, then issues them in sequence once it is entered", async () => {
    const first = await engagementWithDeposit(env);
    expect((await env.call("finance", "POST", `/api/ops/payments/${first.deposit.id}/mark-paid`, { reference: "TT-1" })).status).toBe(200);
    const held = await asPlatform(env.db, null, (tx) => tx.query<any>("select status, number, gross_fils from invoices"));
    expect(held.rows).toEqual([{ status: "pending_trn", number: null, gross_fils: first.deposit.amount }]);
    expect((await env.call("client", "GET", `/api/engagements/${first.engagementId}`)).body.invoices).toEqual([]); // nothing without a TRN reaches the client
    expect((await env.call("ops", "GET", "/api/admin/company")).body.heldInvoices).toBe(1);
    expect((await env.call("founder", "POST", "/api/admin/invoices/issue-held")).status).toBe(409);
    expect((await env.call("founder", "PUT", "/api/admin/company", { trn: "12345", note: "typo" })).status).toBe(400);
    expect((await env.call("ops", "PUT", "/api/admin/company", { trn: "100123456700003", note: "ops tries" })).status).toBe(403);
    const set = await env.call("founder", "PUT", "/api/admin/company", { trn: "100123456700003", address: "Office 1, Dubai", note: "TRN from the FTA certificate" });
    expect(set.status).toBe(200);
    const second = await engagementWithDeposit(env, { mode: "new_company", jurisdiction: "mainland", emirate: "Dubai", visas: 2 });
    expect((await env.call("finance", "POST", `/api/ops/payments/${second.deposit.id}/mark-paid`, { reference: "TT-2" })).status).toBe(200);
    const issued = await env.call("founder", "POST", "/api/admin/invoices/issue-held");
    expect(issued.body.issued).toEqual(["TI-2026-000002"]); // the live payment took 000001 the moment it was paid
    const all = await asPlatform(env.db, null, (tx) => tx.query<any>("select number, status, payment_id from invoices order by number"));
    expect(all.rows.map((r) => [r.number, r.status])).toEqual([["TI-2026-000001", "issued"], ["TI-2026-000002", "issued"]]);
    expect(all.rows[0].payment_id).toBe(second.deposit.id);
    expect(all.rows[1].payment_id).toBe(first.deposit.id);
  });

  it("lays out fees with VAT and government fees as disbursements, adding up to the payment, in a PDF the client can download", async () => {
    const inv = await asPlatform(env.db, null, (tx) => tx.query<any>("select * from invoices where number = 'TI-2026-000001'"));
    const row = inv.rows[0];
    const lines = row.lines as any[];
    const fees = lines.filter((l) => l.kind === "fee");
    const disb = lines.filter((l) => l.kind === "disbursement");
    expect(fees.length).toBeGreaterThan(0);
    expect(disb.length).toBeGreaterThan(0);
    for (const l of fees) expect(l.vatFils).toBe(Math.round(l.netFils * 0.05));
    for (const l of disb) expect(l.vatFils).toBe(0);
    expect(row.net_fils + row.vat_fils + row.disbursements_fils).toBe(row.gross_fils);
    expect(lines.reduce((s, l) => s + l.grossFils, 0)).toBe(row.gross_fils);
    expect(row.seller.trn).toBe("100123456700003");
    const client = await env.call("client", "GET", `/api/engagements/${row.engagement_id}`);
    expect(client.body.invoices.map((i: any) => i.number)).toEqual(["TI-2026-000001"]);
    const pdf = await env.app.inject({ method: "GET", url: `/api/invoices/${row.id}/pdf`, headers: { authorization: `Bearer ${env.tokens.client}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const body = pdf.rawPayload;
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(body.toString("latin1")).toContain("TAX INVOICE");
    expect(body.toString("latin1")).toContain("100123456700003");
    expect(body.toString("latin1")).toMatch(/%%EOF\s*$/);
    // startxref points at the xref table
    const text = body.toString("latin1");
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    expect((await env.app.inject({ method: "GET", url: `/api/invoices/${row.id}/pdf`, headers: { authorization: `Bearer ${env.tokens.setup}` } })).statusCode).toBe(403);
    expect((await env.app.inject({ method: "GET", url: `/api/invoices/${row.id}/pdf` })).statusCode).toBe(401);
  });

  it("the database shows a client only its own issued invoices, and partners none", async () => {
    const other = await env.call("ops", "POST", "/api/admin/partners", { name: "Other Firm", adminName: "X Y", adminEmail: "x@other.test" });
    void other;
    const client = (await env.call("client", "GET", "/api/me")).body;
    const partner = (await env.call("setup", "GET", "/api/me")).body;
    const mine = await asUser(env.db, client, (tx) => tx.query<any>("select client_org_id, status from invoices"));
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(mine.rows.every((r) => r.client_org_id === client.orgId && r.status === "issued")).toBe(true);
    await expect(asUser(env.db, client, (tx) => tx.query("select file_key from invoices"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select * from invoices"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select * from payout_runs"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, client, (tx) => tx.query("select * from partner_invoices"))).rejects.toThrow(/permission denied/);
    const otherClient = await env.call("ops", "POST", "/api/ops/clients", { company: "Second Co", ownerName: "Someone", ownerEmail: "owner@second.test" });
    const otherUser = { ...client, orgId: otherClient.body.id };
    expect((await asUser(env.db, otherUser, (tx) => tx.query("select id from invoices"))).rows).toEqual([]);
  });

  it("a refund produces a credit note, withholds unreleased payouts and shows on the statement", async () => {
    const before = await env.call("client", "GET", "/api/client/statement");
    expect(before.body.totals.paid).toBeGreaterThan(0);
    expect(before.body.invoices.every((i: any) => i.kind === "tax_invoice")).toBe(true);
    const paid = before.body.payments.find((p: any) => p.status === "paid");
    expect((await env.call("ops", "POST", `/api/ops/payments/${paid.id}/refund`, { reference: "RF-1", reason: "client withdrew" })).status).toBe(403);
    const r = await env.call("finance", "POST", `/api/ops/payments/${paid.id}/refund`, { reference: "RF-1", reason: "Client withdrew before work started" });
    expect(r.status).toBe(200);
    expect(r.body.creditNote.number).toBe("CN-2026-000001");
    const after = await env.call("client", "GET", "/api/client/statement");
    const cn = after.body.invoices.find((i: any) => i.kind === "credit_note");
    expect(cn.gross).toBe(-paid.amount);
    expect(after.body.totals.paid).toBe(before.body.totals.paid - paid.amount);
    expect(after.body.payments.find((p: any) => p.id === paid.id).status).toBe("refunded");
    const payouts = await asPlatform(env.db, null, (tx) => tx.query<any>("select distinct status from payouts where engagement_id = $1", [paid.engagementId]));
    expect(payouts.rows.map((p) => p.status).filter((s) => s !== "withheld")).toEqual([]);
    expect((await env.call("finance", "POST", `/api/ops/payments/${paid.id}/refund`, { reference: "RF-2", reason: "again" })).status).toBe(409);
    const ops = await env.call("ops", "GET", `/api/ops/clients/${(await env.call("client", "GET", "/api/me")).body.orgId}/statement`);
    expect(ops.body.invoices.length).toBe(after.body.invoices.length);
  });

  it("renders a multi-page PDF that stays well-formed", () => {
    const pdf = textPdf(Array.from({ length: 120 }, (_, i) => `Line ${i + 1} (with) parens and a backslash \\`), "Long");
    const text = pdf.toString("latin1");
    expect(text).toMatch(/\/Count 3/);
    expect(text.match(/\/Type \/Page\b/g)!.length).toBe(3);
  });
});

describe("partner invoices and payout runs", () => {
  let env: TestEnv;
  let engagementId: string;
  const view = async (who: string) => (await env.call(who, "GET", `/api/engagements/${engagementId}`)).body;

  beforeAll(async () => {
    env = await makeEnv();
    await env.call("founder", "PUT", "/api/admin/company", { trn: "100123456700003", note: "set" });
    const e = await engagementWithDeposit(env, { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 });
    engagementId = e.engagementId;
    await env.call("finance", "POST", `/api/ops/payments/${e.deposit.id}/mark-paid`, { reference: "TT-1" });
    for (const who of ["setup", "corp", "tax"]) {
      const home = await env.call(who, "GET", "/api/partner/home");
      for (const a of home.body.allocations.filter((x: any) => !x.acceptedAt && !x.declinedAt)) await env.call(who, "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
    }
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("a payout needs the partner's invoice for the exact amount, and bank details, before it is payable", async () => {
    const payouts = (await view("finance")).payouts.filter((p: any) => p.status === "eligible");
    expect(payouts.length).toBeGreaterThan(0);
    const payable0 = await env.call("finance", "GET", "/api/ops/payouts/payable");
    expect(payable0.body.every((p: any) => p.payable === false && p.blocked === "no partner invoice")).toBe(true);
    expect((await env.call("ops", "GET", "/api/ops/payouts/payable")).status).toBe(403);
    expect((await env.call("finance", "POST", "/api/ops/payout-runs")).status).toBe(409);

    const upload = (who: string, payoutId: string, amountAed: number, extra: Record<string, unknown> = {}) =>
      env.call(who, "POST", `/api/payouts/${payoutId}/invoice`, { number: `INV-${payoutId.slice(0, 4)}`, amountAed, vatAed: Math.round(amountAed * 0.05 * 100) / 100, fileName: "invoice.pdf", contentBase64: Buffer.from("%PDF-1.4 inv").toString("base64"), ...extra });
    for (const p of payouts) {
      let ok = 0;
      for (const who of ["setup", "corp", "tax"]) {
        const wrongAmount = await upload(who, p.id, p.amount / 100 + 1);
        if (wrongAmount.status === 400) expect(wrongAmount.body.message).toMatch(/payout amount/);
        const r = await upload(who, p.id, p.amount / 100);
        if (r.status === 200) ok += 1;
      }
      expect(ok).toBe(1); // exactly the partner that owns the payout
    }
    const staffTry = await env.call("setupStaff", "POST", `/api/payouts/${payouts[0].id}/invoice`, { number: "X", amountAed: 1, fileName: "a.pdf", contentBase64: "QQ==" });
    expect(staffTry.status).toBe(403);
    const payable1 = await env.call("finance", "GET", "/api/ops/payouts/payable");
    expect(payable1.body.every((p: any) => p.blocked === "no bank details")).toBe(true);
    expect((await env.call("finance", "POST", "/api/ops/payout-runs")).status).toBe(409);

    for (const who of ["setup", "corp", "tax"]) {
      expect((await env.call(who, "PUT", "/api/partner/bank", { beneficiary: `${who} LLC`, iban: "GB12 3456", bank: "Bank" })).status).toBe(400);
      expect((await env.call(who, "PUT", "/api/partner/bank", { beneficiary: `${who} LLC`, iban: `AE07 0331 2345 6789 0123 456`, bank: "Emirates NBD" })).status).toBe(200);
    }
    const home = await env.call("setup", "GET", "/api/partner/home");
    expect(home.body.bank).toMatchObject({ beneficiary: "setup LLC", iban: "AE070331234567890123456" });
    const payable2 = await env.call("finance", "GET", "/api/ops/payouts/payable");
    expect(payable2.body.every((p: any) => p.payable === true)).toBe(true);
    const audit = await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'partner.bank_changed'"));
    expect(JSON.stringify(audit.rows)).not.toContain("AE070331234567890123456"); // the IBAN itself is not an audit fact
    expect(audit.rows[0].data.ibanEnding).toBe("3456");
  });

  it("finance batches payable payouts into one run, exports a bank file whose total matches, marks it paid, and partners get remittances", async () => {
    const payable = (await env.call("finance", "GET", "/api/ops/payouts/payable")).body;
    const expectedTotal = payable.reduce((s: number, p: any) => s + p.amount + (p.invoiceVat ?? 0), 0);
    const run = await env.call("finance", "POST", "/api/ops/payout-runs");
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ reference: "PR-2026-0001", payouts: payable.length, total: expectedTotal });
    expect((await env.call("finance", "POST", "/api/ops/payout-runs")).status).toBe(409); // one open run at a time
    expect((await env.call("finance", "POST", `/api/ops/payout-runs/${run.body.id}/paid`, { bankReference: "FT1" })).status).toBe(409); // export first
    // A payout in a run can no longer be released one by one.
    expect((await env.call("finance", "POST", `/api/ops/payouts/${payable[0].id}/release`)).status).toBe(409);

    const file = await env.app.inject({ method: "GET", url: `/api/ops/payout-runs/${run.body.id}/file`, headers: { authorization: `Bearer ${env.tokens.finance}` } });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("text/csv");
    const rows = file.body.trim().split("\r\n");
    expect(rows[0]).toBe("Beneficiary name,IBAN,Bank,Amount AED,Currency,Payment reference,Payment details");
    const partners = new Set(payable.map((p: any) => p.partnerId));
    expect(rows.length - 1).toBe(partners.size); // one line per partner
    const fileTotal = rows.slice(1).reduce((s, r) => s + Math.round(Number(r.split(",")[3]) * 100), 0);
    expect(fileTotal).toBe(expectedTotal);
    expect(file.body).toContain("AE070331234567890123456");
    expect(file.body).toContain("PR-2026-0001");
    expect((await env.app.inject({ method: "GET", url: `/api/ops/payout-runs/${run.body.id}/file`, headers: { authorization: `Bearer ${env.tokens.ops}` } })).statusCode).toBe(403);

    const paid = await env.call("finance", "POST", `/api/ops/payout-runs/${run.body.id}/paid`, { bankReference: "FT26290ABC" });
    expect(paid.status).toBe(200);
    expect(paid.body.released).toBe(payable.length);
    const after = await view("finance");
    expect(after.payouts.filter((p: any) => p.status === "released").length).toBe(payable.length);
    const runs = await env.call("ops", "GET", "/api/ops/payout-runs");
    expect(runs.body[0]).toMatchObject({ reference: "PR-2026-0001", status: "paid", bankReference: "FT26290ABC" });
    const remits = env.emails.filter((e) => e.subject.startsWith("Remittance advice"));
    expect(remits.length).toBe(partners.size);
    expect(remits.every((e) => e.fromName === "MKW Advisors" && !/tasees/i.test(e.text))).toBe(true);
    expect(remits[0]!.text).toContain("FT26290ABC");
    const partnerView = await view("setup");
    expect(partnerView.payouts.every((p: any) => p.status === "released" || p.status === "pending")).toBe(true);
    expect(JSON.stringify(partnerView)).not.toMatch(/client_unit|clientUnit|margin/);
    const released = await asPlatform(env.db, null, (tx) => tx.query<any>("select count(*)::int as n from audit_events where action = 'payout.released'"));
    expect(released.rows[0].n).toBe(payable.length);
    expect((await env.call("finance", "POST", `/api/ops/payout-runs/${run.body.id}/cancel`, { reason: "too late" })).status).toBe(409);
  });

  it("ops cannot touch runs, bank files or refunds", async () => {
    expect((await env.call("ops", "POST", "/api/ops/payout-runs")).status).toBe(403);
    expect((await env.call("ops", "POST", "/api/ops/payout-runs/00000000-0000-0000-0000-000000000000/paid", { bankReference: "x" })).status).toBe(403);
    expect((await env.call("ops", "PUT", "/api/partner/bank", { beneficiary: "x", iban: "AE070331234567890123456", bank: "b" })).status).toBe(403);
    expect((await env.call("client", "GET", "/api/ops/payout-runs")).status).toBe(403);
  });
});

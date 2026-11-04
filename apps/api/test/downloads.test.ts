import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/lib/auth.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E21 (gap 145): the six download routes the baseline audit found with no test that another party is refused
 * (`docs/transformation/BASELINE-AUDIT.md`, 4.2). Each is tried by the party it belongs to (it works) and by every
 * party it does not (it is refused, and the body carries none of the file).
 */
const pdf = Buffer.from("%PDF-1.4 E21 evidence").toString("base64");
const IBAN = "AE070331234567890123456";
const partnerKey = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");

describe("downloads are refused to every other party (E21)", () => {
  let env: TestEnv;
  let engagementId: string;
  let offerId: string;
  let evidenceId: string;
  let invoiceId: string;
  let runId: string;
  let deliverer: string;
  let stranger: string;
  const get = (who: string, url: string) =>
    env.app.inject({ method: "GET", url, headers: who === "anon" ? {} : { authorization: `Bearer ${env.tokens[who]}` } });

  beforeAll(async () => {
    env = await makeEnv();
    // A tax invoice is issued, with its PDF, only once MKW's TRN is recorded (a test value, as in payments.test.ts).
    expect((await env.call("founder", "PUT", "/api/admin/company", { trn: "100123456700003", address: "Office 1, Dubai", note: "test TRN" })).status).toBe(200);
    const req =await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    offerId = (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`, { acknowledgeReview: true })).status).toBe(200);
    engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
    expect((await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-TT-E21" })).status).toBe(200);
    let e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    for (const a of e.allocations.filter((x: any) => !x.acceptedAt)) {
      expect((await env.call(partnerKey(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" })).status).toBe(200);
    }
    e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const parties = new Set<string>(e.allocations.map((a: any) => partnerKey(a.partner)));
    deliverer = [...parties][0]!;
    stranger = ["setup", "corp", "tax"].find((k) => !parties.has(k))!;
    expect(stranger).toBeDefined();
    const m = (await env.call(deliverer, "GET", `/api/engagements/${engagementId}`)).body.milestones[0];
    expect((await env.call(deliverer, "POST", `/api/milestones/${m.id}/start`)).status).toBe(200);
    expect((await env.call(deliverer, "POST", `/api/milestones/${m.id}/evidence`, { type: m.evidenceRequired[0] ?? "receipt", fileName: "licence.pdf", contentBase64: pdf })).status).toBe(200);
    evidenceId = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body.evidence[0].id;
    invoiceId = (await env.call("client", "GET", "/api/client/statement")).body.invoices[0].id;
    // A real payout run: the delivering firm gives its bank details and invoices its kickoff payout; finance runs it.
    expect((await env.call(deliverer, "PUT", "/api/partner/bank", { beneficiary: "E21 Delivery LLC", iban: IBAN, bank: "Test Bank" })).status).toBe(200);
    const payouts = (await env.call("finance", "GET", "/api/ops/payouts/payable")).body as any[];
    expect(payouts.length).toBeGreaterThan(0);
    for (const p of payouts) {
      const amountAed = p.amount / 100;
      expect((await env.call(deliverer, "POST", `/api/payouts/${p.id}/invoice`, { number: `INV-E21-${p.id.slice(0, 4)}`, amountAed, vatAed: Math.round(amountAed * 5) / 100, fileName: "invoice.pdf", contentBase64: Buffer.from("%PDF-1.4 inv").toString("base64") })).status).toBe(200);
    }
    const run = await env.call("finance", "POST", "/api/ops/payout-runs");
    expect(run.status).toBe(200);
    runId = run.body.id;
    // Another client, with its own owner signed in.
    expect((await env.call("ops", "POST", "/api/ops/clients", { company: "Other Client LLC", ownerName: "Other Owner", ownerEmail: "owner@other-e21.test" })).status).toBe(200);
    env.tokens.other = await createSession(env.db, "owner@other-e21.test");
  });
  afterAll(() => env.db.close());

  /** The file's own bytes never appear in a refusal. */
  const refused = async (who: string, url: string, statuses: number[], secret?: string) => {
    const r = await get(who, url);
    expect(statuses, `${who} ${url} -> ${r.statusCode}`).toContain(r.statusCode);
    if (secret) expect(r.body).not.toContain(secret);
  };

  it("the evidence file: the engagement's client and partner and MKW get it; another client, another firm and anonymous do not", async () => {
    const url = `/api/evidence/${evidenceId}/file`;
    for (const who of ["client", deliverer, "ops"]) {
      const r = await get(who, url);
      expect(r.statusCode, who).toBe(200);
      expect(r.body).toContain("E21 evidence");
    }
    await refused("other", url, [404], "E21 evidence");
    await refused(stranger, url, [404], "E21 evidence");
    await refused("anon", url, [401], "E21 evidence");
  });

  it("the invoice PDF: refused to another client, a partner and anonymous", async () => {
    const url = `/api/invoices/${invoiceId}/pdf`;
    expect((await get("client", url)).statusCode).toBe(200);
    expect((await get("finance", url)).statusCode).toBe(200);
    await refused("other", url, [404], "%PDF");
    await refused(deliverer, url, [403, 404], "%PDF");
    await refused("anon", url, [401], "%PDF");
  });

  it("the offer PDF: refused to another client, a partner and anonymous", async () => {
    const url = `/api/client/offers/${offerId}/pdf`;
    expect((await get("client", url)).statusCode).toBe(200);
    await refused("other", url, [404], "%PDF");
    await refused(deliverer, url, [403], "%PDF");
    await refused("anon", url, [401], "%PDF");
  });

  it("the coverage backlog CSV: MKW only", async () => {
    const url = "/api/admin/coverage/backlog.csv";
    expect((await get("ops", url)).statusCode).toBe(200);
    for (const who of ["client", "clientMember", "other", deliverer, "setupStaff"]) await refused(who, url, [403]);
    await refused("anon", url, [401]);
  });

  it("the payout bank file: finance and the founder only", async () => {
    const url = `/api/ops/payout-runs/${runId}/file`;
    const f = await get("finance", url);
    expect(f.statusCode).toBe(200);
    expect(f.body).toContain(IBAN);
    for (const who of ["ops", "client", "other", deliverer, stranger, "setupStaff"]) await refused(who, url, [403], IBAN);
    await refused("anon", url, [401], IBAN);
  });

  it("the accounting export: never to a partner or a client", async () => {
    const url = "/api/admin/accounting/export?set=payouts&from=2026-01-01&to=2026-12-31";
    expect((await get("finance", url)).statusCode).toBe(200);
    for (const who of [deliverer, stranger, "setupStaff", "client", "other"]) await refused(who, url, [403]);
    await refused("anon", url, [401]);
  });
});

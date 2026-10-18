import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forbiddenFields } from "@tasees/core";
import { signWebhook } from "../src/lib/payments.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * The full managed engagement, end to end, through the HTTP API:
 * request -> offers -> publish -> accept -> pay -> allocate -> accept -> evidence -> QA -> approve -> payouts.
 */
describe("managed engagement lifecycle", () => {
  let env: TestEnv;
  let requestId: string;
  let offerId: string;
  let engagementId: string;

  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("creates a request with a scope sheet from intake answers", async () => {
    const r = await env.call("client", "POST", "/api/requests", {
      answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 2, addOns: ["BANK-ACC"] },
    });
    expect(r.status).toBe(200);
    expect(r.body.lines).toBe(3);
    requestId = r.body.id;
  });

  it("builds tiered offers from rate cards with the margin rules", async () => {
    const r = await env.call("ops", "POST", `/api/ops/requests/${requestId}/build-offers`, {});
    expect(r.status).toBe(200);
    expect(r.body.missing).toEqual([]);
    expect(r.body.offerIds.length).toBeGreaterThanOrEqual(2);
    const overview = await env.call("finance", "GET", "/api/ops/overview");
    const standard = overview.body.offers.find((o: any) => o.tier === "standard");
    expect(standard.margin).toBeGreaterThan(0);
    offerId = standard.id;
  });

  it("hides margin from ops but shows it to finance", async () => {
    const ops = await env.call("ops", "GET", `/api/ops/offers/${offerId}`);
    expect(ops.body).not.toHaveProperty("margin");
    expect(ops.body.lines[0]).not.toHaveProperty("marginUnit");
    expect(ops.body.lines[0]).toHaveProperty("partnerUnitCost");
    const fin = await env.call("finance", "GET", `/api/ops/offers/${offerId}`);
    expect(fin.body.margin).toBeGreaterThan(0);
  });

  it("does not show the client an unpublished offer", async () => {
    const r = await env.call("client", "GET", `/api/client/offers/${offerId}`);
    expect(r.status).toBe(404);
  });

  it("publishes, and the client sees prices but never partner cost or margin", async () => {
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`)).status).toBe(200);
    const r = await env.call("client", "GET", `/api/client/offers/${offerId}`);
    expect(r.status).toBe(200);
    expect(r.body.clientTotal).toBeGreaterThan(0);
    for (const f of forbiddenFields("offer", "client_owner")) expect(r.body).not.toHaveProperty(f);
    for (const line of r.body.lines) {
      for (const f of forbiddenFields("offerLine", "client_owner")) expect(line).not.toHaveProperty(f);
      expect(line.clientUnitPrice).toBeGreaterThan(0);
    }
    expect(JSON.stringify(r.body)).not.toMatch(/margin|partnerUnit|payout/i);
  });

  it("lets only the account owner accept", async () => {
    const member = await env.call("clientMember", "POST", `/api/client/offers/${offerId}/accept`);
    expect(member.status).toBe(403);
    const r = await env.call("client", "POST", `/api/client/offers/${offerId}/accept`);
    expect(r.status).toBe(200);
    engagementId = r.body.engagementId;
  });

  it("allocates only after the deposit is paid", async () => {
    const before = await env.call("ops", "GET", `/api/engagements/${engagementId}`);
    expect(before.body.engagement.status).toBe("awaiting_payment");
    expect(before.body.allocations).toEqual([]);
    const deposit = before.body.payments.find((p: any) => p.kind === "deposit");
    const paid = await env.call("anon", "POST", "/api/webhooks/payments", { paymentId: deposit.id, status: "paid", reference: "PSP-123" });
    expect(paid.status).toBe(401); // unsigned
    const raw = JSON.stringify({ kind: "payment.paid", paymentId: deposit.id, amountFils: deposit.amount, reference: "PSP-123" });
    const sig = signWebhook("test-secret", raw, Math.floor(env.clock.now.getTime() / 1000));
    const ok = await env.app.inject({
      method: "POST",
      url: "/api/webhooks/payments",
      headers: { "content-type": "application/json", "x-webhook-timestamp": sig.timestamp, "x-webhook-signature": sig.signature },
      payload: raw,
    });
    expect(ok.statusCode).toBe(200);
    const after = await env.call("ops", "GET", `/api/engagements/${engagementId}`);
    expect(after.body.engagement.status).toBe("allocating");
    expect(after.body.allocations.length).toBeGreaterThan(0);
  });

  it("shows partners their payout and never the client price", async () => {
    for (const who of ["setup", "corp"]) {
      const home = await env.call(who, "GET", "/api/partner/home");
      expect(home.status).toBe(200);
      const raw = JSON.stringify(home.body);
      expect(raw).not.toContain("clientUnitPrice");
      expect(raw).not.toContain("margin");
    }
  });

  it("partners accept, milestones and payouts appear", async () => {
    for (const who of ["setup", "corp"]) {
      const home = await env.call(who, "GET", "/api/partner/home");
      for (const a of home.body.allocations.filter((x: any) => !x.acceptedAt && x.engagementId === engagementId)) {
        expect(a.payoutTotal).toBeGreaterThan(0);
        const staff = await env.call("setupStaff", "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
        expect(staff.status).toBe(403);
        const r = await env.call(who, "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
        expect(r.status).toBe(200);
      }
    }
    const e = await env.call("ops", "GET", `/api/engagements/${engagementId}`);
    expect(e.body.engagement.status).toBe("in_delivery");
    expect(e.body.milestones.length).toBeGreaterThan(3);
    expect(e.body.payouts.filter((p: any) => p.status === "eligible").every((p: any) => p.stage === "kickoff")).toBe(true);
  });

  it("partner view of the engagement shows its own cost, not the client price", async () => {
    const r = await env.call("setup", "GET", `/api/engagements/${engagementId}`);
    expect(r.status).toBe(200);
    for (const l of r.body.lines) {
      expect(l).not.toHaveProperty("clientUnitPrice");
      expect(l).toHaveProperty("partnerUnitCost");
    }
    const staff = await env.call("setupStaff", "GET", `/api/engagements/${engagementId}`);
    for (const l of staff.body.lines) expect(l).not.toHaveProperty("partnerUnitCost");
  });

  it("masks phone numbers and emails in messages between client and partner", async () => {
    await env.call("client", "POST", `/api/engagements/${engagementId}/messages`, { body: "Call me on +971 50 123 4567 please" });
    const p = await env.call("setup", "GET", `/api/engagements/${engagementId}`);
    const last = p.body.messages.at(-1);
    expect(last.bodyShown).toContain("[phone hidden]");
    expect(JSON.stringify(p.body)).not.toContain("123 4567");
    const ops = await env.call("ops", "GET", `/api/engagements/${engagementId}`);
    expect(ops.body.messages.at(-1).bodyOriginal).toContain("123 4567");
  });

  it("requires evidence, QA, then client approval, and releases payouts in stages", async () => {
    const view = async (who: string) => (await env.call(who, "GET", `/api/engagements/${engagementId}`)).body;
    let ops = await view("ops");
    const byPartner = new Map<string, string>([
      ["Example Setup Partners FZ-LLC", "setup"],
      ["Example Corporate Services LLC", "corp"],
    ]);
    const partnerOfCode = new Map<string, string>(ops.lines.map((l: any) => [l.code, byPartner.get(l.partner)!]));

    for (const m of ops.milestones) {
      const who = partnerOfCode.get(m.code)!;
      const noEvidence = await env.call(who, "POST", `/api/milestones/${m.id}/submit`);
      expect(noEvidence.status).toBe(400);
      for (const type of m.evidenceRequired) {
        const up = await env.call(who, "POST", `/api/milestones/${m.id}/evidence`, {
          type,
          fileName: `${type}.pdf`,
          contentBase64: Buffer.from("%PDF-1.4 test").toString("base64"),
        });
        expect(up.status).toBe(200);
      }
      expect((await env.call(who, "POST", `/api/milestones/${m.id}/submit`)).status).toBe(200);
      // Client cannot approve before QA.
      expect((await env.call("client", "POST", `/api/milestones/${m.id}/review`, { approve: true })).status).toBe(409);
      expect((await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true })).status).toBe(200);
      expect((await env.call("client", "POST", `/api/milestones/${m.id}/review`, { approve: true })).status).toBe(200);
    }
    ops = await view("ops");
    expect(ops.engagement.status).toBe("completed");
    expect(ops.payouts.every((p: any) => p.status === "eligible")).toBe(true);
    expect(ops.payments.find((p: any) => p.kind === "balance").status).toBe("pending");

    const payout = ops.payouts[0];
    expect((await env.call("ops", "POST", `/api/ops/payouts/${payout.id}/release`)).status).toBe(403);
    // O3: a payout is released only against the partner's own invoice for it.
    expect((await env.call("finance", "POST", `/api/ops/payouts/${payout.id}/release`)).status).toBe(409);
    let uploaded = false;
    for (const k of ["setup", "corp", "tax"]) {
      const r = await env.call(k, "POST", `/api/payouts/${payout.id}/invoice`, { number: "INV-001", amountAed: payout.amount / 100, fileName: "inv.pdf", contentBase64: Buffer.from("%PDF-1.4").toString("base64") });
      if (r.status === 200) uploaded = true;
    }
    expect(uploaded).toBe(true);
    expect((await env.call("finance", "POST", `/api/ops/payouts/${payout.id}/release`)).status).toBe(200);
    expect((await env.call("finance", "POST", `/api/ops/payouts/${payout.id}/release`)).status).toBe(409);
  });

  it("keeps a hash-chained audit trail", async () => {
    const r = await env.call("founder", "GET", "/api/ops/audit");
    const events = [...r.body].reverse();
    expect(events.length).toBeGreaterThan(20);
    for (let i = 1; i < events.length; i++) expect(events[i].prevHash).toBe(events[i - 1].hash);
  });
});

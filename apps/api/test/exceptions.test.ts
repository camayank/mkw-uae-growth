import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** The paths where things go wrong: declines, SLA timeouts, no rate card, change orders, disputes. */
describe("exceptions", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  async function paidEngagement(answers: object) {
    const req = await env.call("client", "POST", "/api/requests", { answers });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    const offerId = built.body.offerIds[0];
    await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
    const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
    await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-TT-1" });
    return engagementId as string;
  }

  it("re-routes to the next partner when one declines", async () => {
    const id = await paidEngagement({ mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 0 });
    const e1 = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    const first = e1.allocations[0];
    const who = first.partner.startsWith("Example Setup") ? "setup" : "corp";
    const noReason = await env.call(who, "POST", `/api/allocations/${first.id}/respond`, { decision: "decline" });
    expect(noReason.status).toBe(400);
    expect((await env.call(who, "POST", `/api/allocations/${first.id}/respond`, { decision: "decline", reason: "No capacity this week" })).status).toBe(200);
    const e2 = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    expect(e2.allocations).toHaveLength(2);
    expect(e2.allocations[1].partner).not.toBe(first.partner);
    expect(e2.allocations[1].reason).toBe("next_ranked_declined");
  });

  it("re-routes after the 4 working hour acceptance window lapses", async () => {
    const id = await paidEngagement({ mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 0 });
    const before = (await env.call("ops", "GET", `/api/engagements/${id}`)).body.allocations;
    env.clock.now = new Date(env.clock.now.getTime() + 2 * 24 * 3600 * 1000);
    const jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.allocationTimeouts).toBeGreaterThanOrEqual(1);
    const after = (await env.call("ops", "GET", `/api/engagements/${id}`)).body.allocations;
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1).reason).toBe("next_ranked_sla_timeout");
  });

  it("asks for a request for quote when no rate card covers a line, then prices from the sealed quote", async () => {
    const req = await env.call("client", "POST", "/api/requests", {
      answers: { mode: "services", emirate: "Dubai", services: ["TM-REG"] },
    });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, {});
    expect(built.body.missing).toEqual(["TM-REG"]);
    // Give the setup partner the code, then open an RFQ.
    const partners = (await env.call("ops", "GET", "/api/ops/overview")).body.partners;
    const setup = partners.find((p: any) => p.name.startsWith("Example Setup"));
    await env.call("ops", "PUT", `/api/ops/partners/${setup.id}`, { codes: [...setup.profile.codes, "TM-REG"] });
    const rfq = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/rfq`, { codes: ["TM-REG"] });
    expect(rfq.status).toBe(200);
    const home = await env.call("setup", "GET", "/api/partner/home");
    const open = home.body.rfqs.find((q: any) => q.id === rfq.body.id);
    expect(open).toBeTruthy();
    const quote = await env.call("setup", "POST", `/api/rfqs/${rfq.body.id}/quote`, {
      lines: [{ code: "TM-REG", professionalAed: 1_500, govStatedAed: 5_750, workingDays: 20 }],
    });
    expect(quote.status).toBe(200);
    // A partner that was not invited cannot quote.
    expect((await env.call("tax", "POST", `/api/rfqs/${rfq.body.id}/quote`, { lines: [{ code: "TM-REG", professionalAed: 1, workingDays: 1 }] })).status).toBe(404);
    const rebuilt = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    expect(rebuilt.body.missing).toEqual([]);
    const offer = await env.call("finance", "GET", `/api/ops/offers/${rebuilt.body.offerIds[0]}`);
    // 1,500 + max(20%, AED 500 floor) = 2,000, then rounded up to AED 50.
    expect(offer.body.lines[0].clientUnitPrice).toBe(200_000);
    expect(offer.body.government).toBe(575_000);
  });

  it("prices a change order with the same margin rule and pays the partner only after the client pays", async () => {
    const id = await paidEngagement({ mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 0 });
    let e = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    const open = e.allocations.filter((a: any) => !a.acceptedAt && !a.declinedAt && !a.timedOutAt);
    const who = open[0].partner.startsWith("Example Setup") ? "setup" : "corp";
    await env.call(who, "POST", `/api/allocations/${open[0].id}/respond`, { decision: "accept" });
    const co = await env.call(who, "POST", `/api/engagements/${id}/change-orders`, { description: "Add a second activity to the licence", partnerCostAed: 1_000 });
    expect(co.status).toBe(200);
    const clientView = (await env.call("client", "GET", `/api/engagements/${id}`)).body;
    const c = clientView.changeOrders[0];
    expect(c.client).toBe(150_000); // 1,000 + AED 500 floor
    expect(c).not.toHaveProperty("partner");
    expect((await env.call("client", "POST", `/api/change-orders/${c.id}/decide`, { approve: true })).status).toBe(200);
    e = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    const coPayout = e.payouts.find((p: any) => p.stage === "change_order");
    expect(coPayout.status).toBe("pending");
    const coPayment = e.payments.find((p: any) => p.kind === "change_order");
    expect(coPayment.amount).toBe(157_500); // incl. 5% VAT
    await env.call("finance", "POST", `/api/ops/payments/${coPayment.id}/mark-paid`, { reference: "CARD-1" });
    e = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    expect(e.payouts.find((p: any) => p.stage === "change_order").status).toBe("eligible");
  });

  it("lets the client dispute a milestone and ops send it back for rework", async () => {
    const id = await paidEngagement({ mode: "services", emirate: "Dubai", services: ["CT-RET"] });
    let e = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    const a = e.allocations[0];
    await env.call("tax", "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
    e = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    const m = e.milestones[0];
    for (const type of m.evidenceRequired) {
      await env.call("tax", "POST", `/api/milestones/${m.id}/evidence`, { type, fileName: "trn.pdf", contentBase64: "JVBERi0=" });
    }
    await env.call("tax", "POST", `/api/milestones/${m.id}/submit`);
    await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true });
    expect((await env.call("client", "POST", `/api/milestones/${m.id}/review`, { approve: false })).status).toBe(400);
    expect((await env.call("client", "POST", `/api/milestones/${m.id}/review`, { approve: false, reason: "Wrong company name on the certificate" })).status).toBe(200);
    const overview = (await env.call("ops", "GET", "/api/ops/overview")).body;
    expect(overview.exceptions.some((x: any) => x.kind === "dispute")).toBe(true);
    expect((await env.call("ops", "POST", `/api/ops/milestones/${m.id}/resolve`, { outcome: "rework" })).status).toBe(200);
  });

  it("auto-approves milestones the client has not reviewed within 5 working days", async () => {
    const id = await paidEngagement({ mode: "services", emirate: "Dubai", services: ["VAT-RET"] });
    let e = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    await env.call("tax", "POST", `/api/allocations/${e.allocations[0].id}/respond`, { decision: "accept" });
    e = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    const m = e.milestones[0];
    await env.call("tax", "POST", `/api/milestones/${m.id}/evidence`, { type: m.evidenceRequired[0], fileName: "vat.pdf", contentBase64: "JVBERi0=" });
    await env.call("tax", "POST", `/api/milestones/${m.id}/submit`);
    await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true });
    env.clock.now = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.autoApprovals).toBeGreaterThanOrEqual(1);
    e = (await env.call("ops", "GET", `/api/engagements/${id}`)).body;
    expect(e.milestones.find((x: any) => x.id === m.id).status).toBe("client_approved");
  });

  it("never offers a partner more than the cost the client's price was built on, whoever ends up with the work", async () => {
    // Make the cheapest setup partner the one offers are priced on, then repeat the same order so it goes over
    // the 35% fairness cap and work is re-routed to a dearer partner. That partner must not get the work.
    const partners = (await env.call("ops", "GET", "/api/ops/overview")).body.partners;
    const corp = partners.find((p: any) => p.name.startsWith("Example Corporate"));
    await env.call("ops", "PUT", `/api/ops/partners/${corp.id}`, { quality: 95, capacity: 50 });
    for (let i = 0; i < 3; i++) {
      await paidEngagement({ mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 2, addOns: ["BANK-ACC", "VAT-RET"] });
    }
    const rows = await asPlatform(env.db, null, (tx) =>
      tx.query<{ n: number }>(
        `select
           (select count(*)::int
              from allocations a
              cross join lateral jsonb_array_elements(a.payout_lines) p
              join engagements e on e.id = a.engagement_id
              join offer_lines ol on ol.offer_id = e.offer_id and ol.code = p->>'code'
             where (p->>'unitFils')::bigint > ol.partner_unit_fils) as n,
           1 as one`,
      ),
    );
    expect(rows.rows[0]!.n).toBe(0);
  });
});

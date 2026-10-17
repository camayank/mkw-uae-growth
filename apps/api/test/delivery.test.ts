import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** O6 delivery: client document requests, delay watch and guarantee, ratings, fairness by category, manual allocation, offer PDF. */

const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
const day = 24 * 3600 * 1000;

async function paidEngagement(env: TestEnv, answers: object) {
  const req = await env.call("client", "POST", "/api/requests", { answers });
  const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
  const offerId = built.body.offerIds[0];
  await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
  const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId as string;
  const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
  await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-TT-1" });
  return { engagementId, offerId };
}

const partnerKey = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");

async function acceptAll(env: TestEnv, engagementId: string) {
  const e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
  for (const a of e.allocations.filter((x: any) => !x.acceptedAt && !x.declinedAt && !x.timedOutAt)) {
    expect((await env.call(partnerKey(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" })).status).toBe(200);
  }
  return (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
}

async function completeMilestone(env: TestEnv, who: string, m: any) {
  for (const type of m.evidenceRequired) await env.call(who, "POST", `/api/milestones/${m.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: pdf });
  expect((await env.call(who, "POST", `/api/milestones/${m.id}/submit`)).status).toBe(200);
  expect((await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true })).status).toBe(200);
  expect((await env.call("client", "POST", `/api/milestones/${m.id}/review`, { approve: true })).status).toBe(200);
}

describe("client document requests", () => {
  let env: TestEnv;
  afterAll(async () => {
    await env.db.close();
  });
  beforeAll(async () => {
    env = await makeEnv();
  });

  it("asks the client for the checklist on acceptance, tells the partner when complete, keeps files to the parties", async () => {
    const { engagementId } = await paidEngagement(env, { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 });
    const e = await acceptAll(env, engagementId);
    expect(e.engagement.status).toBe("in_delivery");
    const client = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body;
    const reqs = client.documentRequests;
    expect(reqs.length).toBeGreaterThanOrEqual(4);
    expect(reqs.every((r: any) => r.status === "requested")).toBe(true);
    expect(reqs.map((r: any) => r.kind)).toContain("passport_copy");
    const ask = env.emails.find((e) => e.subject.startsWith("Documents needed"))!;
    expect(ask.fromName).toBe("Tasees, by MKW Advisors");
    expect(ask.text).toContain("passport copy");
    // Only the client uploads; a partner's request on a step it owns is added; an engagement stranger sees nothing.
    const first = reqs[0];
    expect((await env.call("setup", "POST", `/api/document-requests/${first.id}/upload`, { fileName: "x.pdf", contentBase64: pdf })).status).toBe(403);
    expect((await env.call("client", "POST", `/api/document-requests/${first.id}/upload`, { fileName: "x.exe", contentBase64: pdf })).status).toBe(400);
    const step = e.milestones.find((m: any) => m.id === first.milestoneId);
    const who = partnerKey(e.lines.find((l: any) => l.code === step.code).partner);
    const other = who === "setup" ? "corp" : "setup";
    expect((await env.call(other, "POST", `/api/milestones/${step.id}/document-requests`, { kind: "NOC letter" })).status).toBe(404);
    const extra = await env.call(who, "POST", `/api/milestones/${step.id}/document-requests`, { kind: "NOC letter", note: "From the current sponsor, call me on 050 123 4567" });
    expect(extra.status).toBe(200);
    const stepReqs = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body.documentRequests.filter((r: any) => r.milestoneId === step.id);
    expect(stepReqs.find((r: any) => r.kind === "noc_letter").note).not.toContain("050 123 4567");
    for (const r of stepReqs) {
      const up = await env.call("client", "POST", `/api/document-requests/${r.id}/upload`, { fileName: `${r.kind}.pdf`, contentBase64: pdf });
      expect(up.status).toBe(200);
    }
    expect(env.emails.some((e) => e.subject.startsWith("Client documents complete"))).toBe(true);
    // The partner marks one received and asks again for another with a reason; the client is told.
    const [a, b] = stepReqs;
    expect((await env.call(who, "POST", `/api/document-requests/${a.id}/decide`, { decision: "received" })).status).toBe(200);
    expect((await env.call(who, "POST", `/api/document-requests/${b.id}/decide`, { decision: "rejected", note: "" })).status).toBe(400);
    expect((await env.call(who, "POST", `/api/document-requests/${b.id}/decide`, { decision: "rejected", note: "Blurry scan" })).status).toBe(200);
    expect((await env.call(other, "POST", `/api/document-requests/${a.id}/decide`, { decision: "received" })).status).toBe(403);
    const again = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body.documentRequests.find((r: any) => r.id === b.id);
    expect(again.status).toBe("rejected");
    expect(again.decisionNote).toBe("Blurry scan");
    expect((await env.call("client", "POST", `/api/document-requests/${b.id}/upload`, { fileName: "better.pdf", contentBase64: pdf })).status).toBe(200);
    // Files: the client, its partner and MKW can open; another partner cannot; the partner view never shows the client's file key.
    for (const [k, code] of [["client", 200], [who, 200], ["ops", 200], [other, 404]] as const) {
      const r = await env.app.inject({ method: "GET", url: `/api/document-requests/${a.id}/file`, headers: { authorization: `Bearer ${env.tokens[k]}` } });
      expect(r.statusCode).toBe(code);
    }
    const partnerView = JSON.stringify((await env.call(who, "GET", `/api/engagements/${engagementId}`)).body.documentRequests);
    expect(partnerView).not.toMatch(/fileKey|file_key/);
    await expect(asUser(env.db, (await env.call(other, "GET", "/api/me")).body, (tx) => tx.query("select file_key from document_requests"))).rejects.toThrow(/permission denied/);
  });
});

describe("delay watch, service guarantee and ratings", () => {
  let env: TestEnv;
  let engagementId: string;
  let lateStep: any;
  let who: string;
  afterAll(async () => {
    await env.db.close();
  });
  beforeAll(async () => {
    env = await makeEnv();
  });

  it("notices a late step once, tells both sides with a new date, and asks ops to attribute it", async () => {
    ({ engagementId } = await paidEngagement(env, { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 0 }));
    const e = await acceptAll(env, engagementId);
    lateStep = e.milestones[0];
    who = partnerKey(e.lines.find((l: any) => l.code === lateStep.code).partner);
    env.clock.now = new Date(new Date(lateStep.dueDate).getTime() + 1.5 * day);
    let jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.delays).toBeGreaterThanOrEqual(1);
    jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.delays).toBe(0);
    const toClient = env.emails.find((m) => /running late/.test(m.subject))!;
    expect(toClient.fromName).toBe("Tasees, by MKW Advisors");
    expect(toClient.text).toContain("new expected date");
    const toPartner = env.emails.find((m) => /^Overdue:/.test(m.subject))!;
    expect(toPartner.fromName).toBe("MKW Advisors");
    const client = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body;
    const d = client.delays.find((x: any) => x.milestoneId === lateStep.id);
    expect(d.expectedDate > d.dueDate).toBe(true);
    expect(d.cause).toBeUndefined();
    expect((await env.call("ops", "GET", "/api/ops/overview")).body.exceptions.some((x: any) => x.kind === "delay" && x.ref === d.id)).toBe(true);
    expect((await env.call("finance", "POST", `/api/ops/delays/${d.id}/attribute`, { cause: "partner", note: "x" })).status).toBe(403);
    expect((await env.call("ops", "POST", `/api/ops/delays/${d.id}/attribute`, { cause: "partner", note: "Partner did not start the step" })).status).toBe(200);
    const ops = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    expect(ops.delays.find((x: any) => x.id === d.id).cause).toBe("partner");
    // The partner sees the delay without the attribution.
    const partnerDelay = (await env.call(who, "GET", `/api/engagements/${engagementId}`)).body.delays.find((x: any) => x.id === d.id);
    expect(partnerDelay.cause).toBeUndefined();
  });

  it("creates the credit by rule after five working days, finance applies it to the balance and reduces the partner's completion payout", async () => {
    const before = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const line = before.lines.find((l: any) => l.code === lateStep.code);
    const stepsInLine = before.milestones.filter((m: any) => m.code === lateStep.code).length;
    const expectedCredit = Math.floor((Math.floor((line.qty * line.clientUnitPrice) / stepsInLine) * 1000) / 10_000);
    // Four working days: nothing yet.
    env.clock.now = new Date(env.clock.now.getTime() + 4 * day);
    let jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.credits).toBe(0);
    env.clock.now = new Date(env.clock.now.getTime() + 5 * day);
    jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.credits).toBeGreaterThanOrEqual(1);
    const client = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body;
    const credit = client.credits.find((c: any) => c.milestoneId === lateStep.id);
    expect(credit).toMatchObject({ amount: expectedCredit, status: "pending" });
    expect(credit.borneByPartner).toBeUndefined();
    expect(credit.base).toBeUndefined();
    // The partner never sees credits; ops cannot decide; finance applies.
    expect(JSON.stringify((await env.call(who, "GET", `/api/engagements/${engagementId}`)).body)).not.toMatch(/credit/i);
    expect((await env.call("ops", "POST", `/api/ops/credits/${credit.id}/decide`, { decision: "approve" })).status).toBe(403);
    const queue = await env.call("finance", "GET", "/api/ops/delays");
    expect(queue.body.credits.find((c: any) => c.id === credit.id)).toMatchObject({ borneByPartner: true, cause: "partner", guaranteeBp: 1000 });
    const balanceBefore = before.payments.find((p: any) => p.kind === "balance").amount;
    const payoutBefore = before.payouts.find((p: any) => p.stage === "completion" && p.partner === line.partner).amount;
    const decided = await env.call("finance", "POST", `/api/ops/credits/${credit.id}/decide`, { decision: "approve", note: "Per the guarantee" });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ status: "applied", payoutReductionFils: expectedCredit });
    const after = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    expect(after.payments.find((p: any) => p.kind === "balance").amount).toBe(balanceBefore - expectedCredit);
    expect(after.payouts.find((p: any) => p.stage === "completion" && p.partner === line.partner).amount).toBe(payoutBefore - expectedCredit);
    expect((await env.call("finance", "POST", `/api/ops/credits/${credit.id}/decide`, { decision: "approve" })).status).toBe(409);
    const mail = env.emails.find((m) => /Service guarantee credit/.test(m.subject))!;
    expect(mail.text).toContain("deducted from your balance");
    const actions = await asPlatform(env.db, null, (tx) => tx.query<any>("select action from audit_events where action in ('guarantee.credit_due','guarantee.approved','payout.reduced_by_guarantee','payment.reduced_by_credit') order by id"));
    expect(actions.rows.map((a) => a.action)).toEqual(["guarantee.credit_due", "payment.reduced_by_credit", "payout.reduced_by_guarantee", "guarantee.approved"]);
  });

  it("lets the owner rate once after completion; the partner sees stars and a masked comment, never the author", async () => {
    expect((await env.call("client", "POST", `/api/engagements/${engagementId}/rating`, { stars: 4 })).status).toBe(409);
    const e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    for (const m of e.milestones) await completeMilestone(env, partnerKey(e.lines.find((l: any) => l.code === m.code).partner), m);
    expect((await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.engagement.status).toBe("completed");
    expect((await env.call("clientMember", "POST", `/api/engagements/${engagementId}/rating`, { stars: 4 })).status).toBe(403);
    expect((await env.call("client", "POST", `/api/engagements/${engagementId}/rating`, { stars: 6 })).status).toBe(400);
    const rated = await env.call("client", "POST", `/api/engagements/${engagementId}/rating`, { stars: 4, comment: "Good work, slow on the first step. Call me on 050 765 4321." });
    expect(rated.status).toBe(200);
    expect((await env.call("client", "POST", `/api/engagements/${engagementId}/rating`, { stars: 5 })).status).toBe(409);
    const partner = (await env.call(who, "GET", `/api/engagements/${engagementId}`)).body.rating;
    expect(partner.stars).toBe(4);
    expect(partner.comment).not.toContain("050 765 4321");
    expect(partner.authorName).toBeUndefined();
    const ops = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.rating;
    expect(ops.commentOriginal).toContain("050 765 4321");
    expect(env.emails.find((m) => /Client rating/.test(m.subject))!.fromName).toBe("MKW Advisors");
    // The rating and the dispute-free delivery flow into the scorecard.
    await env.call("ops", "POST", "/api/ops/scorecards/recompute");
    const partnerOrg = (await env.call(who, "GET", "/api/me")).body.orgId;
    const card = (await env.call(who, "GET", `/api/partners/${partnerOrg}/scorecards`)).body[0];
    expect(card.inputs.rating).toBe(4);
    expect(card.inputs.milestonesDone).toBeGreaterThan(0);
    expect(card.provisional).toBe(false);
  });
});

describe("fairness by category and manual allocation", () => {
  let env: TestEnv;
  afterAll(async () => {
    await env.db.close();
  });
  beforeAll(async () => {
    env = await makeEnv();
  });

  it("measures the month share within the lines' service category", async () => {
    const { categoryOf, monthShares } = await import("../src/services/engagements.ts");
    const { loadDeliverables } = await import("../src/services/repo.ts");
    await paidEngagement(env, { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 0 });
    const shares = await asPlatform(env.db, null, async (tx) => {
      const d = await loadDeliverables(tx);
      const setupCat = categoryOf(["SET-FZ-LIC"], d);
      const taxCat = categoryOf(["VAT-RET"], d);
      expect(setupCat).not.toBe(taxCat);
      return { setup: await monthShares(tx, setupCat), tax: await monthShares(tx, taxCat) };
    });
    expect([...shares.setup.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(shares.tax.size).toBe(0); // no accounting work this month: a setup partner's share there is nothing
  });

  it("lets ops allocate by hand with a reason, within eligibility and the priced cost", async () => {
    const { engagementId } = await paidEngagement(env, { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 0 });
    const e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const open = e.allocations.find((a: any) => !a.acceptedAt);
    const declineBy = partnerKey(open.partner);
    await env.call(declineBy, "POST", `/api/allocations/${open.id}/respond`, { decision: "decline", reason: "Busy" });
    // Decline re-routes automatically; decline that too so the lines are open.
    const e2 = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    for (const a of e2.allocations.filter((x: any) => !x.acceptedAt && !x.declinedAt && !x.timedOutAt)) {
      await env.call(partnerKey(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "decline", reason: "Busy too" });
    }
    const e3 = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const openCodes = e3.lines.filter((l: any) => !l.partner).map((l: any) => l.code);
    expect(openCodes.length).toBeGreaterThan(0);
    const partners = (await env.call("ops", "GET", "/api/ops/overview")).body.partners;
    const tax = partners.find((p: any) => p.name.startsWith("Example Tax"));
    const setup = partners.find((p: any) => p.name.startsWith("Example Setup"));
    expect((await env.call("finance", "POST", `/api/ops/engagements/${engagementId}/allocate`, { partnerId: setup.id, codes: openCodes, reason: "Founder asked for them" })).status).toBe(403);
    const ineligible = await env.call("ops", "POST", `/api/ops/engagements/${engagementId}/allocate`, { partnerId: tax.id, codes: openCodes, reason: "Try the tax firm" });
    expect(ineligible.status).toBe(409);
    expect(ineligible.body.message).toMatch(/does not offer/);
    expect((await env.call("ops", "POST", `/api/ops/engagements/${engagementId}/allocate`, { partnerId: setup.id, codes: openCodes, reason: "ok" })).status).toBe(400);
    const manual = await env.call("ops", "POST", `/api/ops/engagements/${engagementId}/allocate`, { partnerId: setup.id, codes: openCodes, reason: "Client asked for this firm after the call" });
    expect(manual.status).toBe(200);
    const e4 = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const a = e4.allocations.find((x: any) => x.id === manual.body.allocationId);
    expect(a).toMatchObject({ reason: "manual_override", partner: setup.name });
    expect((await env.call("ops", "POST", `/api/ops/engagements/${engagementId}/allocate`, { partnerId: setup.id, codes: openCodes, reason: "again please" })).status).toBe(409);
    const ev = await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'allocation.manual'"));
    expect(ev.rows[0].data).toMatchObject({ partnerId: setup.id, reason: "Client asked for this firm after the call" });
    expect(ev.rows[0].data.engineWouldHaveChosen).toBeDefined();
    expect((await env.call("setup", "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" })).status).toBe(200);
  });
});

describe("offer document", () => {
  let env: TestEnv;
  afterAll(async () => {
    await env.db.close();
  });
  beforeAll(async () => {
    env = await makeEnv();
  });

  it("is a branded PDF for the client with scope, prices, VAT, assumptions and validity, and never a partner", async () => {
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1, addOns: ["BANK-ACC"] } });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    const offerId = built.body.offerIds[0];
    const get = (who: string) => env.app.inject({ method: "GET", url: `/api/client/offers/${offerId}/pdf`, headers: { authorization: `Bearer ${env.tokens[who]}` } });
    expect((await get("client")).statusCode).toBe(404); // unpublished
    await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
    const r = await get("client");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/pdf");
    const text = r.body;
    expect(text.startsWith("%PDF")).toBe(true);
    expect(text).toContain("TASEES, BY MKW ADVISORS");
    expect(text).toContain("Valid until");
    expect(text).toContain("VAT 5% on fees");
    expect(text).toContain("Government fees at cost");
    expect(text).toContain("ASSUMPTIONS AND EXCLUSIONS");
    expect(text).toContain("BANK-ACC");
    expect(text).not.toMatch(/Example Setup|Example Corporate|Example Tax|margin|partner cost|payout/i);
    expect((await get("setup")).statusCode).toBe(403);
    expect((await get("ops")).statusCode).toBe(200);
  });
});

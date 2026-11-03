import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/lib/auth.ts";
import { asPlatform, type SessionUser } from "../src/lib/context.ts";
import { clientReportPdf, publicReportPdf } from "../src/services/report.ts";
import { verifyAuditChain } from "../src/lib/audit.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E7E: the six pilot journeys (A to F), end to end over HTTP on a fresh environment with the seeded, unverified
 * catalogue and the in-memory adapters, as on the first day of the pilot. Each journey is the path one person walks,
 * in order, and asserts at every step the invariants the launch gate rests on: nothing commercial leaks to the wrong
 * party, nothing is sent, paid, released or filed without a person's action, the audit chain stays intact, and the
 * personal data a person gave can be exported and erased. The journeys run in order (each starts from what the
 * previous ones left), so the suite is one pilot day, not six isolated tests.
 *
 *   A  Founder: public assessment, saved result, preliminary report, review request with a call request.
 *   B  Adviser: the lead, the booked call, the next best action, the request's advice approved, the reviewed report.
 *   C  Client: proposal, acceptance, deposit, documents; prices seen, never cost or margin.
 *   D  Partner: allocation, evidence, MKW check, client approval, invoice, payout run; never the client price.
 *   E  Founder of MKW: funnel, coverage, dashboard, system health, audit chain; margin to finance and founder only.
 *   F  PDPL: export, consent withdrawal, erasure; payments, payouts and the audit chain survive.
 */
const MONEY = /margin|partner_?(unit|cost|org|id)|payout|rate_?card|professional_?fils|commission/i;
const walk = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), walk(x, out));
  else if (typeof v === "string") out.push(v);
  return out;
};
const noMoney = (v: unknown) => {
  for (const s of walk(v)) expect(s, s).not.toMatch(MONEY);
};
const pdfText = (buf: string) => buf.replace(/\\\(/g, "(").replace(/\\\)/g, ")");
const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
const partnerKey = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");

describe("the pilot journeys A to F (E7E)", () => {
  let env: TestEnv;
  const answers = { emirate: "Dubai", activity: "tech", customers: "international", visas: 2, budgetAed: 40_000, premises: "office", ownerType: "individuals", foreignTaxResident: false, startWithin: "1_month" };
  const founder = { company: "Pilot Ventures", name: "Pilot Founder", email: "pilot-founder@example.test" };
  const state: { code?: string; leadId?: string; requestId?: string; offerId?: string; engagementId?: string; clientUserId?: string; partners: string[] } = { partners: [] };
  const count = async (table: string, where = ""): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table} ${where}`))).rows[0]!.n;
  const chainIntact = async () => (await asPlatform(env.db, null, (tx) => verifyAuditChain(tx))).intact;
  const eng = async (who: string) => (await env.call(who, "GET", `/api/engagements/${state.engagementId}`)).body;

  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("A. a founder assesses, saves, downloads the preliminary report and asks for a review with a call; nothing is sent to them but the sign-in", async () => {
    const emails = env.emails.length;
    const a = await env.call("anon", "POST", "/api/public/assess", answers);
    expect(a.status).toBe(200);
    // Nothing is approved for public display on the first day: every statement is "to be verified" and no figure shows.
    expect(a.body.approved).toMatchObject({ statements: 0, places: 0 });
    noMoney(a.body);
    expect(JSON.stringify(a.body)).not.toMatch(/"costMinFils":\d|AED \d/);
    const saved = await env.call("anon", "POST", "/api/public/assessments", { answers, attribution: { source: "linkedin", campaign: "pilot" } });
    expect(saved.status).toBe(200);
    state.code = saved.body.code;
    const report = await env.send("anon", "GET", `/api/public/assessments/${state.code}/report.pdf`);
    expect(report.status).toBe(200);
    // E16: a designed PDF; what it says is the text the renderer drew, through the same service.
    expect(String(report.body).startsWith("%PDF-1.") && /\/FontFile2/.test(String(report.body))).toBe(true);
    const text = (await asPlatform(env.db, null, (tx) => publicReportPdf(tx, state.code!))).text.join(" ");
    expect(text).toMatch(/PRELIMINARY: general information from your answers/);
    expect(text).toMatch(/\bTO BE VERIFIED\b/);
    expect(text).not.toMatch(/AED [\d,]+ to AED/);
    expect(text).not.toMatch(MONEY);
    const events = await env.call("anon", "POST", "/api/public/events", { visitor: "pilotvisitor01", events: [{ stage: "visited" }, { stage: "assessment_started" }, { stage: "assessment_completed" }, { stage: "result_viewed" }, { stage: "result_saved" }], attribution: { source: "linkedin", campaign: "pilot" } });
    expect(events.status).toBe(200);
    const review = await env.call("anon", "POST", "/api/public/intake", { ...founder, consent: true, consentVersion: "2026-11-selector-v1", answers: { mode: "new_company", jurisdiction: "not_sure", ...answers }, code: state.code, consultation: { wanted: true, times: "Weekday mornings" }, attribution: { source: "linkedin", campaign: "pilot", visitor: "pilotvisitor01" } });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    // The founder received the sign-in and nothing else; no marketing consent was given, so none is recorded as given.
    const toFounder = env.emails.slice(emails).filter((e) => e.to === founder.email);
    expect(toFounder).toHaveLength(1);
    expect(toFounder[0]!.fromName).toBe("Tasees, by MKW Advisors");
    const lead = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((l: any) => l.company === founder.company);
    expect(lead).toBeTruthy();
    state.leadId = lead.id;
    const detail = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${lead.id}`)).body;
    expect(detail.consentHistory.filter((c: any) => c.given).map((c: any) => c.purpose)).toEqual(["service"]);
    expect(detail.requestId).toBeTruthy();
    state.requestId = detail.requestId;
    expect(await chainIntact()).toBe(true);
  });

  it("B. the adviser books the call, follows the next best action, a person approves the advice and the client gets the reviewed report", async () => {
    const before = { emails: env.emails.length, outbox: await count("outbox") };
    let d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${state.leadId}`)).body;
    expect(d.nextAction.action).toBe("Assign an owner");
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${state.leadId}/assign`, { ownerUserId: (await env.call("ops", "GET", "/api/me")).body.id, note: "Mine" })).status).toBe(200);
    d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${state.leadId}`)).body;
    expect(d.nextAction.action).toBe("Book the call they asked for");
    const at = new Date(env.clock.now.getTime() + 86_400_000).toISOString();
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${state.leadId}/consultation`, { at, note: "Teams link sent" })).status).toBe(200);
    d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${state.leadId}`)).body;
    expect(d.status).toBe("consultation");
    expect(d.nextAction.action).toBe("Follow up after the call");
    expect(d.notes.some((n: any) => n.kind === "followup" && /Call booked for/.test(n.body) && !n.done_at)).toBe(true); // the call is a queued follow-up
    // The founder signs in as the new client; the advice is held until a person approves it.
    env.tokens.pilot = await createSession(env.db, founder.email);
    state.clientUserId = (await env.call("pilot", "GET", "/api/me")).body.id;
    let home = (await env.call("pilot", "GET", "/api/client/home")).body;
    let req = home.requests.find((r: any) => r.id === state.requestId);
    expect(req.adviceStatus).toBe("pending_review");
    expect(req.advice).toBeNull();
    const scoping = (await env.call("ops", "GET", `/api/ops/requests/${state.requestId}/scoping`)).body;
    expect(scoping.advice.structure.recommendation).toBe("free_zone");
    expect(scoping.advice.hasUncertain).toBe(true); // the seeded catalogue is unverified on day one
    expect((await env.call("ops", "POST", `/api/ops/requests/${state.requestId}/scoping/approve`, {})).status).toBe(200);
    home = (await env.call("pilot", "GET", "/api/client/home")).body;
    req = home.requests.find((r: any) => r.id === state.requestId);
    expect(req.adviceStatus).toBe("approved");
    expect(req.advice.structure.recommendation).toBe("free_zone");
    noMoney(req.advice);
    const report = await env.send("pilot", "GET", `/api/client/requests/${state.requestId}/report.pdf`);
    expect(report.status).toBe(200);
    expect(String(report.body).startsWith("%PDF-1.") && /\/FontFile2/.test(String(report.body))).toBe(true);
    const pilotUser = (await env.call("pilot", "GET", "/api/me")).body as SessionUser;
    const text = (await clientReportPdf(env.db, pilotUser, state.requestId!)).text.join(" ");
    expect(text).toMatch(/REVIEWED by .+ at MKW Advisors on \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/\[UNCERTAIN\]/);
    expect(text).not.toMatch(MONEY);
    // Another client cannot read it; the partner cannot; the adviser's actions sent nothing to the founder.
    expect((await env.send("client", "GET", `/api/client/requests/${state.requestId}/report.pdf`)).status).toBe(404);
    expect((await env.send("setup", "GET", `/api/client/requests/${state.requestId}/report.pdf`)).status).toBe(403);
    expect(env.emails.slice(before.emails).filter((e) => e.to === founder.email)).toHaveLength(0);
    expect(await count("outbox")).toBe(before.outbox);
    expect(await chainIntact()).toBe(true);
  });

  it("C. the client receives the proposal, accepts, pays the deposit and uploads documents; prices only, never cost or margin", async () => {
    const built = await env.call("ops", "POST", `/api/ops/requests/${state.requestId}/build-offers`, { tiers: ["standard", "priority"] });
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    state.offerId = built.body.offerIds[0];
    // Unpublished: the client sees nothing yet, and the offer carries no published price in the audit.
    expect((await env.call("pilot", "GET", `/api/client/offers/${state.offerId}`)).status).toBe(404);
    for (const id of built.body.offerIds) { const p = await env.call("ops", "POST", `/api/ops/offers/${id}/publish`); expect(p.status, JSON.stringify(p.body)).toBe(200); }
    const offer = (await env.call("pilot", "GET", `/api/client/offers/${state.offerId}`)).body;
    expect(offer.status).toBe("published");
    expect(offer.lines.length).toBeGreaterThan(0);
    for (const l of offer.lines) {
      expect(l).toHaveProperty("clientUnitPrice");
      expect(l).not.toHaveProperty("partnerUnitCost");
    }
    noMoney(offer);
    const opsView = (await env.call("ops", "GET", `/api/ops/offers/${state.offerId}`)).body;
    expect(JSON.stringify(opsView)).not.toMatch(/"margin/); // ops never sees the margin (rule 1)
    const proposal = await env.send("pilot", "GET", `/api/client/offers/${state.offerId}/pdf`);
    expect(proposal.status).toBe(200);
    expect(pdfText(String(proposal.body))).toMatch(/Tasees, by MKW Advisors/i);
    expect(pdfText(String(proposal.body))).not.toMatch(/Example Setup|Example Corporate/); // never a partner's name
    // Only the account owner accepts; the sibling tier is withdrawn; an engagement waits for the deposit.
    const accepted = await env.call("pilot", "POST", `/api/client/offers/${state.offerId}/accept`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    state.engagementId = accepted.body.engagementId;
    let e = await eng("pilot");
    expect(e.engagement.status).toBe("awaiting_payment");
    noMoney(e);
    expect((await eng("ops")).allocations).toEqual([]); // nobody is allocated before the deposit
    const deposit = e.payments.find((p: any) => p.kind === "deposit");
    expect(deposit.status).toBe("pending");
    // Nothing is paid by itself: finance records the transfer, then allocation starts.
    expect((await env.call("ops", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "TT-PILOT-1" })).status).toBe(403);
    expect((await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "TT-PILOT-1" })).status).toBe(200);
    e = await eng("ops");
    expect(e.engagement.status).toBe("allocating");
    expect(e.allocations.length).toBeGreaterThan(0);
    // The funnel now shows the pilot source from the visit to the acceptance, once.
    const f = (await env.call("founder", "GET", "/api/ops/pipeline/funnel")).body;
    const row = f.bySource.find((r: any) => r.source === "linkedin" && r.campaign === "pilot");
    expect(row).toMatchObject({ visitors: 1, completed: 1, saved: 1, leads: 1, consultations: 1, proposals: 1, accepted: 1, engagements: 1 });
    expect(row.revenueFils).toBeGreaterThan(0);
    noMoney(f);
    expect(await chainIntact()).toBe(true);
  });

  it("D. the partners accept, deliver with evidence, MKW checks, the client approves; payouts wait for invoices and finance; the client price never reaches a partner", async () => {
    let e = await eng("ops");
    for (const a of e.allocations.filter((x: any) => !x.acceptedAt)) {
      const who = partnerKey(a.partner);
      const home = (await env.call(who, "GET", "/api/partner/home")).body;
      expect(JSON.stringify(home)).not.toMatch(/clientUnitPrice|clientTotal|margin/);
      expect((await env.call(who, "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" })).status).toBe(200);
    }
    e = await eng("ops");
    expect(e.engagement.status).toBe("in_delivery");
    const partnerOfCode = new Map<string, string>(e.lines.map((l: any) => [l.code, partnerKey(l.partner)]));
    state.partners = [...new Set(partnerOfCode.values())];
    // The client's document checklist opens on acceptance; the client uploads, and the files stay with the parties.
    const docs = (await eng("pilot")).documentRequests;
    expect(docs.length).toBeGreaterThanOrEqual(1);
    for (const r of docs) expect((await env.call("pilot", "POST", `/api/document-requests/${r.id}/upload`, { fileName: `${r.kind}.pdf`, contentBase64: pdf })).status).toBe(200);
    expect(env.emails.some((m) => m.subject.startsWith("Documents needed") && m.to === founder.email)).toBe(true);
    for (const m of e.milestones) {
      const who = partnerOfCode.get(m.code)!;
      expect((await env.call(who, "POST", `/api/milestones/${m.id}/submit`)).status).toBe(400); // no evidence, no submission (rule 4)
      for (const type of m.evidenceRequired) expect((await env.call(who, "POST", `/api/milestones/${m.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: pdf })).status).toBe(200);
      expect((await env.call(who, "POST", `/api/milestones/${m.id}/submit`)).status).toBe(200);
      expect((await env.call("pilot", "POST", `/api/milestones/${m.id}/review`, { approve: true })).status).toBe(409); // MKW checks first
      expect((await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true })).status).toBe(200);
      expect((await env.call("pilot", "POST", `/api/milestones/${m.id}/review`, { approve: true })).status).toBe(200);
    }
    e = await eng("ops");
    expect(e.engagement.status).toBe("completed");
    expect(e.payouts.length).toBeGreaterThan(0);
    expect(e.payouts.every((p: any) => p.status === "eligible")).toBe(true);
    // A partner sees its own cost and payout, never the client's price; staff see neither.
    for (const who of new Set(partnerOfCode.values())) {
      const view = await eng(who);
      for (const l of view.lines) { expect(l).not.toHaveProperty("clientUnitPrice"); expect(l).toHaveProperty("partnerUnitCost"); }
      expect(JSON.stringify(view)).not.toMatch(/clientUnitPrice|clientTotal|margin/);
    }
    // No payout leaves without the partner's invoice and finance's action; the balance is a pending payment.
    expect(e.payments.find((p: any) => p.kind === "balance").status).toBe("pending");
    const payout = e.payouts[0];
    expect((await env.call("finance", "POST", `/api/ops/payouts/${payout.id}/release`)).status).toBe(409);
    let ok = 0;
    for (const who of ["setup", "corp", "tax"]) {
      const r = await env.call(who, "POST", `/api/payouts/${payout.id}/invoice`, { number: "INV-PILOT-1", amountAed: payout.amount / 100, fileName: "inv.pdf", contentBase64: pdf });
      if (r.status === 200) ok += 1;
    }
    expect(ok).toBe(1); // exactly the partner the payout belongs to
    expect((await env.call("ops", "POST", `/api/ops/payouts/${payout.id}/release`)).status).toBe(403);
    expect((await env.call("finance", "POST", `/api/ops/payouts/${payout.id}/release`)).status).toBe(200);
    // The remaining payouts go through a payout run: each needs its partner's invoice and bank details, finance
    // exports the bank file and marks the run paid; nothing moves money by itself.
    for (const who of state.partners) expect((await env.call(who, "PUT", "/api/partner/bank", { beneficiary: `${who} LLC`, iban: "AE07 0331 2345 6789 0123 456", bank: "Emirates NBD" })).status).toBe(200);
    e = await eng("ops");
    const remaining = e.payouts.filter((p: any) => p.status === "eligible");
    expect(remaining.length).toBeGreaterThan(0);
    for (const p of remaining) {
      let uploaded = 0;
      for (const who of state.partners) {
        const r = await env.call(who, "POST", `/api/payouts/${p.id}/invoice`, { number: `INV-PILOT-${p.id.slice(0, 6)}`, amountAed: p.amount / 100, fileName: "inv.pdf", contentBase64: pdf });
        if (r.status === 200) uploaded += 1;
      }
      expect(uploaded).toBe(1); // one partner per payout, never another's
    }
    expect((await env.call("ops", "POST", "/api/ops/payout-runs")).status).toBe(403);
    const run = await env.call("finance", "POST", "/api/ops/payout-runs");
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    const file = await env.send("finance", "GET", `/api/ops/payout-runs/${run.body.id}/file`);
    expect(file.status).toBe(200);
    expect(String(file.body)).not.toMatch(/Tasees/); // the bank file is MKW's, never branded Tasees to a partner's bank
    expect((await env.call("finance", "POST", `/api/ops/payout-runs/${run.body.id}/paid`, { bankReference: "BULK-PILOT-1" })).status).toBe(200);
    e = await eng("ops");
    expect(e.payouts.every((p: any) => p.status === "released")).toBe(true);
    // Everything addressed to a partner comes from MKW Advisors and never carries the name Tasees (rule 10).
    const toPartners = env.emails.filter((m) => [EMAILS.setup, EMAILS.corp, EMAILS.tax].includes(m.to as any));
    expect(toPartners.length).toBeGreaterThan(0);
    for (const m of toPartners) { expect(m.fromName).toBe("MKW Advisors"); expect(`${m.subject} ${m.text}`).not.toMatch(/Tasees/); }
    // Every paid amount was recorded by a person with a bank reference; the provider double charged nothing.
    const paid = (await asPlatform(env.db, null, (tx) => tx.query<{ provider_ref: string | null }>("select provider_ref from payments where engagement_id = $1 and status = 'paid'", [state.engagementId]))).rows;
    expect(paid.length).toBeGreaterThan(0);
    for (const p of paid) expect(p.provider_ref).toMatch(/^TT-PILOT/);
    expect(await chainIntact()).toBe(true);
  });

  it("E. the founder of MKW reads the business: funnel, coverage, dashboard, system; margin reaches finance and the founder only", async () => {
    const dash = await env.call("founder", "GET", "/api/admin/dashboard");
    expect(dash.status).toBe(200);
    const opsDash = (await env.call("ops", "GET", "/api/admin/dashboard")).body;
    expect(opsDash.seesMargin).toBe(false);
    expect(JSON.stringify(opsDash)).not.toMatch(/marginFils|marginBp/); // ops reads the dashboard without the margin figures
    expect(dash.body.seesMargin).toBe(true);
    expect(dash.body.current).toHaveProperty("marginFils");
    expect((await env.call("pilot", "GET", "/api/admin/dashboard")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/admin/dashboard")).status).toBe(403);
    const finance = await env.call("finance", "GET", `/api/ops/offers/${state.offerId}`);
    expect(JSON.stringify(finance.body)).toMatch(/margin/i);
    expect(JSON.stringify((await env.call("ops", "GET", `/api/ops/offers/${state.offerId}`)).body)).not.toMatch(/"margin/);
    const coverage = await env.call("founder", "GET", "/api/admin/coverage");
    expect(coverage.status).toBe(200);
    expect(coverage.body.places.total).toBeGreaterThan(0);
    expect(coverage.body.fields).toBeTruthy();
    expect((await env.call("pilot", "GET", "/api/admin/coverage")).status).toBe(403);
    const funnel = (await env.call("founder", "GET", "/api/ops/pipeline/funnel")).body;
    expect(funnel.totals.won + funnel.totals.lost + funnel.totals.leadsAll).toBeGreaterThan(0);
    expect(funnel.attention.find((a: any) => a.company === founder.company)).toBeUndefined(); // the client is on the engagement
    const system = await env.call("founder", "GET", "/api/ops/system");
    expect(system.status).toBe(200);
    expect((await env.call("pilot", "GET", "/api/ops/system")).status).toBe(403);
    const health = (await env.call("anon", "GET", "/api/health")).body;
    expect(health.ok).toBe(true);
    // The audit trail is readable by ops and intact after a whole pilot day.
    const audit = await env.call("ops", "GET", "/api/ops/audit");
    expect(audit.status).toBe(200);
    expect((await env.call("pilot", "GET", "/api/ops/audit")).status).toBe(403);
    expect(await chainIntact()).toBe(true);
  });

  it("F. the founder withdraws marketing consent, exports their data and is erased; payments, payouts and the audit chain survive", async () => {
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${state.leadId}/consent-withdraw`, { purpose: "marketing", note: "By email on the pilot's second week" })).status).toBe(200);
    const d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${state.leadId}`)).body;
    expect(d.consentHistory.filter((c: any) => c.purpose === "marketing").at(-1).given).toBe(false);
    // Export: the person's own data, nothing commercial of ours, nobody else's.
    const exp = await env.call("ops", "POST", `/api/admin/users/${state.clientUserId}/export`);
    expect(exp.status).toBe(200);
    const raw = JSON.stringify(exp.body);
    expect(raw).toContain(founder.email);
    expect(raw).not.toMatch(/partnerUnitCost|partner_unit|margin/i); // the export lists its own sections (payouts released: none for a client)
    expect(raw).not.toContain(EMAILS.client);
    const before = await asPlatform(env.db, null, async (tx) => ({
      payments: (await tx.query("select id, amount_fils, status from payments order by id")).rows,
      payouts: (await tx.query("select id, amount_fils, status from payouts order by id")).rows,
      audit: await tx.query<{ n: number }>("select count(*)::int as n from audit_events"),
    }));
    expect((await env.call("ops", "POST", `/api/admin/users/${state.clientUserId}/erase`, { confirm: "ERASE" })).status).toBe(403);
    const erased = await env.call("founder", "POST", `/api/admin/users/${state.clientUserId}/erase`, { confirm: "ERASE" });
    expect(erased.status).toBe(200);
    expect(erased.body.changed).toBe(true);
    const after = await asPlatform(env.db, null, async (tx) => ({
      user: (await tx.query<{ email: string; status: string }>("select email, status from users where id = $1", [state.clientUserId])).rows[0]!,
      lead: (await tx.query<{ email: string; status: string }>("select email, status from leads where id = $1", [state.leadId])).rows[0]!,
      payments: (await tx.query("select id, amount_fils, status from payments order by id")).rows,
      payouts: (await tx.query("select id, amount_fils, status from payouts order by id")).rows,
      audit: await tx.query<{ n: number }>("select count(*)::int as n from audit_events"),
      chain: await verifyAuditChain(tx),
    }));
    expect(after.user.status).toBe("erased");
    expect(after.user.email).not.toContain("pilot-founder");
    expect(after.lead.email).not.toContain("pilot-founder");
    expect(after.payments).toEqual(before.payments);
    expect(after.payouts).toEqual(before.payouts);
    expect(after.audit.rows[0]!.n).toBeGreaterThan(before.audit.rows[0]!.n);
    expect(after.chain.intact).toBe(true);
    // The old session is gone; the partner still sees the engagement with a tombstoned client.
    expect((await env.call("pilot", "GET", "/api/me")).status).toBe(401);
    const partnerAfter = await env.call(state.partners[0]!, "GET", `/api/engagements/${state.engagementId}`);
    expect(partnerAfter.status).toBe(200);
    expect(JSON.stringify(partnerAfter.body)).not.toContain("pilot-founder");
  });
});

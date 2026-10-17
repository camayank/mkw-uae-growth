import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** O8: dashboards match the database, accounting export, compliance calendar with evidence and reminders. */

const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
const day = 24 * 3600 * 1000;
const partnerKey = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");

async function deliverEngagement(env: TestEnv, answers: object) {
  const req = await env.call("client", "POST", "/api/requests", { answers });
  const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
  const offerId = built.body.offerIds[0];
  await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
  const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId as string;
  const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
  await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-TT-1" });
  let e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
  for (const a of e.allocations.filter((x: any) => !x.acceptedAt)) await env.call(partnerKey(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
  e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
  for (const m of e.milestones) {
    const who = partnerKey(e.lines.find((l: any) => l.code === m.code).partner);
    for (const type of m.evidenceRequired) await env.call(who, "POST", `/api/milestones/${m.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: pdf });
    await env.call(who, "POST", `/api/milestones/${m.id}/submit`);
    await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true });
    await env.call("client", "POST", `/api/milestones/${m.id}/review`, { approve: true });
  }
  e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
  expect(e.engagement.status).toBe("completed");
  const balance = e.payments.find((p: any) => p.kind === "balance");
  await env.call("finance", "POST", `/api/ops/payments/${balance.id}/mark-paid`, { reference: "BANK-TT-2" });
  return engagementId;
}

describe("dashboards and accounting export", () => {
  let env: TestEnv;
  let engagementId: string;
  beforeAll(async () => {
    env = await makeEnv();
    // The founder has set the TRN so invoices issue (O3).
    await env.call("founder", "PUT", "/api/admin/company", { trn: "100123456700003", note: "set for the test" });
    engagementId = await deliverEngagement(env, { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1, addOns: ["BANK-ACC"] });
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("founder figures equal the database rows; ops sees the same without margin", async () => {
    const period = env.clock.now.toISOString().slice(0, 7);
    const f = await env.call("founder", "GET", `/api/admin/dashboard?period=${period}`);
    expect(f.status).toBe(200);
    const c = f.body.current;
    const db = await asPlatform(env.db, null, async (tx) => ({
      net: (await tx.query<any>("select coalesce(sum(net_fils),0)::bigint as n from invoices where status='issued' and kind='tax_invoice'")).rows[0].n,
      vat: (await tx.query<any>("select coalesce(sum(vat_fils),0)::bigint as n from invoices where status='issued' and kind='tax_invoice'")).rows[0].n,
      paid: (await tx.query<any>("select coalesce(sum(amount_fils),0)::bigint as n from payments where status='paid'")).rows[0].n,
      due: (await tx.query<any>("select coalesce(sum(amount_fils),0)::bigint as n from payouts where status='eligible'")).rows[0].n,
      margin: (await tx.query<any>("select coalesce(sum(margin_fils),0)::bigint as n from offers where accepted_at is not null")).rows[0].n,
      done: (await tx.query<any>("select count(*)::int as n from milestones where status='client_approved'")).rows[0].n,
    }));
    expect(c.revenueNetFils).toBe(Number(db.net));
    expect(c.revenueNetFils).toBeGreaterThan(0);
    expect(c.vatFils).toBe(Number(db.vat));
    expect(c.cashCollectedFils).toBe(Number(db.paid));
    expect(c.payoutsDueFils).toBe(Number(db.due));
    expect(c.marginFils).toBe(Number(db.margin));
    expect(c.marginBp).toBeGreaterThan(0);
    expect(c.milestonesDone).toBe(db.done);
    expect(c.onTimeRate).toBe(1);
    expect(c.requests).toBe(1);
    expect(c.offersAccepted).toBe(1);
    expect(c.requestToAcceptance).toBe(1);
    expect(c.engagementsCompleted).toBe(1);
    expect(Object.keys(c.partnerShareByCategory)).toContain("Setup");
    for (const cat of Object.values(c.partnerShareByCategory) as Record<string, number>[]) expect(Object.values(cat).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(f.body.previous.revenueNetFils).toBe(0);
    expect(f.body.seesMargin).toBe(true);
    const ops = await env.call("ops", "GET", `/api/admin/dashboard?period=${period}`);
    expect(ops.body.current.revenueNetFils).toBe(c.revenueNetFils);
    expect(ops.body.current.marginFils).toBeUndefined();
    expect(JSON.stringify(ops.body)).not.toMatch(/margin[A-Z]/);
    expect(ops.body.seesMargin).toBe(false);
    expect((await env.call("founder", "GET", "/api/admin/dashboard?period=last-month")).status).toBe(400);
    expect((await env.call("client", "GET", `/api/admin/dashboard?period=${period}`)).status).toBe(403);
    expect((await env.call("setup", "GET", `/api/admin/dashboard?period=${period}`)).status).toBe(403);
  });

  it("partner dashboard is the firm's own: jobs, on-time, payouts, scorecard; never prices", async () => {
    await env.call("ops", "POST", "/api/ops/scorecards/recompute");
    const d = await env.call("setup", "GET", "/api/partner/dashboard");
    expect(d.status).toBe(200);
    expect(d.body.jobs.find((j: any) => j.status === "completed").n).toBe(1);
    expect(d.body.milestones.done).toBeGreaterThan(0);
    expect(d.body.milestones.onTimeRate).toBe(1);
    expect(d.body.payouts.some((p: any) => p.status === "eligible")).toBe(true);
    expect(d.body.scorecards[0].score).toBeGreaterThanOrEqual(60);
    expect(JSON.stringify(d.body)).not.toMatch(/client|margin|Example Corporate|Example Tax/i);
    expect((await env.call("client", "GET", "/api/partner/dashboard")).status).toBe(403);
  });

  it("exports sales, payments and payouts as formula-safe CSV that matches the rows; margin for finance only; audited", async () => {
    const d = env.clock.now.toISOString().slice(0, 10);
    const get = (who: string, set: string, from = "2026-01-01", to = d) => env.app.inject({ method: "GET", url: `/api/admin/accounting/export?set=${set}&from=${from}&to=${to}`, headers: { authorization: `Bearer ${env.tokens[who]}` } });
    const sales = await get("finance", "sales");
    expect(sales.statusCode).toBe(200);
    expect(sales.headers["content-type"]).toContain("text/csv");
    const lines = sales.body.trim().split("\r\n");
    expect(lines[0]).toBe("Date,Type,Number,Reverses,Client,Engagement,Net AED,VAT AED,Disbursements AED,Gross AED,Currency,Supply date,Status");
    const issued = (await asPlatform(env.db, null, (tx) => tx.query<any>("select number, net_fils from invoices where status='issued' order by number"))).rows;
    expect(lines.length - 1).toBe(issued.length);
    expect(issued.length).toBe(2);
    expect(lines[1]).toContain(issued[0].number);
    expect(lines[1]).toContain((issued[0].net_fils / 100).toFixed(2));
    const payments = await get("ops", "payments");
    expect(payments.statusCode).toBe(200);
    expect(payments.body.trim().split("\r\n").length - 1).toBe(2);
    expect(payments.body).toContain("Received");
    const payouts = await get("finance", "payouts");
    expect(payouts.body.trim().split("\r\n").length).toBe(1); // nothing released yet
    expect((await get("ops", "margin")).statusCode).toBe(403);
    const margin = await get("finance", "margin");
    expect(margin.statusCode).toBe(200);
    expect(margin.body).toContain("Margin AED");
    expect((await get("client", "sales")).statusCode).toBe(403);
    expect((await get("finance", "sales", "2026-02-01", "2026-01-01")).statusCode).toBe(400);
    // A client named like a formula is neutralised.
    await asPlatform(env.db, null, (tx) => tx.query("update orgs set name = '=HYPERLINK(\"x\")' where type = 'client'"));
    const again = await get("finance", "sales");
    expect(again.body).toContain("'=HYPERLINK");
    expect(again.body).not.toMatch(/,=HYPERLINK/);
    await asPlatform(env.db, null, (tx) => tx.query("update orgs set name = 'Sample Trading FZ-LLC' where type = 'client'"));
    const log = await env.call("finance", "GET", "/api/admin/accounting/exports");
    expect(log.body.length).toBe(5); // refused exports are not exports
    expect(log.body.filter((l: any) => l.setName === "sales").every((l: any) => l.rows === 2)).toBe(true);
    expect(log.body.map((l: any) => l.setName).sort()).toEqual(["margin", "payments", "payouts", "sales", "sales"]);
    const ev = await asPlatform(env.db, null, (tx) => tx.query<any>("select count(*)::int as n from audit_events where action = 'accounting.exported'"));
    expect(ev.rows[0].n).toBe(5);
  });

  it("compliance calendar: generated pending review, confirmed by ops before the client sees it, met only with checked evidence, rolled forward, reminded", async () => {
    const ops = await env.call("ops", "GET", "/api/ops/compliance");
    const pending = ops.body.filter((o: any) => o.status === "pending_review" && o.engagementId === engagementId);
    expect(pending.map((o: any) => o.kind).sort()).toEqual(["licence_renewal", "ubo_update", "visa_expiry"]);
    expect(pending.every((o: any) => o.confidence === "UNCERTAIN")).toBe(true);
    expect((await env.call("ops", "GET", "/api/ops/overview")).body.exceptions.filter((x: any) => x.kind === "obligation")).toHaveLength(3);
    // The client sees nothing yet: the API and the database policy both hide pending rows.
    expect((await env.call("client", "GET", "/api/client/compliance")).body).toEqual([]);
    const clientUser = (await env.call("client", "GET", "/api/me")).body;
    expect((await asUser(env.db, clientUser, (tx) => tx.query("select id from obligations"))).rows).toEqual([]);
    await expect(asUser(env.db, clientUser, (tx) => tx.query("select met_note from obligations"))).rejects.toThrow(/permission denied/);
    const licence = pending.find((o: any) => o.kind === "licence_renewal");
    expect((await env.call("finance", "POST", `/api/ops/obligations/${licence.id}/confirm`, { note: "x" })).status).toBe(403);
    expect((await env.call("ops", "POST", `/api/ops/obligations/${licence.id}/confirm`, { note: "" })).status).toBe(400);
    const confirmed = await env.call("ops", "POST", `/api/ops/obligations/${licence.id}/confirm`, { dueDate: "2027-10-20", note: "Date on the issued licence" });
    expect(confirmed.status).toBe(200);
    const visa = pending.find((o: any) => o.kind === "visa_expiry");
    expect((await env.call("ops", "POST", `/api/ops/obligations/${visa.id}/waive`, { reason: "Visa not taken up" })).status).toBe(200);
    let mine = (await env.call("client", "GET", "/api/client/compliance")).body;
    expect(mine.map((o: any) => o.kind).sort()).toEqual(["licence_renewal", "visa_expiry"]);
    expect(mine.find((o: any) => o.kind === "licence_renewal")).toMatchObject({ dueDate: "2027-10-20", status: "open", confidence: "confirmed" });
    expect(mine[0].metNote).toBeUndefined();
    // Met needs evidence, then MKW's check; a partner cannot upload; another client cannot see it.
    expect((await env.call("ops", "POST", `/api/ops/obligations/${licence.id}/met`, {})).status).toBe(409);
    expect((await env.call("setup", "POST", `/api/obligations/${licence.id}/evidence`, { fileName: "renewed.pdf", contentBase64: pdf })).status).toBe(403);
    expect((await env.call("client", "POST", `/api/obligations/${licence.id}/evidence`, { fileName: "renewed.pdf", contentBase64: pdf })).status).toBe(200);
    expect((await env.call("ops", "GET", "/api/ops/overview")).body.exceptions.some((x: any) => x.kind === "obligation_evidence" && x.ref === licence.id)).toBe(true);
    const file = await env.app.inject({ method: "GET", url: `/api/obligations/${licence.id}/file`, headers: { authorization: `Bearer ${env.tokens.client}` } });
    expect(file.statusCode).toBe(200);
    expect((await env.app.inject({ method: "GET", url: `/api/obligations/${licence.id}/file`, headers: { authorization: `Bearer ${env.tokens.setup}` } })).statusCode).toBe(404);
    const met = await env.call("ops", "POST", `/api/ops/obligations/${licence.id}/met`, { note: "Renewed licence checked on the DED portal" });
    expect(met.status).toBe(200);
    expect(met.body.nextId).toBeTruthy();
    mine = (await env.call("client", "GET", "/api/client/compliance")).body;
    const next = mine.find((o: any) => o.id === met.body.nextId);
    expect(next).toMatchObject({ kind: "licence_renewal", dueDate: "2028-10-20", status: "open", confidence: "confirmed" });
    expect(mine.find((o: any) => o.id === licence.id).status).toBe("met");
    // A custom obligation by ops; reminders at 30 and 7 days and once when overdue.
    const custom = await env.call("ops", "POST", `/api/ops/clients/${clientUser.orgId}/obligations`, { kind: "custom", title: "Chamber of commerce membership", dueDate: env.clock.now.toISOString().slice(0, 10), recurrence: "yearly", basis: "Client asked" });
    expect(custom.status).toBe(200);
    env.clock.now = new Date(env.clock.now.getTime() + 1 * day);
    let jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.obligationReminders).toBe(1);
    const overdue = env.emails.filter((m) => /^Overdue: Chamber/.test(m.subject));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.fromName).toBe("Tasees, by MKW Advisors");
    expect(overdue[0]!.text).toContain("We do not file on your behalf");
    jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.obligationReminders).toBe(0);
    const soon = await env.call("ops", "POST", `/api/ops/clients/${clientUser.orgId}/obligations`, { kind: "vat_return", title: "VAT return Q4", dueDate: new Date(env.clock.now.getTime() + 20 * day).toISOString().slice(0, 10), recurrence: "quarterly" });
    expect(soon.status).toBe(200);
    jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.obligationReminders).toBe(1);
    expect(env.emails.filter((m) => /^Reminder: VAT return Q4/.test(m.subject))).toHaveLength(1);
    env.clock.now = new Date(env.clock.now.getTime() + 14 * day);
    jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.obligationReminders).toBe(1);
    expect(env.emails.filter((m) => /^Reminder: VAT return Q4.*7 days/.test(m.subject))).toHaveLength(1);
    const actions = await asPlatform(env.db, null, (tx) => tx.query<any>("select action from audit_events where action like 'obligation.%' order by id"));
    expect(actions.rows.map((a) => a.action)).toEqual(expect.arrayContaining(["obligation.generated", "obligation.confirmed", "obligation.waived", "obligation.evidence_uploaded", "obligation.met", "obligation.rolled_forward", "obligation.added", "obligation.reminded"]));
  });
});

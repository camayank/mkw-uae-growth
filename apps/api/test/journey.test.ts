import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { UPLOAD_RULES } from "../src/lib/storage.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** O12 client journey: the next action, the timeline, the proposal, the intake preview and the upload rules. */

const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
const rows = <T = any>(env: TestEnv, sql: string, params: unknown[] = []) => asPlatform(env.db, null, async (tx) => (await tx.query<T & Record<string, unknown>>(sql, params)).rows);
const partnerKey = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");
const ANSWERS = { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 };
// Nothing a client sees may carry what partners are paid or what MKW keeps.
const NO_MONEY_LEAK = /margin|partnerUnit|partner_unit|payout|partnerCost|cap_unit|capUnit/i;

describe("client journey", () => {
  let env: TestEnv;
  let offerId: string;
  let engagementId: string;
  const home = async () => (await env.call("client", "GET", "/api/client/home")).body;
  beforeAll(async () => {
    env = await makeEnv(); // Monday 19 October 2026, 10:00 in Dubai
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("with nothing on, says so and what to do instead", async () => {
    const h = await home();
    expect(h.nextActions).toEqual([]);
    expect(h.whatsNext).toMatch(/nothing in progress|in progress|next/i);
  });

  it("an offer to decide comes first, with its expiry; the proposal says how the work runs and what is paid when", async () => {
    const req = await env.call("client", "POST", "/api/requests", { answers: ANSWERS });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard", "essential"] });
    for (const id of built.body.offerIds) expect((await env.call("ops", "POST", `/api/ops/offers/${id}/publish`)).status).toBe(200);
    offerId = built.body.offerIds[0];
    const h = await home();
    expect(h.nextActions).toHaveLength(1);
    expect(h.nextActions[0]).toMatchObject({ kind: "offer", title: "Choose one of your 2 offers", link: expect.stringMatching(/^#\/offer\//) });
    expect(h.nextActions[0].due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(h.nextActions[0].why).toMatch(/Nothing starts until you accept one/);
    const o = (await env.call("client", "GET", `/api/client/offers/${offerId}`)).body;
    const p = o.proposal;
    expect(p.plan.length).toBe(o.lines.length);
    expect(p.plan[0].steps.length).toBeGreaterThan(0);
    expect(p.estimateWorkingDays).toBe(Math.max(...p.plan.map((x: any) => x.workingDays)));
    expect(p.depositFils + p.balanceFils).toBe(o.professional + o.mkwFees + o.vat + o.government);
    expect(p.guaranteeBp).toBe(1000);
    expect(p.reviewWorkingDays).toBe(5);
    // A fee note is a sentence for the client, never the internal reason.
    for (const n of Object.values(p.feeNotes) as string[]) expect(n).not.toMatch(/UNCERTAIN|verify it before|ops|review/);
    expect(JSON.stringify(o)).not.toMatch(NO_MONEY_LEAK);
  });

  it("after acceptance the deposit is next; the timeline shows every step; the proposal's deposit is what is charged", async () => {
    const proposal = (await env.call("client", "GET", `/api/client/offers/${offerId}`)).body.proposal;
    engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    const e = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body;
    expect(e.journey.nextAction).toMatchObject({ kind: "payment", engagementId });
    expect(e.journey.nextAction.title).toMatch(/^Pay the deposit: AED [\d,]+\.\d{2}$/);
    const deposit = e.payments.find((x: any) => x.kind === "deposit");
    expect(deposit.amount).toBe(proposal.depositFils);
    const kinds = e.journey.timeline.map((t: any) => t.kind);
    expect(kinds[0]).toBe("accepted");
    expect(kinds[1]).toBe("payment");
    expect(kinds.at(-1)).toBe("completed");
    expect(e.journey.timeline.filter((t: any) => t.kind === "step")).toHaveLength(e.milestones.length);
    expect(e.journey.timeline[1]).toMatchObject({ state: "now", note: "Due now" });
    // The offer is no longer an action anywhere.
    expect((await home()).nextActions.map((a: any) => a.kind)).toEqual(["payment"]);
  });

  it("documents asked for, then a step to approve with its automatic approval date, which a holiday moves", async () => {
    const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
    await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-TT-1" });
    let e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    for (const a of e.allocations.filter((x: any) => !x.acceptedAt)) await env.call(partnerKey(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
    e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    let h = await home();
    expect(h.nextActions.map((a: any) => a.kind)).toEqual(["documents"]);
    // Each kind of document once, and how many steps wait for them.
    expect(h.nextActions[0].why).toMatch(/passport copy/i);
    expect(h.nextActions[0].why.match(/passport copy/gi)).toHaveLength(1);
    expect(h.nextActions[0].why).toMatch(/\d+ steps cannot finish without them\.$/);
    // Monday 26 October is declared a holiday: five working days from Monday 19th now end on Tuesday 27th.
    expect((await env.call("founder", "PUT", "/api/admin/holidays", { date: "2026-10-26", name: "Test holiday", status: "confirmed", reason: "test" })).status).toBe(200);
    const m = e.milestones[0];
    const who = partnerKey(e.lines.find((l: any) => l.code === m.code).partner);
    for (const type of m.evidenceRequired) await env.call(who, "POST", `/api/milestones/${m.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: pdf });
    await env.call(who, "POST", `/api/milestones/${m.id}/submit`);
    // While MKW checks, the timeline says so; nothing is asked of the client for it yet.
    let c = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body;
    expect(c.journey.timeline.find((t: any) => t.ref === m.id)).toMatchObject({ state: "mkw", note: "Evidence handed in: MKW Advisors is checking it" });
    expect((await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true })).status).toBe(200);
    h = await home();
    expect(h.nextActions.map((a: any) => a.kind)).toEqual(["approve", "documents"]);
    expect(h.nextActions[0]).toMatchObject({ title: `Approve: ${m.name}`, due: "2026-10-27", ref: m.id });
    expect(h.nextActions[0].why).toMatch(/approved automatically on 27 Oct 2026/);
    c = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body;
    expect(c.journey.nextAction.kind).toBe("approve");
    expect(c.journey.timeline.find((t: any) => t.ref === m.id)).toMatchObject({ state: "now" });
    expect(JSON.stringify(c.journey)).not.toMatch(NO_MONEY_LEAK);
    expect(JSON.stringify(h)).not.toMatch(NO_MONEY_LEAK);
  });

  it("when nothing is needed, says what is happening and when", async () => {
    const c = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body;
    for (const r of c.documentRequests) await env.call("client", "POST", `/api/document-requests/${r.id}/upload`, { fileName: "doc.pdf", contentBase64: pdf });
    const step = c.journey.nextAction.ref;
    expect((await env.call("client", "POST", `/api/milestones/${step}/review`, { approve: true })).status).toBe(200);
    const after = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body.journey;
    expect(after.nextAction).toBeNull();
    expect(after.whatsNext).toMatch(/is (next|in progress)(, expected by \d+ \w+ \d{4})?\. We will tell you when it needs you\./);
  });

  it("a confirmed filing date within 30 days is an action, with the rule that we do not file", async () => {
    const clientOrg = (await env.call("client", "GET", "/api/me")).body.orgId;
    await asPlatform(env.db, null, (tx) =>
      tx.query("insert into obligations (client_org_id, kind, title, due_date, status, confidence) values ($1, 'vat_return', 'VAT return Q3 2026', '2026-10-28', 'open', 'confirmed')", [clientOrg]),
    );
    const f = (await home()).nextActions.find((a: any) => a.kind === "filing");
    expect(f).toMatchObject({ title: "Due: VAT return Q3 2026", due: "2026-10-28", link: "#/compliance" });
    expect(f.why).toMatch(/We do not file for you\./);
  });

  it("partners and other clients never see a client's journey", async () => {
    expect((await env.call("setup", "GET", "/api/client/home")).status).toBe(403);
    const partnerView = (await env.call(partnerKey("Example Setup"), "GET", `/api/engagements/${engagementId}`)).body;
    expect(partnerView.journey).toBeUndefined();
  });
});

describe("intake preview and upload rules", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("shows the services the answers lead to, writes nothing, and keeps unreviewed advice back", async () => {
    const before = await rows(env, "select (select count(*) from requests)::int as r, (select count(*) from audit_events)::int as a, (select count(*) from ai_drafts)::int as d");
    const p = await env.call("client", "POST", "/api/requests/preview", { answers: { mode: "new_company", jurisdiction: "not_sure", emirate: "Dubai", visas: 2, addOns: ["BANK-ACC"], activity: "tech", description: "software" } });
    expect(p.status).toBe(200);
    expect(p.body.lines.map((l: any) => l.code)).toEqual(expect.arrayContaining(["SET-FZ-LIC", "VISA-RES", "BANK-ACC"]));
    expect(p.body.lines.find((l: any) => l.code === "VISA-RES")).toMatchObject({ qty: 2, name: expect.any(String) });
    expect(p.body.notes[0]).toMatch(/not sure about the licence type/);
    expect(p.body.adviceFollows).toBe(true);
    expect(Object.keys(p.body).sort()).toEqual(["adviceFollows", "lines", "notes"]);
    expect(await rows(env, "select (select count(*) from requests)::int as r, (select count(*) from audit_events)::int as a, (select count(*) from ai_drafts)::int as d")).toEqual(before);
    expect((await env.call("setup", "POST", "/api/requests/preview", { answers: { mode: "new_company", emirate: "Dubai" } })).status).toBe(403);
    expect((await env.call("anon", "POST", "/api/requests/preview", { answers: { mode: "new_company", emirate: "Dubai" } })).status).toBe(401);
    expect((await env.call("client", "POST", "/api/requests/preview", { answers: { mode: "nonsense" } })).status).toBe(400);
  });

  it("publishes the storage adapter's own upload rules", async () => {
    const r = await env.call("anon", "GET", "/api/upload-rules");
    expect(r.body).toEqual({ extensions: [...UPLOAD_RULES.extensions], maxBytes: UPLOAD_RULES.maxBytes });
    expect(r.body.extensions).toContain("pdf");
    expect(r.body.maxBytes).toBe(15 * 1024 * 1024);
  });
});

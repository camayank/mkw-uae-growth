import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E7C over HTTP: funnel events are anonymous and counted once; a double submission is one lead; the scores carry their
 * evidence and the next best action its reason; the adviser's override is audited; the funnel report follows a
 * visitor from the first visit to accepted revenue and names the leads that need a person.
 */
const count = async (env: TestEnv, table: string): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`))).rows[0]!.n;
const MONEY = /margin|partner_?(unit|cost|org|id)|payout|rate_?card|professional_?fils|commission/i;
const walk = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), walk(x, out));
  else if (typeof v === "string") out.push(v);
  return out;
};

describe("funnel measurement, qualification and the conversion dashboard (E7C)", () => {
  let env: TestEnv;
  const visitor = "v1abcdefghij";
  const answers = { emirate: "Dubai", activity: "tech", customers: "international", visas: 2, budgetAed: 30_000, premises: "office", ownerType: "individuals", foreignTaxResident: false, startWithin: "1_month" };
  const events = (v: string, evs: Array<{ stage: string; key?: string }>, attribution: Record<string, unknown> = { source: "google", campaign: "nov-launch" }) =>
    env.call("anon", "POST", "/api/public/events", { visitor: v, events: evs, attribution });
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("events are anonymous, de-duplicated and refuse a malformed id or stage; nobody signed in is needed", async () => {
    const before = { audit: await count(env, "audit_events"), outbox: await count(env, "outbox") };
    const r = await events(visitor, [{ stage: "visited" }, { stage: "assessment_started" }, { stage: "step_reached", key: "activity" }, { stage: "step_reached", key: "customers" }, { stage: "visited" }]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: 4 }); // the repeated "visited" is one row
    expect((await events(visitor, [{ stage: "visited" }, { stage: "step_reached", key: "activity" }])).body).toEqual({ recorded: 0 });
    expect((await events("short", [{ stage: "visited" }])).status).toBe(400);
    expect((await events(visitor, [{ stage: "lead" as never }])).status).toBe(400);
    expect((await events("bad id!!!!!", [{ stage: "visited" }])).status).toBe(400);
    const rows = (await asPlatform(env.db, null, (tx) => tx.query("select * from funnel_events"))).rows as any[];
    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0]).sort()).toEqual(["at", "id", "key", "source", "stage", "visitor"]);
    expect(rows[0].source).toEqual({ source: "google", medium: null, campaign: "nov-launch", term: null, content: null, referrer: null, landing: null }); // the visitor is the row's own column, never repeated
    // No audit row, no outbox row: measurement is not a state change anyone acts on.
    expect(await count(env, "audit_events")).toBe(before.audit);
    expect(await count(env, "outbox")).toBe(before.outbox);
    // Clients, partners and finance cannot read the funnel; ops and the founder can.
    expect((await env.call("client", "GET", "/api/ops/pipeline/funnel")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/ops/pipeline/funnel")).status).toBe(403);
    expect((await env.call("finance", "GET", "/api/ops/pipeline/funnel")).status).toBe(403);
    expect((await env.call("ops", "GET", "/api/ops/pipeline/funnel")).status).toBe(200);
  });

  it("a double submission makes one lead; the lead carries the evidence of both scores and a next best action", async () => {
    await events(visitor, [{ stage: "assessment_completed" }, { stage: "result_viewed" }, { stage: "result_saved" }]);
    const { code } = (await env.call("anon", "POST", "/api/public/assessments", { answers, attribution: { source: "google", campaign: "nov-launch", visitor } })).body;
    const review = (extra: Record<string, unknown> = {}) =>
      env.call("anon", "POST", "/api/public/intake", { company: "Funnel Ventures", name: "F. Founder", email: "funnel-founder@example.test", consent: true, consentVersion: "2026-11-selector-v1", campaign: "nov-launch", attribution: { source: "google", campaign: "nov-launch", visitor }, assessmentCode: code, answers: { mode: "new_company", jurisdiction: "not_sure", ...answers }, consultation: { wanted: true, times: "mornings" }, ...extra });
    const leadsBefore = await count(env, "leads");
    expect((await review()).status).toBe(200);
    expect((await review()).status).toBe(200); // the same person, the same case, a minute later
    expect(await count(env, "leads")).toBe(leadsBefore + 1);
    const l = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Funnel Ventures");
    expect(l.source.visitor).toBe(visitor);
    expect(l.highIntent).toBe(true);
    expect(l.scoreEvidence.readiness.map((f: any) => f.factor)).toEqual(expect.arrayContaining(["budget given", "wants to start within a month", "asked for a call", "a clear activity"]));
    expect(l.scoreEvidence.value.length).toBeGreaterThanOrEqual(0);
    expect(10 + l.scoreEvidence.readiness.reduce((n: number, f: any) => n + f.points, 0)).toBeGreaterThanOrEqual(l.intent);
    expect(l.nextAction).toMatchObject({ action: "Assign an owner", urgent: true });
    expect(l.nextActionOverride).toBeNull();
    const detail = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${l.id}`)).body;
    expect(detail.notes.some((n: any) => /Asked again with the same answers/.test(n.body))).toBe(true);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select 1 from audit_events where action = 'lead.duplicate_ignored'"))).rows).toHaveLength(1);
    // A different case from the same person is a new lead.
    expect((await review({ assessmentCode: undefined, answers: { mode: "new_company", jurisdiction: "not_sure", ...answers, activity: "trading", visas: 5 } })).status).toBe(200);
    expect(await count(env, "leads")).toBe(leadsBefore + 2);
  });

  it("the adviser overrides the next best action with a reason, audited, and can clear it; status changes record first contact", async () => {
    const l = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Funnel Ventures" && x.requestId);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${l.id}/next-action`, { action: "Wait for their documents", reason: "" })).status).toBe(400);
    expect((await env.call("finance", "POST", `/api/ops/pipeline/leads/${l.id}/next-action`, { action: "x", reason: "because" })).status).toBe(403);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${l.id}/next-action`, { action: "Wait for their documents", reason: "They are travelling until the 20th" })).status).toBe(200);
    let d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${l.id}`)).body;
    expect(d.nextActionOverride).toMatchObject({ action: "Wait for their documents", reason: "They are travelling until the 20th" });
    expect(d.nextAction.action).toBe("Assign an owner"); // the rule's suggestion stays visible beside the override
    expect((await asPlatform(env.db, null, (tx) => tx.query("select data from audit_events where action = 'lead.next_action'"))).rows).toHaveLength(1);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${l.id}/next-action`, { action: null, reason: "" })).status).toBe(200);
    d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${l.id}`)).body;
    expect(d.nextActionOverride).toBeNull();
    // Contact: the first contact date is recorded once; closing records the reason; the action follows.
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${l.id}/status`, { status: "contacted", note: "Called" })).status).toBe(200);
    d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${l.id}`)).body;
    expect(d.firstContactAt).toBeTruthy();
    expect(d.nextAction.action).toBe("Get the proposal out"); // the request exists, no offer yet
    const other = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Funnel Ventures" && x.id !== l.id);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${other.id}/status`, { status: "closed", note: "Chose another adviser" })).status).toBe(200);
    expect((await env.call("ops", "GET", `/api/ops/pipeline/leads/${other.id}`)).body).toMatchObject({ closedReason: "Chose another adviser", nextAction: { action: "Nothing: closed" } });
  });

  it("the funnel report follows a source from the first visit to accepted revenue, counts each stage once, and names the leads that need a person", async () => {
    // A second visitor who starts and stops at the visas question, from a newsletter.
    await events("v2abcdefghij", [{ stage: "visited" }, { stage: "assessment_started" }, { stage: "step_reached", key: "activity" }, { stage: "step_reached", key: "visas" }], { source: "newsletter" });
    let f = (await env.call("founder", "GET", "/api/ops/pipeline/funnel")).body;
    const g = f.bySource.find((r: any) => r.source === "google" && r.campaign === "nov-launch");
    expect(g).toMatchObject({ visitors: 1, started: 1, completed: 1, viewed: 1, saved: 1, leads: 2, consultations: 2, qualified: 2, proposals: 0, accepted: 0, engagements: 0, revenueFils: 0, realisedFils: 0, pipelineFils: 0 });
    expect(f.bySource.find((r: any) => r.source === "newsletter")).toMatchObject({ visitors: 1, started: 1, completed: 0, leads: 0 });
    expect(f.totals).toMatchObject({ visitors: 2, started: 2, completed: 1, completionRate: 50, abandonmentRate: 50, won: 0, lost: 1 });
    expect(f.abandonment).toEqual([{ step: "visas", visitors: 1 }]);
    expect(f.lostReasons).toEqual([{ reason: "Chose another adviser", leads: 1 }]);
    expect(f.turnaround.contacted).toBe(1);
    expect(f.turnaround.toFirstContactDays).toBeGreaterThanOrEqual(0);
    expect(f.qualifiedRule).toMatch(/high readiness/);
    // Nothing commercial reaches the report.
    for (const s of walk(f)) expect(s, s).not.toMatch(MONEY);
    // Through Tasees: approve, build, publish, accept; the stages follow, counted once per request and offer.
    const l = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Funnel Ventures" && x.status === "contacted");
    expect((await env.call("ops", "POST", `/api/ops/requests/${l.requestId}/scoping/approve`, {})).status).toBe(200);
    const built = await env.call("ops", "POST", `/api/ops/requests/${l.requestId}/build-offers`, { tiers: ["standard"] });
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/offers/${built.body.offerIds[0]}/publish`)).status).toBe(200);
    f = (await env.call("ops", "GET", "/api/ops/pipeline/funnel")).body;
    let gg = f.bySource.find((r: any) => r.source === "google" && r.campaign === "nov-launch");
    expect(gg).toMatchObject({ proposals: 1, accepted: 0 });
    expect(gg.pipelineFils).toBeGreaterThan(0);
    expect((await env.call("ops", "GET", `/api/ops/pipeline/leads/${l.id}`)).body.nextAction.action).toBe("Chase the proposal");
    expect(f.turnaround.proposed).toBe(1);
    // The founder of Funnel Ventures signs in as the new client and accepts (the review created the account).
    const { createSession } = await import("../src/lib/auth.ts");
    env.tokens.funnel = await createSession(env.db, "funnel-founder@example.test");
    const accepted = await env.call("funnel", "POST", `/api/client/offers/${built.body.offerIds[0]}/accept`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    f = (await env.call("ops", "GET", "/api/ops/pipeline/funnel")).body;
    gg = f.bySource.find((r: any) => r.source === "google" && r.campaign === "nov-launch");
    expect(gg).toMatchObject({ proposals: 1, accepted: 1, engagements: 1, pipelineFils: 0 });
    expect(gg.revenueFils).toBeGreaterThan(0);
    expect(f.bySegment.find((s: any) => s.segment === l.segment).revenueFils).toBe(gg.revenueFils);
    expect(f.totals.revenuePerQualifiedFils).toBe(Math.round(gg.revenueFils / f.totals.qualifiedAll));
    expect((await env.call("ops", "GET", `/api/ops/pipeline/leads/${l.id}`)).body.nextAction.action).toMatch(/on the engagement/);
    // The leads that need a person: a high-readiness lead with no owner is listed, with why.
    const r3 = await env.call("anon", "POST", "/api/public/intake", { company: "Hot Lead Co", name: "H. Founder", email: "hot@example.test", consent: true, consentVersion: "2026-11-selector-v1", answers: { mode: "new_company", jurisdiction: "not_sure", ...answers }, phone: "+971 50 1234567", consultation: { wanted: true } });
    expect(r3.status).toBe(200);
    f = (await env.call("ops", "GET", "/api/ops/pipeline/funnel")).body;
    expect(f.attention.find((a: any) => a.company === "Hot Lead Co")).toMatchObject({ why: "unassigned", status: "new" });
  });
});

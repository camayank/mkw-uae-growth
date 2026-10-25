import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** O11 ops command centre: the ranked queue, the document checker, one-click actions and queue timings. */

const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
const rows = <T = any>(env: TestEnv, sql: string, params: unknown[] = []) => asPlatform(env.db, null, async (tx) => (await tx.query<T & Record<string, unknown>>(sql, params)).rows);
const advance = (env: TestEnv, ms: number) => {
  env.clock.now = new Date(env.clock.now.getTime() + ms);
};
const HOUR = 3_600_000;
const partnerKey = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");

async function inDelivery(env: TestEnv) {
  const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
  const offerId = (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
  await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
  const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId as string;
  const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
  await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-TT-1" });
  let e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
  for (const a of e.allocations.filter((x: any) => !x.acceptedAt)) await env.call(partnerKey(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
  e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
  const m = e.milestones[0];
  return { engagementId, milestone: m, who: partnerKey(e.lines.find((l: any) => l.code === m.code).partner) };
}

describe("ops command centre", () => {
  let env: TestEnv;
  let engagementId: string;
  let milestone: any;
  let who: string;
  beforeAll(async () => {
    env = await makeEnv();
    ({ engagementId, milestone, who } = await inDelivery(env));
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("checks every evidence upload as a draft, from metadata only, and shows it beside the step in QA", async () => {
    const [needed] = milestone.evidenceRequired as string[];
    expect((await env.call(who, "POST", `/api/milestones/${milestone.id}/evidence`, { type: needed, fileName: `${needed}-2026-10-19.pdf`, contentBase64: pdf })).status).toBe(200);
    expect((await env.call(who, "POST", `/api/milestones/${milestone.id}/evidence`, { type: needed, fileName: "passport-scan.txt", contentBase64: pdf })).status).toBe(200);
    for (const type of (milestone.evidenceRequired as string[]).slice(1)) await env.call(who, "POST", `/api/milestones/${milestone.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: pdf });
    await env.notify.flush();
    const drafts = await rows(env, "select d.input, d.output, d.status, d.confidence, d.subject_type from ai_drafts d join evidence e on e.id = d.subject_id where d.kind = 'document_check' and e.milestone_id = $1 order by d.created_at", [milestone.id]);
    expect(drafts.length).toBe((milestone.evidenceRequired as string[]).length + 1);
    expect(drafts.every((d) => d.status === "pending" && d.confidence === "UNCERTAIN" && d.subject_type === "evidence")).toBe(true);
    // Only the file's metadata and the step's requirement went to the model.
    expect(Object.keys(drafts[0].input).sort()).toEqual(["declaredType", "expiresOn", "fileName", "outboxId", "reference", "required", "subject", "today"]);
    expect(JSON.stringify(drafts.map((d) => d.input))).not.toMatch(/@|\+971|AED/);
    const dated = drafts.find((d) => d.input.fileName === `${needed}-2026-10-19.pdf`)!;
    expect(dated.output).toMatchObject({ dates: ["2026-10-19"], matchesRequirement: true, issues: [], basis: expect.stringMatching(/file itself was not read/) });
    const odd = drafts.find((d) => d.input.fileName === "passport-scan.txt")!;
    expect(odd.output.detectedType).toBe("passport");
    expect(odd.output.issues.join(" ")).toMatch(/\.txt file is not a usual document format/);
    expect(odd.output.matchesRequirement).toBe(false);

    expect((await env.call(who, "POST", `/api/milestones/${milestone.id}/submit`)).status).toBe(200);
    const q = (await env.call("ops", "GET", "/api/ops/queue")).body.items;
    const item = q.find((i: any) => i.id === `qa:${milestone.id}`);
    expect(item).toMatchObject({ kind: "qa", label: "Evidence to check", engagementId, link: `#/engagement/${engagementId}`, level: "on_track" });
    expect(item.why).toMatch(/the client cannot approve the step, and the partner is not paid for it, until MKW checks it/);
    expect(item.factors).toEqual(["a client is waiting on it", "a partner is waiting on it"]);
    expect(item.drafts).toHaveLength(drafts.length);
    expect(item.actions.map((a: any) => a.label)).toEqual(["Pass", "Send back"]);
  });

  it("records a person agreeing or disagreeing with a check; the upload itself never changes", async () => {
    const [first, second] = await rows(env, "select d.id from ai_drafts d join evidence e on e.id = d.subject_id where e.milestone_id = $1 order by d.created_at", [milestone.id]);
    advance(env, 4 * 60_000);
    expect((await env.call("ops", "POST", `/api/ops/drafts/${first.id}/review`, { decision: "approve" })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/drafts/${second.id}/review`, { decision: "discard", note: "It is the licence, misnamed" })).status).toBe(200);
    const [a, b] = await rows(env, "select status, extract(epoch from reviewed_at - created_at)::int as secs from ai_drafts where id = any($1) order by created_at", [[first.id, second.id]]);
    expect(a).toMatchObject({ status: "approved", secs: 240 });
    expect(b.status).toBe("discarded");
    expect((await rows(env, "select status from milestones where id = $1", [milestone.id]))[0].status).toBe("evidence_submitted");
  });

  it("ranks by risk: the step past its target goes above newer work, and says by how much", async () => {
    // A partner document arrives now; the QA item is a working day and a half old.
    advance(env, 2 * 24 * HOUR);
    const up = await env.call("setup", "POST", `/api/partners/${(await env.call("setup", "GET", "/api/me")).body.orgId}/documents`, {
      kind: "insurance",
      fileName: "insurance-policy.pdf",
      contentBase64: pdf,
      expiresOn: new Date(env.clock.now.getTime() + 10 * 24 * HOUR).toISOString().slice(0, 10),
    });
    expect(up.status).toBe(200);
    await env.notify.flush();
    const q = (await env.call("ops", "GET", "/api/ops/queue")).body.items;
    const qa = q.findIndex((i: any) => i.id === `qa:${milestone.id}`);
    const doc = q.findIndex((i: any) => i.id === `partner_document:${up.body.id}`);
    expect(qa).toBeLessThan(doc);
    expect(q[qa].level).toBe("overdue");
    expect(q[qa].factors[0]).toMatch(/working hours? past its 9 working hours target/);
    // Every item is listed; the order never drops one.
    const risks = q.map((i: any) => i.risk);
    expect([...risks].sort((x: number, y: number) => y - x)).toEqual(risks);
    // The partner document carries its check inline: insurance expiring in ten days.
    expect(q[doc].drafts[0].check.issues.join(" ")).toMatch(/is 10 day\(s\) away/);
    expect(q[doc].actions.map((a: any) => a.label)).toEqual(["Verify", "Reject"]);
  });

  it("shows each role only the buttons it may use, and nothing to clients or partners", async () => {
    expect((await env.call("client", "GET", "/api/ops/queue")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/ops/queue")).status).toBe(403);
    const finance = (await env.call("finance", "GET", "/api/ops/queue")).body.items;
    expect(finance.flatMap((i: any) => i.actions)).toEqual(finance.filter((i: any) => i.kind === "payout").map(() => expect.objectContaining({ label: "Release" })));
    const ops = (await env.call("ops", "GET", "/api/ops/queue")).body.items;
    expect(ops.flatMap((i: any) => i.actions).some((a: any) => a.label === "Release")).toBe(false);
  });

  it("times each item from arrival to resolution, and ops handling from opening it", async () => {
    await env.call("ops", "GET", "/api/ops/queue");
    expect((await env.call("ops", "POST", "/api/ops/queue/open", { id: `qa:${milestone.id}` })).status).toBe(200);
    expect((await env.call("ops", "POST", "/api/ops/queue/open", { id: "nonsense" })).status).toBe(400);
    advance(env, 7 * 60_000);
    expect((await env.call("ops", "POST", `/api/ops/milestones/${milestone.id}/qa`, { pass: true })).status).toBe(200);
    const after = (await env.call("ops", "GET", "/api/ops/queue")).body.items;
    expect(after.some((i: any) => i.id === `qa:${milestone.id}`)).toBe(false);
    const [t] = await rows(env, "select opened_at, resolved_at, due_at, item_at, engagement_id from queue_timings where kind = 'qa' and ref = $1", [milestone.id]);
    expect((new Date(t.resolved_at).getTime() - new Date(t.opened_at).getTime()) / 60_000).toBe(7);
    expect(t.engagement_id).toBe(engagementId);
    const period = env.clock.now.toISOString().slice(0, 7);
    const dash = (await env.call("founder", "GET", `/api/admin/dashboard?period=${period}`)).body.queue;
    expect(dash.resolved).toBeGreaterThanOrEqual(1);
    expect(dash.opsMinutes).toBe(7);
    expect(dash.opsMinutesPerEngagement).toBe(7);
    expect(dash.byKind.find((k: any) => k.kind === "qa")).toMatchObject({ resolved: 1, withinTarget: 0 });
    // Ops sees the queue figures too: they hold no money.
    expect((await env.call("ops", "GET", `/api/admin/dashboard?period=${period}`)).body.queue.opsMinutes).toBe(7);
  });

  it("lists client documents overdue after three working days and partner licences within 30 days of expiry", async () => {
    // Asked for on Monday morning at acceptance; by Friday they are three working days late.
    expect((await env.call("ops", "GET", "/api/ops/queue")).body.items.some((i: any) => i.kind === "documents_overdue")).toBe(false);
    advance(env, 2 * 24 * HOUR);
    const q = (await env.call("ops", "GET", "/api/ops/queue")).body.items;
    const overdue = q.find((i: any) => i.id === `documents_overdue:${engagementId}`);
    expect(overdue.why).toMatch(/document\(s\) asked of Sample Trading FZ-LLC \d+ working day\(s\) ago are still missing/);
    const setup = (await env.call("setup", "GET", "/api/me")).body.orgId;
    const soon = new Date(env.clock.now.getTime() + 20 * 24 * HOUR).toISOString().slice(0, 10);
    await asPlatform(env.db, null, (tx) =>
      tx.query("insert into partner_documents (partner_org_id, kind, file_key, file_name, uploaded_by, status, expires_on, verified_at) select $1, 'trade_licence', 'k', 'licence.pdf', u.id, 'verified', $2, $3 from users u where u.org_id = $1 limit 1", [setup, soon, env.clock.now.toISOString()]),
    );
    const licence = (await env.call("ops", "GET", "/api/ops/queue")).body.items.find((i: any) => i.kind === "licence_expiring" && i.ref === setup);
    expect(licence.why).toContain(`trade licence expires on ${soon}; the firm is paused automatically if it lapses`);
    expect(licence.link).toBe(`#/partner/${setup}`);
  });
});

describe("document checker failures", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("a model failure leaves no draft and never blocks the step", async () => {
    let calls = 0;
    env.notify.on("document_check", {
      handle: async () => {
        calls += 1;
        throw new Error("model unavailable");
      },
      check: async () => "not_done",
    });
    const { milestone, who } = await inDelivery(env);
    for (const type of milestone.evidenceRequired) expect((await env.call(who, "POST", `/api/milestones/${milestone.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: pdf })).status).toBe(200);
    await env.notify.flush();
    expect(calls).toBeGreaterThan(0);
    expect((await env.call(who, "POST", `/api/milestones/${milestone.id}/submit`)).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/milestones/${milestone.id}/qa`, { pass: true })).status).toBe(200);
    expect(await rows(env, "select 1 from ai_drafts where kind = 'document_check'")).toEqual([]);
    expect((await rows(env, "select distinct status from outbox where topic = 'document_check'")).map((r) => r.status)).toEqual(["pending"]);
    // Agent work that keeps failing is not a message to settle: it never shows as a delivery item.
    const q = (await env.call("ops", "GET", "/api/ops/queue")).body.items;
    expect(q.some((i: any) => i.kind.startsWith("delivery_"))).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, EMAILS, type TestEnv } from "./helpers.ts";

/**
 * E5 over HTTP: a saved result becomes a request for the signed-in client without re-typing; ops turns a held
 * enquiry into a request for the existing client; the review shows then against now; a renewal is asked for from
 * the obligation and met by its delivery. Every step is a person's action and sends nothing beyond what intake did.
 */
const count = async (env: TestEnv, table: string, where = "true"): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`))).rows[0]!.n;
const answers = { emirate: "Dubai", activity: "tech", customers: "international", visas: 2, budgetAed: 30_000, premises: "office", ownerType: "individuals", foreignTaxResident: false };

describe("the handoff into Tasees", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("a signed-in client starts a request from a saved result: the answers pre-fill, the advice is today's, the link is recorded", async () => {
    const { code } = (await env.call("anon", "POST", "/api/public/assessments", { answers, attribution: { source: "linkedin", campaign: "founders" } })).body;
    const outbox = await count(env, "outbox");
    expect((await env.call("setup", "POST", "/api/requests/from-assessment", { code })).status).toBe(403);
    expect((await env.call("client", "POST", "/api/requests/from-assessment", { code: "ZZZZZZZZZZ" })).status).toBe(404);
    expect((await env.call("client", "POST", "/api/requests/from-assessment", { code: "short" })).status).toBe(400);
    const r = await env.call("client", "POST", "/api/requests/from-assessment", { code, description: "Three partners, software, two visas" });
    expect(r.status).toBe(200);
    expect(r.body.adviceStatus).toBe("pending_review");
    const [req] = (await asPlatform(env.db, null, (tx) => tx.query("select answers, source, assessment_id, advice from requests where id = $1", [r.body.id]))).rows as any[];
    expect(req.answers).toMatchObject({ mode: "new_company", jurisdiction: "not_sure", activity: "tech", visas: 2, budgetAed: 30_000, description: "Three partners, software, two visas" });
    expect(req.source).toMatchObject({ from: "saved_assessment", attribution: { source: "linkedin", campaign: "founders" } });
    expect(req.assessment_id).toBeTruthy();
    expect(req.advice.dataVersion.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/); // computed now, not copied
    expect((await asPlatform(env.db, null, (tx) => tx.query("select status from assessments where id = $1", [req.assessment_id]))).rows[0]).toEqual({ status: "request" });
    // Once only, for anyone: another client using the same code is refused once it is used, and a member of this
    // client may use a code as the owner may (a code holds answers, no personal data).
    expect((await env.call("client", "POST", "/api/requests/from-assessment", { code })).status).toBe(409);
    expect((await env.call("clientMember", "POST", "/api/requests/from-assessment", { code })).status).toBe(409);
    // An anonymised result is gone.
    const { code: gone } = (await env.call("anon", "POST", "/api/public/assessments", { answers })).body;
    await asPlatform(env.db, null, (tx) => tx.query("update assessments set status = 'anonymised', answers = '{}'::jsonb where code_hash <> (select code_hash from assessments where id = $1)", [req.assessment_id]));
    expect((await env.call("client", "POST", "/api/requests/from-assessment", { code: gone })).status).toBe(404);
    // The review shows then against now; the client sees the link on their home.
    const scoping = (await env.call("ops", "GET", `/api/ops/requests/${r.body.id}/scoping`)).body;
    expect(scoping.assessment).toMatchObject({ summary: { recommendation: null, confirmed: false }, source: { source: "linkedin" } });
    expect(scoping.assessment.savedAt).toBeTruthy();
    const home = (await env.call("client", "GET", "/api/client/home")).body;
    expect(home.requests.find((x: any) => x.id === r.body.id).assessmentId).toBe(req.assessment_id);
    // Nothing is sent: a request the client creates themselves notifies nobody.
    expect(await count(env, "outbox")).toBe(outbox);
  });

  it("ops turns a held enquiry into a request for the existing client; the enquiry is handled, the lead linked, nothing sent", async () => {
    // The client's own email on the public page: held, not duplicated (O5).
    const held = await env.call("anon", "POST", "/api/public/intake", { company: "Held Again Ltd", name: "Client Owner", email: EMAILS.client, consent: true, answers: { mode: "new_company", jurisdiction: "not_sure", ...answers, activity: "trading", customers: "both" } });
    expect(held.status).toBe(200);
    const [lead] = (await asPlatform(env.db, null, (tx) => tx.query("select id from intake_leads where status = 'held' order by created_at desc limit 1"))).rows as any[];
    const outbox = await count(env, "outbox");
    expect((await env.call("setup", "POST", `/api/ops/leads/${lead.id}/convert`, { note: "x" })).status).toBe(403);
    expect((await env.call("ops", "POST", "/api/ops/leads/not-a-uuid/convert", {})).status).toBe(400);
    const r = await env.call("ops", "POST", `/api/ops/leads/${lead.id}/convert`, { note: "Same founder, second company" });
    expect(r.status).toBe(200);
    const clientOrg = (await env.call("client", "GET", "/api/me")).body.orgId;
    expect(r.body.clientOrgId).toBe(clientOrg);
    const [req] = (await asPlatform(env.db, null, (tx) => tx.query("select client_org_id, answers, source from requests where id = $1", [r.body.id]))).rows as any[];
    expect(req.client_org_id).toBe(clientOrg);
    expect(req.answers).toMatchObject({ activity: "trading", customers: "both" });
    expect(req.source).toMatchObject({ from: "held_enquiry", intakeLeadId: lead.id });
    const [after] = (await asPlatform(env.db, null, (tx) => tx.query("select status, request_id from intake_leads where id = $1", [lead.id]))).rows as any[];
    expect(after).toEqual({ status: "handled", request_id: r.body.id });
    const [l] = (await asPlatform(env.db, null, (tx) => tx.query("select request_id, client_org_id from leads where intake_lead_id = $1", [lead.id]))).rows as any[];
    expect(l).toEqual({ request_id: r.body.id, client_org_id: clientOrg });
    expect((await env.call("ops", "POST", `/api/ops/leads/${lead.id}/convert`, {})).status).toBe(409);
    expect((await env.call("ops", "GET", "/api/ops/queue")).body.items.some((x: any) => x.kind === "lead" && /Held Again/.test(x.detail))).toBe(false);
    expect(await count(env, "outbox")).toBe(outbox);
    // The client can see the request ops made for them.
    expect((await env.call("client", "GET", "/api/client/home")).body.requests.some((x: any) => x.id === r.body.id)).toBe(true);
  });

  it("a renewal is asked for from an open licence-renewal obligation, once; its delivery meets the obligation and rolls it forward", async () => {
    const clientOrg = (await env.call("client", "GET", "/api/me")).body.orgId;
    const add = await env.call("ops", "POST", `/api/ops/clients/${clientOrg}/obligations`, { kind: "licence_renewal", title: "Trade licence renewal", dueDate: "2027-01-15", recurrence: "yearly", basis: "On the licence" });
    expect(add.status).toBe(200);
    const obligationId = add.body.id;
    const other = (await env.call("ops", "POST", `/api/ops/clients/${clientOrg}/obligations`, { kind: "vat_return", title: "VAT return", dueDate: "2027-01-28", recurrence: "quarterly" })).body.id;
    expect((await env.call("client", "POST", `/api/obligations/${other}/renewal-request`)).status).toBe(400);
    expect((await env.call("setup", "POST", `/api/obligations/${obligationId}/renewal-request`)).status).toBe(403);
    const outbox = await count(env, "outbox");
    // An obligation ops added by hand has no engagement: the renewal takes the client's latest request's place.
    const latest = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Sharjah", freeZone: "SHAMS", visas: 1 } });
    expect(latest.status).toBe(200);
    await asPlatform(env.db, null, (tx) => tx.query("update requests set created_at = created_at - interval '1 day' where id <> $1", [latest.body.id])); // the test clock stands still
    const r = await env.call("client", "POST", `/api/obligations/${obligationId}/renewal-request`);
    expect(r.status).toBe(200);
    expect(r.body.lines).toBe(1);
    const [req] = (await asPlatform(env.db, null, (tx) => tx.query("select answers, scope, obligation_id, client_org_id from requests where id = $1", [r.body.id]))).rows as any[];
    expect(req.answers).toMatchObject({ mode: "services", emirate: "Sharjah", freeZone: "SHAMS", services: ["SET-RENEW"] });
    expect(req.scope.lines).toEqual([{ code: "SET-RENEW", qty: 1 }]);
    expect(req.obligation_id).toBe(obligationId);
    expect(req.client_org_id).toBe(clientOrg);
    expect((await env.call("ops", "POST", `/api/obligations/${obligationId}/renewal-request`)).status).toBe(409);
    expect((await env.call("client", "GET", "/api/client/compliance")).body.find((o: any) => o.id === obligationId)).toMatchObject({ renewalRequestId: r.body.id, renewalRequestStatus: "scoped" });
    expect(await count(env, "outbox")).toBe(outbox);
    // An offer that expires leaves the renewal askable again; an accepted one keeps it in progress until delivery.
    const first = (await env.call("ops", "POST", `/api/ops/requests/${r.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    // Built but not yet published: the request reads "offered" while the offer is a draft; the renewal is still live.
    expect((await env.call("client", "POST", `/api/obligations/${obligationId}/renewal-request`)).status).toBe(409);
    expect((await env.call("client", "GET", "/api/client/compliance")).body.find((o: any) => o.id === obligationId)).toMatchObject({ renewalRequestId: r.body.id, renewalRequestStatus: "offered" });
    expect((await env.call("ops", "POST", `/api/ops/offers/${first}/publish`)).status).toBe(200);
    expect((await env.call("client", "POST", `/api/obligations/${obligationId}/renewal-request`)).status).toBe(409); // a live offer
    await asPlatform(env.db, null, (tx) => tx.query("update offers set valid_to = $2::date where id = $1", [first, new Date(env.clock.now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)]));
    expect((await env.call("founder", "POST", "/api/ops/jobs/run")).status).toBe(200); // expires it
    expect((await env.call("client", "GET", "/api/client/compliance")).body.find((o: any) => o.id === obligationId).renewalRequestId).toBeNull();
    const again = await env.call("client", "POST", `/api/obligations/${obligationId}/renewal-request`);
    expect(again.status).toBe(200); // the renewal can be asked for again
    const offer = (await env.call("ops", "POST", `/api/ops/requests/${again.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    expect((await env.call("ops", "POST", `/api/ops/offers/${offer}/publish`)).status).toBe(200);
    expect((await env.call("client", "POST", `/api/client/offers/${offer}/accept`)).status).toBe(200);
    // Accepted: the request closes but the renewal is in progress, so no second one.
    expect((await env.call("client", "POST", `/api/obligations/${obligationId}/renewal-request`)).status).toBe(409);
    const inProgress = (await env.call("client", "GET", "/api/client/compliance")).body.find((o: any) => o.id === obligationId);
    expect(inProgress.renewalRequestId).toBe(again.body.id);
    expect(inProgress.renewalEngagementId).toBeTruthy();
    r.body.id = again.body.id;
    await asPlatform(env.db, null, async (tx) => {
      // Shortcut the engagement to completion, then run the same hook a delivered engagement runs.
      const e = (await tx.query<{ id: string }>("select e.id from engagements e where e.request_id = $1", [r.body.id])).rows[0]!;
      await tx.query("update engagements set status = 'completed' where id = $1", [e.id]);
      const { completeRenewal } = await import("../src/services/handoff.ts");
      expect(await completeRenewal(tx, e.id)).toBe(obligationId);
    });
    const rows = (await asPlatform(env.db, null, (tx) => tx.query("select id, status, due_date::text as due_date, met_note, previous_id from obligations where kind = 'licence_renewal' and client_org_id = $1 order by created_at", [clientOrg]))).rows as any[];
    expect(rows[0]).toMatchObject({ id: obligationId, status: "met" });
    expect(rows[0].met_note).toMatch(/Renewed through Tasees/);
    expect(rows[1]).toMatchObject({ previous_id: obligationId, due_date: "2028-01-15" });
    expect(["open", "pending_review"]).toContain(rows[1].status);
    // The engagement is complete, so the obligation it renewed shows no live request any more.
    expect((await env.call("client", "GET", "/api/client/compliance")).body.find((o: any) => o.id === obligationId).renewalRequestId).toBeNull();
    // An engagement that delivered something else does not meet a renewal obligation.
    const other2 = (await env.call("ops", "POST", `/api/ops/clients/${clientOrg}/obligations`, { kind: "licence_renewal", title: "Second licence renewal", dueDate: "2027-06-01", recurrence: "yearly" })).body.id;
    // An obligation generated from a delivered engagement renews that engagement's licence: its emirate and zone.
    await asPlatform(env.db, null, (tx) => tx.query("update obligations set engagement_id = (select id from engagements where request_id = $2) where id = $1", [other2, r.body.id]));
    await asPlatform(env.db, null, (tx) => tx.query("update engagements set emirate = 'Dubai', free_zone = 'IFZA' where request_id = $1", [r.body.id]));
    const r2 = await env.call("ops", "POST", `/api/obligations/${other2}/renewal-request`);
    expect(r2.status).toBe(200);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select answers from requests where id = $1", [r2.body.id]))).rows[0]).toMatchObject({ answers: { emirate: "Dubai", freeZone: "IFZA", services: ["SET-RENEW"] } });
    const { completeRenewal } = await import("../src/services/handoff.ts");
    // Simulate: the engagement for the second request carries no SET-RENEW line.
    const offer2 = (await env.call("ops", "POST", `/api/ops/requests/${r2.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    expect((await env.call("ops", "POST", `/api/ops/offers/${offer2}/publish`)).status).toBe(200);
    expect((await env.call("client", "POST", `/api/client/offers/${offer2}/accept`)).status).toBe(200);
    await asPlatform(env.db, null, async (tx) => {
      const e = (await tx.query<{ id: string }>("select e.id from engagements e where e.request_id = $1", [r2.body.id])).rows[0]!;
      await tx.query("update engagement_lines set code = 'PRO-EID' where engagement_id = $1 and code = 'SET-RENEW'", [e.id]);
      await tx.query("update engagements set status = 'completed' where id = $1", [e.id]);
      expect(await completeRenewal(tx, e.id)).toBeNull();
    });
    expect((await asPlatform(env.db, null, (tx) => tx.query("select status from obligations where id = $1", [other2]))).rows[0]).toEqual({ status: "open" });
    expect((await asPlatform(env.db, null, (tx) => tx.query("select 1 from audit_events where action = 'obligation.renewal_delivered_without_line' and entity_id = $1", [other2]))).rows).toHaveLength(1);
  });
});

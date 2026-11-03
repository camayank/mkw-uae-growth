import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { createSession } from "../src/lib/auth.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E7C, contract 3D: a lead progresses into the request, quotation and engagement system without duplicating the
 * organisation or the request, losing the answers, the attribution, the consent history or the owner, bypassing a
 * person's approval, exposing partner cost or margin, or pricing on outdated data. One test per risk.
 */
const MONEY = /margin|partner_?(unit|cost|org|id)|payout|rate_?card|professional_?fils|commission/i;
const walk = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), walk(x, out));
  else if (typeof v === "string") out.push(v);
  return out;
};

describe("lead to Tasees without loss (E7C, 3D)", () => {
  let env: TestEnv;
  const count = async (table: string): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`))).rows[0]!.n;
  const answers = { emirate: "Dubai", activity: "consulting", customers: "international", visas: 1, budgetAed: 25_000, startWithin: "3_months" };
  const attribution = { source: "linkedin", medium: "social", campaign: "founders-q4", landing: "/selector.html?utm_source=linkedin", visitor: "vLeadToTasees1" };
  let leadId = "";
  let requestId = "";
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("a new person becomes one organisation, one user and one request; a second review from them makes no second organisation", async () => {
    const orgs = await count("orgs");
    const users = await count("users");
    const requests = await count("requests");
    const { code } = (await env.call("anon", "POST", "/api/public/assessments", { answers, attribution })).body;
    const r = await env.call("anon", "POST", "/api/public/intake", { company: "Lossless Ltd", name: "L. Founder", email: "lossless@example.test", consent: true, consentVersion: "2026-11-selector-v1", attribution, assessmentCode: code, answers: { mode: "new_company", jurisdiction: "not_sure", ...answers }, marketingConsent: true });
    expect(r.status).toBe(200);
    expect(await count("orgs")).toBe(orgs + 1);
    expect(await count("users")).toBe(users + 1);
    expect(await count("requests")).toBe(requests + 1);
    const l = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Lossless Ltd");
    leadId = l.id;
    requestId = l.requestId;
    // The same person asks again with a different case: no second organisation or user; the enquiry is held for ops.
    const again = await env.call("anon", "POST", "/api/public/intake", { company: "Lossless Ltd", name: "L. Founder", email: "lossless@example.test", consent: true, consentVersion: "2026-11-selector-v1", answers: { mode: "new_company", jurisdiction: "not_sure", ...answers, activity: "trading" } });
    expect(again.status).toBe(200);
    expect(await count("orgs")).toBe(orgs + 1);
    expect(await count("users")).toBe(users + 1);
    expect(await count("requests")).toBe(requests + 1); // held, not a request, until ops converts it on purpose
    const held = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Lossless Ltd" && x.id !== leadId);
    expect(held.intakeLeadId).toBeTruthy();
    expect(held.requestId).toBeNull();
  });

  it("the answers, the attribution and the consent history travel to the request and stay with the lead", async () => {
    const [req] = (await asPlatform(env.db, null, (tx) => tx.query("select answers, source from requests where id = $1", [requestId]))).rows as any[];
    expect(req.answers).toMatchObject({ activity: "consulting", budgetAed: 25_000, startWithin: "3_months" });
    expect(req.source).toMatchObject({ channel: "public_intake", campaign: "founders-q4", attribution: { source: "linkedin", medium: "social", campaign: "founders-q4" } });
    expect(JSON.stringify(req.source)).not.toMatch(/code=/);
    const d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${leadId}`)).body;
    expect(d.answers).toMatchObject({ activity: "consulting", budgetAed: 25_000 });
    expect(d.source).toMatchObject({ source: "linkedin", campaign: "founders-q4", visitor: "vLeadToTasees1" });
    expect(d.consentHistory.map((c: any) => [c.purpose, c.given])).toEqual([["service", true], ["marketing", true], ["partner_disclosure", false]]);
    // A withdrawal appends; the history keeps the original decision.
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/consent-withdraw`, { purpose: "marketing", note: "Asked by email" })).status).toBe(200);
    const d2 = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${leadId}`)).body;
    expect(d2.consentHistory.filter((c: any) => c.purpose === "marketing").map((c: any) => c.given)).toEqual([true, false]);
    expect(d2.consents.marketing).toBe(false);
    // Erasure clears the adviser's free text on the lead too (an override, its reason, a closure reason).
    const held = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Lossless Ltd" && x.id !== leadId);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${held.id}/next-action`, { action: "Call L. Founder on +971 50 000", reason: "Prefers calls, Dubai number" })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${held.id}/status`, { status: "closed", note: "L. Founder moved to Riyadh" })).status).toBe(200);
    const { eraseLeadsForEmail } = await import("../src/services/leads.ts");
    await asPlatform(env.db, null, (tx) => eraseLeadsForEmail(tx, "lossless-held@example.test", "erased-x@erased.invalid"));
    const gone = (await asPlatform(env.db, null, (tx) => tx.query("select next_action_override, next_action_reason, closed_reason from leads where id = $1", [held.id]))).rows[0] as any;
    expect(gone).toEqual({ next_action_override: "Call L. Founder on +971 50 000", next_action_reason: "Prefers calls, Dubai number", closed_reason: "L. Founder moved to Riyadh" }); // a different email: untouched
    await asPlatform(env.db, null, (tx) => eraseLeadsForEmail(tx, "lossless@example.test", "erased-y@erased.invalid"));
    const erased = (await asPlatform(env.db, null, (tx) => tx.query("select next_action_override, next_action_reason, closed_reason from leads where id = $1", [held.id]))).rows[0] as any;
    expect(erased).toEqual({ next_action_override: null, next_action_reason: null, closed_reason: null });
  });

  it("no proposal reaches the client without a person's approval of the scoping, and the lead cannot be marked converted before an offer is accepted", async () => {
    // Ops may price early; nothing reaches the client until the structure is settled at the scoping review.
    const early = await env.call("ops", "POST", `/api/ops/requests/${requestId}/build-offers`, { tiers: ["standard"] });
    expect(early.status).toBe(200);
    const tooSoon = await env.call("ops", "POST", `/api/ops/offers/${early.body.offerIds[0]}/publish`);
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.message).toMatch(/cannot go to the client yet/);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/status`, { status: "converted" })).status).toBe(409);
    expect((await env.call("ops", "POST", `/api/ops/requests/${requestId}/scoping/approve`, {})).status).toBe(200);
  });

  it("advice built on licensing data that changed since is not approved again until it is recomputed", async () => {
    // A fresh request from the same client, then a new catalogue fact: the review says the data changed and refuses approval.
    env.tokens.lossless = await createSession(env.db, "lossless@example.test");
    const r = await env.call("lossless", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Dubai", jurisdiction: "not_sure", activity: "tech", customers: "international", visas: 1 } });
    expect(r.status).toBe(200);
    expect((await env.call("founder", "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", subject: "IFZA", field: "visa_quota", valueText: "2", sourceUrl: "https://ifza.com/packages", evidenceDate: new Date(env.clock.now.getTime() - 86_400_000).toISOString().slice(0, 10), confidence: "rule_of_thumb" })).status).toBe(200);
    expect((await env.call("ops", "GET", `/api/ops/requests/${r.body.id}/scoping`)).body.dataChanged).toBe(true);
    expect((await env.call("ops", "POST", `/api/ops/requests/${r.body.id}/scoping/approve`, {})).status).toBe(409);
    expect((await env.call("ops", "POST", `/api/ops/requests/${r.body.id}/scoping/recompute`)).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/requests/${r.body.id}/scoping/approve`, {})).status).toBe(200);
  });

  it("no partner cost or margin reaches the lead pipeline, the funnel or the client, and the lead keeps its owner through conversion", async () => {
    const owner = (await env.call("ops", "GET", "/api/admin/settings/lead-routing")).body.owners.find((o: any) => o.role === "ops");
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/assign`, { ownerUserId: owner.id })).status).toBe(200);
    const built = await env.call("ops", "POST", `/api/ops/requests/${requestId}/build-offers`, { tiers: ["standard"] });
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/offers/${built.body.offerIds[0]}/publish`)).status).toBe(200);
    for (const url of ["/api/ops/pipeline/leads", `/api/ops/pipeline/leads/${leadId}`, "/api/ops/pipeline/funnel", "/api/ops/pipeline/leads/analytics"]) {
      const body = (await env.call("ops", "GET", url)).body;
      for (const s of walk(body)) expect(s, `${url}: ${s}`).not.toMatch(MONEY);
    }
    const offer = (await env.call("lossless", "GET", `/api/client/offers/${built.body.offerIds[0]}`)).body;
    for (const s of walk(offer)) expect(s, s).not.toMatch(MONEY);
    expect((await env.call("lossless", "POST", `/api/client/offers/${built.body.offerIds[0]}/accept`)).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/status`, { status: "converted" })).status).toBe(200);
    const d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${leadId}`)).body;
    expect(d).toMatchObject({ status: "converted", ownerUserId: owner.id, becameClient: true });
    expect(d.nextAction.action).toMatch(/on the engagement/);
    // One engagement, one organisation: nothing duplicated along the way.
    expect((await asPlatform(env.db, null, (tx) => tx.query("select count(*)::int as n from engagements where request_id = $1", [requestId]))).rows[0]).toEqual({ n: 1 });
    expect((await asPlatform(env.db, null, (tx) => tx.query("select count(*)::int as n from orgs where name = 'Lossless Ltd'"))).rows[0]).toEqual({ n: 1 });
    // The existing-client path (scenario 25) keeps the same organisation too.
    expect((await env.call("anon", "POST", "/api/public/intake", { company: "Demo Client once more", name: "Client Owner", email: EMAILS.client, consent: true, answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", activity: "consulting", customers: "international", visas: 1 } })).status).toBe(200);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select count(*)::int as n from users where email = $1", [EMAILS.client]))).rows[0]).toEqual({ n: 1 });
  });
});

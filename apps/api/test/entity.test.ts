import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E1 over HTTP: an uncertain or excluded structure never becomes a firm formation quote, approving a different
 * structure re-scopes the request, and the advice carries every structure's eligibility with its reasons.
 */
const rows = <T = any>(env: TestEnv, sql: string, params: unknown[] = []) => asPlatform(env.db, null, async (tx) => (await tx.query<T & Record<string, unknown>>(sql, params)).rows);

describe("formation quotes wait for a settled structure", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  const request = async (answers: Record<string, unknown>) => (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Dubai", ...answers } })).body.id as string;
  const build = async (id: string) => (await env.call("ops", "POST", `/api/ops/requests/${id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0] as string;
  const publish = (offerId: string) => env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
  const offerStatus = async (offerId: string) => (await rows<{ status: string }>(env, "select status from offers where id = $1", [offerId]))[0]!.status;
  const codesOf = async (offerId: string) => (await rows<{ code: string }>(env, "select code from offer_lines where offer_id = $1 order by code", [offerId])).map((r) => r.code);
  // A partner prices the offshore and DIFC/ADGM formations too, so offers for those structures can be built.
  beforeAll(async () => {
    expect((await env.call("setup", "PUT", "/api/partner/rate-cards", { cards: [{ code: "SET-OFF", professionalAed: 4_000, workingDays: 7 }, { code: "SET-DIFC", professionalAed: 15_000, workingDays: 20 }] })).status).toBe(200);
  });

  it("a client who is not sure of the structure gets no published quote until ops settles it", async () => {
    const id = await request({ jurisdiction: "not_sure", visas: 1, activity: "consulting", customers: "international" });
    const offer = await build(id); // an internal estimate is fine
    const refused = await publish(offer);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/not sure which structure fits/);
    expect((await env.call("client", "GET", `/api/client/offers/${offer}`)).status).toBe(404);
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, { structure: "free_zone", note: "International consultancy" })).status).toBe(200);
    // Settling free zone changes nothing in the scope (not sure was priced as free zone), so the draft stands.
    expect((await publish(offer)).status).toBe(200);
  });

  it("offshore with visas is refused as a quote and as an approval; the advice's free zone re-scopes the request", async () => {
    const id = await request({ jurisdiction: "offshore", visas: 2, activity: "holding", budgetAed: 12_000 });
    const scoping = (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body;
    expect(scoping.advice.structure.recommendation).toBe("free_zone");
    expect(scoping.advice.structures.find((s: any) => s.structure === "offshore").status).toBe("INELIGIBLE");
    expect(scoping.advice.contradictions[0]).toMatch(/offshore company and 2 residence visa/);
    // The request scopes an offshore company with the visas left out; an offer can be built from it as an internal
    // estimate, but it cannot be published, and ops cannot approve the excluded structure.
    expect((await rows(env, "select scope from requests where id = $1", [id]))[0].scope.lines.map((l: any) => l.code)).toEqual(["SET-OFF"]);
    const offshoreOffer = await build(id);
    expect(await codesOf(offshoreOffer)).toEqual(["SET-OFF"]);
    expect((await publish(offshoreOffer)).status).toBe(409);
    const bad = await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, { structure: "offshore" });
    expect(bad.status).toBe(409);
    expect(bad.body.message).toMatch(/offshore cannot be approved for this request: An offshore company cannot sponsor residence visas/);
    // Approving the advice settles free zone: answers and scope follow, the offshore offer is withdrawn.
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, { note: "Visas needed" })).status).toBe(200);
    const [req] = await rows(env, "select answers, scope from requests where id = $1", [id]);
    expect(req.answers.jurisdiction).toBe("free_zone");
    expect(req.scope.lines).toEqual(expect.arrayContaining([{ code: "SET-FZ-LIC", qty: 1 }, { code: "VISA-RES", qty: 2 }]));
    const [ev] = await rows(env, "select data from audit_events where action = 'scoping.approved' and entity_id = $1", [id]);
    expect(ev.data.rescoped).toMatchObject({ from: "offshore", after: expect.arrayContaining([{ code: "VISA-RES", qty: 2 }]) });
    expect(await offerStatus(offshoreOffer)).toBe("withdrawn");
    expect((await publish(offshoreOffer)).status).toBe(409);
    const fresh = await build(id);
    expect((await publish(fresh)).status).toBe(200);
  });

  it("a request whose advice disagrees with what the client asked for waits for the review", async () => {
    const id = await request({ jurisdiction: "mainland", visas: 1, activity: "consulting", customers: "international" });
    const offer = await build(id);
    const refused = await publish(offer);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/asked for mainland but the advice points to free zone/);
    // Ops agrees with the client: mainland is approved, the request keeps its mainland scope, the quote goes out.
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, { structure: "mainland", note: "Client wants government tenders" })).status).toBe(200);
    expect((await publish(offer)).status).toBe(200);
  });

  it("an offer built before the structure changed cannot be published: it prices the old licence", async () => {
    const id = await request({ jurisdiction: "free_zone", visas: 1 }); // no scoping answers: no advice, structure as asked
    const offer = await build(id);
    await asPlatform(env.db, null, (tx) => tx.query("update requests set answers = jsonb_set(answers, '{jurisdiction}', '\"mainland\"') where id = $1", [id]));
    const refused = await publish(offer);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/prices SET-FZ-LIC but the settled structure is mainland \(SET-ML-LIC\)/);
  });

  it("advice approved under earlier facts cannot carry an excluded structure into a quote", async () => {
    const id = await request({ jurisdiction: "free_zone", visas: 1, activity: "consulting", customers: "international" });
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, { note: "ok" })).status).toBe(200);
    const offer = await build(id);
    // The facts change after approval (here: the activity turns out to be regulated finance).
    await asPlatform(env.db, null, (tx) => tx.query("update requests set answers = jsonb_set(answers, '{activity}', '\"finance\"') where id = $1", [id]));
    const refused = await publish(offer);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/free zone does not fit this request: A regulated financial activity needs a regulator-specific licence/);
  });

  it("a DIFC/ADGM formation has its own code: a free zone estimate is withdrawn, never published as the DIFC/ADGM quote", async () => {
    const id = await request({ jurisdiction: "not_sure", visas: 1, activity: "finance", customers: "international", budgetAed: 100_000 });
    const estimate = await build(id);
    expect(await codesOf(estimate)).toContain("SET-FZ-LIC");
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, { note: "Regulated: DIFC or ADGM" })).status).toBe(200);
    const [req] = await rows(env, "select answers, scope from requests where id = $1", [id]);
    expect(req.answers.jurisdiction).toBe("difc_adgm");
    expect(req.scope.lines.map((l: any) => l.code)).toEqual(expect.arrayContaining(["SET-DIFC", "VISA-RES"]));
    expect(req.scope.lines.map((l: any) => l.code)).not.toContain("SET-FZ-LIC");
    expect(await offerStatus(estimate)).toBe("withdrawn");
    expect((await publish(estimate)).status).toBe(409);
    const fresh = await build(id);
    expect(await codesOf(fresh)).toContain("SET-DIFC");
    expect((await publish(fresh)).status).toBe(200);
  });

  it("a company formation priced as a service or add-on has no structure check behind it, so it is refused", async () => {
    const svc = (await env.call("client", "POST", "/api/requests", { answers: { mode: "services", emirate: "Dubai", services: ["SET-ML-LIC"] } })).body.id;
    const refused = await publish(await build(svc));
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/prices a company formation \(SET-ML-LIC\) but the request is not for a new company/);
    // Two formations on one offer (a free zone with a mainland licence added on) are refused too.
    const two = await request({ jurisdiction: "free_zone", visas: 1, addOns: ["SET-ML-LIC"] });
    const offer = await build(two);
    expect(await codesOf(offer)).toEqual(expect.arrayContaining(["SET-FZ-LIC", "SET-ML-LIC"]));
    const both = await publish(offer);
    expect(both.status).toBe(409);
    expect(both.body.message).toMatch(/prices more than one company formation \(SET-FZ-LIC, SET-ML-LIC\)/);
  });

  it("re-scoping keeps the lines ops added, and stops once partners have been asked to quote", async () => {
    const id = await request({ jurisdiction: "not_sure", visas: 1, activity: "trading", customers: "uae_mainland", premises: "retail" });
    // Ops added a bank account to the scope after intake (as an approved AI draft would).
    await asPlatform(env.db, null, (tx) => tx.query(`update requests set scope = jsonb_set(scope, '{lines}', (scope->'lines') || '[{"code":"BANK-ACC","qty":1}]'::jsonb) where id = $1`, [id]));
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, {})).status).toBe(200);
    const [req] = await rows(env, "select answers, scope from requests where id = $1", [id]);
    expect(req.answers.jurisdiction).toBe("mainland");
    expect(req.scope.lines.map((l: any) => l.code).sort()).toEqual(["BANK-ACC", "SET-ML-LIC", "VISA-RES"]);

    const sent = await request({ jurisdiction: "not_sure", visas: 1, activity: "trading", customers: "uae_mainland", premises: "retail" });
    expect((await env.call("ops", "POST", `/api/ops/requests/${sent}/rfq`, { codes: ["SET-FZ-LIC"] })).status).toBe(200);
    const late = await env.call("ops", "POST", `/api/ops/requests/${sent}/scoping/approve`, {});
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/sealed quotes are for the structure as sent/);
  });

  it("a statement ops removes is gone from everything the client sees, findings included; flags are recomputed", async () => {
    const id = await request({ jurisdiction: "free_zone", visas: 1, activity: "tech", customers: "both" });
    const before = (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body.advice;
    expect(JSON.stringify(before)).toContain("structure.free_zone_mainland_sales");
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, { removeRuleKeys: ["structure.free_zone_mainland_sales"] })).status).toBe(200);
    const mine = (await env.call("client", "GET", "/api/client/home")).body.requests.find((r: any) => r.id === id);
    expect(JSON.stringify(mine.advice)).not.toContain("structure.free_zone_mainland_sales");
    expect(mine.advice.needsVerification).toBe(true); // UNCERTAIN rules remain

    // No place fits a budget of AED 1,000: the engine says no option fits; once ops settles a structure, it does not.
    const poor = await request({ jurisdiction: "not_sure", visas: 0, activity: "consulting", customers: "international", budgetAed: 1_000 });
    expect((await env.call("ops", "GET", `/api/ops/requests/${poor}/scoping`)).body.advice.noViableOption).toBe(true);
    expect((await env.call("ops", "POST", `/api/ops/requests/${poor}/scoping/approve`, { structure: "free_zone", note: "Founder raises the budget" })).status).toBe(200);
    const approved = (await env.call("client", "GET", "/api/client/home")).body.requests.find((r: any) => r.id === poor);
    expect(approved.advice.noViableOption).toBe(false);
  });

  it("once an offer is accepted, the structure changes only through a change order", async () => {
    const id = await request({ jurisdiction: "free_zone", visas: 1, activity: "tech", customers: "international" });
    const offer = await build(id);
    expect((await publish(offer)).status).toBe(200);
    expect((await env.call("client", "POST", `/api/client/offers/${offer}/accept`)).status).toBe(200);
    const late = await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, { structure: "mainland" });
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/already accepted/);
  });

  it("requests without a company formation are not held", async () => {
    const id = (await env.call("client", "POST", "/api/requests", { answers: { mode: "services", emirate: "Dubai", services: ["VAT-RET"] } })).body.id;
    const offer = await build(id);
    expect((await publish(offer)).status).toBe(200);
  });

  it("the advice the client finally sees carries no partner, price list or margin, whatever the structure", async () => {
    const id = await request({ jurisdiction: "not_sure", visas: 3, activity: "trading", customers: "uae_mainland", premises: "warehouse", budgetAed: 40_000, ownerType: "company", foreignTaxResident: true });
    await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, {});
    const mine = (await env.call("client", "GET", "/api/client/home")).body.requests.find((r: any) => r.id === id);
    expect(mine.advice.structure.recommendation).toBe("mainland");
    expect(mine.advice.crossBorder.map((r: any) => r.ruleKey)).toEqual(expect.arrayContaining(["crossborder.corporate_shareholder", "crossborder.founder_residence"]));
    // Every key and value, at any depth: no partner, cost, price list, margin or payout field.
    const seen: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (seen.push(k), walk(x));
      else if (typeof v === "string") seen.push(v);
    };
    walk(mine.advice);
    expect(seen.length).toBeGreaterThan(50);
    for (const s of seen) expect(s, s).not.toMatch(/margin|partner_?(unit|cost|org|id)|payout|rate_?card|professional_?fils|commission/i);
  });
});

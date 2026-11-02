import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/lib/auth.ts";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E6: the owner's contract scenarios (section 11), end to end over HTTP on the seeded catalogue, where every rule
 * and place is UNCERTAIN until a named person verifies it, as on the day of the pilot. Each test names the checks it
 * covers from the contract's list: [eligibility] the status and recommendation; [escalation] exclusion or a person's
 * review; [rationale] the reasons shown; [confidence] confidence propagation; [no-price] no invented figure;
 * [access] no unauthorised reading; [no-side-effect] nothing irreversible without a person; [client-view] what the
 * client's own API view shows is exactly what the review approved (the screens themselves are the smoke test's
 * business; docs/evidence/E6/SCENARIOS.md names the checks per scenario). A test that verifies or approves anything
 * puts it back, so every later test still runs on an unverified catalogue; facts (append-only) are recorded by the
 * test that needs them, so each test runs alone.
 */
const MONEY = /margin|partner_?(unit|cost|org|id)|payout|rate_?card|professional_?fils|commission|digest|lastFactId/i;
const walk = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), walk(x, out));
  else if (typeof v === "string") out.push(v);
  return out;
};
const noMoney = (v: unknown) => {
  for (const s of walk(v)) expect(s, s).not.toMatch(MONEY);
};
const keysOf = (a: any): string[] => [...a.structure.reasons, ...a.licences, ...a.obligations, ...(a.crossBorder ?? [])].map((r: any) => r.ruleKey);
const structureOf = (a: any, s: string) => a.structures.find((x: any) => x.structure === s);
const finding = (p: any, key: string) => p.findings?.find((f: any) => f.ruleKey === key);
const day = (d: Date, delta: number) => new Date(d.getTime() + delta * 86_400_000).toISOString().slice(0, 10);

describe("the contract's scenarios, end to end", () => {
  let env: TestEnv;
  const count = async (table: string): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`))).rows[0]!.n;
  const request = async (answers: Record<string, unknown>, who = "client") => {
    const r = await env.call(who, "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Dubai", ...answers } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { id: string; adviceStatus: string; aiDraft: string | null };
  };
  const scoping = async (id: string) => (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body;
  const advice = async (answers: Record<string, unknown>) => (await scoping((await request(answers)).id)).advice;
  const approve = (id: string, body: Record<string, unknown> = {}) => env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, body);
  const build = async (id: string) => {
    const r = await env.call("ops", "POST", `/api/ops/requests/${id}/build-offers`, { tiers: ["standard"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { offerIds: string[]; missing: string[] };
  };
  const publish = (offerId: string) => env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
  const mine = async (id: string, who = "client") => (await env.call(who, "GET", "/api/client/home")).body.requests.find((r: any) => r.id === id);
  const fact = (body: Record<string, unknown>) => env.call("founder", "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", sourceUrl: "https://example.test/source", evidenceDate: day(env.clock.now, -1), confidence: "UNCERTAIN", ...body });
  const publicAssess = (answers: Record<string, unknown>) => env.call("anon", "POST", "/api/public/assess", { emirate: "Dubai", ...answers });
  const lines = (offerId: string) => asPlatform(env.db, null, async (tx) => (await tx.query<{ code: string }>("select code from offer_lines where offer_id = $1 order by code", [offerId])).rows.map((r) => r.code));
  /**
   * The public result and the review for the same answers must agree on what is eligible: one engine, two readers.
   * The public list carries the fitting places first, in the review's order, then the excluded ones as "to be
   * verified" (an exclusion's reason is public only once its rule is approved for display, D80).
   */
  const sameEngine = async (answers: Record<string, unknown>) => {
    const a = await advice({ jurisdiction: "not_sure", ...answers });
    const p = (await publicAssess(answers)).body;
    expect(p.places.length).toBeGreaterThan(0); // the excluded places are listed too, as "to be verified"
    expect(p.places.slice(0, a.places.length).map((x: any) => x.zone)).toEqual(a.places.map((x: any) => x.zone));
    expect(p.places.every((x: any) => x.toBeVerified && !x.figures)).toBe(true);
    return { a, p };
  };

  /** Facilities on record for scenarios 6 and 8; facts are append-only, so recording them twice is harmless. */
  const facilitiesOnRecord = async () => {
    expect((await fact({ subject: "RAKEZ", field: "facilities", valueText: "office, warehouse, industrial", confidence: "rule_of_thumb" })).status).toBe(200);
    expect((await fact({ subject: "IFZA", field: "facilities", valueText: "office", confidence: "rule_of_thumb" })).status).toBe(200);
    expect((await fact({ subject: "Abu Dhabi DED mainland", field: "facilities", valueText: "office, industrial", confidence: "rule_of_thumb" })).status).toBe(200);
  };

  beforeAll(async () => {
    env = await makeEnv();
    // A second client, for the access checks, with its own session.
    const other = await env.call("ops", "POST", "/api/ops/clients", { company: "Other Trading LLC", ownerName: "Other Owner", ownerEmail: "other-owner@example.test" });
    expect(other.status).toBe(200);
    env.tokens.other = await createSession(env.db, "other-owner@example.test");
    // The setup partner prices every formation, so quotes for each structure can be built.
    expect((await env.call("setup", "PUT", "/api/partner/rate-cards", { cards: [{ code: "SET-OFF", professionalAed: 4_000, workingDays: 7 }, { code: "SET-DIFC", professionalAed: 15_000, workingDays: 20 }, { code: "SET-ML-LIC", professionalAed: 6_000, workingDays: 12 }] })).status).toBe(200);
  });
  afterAll(() => env.db.close());

  it("1. Indian SaaS founder selling to US clients, two visas [eligibility] [rationale] [no-side-effect] [client-view] [access]", async () => {
    const answers = { activity: "tech", customers: "international", visas: 2, budgetAed: 25_000, premises: "office", ownerType: "individuals", foreignTaxResident: true };
    const r = await request({ jurisdiction: "not_sure", ...answers });
    const s = await scoping(r.id);
    const a = s.advice;
    expect(a.structure.recommendation).toBe("free_zone");
    expect(structureOf(a, "offshore").status).toBe("INELIGIBLE");
    expect(keysOf(a)).toEqual(expect.arrayContaining(["crossborder.founder_residence", "crossborder.permanent_establishment", "obligation.ct_qfzp"]));
    expect(finding(a.places[0], "place.visa_package")?.outcome).toBe("condition"); // the standard package covers one visa
    // Nothing is verified on the seeded catalogue, so nothing is ELIGIBLE_VERIFIED and every finding says so.
    expect(a.places.every((p: any) => p.status === "REQUIRES_VERIFICATION" || p.status === "ELIGIBLE_CONDITIONAL")).toBe(true);
    expect(a.hasUncertain).toBe(true);
    for (const reason of a.structure.reasons) expect(reason.confidence).toBe("UNCERTAIN");
    // The client sees nothing until a person approves; then exactly what the review approved.
    expect(r.adviceStatus).toBe("pending_review");
    expect((await mine(r.id)).advice).toBeNull();
    expect((await approve(r.id, { note: "SaaS, international" })).status).toBe(200);
    const shown = (await mine(r.id)).advice;
    expect(shown.structure.recommendation).toBe(a.structure.recommendation);
    expect(shown.places.map((p: any) => p.zone)).toEqual(a.places.map((p: any) => p.zone));
    expect(shown.dataVersion).toEqual({ asOf: a.dataVersion.asOf });
    noMoney(shown);
    // Nobody else reads it: another client's home does not list it, a partner cannot open the review.
    expect((await env.call("other", "GET", "/api/client/home")).body.requests.map((x: any) => x.id)).not.toContain(r.id);
    expect((await env.call("setup", "GET", `/api/ops/requests/${r.id}/scoping`)).status).toBe(403);
    // The public selector gives the same places for the same answers, confirms nothing and shows no figure.
    const p = (await publicAssess(answers)).body;
    expect(p.places.slice(0, a.places.length).map((x: any) => x.zone)).toEqual(a.places.map((x: any) => x.zone));
    expect(p.structure).toMatchObject({ confirmed: false, recommendation: null });
    expect(p.places.every((x: any) => x.toBeVerified && !x.figures)).toBe(true);
  });

  it("2. UAE mainland retailer with a physical store [eligibility] [escalation] [rationale] [no-price] [no-side-effect]", async () => {
    const answers = { activity: "trading", customers: "uae_mainland", premises: "retail", visas: 2 };
    const { a } = await sameEngine(answers);
    expect(a.structure.recommendation).toBe("mainland");
    expect(a.places[0].zone).toBe("Dubai DET mainland");
    const offshore = structureOf(a, "offshore");
    expect(offshore.status).toBe("INELIGIBLE");
    expect(offshore.findings.map((f: any) => f.ruleKey)).toEqual(expect.arrayContaining(["structure.offshore_no_visas", "structure.offshore_no_premises", "structure.offshore_no_onshore_trade"]));
    expect(structureOf(a, "free_zone").findings.map((f: any) => f.ruleKey)).toEqual(expect.arrayContaining(["structure.free_zone_mainland_sales", "structure.free_zone_onshore_premises"]));
    // A quote waits for a settled structure, and then prices only the mainland licence.
    const r = await request({ jurisdiction: "not_sure", ...answers });
    const { offerIds } = await build(r.id);
    const refused = await publish(offerIds[0]!);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/not sure which structure fits/);
    expect((await env.call("client", "GET", `/api/client/offers/${offerIds[0]}`)).status).toBe(404);
    expect((await approve(r.id, { structure: "mainland", note: "Retail store in Dubai" })).status).toBe(200);
    const { offerIds: again } = await build(r.id);
    expect(await lines(again[0]!)).toContain("SET-ML-LIC");
    expect(await lines(again[0]!)).not.toContain("SET-FZ-LIC");
    expect((await publish(again[0]!)).status).toBe(200);
    const offer = (await env.call("client", "GET", `/api/client/offers/${again[0]}`)).body;
    expect(offer.clientTotal).toBeGreaterThan(0);
    noMoney(offer);
  });

  it("3. holding company with residence visas [eligibility] [escalation] [rationale]", async () => {
    const { a } = await sameEngine({ activity: "holding", visas: 2, budgetAed: 12_000 });
    expect(a.structure.recommendation).not.toBe("offshore");
    expect(a.places.every((p: any) => p.type !== "offshore")).toBe(true);
    for (const name of ["RAK ICC", "JAFZA Offshore"]) {
      const ex = a.excluded.find((p: any) => p.zone === name);
      expect(ex, name).toBeTruthy();
      expect(finding(ex, "structure.offshore_no_visas")?.outcome).toBe("fail");
    }
    // Ops cannot settle offshore for this request either.
    const r = await request({ jurisdiction: "not_sure", activity: "holding", visas: 2, budgetAed: 12_000 });
    const refused = await approve(r.id, { structure: "offshore" });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/offshore/i);
  });

  it("4. holding company with no visas [eligibility] [no-price]", async () => {
    const a = await advice({ emirate: "Ras Al Khaimah", jurisdiction: "not_sure", activity: "holding", visas: 0, budgetAed: 15_000 });
    expect(a.structure.recommendation).toBe("offshore");
    expect(a.places[0].zone).toBe("RAK ICC");
    // The setup estimate carries the place's own confidence (UNCERTAIN on the seeded catalogue), never a price.
    expect(a.places[0]).toMatchObject({ confidence: "UNCERTAIN" });
    expect(finding(a.places[0], "place.budget")).toMatchObject({ outcome: "pass", confidence: "UNCERTAIN" });
    const p = (await publicAssess({ emirate: "Ras Al Khaimah", activity: "holding", visas: 0, budgetAed: 15_000 })).body;
    expect(p.places[0]).toMatchObject({ zone: "RAK ICC", toBeVerified: true });
    expect(p.places[0].figures).toBeUndefined();
  });

  it("5. foreign corporation setting up a subsidiary [rationale] [escalation]", async () => {
    const r = await request({ jurisdiction: "not_sure", activity: "consulting", customers: "both", visas: 1, ownerType: "company" });
    const a = (await scoping(r.id)).advice;
    expect(keysOf(a)).toContain("crossborder.corporate_shareholder");
    expect(a.crossBorder.find((x: any) => x.ruleKey === "crossborder.corporate_shareholder").confidence).toBe("UNCERTAIN");
    // The request waits for a person, as every new-company request does: it sits in the scoping queue until ops reviews it.
    expect((await env.call("ops", "GET", "/api/ops/overview")).body.exceptions.some((x: any) => x.kind === "scoping" && x.ref === r.id)).toBe(true);
  });

  it("6. manufacturing needing industrial land [eligibility] [escalation] [confidence]", async () => {
    const answers = { emirate: "Abu Dhabi", jurisdiction: "not_sure", activity: "manufacturing", customers: "international", visas: 3, premises: "industrial" };
    // No place has facilities on record: nothing is offered as fit, nothing is excluded on a guess; the data is named.
    const before = await advice(answers);
    const recorded = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.filter((p: any) => p.facilities?.length).map((p: any) => p.name);
    const unknownBefore = before.places.filter((p: any) => !recorded.includes(p.zone));
    expect(unknownBefore.length).toBeGreaterThan(0);
    expect(unknownBefore.every((p: any) => p.status === "DATA_UNAVAILABLE" && finding(p, "place.industrial_facilities")?.missing === "data")).toBe(true);
    expect(keysOf(before)).toContain("structure.industrial_licence");
    // The founder records what each place offers; the engine then qualifies on that record, at its confidence.
    await facilitiesOnRecord();
    const r = await request(answers);
    const after = (await scoping(r.id)).advice;
    expect(after.places[0].zone).toBe("RAKEZ");
    expect(after.places[0].status).toBe("REQUIRES_VERIFICATION"); // qualified on the record; the rules are still unverified
    expect(finding(after.places[0], "place.industrial_facilities")).toBeUndefined(); // nothing to flag once the land is on record
    expect(finding(after.excluded.find((p: any) => p.zone === "IFZA"), "place.industrial_facilities")).toMatchObject({ outcome: "fail", confidence: "UNCERTAIN" }); // rule-of-thumb data, capped by the unverified rule
    // Ops settles mainland for the Abu Dhabi plant: the places are ranked again for that structure, on the record.
    const approved = await approve(r.id, { structure: "mainland", note: "Plant in Abu Dhabi" });
    expect(approved.status).toBe(200);
    expect(approved.body.places[0].zone).toBe("Abu Dhabi DED mainland");
    expect(approved.body.places[0].status).toBe("REQUIRES_VERIFICATION");
    // The other mainland registries have no land on record: listed below, as data missing, never passed on a guess.
    expect(approved.body.places.length).toBeGreaterThan(1);
    expect(approved.body.places.slice(1).every((p: any) => p.status === "DATA_UNAVAILABLE")).toBe(true);
  });

  it("7. food importer distributing on the mainland [eligibility] [rationale]", async () => {
    const { a } = await sameEngine({ activity: "food", customers: "uae_mainland", visas: 3 });
    expect(a.structure.recommendation).toBe("mainland");
    expect(keysOf(a)).toContain("licence.food");
    expect(a.licences.find((x: any) => x.ruleKey === "licence.food").confidence).toBe("UNCERTAIN");
  });

  it("8. cross-border e-commerce needing storage [eligibility] [escalation] [rationale]", async () => {
    const answers = { jurisdiction: "not_sure", activity: "ecommerce", customers: "international", premises: "warehouse", visas: 1 };
    await facilitiesOnRecord();
    const before = await advice(answers);
    // With facilities on record for two places: IFZA (office only) is excluded, RAKEZ (warehouse) qualifies. Every
    // other place says the data is missing and ranks below, instead of being passed on a guess.
    expect(finding(before.excluded.find((p: any) => p.zone === "IFZA"), "place.warehouse_facilities")).toMatchObject({ outcome: "fail", confidence: "UNCERTAIN" });
    expect(before.places[0].zone).toBe("RAKEZ");
    const unknown = before.places.filter((p: any) => p.zone !== "RAKEZ");
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((p: any) => p.status === "DATA_UNAVAILABLE" && finding(p, "place.warehouse_facilities")?.missing === "data")).toBe(true);
    expect(keysOf(before)).toContain("obligation.vat_designated_zone");
    expect((await fact({ subject: "Meydan Free Zone", field: "facilities", valueText: "office, warehouse" })).status).toBe(200);
    const after = await advice(answers);
    const meydan = after.places.find((p: any) => p.zone === "Meydan Free Zone");
    expect(meydan.status).toBe("REQUIRES_VERIFICATION");
    expect(finding(meydan, "place.warehouse_facilities")).toBeUndefined(); // nothing to flag once warehousing is on record
    expect(after.places.indexOf(meydan)).toBeLessThan(after.places.findIndex((p: any) => p.status === "DATA_UNAVAILABLE"));
  });

  it("9. regulated financial services [eligibility] [escalation] [no-side-effect]", async () => {
    const answers = { emirate: "Abu Dhabi", jurisdiction: "not_sure", activity: "finance", customers: "international", visas: 3, budgetAed: 100_000 };
    const r = await request(answers);
    const a = (await scoping(r.id)).advice;
    expect(structureOf(a, "free_zone").status).toBe("INELIGIBLE");
    expect(a.structure.recommendation).toBe("difc_adgm");
    expect(a.places[0].zone).toBe("ADGM");
    expect(a.places.every((p: any) => p.status !== "ELIGIBLE_VERIFIED")).toBe(true);
    expect(structureOf(a, "difc_adgm").findings.some((f: any) => f.ruleKey === "structure.financial_regulated")).toBe(true);
    // The quote prices the DIFC/ADGM formation and nothing else, only after a person settles it.
    expect((await approve(r.id, { note: "Fund manager, ADGM" })).status).toBe(200);
    const { offerIds } = await build(r.id);
    const codes = await lines(offerIds[0]!);
    expect(codes).toContain("SET-DIFC");
    expect(codes.filter((c) => c.startsWith("SET-"))).toEqual(["SET-DIFC"]);
    expect((await publish(offerIds[0]!)).status).toBe(200);
  });

  it("10. virtual-asset business [eligibility] [rationale]", async () => {
    const { a } = await sameEngine({ activity: "virtual_assets", customers: "international", visas: 2 });
    expect(structureOf(a, "offshore").status).toBe("INELIGIBLE");
    const viable = a.structures.filter((s: any) => s.status !== "INELIGIBLE");
    expect(viable.length).toBeGreaterThan(0);
    for (const s of viable) expect(s.findings.find((f: any) => f.ruleKey === "structure.virtual_assets_regulated"), s.structure).toMatchObject({ outcome: "condition" });
    expect(JSON.stringify(a)).toMatch(/VARA/);
  });

  it("11. healthcare provider needing licensed premises [eligibility] [rationale]", async () => {
    const { a } = await sameEngine({ activity: "health", customers: "uae_mainland", premises: "clinic", visas: 4 });
    expect(a.structure.recommendation).toBe("mainland");
    expect(finding(structureOf(a, "mainland"), "licence.health")?.outcome).toBe("condition");
  });

  it("12. university or training institute [eligibility] [rationale]", async () => {
    const { a } = await sameEngine({ activity: "education", customers: "both", premises: "office", visas: 5 });
    expect(keysOf(a)).toContain("licence.education");
    for (const s of a.structures.filter((x: any) => !["offshore", "difc_adgm"].includes(x.structure))) expect(s.findings.some((f: any) => f.ruleKey === "licence.education"), s.structure).toBe(true);
  });

  it("13. free zone company seeking mainland permissions [eligibility] [rationale] [client-view]", async () => {
    const r = await request({ jurisdiction: "free_zone", activity: "consulting", customers: "both", visas: 1 });
    const a = (await scoping(r.id)).advice;
    expect(a.structure.recommendation).toBe("free_zone");
    const condition = finding(structureOf(a, "free_zone"), "structure.free_zone_mainland_sales");
    expect(condition).toMatchObject({ outcome: "condition", confidence: "UNCERTAIN" });
    expect((await approve(r.id)).status).toBe(200);
    const shown = (await mine(r.id)).advice;
    expect(finding(structureOf(shown, "free_zone"), "structure.free_zone_mainland_sales")).toEqual(condition);
    const { offerIds } = await build(r.id);
    expect(await lines(offerIds[0]!)).toContain("SET-FZ-LIC");
  });

  it("14. existing free zone company comparing renewals [confidence] [no-price]", async () => {
    expect((await fact({ subject: "IFZA", field: "renewal_cost", valueText: "8000-11000", confidence: "rule_of_thumb" })).status).toBe(200);
    expect((await fact({ subject: "SHAMS", field: "renewal_cost", valueText: "5000-7000", confidence: "UNCERTAIN" })).status).toBe(200);
    const a = await advice({ jurisdiction: "free_zone", activity: "tech", customers: "international", visas: 1 });
    expect(a.places.find((p: any) => p.zone === "IFZA")).toMatchObject({ renewalMinFils: 800_000, renewalMaxFils: 1_100_000, renewalConfidence: "rule_of_thumb" });
    expect(a.places.find((p: any) => p.zone === "SHAMS")).toMatchObject({ renewalMinFils: 500_000, renewalMaxFils: 700_000, renewalConfidence: "UNCERTAIN" });
    // A place with no renewal on record shows none: no figure is invented.
    const meydan = a.places.find((p: any) => p.zone === "Meydan Free Zone");
    expect(meydan.renewalMinFils ?? null).toBeNull();
    // The public selector shows no renewal figure for a place that is not approved for display.
    const p = (await publicAssess({ activity: "tech", customers: "international", visas: 1 })).body;
    expect(JSON.stringify(p)).not.toMatch(/renewal/i);
  });

  it("15. visas exceed the package limit [eligibility] [escalation] [confidence]", async () => {
    expect((await fact({ subject: "SHAMS", field: "visa_max", valueText: "3", confidence: "rule_of_thumb" })).status).toBe(200);
    const a = await advice({ emirate: "Sharjah", jurisdiction: "not_sure", activity: "consulting", customers: "international", visas: 6 });
    const shams = a.excluded.find((p: any) => p.zone === "SHAMS");
    expect(finding(shams, "place.visa_capacity")).toMatchObject({ outcome: "fail", confidence: "UNCERTAIN" }); // the rule is unverified, whatever the data says
    const ifza = a.places.find((p: any) => p.zone === "IFZA");
    expect(finding(ifza, "place.visa_package")?.outcome).toBe("condition");
  });

  it("16. insufficient budget [eligibility] [escalation] [no-price] [no-side-effect]", async () => {
    const answers = { activity: "consulting", customers: "international", visas: 1, budgetAed: 2_000 };
    const { a, p } = await sameEngine(answers);
    expect(a.places).toEqual([]);
    expect(a.noViableOption).toBe(true);
    expect(keysOf(a)).toContain("structure.no_viable_option");
    expect(a.excluded.every((x: any) => finding(x, "place.budget")?.outcome === "fail")).toBe(true);
    // The public conclusion "no option fits" rests on the budget rule, which nobody has approved for display (D80):
    // the public sees no recommendation and every place as "to be verified", with no figure and no promise.
    expect(p.noViableOption).toBe(false);
    expect(p.structure.recommendation).toBeNull();
    expect(p.places.every((x: any) => x.toBeVerified && !x.figures)).toBe(true);
    // No quote is published on the engine's say-so, even when the client named the structure: a formation quote is
    // refused because no option fits (gate added in E6), and a specialist assessment is the way forward.
    const named = await request({ jurisdiction: "free_zone", ...answers });
    const refusedNamed = await publish((await build(named.id)).offerIds[0]!);
    expect(refusedNamed.status).toBe(409);
    expect(refusedNamed.body.message).toMatch(/no option that fits every answer/);
    // Only a person's approval of a structure at the review (audited, E1) opens the way to a quote: that is the
    // specialist's decision, not the engine's, and the figures are then a real quote, not an estimate.
    const r = await request({ jurisdiction: "not_sure", ...answers });
    expect((await publish((await build(r.id)).offerIds[0]!)).status).toBe(409);
    expect((await approve(r.id, { structure: "free_zone", note: "Budget is indicative; proceed with the free zone" })).status).toBe(200);
    expect((await publish((await build(r.id)).offerIds[0]!)).status).toBe(200);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select 1 from audit_events where action = 'scoping.approved' and entity_id = $1", [r.id]))).rows).toHaveLength(1);
  });

  it("17. multiple regulated activities [escalation] [no-side-effect]", async () => {
    // The assessment takes one activity; the rest goes to a person through the description and the AI draft queue.
    const r = await request({ jurisdiction: "not_sure", activity: "finance", customers: "both", visas: 4, description: "Investment advisory, plus a day-surgery clinic and a training academy under the same group" });
    const s = await scoping(r.id);
    expect(keysOf(s.advice)).toContain("structure.financial_regulated");
    expect(keysOf(s.advice)).not.toContain("licence.health"); // the engine does not guess a second activity from prose
    expect(r.aiDraft).toBeTruthy();
    expect(s.drafts.map((d: any) => d.status)).toEqual(["pending"]);
    expect(s.scope.lines.map((l: any) => l.code).sort()).toEqual(["SET-FZ-LIC", "VISA-RES"]); // the engine's default scope for "not sure": the draft has not touched it
    expect((await env.call("ops", "GET", "/api/ops/overview")).body.exceptions.some((x: any) => x.kind === "ai_draft" && x.ref === r.aiDraft)).toBe(true);
    const { offerIds } = await build(r.id);
    const refused = await publish(offerIds[0]!);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/not sure which structure fits: settle it at the scoping review/);
  });

  it("18. holding plus operating company [eligibility] [escalation]", async () => {
    // One assessment is one entity: a holding vehicle with visas and onshore customers is not promised a structure.
    const a = await advice({ jurisdiction: "not_sure", activity: "holding", customers: "uae_mainland", visas: 2, budgetAed: 50_000 });
    expect(a.structures.every((s: any) => s.status !== "ELIGIBLE_VERIFIED")).toBe(true);
    expect(structureOf(a, "offshore").status).toBe("INELIGIBLE");
    expect(a.hasUncertain).toBe(true);
    const r = await request({ jurisdiction: "not_sure", activity: "holding", customers: "uae_mainland", visas: 2, budgetAed: 50_000 });
    const { offerIds } = await build(r.id);
    const refused = await publish(offerIds[0]!);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/not sure which structure fits: settle it at the scoping review/);
  });

  it("19. missing jurisdiction source data [escalation] [no-price]", async () => {
    const places = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places;
    const pending = places.filter((p: any) => p.placeholder || p.active === false).map((p: any) => p.name);
    expect(pending).toEqual(expect.arrayContaining(["UAQ Free Trade Zone", "Fujairah Free Zone", "Fujairah Creative City"]));
    const a = await advice({ emirate: "Umm Al Quwain", jurisdiction: "free_zone", activity: "consulting", customers: "international", visas: 1 });
    expect([...a.places, ...a.excluded].map((p: any) => p.zone)).not.toContain("UAQ Free Trade Zone");
    const refused = await env.call("founder", "POST", "/api/admin/public-display/approve", { kind: "place", subject: "UAQ Free Trade Zone", note: "x" });
    expect(refused.status).toBe(404);
    expect(refused.body.message).toMatch(/No place UAQ Free Trade Zone/); // not even listed for approval
    const p = (await publicAssess({ emirate: "Umm Al Quwain", activity: "consulting", customers: "international", visas: 1 })).body;
    expect(JSON.stringify(p)).not.toContain("UAQ Free Trade Zone");
  });

  it("20. expired regulatory or price source [confidence] [escalation]", async () => {
    const verify = (path: string, body: Record<string, unknown>) => env.call("founder", "PUT", path, { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://example.test/verified", ...body });
    expect((await verify("/api/admin/scoping/rules/obligation.ubo", { nextVerification: day(env.clock.now, 30) })).status).toBe(200);
    expect((await verify("/api/admin/scoping/zones/Ajman%20Free%20Zone", { nextVerification: day(env.clock.now, 30) })).status).toBe(200);
    const display = (kind: string, subject: string) => env.call("founder", "POST", "/api/admin/public-display/approve", { kind, subject, note: "checked" });
    expect((await display("rule", "obligation.ubo")).status).toBe(200);
    expect((await display("place", "Ajman Free Zone")).status).toBe(200);
    const answers = { emirate: "Ajman", jurisdiction: "free_zone", activity: "trading", customers: "international", visas: 1 };
    const fresh = await advice(answers);
    expect(fresh.obligations.find((o: any) => o.ruleKey === "obligation.ubo").confidence).toBe("verified");
    expect(fresh.places.find((p: any) => p.zone === "Ajman Free Zone").confidence).toBe("verified");
    expect((await publicAssess({ emirate: "Ajman", activity: "trading", customers: "international", visas: 1 })).body.places.find((x: any) => x.zone === "Ajman Free Zone").figures).toBeTruthy();
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 31 * 86_400_000);
    try {
      const stale = await advice(answers);
      expect(stale.obligations.find((o: any) => o.ruleKey === "obligation.ubo").confidence).toBe("rule_of_thumb");
      expect(stale.places.find((p: any) => p.zone === "Ajman Free Zone").confidence).toBe("rule_of_thumb");
      expect(stale.hasUncertain).toBe(true);
      const overview = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body;
      expect(overview.rules.stale).toContain("obligation.ubo");
      const p = (await publicAssess({ emirate: "Ajman", activity: "trading", customers: "international", visas: 1 })).body;
      expect(p.obligations.find((s: any) => s.ruleKey === "obligation.ubo")).toBeUndefined();
      expect(p.places.find((x: any) => x.zone === "Ajman Free Zone")?.figures).toBeUndefined();
      expect((await display("rule", "obligation.ubo")).body.message).toMatch(/past its re-verification date/);
    } finally {
      env.clock.now = saved;
      // Put the catalogue back as it was, so the later scenarios still run on an unverified one.
      for (const [kind, subject] of [["rule", "obligation.ubo"], ["place", "Ajman Free Zone"]]) await env.call("founder", "POST", "/api/admin/public-display/revoke", { kind, subject, note: "test" });
      expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.ubo", { confidence: "UNCERTAIN" })).status).toBe(200);
      expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/Ajman%20Free%20Zone", { confidence: "UNCERTAIN" })).status).toBe(200);
    }
    expect((await advice(answers)).obligations.find((o: any) => o.ruleKey === "obligation.ubo").confidence).toBe("UNCERTAIN");
  });

  it("21. contradictory answers [eligibility] [escalation] [rationale]", async () => {
    const answers = { jurisdiction: "offshore", activity: "consulting", customers: "international", visas: 2, officeNeeded: true, premises: "virtual", taxableSuppliesAed: 900_000, expectedTurnoverAed: 400_000 };
    const r = await request(answers);
    const a = (await scoping(r.id)).advice;
    expect(a.contradictions.length).toBeGreaterThanOrEqual(3);
    expect(a.needsVerification).toBe(true);
    expect(a.structure.reasons.find((x: any) => x.ruleKey === "structure.requested_differs").text).toMatch(/You asked for offshore, which does not fit/);
    expect(structureOf(a, "offshore").status).toBe("INELIGIBLE");
    const { offerIds } = await build(r.id);
    const refused = await publish(offerIds[0]!);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/asked for offshore but the advice points to/);
    expect((await approve(r.id, { structure: "offshore" })).status).toBe(409);
  });

  it("22. withdrawing marketing consent [access] [no-side-effect]", async () => {
    const r = await env.call("anon", "POST", "/api/public/intake", { company: "Withdraw Ltd", name: "W. Founder", email: "withdraw@example.test", consent: true, consentVersion: "2026-11-selector-v1", marketingConsent: true, answers: { mode: "new_company", jurisdiction: "not_sure", emirate: "Dubai", activity: "tech", customers: "international", visas: 1 } });
    expect(r.status).toBe(200);
    const lead = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((l: any) => l.company === "Withdraw Ltd");
    expect(lead.consents).toMatchObject({ service: true, marketing: true });
    const emails = env.emails.length;
    const outbox = await count("outbox");
    expect((await env.call("setup", "POST", `/api/ops/pipeline/leads/${lead.id}/consent-withdraw`, { purpose: "marketing", note: "x" })).status).toBe(403);
    expect((await env.call("other", "POST", `/api/ops/pipeline/leads/${lead.id}/consent-withdraw`, { purpose: "marketing", note: "x" })).status).toBe(403);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${lead.id}/consent-withdraw`, { purpose: "marketing", note: "asked by email" })).status).toBe(200);
    const detail = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${lead.id}`)).body;
    expect(detail.consents).toMatchObject({ service: true, marketing: false });
    expect(detail.consentHistory.filter((c: any) => c.purpose === "marketing").map((c: any) => c.given)).toEqual([true, false]);
    expect(env.emails.length).toBe(emails);
    expect(await count("outbox")).toBe(outbox);
    // The record is append-only and reaches the person's export.
    await expect(asPlatform(env.db, null, (tx) => tx.query("delete from consents"))).rejects.toThrow(/append-only|permission denied/);
    const user = (await asPlatform(env.db, null, (tx) => tx.query<{ id: string }>("select id from users where email = 'withdraw@example.test'"))).rows[0]!;
    const exported = (await env.call("founder", "POST", `/api/admin/users/${user.id}/export`)).body;
    expect(JSON.stringify(exported)).toMatch(/"purpose":"marketing"[^}]*"given":false/);
  });

  it("23. cross-client and cross-partner access [access]", async () => {
    const r = await request({ jurisdiction: "free_zone", activity: "tech", customers: "international", visas: 1 });
    expect((await approve(r.id)).status).toBe(200);
    const { offerIds } = await build(r.id);
    expect((await publish(offerIds[0]!)).status).toBe(200);
    // Another client: none of it, through any door.
    expect((await env.call("other", "GET", "/api/client/home")).body.requests.map((x: any) => x.id)).not.toContain(r.id);
    expect((await env.call("other", "GET", `/api/client/offers/${offerIds[0]}`)).status).toBe(404);
    expect((await env.call("other", "POST", `/api/client/offers/${offerIds[0]}/accept`)).status).toBe(403);
    expect((await env.call("other", "GET", `/api/ops/requests/${r.id}/scoping`)).status).toBe(403);
    expect((await env.call("other", "GET", "/api/ops/pipeline/leads")).status).toBe(403);
    expect((await env.call("other", "GET", "/api/admin/jurisdictions")).status).toBe(403);
    // A partner: no client request, lead, advice or price.
    for (const who of ["setup", "corp"]) {
      expect((await env.call(who, "GET", "/api/client/home")).status).toBe(403);
      expect((await env.call(who, "GET", `/api/client/offers/${offerIds[0]}`)).status).toBe(403);
      expect((await env.call(who, "GET", `/api/ops/requests/${r.id}/scoping`)).status).toBe(403);
      expect((await env.call(who, "GET", "/api/ops/pipeline/leads")).status).toBe(403);
      expect((await env.call(who, "POST", "/api/requests/from-assessment", { code: "ABCDEFGHIJ" })).status).toBe(403);
    }
    // And at the database, as the other client: no row of this client's.
    const otherUser = (await env.call("other", "GET", "/api/me")).body;
    expect((await asUser(env.db, otherUser, (tx) => tx.query("select id from requests where id = $1", [r.id]))).rows).toEqual([]);
    expect((await asUser(env.db, otherUser, (tx) => tx.query("select id from offers where id = $1", [offerIds[0]]))).rows).toEqual([]);
    await expect(asUser(env.db, otherUser, (tx) => tx.query("select margin_fils from offers"))).rejects.toThrow(/permission denied/);
  });

  it("24. pricing changes after approved scoping [no-price] [no-side-effect] [access]", async () => {
    const r = await request({ jurisdiction: "free_zone", activity: "consulting", customers: "international", visas: 1 });
    expect((await approve(r.id)).status).toBe(200);
    const { offerIds } = await build(r.id);
    expect((await publish(offerIds[0]!)).status).toBe(200);
    const shown = (await env.call("client", "GET", `/api/client/offers/${offerIds[0]}`)).body;
    // Both partners raise their price afterwards: the published offer is a snapshot and does not move.
    for (const who of ["setup", "corp"]) expect((await env.call(who, "PUT", "/api/partner/rate-cards", { cards: [{ code: "SET-FZ-LIC", professionalAed: 4_500, govStatedAed: 9_500, workingDays: 10 }] })).status).toBe(200);
    expect((await env.call("client", "GET", `/api/client/offers/${offerIds[0]}`)).body.clientTotal).toBe(shown.clientTotal);
    expect((await scoping(r.id)).advice_status).toBe("approved");
    // Re-pricing is a person's action: it withdraws the old offer and the new one reaches the client only when published.
    const { offerIds: next } = await build(r.id);
    expect(next[0]).not.toBe(offerIds[0]);
    expect((await env.call("client", "GET", `/api/client/offers/${offerIds[0]}`)).status).toBe(404);
    expect((await env.call("client", "GET", `/api/client/offers/${next[0]}`)).status).toBe(404);
    const published = await publish(next[0]!);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const repriced = (await env.call("client", "GET", `/api/client/offers/${next[0]}`)).body;
    expect(repriced.clientTotal).toBeGreaterThan(shown.clientTotal);
    noMoney(repriced);
    // Ops sees the partner's cost and payout (it allocates work) but never the margin, at any depth; finance does.
    for (const s of walk((await env.call("ops", "GET", `/api/ops/offers/${next[0]}`)).body)) expect(s, s).not.toMatch(/margin|commission/i);
    expect((await env.call("finance", "GET", `/api/ops/offers/${next[0]}`)).body.margin).toBeGreaterThan(0);
  });

  it("25. lead to engagement without duplicated customers [no-side-effect] [access]", async () => {
    const orgs = await count("orgs");
    const users = await count("users");
    const emails = env.emails.length;
    const r = await env.call("anon", "POST", "/api/public/intake", { company: "Demo Client again", name: "Client Owner", email: EMAILS.client, consent: true, answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", activity: "consulting", customers: "international", visas: 1 } });
    expect(r.status).toBe(200);
    expect(await count("orgs")).toBe(orgs);
    expect(await count("users")).toBe(users);
    const held = (await asPlatform(env.db, null, (tx) => tx.query<{ id: string }>("select id from intake_leads where status = 'held' and email = $1 order by created_at desc limit 1", [EMAILS.client]))).rows[0]!;
    const converted = await env.call("ops", "POST", `/api/ops/leads/${held.id}/convert`, { note: "Existing client, same person" });
    expect(converted.status).toBe(200);
    const clientOrg = (await env.call("client", "GET", "/api/me")).body.orgId;
    expect(converted.body.clientOrgId).toBe(clientOrg);
    expect((await env.call("ops", "POST", `/api/ops/leads/${held.id}/convert`, { note: "again" })).status).toBe(409);
    // A converted enquiry is not a client yet: the lead becomes "converted" only once an offer is accepted.
    const early = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((l: any) => l.requestId === converted.body.id);
    expect(early).toBeTruthy();
    const tooSoon = await env.call("ops", "POST", `/api/ops/pipeline/leads/${early.id}/status`, { status: "converted" });
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.message).toMatch(/accepted/);
    expect((await approve(converted.body.id)).status).toBe(200);
    const { offerIds } = await build(converted.body.id);
    const published = await publish(offerIds[0]!);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const accepted = await env.call("client", "POST", `/api/client/offers/${offerIds[0]}/accept`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const engagement = (await asPlatform(env.db, null, (tx) => tx.query<{ client_org_id: string }>("select client_org_id from engagements where request_id = $1", [converted.body.id]))).rows[0]!;
    expect(engagement.client_org_id).toBe(clientOrg);
    expect(await count("orgs")).toBe(orgs);
    expect(await count("users")).toBe(users);
    const lead = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((l: any) => l.requestId === converted.body.id);
    expect(lead?.clientOrgId).toBe(clientOrg);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${lead.id}/status`, { status: "converted" })).status).toBe(200);
    // The only messages are the pipeline's own, to the existing client (the neutral intake acknowledgement, the
    // offer, the acceptance) or to MKW; nothing about the lead, and nothing to anyone else.
    const sent = env.emails.slice(emails);
    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) {
      expect(e.to === EMAILS.client || e.to.endsWith("@mkwadvisors.test"), `${e.to}: ${e.subject}`).toBe(true);
      expect(e.subject, e.subject).not.toMatch(/lead|converted|pipeline/i);
    }
  });

  it("26. existing client asks for an additional assessment [no-side-effect] [client-view] [access]", async () => {
    const before = (await env.call("client", "GET", "/api/client/home")).body.requests.length;
    const orgs = await count("orgs");
    const { code } = (await env.call("anon", "POST", "/api/public/assessments", { answers: { emirate: "Dubai", activity: "ecommerce", customers: "both", visas: 2, budgetAed: 40_000 } })).body;
    // Two days later the saved result becomes a request: the advice is recomputed on that day's data, not copied.
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 2 * 86_400_000);
    let r: { status: number; body: any };
    try {
      r = await env.call("client", "POST", "/api/requests/from-assessment", { code });
    } finally {
      env.clock.now = saved;
    }
    expect(r.status).toBe(200);
    expect((await env.call("other", "POST", "/api/requests/from-assessment", { code })).status).toBe(409);
    const s = await scoping(r.body.id);
    expect(s.assessment.savedAt).toBeTruthy();
    expect(s.assessment.dataAsOf).toBe(day(saved, 0));
    expect(s.advice.dataVersion.asOf).toBe(day(saved, 2));
    expect(keysOf(s.advice)).toContain("licence.ecommerce");
    const home = (await env.call("client", "GET", "/api/client/home")).body;
    expect(home.requests.length).toBe(before + 1);
    expect(home.requests.find((x: any) => x.id === r.body.id)).toMatchObject({ assessmentId: expect.any(String), adviceStatus: "pending_review", advice: null });
    expect(await count("orgs")).toBe(orgs);
    expect((await env.call("other", "GET", "/api/client/home")).body.requests.map((x: any) => x.id)).not.toContain(r.body.id);
  });
});

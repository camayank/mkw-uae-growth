import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { withClock } from "../src/lib/db.ts";
import { importCatalogueFacts } from "../src/import/catalogue.ts";
import { runImport } from "../src/import/common.ts";
import { sessionUserForEmail } from "../src/lib/auth.ts";
import { makeEnv, EMAILS, type TestEnv } from "./helpers.ts";

/**
 * E2 over HTTP and SQL: catalogue evidence is append-only, verified evidence names its verifier and source, stale
 * evidence loses confidence, the engine uses recorded activity lists and aliases, and advice built on data that has
 * since changed cannot be approved until it is recomputed.
 */
const one = async (env: TestEnv, sql: string): Promise<any> => (await asPlatform(env.db, null, (tx) => tx.query<any>(sql))).rows[0];
const day = (d: Date, plus = 0) => new Date(d.getTime() + plus * 86_400_000).toISOString().slice(0, 10);

describe("jurisdiction catalogue and evidence", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  const fact = (body: Record<string, unknown>, role = "founder") =>
    env.call(role, "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", evidenceDate: day(env.clock.now), sourceUrl: "https://example.gov.ae/fees", ...body });
  const place = async (name: string) => (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.find((p: any) => p.name === name);

  it("facts are append-only: the database refuses to change or delete one", async () => {
    expect((await fact({ subject: "IFZA", field: "legal_forms", valueText: "FZCO; FZE", confidence: "rule_of_thumb" })).status).toBe(200);
    await expect(asPlatform(env.db, null, (tx) => tx.query("update catalogue_facts set value = '\"x\"'::jsonb"))).rejects.toThrow(/append-only|permission denied/);
    await expect(asPlatform(env.db, null, (tx) => tx.query("delete from catalogue_facts"))).rejects.toThrow(/append-only|permission denied/);
    // Not even the table's owner (no role switch, so no grant applies) can: the trigger refuses.
    await expect(env.db.transaction((tx) => tx.query("update catalogue_facts set note = 'x'"))).rejects.toThrow(/append-only/);
    await expect(env.db.transaction((tx) => tx.query("delete from catalogue_facts"))).rejects.toThrow(/append-only/);
    // Clients and partners cannot read the catalogue at all.
    const client = await sessionUserForEmail(env.db, EMAILS.client);
    await expect(asUser(env.db, client, (tx) => tx.query("select * from catalogue_facts"))).rejects.toThrow(/permission denied/);
    expect((await env.call("client", "GET", "/api/admin/jurisdictions")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/admin/jurisdictions")).status).toBe(403);
  });

  it("verified evidence names its verifier and links its source; only the founder records evidence", async () => {
    const cost = { subject: "IFZA", field: "cost", valueText: "12,900 - 18,000", confidence: "verified" };
    expect((await fact({ ...cost, verifiedBy: "A. Qualified" }, "ops")).status).toBe(403);
    expect((await fact({ ...cost })).body.message).toMatch(/Name the person who verified/);
    expect((await fact({ ...cost, verifiedBy: "A. Qualified", sourceUrl: "" })).body.message).toMatch(/source link/);
    expect((await fact({ ...cost, verifiedBy: "A. Qualified", valueText: "abc" })).body.message).toMatch(/not an AED amount/);
    const ok = await fact({ ...cost, verifiedBy: "A. Qualified, licensing adviser" });
    expect(ok.status).toBe(200);
    // The cache follows, and the engine's place confidence is the weakest evidence it relies on (visas and timeline
    // are still UNCERTAIN, so the place is too).
    const ifza = await place("IFZA");
    const evidence = Object.fromEntries(ifza.evidence.map((e: any) => [e.field, e]));
    expect(evidence.cost).toMatchObject({ confidence: "verified", stale: false, verifiedBy: "A. Qualified, licensing adviser" });
    expect(evidence.cost.nextVerification).toBe(day(env.clock.now, 180)); // the default re-verification period
    expect(ifza.confidence).toBe("UNCERTAIN");
    const z = await one(env, "select cost_min_fils, cost_max_fils from zones where name = 'IFZA'");
    expect([Number(z.cost_min_fils), Number(z.cost_max_fils)]).toEqual([1_290_000, 1_800_000]);
    // History keeps both facts; only the latest per field is current.
    expect((await fact({ ...cost, valueText: "13000-18500", verifiedBy: "A. Qualified, licensing adviser" })).status).toBe(200);
    const history = (await env.call("ops", "GET", "/api/admin/jurisdictions/history?kind=place&subject=IFZA")).body.filter((f: any) => f.field === "cost");
    expect(history.map((f: any) => [f.value.minFils, f.current])).toEqual([
      [1_300_000, true],
      [1_290_000, false],
    ]);
  });

  it("evidence past its re-verification date loses a level of confidence and is labelled stale", async () => {
    const evidenceDate = day(env.clock.now, -400);
    const r = await fact({ subject: "SHAMS", field: "visa_max", valueText: "6", confidence: "verified", verifiedBy: "A. Qualified", evidenceDate, nextVerification: day(env.clock.now, -10) });
    expect(r.status).toBe(200);
    const e = (await place("SHAMS")).evidence.find((x: any) => x.field === "visa_max");
    expect(e).toMatchObject({ recorded: "verified", confidence: "rule_of_thumb", stale: true });
    expect((await place("SHAMS")).stale).toBe(true);
    // Rules too: a verified rule past its date is no longer verified for the engine.
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.ubo", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://moec.gov.ae/ubo", nextVerification: day(env.clock.now, 30) })).status).toBe(200);
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 31 * 86_400_000);
    try {
      const overview = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body;
      expect(overview.rules.stale).toContain("obligation.ubo");
      const id = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Dubai", jurisdiction: "free_zone", activity: "tech", customers: "international", visas: 1 } })).body.id;
      const advice = (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body.advice;
      expect(advice.obligations.find((o: any) => o.ruleKey === "obligation.ubo").confidence).toBe("rule_of_thumb");
    } finally {
      env.clock.now = saved;
    }
  });

  it("an activity on the authority's own list confirms the activity at that place; aliases find the place named", async () => {
    expect((await fact({ subject: "Sharjah Media City", field: "activities_listed", valueText: "consulting; tech", confidence: "rule_of_thumb" })).status).toBe(404); // the API takes the place's own name
    expect((await fact({ subject: "SHAMS", field: "activities_listed", valueText: "consulting; tech", confidence: "rule_of_thumb" })).status).toBe(200);
    const id = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Sharjah", jurisdiction: "free_zone", freeZone: "sharjah media city", activity: "consulting", customers: "international", visas: 1 } })).body.id;
    const advice = (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body.advice;
    const shams = advice.places.find((p: any) => p.zone === "SHAMS");
    expect(advice.places[0].zone).toBe("SHAMS");
    expect(shams.why).toContain("the place you named");
    expect(shams.authority).toBe("Sharjah Media City");
    const listed = shams.findings.find((f: any) => f.ruleKey === "place.activity_listed");
    expect(listed).toMatchObject({ outcome: "pass", confidence: "UNCERTAIN" }); // the rule itself is still UNCERTAIN
    const other = advice.places.find((p: any) => p.zone !== "SHAMS");
    expect(other.findings.find((f: any) => f.ruleKey === "place.activity_listed")).toMatchObject({ outcome: "unknown", missing: "check" });
    // "JAFZA" alone means the free zone, which is not a place here: it never names the offshore registry.
    const jafza = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Dubai", jurisdiction: "offshore", freeZone: "JAFZA", activity: "holding", customers: "international", visas: 0 } })).body.id;
    const off = (await env.call("ops", "GET", `/api/ops/requests/${jafza}/scoping`)).body.advice;
    expect(off.places.find((p: any) => p.zone === "JAFZA Offshore")?.why ?? []).not.toContain("the place you named");
  });

  it("an activity list's own confidence caps the finding, even on a verified place under a verified rule", async () => {
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/place.activity_listed", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://example.gov.ae/rules" })).status).toBe(200);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/DMCC", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://dmcc.ae/" })).status).toBe(200);
    expect((await fact({ subject: "DMCC", field: "activities_listed", valueText: "trading", confidence: "UNCERTAIN" })).status).toBe(200);
    const id = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Dubai", jurisdiction: "free_zone", freeZone: "DMCC", activity: "trading", customers: "international", visas: 1 } })).body.id;
    const before = (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body.advice;
    const dmcc = before.places.find((p: any) => p.zone === "DMCC");
    expect(dmcc.findings.find((f: any) => f.ruleKey === "place.activity_listed")).toMatchObject({ outcome: "pass", confidence: "UNCERTAIN" });
    // Recording the same list as verified changes the data the advice depends on.
    expect((await fact({ subject: "DMCC", field: "activities_listed", valueText: "trading", confidence: "verified", verifiedBy: "A. Qualified" })).status).toBe(200);
    expect((await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body.dataChanged).toBe(true);
    const after = (await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/recompute`)).body;
    expect(after.places.find((p: any) => p.zone === "DMCC").findings.find((f: any) => f.ruleKey === "place.activity_listed").confidence).toBe("verified");
  });

  it("a renewal estimate carries its own confidence to the client", async () => {
    expect((await fact({ subject: "IFZA", field: "renewal_cost", valueText: "8000-11000", confidence: "rule_of_thumb" })).status).toBe(200);
    const id = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Dubai", jurisdiction: "free_zone", activity: "tech", customers: "international", visas: 1 } })).body.id;
    const ifza = (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body.advice.places.find((p: any) => p.zone === "IFZA");
    expect(ifza).toMatchObject({ renewalMinFils: 800_000, renewalMaxFils: 1_100_000, renewalConfidence: "rule_of_thumb" });
  });

  it("evidence is never dated in the future and must be checked again within two years, in the service and in the database", async () => {
    const future = day(env.clock.now, 1);
    expect((await fact({ subject: "IFZA", field: "visa_quota", valueText: "2", confidence: "rule_of_thumb", evidenceDate: future })).body.message).toMatch(/future/);
    expect((await fact({ subject: "IFZA", field: "visa_quota", valueText: "2", confidence: "rule_of_thumb", nextVerification: "9999-12-31" })).body.message).toMatch(/within two years/);
    const insert = (cols: string) => asPlatform(withClock(env.db, () => env.clock.now), null, (tx) => tx.query(`insert into catalogue_facts (subject_kind, subject, field, value, source_url, evidence_date, confidence, verified_by, next_verification) values ${cols}`));
    await expect(insert(`('place','IFZA','visa_quota','2','', '${future}','UNCERTAIN',null,null)`)).rejects.toThrow(/future/);
    await expect(insert(`('place','IFZA','visa_quota','2','', '${day(env.clock.now)}','rule_of_thumb',null,'9999-12-31')`)).rejects.toThrow(/two years/);
    // The database's own rule for verified facts: a verifier, a source link and a re-verification date.
    await expect(insert(`('place','IFZA','visa_quota','2','https://x.ae','${day(env.clock.now)}','verified',null,'${day(env.clock.now, 10)}')`)).rejects.toThrow(/catalogue_facts_verified/);
    await expect(insert(`('place','IFZA','visa_quota','2','','${day(env.clock.now)}','verified','A. Q','${day(env.clock.now, 10)}')`)).rejects.toThrow(/catalogue_facts_verified/);
    await expect(insert(`('place','IFZA','visa_quota','2','https://x.ae','${day(env.clock.now)}','verified','A. Q',null)`)).rejects.toThrow(/catalogue_facts_verified/);
  });

  it("finance reads the catalogue and its history; the old Places table shows the confidence a place deserves today", async () => {
    expect((await env.call("finance", "GET", "/api/admin/jurisdictions")).status).toBe(200);
    expect((await env.call("finance", "GET", "/api/admin/jurisdictions/history?kind=rule&subject=obligation.ubo")).status).toBe(200);
    expect((await env.call("finance", "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", subject: "IFZA", field: "visa_quota", valueText: "2", evidenceDate: day(env.clock.now), confidence: "UNCERTAIN" })).status).toBe(403);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/Ajman%20Free%20Zone", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://afz.ae/", nextVerification: day(env.clock.now, 5) })).status).toBe(200);
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 10 * 86_400_000);
    try {
      const z = (await env.call("ops", "GET", "/api/admin/scoping")).body.zones.find((x: any) => x.name === "Ajman Free Zone");
      expect(z).toMatchObject({ confidence: "rule_of_thumb", stale: true });
    } finally {
      env.clock.now = saved;
    }
  });

  it("advice records its data version; advice built on data that has since changed is recomputed before approval", async () => {
    const id = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Dubai", jurisdiction: "free_zone", activity: "tech", customers: "international", visas: 1 } })).body.id;
    const before = (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body;
    expect(before.advice.dataVersion).toMatchObject({ asOf: day(env.clock.now), digest: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(before.dataChanged).toBe(false);
    expect((await fact({ subject: "Dubai Silicon Oasis", field: "timeline_days", valueText: "12", confidence: "rule_of_thumb" })).status).toBe(200);
    expect((await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body.dataChanged).toBe(true);
    const refused = await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/changed since this advice was computed/);
    const recomputed = (await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/recompute`)).body;
    expect(recomputed.dataVersion.lastFactId).toBeGreaterThan(before.advice.dataVersion.lastFactId);
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, {})).status).toBe(200);
    const mine = (await env.call("client", "GET", "/api/client/home")).body.requests.find((r: any) => r.id === id);
    expect(mine.advice.dataVersion.asOf).toBe(day(env.clock.now));
  });

  it("authority relationships are facts with a source, and cannot loop", async () => {
    const parent = (body: Record<string, unknown>) => fact({ subjectKind: "authority", field: "parent", confidence: "rule_of_thumb", ...body });
    expect((await parent({ subject: "dso", valueText: "dso" })).body.message).toMatch(/own parent/);
    expect((await parent({ subject: "ifza", valueText: "dso" })).status).toBe(200);
    expect((await parent({ subject: "dso", valueText: "ifza" })).body.message).toMatch(/loop/);
    const ifza = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.authorities.find((a: any) => a.id === "ifza");
    expect(ifza).toMatchObject({ parentId: "dso", aliases: ["IFZA"] });
  });

  it("a place added without figures is never offered, cannot be verified from placeholders, and is activated only once its figures are on record", async () => {
    expect((await place("Fujairah Creative City")).active).toBe(false);
    const verify = (body: Record<string, unknown>) => env.call("founder", "PUT", "/api/admin/scoping/zones/Fujairah%20Creative%20City", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://creativecity.ae/", ...body });
    expect((await verify({})).body.message).toMatch(/no cost, visa quota, timeline days on record/);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/Fujairah%20Creative%20City", { confidence: "UNCERTAIN", active: true })).body.message).toMatch(/before verifying or offering/);
    // A cost fact alone does not make the other placeholders figures: verifying or offering still waits for them.
    expect((await fact({ subject: "Fujairah Free Zone", field: "cost", valueText: "9000-14000", confidence: "UNCERTAIN" })).status).toBe(200);
    const partial = await env.call("founder", "PUT", "/api/admin/scoping/zones/Fujairah%20Free%20Zone", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://fujairahfreezone.ae/", active: true });
    expect(partial.status).toBe(400);
    expect(partial.body.message).toMatch(/no visa quota, timeline days on record/);
    expect((await place("Fujairah Free Zone")).active).toBe(false);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select count(*)::int as n from catalogue_facts where subject = 'Fujairah Free Zone' and field <> 'cost'"))).rows[0]!.n).toBe(0);
    expect((await verify({ costMinAed: 9_000, costMaxAed: 14_000, visaQuota: 1, timelineDays: 5, active: true })).status).toBe(200);
    const id = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", emirate: "Fujairah", jurisdiction: "free_zone", activity: "consulting", customers: "international", visas: 1 } })).body.id;
    const advice = (await env.call("ops", "GET", `/api/ops/requests/${id}/scoping`)).body.advice;
    expect(advice.places.map((p: any) => p.zone)).toContain("Fujairah Creative City");
  });

  it("the importer: a dry run writes nothing, applying twice writes once, verified rows need the founder, nobody is notified", async () => {
    const grid = [
      ["Kind", "Place or authority", "Field", "Value", "Source", "Evidence date", "Confidence", "Verified by", "Next verification"],
      ["place", "RAKEZ", "Setup cost range (AED)", "7000-15000", "https://rakez.com/fees", "2026-10-01", "Rule of thumb", "", ""],
      ["place", "Ras Al Khaimah Economic Zone", "facilities", "office; warehouse; industrial", "https://rakez.com/facilities", "2026-10-01", "Verified", "A. Qualified", "2027-04-01"],
      ["place", "Nowhere Free Zone", "cost", "1000", "", "2026-10-01", "UNCERTAIN", "", ""],
      ["place", "RAKEZ", "colour", "blue", "", "2026-10-01", "UNCERTAIN", "", ""],
      ["authority", "RAKEZ", "website", "https://rakez.com", "https://rakez.com", "2026-10-01", "Rule of thumb", "", ""],
    ];
    const outboxBefore: number = (await one(env, "select count(*)::int as n from outbox")).n;
    const facts = async (): Promise<number> => (await one(env, "select count(*)::int as n from catalogue_facts")).n;
    const start = await facts();
    const dry = await runImport(env.db, null, false, (tx) => importCatalogueFacts(tx, grid, "catalogue-facts.csv", null));
    expect(dry.rows.map((r) => r.action)).toEqual(["created", "skipped", "skipped", "skipped", "created"]);
    expect(dry.rows[1]!.reason).toMatch(/importing founder/);
    expect(dry.rows[2]!.reason).toMatch(/no single place matches/);
    expect(dry.rows[3]!.reason).toMatch(/not a place field/);
    expect(await facts()).toBe(start);
    const founder = await sessionUserForEmail(env.db, EMAILS.founder);
    const db = withClock(env.db, () => env.clock.now);
    const applied = await runImport(db, founder, true, (tx) => importCatalogueFacts(tx, grid, "catalogue-facts.csv", founder));
    expect(applied.rows.map((r) => r.action)).toEqual(["created", "created", "skipped", "skipped", "created"]);
    expect(await facts()).toBe(start + 3);
    const again = await runImport(db, founder, true, (tx) => importCatalogueFacts(tx, grid, "catalogue-facts.csv", founder));
    expect(again.rows.map((r) => r.action)).toEqual(["unchanged", "unchanged", "skipped", "skipped", "unchanged"]);
    expect(await facts()).toBe(start + 3);
    expect((await one(env, "select count(*)::int as n from outbox")).n).toBe(outboxBefore);
    const rakez = await place("RAKEZ");
    expect(rakez.evidence.find((e: any) => e.field === "facilities")).toMatchObject({ recorded: "verified", verifiedBy: "A. Qualified" });
  });
});

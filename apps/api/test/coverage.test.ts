import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { importCatalogueFacts } from "../src/import/catalogue.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E7B over HTTP and SQL: evidence carries its reference, effective date and source kind; an intermediary's figure can
 * never be verified; the coverage matrix counts once and lists the backlog; the backlog CSV imports back as a dry run
 * that writes nothing; only the founder classifies a place, audited.
 */
const count = async (env: TestEnv, table: string): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`))).rows[0]!.n;
const day = (d: Date, plus = 0) => new Date(d.getTime() + plus * 86_400_000).toISOString().slice(0, 10);

describe("jurisdiction coverage and the evidence pipeline (E7B)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  const fact = (body: Record<string, unknown>, role = "founder") =>
    env.call(role, "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", evidenceDate: day(env.clock.now), sourceUrl: "https://ifza.com/fees", ...body });

  it("a fact carries its reference, effective date and source kind; an intermediary's figure cannot be verified", async () => {
    const ok = await fact({ subject: "IFZA", field: "government_charges", valueText: "9,000 - 12,500", confidence: "verified", verifiedBy: "A. Qualified, licensing adviser", reference: "Fee schedule 2026, section 2", effectiveDate: "2026-01-01" });
    expect(ok.status).toBe(200);
    const h = (await env.call("ops", "GET", "/api/admin/jurisdictions/history?kind=place&subject=IFZA")).body;
    expect(h[0]).toMatchObject({ field: "government_charges", value: { minFils: 900_000, maxFils: 1_250_000 }, reference: "Fee schedule 2026, section 2", effectiveDate: "2026-01-01", sourceKind: "official", current: true });
    const place = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.find((p: any) => p.name === "IFZA");
    expect(place).toMatchObject({ govChargesMinFils: 900_000, govChargesMaxFils: 1_250_000, placeKind: "free_zone", status: "active", priority: 1 });
    // The service refuses an intermediary verified fact, and so does the database.
    const bad = await fact({ subject: "IFZA", field: "renewal_cost", valueText: "8,000 - 9,000", confidence: "verified", verifiedBy: "A. Qualified", sourceKind: "intermediary", sourceUrl: "https://some-agent.example/ifza" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/intermediary cannot be verified/);
    await expect(
      asPlatform(env.db, null, (tx) =>
        tx.query("insert into catalogue_facts (subject_kind, subject, field, value, source_url, evidence_date, confidence, verified_by, next_verification, source_kind) values ('place','IFZA','renewal_cost','{}','https://x.example/','2026-10-01','verified','A. Q','2027-03-01','intermediary')"),
      ),
    ).rejects.toThrow(/catalogue_facts_intermediary/);
    // As a rule of thumb it is recorded, labelled, and the backlog still asks the authority for it.
    const rot = await fact({ subject: "IFZA", field: "renewal_cost", valueText: "8,000 - 9,000", confidence: "rule_of_thumb", sourceKind: "intermediary", sourceUrl: "https://some-agent.example/ifza" });
    expect(rot.status).toBe(200);
    const h2 = (await env.call("ops", "GET", "/api/admin/jurisdictions/history?kind=place&subject=IFZA")).body;
    expect(h2[0]).toMatchObject({ field: "renewal_cost", sourceKind: "intermediary", confidence: "rule_of_thumb" });
    // The new list fields parse and cache.
    expect((await fact({ subject: "IFZA", field: "activity_codes", valueText: "6201 · Software development; 6202 · IT consultancy", confidence: "rule_of_thumb" })).status).toBe(200);
    expect((await fact({ subject: "IFZA", field: "conditions", valueText: "Office lease of at least one desk; one visa per desk", confidence: "rule_of_thumb" })).status).toBe(200);
    expect((await fact({ subject: "IFZA", field: "exclusions", valueText: "Visa fees; medical; Emirates ID", confidence: "rule_of_thumb" })).status).toBe(200);
    const p2 = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.find((p: any) => p.name === "IFZA");
    expect(p2.activityCodes).toEqual(["6201 · Software development", "6202 · IT consultancy"]);
    expect(p2.conditions).toHaveLength(2);
    expect(p2.exclusions).toHaveLength(3);
  });

  it("the coverage matrix counts each authority and place once, measures the fields and lists the backlog first wave first", async () => {
    expect((await env.call("client", "GET", "/api/admin/coverage")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/admin/coverage")).status).toBe(403);
    const c = (await env.call("finance", "GET", "/api/admin/coverage")).body;
    expect(c.authorities.total).toBe(24);
    expect(c.authorities.byKind).toMatchObject({ free_zone_authority: 12, mainland_department: 3, offshore_registry: 2, financial_centre: 2, regulator: 5 });
    // 14 seeded places with figures plus 5 placeholders; none historical; 15 in the first wave (KEZAD and JAFZA among them).
    expect(c.places).toMatchObject({ total: 19, active: 14, inactive: 5, historical: 0, priority: 15 });
    expect(Object.values(c.places.matrix).flatMap((m: any) => Object.values(m)).reduce((a: any, b: any) => a + b, 0)).toBe(19);
    expect(c.emirates).toEqual(["Abu Dhabi", "Ajman", "Dubai", "Fujairah", "Ras Al Khaimah", "Sharjah", "Umm Al Quwain"]);
    expect(c.places.matrix.Dubai).toMatchObject({ free_zone: 5, mainland: 1, offshore_registry: 1, financial_centre: 1 });
    expect(c.fields.cost).toMatchObject({ onRecord: 14, of: 19 });
    expect(c.fields.government_charges).toMatchObject({ onRecord: 1, verified: 1 });
    expect(c.fields.activity_codes).toMatchObject({ onRecord: 1 });
    expect(c.approvals.outstanding).toBeGreaterThan(0); // the guidance notes, at least, are not approved
    expect(c.approvals.items.some((a: any) => a.kind === "guide")).toBe(true);
    // Tasks: first wave first; IFZA's government charges are done, its renewal is an intermediary's figure.
    expect(c.tasks[0].priority).toBe(1);
    const ifza = c.tasks.filter((t: any) => t.place === "IFZA");
    expect(ifza.map((t: any) => t.field)).not.toContain("government_charges");
    expect(ifza.find((t: any) => t.field === "renewal_cost")).toMatchObject({ reason: "intermediary" });
    expect(ifza.find((t: any) => t.field === "cost")).toMatchObject({ reason: "unverified" });
    // A placeholder place asks for everything until its figures are recorded; then those tasks drop off.
    expect(c.tasks.filter((t: any) => t.place === "KEZAD")).toHaveLength(12);
    expect(c.tasks.every((t: any) => /^Obtain /.test(t.ask))).toBe(true);
    for (const [field, valueText] of [["cost", "18,000 - 40,000"], ["visa_quota", "3"], ["timeline_days", "12"]]) expect((await fact({ subject: "KEZAD", field, valueText, confidence: "rule_of_thumb", sourceUrl: "https://kezad.example/" })).status).toBe(200);
    expect((await fact({ subject: "IFZA", field: "visa_max", valueText: "no limit", confidence: "rule_of_thumb" })).status).toBe(200);
    const c2 = (await env.call("ops", "GET", "/api/admin/coverage")).body;
    // Recorded as rules of thumb: on record now, still asked for as unverified (not missing) until the authority's page is cited.
    expect(c2.tasks.find((t: any) => t.place === "KEZAD" && t.field === "cost")).toMatchObject({ reason: "unverified" });
    expect(c2.tasks.filter((t: any) => t.place === "KEZAD" && t.reason === "missing")).toHaveLength(9);
    expect(c2.fields.cost.onRecord).toBe(15);
    expect(c2.tasks.find((t: any) => t.place === "IFZA" && t.field === "visa_max")).toMatchObject({ reason: "unverified" });
    expect(c2.fields.visa_max.onRecord).toBe(1);
  });

  it("the backlog CSV is in the importer's layout and imports back as a dry run that writes nothing", async () => {
    const r = await env.send("ops", "GET", "/api/admin/coverage/backlog.csv");
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/text\/csv/);
    const text = String(r.body);
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("Kind,Place or authority,Field,Value,Source,Evidence date,Confidence,Verified by,Next verification,Effective date,Reference,Source kind,Note,To obtain");
    expect(lines.length).toBeGreaterThan(50);
    const before = await count(env, "catalogue_facts");
    const outboxBefore = await count(env, "outbox");
    const grid = lines.map((l) => l.replace(/"[^"]*"/g, (m) => m.replace(/,/g, ";")).replace(/"/g, "").split(","));
    const report = await asPlatform(env.db, null, (tx) => importCatalogueFacts(tx, grid, "backlog.csv"));
    expect(report.rows.length).toBe(lines.length - 1);
    expect(report.rows.every((x) => x.action === "skipped")).toBe(true);
    expect(await count(env, "catalogue_facts")).toBe(before);
    expect(await count(env, "outbox")).toBe(outboxBefore);
  });

  it("only the founder classifies a place; a placeholder cannot be offered without figures; historical places leave the counts; audited", async () => {
    expect((await env.call("ops", "POST", "/api/admin/jurisdictions/places/SHAMS/status", { status: "historical" })).status).toBe(403);
    expect((await env.call("founder", "POST", "/api/admin/jurisdictions/places/JAFZA/status", { status: "active" })).body.message).toMatch(/no cost, visa quota, timeline days on record/);
    expect((await env.call("founder", "POST", "/api/admin/jurisdictions/places/No Such/status", { status: "inactive" })).status).toBe(404);
    expect((await env.call("founder", "POST", "/api/admin/jurisdictions/places/SHAMS/status", { placeKind: "sub_zone", status: "historical", priority: null })).status).toBe(200);
    const c = (await env.call("ops", "GET", "/api/admin/coverage")).body;
    expect(c.places).toMatchObject({ total: 19, historical: 1, active: 13 });
    expect(c.tasks.some((t: any) => t.place === "SHAMS")).toBe(false);
    // The engine no longer offers it.
    const pub = (await env.call("anon", "POST", "/api/public/assess", { emirate: "Sharjah", activity: "tech", customers: "international", visas: 1 })).body;
    expect([...pub.places, ...pub.excluded].some((p: any) => p.zone === "SHAMS")).toBe(false);
    const ev = (await asPlatform(env.db, null, (tx) => tx.query("select data from audit_events where action = 'catalogue.place_classified' and entity_id = 'SHAMS'"))).rows as any[];
    expect(ev).toHaveLength(1);
    expect(ev[0].data.after).toMatchObject({ status: "historical", placeKind: "sub_zone" });
    // The legacy verify-zone path cannot offer a historical place, and cannot mark an intermediary's figure verified.
    const vz = await env.call("founder", "PUT", "/api/admin/scoping/zones/SHAMS", { confidence: "UNCERTAIN", active: true });
    expect([vz.status, JSON.stringify(vz.body)]).toEqual([400, expect.any(String)]);
    expect(vz.body.message).toMatch(/historical place is not offered/);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/IFZA", { confidence: "verified", verifiedBy: "A. Q", sourceUrl: "https://agent.example/ifza", sourceKind: "intermediary" })).body.message).toMatch(/intermediary cannot be verified/);
    expect((await env.call("founder", "POST", "/api/admin/jurisdictions/places/SHAMS/status", { placeKind: "free_zone", status: "active", priority: 1 })).status).toBe(200);
    expect((await env.call("ops", "GET", "/api/admin/coverage")).body.places.active).toBe(14);
    // A priority the founder clears stays cleared when the catalogue seed runs again at the next start.
    expect((await env.call("founder", "POST", "/api/admin/jurisdictions/places/IFZA/status", { priority: null })).status).toBe(200);
    const { seedCatalogue } = await import("../src/db/seed.ts");
    await seedCatalogue(env.db);
    expect((await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.find((p: any) => p.name === "IFZA").priority).toBeNull();
    expect((await env.call("ops", "GET", "/api/admin/coverage")).body.places.priority).toBe(14);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { asPlatform } from "../src/lib/context.ts";
import { openPglite } from "../src/lib/db.ts";
import { importCatalogueFacts } from "../src/import/catalogue.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const day = (d: Date, plus = 0) => new Date(d.getTime() + plus * 86_400_000).toISOString().slice(0, 10);
const SRC = "https://example.gov.ae/fees";
const MIG = join(import.meta.dirname, "../migrations");
const out = (label: string, v: unknown) => console.log(`PROBE ${label}: ${JSON.stringify(v)}`);

describe("probe: migration 030 on a database that already holds facts", () => {
  it("runs 001..029, inserts facts, then runs 030", async () => {
    const db = await openPglite();
    const files = (await readdir(MIG)).filter((f) => f.endsWith(".sql")).sort();
    await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    for (const f of files.filter((x) => x < "030")) await db.exec(await readFile(join(MIG, f), "utf8"));
    await db.exec(`insert into catalogue_facts (subject_kind, subject, field, value, source_url, evidence_date, confidence, verified_by, next_verification, note)
      values ('place','IFZA','cost','{"minFils":1,"maxFils":2}','https://x.ae','2026-01-01','rule_of_thumb',null,null,''),
             ('place','IFZA','cost','{"minFils":2,"maxFils":3}','https://x.ae','2026-02-01','rule_of_thumb',null,null,'')`);
    let err = "";
    try {
      await db.exec(await readFile(join(MIG, "030_evidence_operations.sql"), "utf8"));
    } catch (e) {
      err = (e as Error).message;
    }
    out("migration 030 on existing facts error", err);
    if (!err) {
      const rows = await db.transaction((tx) => tx.query("select id, change_kind, supersedes_id from catalogue_facts order by id"));
      out("backfill rows", rows.rows);
    }
    await db.close();
  });
});

describe("probe: E23 paths", () => {
  let env: TestEnv;
  const PLACE = "IFZA";
  const fact = (body: Record<string, unknown>, who = "founder") =>
    env.call(who, "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", subject: PLACE, field: "cost", evidenceDate: day(env.clock.now), sourceUrl: SRC, ...body });
  const place = async () => {
    const p = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.find((p: any) => p.name === PLACE);
    return { ...p, evidence: Object.fromEntries((p.evidence as any[]).map((e) => [e.field, e])) };
  };
  const queue = async (kind: string, who = "ops") => ((await env.call(who, "GET", "/api/ops/queue")).body.items as any[]).filter((i) => i.kind === kind);
  const cache = async () => (await asPlatform(env.db, null, (tx) => tx.query<any>("select cost_min_fils, cost_max_fils, confidence, visa_quota from zones where name = $1", [PLACE]))).rows[0];
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("same value from a weaker intermediary source becomes current", async () => {
    const v = await fact({ valueText: "10000-15000", confidence: "verified", verifiedBy: "A. Qualified", nextVerification: day(env.clock.now, 180), evidenceDate: day(env.clock.now, -30) });
    out("verified", v.body);
    const before = (await place()).evidence.cost;
    const same = await fact({ valueText: "10000-15000", confidence: "UNCERTAIN", sourceKind: "intermediary", sourceUrl: "https://agent.example/ifza", evidenceDate: day(env.clock.now, -10) });
    out("same-value UNCERTAIN intermediary", same.body);
    const after = (await place()).evidence.cost;
    out("engine cost before/after same-value weaker fact", { before: { confidence: before.confidence, factId: before.factId, sourceKind: before.sourceKind }, after: { confidence: after.confidence, factId: after.factId, sourceKind: after.sourceKind } });
    out("place confidence", (await place()).confidence);
  });

  it("ops sees founder-only actions on fact_conflict", async () => {
    const c = await fact({ valueText: "1000-2000", confidence: "UNCERTAIN", evidenceDate: day(env.clock.now, -5) });
    out("conflict", c.body.change);
    const items = await queue("fact_conflict", "ops");
    out("ops queue item actions", items.map((i) => ({ id: i.id, actions: i.actions.map((a: any) => a.label) })));
    const fin = await queue("fact_conflict", "finance");
    out("finance queue item actions", fin.map((i) => i.actions.length));
    const r = await env.call("ops", "POST", `/api/admin/jurisdictions/facts/${c.body.id}/review`, { decision: "keep", note: "ops tries to decide" });
    out("ops acting on it", { status: r.status, body: r.body });
    // open tracking with the composite id
    const open = await env.call("ops", "POST", "/api/ops/queue/open", { id: `fact_conflict:${c.body.id}` });
    out("queue open fact_conflict", { status: open.status, body: open.body });
    // accept after a later fact superseded the field
    const later = await fact({ valueText: "10500-15000", confidence: "verified", verifiedBy: "A. Qualified", nextVerification: day(env.clock.now, 180) });
    out("later change", later.body.change);
    out("queue after later fact", (await queue("fact_conflict")).length);
    const acc = await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${c.body.id}/review`, { decision: "accept", note: "accepting a moot conflict" });
    out("accept after superseded", { status: acc.status, body: acc.body, engine: (await place()).evidence.cost.factId, cache: await cache() });
    const compare = (await env.call("ops", "GET", `/api/admin/jurisdictions/compare?kind=place&subject=${PLACE}&field=cost`)).body;
    out("compare after moot accept", compare.versions.map((v: any) => [v.id, v.change.kind, v.review?.decision ?? null, v.current]));
  });

  it("verifyZone through PUT with a downgrade or a same-day correction", async () => {
    const before = await place();
    out("before PUT", { cost: before.evidence.cost, cache: await cache() });
    // founder downgrades the place to UNCERTAIN with corrected figures (e.g. the schedule page vanished)
    const r = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "UNCERTAIN", costMinFils: 1_200_000, costMaxFils: 1_600_000, visaQuota: 3, timelineDays: 10 });
    out("PUT UNCERTAIN new figures", { status: r.status, body: r.body });
    const after = await place();
    out("after PUT: engine cost / visa / place confidence / cache", { cost: after.evidence.cost, visa: after.evidence.visa_quota, confidence: after.confidence, cache: await cache() });
    out("queue conflicts after PUT", (await queue("fact_conflict")).map((i) => i.detail ?? i.title ?? i.why));
    // founder corrects a figure the same day with a different (better) source link, verified
    const c1 = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/fees-2026", costMinFils: 1_250_000, costMaxFils: 1_600_000 });
    out("PUT verified new source same day", { status: c1.status, body: c1.body });
    const c2 = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/fees-2026-v2", costMinFils: 1_260_000, costMaxFils: 1_600_000 });
    out("PUT verified corrected again same day other source", { status: c2.status, body: c2.body });
    const a2 = await place();
    out("after two same-day PUTs: engine cost, cache, open conflicts", { cost: a2.evidence.cost, cache: await cache(), conflicts: (await queue("fact_conflict")).map((i) => i.why) });
  });

  it("verifyRule through PUT: a downgrade to UNCERTAIN", async () => {
    const key = "obligation.ubo";
    const v = await env.call("founder", "PUT", `/api/admin/scoping/rules/${key}`, { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://moec.gov.ae/ubo", nextVerification: day(env.clock.now, 30) });
    out("rule verified", v.status);
    const d = await env.call("founder", "PUT", `/api/admin/scoping/rules/${key}`, { confidence: "UNCERTAIN" });
    out("rule downgraded", { status: d.status, body: d.body });
    const rules = (await env.call("ops", "GET", "/api/admin/scoping")).body.rules.find((r: any) => r.key === key);
    out("scoping_rules row", { confidence: rules.confidence, version: rules.version });
    const hist = (await env.call("ops", "GET", `/api/admin/jurisdictions/history?kind=rule&subject=${key}`)).body;
    out("rule history", hist.map((h: any) => ({ id: h.id, kind: h.change.kind, current: h.current, conf: h.confidence ?? h.effective?.confidence })));
    out("rule conflicts on queue", (await queue("fact_conflict")).filter((i) => i.why.includes(key)).map((i) => i.why));
    const keep = await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${hist[0].id}/review`, { decision: "accept", note: "the UNCERTAIN version is the real one" });
    out("accept rule conflict", { status: keep.status, body: keep.body });
  });

  it("importer: re-importing the current row after a conflict", async () => {
    const founder = (await env.call("founder", "GET", "/api/me")).body;
    const cur = (await place()).evidence.visa_quota;
    out("current visa fact", cur);
    const grid = [
      ["Kind", "Place or authority", "Field", "Value", "Source", "Evidence date", "Confidence", "Source kind"],
      ["place", PLACE, "visa_quota", "1", "https://agent.example/ifza-visas", day(env.clock.now, -3), "UNCERTAIN", "intermediary"],
    ];
    const first = await asPlatform(env.db, founder, (tx) => importCatalogueFacts(tx, grid, "a.csv", founder));
    out("import conflict row", first.rows[0]);
    const again = await asPlatform(env.db, founder, (tx) => importCatalogueFacts(tx, grid, "a.csv", founder));
    out("import same conflict row again", again.rows[0]);
    const hist = (await env.call("ops", "GET", `/api/admin/jurisdictions/history?kind=place&subject=${PLACE}`)).body.filter((h: any) => h.field === "visa_quota");
    out("visa history", hist.map((h: any) => ({ id: h.id, kind: h.change.kind, current: h.current, value: h.value, conf: h.effective.confidence })));
    out("open conflicts", (await queue("fact_conflict")).length);
  });

  it("evidence_stale open-tracking id and jobs runner", async () => {
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 400 * 86_400_000);
    try {
      const items = await queue("evidence_stale");
      out("stale items", items.map((i) => ({ id: i.id, at: i.at, dueAt: i.dueAt, actions: i.actions.length, risk: i.risk })));
      if (items[0]) out("open stale", await env.call("ops", "POST", "/api/ops/queue/open", { id: items[0].id }));
    } finally {
      env.clock.now = saved;
    }
  });
});

describe("probe 2: PUT path and a moot conflict", () => {
  let env: TestEnv;
  const PLACE = "IFZA";
  const fact = (body: Record<string, unknown>, who = "founder") =>
    env.call(who, "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", subject: PLACE, field: "cost", evidenceDate: day(env.clock.now), sourceUrl: SRC, ...body });
  const compare = async () => ((await env.call("ops", "GET", `/api/admin/jurisdictions/compare?kind=place&subject=${PLACE}&field=cost`)).body.versions as any[]).map((v) => [v.id, v.change.kind, v.review?.decision ?? null, v.current, v.value, v.evidenceDate, v.sourceUrl, v.confidence]);
  const cache = async () => (await asPlatform(env.db, null, (tx) => tx.query<any>("select cost_min_fils, cost_max_fils, confidence from zones where name = $1", [PLACE]))).rows[0];
  const queue = async (kind: string, who = "ops") => ((await env.call(who, "GET", "/api/ops/queue")).body.items as any[]).filter((i) => i.kind === kind);
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("PUT zone over a verified current fact", async () => {
    const v = await fact({ valueText: "10000-15000", confidence: "verified", verifiedBy: "A. Qualified", nextVerification: day(env.clock.now, 180), evidenceDate: day(env.clock.now, -30) });
    out("verified fact", v.body.id);
    const r = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "UNCERTAIN", costMinFils: 1_200_000, costMaxFils: 1_600_000 });
    out("PUT UNCERTAIN", r.status);
    out("compare after PUT UNCERTAIN", await compare());
    out("cache", await cache());
    out("conflict queue", (await queue("fact_conflict")).map((i) => i.why));
    const r2 = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/fees-2026", costMinFils: 1_250_000, costMaxFils: 1_600_000 });
    out("PUT verified today, other source", r2.status);
    out("compare after", await compare());
    out("cache", await cache());
    out("conflict queue", (await queue("fact_conflict")).map((i) => i.why));
    const r3 = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/fees-2026-corrected", costMinFils: 1_260_000, costMaxFils: 1_600_000 });
    out("PUT verified again today, corrected source", r3.status);
    out("compare after", await compare());
    out("cache", await cache());
    out("conflict queue", (await queue("fact_conflict")).map((i) => i.why));
    const p = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.find((p: any) => p.name === PLACE);
    out("engine place", { costMinFils: p.costMinFils, costMaxFils: p.costMaxFils, confidence: p.confidence, cost: p.evidence.find((e: any) => e.field === "cost") });
  });

  it("accept a conflict after a later fact superseded the field", async () => {
    const older = await fact({ valueText: "9000-14000", confidence: "verified", verifiedBy: "B. Checker", nextVerification: day(env.clock.now, 120), evidenceDate: day(env.clock.now, -60) });
    out("older conflict", older.body.change);
    env.clock.now = new Date(env.clock.now.getTime() + 86_400_000);
    const newer = await fact({ valueText: "9500-14000", confidence: "verified", verifiedBy: "B. Checker", nextVerification: day(env.clock.now, 120) });
    out("newer change", newer.body.change);
    out("queue before accept", (await queue("fact_conflict")).length);
    const acc = await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${older.body.id}/review`, { decision: "accept", note: "accepting a moot conflict" });
    out("accept moot", { status: acc.status, body: acc.body });
    out("compare", await compare());
    out("cache", await cache());
  });
});

describe("probe 3: PUT zone with new figures", () => {
  let env: TestEnv;
  const PLACE = "IFZA";
  const fact = (body: Record<string, unknown>, who = "founder") =>
    env.call(who, "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", subject: PLACE, field: "cost", evidenceDate: day(env.clock.now), sourceUrl: SRC, ...body });
  const compare = async () => ((await env.call("ops", "GET", `/api/admin/jurisdictions/compare?kind=place&subject=${PLACE}&field=cost`)).body.versions as any[]).map((v) => [v.id, v.change.kind, v.current, v.value, v.confidence, v.sourceUrl]);
  const cache = async () => (await asPlatform(env.db, null, (tx) => tx.query<any>("select cost_min_fils, cost_max_fils, confidence from zones where name = $1", [PLACE]))).rows[0];
  const queue = async (kind: string, who = "ops") => ((await env.call(who, "GET", "/api/ops/queue")).body.items as any[]).filter((i) => i.kind === kind);
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("founder downgrades with new figures, then corrects twice the same day", async () => {
    await fact({ valueText: "10000-15000", confidence: "verified", verifiedBy: "A. Qualified", nextVerification: day(env.clock.now, 180), evidenceDate: day(env.clock.now, -30) });
    const r = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "UNCERTAIN", costMinAed: 12000, costMaxAed: 16000 });
    out("PUT UNCERTAIN new figures", { status: r.status, body: r.body });
    out("compare", await compare());
    out("cache", await cache());
    const p = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.find((p: any) => p.name === PLACE);
    out("engine place", { costMinFils: p.costMinFils, costMaxFils: p.costMaxFils, confidence: p.confidence, zoneConfidenceColumn: (await cache()).confidence });
    out("conflict queue", (await queue("fact_conflict")).map((i) => i.why));
    const r2 = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/fees-2026", costMinAed: 12500, costMaxAed: 16000 });
    out("PUT verified today new figures other source", { status: r2.status });
    out("compare", await compare());
    out("cache", await cache());
    out("conflict queue", (await queue("fact_conflict")).map((i) => i.why));
    const r3 = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/fees-2026-corrected", costMinAed: 12600, costMaxAed: 16000 });
    out("PUT verified again today corrected figure, corrected source", { status: r3.status });
    out("compare", await compare());
    out("cache", await cache());
    out("conflict queue", (await queue("fact_conflict")).map((i) => i.why));
  });
});

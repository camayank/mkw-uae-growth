import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyFactChange, diffVersions } from "@tasees/core";
import { asPlatform } from "../src/lib/context.ts";
import { importCatalogueFacts } from "../src/import/catalogue.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E23: a contradicting source never changes a figure on its own; every change is explained; stale facts reach the
 * queue. Written before the fix. On `main` at 7f97829 the newest fact always won: an UNCERTAIN figure from an
 * intermediary replaced a verified official one in the engine (`docs/evidence/E23/before-fix.txt`).
 */
const day = (d: Date, plus = 0) => new Date(d.getTime() + plus * 86_400_000).toISOString().slice(0, 10);
const SRC = "https://example.gov.ae/fees";

describe("classifying a new fact against the current one (E23)", () => {
  const asOf = "2026-10-19";
  const current = { value: { minFils: 1_000_000, maxFils: 1_500_000 }, confidence: "verified" as const, evidenceDate: "2026-09-01", nextVerification: "2027-03-01", sourceUrl: SRC, sourceKind: "official" as const };
  const incoming = (over: Record<string, unknown>) => ({ ...current, evidenceDate: "2026-10-01", ...over });

  it("first, same, change", () => {
    expect(classifyFactChange(null, incoming({}), asOf).kind).toBe("first");
    expect(classifyFactChange(current, incoming({}), asOf).kind).toBe("same");
    const c = classifyFactChange(current, incoming({ value: { minFils: 1_100_000, maxFils: 1_500_000 } }), asOf);
    expect(c.kind).toBe("change");
    expect(c.reason).toMatch(/newer evidence/);
  });

  it("a weaker, an older, or a same-dated other source that disagrees is a conflict, with the reason", () => {
    const weaker = classifyFactChange(current, incoming({ value: { minFils: 900_000, maxFils: 1_200_000 }, confidence: "UNCERTAIN", sourceKind: "intermediary", sourceUrl: "https://agent.example/fees" }), asOf);
    expect(weaker).toMatchObject({ kind: "conflict" });
    expect(weaker.reason).toMatch(/UNCERTAIN.*contradicts.*verified/);
    const older = classifyFactChange(current, incoming({ value: { minFils: 900_000, maxFils: 1_200_000 }, evidenceDate: "2026-08-01" }), asOf);
    expect(older.reason).toMatch(/older evidence/);
    const sameDay = classifyFactChange(current, incoming({ value: { minFils: 900_000, maxFils: 1_200_000 }, evidenceDate: "2026-09-01", sourceUrl: "https://other.gov.ae/fees" }), asOf);
    expect(sameDay.reason).toMatch(/same date/);
    // The current figure is stale: it deserves a level less today, so a rule of thumb that is newer is a change.
    const stale = { ...current, nextVerification: "2026-10-01" };
    expect(classifyFactChange(stale, incoming({ value: { minFils: 900_000, maxFils: 1_200_000 }, confidence: "rule_of_thumb" }), asOf).kind).toBe("change");
  });

  it("compares versions: the previous value and the difference, for amounts and ranges", () => {
    const versions = diffVersions([
      { id: 1, value: { minFils: 1_000_000, maxFils: 1_500_000 } },
      { id: 2, value: { minFils: 1_100_000, maxFils: 1_500_000 } },
      { id: 3, value: 12 },
    ]);
    expect(versions[0]).toMatchObject({ id: 1, previous: null, delta: null });
    expect(versions[1]).toMatchObject({ id: 2, previous: { minFils: 1_000_000, maxFils: 1_500_000 }, delta: { minFils: 100_000, maxFils: 0 } });
    expect(versions[2]).toMatchObject({ id: 3, previous: { minFils: 1_100_000, maxFils: 1_500_000 }, delta: null });
    expect(diffVersions([{ id: 1, value: 10 }, { id: 2, value: 12 }])[1]).toMatchObject({ delta: 2 });
  });
});

describe("conflicts, versions and stale facts (E23)", () => {
  let env: TestEnv;
  const PLACE = "IFZA";
  const fact = (body: Record<string, unknown>, who = "founder") =>
    env.call(who, "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", subject: PLACE, field: "cost", evidenceDate: day(env.clock.now), sourceUrl: SRC, ...body });
  const place = async () => {
    const p = (await env.call("ops", "GET", "/api/admin/jurisdictions")).body.places.find((p: any) => p.name === PLACE);
    return { ...p, evidence: Object.fromEntries((p.evidence as any[]).map((e) => [e.field, e])) };
  };
  const queue = async (kind: string) => ((await env.call("founder", "GET", "/api/ops/queue")).body.items as any[]).filter((i) => i.kind === kind);
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("a weaker contradicting figure is recorded as a conflict and does not replace the verified figure", async () => {
    const verified = await fact({ valueText: "10000-15000", confidence: "verified", verifiedBy: "A. Qualified", nextVerification: day(env.clock.now, 180), evidenceDate: day(env.clock.now, -30) });
    expect(verified.status).toBe(200);
    expect(verified.body.change.kind).toMatch(/first|change/);
    const before = await place();
    expect(before.evidence.cost).toMatchObject({ confidence: "verified", factId: verified.body.id });
    const weaker = await fact({ valueText: "8000-12000", confidence: "UNCERTAIN", sourceKind: "intermediary", sourceUrl: "https://agent.example/ifza", evidenceDate: day(env.clock.now, -10) });
    expect(weaker.status).toBe(200);
    expect(weaker.body.change).toMatchObject({ kind: "conflict", supersedes: verified.body.id });
    expect(weaker.body.change.reason).toMatch(/UNCERTAIN.*contradicts/);
    // The engine and every screen keep the verified figure.
    const after = await place();
    expect(after.evidence.cost).toMatchObject({ confidence: "verified", factId: verified.body.id });
    const cache = (await asPlatform(env.db, null, (tx) => tx.query<any>("select cost_min_fils from zones where name = $1", [PLACE]))).rows[0];
    expect(Number(cache.cost_min_fils)).toBe(1_000_000);
    // It is flagged to the verifier: a queue item with the decision as its action, for the founder.
    const items = await queue("fact_conflict");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ subjectId: String(weaker.body.id), label: "Evidence conflict to resolve" });
    expect(items[0].why).toMatch(/UNCERTAIN.*contradicts.*verified/);
    expect(items[0].actions.map((a: any) => a.label).sort()).toEqual(["Accept the new figure", "Keep the current figure"]);
    // The history says so, with the version comparison.
    const history = (await env.call("ops", "GET", `/api/admin/jurisdictions/history?kind=place&subject=${PLACE}`)).body;
    const row = history.find((h: any) => h.id === weaker.body.id);
    expect(row).toMatchObject({ current: false, change: { kind: "conflict" }, review: null });
    const compare = (await env.call("ops", "GET", `/api/admin/jurisdictions/compare?kind=place&subject=${PLACE}&field=cost`)).body;
    expect(compare.versions.map((v: any) => [v.id, v.change.kind, v.current])).toEqual([[verified.body.id, expect.any(String), true], [weaker.body.id, "conflict", false]]);
    expect(compare.versions[1]!).toMatchObject({ previous: { minFils: 1_000_000, maxFils: 1_500_000 }, delta: { minFils: -200_000, maxFils: -300_000 } });
  });

  it("a weaker source that agrees cannot replace the figure either: it would replace the confidence (review)", async () => {
    const agreeing = await fact({ valueText: "10000-15000", confidence: "UNCERTAIN", sourceKind: "intermediary", sourceUrl: "https://agent.example/ifza-2", evidenceDate: day(env.clock.now, -5) });
    expect(agreeing.body.change).toMatchObject({ kind: "conflict" });
    expect(agreeing.body.change.reason).toMatch(/agrees with the current verified figure but cannot replace it/);
    expect((await place()).evidence.cost).toMatchObject({ confidence: "verified", sourceKind: "official" });
    expect(await queue("fact_conflict")).toHaveLength(2);
    await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${agreeing.body.id}/review`, { decision: "keep", note: "Agrees, but an agent's page is not the authority's schedule." });
    expect(await queue("fact_conflict")).toHaveLength(1);
  });

  it("ops see the conflict but not the founder's buttons (review)", async () => {
    const items = ((await env.call("ops", "GET", "/api/ops/queue")).body.items as any[]).filter((i) => i.kind === "fact_conflict");
    expect(items).toHaveLength(1);
    expect(items[0].actions).toEqual([]);
    expect((await queue("fact_conflict"))[0].actions).toHaveLength(2); // the founder
  });

  it("only the founder decides; keeping the current figure closes the conflict; the decision is recorded once and audited", async () => {
    const id = (await queue("fact_conflict"))[0].subjectId;
    expect((await env.call("ops", "POST", `/api/admin/jurisdictions/facts/${id}/review`, { decision: "keep", note: "An agent's page; the authority's own fee schedule stands." })).status).toBe(403);
    expect((await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${id}/review`, { decision: "keep", note: "An agent's page; the authority's own fee schedule stands." })).status).toBe(200);
    expect(await queue("fact_conflict")).toEqual([]);
    expect((await place()).evidence.cost.confidence).toBe("verified");
    expect((await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${id}/review`, { decision: "accept", note: "changed my mind" })).status).toBe(409);
    await expect(asPlatform(env.db, null, (tx) => tx.query("update catalogue_fact_reviews set decision = 'accept'"))).rejects.toThrow(/append-only|permission denied/);
    const ev = (await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'catalogue.conflict_reviewed' and (data->>'factId')::int = $1", [Number(id)]))).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ factId: Number(id), decision: "keep" });
    const row = (await env.call("ops", "GET", `/api/admin/jurisdictions/history?kind=place&subject=${PLACE}`)).body.find((h: any) => h.id === Number(id));
    expect(row.review).toMatchObject({ decision: "keep", by: expect.any(String) });
  });

  it("accepting a conflict makes the new figure current, in the cache and the engine, audited", async () => {
    // As strong as the current figure (verified), but older evidence.
    const older = await fact({ valueText: "9000-14000", confidence: "verified", verifiedBy: "B. Checker", nextVerification: day(env.clock.now, 120), evidenceDate: day(env.clock.now, -60) });
    expect(older.body.change).toMatchObject({ kind: "conflict" });
    expect(older.body.change.reason).toMatch(/older evidence/);
    expect((await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${older.body.id}/review`, { decision: "accept", note: "The authority confirmed the older schedule still applies." })).status).toBe(200);
    const p = await place();
    expect(p.evidence.cost).toMatchObject({ factId: older.body.id, confidence: "verified" });
    expect(Number((await asPlatform(env.db, null, (tx) => tx.query<any>("select cost_min_fils from zones where name = $1", [PLACE]))).rows[0].cost_min_fils)).toBe(900_000);
    expect(await queue("fact_conflict")).toEqual([]);
  });

  it("a newer figure of equal strength is a change, becomes current and names what it replaced; a later fact closes an open conflict", async () => {
    const changed = await fact({ valueText: "9500-14000", confidence: "verified", verifiedBy: "B. Checker", nextVerification: day(env.clock.now, 120) });
    expect(changed.body.change).toMatchObject({ kind: "change" });
    expect(changed.body.change.reason).toMatch(/newer evidence/);
    expect((await place()).evidence.cost.factId).toBe(changed.body.id);
    const conflict = await fact({ valueText: "1000-2000", confidence: "UNCERTAIN", evidenceDate: day(env.clock.now, -5) });
    expect(conflict.body.change.kind).toBe("conflict");
    expect(await queue("fact_conflict")).toHaveLength(1);
    const next = await fact({ valueText: "9600-14000", confidence: "verified", verifiedBy: "B. Checker", nextVerification: day(env.clock.now, 120) });
    expect(next.body.change.kind).toBe("change");
    expect(await queue("fact_conflict")).toEqual([]); // moot: a later fact superseded the figure it contradicted
    const compare = (await env.call("ops", "GET", `/api/admin/jurisdictions/compare?kind=place&subject=${PLACE}&field=cost`)).body;
    expect(compare.versions.at(-1)!).toMatchObject({ id: next.body.id, current: true, previous: { minFils: 950_000, maxFils: 1_400_000 } });
    expect(compare.versions.filter((v: any) => v.current)).toHaveLength(1);
  });

  it("the importer classifies the same way: a dry run reports the conflict it would record, and applying records it as one", async () => {
    const founder = (await env.call("founder", "GET", "/api/me")).body;
    const grid = [
      ["Kind", "Place or authority", "Field", "Value", "Source", "Evidence date", "Confidence", "Source kind"],
      ["place", PLACE, "cost", "5000-7000", "https://agent.example/ifza-fees", day(env.clock.now, -3), "UNCERTAIN", "intermediary"],
    ];
    // A dry run is the same transaction rolled back.
    const dry = await asPlatform(env.db, founder, async (tx) => {
      const report = await importCatalogueFacts(tx, grid, "dry.csv", founder);
      throw Object.assign(new Error("dry"), { report });
    }).catch((e) => (e as { report?: any }).report);
    expect(dry.rows[0].reason).toMatch(/CONFLICT, waits for the founder/);
    expect(dry.notes.join(" ")).toMatch(/1 figure\(s\) contradict/);
    expect(await queue("fact_conflict")).toEqual([]);
    const applied = await asPlatform(env.db, founder, (tx) => importCatalogueFacts(tx, grid, "apply.csv", founder));
    expect(applied.rows[0]!.reason).toMatch(/CONFLICT/);
    expect(await queue("fact_conflict")).toHaveLength(1);
    // Re-importing the master sheet's unchanged row records nothing and decides nothing (review): the conflict stays open.
    const cur = (await env.call("ops", "GET", `/api/admin/jurisdictions/compare?kind=place&subject=${PLACE}&field=cost`)).body.versions.find((v: any) => v.current);
    const master = [grid[0]!, ["place", PLACE, "cost", "9600-14000", cur.sourceUrl, cur.evidenceDate, "verified", "official"]];
    const again = await asPlatform(env.db, founder, (tx) => importCatalogueFacts(tx, [[...master[0]!, "Verified by"], [...master[1]!, "B. Checker"]], "again.csv", founder));
    expect(again.rows[0]!.action).toBe("unchanged");
    expect(await queue("fact_conflict")).toHaveLength(1);
    // Re-importing the agent's row again is unchanged too: no second conflict.
    const twice = await asPlatform(env.db, founder, (tx) => importCatalogueFacts(tx, grid, "twice.csv", founder));
    expect(twice.rows[0]!.action).toBe("unchanged");
    expect(await queue("fact_conflict")).toHaveLength(1);
  });

  it("the founder's own verification of a place is a decision, not a contradicting source (review)", async () => {
    // Weaker figures given by the founder on the place itself take effect, as before E23, and raise no conflict.
    const open = await queue("fact_conflict"); // the importer's, still open
    expect(open).toHaveLength(1);
    const r = await env.call("founder", "PUT", `/api/admin/scoping/zones/${PLACE}`, { confidence: "UNCERTAIN", costMinAed: 9800, costMaxAed: 14000 });
    expect(r.status).toBe(200);
    expect(await queue("fact_conflict")).toEqual([]); // the founder's figure superseded the one the importer's row contradicted
    expect(Number((await asPlatform(env.db, null, (tx) => tx.query<any>("select cost_min_fils from zones where name = $1", [PLACE]))).rows[0].cost_min_fils)).toBe(980_000);
    const latest = (await env.call("ops", "GET", `/api/admin/jurisdictions/history?kind=place&subject=${PLACE}`)).body.find((h: any) => h.field === "cost");
    expect(latest.change.kind).toBe("change");
    expect(latest.change.reason).toMatch(/founder's own verification/);
    // Accepting the importer's conflict now is refused: the field was recorded again since.
    const refused = await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${open[0].subjectId}/review`, { decision: "accept", note: "too late to accept" });
    expect(refused.status).toBe(409);
    expect((await env.call("founder", "POST", `/api/admin/jurisdictions/facts/${open[0].subjectId}/review`, { decision: "keep", note: "superseded by the founder's own figure" })).status).toBe(200);
  });

  it("a current engine fact past its re-verification date is a queue item for the place, and a new fact clears it", async () => {
    expect((await fact({ valueText: "9900-14000", confidence: "verified", verifiedBy: "B. Checker", nextVerification: day(env.clock.now, 120) })).body.change.kind).toBe("change");
    expect(await queue("evidence_stale")).toEqual([]);
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 200 * 86_400_000); // past every re-verification date recorded above
    try {
      const items = await queue("evidence_stale");
      const mine = items.find((i: any) => i.ref === PLACE);
      expect(mine).toMatchObject({ label: "Stale evidence to re-verify" });
      expect(mine.why).toMatch(/cost/);
      expect(mine.link).toMatch(/scoping/);
      expect((await env.call("ops", "GET", "/api/admin/coverage")).body.conflicts.open).toBe(0);
      // A fresh fact for the field clears it (the only engine field with a fact on this place).
      expect((await fact({ valueText: "9700-14000", confidence: "verified", verifiedBy: "B. Checker", nextVerification: day(env.clock.now, 120), evidenceDate: day(env.clock.now) })).status).toBe(200);
      expect((await queue("evidence_stale")).find((i: any) => i.ref === PLACE)).toBeUndefined();
    } finally {
      env.clock.now = saved;
    }
  });
});

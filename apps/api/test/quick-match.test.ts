import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E8 over HTTP: the quick match answers four questions with the place to look at first and live counts, through the
 * same public filter as the full assessment (D80). It writes nothing, carries no money internals, refuses bad input
 * and is rate-limited per IP.
 */
const count = async (env: TestEnv, table: string): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`))).rows[0]!.n;
const walk = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), walk(x, out));
  else if (typeof v === "string") out.push(v);
  return out;
};

describe("the quick match (E8)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  const quick = (body: Record<string, unknown>) => env.call("anon", "POST", "/api/public/quick", body);
  const tech = { activity: "tech", emirate: "Dubai", visas: 1 };

  it("with nothing approved it names places to look at, with no figure, no rule text and no exclusion, and writes nothing", async () => {
    const before = { requests: await count(env, "requests"), leads: await count(env, "intake_leads"), audit: await count(env, "audit_events"), outbox: await count(env, "outbox"), funnel: await count(env, "funnel_events") };
    const r = await quick(tech);
    expect(r.status).toBe(200);
    const m = r.body;
    expect(m.disclaimer).toMatch(/preliminary, general information/);
    expect(m.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.options).toBeGreaterThan(0);
    expect(m.best).toMatchObject({ emirate: "Dubai", toBeVerified: true });
    expect(m.best.figures).toBeUndefined();
    expect(m.structure).toEqual({ recommendation: null, confirmed: false });
    expect(m.byBudget.map((b: any) => b.id)).toEqual(["up_to_15k", "up_to_25k", "up_to_50k", "open"]);
    expect(m.byBudget.every((b: any) => b.options === m.options)).toBe(true);
    expect(Object.keys(m.byEmirate)).toEqual(["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"]);
    expect(m.approved.places).toBe(0);
    expect(Object.keys(m.onRecord)).toEqual(Object.keys(m.byEmirate));
    expect([m.best, ...m.alternatives].every((p: any) => p.conditions === 0)).toBe(true); // no unapproved condition is counted
    expect(m.noViableOption).toBe(false);
    expect(JSON.stringify(m)).not.toMatch(/AED|costM|visaQuota|timelineDays|ruleKey|outcome|authority|sourceUrl/);
    for (const s of walk(m)) expect(s, s).not.toMatch(/margin|partner_?(unit|cost|org|id)|payout|rate_?card|professional_?fils|commission|digest|lastFactId/i);
    // Anywhere: every place on record is still open, and nothing was written by any of it.
    const any = (await quick({ activity: "tech", visas: 1 })).body;
    expect(any.options).toBe(Object.values(any.byEmirate).reduce((a: number, b: any) => a + b, 0));
    expect(any.bestElsewhere).toBe(false);
    expect({ requests: await count(env, "requests"), leads: await count(env, "intake_leads"), audit: await count(env, "audit_events"), outbox: await count(env, "outbox"), funnel: await count(env, "funnel_events") }).toEqual(before);
  });

  it("an approved place shows its figures, and a count falls only on an exclusion the public may see", async () => {
    // IFZA verified at 16,000 to 20,000 and approved; the budget rule verified but not yet approved.
    expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/IFZA", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/", costMinAed: 16_000, costMaxAed: 20_000 })).status).toBe(200);
    expect((await env.call("founder", "POST", "/api/admin/public-display/approve", { kind: "place", subject: "IFZA", note: "checked" })).status).toBe(200);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/place.budget", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/fees" })).status).toBe(200);
    const open = (await quick({ ...tech, budget: "open" })).body;
    const ifza = [open.best, ...open.alternatives].find((p: any) => p.zone === "IFZA");
    expect(ifza).toMatchObject({ toBeVerified: false, figures: { costMinFils: 1_600_000, costMaxFils: 2_000_000 }, sourceUrl: "https://ifza.com/" });
    expect(open.approved.places).toBe(1);
    // Under 15,000 IFZA fails the budget, but the rule saying so is not approved: it stays open, to be verified.
    const low = (await quick({ ...tech, budget: "up_to_15k" })).body;
    expect(low.options).toBe(open.options);
    expect(low.byBudget.find((b: any) => b.id === "up_to_15k").options).toBe(open.options);
    // Once the founder approves the budget rule, IFZA leaves the under-15,000 count and the list.
    expect((await env.call("founder", "POST", "/api/admin/public-display/approve", { kind: "rule", subject: "place.budget", note: "checked" })).status).toBe(200);
    const after = (await quick({ ...tech, budget: "up_to_15k" })).body;
    expect(after.options).toBe(open.options - 1);
    expect(after.byBudget.find((b: any) => b.id === "up_to_15k").options).toBe(open.options - 1);
    expect(after.byBudget.find((b: any) => b.id === "up_to_25k").options).toBe(open.options);
    expect([after.best, ...after.alternatives].some((p: any) => p?.zone === "IFZA")).toBe(false);
    for (const s of walk(after)) expect(s, s).not.toMatch(/margin|payout|professional_?fils|commission/i);
  });

  it("refuses bad input and is rate-limited per IP", async () => {
    expect((await quick({ ...tech, emirate: "Atlantis" })).status).toBe(400);
    expect((await quick({ ...tech, budget: "a lot" })).status).toBe(400);
    expect((await quick({ ...tech, visas: 9_999 })).status).toBe(400);
    expect((await quick({ ...tech, activity: "banking" })).status).toBe(400);
    expect((await quick({ ...tech, extra: "field" })).status).toBe(200); // unknown keys are dropped, as on the assessment
    let last = 200;
    for (let i = 0; i < 260 && last === 200; i++) last = (await quick(tech)).status;
    expect(last).toBe(429);
  }, 60_000);
});

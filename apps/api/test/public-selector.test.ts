import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E3 over HTTP (D80): the founder approves rules and places for public display once per version; the public
 * assessment shows only what is approved, writes nothing, is rate-limited and carries no money internals; the review
 * request becomes a lead with consent.
 */
const count = async (env: TestEnv, table: string): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`))).rows[0]!.n;
const walk = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), walk(x, out));
  else if (typeof v === "string") out.push(v);
  return out;
};

describe("public display and the public selector", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  const answers = { emirate: "Dubai", activity: "tech", customers: "international", visas: 2, budgetAed: 30_000, premises: "office", ownerType: "individuals", foreignTaxResident: false };
  const assess = (body: Record<string, unknown> = answers) => env.call("anon", "POST", "/api/public/assess", body);
  const approve = (kind: string, subject: string, role = "founder") => env.call(role, "POST", "/api/admin/public-display/approve", { kind, subject, note: "checked" });

  it("with nothing approved the public result carries no rule text and no figure, and nothing is written", async () => {
    const before = { requests: await count(env, "requests"), leads: await count(env, "intake_leads"), audit: await count(env, "audit_events"), outbox: await count(env, "outbox") };
    const r = await assess();
    expect(r.status).toBe(200);
    const p = r.body;
    expect(p.disclaimer).toMatch(/preliminary, general information/);
    expect(p.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.approved).toMatchObject({ statements: 0, places: 0 });
    expect(p.places.length).toBeGreaterThan(0);
    expect(p.places.every((x: any) => x.toBeVerified && !x.figures)).toBe(true);
    expect([...p.structure.reasons, ...p.obligations].every((s: any) => s.toBeVerified && s.text === undefined)).toBe(true);
    expect(p.structure).toMatchObject({ confirmed: false, recommendation: null });
    expect(JSON.stringify(p)).not.toMatch(/AED|Fils":\s*[1-9]|visaQuota|timelineDays|ruleKey|outcome|authority|known for/);
    expect(p.noViableOption).toBe(false);
    for (const s of walk(p)) expect(s, s).not.toMatch(/margin|partner_?(unit|cost|org|id)|payout|rate_?card|professional_?fils|commission|digest|lastFactId/i);
    expect({ requests: await count(env, "requests"), leads: await count(env, "intake_leads"), audit: await count(env, "audit_events"), outbox: await count(env, "outbox") }).toEqual(before);
  });

  it("only the founder approves, only a checked rule or place can be approved, and an approval is audited", async () => {
    expect((await approve("rule", "obligation.corporate_tax", "ops")).status).toBe(403);
    expect((await approve("rule", "obligation.corporate_tax")).body.message).toMatch(/UNCERTAIN: verify it/);
    expect((await approve("place", "IFZA")).body.message).toMatch(/UNCERTAIN: verify it/);
    expect((await approve("rule", "no.such.rule")).status).toBe(404);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.corporate_tax", { confidence: "verified", verifiedBy: "A. Qualified, tax agent", sourceUrl: "https://tax.gov.ae/ct" })).status).toBe(200);
    expect((await approve("rule", "obligation.corporate_tax")).status).toBe(200);
    expect((await approve("rule", "obligation.corporate_tax")).status).toBe(409);
    const ev = (await asPlatform(env.db, null, (tx) => tx.query("select data from audit_events where action = 'public_display.approved' and entity_id = 'obligation.corporate_tax'"))).rows;
    expect(ev).toHaveLength(1);
    // The founder sees the engine's wording for the rule before approving it: that is what the public reads.
    const shown = (await env.call("ops", "GET", "/api/admin/public-display")).body.rules.find((r: any) => r.key === "obligation.corporate_tax");
    expect(shown.texts).toEqual([expect.stringMatching(/^Register for corporate tax/)]);
    expect(shown.display.version).toMatch(/^2:verified:[0-9a-f]{16}$/);
    const o = (await env.call("ops", "GET", "/api/admin/public-display")).body;
    expect(o.rules.find((r: any) => r.key === "obligation.corporate_tax").display).toMatchObject({ approved: true, approvedBy: expect.any(String) });
    expect((await env.call("client", "GET", "/api/admin/public-display")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/admin/public-display")).status).toBe(403);
  });

  it("an approved statement reaches the public with its text; a new version of the rule lapses the approval", async () => {
    const p = (await assess()).body;
    const ct = p.obligations.find((s: any) => s.ruleKey === "obligation.corporate_tax");
    expect(ct).toMatchObject({ toBeVerified: false });
    expect(ct.text).toMatch(/Register for corporate tax/);
    expect(p.approved.statements).toBe(1);
    // Verifying the rule again is a new version: the public no longer sees it until it is approved again.
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.corporate_tax", { confidence: "verified", verifiedBy: "A. Qualified, tax agent", sourceUrl: "https://tax.gov.ae/ct", statement: "Register for corporate tax with the FTA within the set period." })).status).toBe(200);
    const lapsed = (await assess()).body;
    expect(lapsed.obligations.find((s: any) => s.ruleKey === "obligation.corporate_tax")).toBeUndefined(); // unapproved: no key, no text
    expect(JSON.stringify(lapsed)).not.toMatch(/Register for corporate tax/);
    const o = (await env.call("ops", "GET", "/api/admin/public-display")).body;
    expect(o.rules.find((r: any) => r.key === "obligation.corporate_tax").display).toMatchObject({ approved: false, lapsed: true });
    expect((await approve("rule", "obligation.corporate_tax")).status).toBe(200);
    expect((await assess()).body.obligations.find((s: any) => s.ruleKey === "obligation.corporate_tax")).toMatchObject({ toBeVerified: false, text: expect.stringMatching(/Register for corporate tax/) });
    // The two approvals are both on record; only the latest is live.
    const rows = (await asPlatform(env.db, null, (tx) => tx.query("select version, revoked_at is null as live, revoke_note from public_approvals where subject = 'obligation.corporate_tax' order by id"))).rows as any[];
    expect(rows.map((x) => [x.version.split(":")[0], x.live])).toEqual([["2", false], ["3", true]]);
    expect(rows[0].revoke_note).toMatch(/superseded/);
  });

  it("an approved place shows its figures; a new fact lapses the approval; revoking hides it at once", async () => {
    expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/IFZA", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/", costMinAed: 12_900, costMaxAed: 18_000 })).status).toBe(200);
    expect((await approve("place", "IFZA")).status).toBe(200);
    let ifza = (await assess()).body.places.find((x: any) => x.zone === "IFZA");
    expect(ifza).toMatchObject({ toBeVerified: false, figures: { costMinFils: 1_290_000, costMaxFils: 1_800_000, visaQuota: 1 } });
    expect((await assess()).body.places.filter((x: any) => x.zone !== "IFZA").every((x: any) => !x.figures)).toBe(true);
    // A recorded fact changes the place's version.
    expect((await env.call("founder", "POST", "/api/admin/jurisdictions/facts", { subjectKind: "place", subject: "IFZA", field: "visa_quota", valueText: "2", sourceUrl: "https://ifza.com/packages", evidenceDate: "2026-10-01", confidence: "rule_of_thumb" })).status).toBe(200);
    ifza = (await assess()).body.places.find((x: any) => x.zone === "IFZA");
    expect(ifza.toBeVerified).toBe(true);
    expect(ifza.figures).toBeUndefined();
    expect((await approve("place", "IFZA")).status).toBe(200);
    expect((await assess()).body.places.find((x: any) => x.zone === "IFZA").figures.visaQuota).toBe(2);
    expect((await env.call("founder", "POST", "/api/admin/public-display/revoke", { kind: "place", subject: "IFZA", note: "fees changed" })).status).toBe(200);
    expect((await assess()).body.places.find((x: any) => x.zone === "IFZA").figures).toBeUndefined();
    expect((await env.call("founder", "POST", "/api/admin/public-display/revoke", { kind: "place", subject: "IFZA", note: "" })).status).toBe(409);
  });

  it("a rule whose verification goes stale loses its public approval until it is checked again", async () => {
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.ubo", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://moec.gov.ae/ubo", nextVerification: "2026-10-25" })).status).toBe(200);
    expect((await approve("rule", "obligation.ubo")).status).toBe(200);
    expect((await assess()).body.obligations.find((s: any) => s.ruleKey === "obligation.ubo")?.text).toMatch(/beneficial owner/);
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 10 * 86_400_000);
    try {
      expect((await assess()).body.obligations.find((s: any) => s.topic === "an obligation after setup" && s.ruleKey === "obligation.ubo")).toBeUndefined();
      const o = (await env.call("ops", "GET", "/api/admin/public-display")).body.rules.find((r: any) => r.key === "obligation.ubo");
      expect(o.display).toMatchObject({ approved: false, lapsed: true });
      expect((await approve("rule", "obligation.ubo")).body.message).toMatch(/past its re-verification date/);
    } finally {
      env.clock.now = saved;
    }
  });

  it("a stale place cannot be approved for public display", async () => {
    expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/SHAMS", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://shams.ae/", nextVerification: "2026-10-25" })).status).toBe(200);
    expect((await approve("place", "SHAMS")).status).toBe(200);
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 10 * 86_400_000); // past 25 Oct: stale
    try {
      expect((await assess()).body.places.find((x: any) => x.zone === "SHAMS")?.figures).toBeUndefined();
      expect((await approve("place", "SHAMS")).body.message).toMatch(/past its re-verification date/);
    } finally {
      env.clock.now = saved;
    }
  });

  it("the public assessment is rate-limited per IP and refuses bad input", async () => {
    expect((await assess({ ...answers, visas: 9_999 })).status).toBe(400);
    expect((await assess({ ...answers, activity: "banking" })).status).toBe(400);
    let last = 200;
    for (let i = 0; i < 70 && last === 200; i++) last = (await assess()).status;
    expect(last).toBe(429);
  });

  it("asking for a review creates the lead with consent and the answers, through the existing public intake", async () => {
    const leads = await count(env, "intake_leads");
    const requests = await count(env, "requests");
    const lead = (consentVersion: string) => env.call("anon", "POST", "/api/public/intake", {
      company: "Selector Ventures", name: "A. Founder", email: "selector-founder@example.test", consent: true, consentVersion, campaign: "selector",
      answers: { mode: "new_company", jurisdiction: "not_sure", ...answers },
    });
    // The consent record names the text the person agreed to; an unknown version is refused.
    expect((await lead("2026-11-made-up")).status).toBe(400);
    const r = await lead("2026-11-selector-v1");
    expect(r.status).toBe(200);
    const consent = (await asPlatform(env.db, null, (tx) => tx.query("select consent from users where email = 'selector-founder@example.test'"))).rows[0] as any;
    expect(consent.consent.version).toBe("2026-11-selector-v1");
    expect(await count(env, "requests")).toBe(requests + 1);
    expect(await count(env, "intake_leads")).toBe(leads); // a new email becomes a client and a request, not a held lead
    const [req] = (await asPlatform(env.db, null, (tx) => tx.query("select answers, source from requests order by created_at desc limit 1"))).rows as any[];
    expect(req.answers).toMatchObject({ activity: "tech", premises: "office", budgetAed: 30_000 });
    expect(req.source).toMatchObject({ channel: "public_intake", campaign: "selector" });
  });
});

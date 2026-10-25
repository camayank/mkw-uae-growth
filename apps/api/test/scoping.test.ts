import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advise, type AdviceInput, type ScopingRule, type Zone } from "@tasees/core";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { SCOPING_RULES, ZONES } from "../src/db/scoping-data.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/** O5: the advice engine against 20 founder cases, rule confidence, ops approval, public intake, AI drafts, search. */

const rules: ScopingRule[] = SCOPING_RULES.map(([key, kind, statement, parameters, sourceUrl]) => ({ key, kind, statement, parameters, sourceUrl, confidence: "UNCERTAIN" }));
const zones: Zone[] = ZONES.map(([name, emirate, type, visaQuota, min, max, timelineDays, activities]) => ({ name, emirate, type, visaQuota, costMinFils: min * 100, costMaxFils: max * 100, timelineDays, activities, sourceUrl: "", confidence: "UNCERTAIN" }));

/** Twenty founder cases with the answer a qualified person would expect from the rules as written. */
const CASES: Array<{ name: string; input: AdviceInput; structure: AdviceInput["jurisdiction"] | null; obligations: string[]; licences?: string[]; firstPlace?: string }> = [
  { name: "consultant, international clients, 1 visa, Dubai", input: { mode: "new_company", emirate: "Dubai", activity: "consulting", customers: "international", visas: 1, budgetAed: 15000 }, structure: "free_zone", obligations: ["obligation.corporate_tax", "obligation.vat_watch", "obligation.ubo", "obligation.wps"], firstPlace: "IFZA" },
  { name: "retail shop selling to UAE residents", input: { mode: "new_company", emirate: "Dubai", activity: "trading", customers: "uae_mainland", visas: 2, officeNeeded: true }, structure: "mainland", obligations: ["obligation.corporate_tax", "obligation.goaml_dnfbp"], firstPlace: "Dubai DET mainland" },
  { name: "restaurant in Sharjah", input: { mode: "new_company", emirate: "Sharjah", activity: "food", customers: "uae_mainland", visas: 5 }, structure: "mainland", obligations: ["obligation.wps"], licences: ["licence.food"], firstPlace: "Sharjah SEDD mainland" },
  { name: "holding company, no visas, small budget", input: { mode: "new_company", emirate: "Ras Al Khaimah", activity: "holding", visas: 0, budgetAed: 12000 }, structure: "offshore", obligations: ["obligation.corporate_tax", "obligation.ubo"], firstPlace: "RAK ICC" },
  { name: "holding company with visas", input: { mode: "new_company", emirate: "Dubai", activity: "holding", visas: 2, budgetAed: 12000 }, structure: "offshore", obligations: ["obligation.ubo"] },
  { name: "family holding with a large budget", input: { mode: "new_company", emirate: "Dubai", activity: "holding", visas: 0, budgetAed: 80000 }, structure: "difc_adgm", obligations: ["obligation.corporate_tax"], firstPlace: "DIFC" },
  { name: "asset manager", input: { mode: "new_company", emirate: "Abu Dhabi", activity: "finance", customers: "international", visas: 3, budgetAed: 100000 }, structure: "difc_adgm", obligations: ["obligation.corporate_tax"], licences: ["licence.financial"], firstPlace: "ADGM" },
  { name: "SaaS startup, international", input: { mode: "new_company", emirate: "Dubai", activity: "tech", customers: "international", visas: 3, budgetAed: 20000 }, structure: "free_zone", obligations: ["obligation.wps"], firstPlace: "IFZA" },
  { name: "e-commerce selling to the UAE and abroad", input: { mode: "new_company", emirate: "Dubai", activity: "ecommerce", customers: "both", visas: 1 }, structure: "free_zone", obligations: ["obligation.corporate_tax"], licences: ["licence.ecommerce"] },
  { name: "clinic", input: { mode: "new_company", emirate: "Dubai", activity: "health", customers: "uae_mainland", visas: 4, officeNeeded: true }, structure: "mainland", licences: ["licence.health"], obligations: ["obligation.wps"] },
  { name: "training academy, online, international", input: { mode: "new_company", emirate: "Dubai", activity: "education", customers: "international", visas: 2 }, structure: "free_zone", licences: ["licence.education"], obligations: ["obligation.corporate_tax"] },
  { name: "contractor needing a site", input: { mode: "new_company", emirate: "Abu Dhabi", activity: "construction", customers: "uae_mainland", visas: 10, officeNeeded: true }, structure: "mainland", obligations: ["obligation.wps"], firstPlace: "Abu Dhabi DED mainland" },
  { name: "trader above the VAT threshold", input: { mode: "new_company", emirate: "Dubai", activity: "trading", customers: "international", visas: 1, expectedTurnoverAed: 900000 }, structure: "free_zone", obligations: ["obligation.vat_mandatory"] },
  { name: "consultant in the voluntary VAT band", input: { mode: "new_company", emirate: "Dubai", activity: "consulting", customers: "international", visas: 1, expectedTurnoverAed: 200000 }, structure: "free_zone", obligations: ["obligation.vat_voluntary"] },
  { name: "consultant below both thresholds", input: { mode: "new_company", emirate: "Dubai", activity: "consulting", customers: "international", visas: 1, expectedTurnoverAed: 50000 }, structure: "free_zone", obligations: ["obligation.vat_watch"] },
  { name: "founder asked for mainland but answers point to a free zone", input: { mode: "new_company", jurisdiction: "mainland", emirate: "Dubai", activity: "consulting", customers: "international", visas: 1 }, structure: "free_zone", obligations: ["obligation.corporate_tax"] },
  { name: "founder named a zone", input: { mode: "new_company", jurisdiction: "free_zone", freeZone: "shams", emirate: "Dubai", activity: "consulting", customers: "international", visas: 1 }, structure: "free_zone", obligations: ["obligation.corporate_tax"], firstPlace: "SHAMS" },
  { name: "RAK trader on a budget", input: { mode: "new_company", emirate: "Ras Al Khaimah", activity: "trading", customers: "international", visas: 1, budgetAed: 9000 }, structure: "free_zone", obligations: ["obligation.goaml_dnfbp"], firstPlace: "RAKEZ" },
  { name: "consultant who will sell to mainland firms from a free zone", input: { mode: "new_company", emirate: "Dubai", activity: "consulting", customers: "both", visas: 1 }, structure: "free_zone", obligations: ["obligation.corporate_tax"] },
  { name: "existing company asking for services only", input: { mode: "services", emirate: "Dubai", services: ["VAT-RET"], expectedTurnoverAed: 500000 }, structure: null, obligations: ["obligation.vat_mandatory"] },
];

describe("advice engine: 20 founder cases", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const a = advise(c.input, rules, zones);
      expect(a.structure.recommendation).toBe(c.structure);
      const keys = [...a.structure.reasons, ...a.licences, ...a.obligations].map((r) => r.ruleKey);
      for (const k of c.obligations) expect(keys, `${c.name}: missing ${k}`).toContain(k);
      for (const k of c.licences ?? []) expect(keys, `${c.name}: missing licence ${k}`).toContain(k);
      if (c.firstPlace) expect(a.places[0]?.zone, `${c.name}: first place`).toBe(c.firstPlace);
      if (c.structure) expect(a.places.length).toBeGreaterThanOrEqual(2);
      // Nothing is firmer than the rules it came from: all UNCERTAIN here.
      expect(a.hasUncertain).toBe(true);
      for (const r of [...a.structure.reasons, ...a.licences, ...a.obligations]) if (r.ruleKey) expect(r.confidence).toBe("UNCERTAIN");
    });
  }

  it("a case where the founder names a jurisdiction the answers do not support says so, as confident as its rule", () => {
    const a = advise({ mode: "new_company", jurisdiction: "mainland", emirate: "Dubai", activity: "consulting", customers: "international", visas: 1 }, rules, zones);
    const note = a.structure.reasons.find((r) => r.ruleKey === "structure.requested_differs")!;
    expect(note.text).toMatch(/You asked for mainland/);
    expect(note.confidence).toBe("UNCERTAIN"); // a rule like any other: unverified until a person signs it off
  });

  it("the advice is exactly as confident as the rules: a verified rule shows as verified", () => {
    const verified = rules.map((r) => (r.key === "obligation.corporate_tax" ? { ...r, confidence: "verified" as const, verifiedBy: "A. Qualified", verifiedAt: "2026-10-17" } : r));
    const a = advise(CASES[0]!.input, verified, zones);
    expect(a.obligations.find((o) => o.ruleKey === "obligation.corporate_tax")!.confidence).toBe("verified");
    expect(a.obligations.find((o) => o.ruleKey === "obligation.ubo")!.confidence).toBe("UNCERTAIN");
    const allVerified = rules.map((r) => ({ ...r, confidence: "verified" as const }));
    const zonesVerified = zones.map((z) => ({ ...z, confidence: "verified" as const }));
    expect(advise(CASES[0]!.input, allVerified, zonesVerified).hasUncertain).toBe(false);
  });
});

describe("advice on requests: review before the client sees it", () => {
  let env: TestEnv;
  let requestId: string;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("stores advice as pending review; the client sees none until ops approves, then sees it with its confidence labels", async () => {
    const r = await env.call("client", "POST", "/api/requests", {
      answers: { mode: "new_company", jurisdiction: "not_sure", emirate: "Dubai", visas: 2, activity: "tech", customers: "international", budgetAed: 20000, expectedTurnoverAed: 500000, description: "We are building a SaaS app, need 2 visas, a bank account and VAT registration" },
    });
    expect(r.status).toBe(200);
    expect(r.body.adviceStatus).toBe("pending_review");
    expect(r.body.aiDraft).toBeTruthy();
    requestId = r.body.id;
    const home = await env.call("client", "GET", "/api/client/home");
    const mine = home.body.requests.find((x: any) => x.id === requestId);
    expect(mine.adviceStatus).toBe("pending_review");
    expect(mine.advice).toBeNull();
    const queue = await env.call("ops", "GET", "/api/ops/overview");
    expect(queue.body.exceptions.some((x: any) => x.kind === "scoping" && x.ref === requestId)).toBe(true);
    expect(queue.body.exceptions.some((x: any) => x.kind === "ai_draft")).toBe(true);

    const scoping = await env.call("ops", "GET", `/api/ops/requests/${requestId}/scoping`);
    expect(scoping.body.advice.structure.recommendation).toBe("free_zone");
    expect(scoping.body.advice.hasUncertain).toBe(true);
    expect(scoping.body.drafts).toHaveLength(1);
    expect((await env.call("finance", "POST", `/api/ops/requests/${requestId}/scoping/approve`, {})).status).toBe(403);
    const approved = await env.call("ops", "POST", `/api/ops/requests/${requestId}/scoping/approve`, { removeRuleKeys: ["obligation.goaml_dnfbp"], removePlaces: ["Meydan Free Zone"], note: "Not a DNFBP" });
    expect(approved.status).toBe(200);
    expect(approved.body.obligations.map((o: any) => o.ruleKey)).not.toContain("obligation.goaml_dnfbp");
    expect(approved.body.places.map((p: any) => p.zone)).not.toContain("Meydan Free Zone");
    const after = (await env.call("client", "GET", "/api/client/home")).body.requests.find((x: any) => x.id === requestId);
    expect(after.adviceStatus).toBe("approved");
    expect(after.advice.structure.recommendation).toBe("free_zone");
    expect(after.advice.obligations.find((o: any) => o.ruleKey === "obligation.vat_mandatory").confidence).toBe("UNCERTAIN");
    expect(JSON.stringify(after.advice)).not.toMatch(/margin|partner/i);
    const ev = await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'scoping.approved'"));
    expect(ev.rows[0].data).toMatchObject({ removedRules: ["obligation.goaml_dnfbp"], uncertainShown: true, note: "Not a DNFBP" });
    // At the database the client role cannot read the advice column at all; approved advice comes through a function.
    const clientUser = (await env.call("client", "GET", "/api/me")).body;
    await expect(asUser(env.db, clientUser, (tx) => tx.query("select advice from requests"))).rejects.toThrow(/permission denied/);
    const viaFn = await asUser(env.db, clientUser, (tx) => tx.query<any>("select app_approved_advice(id) as a from requests where id = $1", [requestId]));
    expect(viaFn.rows[0].a.structure.recommendation).toBe("free_zone");
    // Changing the structure at approval ranks the places again for that structure.
    const r3 = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "not_sure", emirate: "Dubai", visas: 1, activity: "consulting", customers: "both" } });
    const asMainland = await env.call("ops", "POST", `/api/ops/requests/${r3.body.id}/scoping/approve`, { structure: "mainland", note: "Will sell onshore" });
    expect(asMainland.body.structure.recommendation).toBe("mainland");
    expect(asMainland.body.places.length).toBeGreaterThan(0);
    expect(asMainland.body.places.every((p: any) => p.type === "mainland")).toBe(true);
  });

  it("verifying a rule is founder-only, needs a name and a source, and changes recomputed advice", async () => {
    expect((await env.call("ops", "PUT", "/api/admin/scoping/rules/obligation.vat_mandatory", { confidence: "verified", verifiedBy: "X", sourceUrl: "https://tax.gov.ae/" })).status).toBe(403);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.vat_mandatory", { confidence: "verified", verifiedBy: "", sourceUrl: "https://tax.gov.ae/" })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.vat_mandatory", { confidence: "verified", verifiedBy: "A. Qualified, tax agent", sourceUrl: "" })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.vat_mandatory", { confidence: "rule_of_thumb", sourceUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/scoping/rules/obligation.vat_mandatory", { confidence: "verified", verifiedBy: "A. Qualified, tax agent", sourceUrl: "https://tax.gov.ae/en/taxes/vat" })).status).toBe(200);
    const overview = await env.call("ops", "GET", "/api/admin/scoping");
    const rule = overview.body.rules.find((r: any) => r.key === "obligation.vat_mandatory");
    expect(rule).toMatchObject({ confidence: "verified", verifiedBy: "A. Qualified, tax agent" });
    expect(rule.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const recomputed = await env.call("ops", "POST", `/api/ops/requests/${requestId}/scoping/recompute`);
    expect(recomputed.body.obligations.find((o: any) => o.ruleKey === "obligation.vat_mandatory").confidence).toBe("verified");
    // Recomputing puts the advice back under review: the client sees the old approved version no more.
    const pending = (await env.call("client", "GET", "/api/client/home")).body.requests.find((x: any) => x.id === requestId);
    expect(pending.adviceStatus).toBe("pending_review");
    expect(pending.advice).toBeNull();
    expect((await env.call("founder", "PUT", "/api/admin/scoping/zones/IFZA", { confidence: "verified", verifiedBy: "A. Qualified", sourceUrl: "https://ifza.com/", costMinAed: 12900, costMaxAed: 18000 })).status).toBe(200);
    const z = (await env.call("ops", "GET", "/api/admin/scoping")).body.zones.find((x: any) => x.name === "IFZA");
    expect(z).toMatchObject({ confidence: "verified", costMin: 1_290_000 });
    const client = (await env.call("client", "GET", "/api/me")).body;
    await expect(asUser(env.db, client, (tx) => tx.query("select * from scoping_rules"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, client, (tx) => tx.query("select * from ai_drafts"))).rejects.toThrow(/permission denied/);
    expect((await env.call("client", "GET", "/api/admin/scoping")).status).toBe(403);
    expect((await env.call("setup", "GET", `/api/ops/requests/${requestId}/scoping`)).status).toBe(403);
  });

  it("AI drafts change nothing until ops approves one, and never after pricing", async () => {
    const drafts = await env.call("ops", "GET", "/api/ops/drafts");
    const d = drafts.body.find((x: any) => x.requestId === requestId);
    expect(d.model).toBe("memory");
    expect(d.confidence).toBe("UNCERTAIN");
    expect(d.output.lines.map((l: any) => l.code)).toEqual(expect.arrayContaining(["SET-FZ-LIC", "VISA-RES", "BANK-ACC", "VAT-RET"]));
    expect(d.output.lines.find((l: any) => l.code === "VISA-RES").qty).toBe(2);
    const before = (await env.call("ops", "GET", `/api/ops/requests/${requestId}/scoping`)).body.scope.lines;
    expect(before.map((l: any) => l.code)).not.toContain("VAT-RET"); // the deterministic scope did not include it
    expect((await env.call("finance", "POST", `/api/ops/drafts/${d.id}/review`, { decision: "approve" })).status).toBe(403);
    const approved = await env.call("ops", "POST", `/api/ops/drafts/${d.id}/review`, { decision: "approve", note: "Matches the call", keepCodes: ["SET-FZ-LIC", "VISA-RES", "BANK-ACC", "VAT-RET"] });
    expect(approved.status).toBe(200);
    const after = (await env.call("ops", "GET", `/api/ops/requests/${requestId}/scoping`)).body;
    expect(after.scope.lines.map((l: any) => l.code).sort()).toEqual(["BANK-ACC", "SET-FZ-LIC", "VAT-RET", "VISA-RES"]);
    expect(after.notes.join(" ")).not.toMatch(/AI draft|approved by/); // partners and clients read notes
    expect((await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'ai.draft_approved'"))).rows[0].data.appliedBy).toBe("Ops Manager");
    expect((await env.call("ops", "POST", `/api/ops/drafts/${d.id}/review`, { decision: "discard" })).status).toBe(409);
    // After pricing, a new draft cannot change the scope any more.
    const r2 = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1, description: "set up a company and open a bank account" } });
    await env.call("ops", "POST", `/api/ops/requests/${r2.body.id}/build-offers`, { tiers: ["standard"] });
    expect((await env.call("ops", "POST", `/api/ops/drafts/${r2.body.aiDraft}/review`, { decision: "approve" })).status).toBe(409);
    expect((await env.call("ops", "POST", `/api/ops/drafts/${r2.body.aiDraft}/review`, { decision: "discard", note: "priced already" })).status).toBe(200);
    // Once partners have been asked to quote, the scope they quoted cannot change from a draft either.
    const r4 = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1, description: "set up a company and open a bank account" } });
    expect((await env.call("ops", "POST", `/api/ops/requests/${r4.body.id}/rfq`, { codes: ["SET-FZ-LIC"] })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/drafts/${r4.body.aiDraft}/review`, { decision: "approve" })).status).toBe(409);
    await env.call("ops", "POST", `/api/ops/drafts/${r4.body.aiDraft}/review`, { decision: "discard", note: "RFQ out" });
    const actions = await asPlatform(env.db, null, (tx) => tx.query<any>("select action from audit_events where action like 'ai.%' order by id"));
    expect(actions.rows.map((a) => a.action)).toEqual(["ai.draft_created", "ai.draft_approved", "ai.draft_created", "ai.draft_discarded", "ai.draft_created", "ai.draft_discarded"]);
  });

  it("search finds by name and reference for MKW staff only", async () => {
    const r = await env.call("ops", "GET", "/api/ops/search?q=sample");
    expect(r.body.clients.map((c: any) => c.name)).toContain("Sample Trading FZ-LLC");
    const partners = await env.call("finance", "GET", "/api/ops/search?q=tax");
    expect(partners.body.partners.map((p: any) => p.name)).toContain("Example Tax & Accounts LLC");
    const offers = await env.call("ops", "GET", "/api/ops/search?q=sample");
    expect(offers.body.offers.length).toBeGreaterThan(0);
    const byRef = await env.call("ops", "GET", `/api/ops/search?q=${offers.body.offers[0].id.slice(0, 8)}`);
    expect(byRef.body.offers.map((o: any) => o.id)).toContain(offers.body.offers[0].id);
    expect((await env.call("client", "GET", "/api/ops/search?q=sample")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/ops/search?q=sample")).status).toBe(403);
    expect((await env.call("ops", "GET", "/api/ops/search?q=x")).body.clients).toEqual([]);
    expect((await env.call("ops", "GET", "/api/ops/search?q=%25%25")).body.clients).toEqual([]); // wildcards are literal
  });
});

describe("public intake", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });
  const lead = (extra: Record<string, unknown> = {}) => ({
    company: "New Founder Ventures",
    name: "Nadia Founder",
    email: "nadia@new-founder.test",
    consent: true,
    campaign: "oct-launch",
    referrer: "https://tasees.ae/",
    answers: { mode: "new_company", jurisdiction: "not_sure", emirate: "Dubai", visas: 1, activity: "consulting", customers: "international", budgetAed: 15000 },
    ...extra,
  });

  it("refuses without consent, swallows bots, and creates the company, owner, consent record, request and AI draft", async () => {
    expect((await env.call("anon", "POST", "/api/public/intake", lead({ consent: false }))).status).toBe(400);
    const bot = await env.call("anon", "POST", "/api/public/intake", lead({ website: "http://spam.example" }));
    expect(bot.status).toBe(200);
    expect(bot.body).toEqual({ ok: true });
    expect((await asPlatform(env.db, null, (tx) => tx.query("select 1 from users where email = 'nadia@new-founder.test'"))).rows).toEqual([]);
    const ok = await env.call("anon", "POST", "/api/public/intake", lead({ answers: { ...lead().answers, description: "consulting company, one visa, bank account" } }));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true }); // the body never says whether the email was known
    const user = (await asPlatform(env.db, null, (tx) => tx.query<any>("select u.*, o.name as org from users u join orgs o on o.id = u.org_id where email = 'nadia@new-founder.test'"))).rows[0];
    expect(user).toMatchObject({ role: "client_owner", status: "active", org: "New Founder Ventures" });
    expect(user.consent).toMatchObject({ given: true, version: "2026-10-privacy-v1", channel: "public_intake" });
    expect(user.consent.at).toMatch(/^\d{4}-/);
    const req = (await asPlatform(env.db, null, (tx) => tx.query<any>("select id, advice_status, source from requests where created_by = $1", [user.id]))).rows[0];
    expect(req.advice_status).toBe("pending_review");
    expect(req.source).toMatchObject({ channel: "public_intake", campaign: "oct-launch" });
    expect((await asPlatform(env.db, null, (tx) => tx.query("select 1 from ai_drafts where request_id = $1 and status = 'pending'", [req.id]))).rows).toHaveLength(1);
    const email = env.emails.find((e) => e.to === "nadia@new-founder.test")!;
    expect(email.subject).toBe("We have your request");
    expect(email.fromName).toBe("Tasees, by MKW Advisors");
    expect(email.text).toContain("An account has been created");
    const code = await env.call("anon", "POST", "/api/auth/request-code", { email: "nadia@new-founder.test" });
    expect(code.body.devCode).toMatch(/^\d{6}$/);
  });

  it("holds a lead for an email that already has an account: nothing written as that person, consent untouched, neutral email", async () => {
    const before = (await asPlatform(env.db, null, (tx) => tx.query<any>("select consent from users where email = 'nadia@new-founder.test'"))).rows[0].consent;
    env.clock.now = new Date(env.clock.now.getTime() + 60_000);
    const again = await env.call("anon", "POST", "/api/public/intake", lead({ company: "Attacker Co", name: "Mallory", answers: { ...lead().answers, description: "CLICK http://evil.example to pay" } }));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });
    const db = env.db;
    expect((await asPlatform(db, null, (tx) => tx.query("select 1 from orgs where name in ('New Founder Ventures', 'Attacker Co')"))).rows).toHaveLength(1);
    expect((await asPlatform(db, null, (tx) => tx.query("select 1 from requests r join users u on u.id = r.created_by where u.email = 'nadia@new-founder.test'"))).rows).toHaveLength(1);
    expect((await asPlatform(db, null, (tx) => tx.query<any>("select consent from users where email = 'nadia@new-founder.test'"))).rows[0].consent).toEqual(before);
    const held = (await asPlatform(db, null, (tx) => tx.query<any>("select * from intake_leads"))).rows;
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ email: "nadia@new-founder.test", company: "Attacker Co", status: "held" });
    const mails = env.emails.filter((e) => e.to === "nadia@new-founder.test" && !/sign-in code/.test(e.subject));
    expect(mails.map((m) => m.subject)).toEqual(["We have your request", "Continue with your request"]);
    expect(mails[1]!.text).not.toMatch(/Attacker|evil|Mallory/);
    expect((await asPlatform(db, null, (tx) => tx.query<any>("select actor_user_id from audit_events where action = 'intake.lead_held'"))).rows[0].actor_user_id).toBeNull();
    // Ops sees it in the queue and closes it; clients and partners never see leads.
    const queue = await env.call("ops", "GET", "/api/ops/overview");
    expect(queue.body.exceptions.some((x: any) => x.kind === "lead" && x.ref === held[0].id)).toBe(true);
    expect((await env.call("client", "GET", "/api/ops/leads")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/ops/leads")).status).toBe(403);
    expect((await env.call("ops", "GET", "/api/ops/leads")).body[0].company).toBe("Attacker Co");
    expect((await env.call("ops", "POST", `/api/ops/leads/${held[0].id}/handle`, { note: "Called; duplicate" })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/leads/${held[0].id}/handle`, { note: "again" })).status).toBe(409);
    // A partner's or staff email gets exactly the same answer and creates nothing but a held lead.
    const partner = await env.call("anon", "POST", "/api/public/intake", lead({ email: EMAILS.setup }));
    expect(partner.body).toEqual({ ok: true });
    expect((await asPlatform(db, null, (tx) => tx.query<any>("select count(*)::int as n from intake_leads where email = $1", [EMAILS.setup]))).rows[0].n).toBe(1);
    expect((await asPlatform(db, null, (tx) => tx.query<any>("select count(*)::int as n from audit_events where action = 'intake.consent_recorded'"))).rows[0].n).toBe(1);
  });

  it("honours X-Forwarded-For only when a proxy is trusted", async () => {
    const spoof = async (app: TestEnv["app"], i: number) =>
      app.inject({ method: "POST", url: "/api/public/intake", headers: { "x-forwarded-for": `203.0.113.${i}` }, payload: lead({ email: `xff${i}@many.test`, company: `XFF ${i}` }) });
    let limited = 0;
    for (let i = 0; i < 12; i++) if ((await spoof(env.app, i)).statusCode === 429) limited += 1;
    expect(limited).toBeGreaterThan(0); // spoofed addresses share one bucket when no proxy is trusted
    const trusting = await makeEnv(undefined, { trustProxy: "127.0.0.1" }); // the address inject() comes from
    try {
      let limited2 = 0;
      for (let i = 0; i < 12; i++) if ((await spoof(trusting.app, i)).statusCode === 429) limited2 += 1;
      expect(limited2).toBe(0); // behind a trusted proxy each visitor is their own address
    } finally {
      await trusting.db.close();
    }
  });

  it("is rate-limited per IP", async () => {
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await env.call("anon", "POST", "/api/public/intake", lead({ email: `lead${i}@many.test`, company: `Many ${i}` }));
      if (r.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

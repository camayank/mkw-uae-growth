import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E4 over HTTP: a saved assessment holds no contact details and is recovered by its code; a review request becomes
 * one lead with its consents, source and scores, routed to an owner; the pipeline is internal and audited; nothing
 * is sent to a lead; analytics follow a source to accepted revenue; retention anonymises only once confirmed.
 */
const count = async (env: TestEnv, table: string, where = "true"): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`))).rows[0]!.n;
const answers = { emirate: "Dubai", activity: "tech", customers: "international", visas: 2, budgetAed: 30_000, premises: "office", ownerType: "individuals", foreignTaxResident: false };
const attribution = { source: "google", medium: "cpc", campaign: "nov-launch", referrer: "https://google.test/", landing: "/selector.html?utm_source=google&code=ABCDE23456" };

describe("lead intelligence", () => {
  let env: TestEnv;
  let code: string;
  let leadId: string;
  let opsId: string;
  beforeAll(async () => {
    env = await makeEnv();
    opsId = (await env.call("ops", "GET", "/api/me")).body.id;
  });
  afterAll(() => env.db.close());

  const review = (body: Record<string, unknown>) =>
    env.call("anon", "POST", "/api/public/intake", { company: "Saved Ventures", name: "A. Founder", email: "saved-founder@example.test", consent: true, consentVersion: "2026-11-selector-v1", answers: { mode: "new_company", jurisdiction: "not_sure", ...answers }, attribution, ...body });

  it("saving an assessment stores the answers and attribution only, and the code recovers it on today's rules", async () => {
    const r = await env.call("anon", "POST", "/api/public/assessments", { answers, attribution: { ...attribution, password: "no", email: "no@no.test" } });
    expect(r.status).toBe(200);
    code = r.body.code;
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    const [row] = (await asPlatform(env.db, null, (tx) => tx.query("select code_hash, answers, source, summary, status from assessments"))).rows as any[];
    expect(row.code_hash).not.toBe(code);
    expect(JSON.stringify(row)).not.toMatch(/no@no\.test|password|A\. Founder/);
    expect(row.source).toEqual({ source: "google", medium: "cpc", campaign: "nov-launch", term: null, content: null, referrer: "https://google.test/", landing: "/selector.html?utm_source=google" }); // the code is stripped
    expect(row.summary).toMatchObject({ recommendation: null, confirmed: false }); // nothing approved: the structure is withheld
    const back = (await env.call("anon", "GET", `/api/public/assessments/${code.toLowerCase()}`)).body;
    expect(back).toMatchObject({ found: true, recovered: 1, answers: { activity: "tech", visas: 2 } });
    expect(back.result.disclaimer).toMatch(/preliminary/);
    expect((await env.call("anon", "GET", "/api/public/assessments/ZZZZZZZZZZ")).body).toEqual({ found: false });
    expect((await env.call("anon", "GET", "/api/public/assessments/nope")).body).toEqual({ found: false });
  });

  it("a review request creates one lead with its consents (nothing pre-ticked), source, session and scores, and sends only the intake email", async () => {
    const emails = env.emails.length;
    const outbox = await count(env, "outbox");
    const r = await review({ assessmentCode: code, phone: "+971 50 000 0000", consultation: { wanted: true, times: "weekday mornings" } });
    expect(JSON.stringify((await asPlatform(env.db, null, (tx) => tx.query("select * from consents"))).rows)).not.toMatch(/"ip"/);
    expect(r.status).toBe(200);
    const leads = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body;
    expect(leads).toHaveLength(1);
    const l = leads[0];
    leadId = l.id;
    expect(l).toMatchObject({ company: "Saved Ventures", segment: "starter", status: "new", owner: null, phoneGiven: true, highIntent: true, consents: { service: true, marketing: false, partner_disclosure: false } });
    expect(l.intent).toBeGreaterThanOrEqual(60);
    expect(l.source).toMatchObject({ source: "google", campaign: "nov-launch", landing: "/selector.html?utm_source=google" });
    expect(JSON.stringify((await asPlatform(env.db, null, (tx) => tx.query("select data from audit_events where action = 'lead.created'"))).rows)).not.toContain("ABCDE23456");
    expect(l.consultation.times).toBe("weekday mornings");
    expect(l.clientOrgId).toBeTruthy();
    expect(l.requestId).toBeTruthy();
    expect((await asPlatform(env.db, null, (tx) => tx.query("select status from assessments"))).rows[0]).toEqual({ status: "lead" });
    const detail = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${leadId}`)).body;
    expect(detail.consentHistory.map((c: any) => [c.purpose, c.given, c.version])).toEqual([["service", true, "2026-11-selector-v1"], ["marketing", false, "2026-11-marketing-v1"], ["partner_disclosure", false, "2026-11-partner-v1"]]);
    // The request's source carries the attribution; the only email is the intake acknowledgement the client gets.
    const [req] = (await asPlatform(env.db, null, (tx) => tx.query("select source from requests order by created_at desc limit 1"))).rows as any[];
    expect(req.source.attribution).toMatchObject({ source: "google", medium: "cpc" });
    expect(env.emails.length - emails).toBe(1);
    expect(env.emails[env.emails.length - 1]!.to).toBe("saved-founder@example.test");
    expect(await count(env, "outbox")).toBe(outbox + 1); // exactly the intake acknowledgement, nothing for the lead
    // The ops queue shows the call request; partners and clients cannot see the pipeline.
    const q = (await env.call("ops", "GET", "/api/ops/queue")).body;
    expect(q.items.some((x: any) => x.kind === "consultation" && /Saved Ventures/.test(x.detail))).toBe(true);
    expect((await env.call("setup", "GET", "/api/ops/pipeline/leads")).status).toBe(403);
    expect((await env.call("client", "GET", "/api/ops/pipeline/leads")).status).toBe(403);
    expect((await env.call("finance", "GET", "/api/ops/pipeline/leads")).status).toBe(403);
    // What the engine makes of contradictory answers reaches the complexity score.
    const odd = await env.call("anon", "POST", "/api/public/intake", { company: "Odd Answers Co", name: "O. Founder", email: "odd@example.test", consent: true, consentVersion: "2026-10-privacy-v1", answers: { mode: "new_company", emirate: "Dubai", jurisdiction: "offshore", activity: "trading", customers: "uae_mainland", visas: 5, premises: "retail" } });
    expect(odd.status).toBe(200);
    const [ev] = (await asPlatform(env.db, null, (tx) => tx.query("select data from audit_events where action = 'lead.created' order by id desc limit 1"))).rows as any[];
    expect(ev.data.factors).toContain("contradictory answers");
    // An email that already has an account: one queue item for the enquiry, not two.
    const dup = await env.call("anon", "POST", "/api/public/intake", { company: "Dup Co", name: "D. Founder", email: "odd@example.test", consent: true, consentVersion: "2026-10-privacy-v1", answers: { mode: "new_company", emirate: "Dubai", jurisdiction: "not_sure", activity: "tech", customers: "international", visas: 1 }, consultation: { wanted: true } });
    expect(dup.status).toBe(200);
    const qi = (await env.call("ops", "GET", "/api/ops/queue")).body.items.filter((x: any) => /Dup Co/.test(x.detail));
    expect(qi.map((x: any) => x.kind)).toEqual(["lead"]);
    expect((await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Dup Co").intakeLeadId).toBeTruthy();
  });

  it("first touch wins: a lead that comes back by its saved code keeps the saved campaign on the lead and the request", async () => {
    const { code: c } = (await env.call("anon", "POST", "/api/public/assessments", { answers, attribution: { source: "newsletter", campaign: "oct-issue" } })).body;
    const r = await env.call("anon", "POST", "/api/public/intake", { company: "Returning Co", name: "R. Founder", email: "returning@example.test", consent: true, consentVersion: "2026-10-privacy-v1", answers: { mode: "new_company", jurisdiction: "not_sure", ...answers }, assessmentCode: c, attribution: { referrer: "https://direct.test/" } });
    expect(r.status).toBe(200);
    const lead = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Returning Co");
    expect(lead.source).toMatchObject({ source: "newsletter", campaign: "oct-issue", referrer: "https://direct.test/" });
    const [req] = (await asPlatform(env.db, null, (tx) => tx.query("select source from requests where id = $1", [lead.requestId]))).rows as any[];
    expect(req.source.attribution).toMatchObject({ source: "newsletter", campaign: "oct-issue" });
    expect(req.source.campaign).toBe("oct-issue");
  });

  it("routing sends a segment's leads to its owner; unmapped segments stay with ops", async () => {
    expect((await env.call("ops", "PUT", "/api/admin/settings/lead-routing", { routing: { starter: opsId } })).status).toBe(403);
    expect((await env.call("founder", "PUT", "/api/admin/settings/lead-routing", { routing: { starter: (await env.call("client", "GET", "/api/me")).body.id } })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/settings/lead-routing", { routing: { starter: opsId } })).status).toBe(200);
    const r = await env.call("anon", "POST", "/api/public/intake", { company: "Routed Co", name: "B. Founder", email: "routed@example.test", consent: true, consentVersion: "2026-10-privacy-v1", answers: { mode: "new_company", jurisdiction: "not_sure", ...answers }, marketingConsent: true });
    expect(r.status).toBe(200);
    const mine = (await env.call("ops", "GET", "/api/ops/pipeline/leads?owner=me")).body;
    expect(mine.map((l: any) => [l.company, l.status, l.consents.marketing])).toEqual([["Routed Co", "routed", true]]);
    const complexLead = await env.call("anon", "POST", "/api/public/intake", { company: "Complex Co", name: "C. Founder", email: "complex@example.test", consent: true, consentVersion: "2026-10-privacy-v1", answers: { mode: "new_company", jurisdiction: "not_sure", ...answers, activity: "finance" } });
    expect(complexLead.status).toBe(200);
    const all = (await env.call("ops", "GET", "/api/ops/pipeline/leads?segment=regulated")).body;
    expect(all.map((l: any) => [l.company, l.status, l.owner])).toEqual([["Complex Co", "new", null]]);
  });

  it("the pipeline: assign, status, notes, a follow-up that reaches the queue when due, a consent withdrawal; all audited, nothing sent", async () => {
    const emails = env.emails.length;
    const outbox = await count(env, "outbox");
    expect((await env.call("ops", "POST", "/api/ops/pipeline/leads/not-a-uuid/note", { body: "x" })).status).toBe(400);
    expect((await env.call("ops", "POST", "/api/ops/pipeline/followups/abc/done", {})).status).toBe(400);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/assign`, { ownerUserId: opsId, note: "mine" })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/status`, { status: "contacted", note: "called, left a message" })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/note`, { body: "Wants DIFC compared with IFZA" })).status).toBe(200);
    const due = new Date(env.clock.now.getTime() + 2 * 86_400_000).toISOString();
    const f = await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/followup`, { dueAt: due, body: "Call back about the budget" });
    expect(f.status).toBe(200);
    expect((await env.call("ops", "GET", "/api/ops/queue")).body.items.some((x: any) => x.kind === "lead_followup")).toBe(false);
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 3 * 86_400_000);
    try {
      const item = (await env.call("ops", "GET", "/api/ops/queue")).body.items.find((x: any) => x.kind === "lead_followup");
      expect(item).toBeTruthy();
      expect(item.detail).toMatch(/Follow-up due: Saved Ventures \(Call back about the budget\)/);
      expect(item.link).toBe(`#/leads/${leadId}`);
      expect((await env.call("ops", "POST", `/api/ops/pipeline/followups/${f.body.id}/done`, { note: "done" })).status).toBe(200);
      expect((await env.call("ops", "POST", `/api/ops/pipeline/followups/${f.body.id}/done`, {})).status).toBe(409);
    } finally {
      env.clock.now = saved;
    }
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/consent-withdraw`, { purpose: "marketing", note: "asked by email on 3 Nov" })).status).toBe(200);
    const detail = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${leadId}`)).body;
    expect(detail).toMatchObject({ status: "contacted", owner: expect.any(String), consents: { marketing: false } });
    expect(detail.consentHistory.filter((c: any) => c.purpose === "marketing").map((c: any) => [c.given, c.channel])).toEqual([[false, "public_intake"], [false, "ops"]]);
    expect(detail.notes.map((n: any) => n.kind)).toEqual(expect.arrayContaining(["assigned", "status", "note", "followup", "followup_done"]));
    // A submitted form is not a client: converted needs an accepted offer on the lead's request.
    const early = await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/status`, { status: "converted" });
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/accepted/);
    const events = (await asPlatform(env.db, null, (tx) => tx.query("select action, data from audit_events where entity = 'lead' and entity_id = $1 order by id", [leadId]))).rows as any[];
    expect(events.map((x) => x.action)).toEqual(expect.arrayContaining(["lead.created", "lead.assigned", "lead.status", "lead.note", "lead.followup_set", "lead.followup_done", "lead.consent_withdrawn"]));
    // Free text a person typed stays in lead_notes (which erasure reaches), never in the audit trail.
    expect(JSON.stringify(events)).not.toMatch(/called, left a message|Wants DIFC|Call back about the budget|asked by email/);
    expect(env.emails.length).toBe(emails);
    expect(await count(env, "outbox")).toBe(outbox);
    // Consents cannot be edited or deleted, by anyone.
    await expect(asPlatform(env.db, null, (tx) => tx.query("delete from consents"))).rejects.toThrow(/append-only|permission denied/);
    await expect(env.db.transaction((tx) => tx.query("update consents set given = true"))).rejects.toThrow(/append-only/);
  });

  it("analytics follow a source from saved assessments to accepted revenue, without margin", async () => {
    // Price and accept the first lead's request so the source has revenue.
    const l = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${leadId}`)).body;
    const offer = (await env.call("ops", "POST", `/api/ops/requests/${l.requestId}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    expect((await env.call("ops", "POST", `/api/ops/requests/${l.requestId}/scoping/approve`, { structure: "free_zone" })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/offers/${offer}/publish`)).status).toBe(200);
    const token = (await asPlatform(env.db, null, (tx) => tx.query("select id from users where email = 'saved-founder@example.test'"))).rows[0] as any;
    expect(token).toBeTruthy();
    await asPlatform(env.db, null, (tx) => tx.query("update offers set status = 'accepted' where id = $1", [offer]));
    // Now the lead can be marked converted, and it stays converted.
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/status`, { status: "converted" })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${leadId}/status`, { status: "closed" })).status).toBe(409);
    const a = (await env.call("ops", "GET", "/api/ops/pipeline/leads/analytics")).body;
    const google = a.find((x: any) => x.source === "google" && x.campaign === "nov-launch");
    expect(google).toMatchObject({ assessments: 1, leads: 1, requests: 1, offersPublished: 1, offersAccepted: 1 });
    expect(google.revenueFils).toBeGreaterThan(0);
    expect(a.find((x: any) => x.source === "direct")).toMatchObject({ leads: 4 });
    expect(a.find((x: any) => x.source === "newsletter")).toMatchObject({ assessments: 1, leads: 1, requests: 1 });
    expect(JSON.stringify(a)).not.toMatch(/margin|partner|payout/i);
    expect((await env.call("finance", "GET", "/api/ops/pipeline/leads/analytics")).status).toBe(403);
  });

  it("export includes a person's leads and consents; erasure tombstones them and keeps the counts", async () => {
    const user = (await asPlatform(env.db, null, (tx) => tx.query("select id from users where email = 'routed@example.test'"))).rows[0] as any;
    const exported = (await env.call("founder", "POST", `/api/admin/users/${user.id}/export`)).body;
    expect(exported.leads).toHaveLength(1);
    expect(exported.consents.map((c: any) => c.purpose)).toEqual(["service", "marketing", "partner_disclosure"]);
    expect(exported.leadNotes.length).toBeGreaterThanOrEqual(1); // the routing note
    expect(exported.assessments).toEqual([]); // this lead was not saved first
    const erased = await env.call("founder", "POST", `/api/admin/users/${user.id}/erase`, { confirm: "ERASE" });
    expect(erased.status).toBe(200);
    expect(erased.body.leadRecordsTombstoned).toBe(1);
    const [row] = (await asPlatform(env.db, null, (tx) => tx.query("select email, name, company, answers from leads where company = 'Erased person'"))).rows as any[];
    expect(row).toMatchObject({ name: "Erased person", answers: {} });
    expect(row.email).toMatch(/^erased-/);
    expect(await count(env, "consents", "subject_kind = 'lead'")).toBeGreaterThanOrEqual(10); // the history stays
    // Erasing the person who saved an assessment first wipes the saved answers too.
    const saver = (await asPlatform(env.db, null, (tx) => tx.query("select id from users where email = 'saved-founder@example.test'"))).rows[0] as any;
    expect((await env.call("founder", "POST", `/api/admin/users/${saver.id}/erase`, { confirm: "ERASE" })).status).toBe(200);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select answers, status from assessments where code_hash like 'anonymised-%'"))).rows).toEqual([{ answers: {}, status: "anonymised" }]);
  });

  it("retention anonymises old leads and sessions only once the founder has confirmed the periods, and is idempotent", async () => {
    const old = new Date(env.clock.now.getTime() - 400 * 86_400_000);
    // A form-only lead (it has a client organisation and a request, but no accepted offer) is old enough to go; the
    // converted lead with an accepted offer is not, however old.
    await asPlatform(env.db, null, async (tx) => {
      await tx.query("update leads set created_at = $1 where company in ('Complex Co', 'Saved Ventures', 'Dup Co')", [old.toISOString()]);
      await tx.query("insert into assessments (code_hash, answers, created_at) values ('old-hash', '{\"activity\":\"tech\"}'::jsonb, $1)", [old.toISOString()]);
    });
    const jobs = async () => (await env.call("founder", "POST", "/api/ops/jobs/run")).body;
    const dry = await jobs();
    expect(dry.leadsAnonymised).toBe(0); // counted only: the periods are not confirmed
    expect((await asPlatform(env.db, null, (tx) => tx.query("select status from leads where company = 'Complex Co'"))).rows[0]).toEqual({ status: "new" });
    expect((await env.call("founder", "PUT", "/api/admin/settings/retention", { note: "Confirmed with counsel on 2 Nov 2026" })).status).toBe(200);
    const run = await jobs();
    expect(run.leadsAnonymised).toBe(2); // Complex Co and the held enquiry Dup Co
    // The held intake copy of the anonymised enquiry is anonymised too, and leaves the ops queue.
    const [held] = (await asPlatform(env.db, null, (tx) => tx.query("select email, company, answers, status from intake_leads where company = 'Anonymised'"))).rows as any[];
    expect(held).toMatchObject({ company: "Anonymised", answers: {}, status: "handled" });
    expect(held.email).toMatch(/^anonymised-/);
    expect((await env.call("ops", "GET", "/api/ops/queue")).body.items.some((x: any) => x.kind === "lead" && /Dup Co/.test(x.detail))).toBe(false);
    // The converted lead was erased earlier in this file (so it reads "Erased person"), but it is kept, not anonymised.
    const rows = (await asPlatform(env.db, null, (tx) => tx.query("select company, status, email, answers from leads where status = 'anonymised' or id = $1 order by company", [leadId]))).rows as any[];
    expect(rows.map((x) => [x.company, x.status])).toEqual([["Anonymised", "anonymised"], ["Anonymised", "anonymised"], ["Erased person", "converted"]]);
    expect(rows[0].answers).toEqual({});
    expect(rows[0].email).toMatch(/^anonymised-/);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select status, answers from assessments where code_hash like 'anonymised-%' or code_hash = 'old-hash'"))).rows.every((x: any) => x.status === "anonymised" && Object.keys(x.answers).length === 0)).toBe(true);
    expect((await jobs()).leadsAnonymised).toBe(0);
    // Counts for analytics survive anonymisation.
    expect((await env.call("ops", "GET", "/api/ops/pipeline/leads/analytics")).body.find((x: any) => x.source === "direct").leads).toBe(4);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/lib/auth.ts";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/** O6: partner onboarding with document gates, licence watch, scorecards, staff; delivery extras on the client side. */

const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
const day = 24 * 3600 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("partner onboarding", () => {
  let env: TestEnv;
  let orgId: string;
  const adminEmail = "admin@new-firm.test";
  beforeAll(async () => {
    env = await makeEnv();
    const created = await env.call("ops", "POST", "/api/admin/partners", { name: "New Firm Consultancy LLC", adminName: "Nour Admin", adminEmail });
    orgId = created.body.orgId;
    env.tokens.newp = await createSession(env.db, adminEmail);
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("moves prospect → applied on the firm's application and refuses an expired licence", async () => {
    const expired = await env.call("newp", "PUT", "/api/partner/application", { emirates: ["Dubai"], codes: ["SET-FZ-LIC", "VISA-RES"], capacity: 5, licenceNumber: "DED-123", licenceExpiry: "2026-01-01" });
    expect(expired.status).toBe(400);
    const ok = await env.call("newp", "PUT", "/api/partner/application", { emirates: ["Dubai"], codes: ["SET-FZ-LIC", "VISA-RES"], capacity: 5, licenceNumber: "DED-123", licenceExpiry: iso(new Date(env.clock.now.getTime() + 40 * day)), about: "Setup specialists" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("applied");
    expect((await env.call("setupStaff", "PUT", "/api/partner/application", { emirates: ["Dubai"], codes: ["SET-FZ-LIC"], capacity: 1, licenceNumber: "x", licenceExpiry: "2030-01-01" })).status).toBe(403);
    const queue = await env.call("ops", "GET", "/api/ops/overview");
    expect(queue.body.exceptions.some((x: any) => x.kind === "partner_review" && x.ref === orgId)).toBe(true);
  });

  it("gates pilot on a verified unexpired licence and signed on the agreement and insurance", async () => {
    expect((await env.call("ops", "POST", `/api/ops/partners/${orgId}/status`, { status: "under_review", note: "Application looks complete" })).status).toBe(200);
    const noLicence = await env.call("ops", "POST", `/api/ops/partners/${orgId}/status`, { status: "pilot", note: "go" });
    expect(noLicence.status).toBe(409);
    // A trade licence needs its expiry; another firm cannot upload for this one; staff cannot either.
    expect((await env.call("newp", "POST", `/api/partners/${orgId}/documents`, { kind: "trade_licence", fileName: "licence.pdf", contentBase64: pdf })).status).toBe(400);
    expect((await env.call("setup", "POST", `/api/partners/${orgId}/documents`, { kind: "trade_licence", fileName: "licence.pdf", contentBase64: pdf, expiresOn: "2027-06-30" })).status).toBe(403);
    const expiry = iso(new Date(env.clock.now.getTime() + 40 * day));
    const lic = await env.call("newp", "POST", `/api/partners/${orgId}/documents`, { kind: "trade_licence", fileName: "licence.pdf", contentBase64: pdf, reference: "DED-123", expiresOn: expiry });
    expect(lic.status).toBe(200);
    // Still not verified: pilot refused.
    expect((await env.call("ops", "POST", `/api/ops/partners/${orgId}/status`, { status: "pilot", note: "go" })).status).toBe(409);
    expect((await env.call("finance", "POST", `/api/ops/partner-documents/${lic.body.id}/review`, { decision: "verified" })).status).toBe(403);
    expect((await env.call("ops", "POST", `/api/ops/partner-documents/${lic.body.id}/review`, { decision: "rejected", note: "" })).status).toBe(400);
    const verified = await env.call("ops", "POST", `/api/ops/partner-documents/${lic.body.id}/review`, { decision: "verified", note: "Matches the DED portal" });
    expect(verified.status).toBe(200);
    expect(verified.body.effects).toMatchObject({ licenceActive: true, licenceExpiry: expiry });
    const pilot = await env.call("ops", "POST", `/api/ops/partners/${orgId}/status`, { status: "pilot", note: "Two pilot jobs first" });
    expect(pilot.status).toBe(200);
    const mail = env.emails.filter((e) => e.to === adminEmail).at(-1)!;
    expect(mail.subject).toContain("pilot");
    expect(mail.fromName).toBe("MKW Advisors");
    expect(`${mail.subject} ${mail.text}`).not.toMatch(/Tasees/);
    // Signed needs the agreement and insurance, verified.
    expect((await env.call("ops", "POST", `/api/ops/partners/${orgId}/status`, { status: "signed", note: "x" })).status).toBe(409);
    const agr = await env.call("newp", "POST", `/api/partners/${orgId}/documents`, { kind: "agreement", fileName: "pna-signed.pdf", contentBase64: pdf });
    const ins = await env.call("newp", "POST", `/api/partners/${orgId}/documents`, { kind: "insurance", fileName: "pi.pdf", contentBase64: pdf, expiresOn: "2027-12-31" });
    await env.call("ops", "POST", `/api/ops/partner-documents/${agr.body.id}/review`, { decision: "verified" });
    expect((await env.call("ops", "POST", `/api/ops/partners/${orgId}/status`, { status: "signed", note: "x" })).status).toBe(409);
    await env.call("ops", "POST", `/api/ops/partner-documents/${ins.body.id}/review`, { decision: "verified" });
    const signed = await env.call("ops", "POST", `/api/ops/partners/${orgId}/status`, { status: "signed", note: "Agreement countersigned 17 Oct" });
    expect(signed.status).toBe(200);
    const view = await env.call("newp", "GET", `/api/partners/${orgId}/onboarding`);
    expect(view.body.profile).toMatchObject({ status: "signed", agreementSigned: true, licenceActive: true });
    expect(view.body.profile.conflicts).toBeUndefined();
    expect(view.body.documents.filter((d: any) => d.status === "verified")).toHaveLength(3);
    // Another firm's documents and onboarding are invisible; clients too.
    expect((await env.call("setup", "GET", `/api/partners/${orgId}/onboarding`)).status).toBe(403);
    expect((await env.call("setup", "GET", `/api/partner-documents/${lic.body.id}/file`)).status).toBe(404);
    expect((await env.call("client", "GET", `/api/partners/${orgId}/onboarding`)).status).toBe(403);
    await expect(asUser(env.db, (await env.call("setup", "GET", "/api/me")).body, (tx) => tx.query("select * from partner_documents"))).rejects.toThrow(/permission denied/);
    const file = await env.app.inject({ method: "GET", url: `/api/partner-documents/${lic.body.id}/file`, headers: { authorization: `Bearer ${env.tokens.newp}` } });
    expect(file.statusCode).toBe(200);
    expect(file.body.startsWith("%PDF")).toBe(true);
    const audit = await asPlatform(env.db, null, (tx) => tx.query<any>("select action from audit_events where entity_id = $1 and action like 'partner.%' order by id", [orgId]));
    expect(audit.rows.map((a) => a.action)).toEqual(expect.arrayContaining(["partner.created", "partner.applied", "partner.status_changed"]));
  });

  it("warns 30 days before the licence expires and pauses the firm on expiry; a new verified licence lifts the pause", async () => {
    env.clock.now = new Date(env.clock.now.getTime() + 12 * day); // 28 days left
    let jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.licences).toBe(1);
    const warn = env.emails.filter((e) => /expires on/.test(e.subject));
    expect(warn.some((e) => e.to === adminEmail)).toBe(true);
    expect(warn.some((e) => e.to === EMAILS.ops)).toBe(true);
    jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.licences).toBe(0); // warned once
    env.clock.now = new Date(env.clock.now.getTime() + 30 * day);
    jobs = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(jobs.body.licences).toBe(1);
    let view = await env.call("newp", "GET", `/api/partners/${orgId}/onboarding`);
    expect(view.body.profile).toMatchObject({ status: "paused", licenceActive: false, pausedFrom: "signed" });
    expect(env.emails.some((e) => e.to === adminEmail && /expired/.test(e.subject))).toBe(true);
    // The paused firm receives no work: eligibility fails at the engine.
    const partners = (await env.call("ops", "GET", "/api/ops/overview")).body.partners;
    expect(partners.find((p: any) => p.id === orgId).profile.status).toBe("paused");
    const renewed = await env.call("newp", "POST", `/api/partners/${orgId}/documents`, { kind: "trade_licence", fileName: "licence-2027.pdf", contentBase64: pdf, expiresOn: iso(new Date(env.clock.now.getTime() + 365 * day)) });
    await env.call("ops", "POST", `/api/ops/partner-documents/${renewed.body.id}/review`, { decision: "verified", note: "Renewed" });
    view = await env.call("newp", "GET", `/api/partners/${orgId}/onboarding`);
    expect(view.body.profile).toMatchObject({ status: "signed", licenceActive: true });
    expect(view.body.documents.filter((d: any) => d.kind === "trade_licence" && d.status === "verified")).toHaveLength(1);
  });

  it("lets the admin add and remove its own staff only", async () => {
    const invited = await env.call("newp", "POST", "/api/partner/staff", { email: "staff@new-firm.test", name: "Sami Staff" });
    expect(invited.status).toBe(200);
    expect(env.emails.find((e) => e.to === "staff@new-firm.test")!.fromName).toBe("MKW Advisors");
    expect((await env.call("newp", "POST", "/api/partner/staff", { email: EMAILS.client, name: "Taken Person" })).status).toBe(409);
    expect((await env.call("setupStaff", "POST", "/api/partner/staff", { email: "x@y.test", name: "xx" })).status).toBe(403);
    const otherStaff = (await env.call("setupStaff", "GET", "/api/me")).body.id;
    expect((await env.call("newp", "POST", `/api/partner/staff/${otherStaff}/active`, { active: false })).status).toBe(404);
    expect((await env.call("newp", "POST", `/api/partner/staff/${invited.body.id}/active`, { active: false })).status).toBe(200);
    const me = (await env.call("newp", "GET", "/api/me")).body.id;
    expect((await env.call("newp", "POST", `/api/partner/staff/${me}/active`, { active: false })).status).toBe(403);
    const view = await env.call("newp", "GET", `/api/partners/${orgId}/onboarding`);
    expect(view.body.staff.find((s: any) => s.email === "staff@new-firm.test").status).toBe("deactivated");
  });

  it("computes scorecards weekly and shows each partner only its own", async () => {
    const r = await env.call("ops", "POST", "/api/ops/scorecards/recompute");
    expect(r.body.partners).toBeGreaterThanOrEqual(4);
    const mine = await env.call("newp", "GET", `/api/partners/${orgId}/scorecards`);
    expect(mine.body[0]).toMatchObject({ score: 60, provisional: true });
    const setupOrg = (await env.call("setup", "GET", "/api/me")).body.orgId;
    expect((await env.call("newp", "GET", `/api/partners/${setupOrg}/scorecards`)).status).toBe(403);
    expect((await env.call("client", "GET", `/api/partners/${setupOrg}/scorecards`)).status).toBe(403);
    const home = await env.call("newp", "GET", "/api/partner/home");
    expect(home.body.firm).toMatchObject({ status: "signed", latestScore: 60 });
    expect(home.body.firm.bank).toBeUndefined();
    expect(home.body.firm.conflicts).toBeUndefined();
  });
});

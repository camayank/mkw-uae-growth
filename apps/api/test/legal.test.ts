import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { upsertLegalText } from "../src/services/legal.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** O10: client terms at acceptance, the partner agreement in onboarding, the lawyer's sign-off, the holiday calendar. */

const TERMS = "# Tasees Client Terms\n\nDraft for review by a UAE lawyer before use.\n\n## 1. Who we are\n\nTasees is a service of MKW Advisors.\n";
const AGREEMENT = "# MKW Partner Network Agreement\n\nDraft for review by a UAE lawyer before use.\n\n## 1. Parties\n\nThis agreement is between MKW Advisors and the Partner.\n";

const q = (env: TestEnv, sql: string, params: unknown[] = []) => asPlatform(env.db, null, (tx) => tx.query<Record<string, any>>(sql, params));

describe("legal texts", () => {
  let env: TestEnv;
  let offerId: string;
  beforeAll(async () => {
    env = await makeEnv();
    await asPlatform(env.db, null, async (tx) => {
      await upsertLegalText(tx, "client_terms", "Tasees Client Terms", TERMS, "test");
      await upsertLegalText(tx, "partner_agreement", "MKW Partner Network Agreement", AGREEMENT, "test");
    });
    const r = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    const built = await env.call("ops", "POST", `/api/ops/requests/${r.body.id}/build-offers`, {});
    offerId = built.body.offerIds[0];
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`)).status).toBe(200);
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("shows each side only its own text, marked draft until signed off", async () => {
    const client = await env.call("client", "GET", "/api/legal/client_terms");
    expect(client.body).toMatchObject({ kind: "client_terms", version: 1, draft: true, approvedByLawyer: null });
    expect(client.body.body).toContain("Who we are");
    expect((await env.call("client", "GET", "/api/legal/partner_agreement")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/legal/client_terms")).status).toBe(403);
    const partner = await env.call("setup", "GET", "/api/legal/partner_agreement");
    expect(partner.body).toMatchObject({ version: 1, draft: true });
    expect(partner.body.body).not.toMatch(/\bTasees\b/);
    expect((await env.call("ops", "GET", "/api/legal/client_terms")).status).toBe(200);
  });

  it("refuses acceptance without the current terms version, and the engagement keeps the version accepted", async () => {
    const none = await env.call("client", "POST", `/api/client/offers/${offerId}/accept`, {});
    expect(none.status).toBe(409);
    expect(JSON.stringify(none.body)).toMatch(/client terms \(version 1\)/);
    expect((await env.call("client", "POST", `/api/client/offers/${offerId}/accept`, { termsVersion: 7 })).status).toBe(409);
    const ok = await env.call("client", "POST", `/api/client/offers/${offerId}/accept`, { termsVersion: 1 });
    expect(ok.status).toBe(200);
    const eng = (await q(env, "select client_terms_version from engagements where id = $1", [ok.body.engagementId])).rows[0]!;
    expect(eng.client_terms_version).toBe(1);
    const ev = (await q(env, "select data from audit_events where action = 'offer.accepted' and entity_id = $1", [ok.body.engagementId])).rows[0]!;
    expect(ev.data.clientTermsVersion).toBe(1);
  });

  it("lets the partner admin accept the current agreement, and only them", async () => {
    expect((await env.call("setupStaff", "POST", "/api/partner/agreement/accept", { version: 1 })).status).toBe(403);
    expect((await env.call("setup", "POST", "/api/partner/agreement/accept", { version: 2 })).status).toBe(409);
    expect((await env.call("setup", "POST", "/api/partner/agreement/accept", { version: 1 })).status).toBe(200);
    const p = (await q(env, "select o.profile from orgs o join users u on u.org_id = o.id where u.email = 'admin@setup-partner.test'")).rows[0]!.profile;
    expect(p.agreementAccepted).toMatchObject({ version: 1, draft: true });
    expect(p.agreementSigned).toBe(true); // the demo firm's signed copy is a separate, verified document; accepting online does not change it
  });

  it("records the lawyer's sign-off: founder only, audited, the draft note goes", async () => {
    expect((await env.call("ops", "POST", "/api/admin/legal/client_terms/1/sign-off", { lawyer: "A. Lawyer", approvedOn: "2026-10-18" })).status).toBe(403);
    expect((await env.call("founder", "POST", "/api/admin/legal/client_terms/1/sign-off", { lawyer: "A. Lawyer", approvedOn: "18/10/2026" })).status).toBe(400);
    expect((await env.call("founder", "POST", "/api/admin/legal/client_terms/1/sign-off", { lawyer: "A. Lawyer", approvedOn: "2026-10-18" })).status).toBe(200);
    expect((await env.call("client", "GET", "/api/legal/client_terms")).body).toMatchObject({ draft: false, approvedByLawyer: "A. Lawyer", approvedOn: "2026-10-18" });
    const overview = (await env.call("ops", "GET", "/api/admin/legal")).body;
    expect(overview.map((d: any) => [d.kind, d.version, d.draft])).toEqual([
      ["client_terms", 1, false],
      ["partner_agreement", 1, true],
    ]);
    expect((await q(env, "select count(*)::int as n from audit_events where action = 'legal.signed_off'")).rows[0]!.n).toBe(1);
    // A new text is a new draft; the old sign-off does not carry over and cannot be recorded against the old version.
    await asPlatform(env.db, null, (tx) => upsertLegalText(tx, "client_terms", "Tasees Client Terms", TERMS + "\nUpdated.\n", "test"));
    expect((await env.call("client", "GET", "/api/legal/client_terms")).body).toMatchObject({ version: 2, draft: true });
    expect((await env.call("founder", "POST", "/api/admin/legal/client_terms/1/sign-off", { lawyer: "A. Lawyer", approvedOn: "2026-10-18" })).status).toBe(409);
  });
});

describe("holiday calendar", () => {
  let env: TestEnv;
  beforeAll(async () => {
    // Tuesday 20 Oct 2026, 08:30 GST: inside the ops digest window.
    env = await makeEnv(new Date("2026-10-20T04:30:00Z"));
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("is changed by the founder only, with a reason, and every change is audited", async () => {
    const h = { date: "2026-10-20", name: "Test holiday", status: "confirmed", reason: "Announced by the government" };
    expect((await env.call("ops", "PUT", "/api/admin/holidays", h)).status).toBe(403);
    expect((await env.call("founder", "PUT", "/api/admin/holidays", { ...h, reason: "" })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/holidays", { ...h, date: "20/10/2026" })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/holidays", h)).status).toBe(200);
    expect((await env.call("ops", "GET", "/api/admin/holidays")).body).toEqual([{ date: "2026-10-20", name: "Test holiday", status: "confirmed", note: "" }]);
    expect((await q(env, "select count(*)::int as n from audit_events where action = 'settings.holiday_set'")).rows[0]!.n).toBe(1);
  });

  it("stops the ops digest on a holiday and lets it run once the date is removed", async () => {
    const onHoliday = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(onHoliday.body.opsDigests).toBe(0);
    expect((await env.call("founder", "DELETE", "/api/admin/holidays/2026-10-20", { reason: "Entered by mistake" })).status).toBe(200);
    const working = await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(working.body.opsDigests).toBeGreaterThan(0);
    expect((await q(env, "select count(*)::int as n from audit_events where action = 'settings.holiday_removed'")).rows[0]!.n).toBe(1);
  });
});

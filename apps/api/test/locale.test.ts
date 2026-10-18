import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderTemplateAr } from "../src/lib/templates-ar.ts";
import { renderTemplate, TEMPLATE_AUDIENCE, type TemplateName } from "../src/lib/templates.ts";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** O9: language per person, Arabic gated on the reviewer's sign-off, Arabic client emails. */

const VARS = { code: "123456", offerId: "11111111-2222-3333-4444-555555555555", engagementId: "66666666-7777-8888-9999-000000000000", amountFils: 1234550, kind: "deposit", payUrl: "https://app.test/#/pay/x", number: "TI-2026-000001", company: "شركة النور", newAccount: 1, step: "Initial approval issued", count: 2, kinds: "passport copy, photo", dueDate: "2026-10-20", expectedDate: "2026-10-27", amountAed: "250", how: "applied", title: "VAT return", when: "7 days", uncertain: 1, orgName: "Example LLC" };

describe("Arabic templates", () => {
  it("exist for every client-facing template, keep the brand, amounts and links, and never leak undefined", () => {
    const clientTemplates = (Object.keys(TEMPLATE_AUDIENCE) as TemplateName[]).filter((t) => TEMPLATE_AUDIENCE[t] === "client" || t === "login_code" || t === "user_invited");
    for (const t of clientTemplates) {
      const ar = renderTemplateAr(t, VARS, "https://app.test");
      expect(ar, t).not.toBeNull();
      const text = `${ar!.subject}\n${ar!.body}`;
      expect(text).toMatch(/[؀-ۿ]/);
      expect(text).not.toMatch(/undefined|NaN|\[object/);
      expect(text).toContain("MKW Advisors");
      const en = renderTemplate(t, "client", VARS, "https://app.test");
      // Whatever link or reference the English version carries, the Arabic one carries too.
      for (const m of en.body.match(/https:\/\/[^\s;:,،]+|[0-9A-F]{8}\b/g) ?? []) expect(text).toContain(m);
    }
    // Partner and staff templates have no Arabic version in this outcome.
    expect(renderTemplateAr("allocation_offered", VARS, "x")).toBeNull();
    expect(renderTemplateAr("ops_digest", VARS, "x")).toBeNull();
  });
});

describe("language on the account", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("keeps clients on English until the founder records the Arabic review; staff may preview", async () => {
    const me = await env.call("client", "GET", "/api/me");
    expect(me.body.locale).toBe("en");
    expect(me.body.arabic).toEqual({ available: false, preview: false, reviewed: false });
    expect((await env.call("client", "PUT", "/api/me/locale", { locale: "ar" })).status).toBe(409);
    expect((await env.call("client", "PUT", "/api/me/locale", { locale: "fr" })).status).toBe(400);
    expect((await env.call("ops", "GET", "/api/me")).body.arabic).toEqual({ available: true, preview: true, reviewed: false });
    expect((await env.call("ops", "PUT", "/api/me/locale", { locale: "ar" })).status).toBe(200);
    // Partners never: their screens are English by design.
    expect((await env.call("setup", "GET", "/api/me")).body.arabic.available).toBe(false);
    expect((await env.call("setup", "PUT", "/api/me/locale", { locale: "ar" })).status).toBe(409);
    // The reviewer's test client may preview before the sign-off, with the draft flag, and report gaps.
    expect((await env.call("founder", "POST", "/api/admin/arabic/review", { reviewed: false, previewEmails: ["accounts@sample-client.test"] })).status).toBe(200);
    expect((await env.call("clientMember", "GET", "/api/me")).body.arabic).toEqual({ available: true, preview: true, reviewed: false });
    expect((await env.call("clientMember", "PUT", "/api/me/locale", { locale: "ar" })).status).toBe(200);
    expect((await env.call("client", "PUT", "/api/me/locale", { locale: "ar" })).status).toBe(409);
    expect((await env.call("clientMember", "POST", "/api/me/i18n-gaps", { strings: ["Some untranslated heading", "12,345", "a@b.test"] })).body.total).toBe(1);
    expect((await env.call("setup", "POST", "/api/me/i18n-gaps", { strings: ["x y"] })).status).toBe(403);
    expect((await env.call("founder", "GET", "/api/admin/arabic")).body.gaps).toEqual(["Some untranslated heading"]);
    // An English-speaking client gets English email even when the staff previewer uses Arabic.
    expect((await env.call("ops", "POST", "/api/admin/arabic/review", { reviewed: true, reviewedBy: "A. Reviewer" })).status).toBe(403);
    expect((await env.call("founder", "POST", "/api/admin/arabic/review", { reviewed: true })).status).toBe(400);
    const signed = await env.call("founder", "POST", "/api/admin/arabic/review", { reviewed: true, reviewedBy: "Huda Al Marri, legal translator", note: "Dictionary v1 and 13 templates reviewed" });
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ reviewed: true, reviewedBy: "Huda Al Marri, legal translator", previewEmails: ["accounts@sample-client.test"] });
    expect(signed.body.reviewedAt.slice(0, 10)).toBe(env.clock.now.toISOString().slice(0, 10)); // the application clock
    expect((await env.call("client", "GET", "/api/me")).body.arabic).toEqual({ available: true, preview: false, reviewed: true });
    expect((await env.call("client", "PUT", "/api/me/locale", { locale: "ar" })).status).toBe(200);
    expect((await env.call("client", "GET", "/api/me")).body.locale).toBe("ar");
    const ev = await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'arabic.review_recorded' order by id desc limit 1"));
    expect(ev.rows[0].data.after.reviewed).toBe(true);
  });

  it("sends Arabic emails to an Arabic-speaking client, English to partners, and records the language", async () => {
    const r = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    const built = await env.call("ops", "POST", `/api/ops/requests/${r.body.id}/build-offers`, { tiers: ["standard"] });
    await env.call("ops", "POST", `/api/ops/offers/${built.body.offerIds[0]}/publish`);
    const mail = env.emails.filter((m) => m.to === "founder@sample-client.test").at(-1)!;
    expect(mail.subject).toBe("عروضك جاهزة");
    expect(mail.fromName).toContain("MKW Advisors");
    expect(mail.text).toContain(`#/offer/${built.body.offerIds[0]}`);
    const rec = await asPlatform(env.db, null, (tx) => tx.query<any>("select locale, audience from notifications where template = 'offer_ready' order by created_at desc limit 1"));
    expect(rec.rows[0]).toMatchObject({ locale: "ar", audience: "client" });
    // Accept and pay so partners are offered work: their emails stay English.
    const engagementId = (await env.call("client", "POST", `/api/client/offers/${built.body.offerIds[0]}/accept`)).body.engagementId;
    const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
    await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "TT-1" });
    const partnerMail = env.emails.find((m) => m.subject.startsWith("New work from MKW Advisors"))!;
    expect(partnerMail).toBeTruthy();
    expect(partnerMail.text).not.toMatch(/[؀-ۿ]/);
    // Withdrawing the sign-off puts clients back on English at once, each on the record; the preview account keeps Arabic.
    await env.call("founder", "POST", "/api/admin/arabic/review", { reviewed: false, note: "Corrections pending" });
    expect((await env.call("client", "GET", "/api/me")).body.locale).toBe("en");
    expect((await env.call("client", "PUT", "/api/me/locale", { locale: "ar" })).status).toBe(409);
    expect((await env.call("clientMember", "GET", "/api/me")).body.locale).toBe("ar");
    const resets = await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'user.locale' and data->>'reason' = 'arabic_review_withdrawn'"));
    expect(resets.rows).toHaveLength(1);
  });
});

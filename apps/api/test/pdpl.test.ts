import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "../src/lib/audit.ts";
import { createSession } from "../src/lib/auth.ts";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { TOMBSTONE_NAME, TOMBSTONE_TEXT } from "../src/services/admin.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/**
 * UAE PDPL data requests. Export returns one person's data and nobody else's; erasure replaces the person's
 * identifying data with tombstones while payments, payouts and every audit row stay exactly as they were.
 */
describe("PDPL export and erasure", () => {
  let env: TestEnv;
  let engagementId: string;
  let memberId: string;
  let partnerAdminId: string;
  let memberToken: string;

  beforeAll(async () => {
    env = await makeEnv();
    // Run one engagement to the point where client, partner and MKW have all left traces.
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    const offerId = built.body.offerIds[0];
    await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
    engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    const eng = await env.call("finance", "GET", `/api/engagements/${engagementId}`);
    const deposit = eng.body.payments.find((p: any) => p.kind === "deposit");
    await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-REF-001" });
    for (const who of ["setup", "corp", "tax"]) {
      const home = await env.call(who, "GET", "/api/partner/home");
      for (const a of home.body.allocations.filter((x: any) => !x.acceptedAt && !x.declinedAt)) {
        await env.call(who, "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
      }
    }
    await env.call("clientMember", "POST", `/api/engagements/${engagementId}/messages`, { body: "Hello from the client member, call me on +971 50 111 2222" });
    await env.call("setup", "POST", `/api/engagements/${engagementId}/messages`, { body: "Partner here, passport copies please" });
    memberId = (await env.call("clientMember", "GET", "/api/me")).body.id;
    partnerAdminId = (await env.call("setup", "GET", "/api/me")).body.id;
    memberToken = await createSession(env.db, EMAILS.clientMember);
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("exports one person's data and nothing about anyone else", async () => {
    const r = await env.call("ops", "POST", `/api/admin/users/${memberId}/export`);
    expect(r.status).toBe(200);
    const data = r.body;
    expect(data.person).toMatchObject({ id: memberId, email: EMAILS.clientMember, role: "client_member" });
    expect(data.organisation.name).toBe("Sample Trading FZ-LLC");
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].body).toContain("+971 50 111 2222"); // the person's own words, unmasked, as they wrote them
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
    expect(data.auditEventsAsActor.map((e: any) => e.action)).toContain("message.contact_masked");
    const text = JSON.stringify(data);
    for (const other of [EMAILS.client, EMAILS.setup, EMAILS.ops, EMAILS.finance, EMAILS.founder, EMAILS.tax, EMAILS.corp]) expect(text).not.toContain(other);
    expect(text).not.toContain("Partner here, passport copies");
    expect(text).not.toMatch(/margin_fils|partner_unit_fils|client_unit_fils/);
    const logged = await asPlatform(env.db, null, (tx) => tx.query<{ kind: string }>("select kind from data_requests where user_id = $1", [memberId]));
    expect(logged.rows.map((x) => x.kind)).toEqual(["export"]);
  });

  it("limits who may export", async () => {
    expect((await env.call("finance", "POST", `/api/admin/users/${memberId}/export`)).status).toBe(403);
    expect((await env.call("client", "POST", `/api/admin/users/${memberId}/export`)).status).toBe(403);
    const founderId = (await env.call("founder", "GET", "/api/me")).body.id;
    expect((await env.call("ops", "POST", `/api/admin/users/${founderId}/export`)).status).toBe(403);
    expect((await env.call("founder", "POST", `/api/admin/users/${founderId}/export`)).status).toBe(200);
  });

  it("erases a person with tombstones and keeps payments, payouts and the audit chain", async () => {
    const before = await asPlatform(env.db, null, async (tx) => ({
      payments: (await tx.query("select id, amount_fils, status, provider_ref from payments order by id")).rows,
      payouts: (await tx.query("select id, amount_fils, status from payouts order by id")).rows,
      audit: (await tx.query("select id, hash, prev_hash, data from audit_events order by id")).rows,
      chain: await verifyAuditChain(tx),
    }));
    expect(before.chain.intact).toBe(true);
    expect(before.payments.length).toBeGreaterThan(0);

    expect((await env.call("ops", "POST", `/api/admin/users/${memberId}/erase`, { confirm: "ERASE" })).status).toBe(403);
    expect((await env.call("founder", "POST", `/api/admin/users/${memberId}/erase`, { confirm: "yes" })).status).toBe(400);
    const r = await env.call("founder", "POST", `/api/admin/users/${memberId}/erase`, { confirm: "ERASE" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, messagesTombstoned: 1 });
    expect(r.body.sessionsDeleted).toBeGreaterThanOrEqual(1);

    const after = await asPlatform(env.db, null, async (tx) => ({
      user: (await tx.query("select name, email, status, erased_at from users where id = $1", [memberId])).rows[0] as any,
      messages: (await tx.query("select author_name, body_original, body_shown from messages where engagement_id = $1 order by created_at", [engagementId])).rows as any[],
      payments: (await tx.query("select id, amount_fils, status, provider_ref from payments order by id")).rows,
      payouts: (await tx.query("select id, amount_fils, status from payouts order by id")).rows,
      audit: (await tx.query("select id, hash, prev_hash, data from audit_events order by id")).rows,
      chain: await verifyAuditChain(tx),
      requests: (await tx.query<{ kind: string }>("select kind from data_requests where user_id = $1 order by created_at", [memberId])).rows,
    }));
    expect(after.user).toMatchObject({ name: TOMBSTONE_NAME, email: `erased-${memberId}@erased.invalid`, status: "erased" });
    expect(after.user.erased_at).toBeTruthy();
    expect(after.messages[0]).toEqual({ author_name: TOMBSTONE_NAME, body_original: TOMBSTONE_TEXT, body_shown: TOMBSTONE_TEXT });
    expect(after.messages[1].body_original).toBe("Partner here, passport copies please"); // somebody else's message is untouched
    expect(after.payments).toEqual(before.payments);
    expect(after.payouts).toEqual(before.payouts);
    // Every earlier audit row is byte-for-byte the same, and the chain including the new erasure event verifies.
    expect(after.audit.slice(0, before.audit.length)).toEqual(before.audit);
    expect(after.audit.length).toBeGreaterThan(before.audit.length);
    expect(after.chain).toMatchObject({ intact: true, brokenId: null, checked: after.audit.length });
    expect(after.requests.map((x) => x.kind)).toEqual(["export", "erase"]);

    // The person can no longer sign in or use an old session, and the old address gets no code.
    const me = await env.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${memberToken}` } });
    expect(me.statusCode).toBe(401);
    expect((await env.call("anon", "POST", "/api/auth/request-code", { email: EMAILS.clientMember })).body).toEqual({ ok: true });
    // The tombstoned name is what other parties now see on the engagement.
    const partnerView = await env.call("setup", "GET", `/api/engagements/${engagementId}`);
    expect(partnerView.body.messages[0].authorName).toBe(TOMBSTONE_NAME);
    expect(JSON.stringify(partnerView.body)).not.toContain("111 2222");
    // Erasing again changes nothing; the old email can be invited afresh as a new person.
    expect((await env.call("founder", "POST", `/api/admin/users/${memberId}/erase`, { confirm: "ERASE" })).body.changed).toBe(false);
    expect((await env.call("founder", "POST", `/api/admin/users/${memberId}/reactivate`)).status).toBe(409);
    const again = await env.call("ops", "POST", `/api/admin/orgs/${env.ids.clientOrgId}/users`, { email: EMAILS.clientMember, name: "Accounts Assistant", role: "client_member" });
    expect(again.status).toBe(200);
  });

  it("refuses to erase the founder's own account", async () => {
    const founderId = (await env.call("founder", "GET", "/api/me")).body.id;
    expect((await env.call("founder", "POST", `/api/admin/users/${founderId}/erase`, { confirm: "ERASE" })).status).toBe(403);
    expect((await env.call("founder", "POST", `/api/admin/users/${partnerAdminId}/export`)).status).toBe(200);
  });

  it("detects a tampered audit row", async () => {
    // Corrupt one row inside a transaction that is rolled back, so the shared database stays intact.
    await asPlatform(env.db, null, async (tx) => {
      await tx.query("update audit_events set data = data || '{\"tampered\": true}'::jsonb where id = (select min(id) + 2 from audit_events)");
      const check = await verifyAuditChain(tx);
      expect(check.intact).toBe(false);
      expect(check.brokenId).not.toBeNull();
      throw new Error("rollback");
    }).catch((e) => {
      if ((e as Error).message !== "rollback") throw e;
    });
    const check = await asPlatform(env.db, null, (tx) => verifyAuditChain(tx));
    expect(check.intact).toBe(true);
  });

  it("hides data requests and retention settings from clients and partners at the database", async () => {
    const client = (await env.call("client", "GET", "/api/me")).body;
    const partner = (await env.call("setup", "GET", "/api/me")).body;
    await expect(asUser(env.db, client, (tx) => tx.query("select * from data_requests"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select * from data_requests"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, client, (tx) => tx.query("select * from settings"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select invited_by from users"))).rejects.toThrow(/permission denied/);
  });
});

describe("retention settings", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("start UNCERTAIN and only the founder confirms them, with an audited before and after", async () => {
    const before = await env.call("ops", "GET", "/api/admin/settings/retention");
    expect(before.status).toBe(200);
    expect(before.body.confirmed).toBe(false);
    expect(before.body.periods.taxRecords).toMatchObject({ years: 5, confidence: "UNCERTAIN" });
    expect(before.body.periods.sessions.confidence).toBe("verified");

    expect((await env.call("finance", "PUT", "/api/admin/settings/retention", { note: "x" })).status).toBe(403);
    expect((await env.call("ops", "PUT", "/api/admin/settings/retention", { note: "confirmed by lawyer" })).status).toBe(403);
    expect((await env.call("founder", "PUT", "/api/admin/settings/retention", { periods: { nonsense: { years: 1 } }, note: "confirmed by lawyer" })).status).toBe(400);

    const r = await env.call("founder", "PUT", "/api/admin/settings/retention", { periods: { clientDocuments: { years: 7 } }, note: "Confirmed with counsel on 20 Oct 2026" });
    expect(r.status).toBe(200);
    expect(r.body.confirmed).toBe(true);
    expect(r.body.periods.clientDocuments).toMatchObject({ years: 7, confidence: "verified" });
    expect(r.body.periods.taxRecords.confidence).toBe("verified");
    const after = await env.call("finance", "GET", "/api/admin/settings/retention");
    expect(after.body.confirmedBy).toBeTruthy();
    const ev = await asPlatform(env.db, null, (tx) => tx.query<{ data: any }>("select data from audit_events where action = 'settings.retention_confirmed'"));
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.data.before.clientDocuments.years).toBe(5);
    expect(ev.rows[0]!.data.after.clientDocuments.years).toBe(7);
  });
});

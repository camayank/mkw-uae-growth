import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, type SessionUser } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * Database-level guarantees. Even if application code asked for them, a client or partner
 * session cannot read margin columns or another party's rows.
 */
describe("row-level security and column grants", () => {
  let env: TestEnv;
  let client: SessionUser;
  let otherClient: SessionUser;
  let partner: SessionUser;
  let engagementId: string;

  beforeAll(async () => {
    env = await makeEnv();
    const req = await env.call("client", "POST", "/api/requests", {
      answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 },
    });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    const offerId = built.body.offerIds[0];
    await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
    engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    const me = await env.call("client", "GET", "/api/me");
    client = { ...me.body };
    const pm = await env.call("setup", "GET", "/api/me");
    partner = { ...pm.body };
    const other = await env.call("ops", "POST", "/api/ops/clients", { company: "Other Co", ownerName: "Other", ownerEmail: "other@client.test" });
    otherClient = { ...client, id: client.id, orgId: other.body.id, orgName: "Other Co" };
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("refuses margin and partner cost columns to clients", async () => {
    await expect(asUser(env.db, client, (tx) => tx.query("select margin_fils from offers"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, client, (tx) => tx.query("select partner_unit_fils from offer_lines"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, client, (tx) => tx.query("select * from payouts"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, client, (tx) => tx.query("select * from rate_cards"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, client, (tx) => tx.query("select body_original from messages"))).rejects.toThrow(/permission denied/);
  });

  it("refuses the client price and margin to partners", async () => {
    await expect(asUser(env.db, partner, (tx) => tx.query("select client_unit_fils from engagement_lines"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select * from offers"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select * from payments"))).rejects.toThrow(/permission denied/);
  });

  it("returns no rows of another client's engagement", async () => {
    const own = await asUser(env.db, client, (tx) => tx.query("select id from engagements"));
    expect(own.rows.map((r: any) => r.id)).toContain(engagementId);
    const other = await asUser(env.db, otherClient, (tx) => tx.query("select id from engagements"));
    expect(other.rows).toEqual([]);
    const r = await env.call("anon", "GET", `/api/engagements/${engagementId}`);
    expect(r.status).toBe(401);
  });

  it("does not show a partner an engagement before it is allocated to it", async () => {
    const rows = await asUser(env.db, partner, (tx) => tx.query("select id from engagements"));
    expect(rows.rows).toEqual([]);
    const r = await env.call("tax", "GET", `/api/engagements/${engagementId}`);
    expect(r.status).toBe(404);
  });

  it("blocks role escalation through the API", async () => {
    expect((await env.call("client", "GET", "/api/ops/overview")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/ops/overview")).status).toBe(403);
    expect((await env.call("setup", "GET", "/api/client/home")).status).toBe(403);
    expect((await env.call("ops", "POST", "/api/ops/payments/00000000-0000-0000-0000-000000000000/mark-paid", { reference: "x123" })).status).toBe(403);
  });

  it("signs in with a one-time code and rejects a wrong one", async () => {
    const req = await env.call("anon", "POST", "/api/auth/request-code", { email: "founder@sample-client.test" });
    expect(req.body.devCode).toMatch(/^\d{6}$/);
    const bad = await env.call("anon", "POST", "/api/auth/verify", { email: "founder@sample-client.test", code: "000000" === req.body.devCode ? "111111" : "000000" });
    expect(bad.status).toBe(401);
    const ok = await env.call("anon", "POST", "/api/auth/verify", { email: "founder@sample-client.test", code: req.body.devCode });
    expect(ok.status).toBe(200);
    expect(ok.body.user.role).toBe("client_owner");
    const unknown = await env.call("anon", "POST", "/api/auth/request-code", { email: "nobody@nowhere.test" });
    expect(unknown.body).toEqual({ ok: true });
  });

  it("limits sign-in codes per account so codes cannot be brute-forced", async () => {
    const email = "accounts@sample-client.test";
    const issued = [];
    for (let i = 0; i < 7; i++) issued.push((await env.call("anon", "POST", "/api/auth/request-code", { email })).body);
    expect(issued.filter((b) => b.devCode).length).toBe(5);
    expect(issued.at(-1)).toEqual({ ok: true }); // same answer as an unknown email
  });

  it("sends security headers", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

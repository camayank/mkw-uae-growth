import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/lib/auth.ts";
import { asPlatform } from "../src/lib/context.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/**
 * Console administration: partner creation, inviting people, role changes and deactivation.
 * Founder and ops write; finance reads; MKW Advisors' own staff are the founder's business only.
 */
describe("administration of organisations and people", () => {
  let env: TestEnv;
  let partnerOrgId: string;
  let partnerAdminId: string;
  let clientOrgId: string;
  let platformOrgId: string;
  const audits = () => asPlatform(env.db, null, async (tx) => (await tx.query<{ action: string }>("select action from audit_events order by id")).rows.map((r) => r.action));

  beforeAll(async () => {
    env = await makeEnv();
    clientOrgId = env.ids.clientOrgId;
    platformOrgId = env.ids.platformOrgId;
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("lets ops create a partner firm with its first admin, who can then sign in", async () => {
    const r = await env.call("ops", "POST", "/api/admin/partners", {
      name: "New Setup Partners LLC",
      adminName: "Partner Admin",
      adminEmail: "Admin@New-Partner.test",
      emirates: ["Dubai"],
      codes: ["SET-FZ-LIC"],
    });
    expect(r.status).toBe(200);
    partnerOrgId = r.body.orgId;
    partnerAdminId = r.body.adminUserId;
    const orgs = await env.call("finance", "GET", "/api/admin/orgs");
    const org = orgs.body.find((o: any) => o.id === partnerOrgId);
    expect(org.type).toBe("partner");
    expect(org.profile.status).toBe("prospect");
    expect(org.profile.licenceActive).toBe(false);
    expect(org.users).toHaveLength(1);
    expect(org.users[0]).toMatchObject({ email: "admin@new-partner.test", role: "partner_admin", status: "active" });
    expect(env.notify.sent.at(-1)).toMatchObject({ template: "user_invited", to: "admin@new-partner.test" });
    const code = await env.call("anon", "POST", "/api/auth/request-code", { email: "admin@new-partner.test" });
    expect(code.body.devCode).toMatch(/^\d{6}$/);
    expect(await audits()).toEqual(expect.arrayContaining(["partner.created", "user.invited"]));
  });

  it("keeps finance read-only", async () => {
    expect((await env.call("finance", "GET", "/api/admin/orgs")).status).toBe(200);
    expect((await env.call("finance", "POST", "/api/admin/partners", { name: "X Partners", adminName: "Someone", adminEmail: "x@x.test" })).status).toBe(403);
    expect((await env.call("finance", "POST", `/api/admin/orgs/${clientOrgId}/users`, { email: "y@y.test", name: "Someone", role: "client_member" })).status).toBe(403);
    expect((await env.call("finance", "POST", `/api/admin/users/${partnerAdminId}/deactivate`)).status).toBe(403);
  });

  it("refuses clients, partners and anonymous callers", async () => {
    for (const who of ["client", "setup", "tax"]) {
      expect((await env.call(who, "GET", "/api/admin/orgs")).status).toBe(403);
      expect((await env.call(who, "POST", "/api/admin/partners", { name: "X Partners", adminName: "Someone", adminEmail: "x@x.test" })).status).toBe(403);
      expect((await env.call(who, "GET", "/api/admin/settings/retention")).status).toBe(403);
    }
    expect((await env.call("anon", "GET", "/api/admin/orgs")).status).toBe(401);
  });

  it("invites a user only with a role that fits the organisation, and never the same email twice", async () => {
    const ok = await env.call("ops", "POST", `/api/admin/orgs/${clientOrgId}/users`, { email: "ops-invited@sample-client.test", name: "New Member", role: "client_member" });
    expect(ok.status).toBe(200);
    const wrongKind = await env.call("ops", "POST", `/api/admin/orgs/${clientOrgId}/users`, { email: "p@sample-client.test", name: "Wrong Role", role: "partner_admin" });
    expect(wrongKind.status).toBe(400);
    const dup = await env.call("ops", "POST", `/api/admin/orgs/${clientOrgId}/users`, { email: "OPS-INVITED@sample-client.test", name: "Again", role: "client_member" });
    expect(dup.status).toBe(409);
    const unknownOrg = await env.call("ops", "POST", `/api/admin/orgs/00000000-0000-0000-0000-000000000000/users`, { email: "z@z.test", name: "Nobody", role: "client_member" });
    expect(unknownOrg.status).toBe(404);
  });

  it("lets only the founder manage MKW Advisors staff", async () => {
    const byOps = await env.call("ops", "POST", `/api/admin/orgs/${platformOrgId}/users`, { email: "newops@mkwadvisors.test", name: "New Ops", role: "ops" });
    expect(byOps.status).toBe(403);
    const byFounder = await env.call("founder", "POST", `/api/admin/orgs/${platformOrgId}/users`, { email: "newops@mkwadvisors.test", name: "New Ops", role: "ops" });
    expect(byFounder.status).toBe(200);
    const founderId = (await env.call("founder", "GET", "/api/me")).body.id;
    expect((await env.call("ops", "POST", `/api/admin/users/${founderId}/role`, { role: "ops" })).status).toBe(403);
    expect((await env.call("ops", "POST", `/api/admin/users/${founderId}/deactivate`)).status).toBe(403);
  });

  it("changes a role within the organisation's kind and never one's own", async () => {
    const orgs = await env.call("ops", "GET", "/api/admin/orgs");
    const member = orgs.body.find((o: any) => o.id === clientOrgId).users.find((u: any) => u.email === "ops-invited@sample-client.test");
    expect((await env.call("ops", "POST", `/api/admin/users/${member.id}/role`, { role: "client_owner" })).status).toBe(200);
    expect((await env.call("ops", "POST", `/api/admin/users/${member.id}/role`, { role: "ops" })).status).toBe(400);
    const opsId = (await env.call("ops", "GET", "/api/me")).body.id;
    expect((await env.call("founder", "POST", `/api/admin/users/${opsId}/role`, { role: "finance" })).status).toBe(200);
    expect((await env.call("founder", "POST", `/api/admin/users/${opsId}/role`, { role: "ops" })).status).toBe(200);
    const founderId = (await env.call("founder", "GET", "/api/me")).body.id;
    expect((await env.call("founder", "POST", `/api/admin/users/${founderId}/role`, { role: "ops" })).status).toBe(403);
    expect(await audits()).toContain("user.role_changed");
  });

  it("deactivation ends existing sessions and stops new sign-in codes; reactivation restores access", async () => {
    const email = "admin@new-partner.test";
    const token = await createSession(env.db, email);
    const before = await env.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(before.statusCode).toBe(200);

    const r = await env.call("ops", "POST", `/api/admin/users/${partnerAdminId}/deactivate`);
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    const after = await env.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
    const code = await env.call("anon", "POST", "/api/auth/request-code", { email });
    expect(code.body).toEqual({ ok: true }); // same as an unknown address: no code
    const sessions = await asPlatform(env.db, null, (tx) => tx.query("select 1 from sessions s join users u on u.id = s.user_id where u.email = $1", [email]));
    expect(sessions.rows).toEqual([]);

    expect((await env.call("ops", "POST", `/api/admin/users/${partnerAdminId}/reactivate`)).status).toBe(200);
    const again = await env.call("anon", "POST", "/api/auth/request-code", { email });
    expect(again.body.devCode).toMatch(/^\d{6}$/);
    expect(await audits()).toEqual(expect.arrayContaining(["user.deactivated", "user.reactivated"]));
  });

  it("never deactivates the caller, and a founder always remains", async () => {
    const opsId = (await env.call("ops", "GET", "/api/me")).body.id;
    expect((await env.call("ops", "POST", `/api/admin/users/${opsId}/deactivate`)).status).toBe(403);
    const founderId = (await env.call("founder", "GET", "/api/me")).body.id;
    expect((await env.call("founder", "POST", `/api/admin/users/${founderId}/deactivate`)).status).toBe(403);
    expect((await env.call("founder", "POST", `/api/admin/users/${founderId}/role`, { role: "ops" })).status).toBe(403);
    // Only a founder may act on a founder, and never on themselves, so at least one active founder always remains.
    const second = await env.call("founder", "POST", `/api/admin/orgs/${platformOrgId}/users`, { email: "founder2@mkwadvisors.test", name: "Second Founder", role: "founder" });
    expect(second.status).toBe(200);
    env.tokens.founder2 = await createSession(env.db, "founder2@mkwadvisors.test");
    expect((await env.call("founder2", "POST", `/api/admin/users/${founderId}/deactivate`)).status).toBe(200);
    expect((await env.call("founder", "GET", "/api/me")).status).toBe(401);
    expect((await env.call("founder2", "POST", `/api/admin/users/${founderId}/reactivate`)).status).toBe(200);
    env.tokens.founder = await createSession(env.db, EMAILS.founder);
    expect((await env.call("founder", "POST", `/api/admin/users/${second.body.id}/deactivate`)).status).toBe(200);
    const founders = await asPlatform(env.db, null, (tx) => tx.query("select 1 from users where role = 'founder' and status = 'active'"));
    expect(founders.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects malformed input", async () => {
    expect((await env.call("ops", "POST", "/api/admin/partners", { name: "X", adminName: "", adminEmail: "not-an-email" })).status).toBe(400);
    expect((await env.call("founder", "POST", `/api/admin/users/${partnerAdminId}/role`, { role: "superuser" })).status).toBe(400);
  });

  it("keeps the demo users unchanged for the other suites", async () => {
    for (const email of Object.values(EMAILS)) {
      const r = await asPlatform(env.db, null, (tx) => tx.query<{ status: string }>("select status from users where email = $1", [email]));
      expect(r.rows[0]?.status).toBe("active");
    }
  });
});

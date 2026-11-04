import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { ensureRuntimeLogin, loginOwnsSchema, openPostgres, prepareDatabase, scramVerifier } from "../src/lib/db.ts";
import { signWebhook } from "../src/lib/payments.ts";
import { runJobs } from "../src/jobs/run.ts";
import { nightlyAuditCheck } from "../src/services/system.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E19: the audit trail is append-only at the database, and the application runs as a login that owns nothing. Before
 * E19, staging logged in as the database's master user, which owns every table: a compromised process could leave the
 * per-request role, read anything, switch a guard off or edit the audit trail.
 */
const PG = !!process.env.TEST_DATABASE_URL;

describe("the audit trail is append-only (E19)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("no application role can change, remove or truncate an audit event", async () => {
    await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    for (const sql of [
      "update audit_events set data = '{}'::jsonb where id = (select max(id) from audit_events)",
      "delete from audit_events where id = (select max(id) from audit_events)",
      "truncate audit_events",
    ]) {
      await expect(asPlatform(env.db, null, (tx) => tx.query(sql))).rejects.toThrow(/permission denied|append-only/);
    }
    // Even with the privilege (as the owner, the trigger on), the change is refused.
    await expect(env.db.transaction((tx) => tx.query("update audit_events set data = '{}'::jsonb where id = (select max(id) from audit_events)"))).rejects.toThrow(/append-only/);
    expect((await asPlatform(env.db, null, (tx) => tx.query<{ broken_id: number | null }>("select * from audit_verify()"))).rows[0]!.broken_id).toBeNull();
  });

  it.skipIf(!PG)("on PostgreSQL, the owner of the tables is refused as the application's login in production, and may migrate elsewhere", async () => {
    expect(await loginOwnsSchema(env.db)).toBe(true);
    await expect(prepareDatabase(env.db, { production: true })).rejects.toThrow(/logs in as the owner of its tables/);
    expect(await prepareDatabase(env.db, { production: false })).toEqual([]); // development and tests: the owner migrates
  });

  it("a SCRAM verifier matches an independent computation (Python's hashlib, RFC 7677) and never contains the password", () => {
    const v = scramVerifier("correct-horse-battery-staple-0123456789", Buffer.alloc(16, 7));
    // Computed with Python's hashlib.pbkdf2_hmac and hmac (E19 review: the suite's PostgreSQL trusts local logins, so a
    // wrong verifier would otherwise pass every test).
    expect(v).toBe("SCRAM-SHA-256$4096:BwcHBwcHBwcHBwcHBwcHBw==$+IOlLVdmptQ6t2kJ9+bC/sx1M/3z66Y/w61fwtatf6s=:dIbrFgSdmPumBP0a33JHN+pPIvzs6rKStvPDn7Ohu+Y=");
    expect(v).not.toContain("correct-horse");
    expect(() => scramVerifier("has a space")).toThrow(/printable ASCII/);
  });

  it("the owner's truncate is refused too: the guard is a trigger, not only a revoked privilege", async () => {
    await expect(env.db.transaction((tx) => tx.query("truncate audit_events"))).rejects.toThrow(/append-only/);
  });

  it("no application role may add a trigger or a foreign key to any table, or change the migration list (E19 review)", async () => {
    const roles = ["app_client", "app_partner", "app_platform", "app_runtime"];
    const held = await env.db.transaction((tx) =>
      tx.query<{ role: string; relname: string; priv: string }>(
        `select r.role, c.relname, p.priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
           cross join unnest($1::text[]) as r(role) cross join unnest(array['TRIGGER', 'REFERENCES', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
         where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege(r.role, c.oid, p.priv)
           and (p.priv in ('TRIGGER', 'REFERENCES') or c.relname = 'schema_migrations')`,
        [roles],
      ),
    );
    expect(held.rows).toEqual([]);
    if (env.db.kind === "postgres") {
      const temp = await env.db.transaction((tx) => tx.query<{ role: string }>("select r.role from unnest($1::text[]) as r(role) where has_database_privilege(r.role, current_database(), 'TEMPORARY')", [roles]));
      expect(temp.rows).toEqual([]);
    }
  });
});

describe.skipIf(!PG)("the application as a runtime login that owns nothing (PostgreSQL, E19)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv(undefined, {}, { runtimeLogin: true });
  });
  afterAll(() => env.db.close());

  it("is not the owner and starts in production on a current schema", async () => {
    expect(await loginOwnsSchema(env.db)).toBe(false);
    expect(await prepareDatabase(env.db, { production: true })).toEqual([]);
  });

  it("runs a whole engagement: request, offer, acceptance, payment, allocation, every step delivered and approved, jobs and the nightly audit check", async () => {
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    expect(req.status).toBe(200);
    const offerId = (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`, { acknowledgeReview: true })).status).toBe(200);
    const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    expect(engagementId).toBeTruthy();
    const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
    const raw = JSON.stringify({ kind: "payment.paid", paymentId: deposit.id, amountFils: deposit.amount, reference: "PSP-RT" });
    const sig = signWebhook("test-secret", raw, Math.floor(env.clock.now.getTime() / 1000));
    expect((await env.app.inject({ method: "POST", url: "/api/webhooks/payments", headers: { "content-type": "application/json", "x-webhook-timestamp": sig.timestamp, "x-webhook-signature": sig.signature }, payload: raw })).statusCode).toBe(200);
    for (const who of ["setup", "corp", "tax"]) {
      for (const a of (await env.call(who, "GET", "/api/partner/home")).body.allocations.filter((x: any) => !x.acceptedAt && x.engagementId === engagementId)) {
        expect((await env.call(who, "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" })).status).toBe(200);
      }
    }
    const byName = new Map([["Example Setup Partners FZ-LLC", "setup"], ["Example Corporate Services LLC", "corp"], ["Example Tax & Accounts LLC", "tax"]]);
    let ops = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const partnerOf = new Map<string, string>(ops.lines.map((l: any) => [l.code, byName.get(l.partner)!]));
    for (const m of ops.milestones) {
      const who = partnerOf.get(m.code)!;
      for (const type of m.evidenceRequired) {
        expect((await env.call(who, "POST", `/api/milestones/${m.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: Buffer.from("%PDF-1.4 test").toString("base64") })).status).toBe(200);
      }
      expect((await env.call(who, "POST", `/api/milestones/${m.id}/submit`)).status).toBe(200);
      expect((await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true })).status).toBe(200);
      expect((await env.call("client", "POST", `/api/milestones/${m.id}/review`, { approve: true })).status).toBe(200);
    }
    ops = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    expect(ops.engagement.status).toBe("completed");
    const jobs = await runJobs(env.db, { notify: env.notify, storage: env.storage, provider: env.provider });
    expect(jobs.errors).toEqual([]);
    expect(await asPlatform(env.db, null, (tx) => nightlyAuditCheck(tx))).toBe(0); // no break in the chain
  });

  it("cannot leave the per-request role, read without one, change the audit trail or switch off a guard", async () => {
    // Without a role the login reads nothing, and RESET ROLE inside a request leaves it with nothing either.
    await expect(env.db.transaction((tx) => tx.query("select count(*) from offers"))).rejects.toThrow(/permission denied/);
    await expect(asPlatform(env.db, null, async (tx) => {
      await tx.query("reset role");
      return tx.query("select count(*) from offers");
    })).rejects.toThrow(/permission denied/);
    // The audit trail, the fee evidence guard and the role grants are out of its reach.
    await expect(asPlatform(env.db, null, (tx) => tx.query("update audit_events set data = '{}'::jsonb where id = (select max(id) from audit_events)"))).rejects.toThrow(/permission denied|append-only/);
    await expect(asPlatform(env.db, null, (tx) => tx.query("alter table audit_events disable trigger audit_events_no_change"))).rejects.toThrow(/must be owner/);
    await expect(asPlatform(env.db, null, (tx) => tx.query("alter table offer_lines disable trigger offer_lines_fee_evidence"))).rejects.toThrow(/must be owner/);
    await expect(env.db.transaction((tx) => tx.query("create role sneaky login"))).rejects.toThrow(/permission denied/);
    // The way round the guard the independent review found: a trigger of its own on audit_events, run as the owner
    // inside the security-definer audit_append; or code in the temporary schema. Both are refused.
    await expect(asPlatform(env.db, null, (tx) => tx.query("create trigger sneaky before insert on audit_events for each row execute function audit_events_append_only()"))).rejects.toThrow(/permission denied/);
    await expect(asPlatform(env.db, null, (tx) => tx.query("create function pg_temp.sneaky() returns int language sql as 'select 1'"))).rejects.toThrow(/permission denied/);
    // The migration list is the migration step's: a future migration cannot be marked as applied or removed.
    await expect(asPlatform(env.db, null, (tx) => tx.query("insert into schema_migrations (name) values ('999_skip_me.sql')"))).rejects.toThrow(/permission denied/);
    await expect(env.db.transaction((tx) => tx.query("delete from schema_migrations"))).rejects.toThrow(/permission denied/);
  });

  it("the migration step runs again as an owner who is not a superuser (as RDS's master): the login is updated, not refused", async () => {
    // E19 review: ALTER ROLE ... NOSUPERUSER is refused to a non-superuser, so every migration after the first failed.
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    const tag = randomBytes(4).toString("hex");
    const ownerRole = `rds_like_${tag}`;
    const dbName = `tasees_rds_${tag}`;
    const login = `tasees_rt_${tag}`;
    await admin.query(`create role ${ownerRole} login createrole createdb`);
    await admin.query(`grant app_runtime to ${ownerRole} with admin option`);
    await admin.query(`create database ${dbName} owner ${ownerRole}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.username = ownerRole;
    url.pathname = `/${dbName}`;
    const asOwner = await openPostgres(url.toString());
    try {
      await ensureRuntimeLogin(asOwner, login, randomBytes(24).toString("base64url"));
      // The login gives itself a default role; the next migration step clears it, and updates the password.
      await asOwner.transaction((tx) => tx.query(`alter role ${login} set role = 'app_platform'`));
      await ensureRuntimeLogin(asOwner, login, randomBytes(24).toString("base64url"));
      const r = await admin.query("select rolsuper, rolcreaterole, rolcreatedb, rolconfig from pg_roles where rolname = $1", [login]);
      expect(r.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolconfig: null });
    } finally {
      await asOwner.close();
      await admin.query(`drop database ${dbName} with (force)`);
      await admin.query(`drop role if exists ${login}`);
      await admin.query(`drop role if exists ${ownerRole}`);
      await admin.end();
    }
  });
});

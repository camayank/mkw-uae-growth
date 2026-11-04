import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser, type SessionUser } from "../src/lib/context.ts";
import { verifyAuditChain } from "../src/lib/audit.ts";
import { withClock } from "../src/lib/db.ts";
import { nightlyAuditCheck, sweepAlerts } from "../src/services/system.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E21 (S6, gap 148): the audit trail is written only through `audit_append`, and the nightly check's history only by
 * the database itself. Written before the fix; on `main` at 0b16552 every application role could insert an audit
 * event directly and rewrite `audit_checks` (`docs/evidence/E21/before-fix.txt`).
 */
const ROLES = ["app_platform", "app_client", "app_partner"] as const;
const day = 24 * 3600 * 1000;
/** A fresh environment has no audit events yet: append some, as the application does. */
const appendEvents = async (env: TestEnv, n: number, action = "test.event") => {
  for (let i = 0; i < n; i++) await asPlatform(env.db, null, (tx) => tx.query("select audit_append(null, null, $1, 'test', $2, '{}'::jsonb)", [action, String(i)]));
};

describe("the audit trail is written only through audit_append (E21)", () => {
  let env: TestEnv;
  let client: SessionUser;
  let partner: SessionUser;
  beforeAll(async () => {
    env = await makeEnv();
    client = (await env.call("client", "GET", "/api/me")).body;
    partner = (await env.call("setup", "GET", "/api/me")).body;
  });
  afterAll(() => env.db.close());

  const forged = (tx: any) =>
    tx.query(
      `insert into audit_events (actor_user_id, action, entity, entity_id, data, prev_hash, hash)
       values (null, 'payout.released', 'payout', 'forged', '{}'::jsonb, 'x', 'y')`,
    );

  it("refuses a direct insert into audit_events as every application role, and audit_append still works for each", async () => {
    await expect(asPlatform(env.db, null, forged)).rejects.toThrow(/permission denied|append-only/);
    await expect(asUser(env.db, client, forged)).rejects.toThrow(/permission denied|append-only/);
    await expect(asUser(env.db, partner, forged)).rejects.toThrow(/permission denied|append-only/);
    // Nor through the sequence: no application role may take or move audit event ids.
    await expect(asPlatform(env.db, null, (tx) => tx.query("select nextval('audit_events_id_seq')"))).rejects.toThrow(/permission denied/);
    const append = async (tx: any): Promise<number> => Number((await tx.query("select audit_append(null, null, 'test.append', 'test', 'e21', '{}'::jsonb) as id")).rows[0].id);
    for (const id of [await asPlatform(env.db, null, append), await asUser(env.db, client, append), await asUser(env.db, partner, append)]) {
      expect(id).toBeGreaterThan(0);
    }
    expect((await asPlatform(env.db, null, (tx) => verifyAuditChain(tx))).intact).toBe(true);
    expect((await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>("select count(*)::int as n from audit_events where entity_id = 'forged'"))).rows[0]!.n).toBe(0);
  });

  it("refuses a direct insert even to a role later granted the privilege (the trigger)", async () => {
    await asPlatform(env.db, null, async (tx) => {
      await tx.query("reset role"); // the test's connection is the owner's: grant, try, and roll back
      await tx.query("grant insert on audit_events to app_platform");
      await tx.query("set local role app_platform");
      await expect(forged(tx)).rejects.toThrow(/written only through audit_append/);
      throw new Error("rollback");
    }).catch((e) => {
      if (!/rollback|written only through/.test((e as Error).message)) throw e;
    });
  });

  it("no application role holds insert, update, delete or truncate on audit_events or audit_checks", async () => {
    const held = await asPlatform(env.db, null, (tx) =>
      tx.query<{ role: string; tbl: string; priv: string }>(
        `select r.role, t.tbl, p.priv from unnest($1::text[]) r(role) cross join unnest(array['audit_events', 'audit_checks']) t(tbl)
           cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p(priv)
          where has_table_privilege(r.role, t.tbl, p.priv)`,
        [ROLES],
      ),
    );
    expect(held.rows).toEqual([]);
    // They may still read what the console shows: the platform reads both.
    expect((await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>("select count(*)::int as n from audit_checks"))).rows[0]!.n).toBeGreaterThanOrEqual(0);
  });

  it("the platform cannot write, change or remove a nightly check row; only the database's own check records one", async () => {
    const tries = [
      "insert into audit_checks (day, checked, broken_id) values ('2099-01-01', 999999, null)",
      "update audit_checks set broken_id = null",
      "delete from audit_checks",
      "truncate audit_checks",
    ];
    for (const sql of tries) await expect(asPlatform(env.db, null, (tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied|append-only/);
    const at = withClock(env.db, () => env.clock.now);
    expect(await asPlatform(at, null, (tx) => nightlyAuditCheck(tx))).toBeGreaterThan(0);
    expect(await asPlatform(at, null, (tx) => nightlyAuditCheck(tx))).toBe(0); // once per Dubai day
    // A clock set in the future (app.now is a session setting) cannot record a later day's check ahead of time.
    const future = withClock(env.db, () => new Date(Date.now() + 30 * day));
    expect(await asPlatform(future, null, (tx) => nightlyAuditCheck(tx))).toBeGreaterThan(0); // recorded for today, not for the future day
    expect((await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>("select count(*)::int as n from audit_checks where day > now()::date + 1"))).rows[0]!.n).toBe(0);
    const [row] = (await asPlatform(env.db, null, (tx) => tx.query<any>("select checked, broken_id, finding, last_id, last_hash from audit_checks order by day limit 1"))).rows;
    expect(row).toMatchObject({ broken_id: null, finding: null });
    expect(Number(row.last_id)).toBeGreaterThan(0);
    expect(row.last_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compares the chain night to night: a removed tail is found even after new events are added", async () => {
    // After night 1, the owner (who alone can switch the guard off) removes the last events, then the application
    // appends more, so the chain is longer than last night's and still verifies on its own. A fresh environment,
    // because the change has to be committed.
    const fresh = await makeEnv();
    try {
      const at2 = withClock(fresh.db, () => fresh.clock.now);
      await appendEvents(fresh, 6);
      const n1 = await asPlatform(at2, null, (tx) => nightlyAuditCheck(tx));
      expect(n1).toBeGreaterThan(3);
      await asPlatform(fresh.db, null, async (tx) => {
        await tx.query("reset role");
        await tx.query("alter table audit_events disable trigger audit_events_no_change");
        await tx.query("delete from audit_events where id > (select max(id) - 3 from audit_events)");
        await tx.query("alter table audit_events enable trigger audit_events_no_change");
      });
      await appendEvents(fresh, 5, "test.after");
      expect((await asPlatform(fresh.db, null, (tx) => verifyAuditChain(tx))).intact).toBe(true); // the chain alone looks fine
      fresh.clock.now = new Date(fresh.clock.now.getTime() + day);
      expect(await asPlatform(at2, null, (tx) => nightlyAuditCheck(tx))).toBeGreaterThan(n1);
      const latest = (await asPlatform(fresh.db, null, (tx) => tx.query<any>("select finding from audit_checks order by day desc limit 1"))).rows[0];
      expect(latest.finding).toBe("tail_removed");
      expect(await asPlatform(at2, null, (tx) => sweepAlerts(tx, { notify: fresh.notify, alertEmail: "alerts@mkwadvisors.test", since: new Date(0) }))).toMatchObject({ opened: expect.any(Number) });
      const alert = (await asPlatform(fresh.db, null, (tx) => tx.query<any>("select kind, severity, summary from alerts where kind = 'audit_chain' and closed_at is null"))).rows[0];
      expect(alert).toMatchObject({ kind: "audit_chain", severity: "critical" });
      expect(alert.summary).toMatch(/last event of the previous check/);
    } finally {
      await fresh.db.close();
    }
  });

  it("finds a removed tail when nothing is added either: the chain is shorter and last night's final event is gone", async () => {
    const fresh = await makeEnv();
    try {
      const at = withClock(fresh.db, () => fresh.clock.now);
      await appendEvents(fresh, 6);
      expect(await asPlatform(at, null, (tx) => nightlyAuditCheck(tx))).toBe(6);
      await asPlatform(fresh.db, null, async (tx) => {
        await tx.query("reset role");
        await tx.query("alter table audit_events disable trigger audit_events_no_change");
        await tx.query("delete from audit_events where id > (select max(id) - 2 from audit_events)");
        await tx.query("alter table audit_events enable trigger audit_events_no_change");
      });
      fresh.clock.now = new Date(fresh.clock.now.getTime() + day);
      await asPlatform(at, null, (tx) => nightlyAuditCheck(tx));
      const rows = (await asPlatform(fresh.db, null, (tx) => tx.query<any>("select checked, finding from audit_checks order by day"))).rows;
      expect(rows).toHaveLength(2);
      expect(Number(rows[1].checked)).toBeLessThan(Number(rows[0].checked));
      expect(rows[1].finding).toBe("tail_removed"); // last night's final event is gone, which also explains the shorter chain
    } finally {
      await fresh.db.close();
    }
  });

  it("compares the length when the night before recorded no final event (a check from before E21)", async () => {
    const fresh = await makeEnv();
    try {
      const at = withClock(fresh.db, () => fresh.clock.now);
      await appendEvents(fresh, 3);
      await asPlatform(at, null, async (tx) => {
        await tx.query("reset role"); // as the owner: a row as migration 012's check wrote it, with no final event
        await tx.query("insert into audit_checks (day, checked, broken_id) values ((app_now() at time zone 'Asia/Dubai')::date - 1, 1000000, null)");
      });
      await asPlatform(at, null, (tx) => nightlyAuditCheck(tx));
      const latest = (await asPlatform(fresh.db, null, (tx) => tx.query<any>("select finding from audit_checks order by day desc limit 1"))).rows[0];
      expect(latest.finding).toBe("shortened");
    } finally {
      await fresh.db.close();
    }
  });
});

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { withClock } from "../src/lib/db.ts";
import { checkConfig, ConfigError, configProblems } from "../src/lib/config.ts";
import { requestId } from "../src/server.ts";
import { nightlyAuditCheck, sweepAlerts } from "../src/services/system.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const ALERTS = "alerts@mkwadvisors.test";
const rows = <T = any>(env: TestEnv, sql: string, params: unknown[] = []) =>
  asPlatform(withClock(env.db, () => env.clock.now), null, async (tx) => (await tx.query<T & Record<string, unknown>>(sql, params)).rows);
const later = (env: TestEnv, minutes: number) => {
  env.clock.now = new Date(env.clock.now.getTime() + minutes * 60_000);
};

describe("configuration at boot", () => {
  const prod = { NODE_ENV: "production" };

  it("accepts a sound production set and the development defaults", () => {
    expect(configProblems({})).toEqual([]);
    expect(
      configProblems({ ...prod, PORT: "8787", TRUST_PROXY: "1", APP_URL: "https://app.tasees.ae", EMAIL: "ses", SES_REGION: "me-central-1", EMAIL_FROM_CLIENT: "tasees@mkwadvisors.com", EMAIL_FROM_PARTNER: "partners@mkwadvisors.com", STORAGE: "s3", S3_BUCKET: "b", S3_REGION: "me-central-1", PAYMENT_WEBHOOK_SECRET: "a-long-enough-secret", ALERT_EMAIL: "alerts@mkwadvisors.com" }),
    ).toEqual([]);
  });

  it("refuses each misconfiguration, naming the variable and never its value", () => {
    const secret = "sekrit-value-xyz";
    const problems = configProblems({
      ...prod,
      PORT: "eighty",
      EMAIL: "sess",
      STORAGE: "s3",
      DEV_LOGIN: "1",
      APP_URL: "http://app.tasees.ae",
      PAYMENT_WEBHOOK_SECRET: "short",
      ALERT_EMAIL: secret,
      DATABASE_URL: `mysql://user:${secret}@host/db`,
    });
    expect(problems.map((p) => p.split(":")[0]).sort()).toEqual(
      ["ALERT_EMAIL", "APP_URL", "DATABASE_URL", "DEV_LOGIN", "EMAIL", "PAYMENT_WEBHOOK_SECRET", "PORT", "S3_BUCKET", "S3_REGION"].sort(),
    );
    expect(problems.join("\n")).not.toContain(secret);
    expect(problems.join("\n")).not.toContain("eighty");
    expect(() => checkConfig({ ...prod, EMAIL: "ses" })).toThrow(ConfigError);
    expect(configProblems({ ...prod, EMAIL: "ses" })).toEqual([
      "EMAIL_FROM_CLIENT: required when EMAIL=ses",
      "EMAIL_FROM_PARTNER: required when EMAIL=ses",
      "SES_REGION: required when EMAIL=ses (or S3_REGION)",
    ]);
  });

  it("allows outside production what production refuses", () => {
    expect(configProblems({ NODE_ENV: "development", DEV_LOGIN: "1", APP_URL: "http://localhost:8787", PAYMENT_WEBHOOK_SECRET: "dev" })).toEqual([]);
  });
});

describe("structured logs and request ids", () => {
  let env: TestEnv;
  const lines: Array<Record<string, unknown>> = [];
  beforeAll(async () => {
    env = await makeEnv(undefined, { logger: { stream: { write: (l: string) => void lines.push(JSON.parse(l)) } } });
  });
  afterAll(() => env.db.close());

  it("keeps a well-formed request id from the load balancer and makes one otherwise", () => {
    expect(requestId({ headers: { "x-request-id": "Root=1-abc-123" } })).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId({ headers: { "x-request-id": "lb-7f3a9c21-0001" } })).toBe("lb-7f3a9c21-0001");
    expect(requestId({ headers: { "x-request-id": "short" } })).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId({ headers: { "x-request-id": "bad id with spaces and more" } })).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId({ headers: {} })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the request id and logs who made the request, by id only", async () => {
    lines.length = 0;
    const res = await env.send("client", "GET", "/api/ops/search?q=founder@sample-trading.test", undefined, { "x-request-id": "lb-req-000123" });
    expect(res.headers["x-request-id"]).toBe("lb-req-000123");
    const mine = lines.filter((l) => l.reqId === "lb-req-000123");
    const done = mine.find((l) => l.msg === "request completed")!;
    const me = (await env.call("client", "GET", "/api/me")).body;
    expect(done).toMatchObject({ userId: me.id, orgId: env.ids.clientOrgId, role: "client_owner", res: { statusCode: 403 } });
    const text = JSON.stringify(mine);
    // No email, no query string, no token or cookie anywhere in the request's lines.
    expect(text).not.toContain("@");
    expect(text).not.toContain("?q=");
    expect(text).not.toContain(env.tokens.client!);
    expect(text).not.toMatch(/authorization|cookie/i);
    expect(mine.find((l) => l.msg === "incoming request")).toMatchObject({ req: { method: "GET", path: "/api/ops/search" } });
  });

  it("answers a server error with its request id, and logs the error under it", async () => {
    lines.length = 0;
    // A real failure: the catalogue table is briefly missing.
    const owner = (sql: string) => env.db.transaction((tx) => tx.query(sql));
    await owner("alter table deliverables rename to deliverables_gone");
    const res = await env.send("ops", "GET", "/api/deliverables", undefined, { "x-request-id": "lb-req-boom-01" });
    await owner("alter table deliverables_gone rename to deliverables");
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "server_error", requestId: "lb-req-boom-01" });
    expect(res.body.message).toContain("lb-req-boom-01");
    expect(res.body.message).not.toContain("deliverables");
    expect(lines.find((l) => l.msg === "request failed")).toMatchObject({ reqId: "lb-req-boom-01", role: "ops" });
  }, 30_000);
});

describe("job runs, alerts and the nightly audit check", () => {
  let env: TestEnv;
  const started = new Date("2026-10-19T06:00:00Z");
  beforeAll(async () => {
    env = await makeEnv(started, { alertEmail: ALERTS, startedAt: started });
  });
  afterAll(() => env.db.close());
  const sweep = async () => {
    const r = await asPlatform(withClock(env.db, () => env.clock.now), null, (tx) => sweepAlerts(tx, { notify: env.notify, alertEmail: ALERTS, since: started }));
    await env.notify.flush();
    return r;
  };
  let seen = 0;
  /** Alert emails since the last call to `fresh()`. */
  const alertMail = () => env.emails.filter((e) => e.to === ALERTS).slice(seen);
  const fresh = () => {
    seen = env.emails.filter((e) => e.to === ALERTS).length;
  };

  it("records each run with its steps and checks the audit chain once a day", async () => {
    const run = (await env.call("ops", "POST", "/api/ops/jobs/run")).body;
    expect(run.skipped).toBe(false);
    expect(run.auditChecked).toBeGreaterThan(0);
    const [r] = await rows(env, "select status, steps, duration_ms from job_runs where id = $1", [run.runId]);
    expect(r.status).toBe("ok");
    expect(Object.keys(r.steps)).toEqual(expect.arrayContaining(["allocationTimeouts", "delays", "queueItems", "auditChecked", "outbox"]));
    for (const s of Object.values(r.steps) as any[]) expect(s).toMatchObject({ ms: expect.any(Number), count: expect.any(Number) });
    // The same Dubai day: not checked again.
    expect((await env.call("ops", "POST", "/api/ops/jobs/run")).body.auditChecked).toBe(0);
    expect(await rows(env, "select checked > 0 as ok, broken_id from audit_checks")).toEqual([{ ok: true, broken_id: null }]);
  });

  it("runs one at a time and closes a run that died", async () => {
    await rows(env, "insert into job_runs (job, started_at) values ('sweeps', app_now() - interval '5 minutes')");
    const skipped = (await env.call("ops", "POST", "/api/ops/jobs/run")).body;
    expect(skipped).toMatchObject({ skipped: true, runId: null });
    later(env, 30);
    const ran = (await env.call("ops", "POST", "/api/ops/jobs/run")).body;
    expect(ran.skipped).toBe(false);
    expect(await rows(env, "select status, error from job_runs where status = 'abandoned'")).toEqual([
      { status: "abandoned", error: "did not finish within 30 minutes" },
    ]);
  });

  it("alerts when the jobs stop, reminds every four hours, and says when it clears", async () => {
    fresh();
    later(env, 50);
    expect(await sweep()).toEqual({ opened: 1, reminded: 0, closed: 0 });
    expect(await sweep()).toEqual({ opened: 0, reminded: 0, closed: 0 });
    const [opened] = alertMail();
    expect(opened!.subject).toMatch(/^Alert: The scheduled jobs have not completed for 50 minutes/);
    expect(opened!.fromName).toBe("MKW Advisors");
    expect((await env.call("ops", "GET", "/api/health/jobs")).status).toBe(503);
    // At the top of the ops queue, without buttons.
    const queue = (await env.call("ops", "GET", "/api/ops/queue")).body;
    expect(queue.items[0]).toMatchObject({ kind: "system_alert", link: "#/system", actions: [] });
    later(env, 4 * 60 + 1);
    expect(await sweep()).toMatchObject({ reminded: 1 });
    expect(alertMail()[1]!.subject).toMatch(/^Still open: The scheduled jobs have not completed for 29\d minutes/);
    await env.call("ops", "POST", "/api/ops/jobs/run"); // the run's own sweep closes it
    expect(alertMail()[2]!.subject).toMatch(/^Resolved: /);
    expect((await env.call("ops", "GET", "/api/health/jobs")).body).toMatchObject({ ok: true, lastStatus: "ok" });
    expect(await rows(env, "select action from audit_events where entity = 'alert' order by id")).toEqual([{ action: "alert.opened" }, { action: "alert.closed" }]);
  });

  it("alerts on a failed step without repeating its personal data", async () => {
    fresh();
    later(env, 5); // the failed run below is then the latest one
    await rows(
      env,
      `insert into job_runs (job, status, started_at, finished_at, steps) values ('sweeps', 'failed', app_now() - interval '2 minutes', app_now() - interval '1 minute',
         '{"delays": {"ms": 3, "count": 0, "error": "no route for founder@sample-trading.test"}}'::jsonb)`,
    );
    expect(await sweep()).toMatchObject({ opened: 1 });
    const [a] = await rows(env, "select kind, subject, summary from alerts where closed_at is null");
    expect(a).toMatchObject({ kind: "job_step_failed", subject: "delays" });
    expect(a.summary).toContain("[address]");
    expect(JSON.stringify(alertMail())).not.toContain("sample-trading");
    await env.call("ops", "POST", "/api/ops/jobs/run");
    expect(await rows(env, "select 1 from alerts where closed_at is null")).toEqual([]);
  });

  it("alerts when messages are stuck in the outbox", async () => {
    await rows(env, "insert into outbox (topic, payload, next_attempt_at) values ('notify', '{}'::jsonb, app_now() - interval '40 minutes')");
    expect(await sweep()).toMatchObject({ opened: 1 });
    expect((await rows(env, "select kind from alerts where closed_at is null"))[0].kind).toBe("outbox_stuck");
    await rows(env, "update outbox set status = 'cancelled' where payload = '{}'::jsonb");
    expect(await sweep()).toMatchObject({ closed: 1 });
  });

  it("raises a critical alert when the nightly check finds a changed audit row", async () => {
    // Inside one transaction that is rolled back, so the shared database stays intact.
    await asPlatform(withClock(env.db, () => env.clock.now), null, async (tx) => {
      await tx.query("delete from audit_checks");
      await tx.query("update audit_events set data = data || '{\"tampered\": true}'::jsonb where id = (select min(id) + 1 from audit_events)");
      expect(await nightlyAuditCheck(tx)).toBeGreaterThan(0);
      expect(await sweepAlerts(tx, { notify: env.notify, alertEmail: ALERTS, since: started })).toMatchObject({ opened: 1 });
      const [a] = (await tx.query<any>("select kind, severity, summary from alerts where closed_at is null")).rows;
      expect(a).toMatchObject({ kind: "audit_chain", severity: "critical" });
      throw new Error("rollback");
    }).catch((e) => {
      if ((e as Error).message !== "rollback") throw e;
    });
  });

  it("shows the System page to MKW staff only", async () => {
    for (const who of ["founder", "ops", "finance"]) {
      const s = (await env.call(who, "GET", "/api/ops/system")).body;
      expect(s.runs.length).toBeGreaterThan(0);
      expect(s.thresholds).toEqual({ jobsLateMinutes: 45, outboxStuckMinutes: 30, remindHours: 4 });
    }
    for (const who of ["client", "setup"]) expect((await env.call(who, "GET", "/api/ops/system")).status).toBe(403);
    expect((await env.call("anon", "GET", "/api/health/jobs")).body).not.toHaveProperty("runs");
  });
});

describe("idempotency keys", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());
  const body = { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } };
  const requests = async () => (await rows(env, "select count(*)::int as n from requests"))[0].n as number;

  it("runs a change once and gives a repeat the first answer", async () => {
    const before = await requests();
    const first = await env.send("client", "POST", "/api/requests", body, { "idempotency-key": "key-request-0001" });
    const again = await env.send("client", "POST", "/api/requests", body, { "idempotency-key": "key-request-0001" });
    expect(first.status).toBe(200);
    expect(again).toMatchObject({ status: 200, body: first.body });
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(first.headers["idempotent-replay"]).toBeUndefined();
    expect(await requests()).toBe(before + 1);
    // Without a key, or with a new one, it is a new change.
    await env.send("client", "POST", "/api/requests", body, { "idempotency-key": "key-request-0002" });
    expect(await requests()).toBe(before + 2);
  });

  it("refuses the same key on a different request, and a repeat while the first runs", async () => {
    const other = await env.send("client", "POST", "/api/requests", { answers: { ...body.answers, visas: 2 } }, { "idempotency-key": "key-request-0001" });
    expect(other).toMatchObject({ status: 422, body: { error: "idempotency_mismatch" } });
    const elsewhere = await env.send("client", "PUT", "/api/me/locale", { locale: "en" }, { "idempotency-key": "key-request-0001" });
    expect(elsewhere.status).toBe(422);
    const me = (await env.call("client", "GET", "/api/me")).body;
    await rows(env, "insert into idempotency_keys (user_id, key, method, path, body_hash) values ($1, 'key-stuck-00001', 'PUT', '/api/me/locale', $2)", [
      me.id,
      createHash("sha256").update(JSON.stringify({ locale: "en" })).digest("hex"),
    ]);
    const stuck = await env.send("client", "PUT", "/api/me/locale", { locale: "en" }, { "idempotency-key": "key-stuck-00001" });
    expect(stuck).toMatchObject({ status: 409, body: { error: "in_progress" } });
  });

  it("keeps keys per person, refuses them on public routes and malformed ones", async () => {
    // The same key from another person is that person's own first request.
    const theirs = await env.send("clientMember", "PUT", "/api/me/locale", { locale: "en" }, { "idempotency-key": "key-request-0001" });
    expect(theirs.status).toBe(200);
    expect(theirs.headers["idempotent-replay"]).toBeUndefined();
    const anon = await env.send("anon", "POST", "/api/auth/request-code", { email: "someone@example.test" }, { "idempotency-key": "key-anon-000001" });
    expect(anon.status).toBe(400);
    expect((await env.send("client", "PUT", "/api/me/locale", { locale: "en" }, { "idempotency-key": "short" })).status).toBe(400);
    // Reads ignore the header.
    expect((await env.send("client", "GET", "/api/me", undefined, { "idempotency-key": "short" })).status).toBe(200);
  });

  it("records refusals too, and releases the key when the server failed", async () => {
    const refused = await env.send("client", "POST", "/api/requests", { answers: { mode: "nonsense" } }, { "idempotency-key": "key-refused-001" });
    expect(refused.status).toBe(400);
    expect((await env.send("client", "POST", "/api/requests", { answers: { mode: "nonsense" } }, { "idempotency-key": "key-refused-001" })).headers["idempotent-replay"]).toBe("true");
    const owner = (sql: string) => env.db.transaction((tx) => tx.query(sql));
    await owner("alter table requests rename to requests_gone");
    const failed = await env.send("client", "POST", "/api/requests", body, { "idempotency-key": "key-failed-0001" });
    await owner("alter table requests_gone rename to requests");
    expect(failed.status).toBe(500);
    const retried = await env.send("client", "POST", "/api/requests", body, { "idempotency-key": "key-failed-0001" });
    expect(retried.status).toBe(200);
    expect(retried.headers["idempotent-replay"]).toBeUndefined();
  });

  it("forgets keys after a day and when the person is erased", async () => {
    const memberId = (await env.call("clientMember", "GET", "/api/me")).body.id;
    expect((await rows(env, "select count(*)::int as n from idempotency_keys where user_id = $1", [memberId]))[0].n).toBe(1);
    expect((await env.call("founder", "POST", `/api/admin/users/${memberId}/erase`, { confirm: "ERASE" })).status).toBe(200);
    expect((await rows(env, "select count(*)::int as n from idempotency_keys where user_id = $1", [memberId]))[0].n).toBe(0);
    later(env, 24 * 60 + 1);
    const run = (await env.call("ops", "POST", "/api/ops/jobs/run")).body;
    expect(run.idempotencyPurged).toBeGreaterThan(0);
    expect((await rows(env, "select count(*)::int as n from idempotency_keys where created_at < app_now() - interval '24 hours'"))[0].n).toBe(0);
  });
});

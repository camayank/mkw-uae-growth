import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { memoryTransport, recordingNotifier } from "../src/lib/notify.ts";
import { writeOutbox } from "../src/lib/outbox.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

/** O11 event outbox: written with the change, delivered once, retried on refusal, never re-sent on its own. */

const minutes = (env: TestEnv, m: number) => {
  env.clock.now = new Date(env.clock.now.getTime() + m * 60_000);
};
const rows = <T = any>(env: TestEnv, sql: string, params: unknown[] = []) => asPlatform(env.db, null, async (tx) => (await tx.query<T & Record<string, unknown>>(sql, params)).rows);
const offerReady = (offerId: string) => ({ to: EMAILS.client, channel: "email" as const, template: "offer_ready" as const, vars: { offerId } });

describe("event outbox", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("writes the message with the change: a rollback leaves no row and sends nothing", async () => {
    const before = env.emails.length;
    await asPlatform(env.db, null, async (tx) => {
      await env.notify.send(offerReady("never"));
      expect((await tx.query("select 1 from outbox where payload->'vars'->>'offerId' = 'never'")).rows).toHaveLength(1); // same transaction
      throw new Error("rollback");
    }).catch(() => undefined);
    await env.notify.dispatch();
    expect(await rows(env, "select 1 from outbox where payload->'vars'->>'offerId' = 'never'")).toEqual([]);
    expect(env.emails.length).toBe(before);
  });

  it("delivers a committed message exactly once, however many dispatchers run", async () => {
    const before = env.emails.length;
    // A second app task on the same database, with its own transport: it must not send what the first one sends.
    const other = memoryTransport();
    const second = recordingNotifier({ db: env.db, transport: other, appUrl: "https://app.test", fromClient: "a@b.test", fromPartner: "c@d.test", now: () => env.clock.now, log: () => undefined });
    await asPlatform(env.db, null, () => env.notify.send(offerReady("once")));
    await Promise.all([env.notify.dispatch(), second.dispatch(), env.notify.flush(), second.dispatch()]);
    await env.notify.flush();
    expect(env.emails.length + other.delivered.length - before).toBe(1);
    const [row] = await rows(env, "select o.status, o.attempts, (select count(*)::int from notifications n where n.outbox_id = o.id) as records from outbox o where payload->'vars'->>'offerId' = 'once'");
    expect(row).toMatchObject({ status: "done", attempts: 1, records: 1 });
  });

  it("retries a refusal after 1, 5, 15 and 60 minutes, then waits for a person", async () => {
    env.transport.failNext = "SES: throttled";
    await asPlatform(env.db, null, () => env.notify.send(offerReady("refused")));
    await env.notify.flush();
    let [row] = await rows(env, "select id, status, attempts, last_error, next_attempt_at from outbox where payload->'vars'->>'offerId' = 'refused'");
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_error: "SES: throttled" });
    expect(new Date(row.next_attempt_at).getTime() - env.clock.now.getTime()).toBe(60_000);
    // Not due yet: nothing happens.
    await env.notify.dispatch();
    expect((await rows(env, "select attempts from outbox where id = $1", [row.id]))[0].attempts).toBe(1);
    for (const wait of [1, 5, 15, 60]) {
      minutes(env, wait);
      env.transport.failNext = "SES: throttled";
      await env.notify.dispatch();
    }
    [row] = await rows(env, "select id, status, attempts from outbox where id = $1", [row.id]);
    expect(row).toMatchObject({ status: "failed", attempts: 5 });
    // One record of the message, marked failed; the failure is audited without the provider's words.
    expect(await rows(env, "select status from notifications where outbox_id = $1", [row.id])).toEqual([{ status: "failed" }]);
    const [audit] = await rows(env, "select data from audit_events where action = 'outbox.failed' and entity_id = $1", [String(row.id)]);
    expect(audit.data).toEqual({ topic: "notify", attempts: 5 });
    // It sits in the ops queue with Retry and Cancel; retrying sends it once.
    const queue = (await env.call("ops", "GET", "/api/ops/queue")).body.items;
    const item = queue.find((i: any) => i.id === `delivery_failed:${row.id}`);
    expect(item.why).toMatch(/refused offer ready 5 time\(s\)/);
    expect(item.actions.map((a: any) => a.label)).toEqual(["Retry", "Cancel"]);
    const before = env.emails.length;
    expect((await env.call("ops", "POST", `/api/ops/outbox/${row.id}/resolve`, { action: "retry", note: "SES limit raised" })).status).toBe(200);
    await env.notify.dispatch();
    expect(env.emails.length).toBe(before + 1);
    expect(await rows(env, "select status from notifications where outbox_id = $1", [row.id])).toEqual([{ status: "sent" }]);
    expect((await rows(env, "select status from outbox where id = $1", [row.id]))[0].status).toBe("done");
  });

  it("never re-sends a message whose delivery was not recorded: a person decides", async () => {
    // A process died after handing the email to the provider and before recording the answer.
    // Written straight to the outbox, as a process that then died would have left it: send() would also kick a
    // background run, which on PostgreSQL can race the set-up below and settle the claim before the dispatch measured.
    await asPlatform(env.db, null, (tx) => writeOutbox(tx, "notify", offerReady("in-doubt") as unknown as Record<string, unknown>));
    const [row] = await rows(env, "select id from outbox where payload->'vars'->>'offerId' = 'in-doubt'");
    await asPlatform(env.db, null, async (tx) => {
      await tx.query("update outbox set status = 'sending', attempts = 1, claimed_at = $2::timestamptz - interval '11 minutes' where id = $1", [row.id, env.clock.now.toISOString()]);
      await tx.query("insert into notifications (to_email, channel, template, audience, subject, body, status, outbox_id) values ($1, 'email', 'offer_ready', 'client', 's', 'b', 'queued', $2)", [EMAILS.client, row.id]);
    });
    const before = env.emails.length;
    const summary = await env.notify.dispatch();
    expect(summary.unknown).toBe(1);
    expect(env.emails.length).toBe(before);
    expect((await rows(env, "select status from outbox where id = $1", [row.id]))[0].status).toBe("unknown");
    await env.notify.dispatch(); // still nothing
    expect(env.emails.length).toBe(before);
    const item = (await env.call("ops", "GET", "/api/ops/queue")).body.items.find((i: any) => i.id === `delivery_unknown:${row.id}`);
    expect(item.actions.map((a: any) => a.label)).toEqual(["Mark delivered", "Send again", "Cancel"]);
    expect(item.why).toMatch(/not re-sent on its own/);
    // Only MKW ops settles it, with a reason.
    for (const who of ["client", "setup", "finance"]) expect((await env.call(who, "POST", `/api/ops/outbox/${row.id}/resolve`, { action: "mark_delivered", note: "x" })).status).toBe(403);
    expect((await env.call("ops", "POST", `/api/ops/outbox/${row.id}/resolve`, { action: "mark_delivered" })).status).toBe(400);
    expect((await env.call("ops", "POST", `/api/ops/outbox/${row.id}/resolve`, { action: "mark_delivered", note: "Client confirmed by phone" })).status).toBe(200);
    expect(await rows(env, "select status from notifications where outbox_id = $1", [row.id])).toEqual([{ status: "sent" }]);
    expect((await rows(env, "select status, resolution from outbox where id = $1", [row.id]))[0]).toEqual({ status: "done", resolution: "marked delivered: Client confirmed by phone" });
    expect(await rows(env, "select data->>'note' as note from audit_events where action = 'outbox.mark_delivered' and entity_id = $1", [String(row.id)])).toEqual([{ note: "Client confirmed by phone" }]);
    // Settled once: a second decision is refused.
    expect((await env.call("ops", "POST", `/api/ops/outbox/${row.id}/resolve`, { action: "retry" })).status).toBe(409);
  });

  it("never retries a delivery that timed out: the provider may have taken it", async () => {
    env.transport.inDoubtNext = true;
    const before = env.emails.length;
    await asPlatform(env.db, null, () => env.notify.send(offerReady("timed-out")));
    await env.notify.flush();
    expect(env.emails.length).toBe(before + 1); // it went, but nobody was told
    const [row] = await rows(env, "select id, status, attempts from outbox where payload->'vars'->>'offerId' = 'timed-out'");
    expect(row).toMatchObject({ status: "unknown", attempts: 1 });
    for (const wait of [1, 5, 15, 60]) {
      minutes(env, wait);
      await env.notify.dispatch();
    }
    expect(env.emails.length).toBe(before + 1);
    expect(await rows(env, "select status from notifications where outbox_id = $1", [row.id])).toEqual([{ status: "queued" }]);
    // Ops checks, then sends it again on purpose or cancels it: both audited with their reason.
    expect((await env.call("ops", "POST", `/api/ops/outbox/${row.id}/resolve`, { action: "retry", note: "Client says it never arrived" })).status).toBe(200);
    await env.notify.dispatch();
    expect(env.emails.length).toBe(before + 2);
    expect(await rows(env, "select status from notifications where outbox_id = $1", [row.id])).toEqual([{ status: "sent" }]);
    env.transport.failNext = "SES: rejected";
    await asPlatform(env.db, null, () => env.notify.send(offerReady("to-cancel")));
    await env.notify.flush();
    for (const wait of [1, 5, 15, 60]) {
      minutes(env, wait);
      env.transport.failNext = "SES: rejected";
      await env.notify.dispatch();
    }
    const [failed] = await rows(env, "select id, status from outbox where payload->'vars'->>'offerId' = 'to-cancel'");
    expect(failed.status).toBe("failed");
    expect((await env.call("ops", "POST", `/api/ops/outbox/${failed.id}/resolve`, { action: "cancel" })).status).toBe(400);
    expect((await env.call("ops", "POST", `/api/ops/outbox/${failed.id}/resolve`, { action: "cancel", note: "Offer withdrawn" })).status).toBe(200);
    expect(await rows(env, "select action, data->>'note' as note from audit_events where entity = 'outbox' and entity_id = any($1) and action in ('outbox.retry', 'outbox.cancel') order by id", [[String(row.id), String(failed.id)]])).toEqual([
      { action: "outbox.retry", note: "Client says it never arrived" },
      { action: "outbox.cancel", note: "Offer withdrawn" },
    ]);
    expect(await rows(env, "select status from notifications where outbox_id = $1", [failed.id])).toEqual([{ status: "skipped" }]);
  });

  it("a message the provider took but that could not be recorded is in doubt, never resent", async () => {
    // The provider accepts the email; recording "sent" then fails (here: a constraint added for the moment).
    const transport = memoryTransport();
    const real = transport.deliver.bind(transport);
    transport.deliver = async (email) => {
      const r = await real(email);
      await env.db.exec("alter table notifications add constraint no_sent_now check (status <> 'sent') not valid");
      return r;
    };
    const n = recordingNotifier({ db: env.db, transport, appUrl: "https://app.test", fromClient: "a@b.test", fromPartner: "c@d.test", now: () => env.clock.now, log: () => undefined });
    await asPlatform(env.db, null, () => n.send(offerReady("unrecorded")));
    await n.dispatch();
    await env.db.exec("alter table notifications drop constraint no_sent_now");
    expect(transport.delivered).toHaveLength(1);
    const [row] = await rows(env, "select id, status from outbox where payload->'vars'->>'offerId' = 'unrecorded'");
    expect(row.status).toBe("unknown");
    expect(await rows(env, "select status from notifications where outbox_id = $1", [row.id])).toEqual([{ status: "queued" }]);
    for (const wait of [1, 5, 15, 60]) {
      minutes(env, wait);
      await n.dispatch();
    }
    expect(transport.delivered).toHaveLength(1);
  });

  it("a run that outlived its claim changes nothing a recovery or a person decided since", async () => {
    // The handler hangs past the 10-minute lease; meanwhile another process recovers the row and ops cancels it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = recordingNotifier({ db: env.db, transport: memoryTransport(), appUrl: "https://app.test", fromClient: "a@b.test", fromPartner: "c@d.test", now: () => env.clock.now, log: () => undefined });
    slow.on("document_check", { handle: () => gate, check: async () => "not_done" });
    await asPlatform(env.db, null, () => slow.emit("document_check", { subject: "evidence", id: "00000000-0000-0000-0000-000000000000" }));
    const [row] = await rows(env, "select id from outbox where topic = 'document_check' order by id desc limit 1");
    const running = slow.dispatch();
    for (let i = 0; i < 50 && (await rows(env, "select status from outbox where id = $1", [row.id]))[0].status !== "sending"; i++) await new Promise((r) => setTimeout(r, 10));
    await asPlatform(env.db, null, (tx) => tx.query("update outbox set status = 'cancelled', resolution = 'cancelled: test' where id = $1", [row.id]));
    release();
    await running;
    expect((await rows(env, "select status from outbox where id = $1", [row.id]))[0].status).toBe("cancelled");
  });

  it("resends a message whose claim was abandoned before anything was handed over", async () => {
    // Straight to the outbox (no background run to race the set-up), as in the test above.
    await asPlatform(env.db, null, (tx) => writeOutbox(tx, "notify", offerReady("never-handed") as unknown as Record<string, unknown>));
    const [row] = await rows(env, "select id from outbox where payload->'vars'->>'offerId' = 'never-handed'");
    await asPlatform(env.db, null, (tx) => tx.query("update outbox set status = 'sending', attempts = 1, claimed_at = $2::timestamptz - interval '11 minutes' where id = $1", [row.id, env.clock.now.toISOString()]));
    const before = env.emails.length;
    await env.notify.dispatch();
    expect(env.emails.length).toBe(before + 1);
    expect((await rows(env, "select status, attempts from outbox where id = $1", [row.id]))[0]).toEqual({ status: "done", attempts: 2 });
  });

  it("keeps sign-in codes out of the outbox (the code is never written down)", async () => {
    await env.call("anon", "POST", "/api/auth/request-code", { email: EMAILS.ops });
    await env.notify.flush();
    expect(await rows(env, "select 1 from outbox where payload->>'template' = 'login_code'")).toEqual([]);
    expect(env.emails.at(-1)!.subject).toMatch(/sign-in code/i);
  });

  it("cancels an erased person's unsent messages and removes their address", async () => {
    const orgs = (await env.call("founder", "GET", "/api/admin/orgs")).body;
    const member = orgs.flatMap((o: any) => o.users).find((u: any) => u.email === EMAILS.clientMember);
    env.transport.failNext = "SES: mailbox unavailable";
    await asPlatform(env.db, null, () => env.notify.send({ ...offerReady("to-erase"), to: EMAILS.clientMember }));
    await env.notify.flush();
    expect((await env.call("founder", "POST", `/api/admin/users/${member.id}/erase`, { confirm: "ERASE", reason: "Asked to be forgotten" })).status).toBe(200);
    const [row] = await rows(env, "select status, payload from outbox where payload->'vars' = '{}'::jsonb and payload->>'template' = 'offer_ready' order by id desc limit 1");
    expect(row.status).toBe("cancelled");
    expect(JSON.stringify(row.payload)).not.toContain(EMAILS.clientMember);
    expect(await rows(env, "select 1 from outbox where (last_error like $1 or resolution like $1)", [`%${EMAILS.clientMember}%`])).toEqual([]);
    expect(await rows(env, "select 1 from outbox where payload::text like $1", [`%${EMAILS.clientMember}%`])).toEqual([]);
  });
});

import { asPlatform, audit, txScope, type SessionUser } from "./context.ts";
import type { Database, Queryable } from "./db.ts";
import { conflict, forbidden, notFound } from "./errors.ts";

/**
 * The event outbox (O11). A side effect is a row written in the same transaction as the change that causes it, so
 * it exists exactly when the change does; the dispatcher delivers it afterwards.
 *
 *   pending   waiting (or waiting for its next retry)
 *   sending   claimed by a dispatcher; the handler is running
 *   done      delivered and recorded
 *   failed    refused five times: a person retries or cancels it
 *   unknown   the process stopped between handing the message over and recording the result: a person decides
 *             whether to send it again or mark it delivered. Nothing is ever sent twice on its own.
 *   cancelled a person decided it should not go
 */
export type Topic = "notify" | "document_check";
export const TOPICS: Topic[] = ["notify", "document_check"];

export interface OutboxRow {
  id: number;
  topic: Topic;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * What a handler reports when a stale claim is found: whether the side effect is known to have happened, known not
 * to have happened, or cannot be known.
 */
export type ClaimCheck = "done" | "not_done" | "unknown";

export interface TopicHandler {
  handle(row: OutboxRow): Promise<void>;
  /** For a claim abandoned mid-run (the process stopped): did the side effect happen? */
  check(row: OutboxRow): Promise<ClaimCheck>;
}

/** Minutes to wait before attempt 2, 3, 4 and 5; the fifth refusal is final. */
export const RETRY_MINUTES = [1, 5, 15, 60];
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
/** A claim older than this was abandoned (a delivery itself times out long before). */
export const CLAIM_LEASE_MINUTES = 10;

/** Write an outbox row in the given transaction. No RETURNING: clients and partners may insert but never read. */
export async function writeOutbox(tx: Queryable, topic: Topic, payload: Record<string, unknown>): Promise<void> {
  await tx.query("insert into outbox (topic, payload) values ($1, $2)", [topic, JSON.stringify(payload)]);
}

/**
 * Write a row in the caller's transaction when there is one, otherwise in its own; `after` runs once the row is
 * committed (to wake the dispatcher).
 */
export async function emit(db: Database, topic: Topic, payload: Record<string, unknown>, after: () => void): Promise<void> {
  const scope = txScope.getStore();
  if (scope?.tx) {
    await writeOutbox(scope.tx, topic, payload);
    scope.deferred.push({ run: after });
    return;
  }
  await asPlatform(db, null, (tx) => writeOutbox(tx, topic, payload));
  after();
}

export interface DispatchSummary {
  done: number;
  retried: number;
  failed: number;
  unknown: number;
  recovered: number;
}

export interface Dispatcher {
  on(topic: Topic, handler: TopicHandler): void;
  /** Note that work is waiting; `runIfDirty` then dispatches. */
  kick(): void;
  /** Dispatch only if this process wrote something since the last run (cheap enough for every response). */
  runIfDirty(): Promise<DispatchSummary | null>;
  /** Recover abandoned claims, then deliver everything due. Concurrent calls share one run. */
  run(): Promise<DispatchSummary>;
}

export function createDispatcher(db: Database, log: (msg: string) => void = (m) => console.error(m)): Dispatcher {
  const handlers = new Map<Topic, TopicHandler>();
  let dirty = false;
  let running: Promise<DispatchSummary> | null = null;
  let again = false;

  const recover = async (s: DispatchSummary) => {
    const stale = await asPlatform(db, null, async (tx) =>
      (
        await tx.query<OutboxRow>(
          `select id, topic, payload, attempts from outbox
           where status = 'sending' and claimed_at < app_now() - make_interval(mins => $1) and topic = any($2) order by id`,
          [CLAIM_LEASE_MINUTES, [...handlers.keys()]],
        )
      ).rows,
    );
    for (const row of stale) {
      const verdict = await handlers.get(row.topic)!.check(row).catch(() => "unknown" as const);
      await asPlatform(db, null, async (tx) => {
        if (verdict === "done") await tx.query("update outbox set status = 'done', done_at = app_now() where id = $1 and status = 'sending'", [row.id]);
        else if (verdict === "not_done") await tx.query(`update outbox set status = case when attempts >= $2 then 'failed' else 'pending' end, next_attempt_at = app_now(), last_error = coalesce(last_error, 'claim abandoned before delivery') where id = $1 and status = 'sending'`, [row.id, MAX_ATTEMPTS]);
        else await tx.query("update outbox set status = 'unknown', last_error = 'delivery started but its result was never recorded' where id = $1 and status = 'sending'", [row.id]);
        await audit(tx, null, `outbox.claim_${verdict}`, "outbox", String(row.id), { topic: row.topic });
      });
      if (verdict === "unknown") s.unknown += 1;
      else s.recovered += 1;
    }
  };

  const claim = () =>
    asPlatform(db, null, async (tx) =>
      (
        await tx.query<OutboxRow>(
          `update outbox set status = 'sending', claimed_at = app_now(), attempts = attempts + 1
           where id = (select id from outbox where status = 'pending' and (attempts = 0 or next_attempt_at <= app_now()) and topic = any($1)
                       order by id limit 1 for update skip locked)
           returning id, topic, payload, attempts`,
          [[...handlers.keys()]],
        )
      ).rows[0],
    );

  const once = async (): Promise<DispatchSummary> => {
    const s: DispatchSummary = { done: 0, retried: 0, failed: 0, unknown: 0, recovered: 0 };
    if (!handlers.size) return s;
    await recover(s);
    for (let row = await claim(); row; row = await claim()) {
      try {
        await handlers.get(row.topic)!.handle(row);
        await asPlatform(db, null, (tx) => tx.query("update outbox set status = 'done', done_at = app_now(), last_error = null where id = $1", [row.id]));
        s.done += 1;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        const final = row.attempts >= MAX_ATTEMPTS;
        log(`[outbox] ${row.topic} #${row.id} attempt ${row.attempts} failed${final ? " (final)" : ""}: ${msg}`);
        await asPlatform(db, null, async (tx) => {
          await tx.query(
            final
              ? "update outbox set status = 'failed', last_error = $2 where id = $1"
              : "update outbox set status = 'pending', last_error = $2, next_attempt_at = app_now() + make_interval(mins => $3) where id = $1",
            final ? [row.id, msg] : [row.id, msg, RETRY_MINUTES[row.attempts - 1]],
          );
          if (final) await audit(tx, null, "outbox.failed", "outbox", String(row.id), { topic: row.topic, attempts: row.attempts });
        });
        if (final) s.failed += 1;
        else s.retried += 1;
      }
    }
    return s;
  };

  const run = (): Promise<DispatchSummary> => {
    if (running) {
      again = true;
      return running;
    }
    dirty = false;
    const r = (async () => {
      const total = await once();
      // Work written while this run was going is picked up before the run reports back.
      while (again) {
        again = false;
        const more = await once();
        for (const k of Object.keys(total) as Array<keyof DispatchSummary>) total[k] += more[k];
      }
      return total;
    })().finally(() => {
      running = null;
    });
    running = r;
    return r;
  };

  return {
    on(topic, handler) {
      handlers.set(topic, handler);
    },
    kick() {
      dirty = true;
      setImmediate(() => void run().catch((e) => log(`[outbox] dispatch failed: ${(e as Error).message}`)));
    },
    async runIfDirty() {
      return dirty || running ? run() : null;
    },
    run,
  };
}

// Staff actions on rows that need a person -------------------------------------------------------------------------

export async function outboxAttention(tx: Queryable) {
  return (
    await tx.query<{ id: number; topic: Topic; status: "failed" | "unknown"; attempts: number; last_error: string | null; created_at: string; template: string | null; to_email: string | null }>(
      `select o.id, o.topic, o.status, o.attempts, o.last_error, o.created_at::text, o.payload->>'template' as template, o.payload->>'to' as to_email
         from outbox o where o.status in ('failed', 'unknown') and o.topic = 'notify' order by o.id`,
    )
  ).rows;
}

/**
 * A person settles a message that needs one: send it again (failed or unknown), mark it delivered (unknown only:
 * they checked it arrived), or cancel it. Audited with their name.
 */
export async function resolveOutbox(tx: Queryable, actor: SessionUser, id: number, action: "retry" | "mark_delivered" | "cancel", note: string) {
  if (!["ops", "founder"].includes(actor.role)) throw forbidden("Only MKW ops settles undelivered messages");
  const row = (await tx.query<{ status: string; topic: string }>("select status, topic from outbox where id = $1 for update", [id])).rows[0];
  if (!row) throw notFound("Message not found");
  if (!["failed", "unknown"].includes(row.status)) throw conflict(`This message is ${row.status}; nothing to settle`);
  if (action === "mark_delivered" && row.status !== "unknown") throw conflict("Only a message whose delivery is not confirmed can be marked delivered");
  if (action === "retry") {
    await tx.query("update outbox set status = 'pending', attempts = 0, next_attempt_at = app_now(), resolved_by = $2, resolution = $3 where id = $1", [id, actor.id, `retry: ${note}`]);
    // The record of the earlier try stays; the new try reuses it so the bell and the delivery log show one message.
    await tx.query("update notifications set status = 'failed', error = coalesce(error, 'resent by MKW') where outbox_id = $1 and status = 'queued'", [id]);
  } else if (action === "mark_delivered") {
    await tx.query("update outbox set status = 'done', done_at = app_now(), resolved_by = $2, resolution = $3 where id = $1", [id, actor.id, `marked delivered: ${note}`]);
    await tx.query("update notifications set status = 'sent', sent_at = coalesce(sent_at, app_now()), error = null where outbox_id = $1", [id]);
  } else {
    await tx.query("update outbox set status = 'cancelled', resolved_by = $2, resolution = $3 where id = $1", [id, actor.id, `cancelled: ${note}`]);
    await tx.query("update notifications set status = 'skipped', error = 'cancelled by MKW' where outbox_id = $1 and status <> 'sent'", [id]);
  }
  await audit(tx, actor, `outbox.${action}`, "outbox", String(id), { before: row.status, note });
  return { ok: true };
}

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
  /**
   * The claim this run holds, as exact text (Postgres keeps microseconds, a JavaScript Date does not); every update
   * after the handler checks it is still the same claim.
   */
  claimed_at?: string;
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

/**
 * Thrown by a handler when it cannot know whether its side effect happened (a timeout or a dropped connection after
 * the request left): the row becomes `unknown` at once and a person decides. Any other error is a refusal and is
 * retried.
 */
export class InDoubtError extends Error {
  readonly inDoubt = true;
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
  let next: Promise<DispatchSummary> | null = null;

  const recover = async (s: DispatchSummary) => {
    const stale = await asPlatform(db, null, async (tx) =>
      (
        await tx.query<OutboxRow>(
          `select id, topic, payload, attempts, claimed_at::text as claimed_at from outbox
           where status = 'sending' and claimed_at < app_now() - make_interval(mins => $1) and topic = any($2) order by id`,
          [CLAIM_LEASE_MINUTES, [...handlers.keys()]],
        )
      ).rows,
    );
    for (const row of stale) {
      const verdict = await handlers.get(row.topic)!.check(row).catch(() => "unknown" as const);
      // Each update re-checks the claim, so two processes recovering the same row change (and audit) it once.
      const changed = await asPlatform(db, null, async (tx) => {
        const r =
          verdict === "done"
            ? await tx.query("update outbox set status = 'done', done_at = app_now() where id = $1 and status = 'sending' and claimed_at = $2::timestamptz returning id", [row.id, row.claimed_at])
            : verdict === "not_done"
              ? await tx.query(`update outbox set status = case when attempts >= $3 then 'failed' else 'pending' end, next_attempt_at = app_now(), last_error = coalesce(last_error, 'claim abandoned before delivery') where id = $1 and status = 'sending' and claimed_at = $2::timestamptz returning id`, [row.id, row.claimed_at, MAX_ATTEMPTS])
              : await tx.query("update outbox set status = 'unknown', last_error = 'delivery started but its result was never recorded' where id = $1 and status = 'sending' and claimed_at = $2::timestamptz returning id", [row.id, row.claimed_at]);
        if (r.rows.length) await audit(tx, null, `outbox.claim_${verdict}`, "outbox", String(row.id), { topic: row.topic });
        return r.rows.length > 0;
      });
      if (!changed) continue;
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
           returning id, topic, payload, attempts, claimed_at::text as claimed_at`,
          [[...handlers.keys()]],
        )
      ).rows[0],
    );

  const once = async (): Promise<DispatchSummary> => {
    const s: DispatchSummary = { done: 0, retried: 0, failed: 0, unknown: 0, recovered: 0 };
    if (!handlers.size) return s;
    await recover(s);
    for (let row = await claim(); row; row = await claim()) {
      // A handler that outlived its claim (recovered or settled by a person meanwhile) changes nothing afterwards.
      const ours = "id = $1 and status = 'sending' and claimed_at = $2::timestamptz";
      try {
        await handlers.get(row.topic)!.handle(row);
        await asPlatform(db, null, (tx) => tx.query(`update outbox set status = 'done', done_at = app_now(), last_error = null where ${ours}`, [row.id, row.claimed_at]));
        s.done += 1;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        if ((e as InDoubtError).inDoubt) {
          log(`[outbox] ${row.topic} #${row.id}: delivery in doubt, left for a person: ${msg}`);
          await asPlatform(db, null, async (tx) => {
            const r = await tx.query(`update outbox set status = 'unknown', last_error = $3 where ${ours} returning id`, [row.id, row.claimed_at, msg]);
            if (r.rows.length) await audit(tx, null, "outbox.claim_unknown", "outbox", String(row.id), { topic: row.topic });
          });
          s.unknown += 1;
          continue;
        }
        const final = row.attempts >= MAX_ATTEMPTS;
        log(`[outbox] ${row.topic} #${row.id} attempt ${row.attempts} failed${final ? " (final)" : ""}: ${msg}`);
        await asPlatform(db, null, async (tx) => {
          const r = await tx.query(
            final
              ? `update outbox set status = 'failed', last_error = $3 where ${ours} returning id`
              : `update outbox set status = 'pending', last_error = $3, next_attempt_at = app_now() + make_interval(mins => $4) where ${ours} returning id`,
            final ? [row.id, row.claimed_at, msg] : [row.id, row.claimed_at, msg, RETRY_MINUTES[row.attempts - 1]],
          );
          if (final && r.rows.length) await audit(tx, null, "outbox.failed", "outbox", String(row.id), { topic: row.topic, attempts: row.attempts });
        });
        if (final) s.failed += 1;
        else s.retried += 1;
      }
    }
    return s;
  };

  const run = (): Promise<DispatchSummary> => {
    // Asked while a run is going: one more run follows it, shared by every caller who asked meanwhile, so work
    // written during the current run is delivered before any of them is answered.
    if (running) {
      next ??= running.then(
        () => {
          next = null;
          return run();
        },
        () => {
          next = null;
          return run();
        },
      );
      return next;
    }
    dirty = false;
    const r = once().finally(() => {
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

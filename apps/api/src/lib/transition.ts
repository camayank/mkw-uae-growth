/**
 * The one way milestones, offers and engagements change status (O13). `transition()` locks the row, checks the
 * transition table in `packages/core/src/states.ts` for who may make the move, sets the status with the timestamp
 * that goes with it, and writes the audit event. Two requests racing for the same row cannot both pass: the second
 * waits for the lock, then finds the status already moved and is refused with what can happen next.
 * `test/transitions.test.ts` fails if any other code updates these statuses.
 */
import { assertTransition, type Actor, type MachineName } from "@tasees/core";
import { audit, lockAuditChain, type SessionUser } from "./context.ts";
import type { Queryable } from "./db.ts";
import { notFound } from "./errors.ts";

const TABLE: Record<MachineName, string> = { milestone: "milestones", offer: "offers", engagement: "engagements" };

/** Columns set by the move itself, by machine and destination. Fixed SQL: no input reaches it. */
const STAMPS: Record<MachineName, Record<string, string>> = {
  milestone: {
    "*": "updated_at = app_now()",
    evidence_submitted: "first_submitted_at = coalesce(first_submitted_at, app_now())",
    qa_passed: "qa_passed_at = app_now()",
  },
  offer: { published: "published_at = app_now()", accepted: "accepted_at = app_now()" },
  engagement: { completed: "completed_at = app_now()" },
};

/** Other columns a move may carry (a QA note, a dispute reason), by machine. Values are bound parameters. */
const EXTRA: Record<MachineName, string[]> = {
  milestone: ["qa_note", "dispute_reason"],
  offer: [],
  engagement: [],
};

export interface TransitionOptions {
  /** The audit event for the move; its from and to are added to the data. Default: `<machine>.status_changed`. */
  audit?: { actor: SessionUser | null; action: string; entity?: string; data?: Record<string, unknown> };
  /** Who made the move, for the default audit event (null: the platform's own rule, such as a sweep). */
  actor?: SessionUser | null;
  set?: Record<string, string | null>;
  /** When the row is already in `to`, do nothing instead of refusing (for sweeps that may meet a moved row). */
  idempotent?: boolean;
}

export async function transition(
  tx: Queryable,
  machine: MachineName,
  id: string,
  to: string,
  by: Actor,
  opts: TransitionOptions = {},
): Promise<{ from: string; changed: boolean }> {
  const table = TABLE[machine];
  await lockAuditChain(tx); // the lock order: audit chain first, then the row (lib/context.ts)
  const row = (await tx.query<{ status: string }>(`select status from ${table} where id = $1 for update`, [id])).rows[0];
  if (!row) throw notFound(`${machine[0]!.toUpperCase()}${machine.slice(1)} not found`);
  if (opts.idempotent && row.status === to) return { from: row.status, changed: false };
  assertTransition(machine, row.status, to, by);
  const sets = ["status = $2"];
  const params: unknown[] = [id, to];
  for (const stamp of [STAMPS[machine]["*"], STAMPS[machine][to]]) if (stamp) sets.push(stamp);
  for (const [col, value] of Object.entries(opts.set ?? {})) {
    if (!EXTRA[machine].includes(col)) throw new Error(`transition: ${col} is not a column a ${machine} move may set`);
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  params.push(row.status);
  await tx.query(`update ${table} set ${sets.join(", ")} where id = $1 and status = $${params.length}`, params);
  // Every move is audited (rule 8): with the caller's own event, or a plain one naming the move.
  const a = opts.audit ?? { actor: opts.actor ?? null, action: `${machine}.status_changed` };
  await audit(tx, a.actor, a.action, a.entity ?? machine, id, { ...(a.data ?? {}), from: row.status, to });
  return { from: row.status, changed: true };
}

/**
 * Withdraw a request's open offers (all, or all but the accepted one), each through `transition()`. Callers that
 * already hold one of the offers must first lock all of them in id order (see `lockRequestOffers`), or two calls
 * could each hold one offer and wait for the other's.
 */
export async function withdrawOffers(tx: Queryable, requestId: string, except: string | null = null, actor: SessionUser | null = null): Promise<number> {
  await lockAuditChain(tx);
  const open = await tx.query<{ id: string }>(
    "select id from offers where request_id = $1 and ($2::uuid is null or id <> $2) and status in ('draft', 'ops_review', 'published') order by id for update",
    [requestId, except],
  );
  for (const o of open.rows) await transition(tx, "offer", o.id, "withdrawn", "platform", { actor });
  return open.rows.length;
}

/** Lock every offer of a request, in id order: the first thing a change to one of them does (no deadlock). */
export async function lockRequestOffers(tx: Queryable, requestId: string): Promise<void> {
  await lockAuditChain(tx);
  await tx.query("select id from offers where request_id = $1 order by id for update", [requestId]);
}

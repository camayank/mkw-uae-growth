/**
 * The platform watching itself (O13): jobs runs and their steps, the nightly audit chain check, and alerts.
 * An alert is about the platform, never about a client or a partner, and carries no personal data: it says what
 * stopped and since when. One alert per kind and subject is open at a time; it is emailed to MKW's alert address
 * when it opens, every four hours while it stays open, and once when it clears.
 */
import { audit } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import type { Notifier } from "../lib/notify.ts";
import { verifyAuditChain } from "../lib/audit.ts";

/** The jobs run every 15 minutes; three missed runs is late. */
export const JOBS_LATE_MINUTES = 45;
/** A run still "running" after this long died; it is closed so the next run can start. */
export const RUN_LEASE_MINUTES = 30;
/** A message due this long ago and still not handed to the provider is stuck. */
export const OUTBOX_STUCK_MINUTES = 30;
export const REMIND_HOURS = 4;

export type AlertKind = "jobs_late" | "job_step_failed" | "outbox_stuck" | "audit_chain";

export interface StepResult {
  ms: number;
  count: number;
  error?: string;
}

/** Start a run, or return null when another run is in progress (only one at a time). */
export async function startRun(tx: Queryable): Promise<number | null> {
  await tx.query(
    `update job_runs set status = 'abandoned', finished_at = app_now(), error = 'did not finish within ${RUN_LEASE_MINUTES} minutes'
      where job = 'sweeps' and status = 'running' and started_at < app_now() - interval '${RUN_LEASE_MINUTES} minutes'`,
  );
  const r = await tx.query<{ id: number | string }>(
    "insert into job_runs (job) values ('sweeps') on conflict (job) where status = 'running' do nothing returning id",
  );
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

export async function finishRun(tx: Queryable, id: number, steps: Record<string, StepResult>, startedMs: number, error: string | null) {
  const failed = !!error || Object.values(steps).some((s) => s.error);
  await tx.query(
    `update job_runs set status = $2, finished_at = app_now(), duration_ms = $3, steps = $4::jsonb, error = $5 where id = $1 and status = 'running'`,
    [id, failed ? "failed" : "ok", Math.max(0, Date.now() - startedMs), JSON.stringify(steps), error],
  );
}

/** Verify the whole audit chain once per Dubai day. Returns the events checked, or 0 when today's check is done. */
export async function nightlyAuditCheck(tx: Queryable): Promise<number> {
  const done = (await tx.query("select 1 from audit_checks where day = (app_now() at time zone 'Asia/Dubai')::date")).rows.length;
  if (done) return 0;
  const result = await verifyAuditChain(tx);
  await tx.query(
    "insert into audit_checks (day, checked, broken_id) values ((app_now() at time zone 'Asia/Dubai')::date, $1, $2) on conflict (day) do nothing",
    [result.checked, result.brokenId],
  );
  return result.checked;
}

interface Condition {
  kind: AlertKind;
  subject: string;
  severity: "warning" | "critical";
  summary: string;
}

/** What is wrong right now. `since` is when this process started, for a platform whose jobs never ran at all. */
export async function currentConditions(tx: Queryable, since: Date | null): Promise<Condition[]> {
  const out: Condition[] = [];
  const last = (
    await tx.query<{ finished_at: string | null; minutes: number | string | null; steps: Record<string, StepResult> | null; any_run: boolean }>(
      `select r.finished_at::text, extract(epoch from (app_now() - r.finished_at)) / 60 as minutes, r.steps,
              exists (select 1 from job_runs) as any_run
         from (select 1) one left join lateral (
           select finished_at, steps from job_runs where job = 'sweeps' and status in ('ok', 'failed') order by finished_at desc limit 1
         ) r on true`,
    )
  ).rows[0]!;
  const now = (await tx.query<{ now: string }>("select app_now()::text as now")).rows[0]!.now;
  const lateSince = last.finished_at
    ? Number(last.minutes)
    : since
      ? (new Date(now).getTime() - since.getTime()) / 60_000
      : null;
  if (lateSince !== null && lateSince >= JOBS_LATE_MINUTES) {
    out.push({
      kind: "jobs_late",
      subject: "",
      severity: "critical",
      summary: last.finished_at
        ? `The scheduled jobs have not completed for ${Math.floor(lateSince)} minutes (they run every 15). Reminders, auto-approvals and messages wait until they do.`
        : `The scheduled jobs have not completed once since the platform started ${Math.floor(lateSince)} minutes ago.`,
    });
  }
  for (const [step, r] of Object.entries(last.steps ?? {})) {
    if (r.error) {
      out.push({ kind: "job_step_failed", subject: step, severity: "warning", summary: `The "${step}" step failed in the last jobs run: ${scrub(r.error)}` });
    }
  }
  const stuck = (
    await tx.query<{ n: number | string; oldest: number | string | null }>(
      `select count(*) as n, max(extract(epoch from (app_now() - next_attempt_at)) / 60) as oldest
         from outbox where status = 'pending' and next_attempt_at < app_now() - interval '${OUTBOX_STUCK_MINUTES} minutes'`,
    )
  ).rows[0]!;
  if (Number(stuck.n) > 0) {
    out.push({
      kind: "outbox_stuck",
      subject: "",
      severity: "warning",
      summary: `${Number(stuck.n)} message(s) have been due for up to ${Math.floor(Number(stuck.oldest))} minutes and are not sent: the dispatcher is not running or cannot reach the provider.`,
    });
  }
  const check = (await tx.query<{ day: string; broken_id: number | string | null }>("select day::text, broken_id from audit_checks order by day desc limit 1")).rows[0];
  if (check && check.broken_id !== null) {
    out.push({
      kind: "audit_chain",
      subject: "",
      severity: "critical",
      summary: `The audit chain check on ${check.day} failed at event ${check.broken_id}: an audit row was changed or removed. Do not change anything else; follow the incident steps in docs/DEPLOY.md.`,
    });
  }
  return out;
}

/** Error text from a step can quote anything; keep it short and drop anything that looks like an email address. */
function scrub(error: string): string {
  return error.replace(/[^\s@]+@[^\s@]+/g, "[address]").slice(0, 160);
}

export interface AlertSweep {
  opened: number;
  reminded: number;
  closed: number;
}

/**
 * Open, remind and close alerts to match the current conditions. Emails go through the outbox to `alertEmail`; with
 * none set they are only logged (the alerts still show on the System page and at the top of the ops queue).
 */
export async function sweepAlerts(
  tx: Queryable,
  opts: { notify: Notifier; alertEmail?: string; since?: Date | null; log?: (line: Record<string, unknown>) => void },
): Promise<AlertSweep> {
  const result: AlertSweep = { opened: 0, reminded: 0, closed: 0 };
  const conditions = await currentConditions(tx, opts.since ?? null);
  const tell = async (state: "opened" | "reminder" | "resolved", a: { id: number | string; kind: string; severity: string; summary: string; opened_at: string; closed_at?: string | null }) => {
    opts.log?.({ msg: "alert", state, alert: Number(a.id), kind: a.kind, severity: a.severity });
    if (opts.alertEmail) {
      await opts.notify.send({
        to: opts.alertEmail,
        channel: "email",
        template: "ops_alert",
        vars: { state, kind: a.kind, severity: a.severity, summary: a.summary, openedAt: a.opened_at, closedAt: a.closed_at ?? "" },
      });
    }
    await tx.query("update alerts set last_notified_at = app_now() where id = $1", [a.id]);
  };
  for (const c of conditions) {
    const opened = (
      await tx.query<{ id: string; opened_at: string }>(
        `insert into alerts (kind, subject, severity, summary) values ($1, $2, $3, $4)
           on conflict (kind, subject) where closed_at is null do nothing returning id, opened_at::text`,
        [c.kind, c.subject, c.severity, c.summary],
      )
    ).rows[0];
    if (opened) {
      result.opened++;
      await audit(tx, null, "alert.opened", "alert", String(opened.id), { kind: c.kind, subject: c.subject, severity: c.severity });
      await tell("opened", { ...c, id: opened.id, opened_at: opened.opened_at });
      continue;
    }
    // Still open: keep its summary current, and remind every few hours.
    const due = (
      await tx.query<{ id: string; opened_at: string }>(
        `update alerts set summary = $3 where kind = $1 and subject = $2 and closed_at is null
           returning id, opened_at::text, (last_notified_at is null or last_notified_at < app_now() - interval '${REMIND_HOURS} hours') as due`,
        [c.kind, c.subject, c.summary],
      )
    ).rows[0] as { id: string; opened_at: string; due: boolean } | undefined;
    if (due?.due) {
      result.reminded++;
      await tell("reminder", { ...c, id: due.id, opened_at: due.opened_at });
    }
  }
  const open = (await tx.query<{ id: string; kind: string; subject: string; severity: string; summary: string; opened_at: string }>(
    "select id, kind, subject, severity, summary, opened_at::text from alerts where closed_at is null",
  )).rows;
  for (const a of open) {
    if (conditions.some((c) => c.kind === a.kind && c.subject === a.subject)) continue;
    const closed = (await tx.query<{ closed_at: string }>("update alerts set closed_at = app_now() where id = $1 and closed_at is null returning closed_at::text", [a.id])).rows[0];
    if (!closed) continue;
    result.closed++;
    await audit(tx, null, "alert.closed", "alert", String(a.id), { kind: a.kind, subject: a.subject });
    await tell("resolved", { ...a, closed_at: closed.closed_at });
  }
  return result;
}

/** For an external monitor: are the jobs keeping up? */
export async function jobHealth(tx: Queryable, since: Date | null) {
  const last = (await tx.query<{ finished_at: string | null; status: string | null }>(
    "select finished_at::text, status from job_runs where job = 'sweeps' and status in ('ok', 'failed') order by finished_at desc limit 1",
  )).rows[0];
  const late = (await currentConditions(tx, since)).some((c) => c.kind === "jobs_late");
  return { ok: !late, lastRunAt: last?.finished_at ?? null, lastStatus: last?.status ?? null, lateAfterMinutes: JOBS_LATE_MINUTES };
}

/** The System page: recent runs, the outbox backlog, open and recent alerts, the last audit checks. No personal data. */
export async function systemOverview(tx: Queryable) {
  const runs = (await tx.query(
    `select id, status, started_at::text as "startedAt", finished_at::text as "finishedAt", duration_ms as "durationMs", steps, error
       from job_runs order by started_at desc limit 20`,
  )).rows;
  const outbox = (await tx.query(
    `select status, count(*)::int as n, min(created_at)::text as oldest from outbox where status in ('pending', 'sending', 'failed', 'unknown') group by status order by status`,
  )).rows;
  const alerts = (await tx.query(
    `select id, kind, subject, severity, summary, opened_at::text as "openedAt", last_notified_at::text as "lastNotifiedAt", closed_at::text as "closedAt"
       from alerts where closed_at is null or closed_at > app_now() - interval '7 days' order by closed_at is null desc, opened_at desc limit 50`,
  )).rows;
  const auditChecks = (await tx.query(
    `select day::text, checked, broken_id as "brokenId", at::text from audit_checks order by day desc limit 7`,
  )).rows;
  return { runs, outbox, alerts, auditChecks, thresholds: { jobsLateMinutes: JOBS_LATE_MINUTES, outboxStuckMinutes: OUTBOX_STUCK_MINUTES, remindHours: REMIND_HOURS } };
}

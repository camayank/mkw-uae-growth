import { recomputeScorecards, sweepLicences } from "../services/partners.ts";
import { sweepDelays } from "../services/delivery.ts";
import { sweepObligations } from "../services/compliance.ts";
import { asPlatform, audit, type SessionUser } from "../lib/context.ts";
import type { Database } from "../lib/db.ts";
import type { DispatchSummary } from "../lib/outbox.ts";
import { sweepAllocationTimeouts, sweepAutoApprovals, type Deps } from "../services/engagements.ts";
import { expireOffers } from "../services/pricing.ts";
import { sendOpsDigest } from "../services/digest.ts";
import { refreshCurrentRules } from "../services/rules.ts";
import { opsQueue, syncQueueTimings } from "../services/queue.ts";
import { purgeIdempotencyKeys } from "../lib/idempotency.ts";
import { finishRun, nightlyAuditCheck, startRun, sweepAlerts, type AlertSweep, type StepResult } from "../services/system.ts";

export interface JobsOptions {
  /** One JSON-able line per step and per run (O13). */
  log?: (line: Record<string, unknown>) => void;
  /** MKW's alert address (ALERT_EMAIL); without it alerts are only logged and shown. */
  alertEmail?: string;
}

/**
 * Scheduled sweeps. Run every 15 minutes from cron (or `pnpm jobs`). Each sweep is its own transaction so one failure
 * does not block the others. Only one run at a time (O13): a run that finds another in progress is skipped. Every
 * run and every step is recorded in `job_runs` with its duration and count, for the System page and the alerts.
 */
export async function runJobs(db: Database, deps: Deps, actor: SessionUser | null = null, opts: JobsOptions = {}) {
  const result = { allocationTimeouts: 0, autoApprovals: 0, offersExpired: 0, opsDigests: 0, rulesRefreshed: 0, licences: 0, delays: 0, credits: 0, scorecards: 0, obligationReminders: 0, queueItems: 0, idempotencyPurged: 0, auditChecked: 0, alerts: null as AlertSweep | null, outbox: null as DispatchSummary | null, errors: [] as string[], skipped: false, runId: null as number | null };
  const startedMs = Date.now();
  const runId = await asPlatform(db, actor, (tx) => startRun(tx));
  if (runId === null) {
    result.skipped = true;
    opts.log?.({ msg: "jobs skipped: another run is in progress" });
    return result;
  }
  result.runId = runId;
  const steps: Record<string, StepResult> = {};
  const step = async (name: keyof Omit<typeof result, "errors" | "outbox" | "alerts" | "skipped" | "runId">, fn: () => Promise<number>) => {
    const t = Date.now();
    try {
      result[name] = await fn();
      steps[name] = { ms: Date.now() - t, count: result[name] };
    } catch (e) {
      result.errors.push(`${name}: ${(e as Error).message}`);
      steps[name] = { ms: Date.now() - t, count: 0, error: (e as Error).message };
    }
    opts.log?.({ msg: "jobs step", step: name, ...steps[name] });
  };
  await step("allocationTimeouts", () => asPlatform(db, actor, (tx) => sweepAllocationTimeouts(tx, deps)));
  await step("autoApprovals", () => asPlatform(db, actor, (tx) => sweepAutoApprovals(tx, deps)));
  await step("offersExpired", () => asPlatform(db, actor, (tx) => expireOffers(tx)));
  await step("opsDigests", () => asPlatform(db, actor, (tx) => sendOpsDigest(tx, deps)));
  await step("rulesRefreshed", () => asPlatform(db, actor, (tx) => refreshCurrentRules(tx)));
  // O6: licence watch daily, delay watch daily, scorecards weekly (Monday) or when none exists yet.
  await step("licences", () => asPlatform(db, actor, (tx) => sweepLicences(tx, deps.notify)));
  await step("delays", () =>
    asPlatform(db, actor, async (tx) => {
      const r = await sweepDelays(tx, deps);
      result.credits = r.credits;
      return r.delays;
    }),
  );
  await step("obligationReminders", () => asPlatform(db, actor, (tx) => sweepObligations(tx, deps.notify)));
  // Queue timings (O11): items that left the queue since anyone last looked get their resolution time.
  await step("queueItems", () =>
    asPlatform(db, actor, async (tx) => {
      const items = await opsQueue(tx, null, deps.now ? deps.now() : new Date());
      await syncQueueTimings(tx, items);
      return items.length;
    }),
  );
  await step("scorecards", () =>
    asPlatform(db, actor, async (tx) => {
      // Monday in Gulf time, or seven days since the last card (a missed Monday does not skip the week).
      const due = (await tx.query<{ due: boolean }>("select (extract(dow from (app_now() at time zone 'Asia/Dubai')) = 1 or not exists (select 1 from scorecards where computed_at > app_now() - interval '7 days')) and not exists (select 1 from scorecards where computed_at > app_now() - interval '6 days') as due")).rows[0]!.due;
      return due ? recomputeScorecards(tx, actor) : 0;
    }),
  );
  await step("idempotencyPurged", () => asPlatform(db, actor, (tx) => purgeIdempotencyKeys(tx)));
  // The whole audit chain, once per Dubai day (O13); a break opens a critical alert below.
  await step("auditChecked", () => asPlatform(db, actor, (tx) => nightlyAuditCheck(tx)));
  // Deliver what the sweeps raised, and anything a stopped process left in the outbox (O11).
  const t = Date.now();
  try {
    result.outbox = await deps.notify.dispatch();
    steps.outbox = { ms: Date.now() - t, count: result.outbox?.done ?? 0 };
  } catch (e) {
    result.errors.push(`outbox: ${(e as Error).message}`);
    steps.outbox = { ms: Date.now() - t, count: 0, error: (e as Error).message };
  }
  await asPlatform(db, actor, async (tx) => {
    await finishRun(tx, runId, steps, startedMs, null);
    await audit(tx, actor, "jobs.ran", "system", null, result);
  });
  // Alerts last, so this run's own failures count; their emails go out with the flush below.
  try {
    result.alerts = await asPlatform(db, actor, (tx) => sweepAlerts(tx, { notify: deps.notify, alertEmail: opts.alertEmail, log: opts.log }));
  } catch (e) {
    result.errors.push(`alerts: ${(e as Error).message}`);
  }
  opts.log?.({ msg: "jobs ran", runId, ms: Date.now() - startedMs, errors: result.errors.length });
  await deps.notify.flush();
  return result;
}

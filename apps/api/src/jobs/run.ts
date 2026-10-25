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

/**
 * Scheduled sweeps. Run every 15 minutes from cron (or `pnpm jobs`). Each sweep is its own
 * transaction so one failure does not block the others.
 */
export async function runJobs(db: Database, deps: Deps, actor: SessionUser | null = null) {
  const result = { allocationTimeouts: 0, autoApprovals: 0, offersExpired: 0, opsDigests: 0, rulesRefreshed: 0, licences: 0, delays: 0, credits: 0, scorecards: 0, obligationReminders: 0, queueItems: 0, outbox: null as DispatchSummary | null, errors: [] as string[] };
  const step = async (name: keyof Omit<typeof result, "errors" | "outbox">, fn: () => Promise<number>) => {
    try {
      result[name] = await fn();
    } catch (e) {
      result.errors.push(`${name}: ${(e as Error).message}`);
    }
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
  // Deliver what the sweeps raised, and anything a stopped process left in the outbox (O11).
  try {
    result.outbox = await deps.notify.dispatch();
  } catch (e) {
    result.errors.push(`outbox: ${(e as Error).message}`);
  }
  await asPlatform(db, actor, (tx) => audit(tx, actor, "jobs.ran", "system", null, result));
  await deps.notify.flush();
  return result;
}

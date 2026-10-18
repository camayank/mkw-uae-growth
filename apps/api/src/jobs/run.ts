import { asPlatform, audit, type SessionUser } from "../lib/context.ts";
import type { Database } from "../lib/db.ts";
import { sweepAllocationTimeouts, sweepAutoApprovals, type Deps } from "../services/engagements.ts";
import { expireOffers } from "../services/pricing.ts";

/**
 * Scheduled sweeps. Run every 15 minutes from cron (or `pnpm jobs`). Each sweep is its own
 * transaction so one failure does not block the others.
 */
export async function runJobs(db: Database, deps: Deps, actor: SessionUser | null = null) {
  const result = { allocationTimeouts: 0, autoApprovals: 0, offersExpired: 0, errors: [] as string[] };
  const step = async (name: keyof Omit<typeof result, "errors">, fn: () => Promise<number>) => {
    try {
      result[name] = await fn();
    } catch (e) {
      result.errors.push(`${name}: ${(e as Error).message}`);
    }
  };
  await step("allocationTimeouts", () => asPlatform(db, actor, (tx) => sweepAllocationTimeouts(tx, deps)));
  await step("autoApprovals", () => asPlatform(db, actor, (tx) => sweepAutoApprovals(tx, deps)));
  await step("offersExpired", () => asPlatform(db, actor, (tx) => expireOffers(tx)));
  await asPlatform(db, actor, (tx) => audit(tx, actor, "jobs.ran", "system", null, result));
  return result;
}

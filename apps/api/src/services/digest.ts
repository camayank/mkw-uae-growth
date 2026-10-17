import { dubaiDateHour, isUaeWorkingDay } from "@tasees/core";
import type { Queryable } from "../lib/db.ts";
import { exceptionQueue } from "./views.ts";
import type { Deps } from "./engagements.ts";

/**
 * The morning ops digest: an explicit, tested rule. Once per UAE working day, in the window 08:00 to 10:00 GST,
 * if no digest has gone out that day, every active ops and founder user receives the exception-queue counts.
 * Outside the window, on a weekend or holiday, or when one already went out today, nothing is sent.
 */
export const DIGEST_WINDOW = { fromHour: 8, toHour: 10 };

export async function sendOpsDigest(tx: Queryable, deps: Deps): Promise<number> {
  const now = deps.now ? deps.now() : new Date();
  if (!isUaeWorkingDay(now)) return 0;
  const { date, hour } = dubaiDateHour(now);
  if (hour < DIGEST_WINDOW.fromHour || hour >= DIGEST_WINDOW.toHour) return 0;
  const already = await tx.query(
    "select 1 from notifications where template = 'ops_digest' and (created_at at time zone 'Asia/Dubai')::date = $1::date limit 1",
    [date],
  );
  if (already.rows.length) return 0;
  const items = await exceptionQueue(tx);
  const counts: Record<string, number> = { total: items.length };
  for (const x of items) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
  const staff = (await tx.query<{ email: string }>("select email from users where role in ('ops', 'founder') and status = 'active' order by email")).rows;
  for (const u of staff) await deps.notify.send({ to: u.email, channel: "email", template: "ops_digest", vars: counts });
  return staff.length;
}

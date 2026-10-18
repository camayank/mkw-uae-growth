import { dubaiDateHour, isUaeWorkingDay } from "@tasees/core";
import type { Queryable } from "../lib/db.ts";
import { exceptionQueue } from "./views.ts";
import { loadCalendar } from "./calendar.ts";
import type { Deps } from "./engagements.ts";

/**
 * The morning ops digest: an explicit, tested rule. Once per UAE working day, in the window 08:00 to 10:00 GST,
 * if no digest has gone out that day, every active ops and founder user receives the exception-queue counts.
 * Outside the window, on a weekend or holiday, or when one already went out today, nothing is sent.
 */
export const DIGEST_WINDOW = { fromHour: 8, toHour: 10 };

export async function sendOpsDigest(tx: Queryable, deps: Deps): Promise<number> {
  const now = deps.now ? deps.now() : new Date();
  if (!isUaeWorkingDay(now, await loadCalendar(tx))) return 0;
  const { date, hour } = dubaiDateHour(now);
  if (hour < DIGEST_WINDOW.fromHour || hour >= DIGEST_WINDOW.toHour) return 0;
  const staff = (await tx.query<{ email: string }>("select email from users where role in ('ops', 'founder') and status = 'active' order by email")).rows;
  // Claim today's digest in this transaction: a second runner finds the row and sends nothing.
  const claimed = await tx.query("insert into digest_runs (day, recipients) values ($1::date, $2) on conflict (day) do nothing returning day", [date, staff.length]);
  if (!claimed.rows.length) return 0;
  const items = await exceptionQueue(tx);
  const counts: Record<string, number> = { total: items.length };
  for (const x of items) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
  for (const u of staff) await deps.notify.send({ to: u.email, channel: "email", template: "ops_digest", vars: counts });
  return staff.length;
}

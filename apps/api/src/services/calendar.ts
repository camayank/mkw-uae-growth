import { UAE_CALENDAR, type WorkCalendar } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { badRequest, forbidden, notFound } from "../lib/errors.ts";
import { realDate } from "../import/xlsx.ts";

/**
 * The UAE public holidays the working-time clock skips (O10). Kept in the `holidays` setting rather than in code,
 * because lunar dates are announced late: each date is `expected` until the government confirms it. Expected
 * dates count as holidays for every SLA clock (the best estimate beats none); the founder confirms, edits or
 * removes them on Settings, and every change is audited.
 */

export type HolidayStatus = "expected" | "confirmed";
export interface Holiday {
  date: string;
  name: string;
  status: HolidayStatus;
  note: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function validHoliday(h: Partial<Holiday>): Holiday {
  const date = String(h.date ?? "").trim();
  const [y, m, d] = date.split("-").map(Number);
  if (!ISO.test(date) || realDate(y!, m!, d!) !== date) throw badRequest("Give a real date as YYYY-MM-DD");
  const name = String(h.name ?? "").trim();
  if (name.length < 2 || name.length > 120) throw badRequest("Name the holiday");
  const status = h.status === "confirmed" ? "confirmed" : h.status === "expected" || h.status === undefined ? "expected" : null;
  if (!status) throw badRequest("Status is expected or confirmed");
  return { date, name, status, note: String(h.note ?? "").trim().slice(0, 300) };
}

export async function listHolidays(tx: Queryable): Promise<Holiday[]> {
  const r = await tx.query<{ value: Holiday[] }>("select value from settings where key = 'holidays'");
  const list = Array.isArray(r.rows[0]?.value) ? r.rows[0]!.value : [];
  return [...list].sort((a, b) => a.date.localeCompare(b.date));
}

/** The calendar every SLA clock uses: Monday to Friday, 09:00 to 18:00 GST, minus the listed holidays. */
export async function loadCalendar(tx: Queryable): Promise<WorkCalendar> {
  const days = (await listHolidays(tx)).map((h) => h.date);
  return { ...UAE_CALENDAR, holidays: days };
}

export async function saveHolidays(tx: Queryable, list: Holiday[]) {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  await tx.query("insert into settings (key, value) values ('holidays', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(sorted)]);
}

/** Add a date or change one (name, status, note). Founder only; audited with before and after. */
export async function setHoliday(tx: Queryable, actor: SessionUser, input: Partial<Holiday>, reason: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder changes the holiday calendar");
  if (!reason.trim()) throw badRequest("Record why (for example the announcement)");
  const h = validHoliday(input);
  const list = await listHolidays(tx);
  const before = list.find((x) => x.date === h.date) ?? null;
  await saveHolidays(tx, [...list.filter((x) => x.date !== h.date), h]);
  await audit(tx, actor, "settings.holiday_set", "settings", "holidays", { date: h.date, before, after: h, reason: reason.trim() });
  return h;
}

export async function removeHoliday(tx: Queryable, actor: SessionUser, date: string, reason: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder changes the holiday calendar");
  if (!reason.trim()) throw badRequest("Record why");
  const list = await listHolidays(tx);
  const before = list.find((x) => x.date === date);
  if (!before) throw notFound("No holiday on that date");
  await saveHolidays(tx, list.filter((x) => x.date !== date));
  await audit(tx, actor, "settings.holiday_removed", "settings", "holidays", { date, before, reason: reason.trim() });
  return { ok: true };
}

/**
 * Working-time clocks for UAE SLAs.
 * Working days are Monday to Friday (the UAE federal week since 2022), 09:00–18:00 Gulf Standard Time (UTC+4, no DST).
 * Public holidays are passed in as ISO dates (YYYY-MM-DD) in Dubai time.
 */
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_START = 9;
const DAY_END = 18;

export interface WorkCalendar {
  holidays: string[];
  workingWeekdays: number[];
  dayStart: number;
  dayEnd: number;
}

export const UAE_CALENDAR: WorkCalendar = {
  holidays: [],
  workingWeekdays: [1, 2, 3, 4, 5],
  dayStart: DAY_START,
  dayEnd: DAY_END,
};

const toDubai = (d: Date) => new Date(d.getTime() + DUBAI_OFFSET_MS);
const fromDubai = (d: Date) => new Date(d.getTime() - DUBAI_OFFSET_MS);

function isWorkingDay(dubai: Date, cal: WorkCalendar): boolean {
  const iso = dubai.toISOString().slice(0, 10);
  return cal.workingWeekdays.includes(dubai.getUTCDay()) && !cal.holidays.includes(iso);
}

/** Whether the instant falls on a UAE working day (Monday to Friday, not a listed holiday). */
export function isUaeWorkingDay(at: Date, cal: WorkCalendar = UAE_CALENDAR): boolean {
  return isWorkingDay(toDubai(at), cal);
}

/** The Dubai calendar date (YYYY-MM-DD) and hour of an instant. */
export function dubaiDateHour(at: Date): { date: string; hour: number } {
  const d = toDubai(at);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

/** Add working hours to an instant, skipping nights, weekends and holidays. */
export function addWorkingHours(start: Date, hours: number, cal: WorkCalendar = UAE_CALENDAR): Date {
  if (hours < 0) throw new Error("hours must not be negative");
  let t = toDubai(start);
  let remainingMs = hours * 3_600_000;
  for (let guard = 0; guard < 10_000; guard++) {
    const dayOpen = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), cal.dayStart));
    const dayClose = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), cal.dayEnd));
    if (!isWorkingDay(t, cal) || t >= dayClose) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, cal.dayStart));
      continue;
    }
    if (t < dayOpen) t = dayOpen;
    const available = dayClose.getTime() - t.getTime();
    if (remainingMs <= available) return fromDubai(new Date(t.getTime() + remainingMs));
    remainingMs -= available;
    t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, cal.dayStart));
  }
  throw new Error("could not resolve working-hour deadline");
}

/** Add whole working days, landing at the same time of day (or the next opening). */
export function addWorkingDays(start: Date, days: number, cal: WorkCalendar = UAE_CALENDAR): Date {
  return addWorkingHours(start, days * (cal.dayEnd - cal.dayStart), cal);
}

/** Working hours elapsed between two instants. */
export function workingHoursBetween(from: Date, to: Date, cal: WorkCalendar = UAE_CALENDAR): number {
  if (to <= from) return 0;
  let lo = 0;
  let hi = Math.ceil((to.getTime() - from.getTime()) / 3_600_000) + 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (addWorkingHours(from, mid, cal) <= to) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 100) / 100;
}

export function isBreached(deadline: Date, now: Date): boolean {
  return now.getTime() > deadline.getTime();
}

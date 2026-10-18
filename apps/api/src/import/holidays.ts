import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { listHolidays, saveHolidays, validHoliday, type Holiday } from "../services/calendar.ts";
import { excelDate, type Workbook } from "./xlsx.ts";
import { newReport, readTable, sameValue, type Report, type ReportRow } from "./common.ts";

/**
 * UAE holidays tab → the `holidays` setting the working-time clock reads (O10). Matched on date. Each date keeps
 * its status: "Expected" (lunar or not yet announced) or "Confirmed". The founder's calendar on Settings is the record:
 * the file adds dates that are not there and may confirm an expected one, but never renames a date, turns a confirmed
 * one back to expected, or brings back a date the founder removed. Dates the file does not list are left alone.
 */
export async function importHolidays(tx: Queryable, book: Workbook, source: string, actor: SessionUser | null = null): Promise<Report> {
  const report = newReport("holidays", source);
  const grid = book.get("UAE holidays");
  if (!grid) throw new Error('The workbook has no "UAE holidays" tab');
  const t = readTable(grid, ["Date", "Holiday", "Status"]);
  if (!t) throw new Error('No header row with "Date", "Holiday" and "Status" on the UAE holidays tab');
  const C = { date: t.col("Date"), name: t.col("Holiday"), status: t.col("Status"), note: t.col("Note") };
  const list = await listHolidays(tx);
  const byDate = new Map(list.map((h) => [h.date, h]));
  const seen = new Set<string>();
  let dirty = false;

  for (const { line, cells } of t.rows) {
    const raw = (cells[C.date] ?? "").trim();
    const date = excelDate(raw);
    const row: ReportRow = { line, ref: date ?? (raw || "(no date)"), action: "skipped" };
    report.rows.push(row);
    if (!date) {
      row.reason = `"${raw}" is not a date`;
      continue;
    }
    if (seen.has(date)) {
      row.reason = "date listed twice; only the first row is used";
      continue;
    }
    seen.add(date);
    const statusRaw = (cells[C.status] ?? "").trim().toLowerCase();
    if (statusRaw !== "expected" && statusRaw !== "confirmed") {
      row.reason = `status "${cells[C.status] ?? ""}" is neither Expected nor Confirmed`;
      continue;
    }
    let h: Holiday;
    try {
      h = validHoliday({ date, name: cells[C.name], status: statusRaw, note: C.note >= 0 ? cells[C.note] : "" });
    } catch (e) {
      row.reason = (e as Error).message;
      continue;
    }
    row.label = h.name;
    const before = byDate.get(date) ?? null;
    if (before && sameValue(before, h)) {
      row.action = "unchanged";
      continue;
    }
    if (before && !(before.status === "expected" && h.status === "confirmed" && before.name === h.name)) {
      row.action = "unchanged";
      row.reason = "changed on Settings; the founder's version stands";
      continue;
    }
    if (!before) {
      const removed = (await tx.query("select 1 from audit_events where action = 'settings.holiday_removed' and data->>'date' = $1 limit 1", [date])).rows.length;
      if (removed) {
        row.reason = "removed on Settings; the file does not bring it back";
        continue;
      }
    }
    byDate.set(date, h);
    dirty = true;
    await audit(tx, actor, "settings.holiday_imported", "settings", "holidays", { date, before, after: h, source: source.split("/").pop() });
    row.action = before ? "updated" : "created";
    row.reason = `${h.name}, ${h.status}`;
  }
  if (dirty) await saveHolidays(tx, [...byDate.values()]);
  return report;
}

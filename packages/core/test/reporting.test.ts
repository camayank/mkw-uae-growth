import { describe, expect, it } from "vitest";
import { addMonths, aedDecimal, csvLine, nextDue, obligationsFor, parsePeriod, previousPeriod, periodOf, rate, reminderDue, shares } from "../src/index.ts";

describe("periods", () => {
  it("parses months, quarters and years with exclusive ends", () => {
    expect(parsePeriod("2026-10")).toMatchObject({ kind: "month", from: "2026-10-01", to: "2026-11-01" });
    expect(parsePeriod("2026-12")).toMatchObject({ from: "2026-12-01", to: "2027-01-01" });
    expect(parsePeriod("2026-Q4")).toMatchObject({ kind: "quarter", from: "2026-10-01", to: "2027-01-01" });
    expect(parsePeriod("2026-q1")).toMatchObject({ label: "2026-Q1", from: "2026-01-01", to: "2026-04-01" });
    expect(parsePeriod("2026")).toMatchObject({ kind: "year", from: "2026-01-01", to: "2027-01-01" });
    expect(() => parsePeriod("2026-13")).toThrow();
    expect(() => parsePeriod("last month")).toThrow();
  });
  it("steps back and finds the period of a date", () => {
    expect(previousPeriod(parsePeriod("2026-01")).label).toBe("2025-12");
    expect(previousPeriod(parsePeriod("2026-Q1")).label).toBe("2025-Q4");
    expect(previousPeriod(parsePeriod("2026")).label).toBe("2025");
    expect(periodOf("2026-10-17", "quarter").label).toBe("2026-Q4");
  });
  it("rates and shares never produce NaN", () => {
    expect(rate(1, 3)).toBe(0.3333);
    expect(rate(0, 0)).toBe(0);
    expect(shares({ a: 2, b: 2 })).toEqual({ a: 0.5, b: 0.5 });
    expect(shares({ a: 0 })).toEqual({ a: 0 });
  });
  it("writes CSV that cannot start a formula and quotes separators", () => {
    expect(csvLine(["=SUM(A1)", "a,b", 'say "hi"', 12, null])).toBe(`'=SUM(A1),"a,b","say ""hi""",12,`);
    expect(aedDecimal(1234550)).toBe("12345.50");
    expect(csvLine([aedDecimal(-1234550), "-5.00", "-5 apples", "+971 50"])).toBe(`-12345.50,-5.00,'-5 apples,'+971 50`);
  });
});

describe("obligations", () => {
  it("creates one obligation per kind from delivered codes and rolls dates forward", () => {
    const kinds = obligationsFor(["SET-FZ-LIC", "VISA-RES", "VAT-RET"]).map((r) => r.kind);
    expect(kinds).toEqual(["licence_renewal", "visa_expiry", "vat_return", "ubo_update"]);
    expect(obligationsFor(["TM-REG"])).toEqual([]);
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-17", 12)).toBe("2027-10-17");
    expect(nextDue("2026-12-28", "quarterly")).toBe("2027-03-28");
    expect(nextDue("2028-10-17", "none")).toBeNull();
  });
  it("reminds at 30 and 7 days once each, then once when overdue", () => {
    expect(reminderDue("2026-09-01", "2026-10-17", [])).toBeNull();
    expect(reminderDue("2026-09-20", "2026-10-17", [])).toBe(30);
    expect(reminderDue("2026-09-21", "2026-10-17", [30])).toBeNull();
    expect(reminderDue("2026-10-12", "2026-10-17", [30])).toBe(7);
    expect(reminderDue("2026-10-17", "2026-10-17", [30, 7])).toBeNull();
    expect(reminderDue("2026-10-18", "2026-10-17", [30, 7])).toBe("overdue");
    expect(reminderDue("2026-10-19", "2026-10-17", [30, 7, -1])).toBeNull();
    // A late-created obligation skips straight to the nearest reminder, without the earlier one.
    expect(reminderDue("2026-10-15", "2026-10-17", [])).toBe(7);
    expect(reminderDue("2026-10-15", "2026-10-17", [7])).toBeNull();
  });
});

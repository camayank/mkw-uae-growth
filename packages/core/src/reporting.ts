/**
 * Reporting periods and rates (O8). Dates are ISO (YYYY-MM-DD) in Gulf time; the services compute figures in
 * SQL with these boundaries so the dashboard, the export and the tests read the same rows.
 */
export interface Period {
  kind: "month" | "quarter" | "year";
  label: string;
  /** Inclusive. */
  from: string;
  /** Exclusive. */
  to: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d = 1) => `${y}-${pad(m)}-${pad(d)}`;

/** `2026-10`, `2026-Q4` or `2026`. Anything else throws. */
export function parsePeriod(input: string): Period {
  const s = input.trim();
  let m: RegExpMatchArray | null;
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) throw new Error("month must be 01..12");
    const ny = mo === 12 ? y + 1 : y;
    const nm = mo === 12 ? 1 : mo + 1;
    return { kind: "month", label: s, from: iso(y, mo), to: iso(ny, nm) };
  }
  if ((m = /^(\d{4})-Q([1-4])$/i.exec(s))) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const mo = (q - 1) * 3 + 1;
    const to = q === 4 ? iso(y + 1, 1) : iso(y, mo + 3);
    return { kind: "quarter", label: `${y}-Q${q}`, from: iso(y, mo), to };
  }
  if ((m = /^(\d{4})$/.exec(s))) {
    const y = Number(m[1]);
    return { kind: "year", label: s, from: iso(y, 1), to: iso(y + 1, 1) };
  }
  throw new Error("period must look like 2026-10, 2026-Q4 or 2026");
}

/** The period before: the previous month, quarter or year. */
export function previousPeriod(p: Period): Period {
  const [y, mo] = p.from.split("-").map(Number) as [number, number];
  if (p.kind === "month") return parsePeriod(mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`);
  if (p.kind === "quarter") {
    const q = Math.floor((mo - 1) / 3) + 1;
    return parsePeriod(q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`);
  }
  return parsePeriod(String(y - 1));
}

/** The period containing a date, of the given kind. */
export function periodOf(date: string, kind: Period["kind"]): Period {
  const [y, mo] = date.slice(0, 10).split("-").map(Number) as [number, number];
  if (kind === "month") return parsePeriod(`${y}-${pad(mo)}`);
  if (kind === "quarter") return parsePeriod(`${y}-Q${Math.floor((mo - 1) / 3) + 1}`);
  return parsePeriod(String(y));
}

/** A rate 0..1 rounded to four places; 0 when nothing to measure (never NaN). */
export function rate(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

/** Basis points of a part in a whole, or 0; integer. */
export function bpOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part * 10_000) / whole);
}

/** Share of a total per key (0..1), summing to 1 when the total is positive. */
export function shares<K extends string>(counts: Record<K, number>): Record<K, number> {
  const total = Object.values<number>(counts).reduce((a, b) => a + b, 0);
  const out = {} as Record<K, number>;
  for (const k of Object.keys(counts) as K[]) out[k] = rate(counts[k], total);
  return out;
}

/** One CSV line. Text that could start a spreadsheet formula is prefixed with an apostrophe; quotes doubled. */
export function csvLine(values: Array<string | number | null | undefined>): string {
  return values
    .map((v) => {
      if (v === null || v === undefined) return "";
      if (typeof v === "number") return String(v);
      let t = v.replace(/\r?\n/g, " ");
      // A plain number (including a negative amount) stays a number; anything else that could start a formula is neutralised.
      if (/^[=+\-@\t]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`;
      return /[",;]/.test(t) || /^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    })
    .join(",");
}

/** Fils to a decimal AED string for accounting imports (two places, no thousands separators). */
export const aedDecimal = (fils: number) => (fils / 100).toFixed(2);

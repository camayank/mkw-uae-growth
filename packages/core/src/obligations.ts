/**
 * Compliance calendar rules (O8): which recurring obligations a completed service creates for the client,
 * and how a date rolls forward. Every generated date is UNCERTAIN until a person at MKW confirms it; the
 * platform never files anything, it tracks what a person did and reminds in time.
 */
export type ObligationKind = "licence_renewal" | "visa_expiry" | "vat_return" | "ct_return" | "esr_notification" | "ubo_update" | "audit_filing" | "custom";
export type Recurrence = "none" | "monthly" | "quarterly" | "yearly";

export interface ObligationRule {
  kind: ObligationKind;
  title: string;
  /** Months after completion for the first due date. */
  firstDueMonths: number;
  recurrence: Recurrence;
  /** Which service codes create it (prefix match with a trailing *). */
  codes: string[];
  /** Why we think so; shown to ops when confirming. */
  basis: string;
}

export const OBLIGATION_RULES: ObligationRule[] = [
  { kind: "licence_renewal", title: "Trade licence renewal", firstDueMonths: 12, recurrence: "yearly", codes: ["SET-FZ-LIC", "SET-ML-LIC", "SET-OFF", "SET-DIFC", "SET-BRANCH", "SET-FREELANCE", "SET-RENEW"], basis: "UAE trade licences are issued for one year and renewed annually; the exact date is on the licence." },
  { kind: "visa_expiry", title: "Residence visa and Emirates ID renewal", firstDueMonths: 24, recurrence: "none", codes: ["VISA-RES", "VISA-FAM"], basis: "Employment and family residence visas are commonly issued for two years; the date is on the visa." },
  { kind: "vat_return", title: "VAT return and payment", firstDueMonths: 4, recurrence: "quarterly", codes: ["VAT-RET", "VAT-REG"], basis: "Quarterly VAT returns are due 28 days after the tax period ends; the FTA sets each registrant's periods." },
  { kind: "ct_return", title: "Corporate tax return", firstDueMonths: 21, recurrence: "yearly", codes: ["CT-RET", "CT-REG"], basis: "The corporate tax return is due within nine months of the financial year end (31 December assumed)." },
  { kind: "ubo_update", title: "UBO register confirmation", firstDueMonths: 12, recurrence: "yearly", codes: ["ESR-UBO", "SET-FZ-LIC", "SET-ML-LIC"], basis: "The beneficial-owner register is kept current and confirmed with the registrar, usually at renewal." },
  { kind: "esr_notification", title: "Economic substance notification", firstDueMonths: 6, recurrence: "yearly", codes: ["ESR-UBO"], basis: "Relevant activities notify within six months of the financial year end; confirm whether the client is in scope." },
  { kind: "audit_filing", title: "Audited financial statements", firstDueMonths: 15, recurrence: "yearly", codes: ["AUD-EXT", "ACC-IFRS"], basis: "Many free zones require audited accounts within a set time after the financial year end; the zone's rule applies." },
];

const matches = (pattern: string, code: string) => (pattern.endsWith("*") ? code.startsWith(pattern.slice(0, -1)) : pattern === code);

/** The obligations a set of delivered codes creates, one per kind. */
export function obligationsFor(codes: string[]): ObligationRule[] {
  const seen = new Set<ObligationKind>();
  const out: ObligationRule[] = [];
  for (const r of OBLIGATION_RULES) {
    if (seen.has(r.kind)) continue;
    if (codes.some((c) => r.codes.some((p) => matches(p, c)))) {
      seen.add(r.kind);
      out.push(r);
    }
  }
  return out;
}

/** Add calendar months to an ISO date, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, last);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

export function nextDue(due: string, recurrence: Recurrence): string | null {
  if (recurrence === "none") return null;
  return addMonths(due, recurrence === "monthly" ? 1 : recurrence === "quarterly" ? 3 : 12);
}

/** Reminder offsets in days before the due date; overdue is reminded once more. */
export const REMINDER_DAYS = [30, 7] as const;

export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** Which reminder (if any) is due today for an open obligation that has already sent `sent`. */
export function reminderDue(today: string, due: string, sent: number[]): number | "overdue" | null {
  const left = daysBetween(today, due);
  if (left < 0) return sent.includes(-1) ? null : "overdue";
  // The nearest threshold not yet sent; a reminder that would have gone earlier is not sent late as well.
  const nearest = [...REMINDER_DAYS].reverse().find((d) => left <= d);
  if (nearest === undefined) return null;
  if (sent.includes(nearest)) return null;
  return nearest;
}

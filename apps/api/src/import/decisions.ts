import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { scheduleRule } from "../services/rules.ts";
import { addDays, dbToday, loadRules } from "../services/repo.ts";
import { updateCompany, loadCompany, type Company } from "../services/invoices.ts";
import { markdownTables, newReport, type Report, type ReportRow } from "./common.ts";

/**
 * Owner-Decisions.md and MKW-Company-Details.md (O10). Answers apply through the same services a person uses on
 * Settings and Rules, as the founder named with `--as`, so every change is audited to them. A blank answer changes
 * nothing (today's value stays, UNCERTAIN where it shows). "Agree" takes the written suggestion where the platform
 * can apply it exactly; any other answer that cannot be read with confidence is reported for the owner, never
 * guessed. Decisions the platform holds as code or as deployment settings are reported as such.
 */

export interface DecisionRow {
  n: number;
  line: number;
  decision: string;
  suggestion: string;
  answer: string;
}

export function parseDecisions(md: string): DecisionRow[] {
  const table = markdownTables(md).find((t) => t[0]?.[0] === "#" && t[0].some((h) => /answer/i.test(h)));
  if (!table) throw new Error('No decisions table found (a table whose header starts with "#" and has a "Your answer" column)');
  const header = table[0]!;
  const ia = header.findIndex((h) => /answer/i.test(h));
  const is = header.findIndex((h) => /suggestion/i.test(h));
  const id = header.findIndex((h) => /^decision$/i.test(h));
  return table.slice(1).map((cells, i) => ({
    n: Number(cells[0]),
    line: i + 1,
    decision: cells[id] ?? "",
    suggestion: cells[is] ?? "",
    answer: (cells[ia] ?? "").trim(),
  }));
}

/** The fee verifier's name from row 12 ("Named fee verifier"), or null when blank or not a name. */
export function feeVerifierFrom(rows: DecisionRow[]): string | null {
  return nameAnswer(rows.find((r) => r.n === 12)?.answer);
}
function nameAnswer(a: string | undefined): string | null {
  const s = String(a ?? "")
    .replace(/^name\s*:\s*/i, "")
    .trim();
  if (!s || /^(agree|tbc|tbd|to be (found|named)|n\/a|-)$/i.test(s) || s.length < 3) return null;
  return s;
}

const isAgree = (a: string) => /^agree\.?$/i.test(a.trim());

/** Row 1's suggestion, exactly as written: rate in basis points and floor in fils per platform category. */
const SUGGESTED_MARGINS: Record<string, { rateBp: number; floorFils: number }> = {
  Setup: { rateBp: 2000, floorFils: 50_000 },
  Visa: { rateBp: 2000, floorFils: 40_000 },
  PRO: { rateBp: 2000, floorFils: 30_000 },
  Accounting: { rateBp: 2500, floorFils: 15_000 },
  Tax: { rateBp: 2500, floorFils: 30_000 },
  Audit: { rateBp: 1000, floorFils: 50_000 },
  Compliance: { rateBp: 2000, floorFils: 50_000 },
  "Legal & IP": { rateBp: 2000, floorFils: 50_000 },
};

/** Where each decision lives when the import cannot (or should not) apply it. */
const HELD_ELSEWHERE: Record<number, string> = {
  2: "the fairness cap (35%) and quality bar (60) are built into the allocation code; a different answer needs a code change",
  3: "the deposit (50% of fees plus government fees) is built into the pricing code; a different answer needs a code change",
  4: "the guarantee is 10% of the late step's fee (setting guarantee_bp = 1000), borne by the partner when the delay is theirs, as built",
  5: "partners see the client's name only after accepting, as built",
  6: "retention periods are confirmed by the founder on Settings after the lawyer's advice; the UNCERTAIN badge stays until then",
  7: "only the founder may erase; ops may export, as built",
  8: "hosting is the staging and production deployment (docs/DEPLOY.md), not a platform setting",
  9: "email sending is the EMAIL, EMAIL_FROM_CLIENT and EMAIL_FROM_PARTNER deployment settings",
  10: "the card provider is the PAYMENT deployment setting and an adapter to build; bank transfer stays the default",
  11: "the public web address is the APP_URL deployment setting and the domain's DNS",
  13: "the scoping-rule verifier signs each rule on the Scoping rules page; the name is recorded for that",
  14: "AI drafting is the AI deployment setting (memory double until a key and cap exist)",
  15: "the accounting export's column mapping is built once the system is named",
  16: "the corporate tax obligation rule assumes 31 December; another year end needs the rule changed",
  17: "the ops digest runs once per working day between 08:00 and 10:00 GST, as built",
  18: "the founder records the Arabic reviewer's sign-off on Settings after the review; it is never switched on by an import",
  19: "template wording is approved by the owner; nothing changes in the platform",
  20: "pilot partners are moved to pilot by MKW in the console",
  21: "pilot clients are invited from the People page",
  22: "the lawyer's sign-off is recorded per legal text on Settings",
};

export async function importDecisions(tx: Queryable, md: string, source: string, actor: SessionUser | null): Promise<Report> {
  const report = newReport("decisions", source);
  const rows = parseDecisions(md);
  const founder = actor && actor.role === "founder" ? actor : null;
  for (const d of rows) {
    const row: ReportRow = { line: d.line, ref: `#${d.n} ${d.decision}`.slice(0, 80), action: "unchanged" };
    report.rows.push(row);
    if (!d.answer) {
      row.reason = "no answer: today's value stays, UNCERTAIN where it shows";
      continue;
    }
    if (d.n === 1) {
      if (!isAgree(d.answer)) {
        row.action = "skipped";
        row.reason = "answer is not \"Agree\" and cannot be read into rates and floors with confidence: for the owner to enter on the Rules page";
        continue;
      }
      if (!founder) throw new Error("Row 1 changes margin rules: run with --as <founder email>");
      const from = addDays(await dbToday(tx), 1);
      const now = await loadRules(tx, from);
      const changes: string[] = [];
      for (const [category, s] of Object.entries(SUGGESTED_MARGINS)) {
        const cur = now.get(category);
        if (cur && cur.rateBp === s.rateBp && cur.floor === s.floorFils) continue;
        await scheduleRule(tx, founder, { category, rateBp: s.rateBp, floorFils: s.floorFils, effectiveFrom: from, note: `Owner-Decisions.md row 1 ("Agree"), imported` });
        changes.push(category);
      }
      row.warnings = [
        "Banking is not a separate category on the platform (bank account opening sits in its own code's category); its suggested floor is not applied",
        "the new categories' suggestion is a range (AED 300 to 500): their \"default, confirm\" rules stay",
      ];
      if (changes.length) {
        row.action = "updated";
        row.reason = `rules scheduled from ${from} for ${changes.join(", ")}; offers already built keep their rules`;
      } else row.reason = "the rules already match the suggestion";
      continue;
    }
    if (d.n === 12 || d.n === 13) {
      const name = nameAnswer(d.answer);
      if (!name) {
        row.action = "skipped";
        row.reason = "no name given";
        continue;
      }
      const key = d.n === 12 ? "fee" : "scoping";
      const cur = (await tx.query<{ value: Record<string, string | null> }>("select value from settings where key = 'verifiers'")).rows[0]?.value ?? {};
      if (cur[key] === name) {
        row.reason = "already recorded";
        continue;
      }
      if (!founder) throw new Error(`Row ${d.n} names a verifier: run with --as <founder email>`);
      const after = { ...cur, [key]: name };
      await tx.query("insert into settings (key, value) values ('verifiers', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(after)]);
      await audit(tx, founder, "settings.verifier_named", "settings", "verifiers", { role: key, before: cur[key] ?? null, after: name, source: source.split("/").pop() });
      row.action = "updated";
      row.reason = `${key === "fee" ? "fee" : "scoping-rule"} verifier recorded`;
      continue;
    }
    row.action = "skipped";
    row.reason = isAgree(d.answer) ? `agreed; ${HELD_ELSEWHERE[d.n] ?? "nothing to apply in the platform"}` : `answered; ${HELD_ELSEWHERE[d.n] ?? "nothing to apply in the platform"} (for the owner)`;
  }
  return report;
}

// Company details --------------------------------------------------------------------------------------------------

type CompanyField = "legalName" | "trn" | "address" | "bankName";
const COMPANY_FIELDS: Array<{ match: RegExp; field?: CompanyField; elsewhere?: string }> = [
  { match: /^legal name/i, field: "legalName" },
  { match: /^vat trn/i, field: "trn" },
  { match: /^registered address/i, field: "address" },
  { match: /^bank name/i, field: "bankName" },
  { match: /^trade licence number/i, elsewhere: "not printed by the platform yet; kept in the company file" },
  { match: /^licensing authority/i, elsewhere: "not printed by the platform yet; kept in the company file" },
  { match: /^corporate tax trn/i, elsewhere: "not used on invoices (VAT TRN is); kept in the company file" },
  { match: /^notice email/i, elsewhere: "where the platform sends owner notices is the founder's own account" },
  { match: /^client sender email/i, elsewhere: "deployment setting EMAIL_FROM_CLIENT (default tasees@mkwadvisors.com)" },
  { match: /^partner sender email/i, elsewhere: "deployment setting EMAIL_FROM_PARTNER (default partners@mkwadvisors.com)" },
  { match: /^platform web address/i, elsewhere: "deployment setting APP_URL" },
  { match: /^authorised signatory/i, elsewhere: "goes on the signed Partner Network Agreement, not a platform field" },
];

export async function importCompany(tx: Queryable, md: string, source: string, actor: SessionUser | null): Promise<Report> {
  const report = newReport("company", source);
  const table = markdownTables(md).find((t) => /^field$/i.test(t[0]?.[0] ?? "") && /^value$/i.test(t[0]?.[1] ?? ""));
  if (!table) throw new Error('No "Field | Value" table found');
  const patch: Partial<Pick<Company, CompanyField>> = {};
  const pending: ReportRow[] = [];
  const before = await loadCompany(tx);
  for (const [i, cells] of table.slice(1).entries()) {
    const label = cells[0] ?? "";
    const value = (cells[1] ?? "").trim();
    const row: ReportRow = { line: i + 1, ref: label.replace(/\(.*?\)/g, "").trim(), action: "unchanged" };
    report.rows.push(row);
    if (/iban|swift|account number|password/i.test(label)) {
      row.action = "skipped";
      row.reason = "bank account details and passwords are never imported; enter them on Settings";
      continue;
    }
    const map = COMPANY_FIELDS.find((f) => f.match.test(label));
    if (!value) {
      row.reason = "blank: nothing changes";
      continue;
    }
    if (!map) {
      row.action = "skipped";
      row.reason = "not a field the platform knows (for the owner)";
      continue;
    }
    if (map.elsewhere) {
      row.action = "skipped";
      row.reason = map.elsewhere;
      continue;
    }
    const field = map.field!;
    if (field === "trn" && !/^\d{15}$/.test(value.replace(/\s/g, ""))) {
      row.action = "skipped";
      row.reason = "a UAE TRN is 15 digits; not applied (for the owner)";
      continue;
    }
    const v = field === "trn" ? value.replace(/\s/g, "") : value;
    if ((before[field] ?? "") === v) {
      row.reason = "already set";
      continue;
    }
    patch[field] = v;
    row.action = "updated";
    row.reason = "set through the founder's company settings";
    pending.push(row);
  }
  if (pending.length) {
    if (!actor || actor.role !== "founder") throw new Error("Company details change company settings: run with --as <founder email>");
    await updateCompany(tx, actor, patch, `Imported from ${source.split("/").pop()}`);
  }
  return report;
}

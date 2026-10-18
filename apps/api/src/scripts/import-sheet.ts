/**
 * Import partner rate cards from a CSV export of the "Rate Cards" tab of the operating Google Sheet.
 *
 *   pnpm --filter @tasees/api import:sheet path/to/rate-cards.csv            # dry run: shows what would change
 *   pnpm --filter @tasees/api import:sheet path/to/rate-cards.csv --apply    # writes, with an audit event per partner
 *
 * Rows are matched to partners by exact organisation name (column "Partner") and to services by code.
 * Example rows (Partner ID starting EXAMPLE) and rows for unknown partners or codes are skipped and listed.
 * The Sheet stays the place partners' prices are negotiated until partners maintain cards in the portal.
 */
import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { aed } from "@tasees/core";
import { asPlatform, audit } from "../lib/context.ts";
import { migrate, openDatabase } from "../lib/db.ts";

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("Usage: import:sheet <rate-cards.csv> [--apply]");
  process.exit(2);
}
const apply = flags.includes("--apply");

const rows: string[][] = parse(await readFile(file, "utf8"), { relax_column_count: true, skip_empty_lines: true });
const headerAt = rows.findIndex((r) => r.includes("Card ID") && r.includes("Code"));
if (headerAt < 0) {
  console.error('No header row with "Card ID" and "Code" found. Export the Rate Cards tab as CSV.');
  process.exit(2);
}
const header = rows[headerAt]!;
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`Column "${name}" missing from the export`);
  return i;
};
const C = {
  partnerId: col("Partner ID"),
  partner: col("Partner"),
  code: col("Code"),
  fee: col("Professional fee"),
  gov: col("Govt fee stated"),
  third: col("Third-party"),
  days: col("Timeline"),
  exclusions: col("Exclusions"),
  validTo: col("Valid to"),
};
const money = (v: string | undefined) => {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const db = await openDatabase();
await migrate(db);
const skipped: string[] = [];
const planned: Array<{ orgId: string; partner: string; code: string; fee: number; gov: number; third: number; days: number; exclusions: string[]; validTo: string }> = [];

await asPlatform(db, null, async (tx) => {
  const partners = new Map(
    (await tx.query<{ id: string; name: string }>("select id, name from orgs where type = 'partner'")).rows.map((r) => [r.name.trim(), r.id]),
  );
  const codes = new Set((await tx.query<{ code: string }>("select code from deliverables")).rows.map((r) => r.code));
  for (const [i, r] of rows.slice(headerAt + 1).entries()) {
    const line = headerAt + i + 2;
    const code = (r[C.code] ?? "").trim();
    const partner = (r[C.partner] ?? "").trim();
    if (!code && !partner) continue;
    if ((r[C.partnerId] ?? "").startsWith("EXAMPLE")) {
      skipped.push(`row ${line}: example row`);
      continue;
    }
    const orgId = partners.get(partner);
    if (!orgId) {
      skipped.push(`row ${line}: partner "${partner}" is not on the platform yet`);
      continue;
    }
    if (!codes.has(code)) {
      skipped.push(`row ${line}: unknown service code "${code}"`);
      continue;
    }
    const days = Math.round(money(r[C.days]));
    const validTo = new Date(r[C.validTo] ?? "");
    if (days < 1 || Number.isNaN(validTo.getTime())) {
      skipped.push(`row ${line}: needs a timeline in working days and a valid-to date`);
      continue;
    }
    planned.push({
      orgId,
      partner,
      code,
      fee: money(r[C.fee]),
      gov: money(r[C.gov]),
      third: money(r[C.third]),
      days,
      exclusions: String(r[C.exclusions] ?? "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean),
      validTo: validTo.toISOString().slice(0, 10),
    });
  }

  if (!apply) return;
  for (const p of planned) {
    await tx.query(
      `insert into rate_cards (partner_org_id, code, professional_fils, gov_stated_fils, third_party_fils, working_days, exclusions, valid_to)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (partner_org_id, code) do update set professional_fils = excluded.professional_fils, gov_stated_fils = excluded.gov_stated_fils,
         third_party_fils = excluded.third_party_fils, working_days = excluded.working_days, exclusions = excluded.exclusions,
         valid_to = excluded.valid_to, updated_at = app_now()`,
      [p.orgId, p.code, aed(p.fee), aed(p.gov), aed(p.third), p.days, p.exclusions, p.validTo],
    );
  }
  const byPartner = new Map<string, string[]>();
  for (const p of planned) byPartner.set(p.orgId, [...(byPartner.get(p.orgId) ?? []), p.code]);
  for (const [orgId, list] of byPartner) await audit(tx, null, "rate_cards.imported", "org", orgId, { codes: list, source: "sheet_csv" });
});

for (const p of planned) console.log(`${apply ? "updated" : "would update"}  ${p.partner}  ${p.code}  AED ${p.fee}  ${p.days}d  valid to ${p.validTo}`);
for (const s of skipped) console.log(`skipped  ${s}`);
console.log(`${planned.length} card(s) ${apply ? "imported" : "ready; run again with --apply to write"}; ${skipped.length} row(s) skipped.`);
await db.close();

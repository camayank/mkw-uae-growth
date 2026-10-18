import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { excelDate } from "./xlsx.ts";
import { aedToFils, isBlank, newReport, readTable, sameValue, type Report, type ReportRow } from "./common.ts";

/**
 * Partner rate cards from the operating Sheet (O10), from a CSV export of the "Rate Cards" tab or the go-live
 * workbook's "Rate card template" tab. Accepts the Sheet's real headers ("Professional fee (AED, excl. VAT)",
 * "Government fee stated (AED)", "Third-party costs (AED)", "Timeline (working days)") and the short ones.
 * Partners match on Partner ID when the row has one (an unknown ID is skipped, never matched by name), otherwise on
 * the exact name (a name two firms share is skipped). Rows marked Example or Draft, rows without a professional fee,
 * and rows for unknown partners or codes are skipped and listed. A card that already holds the same figures is
 * unchanged; otherwise it is created or updated, one audit event per card. A card changed on the platform since the
 * last import (by the partner in the portal, or by MKW) is not overwritten: the Sheet is the source only until then.
 */

const REQUIRED = ["Code", "Partner"];

export async function importRateCards(tx: Queryable, grid: string[][], source: string, actor: SessionUser | null = null): Promise<Report> {
  const report = newReport("rate-cards", source);
  const t = readTable(grid, REQUIRED);
  if (!t) throw new Error('No header row with "Partner" and "Code" found. Export the Rate Cards tab, or use the workbook\'s "Rate card template" tab.');
  const C = {
    cardId: t.col("Card ID"),
    partnerId: t.col("Partner ID"),
    partner: t.col("Partner"),
    code: t.col("Code"),
    fee: t.col("Professional fee"),
    gov: t.col("Government fee stated", "Govt fee stated", "Government fee"),
    third: t.col("Third-party costs", "Third-party", "Third party"),
    days: t.col("Timeline", "Timeline working days"),
    exclusions: t.col("Exclusions"),
    validTo: t.col("Valid to"),
    status: t.col("Status"),
  };
  const missing = Object.entries({ fee: C.fee, days: C.days, validTo: C.validTo }).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new Error(`Columns missing from the export: ${missing.join(", ")} (looked for "Professional fee", "Timeline" and "Valid to")`);

  const partners = (await tx.query<{ id: string; name: string; source_id: string | null }>("select id, name, profile->>'sourceId' as source_id from orgs where type = 'partner'")).rows;
  const byId = new Map(partners.filter((p) => p.source_id).map((p) => [p.source_id!, p]));
  const byName = new Map<string, typeof partners>();
  for (const p of partners) byName.set(p.name.trim().toLowerCase(), [...(byName.get(p.name.trim().toLowerCase()) ?? []), p]);
  const codes = new Set((await tx.query<{ code: string }>("select code from deliverables")).rows.map((r) => r.code));
  const today = (await tx.query<{ d: string }>("select (app_now() at time zone 'Asia/Dubai')::date::text as d")).rows[0]!.d;
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
  const seen = new Set<string>();

  for (const { line, cells } of t.rows) {
    const partnerId = cell(cells, C.partnerId);
    const partnerName = cell(cells, C.partner);
    const code = cell(cells, C.code).toUpperCase();
    const status = cell(cells, C.status);
    const row: ReportRow = { line, ref: `${cell(cells, C.cardId) || "(no card ID)"} ${partnerId || ""} ${code}`.replace(/\s+/g, " ").trim(), label: partnerName, action: "skipped" };
    report.rows.push(row);
    if (/^example/i.test(status) || partnerId.toUpperCase().startsWith("EXAMPLE")) {
      row.reason = "example row";
      continue;
    }
    if (/^draft/i.test(status)) {
      row.reason = `status Draft${isBlank(cell(cells, C.fee)) ? " and no professional fee" : ""}: mark it Active once the firm has confirmed the price`;
      continue;
    }
    const fee = aedToFils(cell(cells, C.fee));
    if (fee === null) {
      row.reason = isBlank(cell(cells, C.fee)) ? "no professional fee" : `professional fee "${cell(cells, C.fee)}" is not an amount`;
      continue;
    }
    const named = byName.get(partnerName.toLowerCase()) ?? [];
    const partner = partnerId ? byId.get(partnerId) : named.length === 1 ? named[0] : undefined;
    if (!partner) {
      row.reason = !partnerId && named.length > 1 ? `two partners are called "${partnerName}"; add the Partner ID` : `partner ${partnerId || `"${partnerName}"`} is not on the platform yet`;
      continue;
    }
    if (!codes.has(code)) {
      row.reason = `unknown service code "${code}"`;
      continue;
    }
    const days = Number(cell(cells, C.days));
    if (!Number.isInteger(days) || days < 1) {
      row.reason = "needs a timeline in whole working days";
      continue;
    }
    const validTo = excelDate(cell(cells, C.validTo));
    if (!validTo) {
      row.reason = "needs a valid-to date";
      continue;
    }
    if (validTo < today) {
      row.reason = `expired on ${validTo}`;
      continue;
    }
    const gov = aedToFils(cell(cells, C.gov)) ?? 0;
    const third = aedToFils(cell(cells, C.third)) ?? 0;
    const exclusions = cell(cells, C.exclusions)
      .split(/[;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const key = `${partner.id}:${code}`;
    if (seen.has(key)) {
      row.reason = "the same partner and code appear twice in the file; only the first row is used";
      continue;
    }
    seen.add(key);

    const before = (
      await tx.query<Record<string, unknown>>("select professional_fils, gov_stated_fils, third_party_fils, working_days, exclusions, valid_to::text as valid_to from rate_cards where partner_org_id = $1 and code = $2", [partner.id, code])
    ).rows[0];
    const after = { professional: fee, gov, third, days, exclusions, validTo };
    if (before) {
      // The card as the last import left it; if it differs now, someone changed it on the platform since.
      const lastImport = (
        await tx.query<{ after: typeof after }>("select data->'after' as after from audit_events where action = 'rate_card.imported' and entity_id = $1 and data->>'code' = $2 order by id desc limit 1", [partner.id, code])
      ).rows[0]?.after;
      const now = { professional: num(before.professional_fils), gov: num(before.gov_stated_fils), third: num(before.third_party_fils), days: num(before.working_days), exclusions: (before.exclusions as string[]) ?? [], validTo: String(before.valid_to).slice(0, 10) };
      if (lastImport && !sameValue(now, lastImport) && !sameValue(now, after)) {
        row.action = "unchanged";
        row.reason = "changed on the platform since the last import; the file does not overwrite it";
        continue;
      }
    }
    if (
      before &&
      num(before.professional_fils) === fee &&
      num(before.gov_stated_fils) === gov &&
      num(before.third_party_fils) === third &&
      num(before.working_days) === days &&
      JSON.stringify(before.exclusions ?? []) === JSON.stringify(exclusions) &&
      String(before.valid_to).slice(0, 10) === validTo
    ) {
      row.action = "unchanged";
      continue;
    }
    await tx.query(
      `insert into rate_cards (partner_org_id, code, professional_fils, gov_stated_fils, third_party_fils, working_days, exclusions, valid_to)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (partner_org_id, code) do update set professional_fils = excluded.professional_fils, gov_stated_fils = excluded.gov_stated_fils,
         third_party_fils = excluded.third_party_fils, working_days = excluded.working_days, exclusions = excluded.exclusions,
         valid_to = excluded.valid_to, updated_at = app_now()`,
      [partner.id, code, fee, gov, third, days, exclusions, validTo],
    );
    await audit(tx, actor, "rate_card.imported", "org", partner.id, {
      code,
      action: before ? "updated" : "created",
      before: before ? { professional: num(before.professional_fils), gov: num(before.gov_stated_fils), third: num(before.third_party_fils), days: num(before.working_days), validTo: String(before.valid_to).slice(0, 10) } : null,
      after,
      source: source.split("/").pop(),
    });
    row.action = before ? "updated" : "created";
    row.reason = `AED ${(fee / 100).toFixed(2)}, ${days} working days, valid to ${validTo}`;
  }
  return report;
}

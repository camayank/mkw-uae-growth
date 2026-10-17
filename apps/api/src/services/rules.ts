import { DEFAULT_SETTINGS, type PricingSettings } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { dbToday, FEE_STALE_DAYS, loadRules, loadSettings } from "./repo.ts";

/**
 * Rules administration (O4): margin rates and floors with effective dates, pricing settings, and the
 * government fee table. The founder changes rules; ops may add a fee row (it starts UNCERTAIN); only the
 * founder verifies a fee, naming the qualified person who checked it. Every change is audited with before
 * and after. Offers already built keep the figures they were built with (offers.rules_as_of).
 */

const isFounder = (u: SessionUser) => u.role === "founder";
const canEditFees = (u: SessionUser) => u.role === "founder" || u.role === "ops";

export async function rulesOverview(tx: Queryable) {
  const asOf = await dbToday(tx);
  const current = await loadRules(tx, asOf);
  const versions = await tx.query<Record<string, unknown>>(
    `select v.category, v.rate_bp, v.floor_fils, v.effective_from::text as effective_from, v.note, v.created_at, u.name as created_by
     from margin_rule_versions v left join users u on u.id = v.created_by order by v.category, v.effective_from desc`,
  );
  const categories = await tx.query<{ category: string; codes: number }>("select category, count(*)::int as codes from deliverables where active group by category order by category");
  const fees = await tx.query<Record<string, unknown>>(
    `select f.id, f.code, d.name, f.emirate, f.free_zone, f.fee_fils, f.source_url, f.source_note, f.effective_from::text as effective_from,
       f.confidence, f.verified_by, f.verified_at::text as verified_at, f.created_at, f.retired_at
     from government_fees f join deliverables d on d.code = f.code order by f.retired_at nulls first, f.code, f.emirate, f.free_zone`,
  );
  const settings = await loadSettings(tx);
  return {
    asOf,
    settings,
    categories: categories.rows.map((c) => {
      const rule = current.get(c.category);
      const all = versions.rows.filter((v) => v.category === c.category);
      return {
        category: c.category,
        codes: c.codes,
        current: rule ? { rateBp: rule.rateBp, floor: rule.floor } : null,
        scheduled: all.filter((v) => String(v.effective_from) > asOf).map(shapeVersion),
        history: all.filter((v) => String(v.effective_from) <= asOf).map(shapeVersion),
      };
    }),
    fees: fees.rows.map((f) => {
      const verifiedAt = f.verified_at ? String(f.verified_at).slice(0, 10) : null;
      const ageDays = verifiedAt ? Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${verifiedAt}T00:00:00Z`)) / 86_400_000) : null;
      return {
        id: f.id,
        code: f.code,
        name: f.name,
        emirate: f.emirate,
        freeZone: f.free_zone,
        fee: num(f.fee_fils),
        sourceUrl: f.source_url,
        sourceNote: f.source_note,
        effectiveFrom: f.effective_from,
        confidence: f.confidence,
        verifiedBy: f.verified_by,
        verifiedAt,
        stale: f.confidence === "verified" && (ageDays === null || ageDays > FEE_STALE_DAYS),
        retired: !!f.retired_at,
      };
    }),
    staleAfterDays: FEE_STALE_DAYS,
  };
}

const shapeVersion = (v: Record<string, unknown>) => ({
  rateBp: num(v.rate_bp),
  floor: num(v.floor_fils),
  effectiveFrom: String(v.effective_from),
  note: v.note,
  createdBy: v.created_by,
  createdAt: v.created_at,
});

export interface RuleChange {
  category: string;
  rateBp: number;
  floorFils: number;
  effectiveFrom: string;
  note: string;
}

/** Schedule (or correct) the rule for a category from a date. Dates in the past are refused: earlier offers keep their rules. */
export async function scheduleRule(tx: Queryable, actor: SessionUser, change: RuleChange) {
  if (!isFounder(actor)) throw forbidden("Only the founder changes margin rules");
  const known = await tx.query("select 1 from deliverables where category = $1 limit 1", [change.category]);
  if (!known.rows.length) throw notFound(`No category ${change.category}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(change.effectiveFrom)) throw badRequest("Give the effective date as YYYY-MM-DD");
  const asOf = await dbToday(tx);
  if (change.effectiveFrom < asOf) throw badRequest("A rule cannot take effect in the past; offers already built keep their rules");
  if (!Number.isInteger(change.rateBp) || change.rateBp < 0 || change.rateBp > 10_000) throw badRequest("Rate must be whole basis points between 0 and 10000");
  if (!Number.isInteger(change.floorFils) || change.floorFils < 0) throw badRequest("Floor must be whole fils, zero or more");
  const before = (await loadRules(tx, asOf)).get(change.category) ?? null;
  await tx.query(
    `insert into margin_rule_versions (category, rate_bp, floor_fils, effective_from, note, created_by) values ($1,$2,$3,$4,$5,$6)
     on conflict (category, effective_from) do update set rate_bp = excluded.rate_bp, floor_fils = excluded.floor_fils, note = excluded.note, created_by = excluded.created_by, created_at = app_now()`,
    [change.category, change.rateBp, change.floorFils, change.effectiveFrom, change.note.trim(), actor.id],
  );
  if (change.effectiveFrom === asOf) {
    await tx.query(
      "insert into margin_rules (category, rate_bp, floor_fils) values ($1,$2,$3) on conflict (category) do update set rate_bp = excluded.rate_bp, floor_fils = excluded.floor_fils",
      [change.category, change.rateBp, change.floorFils],
    );
  }
  await audit(tx, actor, "rules.margin_scheduled", "margin_rule", change.category, {
    before,
    after: { rateBp: change.rateBp, floor: change.floorFils },
    effectiveFrom: change.effectiveFrom,
    note: change.note.trim(),
  });
  return { ok: true };
}

/** Bring the margin_rules cache in line with the version in force today. Run by the jobs sweep. */
export async function refreshCurrentRules(tx: Queryable): Promise<number> {
  const current = await loadRules(tx, await dbToday(tx));
  let changed = 0;
  for (const r of current.values()) {
    const res = await tx.query(
      `insert into margin_rules (category, rate_bp, floor_fils) values ($1,$2,$3)
       on conflict (category) do update set rate_bp = excluded.rate_bp, floor_fils = excluded.floor_fils
       where margin_rules.rate_bp <> excluded.rate_bp or margin_rules.floor_fils <> excluded.floor_fils returning category`,
      [r.category, r.rateBp, r.floor],
    );
    changed += res.rows.length;
  }
  return changed;
}

export async function updatePricingSettings(tx: Queryable, actor: SessionUser, patch: Partial<Pick<PricingSettings, "capFactorBp" | "roundTo">>, note: string) {
  if (!isFounder(actor)) throw forbidden("Only the founder changes pricing settings");
  const before = await loadSettings(tx);
  const after: PricingSettings = { ...before, ...patch };
  if (after.capFactorBp < 10_000 || after.capFactorBp > 30_000) throw badRequest("Cap factor must be between 1.0x and 3.0x (10000 to 30000 basis points)");
  if (![100, 500, 1_000, 5_000, 10_000].includes(after.roundTo)) throw badRequest("Round to AED 1, 5, 10, 50 or 100");
  if (after.vatBp !== DEFAULT_SETTINGS.vatBp) throw badRequest("VAT is set by law and is not editable here");
  await tx.query("insert into settings (key, value) values ('pricing', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(after)]);
  await audit(tx, actor, "rules.pricing_settings_changed", "settings", "pricing", { before, after, note });
  return after;
}

export interface NewFee {
  code: string;
  emirate: string;
  freeZone?: string | null;
  feeFils: number;
  sourceUrl: string;
  sourceNote: string;
  effectiveFrom?: string;
}

/** Add a fee row. It starts UNCERTAIN whoever adds it; only verification makes it chargeable without review. */
export async function addFee(tx: Queryable, actor: SessionUser, fee: NewFee) {
  if (!canEditFees(actor)) throw forbidden("Only ops and the founder add fees");
  const d = await tx.query("select 1 from deliverables where code = $1", [fee.code]);
  if (!d.rows.length) throw notFound(`Unknown service code ${fee.code}`);
  if (!Number.isInteger(fee.feeFils) || fee.feeFils < 0) throw badRequest("Fee must be whole fils, zero or more");
  const effectiveFrom = fee.effectiveFrom ?? (await dbToday(tx));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw badRequest("Give the effective date as YYYY-MM-DD");
  const zone = fee.freeZone?.trim() || null;
  // One live row per code, place and effective date; a replacement retires the earlier row.
  const dup = await tx.query<{ id: string }>(
    "select id from government_fees where code = $1 and emirate = $2 and free_zone is not distinct from $3 and effective_from = $4::date and retired_at is null",
    [fee.code, fee.emirate.trim(), zone, effectiveFrom],
  );
  for (const r of dup.rows) await tx.query("update government_fees set retired_at = app_now() where id = $1", [r.id]);
  const row = (
    await tx.query<{ id: string }>(
      `insert into government_fees (code, emirate, free_zone, fee_fils, source_url, source_note, effective_from, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [fee.code, fee.emirate.trim(), zone, fee.feeFils, fee.sourceUrl.trim(), fee.sourceNote.trim(), effectiveFrom, actor.id],
    )
  ).rows[0]!;
  await audit(tx, actor, "fees.added", "government_fee", row.id, { ...fee, freeZone: zone, effectiveFrom, replaced: dup.rows.map((r) => r.id), confidence: "UNCERTAIN" });
  return { id: row.id, confidence: "UNCERTAIN" as const };
}

/** The founder records that a named qualified person has checked this fee against its source. */
export async function verifyFee(tx: Queryable, actor: SessionUser, feeId: string, verifiedBy: string) {
  if (!isFounder(actor)) throw forbidden("Only the founder records a fee verification");
  if (verifiedBy.trim().length < 2) throw badRequest("Name the person who verified the fee");
  const f = (await tx.query<Record<string, unknown>>("select * from government_fees where id = $1", [feeId])).rows[0];
  if (!f) throw notFound("Fee not found");
  if (f.retired_at) throw conflict("This fee row has been retired");
  if (!String(f.source_url ?? "").trim()) throw badRequest("A fee needs a source link before it can be verified");
  await tx.query("update government_fees set confidence = 'verified', verified_by = $2, verified_at = app_now()::date where id = $1", [feeId, verifiedBy.trim()]);
  await audit(tx, actor, "fees.verified", "government_fee", feeId, { code: f.code, emirate: f.emirate, freeZone: f.free_zone, fee: num(f.fee_fils), verifiedBy: verifiedBy.trim() });
  return { ok: true };
}

export async function retireFee(tx: Queryable, actor: SessionUser, feeId: string, reason: string) {
  if (!canEditFees(actor)) throw forbidden("Only ops and the founder retire fees");
  const r = await tx.query("update government_fees set retired_at = app_now() where id = $1 and retired_at is null returning code", [feeId]);
  if (!r.rows.length) throw notFound("Fee not found or already retired");
  await audit(tx, actor, "fees.retired", "government_fee", feeId, { reason });
  return { ok: true };
}

export async function catalogue(tx: Queryable) {
  const rules = await loadRules(tx, await dbToday(tx));
  const rows = await tx.query<Record<string, unknown>>(
    `select d.code, d.name, d.category, d.model, d.billing, d.market_mid_fils, d.mid_basis, d.requires, d.required_evidence, d.sheet_row, d.active,
       (select count(*)::int from government_fees f where f.code = d.code and f.retired_at is null) as fee_rows,
       (select count(*)::int from government_fees f where f.code = d.code and f.retired_at is null and f.confidence = 'verified') as verified_fee_rows,
       (select count(*)::int from rate_cards rc where rc.code = d.code and rc.valid_to >= app_now()::date) as rate_cards
     from deliverables d order by d.category, d.code`,
  );
  return rows.rows.map((d) => ({
    code: d.code,
    name: d.name,
    category: d.category,
    model: d.model,
    billing: d.billing,
    marketMid: num(d.market_mid_fils),
    midBasis: d.mid_basis,
    requires: d.requires,
    requiredEvidence: d.required_evidence,
    sheetRow: d.sheet_row,
    active: d.active,
    feeRows: num(d.fee_rows),
    verifiedFeeRows: num(d.verified_fee_rows),
    rateCards: num(d.rate_cards),
    rule: rules.get(String(d.category)) ?? null,
  }));
}

import {
  DEFAULT_SETTINGS,
  type CostQuote,
  type Deliverable,
  type MarginRule,
  type PartnerProfile,
  type PricingSettings,
} from "@tasees/core";
import { num, type Queryable } from "../lib/db.ts";

/** Loaders that turn rows into core types. All run inside a platform transaction. */

export async function loadDeliverables(tx: Queryable): Promise<Map<string, Deliverable>> {
  const r = await tx.query<Record<string, unknown>>("select * from deliverables");
  return new Map(
    r.rows.map((d) => [
      String(d.code),
      {
        code: String(d.code),
        name: String(d.name),
        category: String(d.category),
        model: d.model as Deliverable["model"],
        billing: d.billing as Deliverable["billing"],
        marketMid: num(d.market_mid_fils),
        midBasis: d.mid_basis as Deliverable["midBasis"],
        govFeeTable: d.gov_fee_fils === null ? null : num(d.gov_fee_fils),
        requiredEvidence: (d.required_evidence as string[]) ?? [],
        requires: ((d.requires as string[]) ?? []) as Deliverable["requires"],
      },
    ]),
  );
}

/** The margin rule per category in force on `asOf` (default today): the latest version whose effective date has arrived. */
export async function loadRules(tx: Queryable, asOf: string = today()): Promise<Map<string, MarginRule>> {
  const r = await tx.query<{ category: string; rate_bp: number; floor_fils: number }>(
    `select distinct on (category) category, rate_bp, floor_fils from margin_rule_versions
     where effective_from <= $1::date order by category, effective_from desc`,
    [asOf],
  );
  return new Map(r.rows.map((m) => [m.category, { category: m.category, rateBp: num(m.rate_bp), floor: num(m.floor_fils) }]));
}

export const FEE_STALE_DAYS = 90;

export interface FeeLookup {
  id: string;
  fee: number;
  confidence: "UNCERTAIN" | "verified";
  /** Verified more than FEE_STALE_DAYS ago. */
  stale: boolean;
  scope: "free_zone" | "emirate";
  verifiedBy: string | null;
  verifiedAt: string | null;
}

/**
 * MKW's government fee for each code at a place. A free-zone row beats an emirate-wide row; only rows in force
 * on `asOf` and not retired count. Codes without a row are absent from the map (the partner's figure is used).
 */
export async function loadGovernmentFees(tx: Queryable, codes: string[], emirate: string, freeZone: string | null, asOf: string = today()): Promise<Map<string, FeeLookup>> {
  if (codes.length === 0) return new Map();
  const r = await tx.query<Record<string, unknown>>(
    `select distinct on (code) id, code, fee_fils, confidence, free_zone, verified_by, verified_at::text as verified_at from government_fees
     where code = any($1) and emirate = $2 and (free_zone is null or free_zone = $3) and effective_from <= $4::date and retired_at is null
     order by code, (free_zone is not null) desc, effective_from desc`,
    [codes, emirate, freeZone ?? "", asOf],
  );
  const out = new Map<string, FeeLookup>();
  for (const row of r.rows) {
    const verifiedAt = row.verified_at ? String(row.verified_at).slice(0, 10) : null;
    const ageDays = verifiedAt ? Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${verifiedAt}T00:00:00Z`)) / 86_400_000) : null;
    out.set(String(row.code), {
      id: String(row.id),
      fee: num(row.fee_fils),
      confidence: row.confidence as FeeLookup["confidence"],
      stale: row.confidence === "verified" && (ageDays === null || ageDays > FEE_STALE_DAYS),
      scope: row.free_zone ? "free_zone" : "emirate",
      verifiedBy: (row.verified_by as string | null) ?? null,
      verifiedAt,
    });
  }
  return out;
}

export async function loadSettings(tx: Queryable): Promise<PricingSettings> {
  const r = await tx.query<{ value: Partial<PricingSettings> }>("select value from settings where key = 'pricing'");
  return { ...DEFAULT_SETTINGS, ...(r.rows[0]?.value ?? {}) };
}

interface ProfileJson {
  status?: PartnerProfile["status"];
  quality?: number;
  changeOrderRate?: number;
  capacity?: number;
  deliveredOnTime?: number;
  licenceActive?: boolean;
  agreementSigned?: boolean;
  emirates?: string[];
  codes?: string[];
  ftaTaxAgent?: boolean;
  approvedAuditorZones?: string[];
  registeredLiquidator?: boolean;
  conflicts?: string[];
}

export async function loadPartners(tx: Queryable): Promise<Map<string, PartnerProfile>> {
  const r = await tx.query<{ id: string; name: string; profile: ProfileJson; live: number }>(
    `select o.id, o.name, o.profile,
       (select count(distinct a.engagement_id) from allocations a join engagements e on e.id = a.engagement_id
         where a.partner_org_id = o.id and (a.accepted_at is not null or (a.declined_at is null and a.timed_out_at is null))
           and e.status in ('allocating', 'in_delivery', 'disputed'))::int as live
     from orgs o where o.type = 'partner'`,
  );
  return new Map(
    r.rows.map((o) => {
      const p = o.profile ?? {};
      const live = num(o.live);
      return [
        o.id,
        {
          id: o.id,
          name: o.name,
          status: p.status ?? "prospect",
          quality: p.quality ?? 60,
          changeOrderRate: p.changeOrderRate ?? 0,
          capacityLeft: Math.max(0, (p.capacity ?? 10) - live),
          liveJobs: live,
          deliveredOnTime: p.deliveredOnTime ?? 0,
          licenceActive: p.licenceActive ?? false,
          agreementSigned: p.agreementSigned ?? false,
          emirates: p.emirates ?? [],
          codes: p.codes ?? [],
          ftaTaxAgent: p.ftaTaxAgent ?? false,
          approvedAuditorZones: p.approvedAuditorZones ?? [],
          registeredLiquidator: p.registeredLiquidator ?? false,
          conflicts: p.conflicts ?? [],
        } satisfies PartnerProfile,
      ];
    }),
  );
}

/** Active rate cards from partners who can take work, valid on `onDate`. */
export async function loadRateCards(tx: Queryable, codes: string[], onDate: string): Promise<CostQuote[]> {
  if (codes.length === 0) return [];
  const r = await tx.query<Record<string, unknown>>(
    `select rc.* from rate_cards rc join orgs o on o.id = rc.partner_org_id
     where rc.code = any($1) and rc.valid_to >= $2::date and o.profile->>'status' in ('signed', 'pilot')`,
    [codes, onDate],
  );
  return r.rows.map((c) => ({
    id: `rc:${c.id}`,
    partnerId: String(c.partner_org_id),
    code: String(c.code),
    professionalFee: num(c.professional_fils),
    govFeeStated: num(c.gov_stated_fils),
    thirdPartyCost: num(c.third_party_fils),
    workingDays: num(c.working_days),
    exclusions: (c.exclusions as string[]) ?? [],
    gapCost: num(c.gap_fils),
    source: "rate_card",
    validTo: String(c.valid_to).slice(0, 10),
  }));
}

/** Sealed quotes submitted for a request. */
export async function loadRfqQuotes(tx: Queryable, requestId: string): Promise<CostQuote[]> {
  const r = await tx.query<Record<string, unknown>>(
    `select l.*, q.partner_org_id from partner_quote_lines l
       join partner_quotes q on q.id = l.quote_id
       join quote_requests qr on qr.id = q.quote_request_id
     where qr.request_id = $1`,
    [requestId],
  );
  return r.rows.map((l) => ({
    id: `pq:${l.id}`,
    partnerId: String(l.partner_org_id),
    code: String(l.code),
    professionalFee: num(l.professional_fils),
    govFeeStated: num(l.gov_stated_fils),
    thirdPartyCost: num(l.third_party_fils),
    workingDays: num(l.working_days),
    exclusions: (l.exclusions as string[]) ?? [],
    gapCost: num(l.gap_fils),
    source: "rfq",
  }));
}

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

/** Today by the application clock (app_now(), which tests and replays can set), as YYYY-MM-DD. */
export async function dbToday(tx: Queryable): Promise<string> {
  const r = await tx.query<{ d: string }>("select app_now()::date::text as d");
  return String(r.rows[0]!.d).slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return today(d);
}

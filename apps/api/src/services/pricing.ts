import {
  assertOffer,
  offerTotals,
  priceLine,
  scoreQuotes,
  selectForTier,
  type CostQuote,
  type OfferStatus,
  type PricedLine,
  type ScopeLine,
  type Tier,
} from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { addDays, loadDeliverables, loadPartners, loadRateCards, loadRfqQuotes, loadRules, loadSettings, today } from "./repo.ts";

export const OFFER_VALID_DAYS = 14;

export interface BuildResult {
  offerIds: string[];
  missing: string[];
}

/**
 * Build one offer per tier for a request from active rate cards and any sealed quotes.
 * Lines with no eligible cost are reported as `missing`: start a request for quote for those.
 * Offers start as draft (all lines fine) or ops_review (a line breaks the margin floor or the cap).
 */
export async function buildOffers(
  tx: Queryable,
  actor: SessionUser | null,
  requestId: string,
  tiers: Tier[] = ["essential", "standard", "priority"],
): Promise<BuildResult> {
  const req = (
    await tx.query<{ id: string; client_org_id: string; scope: { lines: ScopeLine[] }; status: string }>(
      "select id, client_org_id, scope, status from requests where id = $1",
      [requestId],
    )
  ).rows[0];
  if (!req) throw notFound("Request not found");
  const lines = req.scope?.lines ?? [];
  if (lines.length === 0) throw badRequest("The request has no deliverables to price");

  const [deliverables, rules, settings, partners] = await Promise.all([
    loadDeliverables(tx),
    loadRules(tx),
    loadSettings(tx),
    loadPartners(tx),
  ]);
  const codes = lines.map((l) => l.code);
  const cards = await loadRateCards(tx, codes, today());
  const rfq = await loadRfqQuotes(tx, requestId);
  const all: CostQuote[] = [...cards, ...rfq].filter((q) => {
    const p = partners.get(q.partnerId);
    return p && (p.status === "signed" || p.status === "pilot") && p.licenceActive && p.agreementSigned;
  });

  const missing = codes.filter((c) => !all.some((q) => q.code === c));
  if (missing.length > 0) {
    await tx.query("update requests set status = 'quoting' where id = $1", [requestId]);
    return { offerIds: [], missing };
  }

  // Withdraw earlier unaccepted offers for this request so only one set is live.
  await tx.query(
    "update offers set status = 'withdrawn' where request_id = $1 and status in ('draft', 'ops_review', 'published')",
    [requestId],
  );

  const offerIds: string[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    const picked: Array<{ line: PricedLine; partnerId: string; fallbackId: string | null; sourceId: string }> = [];
    for (const sl of lines) {
      const d = deliverables.get(sl.code);
      if (!d) throw badRequest(`Unknown deliverable ${sl.code}`);
      const rule = rules.get(d.category);
      if (!rule) throw badRequest(`No margin rule for category ${d.category}`);
      // Prefer a sealed quote over a rate card from the same partner for the same code.
      const quotes = dedupeByPartner(all.filter((q) => q.code === sl.code));
      const scored = scoreQuotes(quotes, d, partners, settings.weights);
      const sel = selectForTier(scored, tier);
      if (!sel) continue;
      const line = priceLine(
        { deliverable: d, qty: sl.qty, partnerUnitCost: sel.chosen.partnerUnitCost, govUnitFee: sel.chosen.govFeeUsed, rule },
        settings,
      );
      picked.push({ line, partnerId: sel.chosen.partnerId, fallbackId: sel.fallback?.partnerId ?? null, sourceId: sel.chosen.quoteId });
    }
    // Skip a tier that comes out identical to one already built (common with few partners).
    const signature = picked.map((p) => `${p.line.code}:${p.sourceId}`).join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);

    const totals = offerTotals(
      picked.map((p) => p.line),
      settings,
    );
    const status: OfferStatus = totals.linesNeedingReview > 0 ? "ops_review" : "draft";
    const offer = (
      await tx.query<{ id: string }>(
        `insert into offers (request_id, client_org_id, tier, status, valid_to, professional_fils, mkw_fees_fils, vat_fils,
           government_fils, client_total_fils, partner_payout_fils, margin_fils, margin_bp, lines_needing_review)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [
          requestId,
          req.client_org_id,
          tier,
          status,
          addDays(today(), OFFER_VALID_DAYS),
          totals.professional,
          totals.mkwFees,
          totals.vat,
          totals.government,
          totals.clientTotal,
          totals.partnerPayout,
          totals.margin,
          totals.marginBp,
          totals.linesNeedingReview,
        ],
      )
    ).rows[0]!;
    for (const p of picked) {
      const l = p.line;
      await tx.query(
        `insert into offer_lines (offer_id, code, qty, model, partner_org_id, fallback_partner_org_id, cost_source_id,
           partner_unit_fils, gov_unit_fils, client_unit_fils, mkw_fee_unit_fils, margin_unit_fils, cap_unit_fils, status, reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          offer.id,
          l.code,
          l.qty,
          l.model,
          p.partnerId,
          p.fallbackId,
          p.sourceId,
          l.partnerUnitCost,
          l.govUnitFee,
          l.clientUnitPrice,
          l.mkwFeeUnit,
          l.marginUnit,
          l.capUnit,
          l.status,
          l.reason ?? null,
        ],
      );
    }
    offerIds.push(offer.id);
    await audit(tx, actor, "offer.built", "offer", offer.id, { tier, status, margin: totals.margin, requestId });
  }
  await tx.query("update requests set status = 'offered' where id = $1", [requestId]);
  return { offerIds, missing: [] };
}

function dedupeByPartner(quotes: CostQuote[]): CostQuote[] {
  const best = new Map<string, CostQuote>();
  for (const q of quotes) {
    const cur = best.get(q.partnerId);
    if (!cur || (q.source === "rfq" && cur.source === "rate_card")) best.set(q.partnerId, q);
  }
  return [...best.values()];
}

export async function publishOffer(tx: Queryable, actor: SessionUser, offerId: string): Promise<void> {
  const o = (await tx.query<{ status: OfferStatus }>("select status from offers where id = $1", [offerId])).rows[0];
  if (!o) throw notFound("Offer not found");
  assertOffer(o.status, "published", "platform");
  await tx.query("update offers set status = 'published', published_at = app_now() where id = $1", [offerId]);
  await audit(tx, actor, "offer.published", "offer", offerId, { from: o.status });
}

/** Ops may override one line's client price, for example after a negotiation. Totals are recomputed. */
export async function overrideLinePrice(
  tx: Queryable,
  actor: SessionUser,
  offerId: string,
  code: string,
  clientUnitFils: number,
): Promise<void> {
  const o = (await tx.query<{ status: string }>("select status from offers where id = $1", [offerId])).rows[0];
  if (!o) throw notFound("Offer not found");
  if (!["draft", "ops_review"].includes(o.status)) throw conflict("Only unpublished offers can be changed");
  const line = (
    await tx.query<{ id: string; partner_unit_fils: number; model: string }>(
      "select id, partner_unit_fils, model from offer_lines where offer_id = $1 and code = $2",
      [offerId, code],
    )
  ).rows[0];
  if (!line) throw notFound("Line not found");
  if (line.model !== "reseller") throw badRequest("Agent-model lines carry the partner's own fee and cannot be repriced here");
  const margin = clientUnitFils - num(line.partner_unit_fils);
  if (margin < 0) throw badRequest("The price cannot be below the partner's cost");
  await tx.query(
    "update offer_lines set client_unit_fils = $1, margin_unit_fils = $2, status = 'ok', reason = 'Price set by ops' where id = $3",
    [clientUnitFils, margin, line.id],
  );
  await recomputeOffer(tx, offerId);
  await audit(tx, actor, "offer.line_overridden", "offer", offerId, { code, clientUnitFils, margin });
}

export async function recomputeOffer(tx: Queryable, offerId: string): Promise<void> {
  const settings = await loadSettings(tx);
  const rows = (
    await tx.query<Record<string, number | string>>("select * from offer_lines where offer_id = $1", [offerId])
  ).rows;
  const lines: PricedLine[] = rows.map((r) => ({
    code: String(r.code),
    qty: num(r.qty),
    model: r.model as PricedLine["model"],
    partnerUnitCost: num(r.partner_unit_fils),
    govUnitFee: num(r.gov_unit_fils),
    clientUnitPrice: num(r.client_unit_fils),
    mkwFeeUnit: num(r.mkw_fee_unit_fils),
    capUnit: num(r.cap_unit_fils),
    marginUnit: num(r.margin_unit_fils),
    capped: false,
    status: r.status as PricedLine["status"],
  }));
  const t = offerTotals(lines, settings);
  await tx.query(
    `update offers set professional_fils=$2, mkw_fees_fils=$3, vat_fils=$4, government_fils=$5, client_total_fils=$6,
       partner_payout_fils=$7, margin_fils=$8, margin_bp=$9, lines_needing_review=$10 where id=$1`,
    [offerId, t.professional, t.mkwFees, t.vat, t.government, t.clientTotal, t.partnerPayout, t.margin, t.marginBp, t.linesNeedingReview],
  );
}

export async function expireOffers(tx: Queryable): Promise<number> {
  const r = await tx.query<{ id: string }>(
    "update offers set status = 'expired' where status = 'published' and valid_to < app_now()::date returning id",
  );
  return r.rows.length;
}

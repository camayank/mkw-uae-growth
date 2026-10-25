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
import { transition, withdrawOffers } from "../lib/transition.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { addDays, dbToday, loadDeliverables, loadGovernmentFees, loadPartners, loadRateCards, loadRfqQuotes, loadRules, loadSettings, type FeeLookup } from "./repo.ts";

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
    await tx.query<{ id: string; client_org_id: string; scope: { lines: ScopeLine[] }; status: string; answers: { emirate?: string; freeZone?: string | null } }>(
      "select id, client_org_id, scope, status, answers from requests where id = $1",
      [requestId],
    )
  ).rows[0];
  if (!req) throw notFound("Request not found");
  const lines = req.scope?.lines ?? [];
  if (lines.length === 0) throw badRequest("The request has no deliverables to price");

  const asOf = await dbToday(tx);
  const codes = lines.map((l) => l.code);
  const [deliverables, rules, settings, partners, fees] = await Promise.all([
    loadDeliverables(tx),
    loadRules(tx, asOf),
    loadSettings(tx),
    loadPartners(tx),
    loadGovernmentFees(tx, codes, req.answers.emirate ?? "", req.answers.freeZone ?? null, asOf),
  ]);
  // MKW's own fee table, where it has a row for this place, replaces the partner's stated government fee.
  for (const [code, f] of fees) {
    const d = deliverables.get(code);
    if (d) d.govFeeTable = f.fee;
  }
  const cards = await loadRateCards(tx, codes, asOf);
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
  await withdrawOffers(tx, requestId);

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
      const line = withFeeCheck(
        priceLine({ deliverable: d, qty: sl.qty, partnerUnitCost: sel.chosen.partnerUnitCost, govUnitFee: sel.chosen.govFeeUsed, rule }, settings),
        fees.get(sl.code),
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
           government_fils, client_total_fils, partner_payout_fils, margin_fils, margin_bp, lines_needing_review, rules_as_of)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [
          requestId,
          req.client_org_id,
          tier,
          status,
          addDays(asOf, OFFER_VALID_DAYS),
          totals.professional,
          totals.mkwFees,
          totals.vat,
          totals.government,
          totals.clientTotal,
          totals.partnerPayout,
          totals.margin,
          totals.marginBp,
          totals.linesNeedingReview,
          asOf,
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

/**
 * A government fee a client is charged must come from a verified, current row of MKW's table. An UNCERTAIN or
 * stale row prices the line but sends it to ops review with the reason; no row at all uses the partner's figure
 * and says so, so ops can see where the table has gaps.
 */
export function withFeeCheck(line: PricedLine, fee: FeeLookup | undefined): PricedLine {
  const note = (reason: string): PricedLine => ({ ...line, status: "ops_review", reason: line.reason ? `${line.reason}; ${reason}` : reason });
  if (!fee) return line.govUnitFee > 0 ? { ...line, reason: line.reason ? `${line.reason}; government fee as stated by the partner (no table row)` : "Government fee as stated by the partner (no table row)" } : line;
  if (fee.confidence === "UNCERTAIN") return note("Government fee UNCERTAIN: verify it before this reaches the client");
  if (fee.stale) return note(`Government fee verified over 90 days ago (${fee.verifiedAt}): re-verify before this reaches the client`);
  return line;
}

function dedupeByPartner(quotes: CostQuote[]): CostQuote[] {
  const best = new Map<string, CostQuote>();
  for (const q of quotes) {
    const cur = best.get(q.partnerId);
    if (!cur || (q.source === "rfq" && cur.source === "rate_card")) best.set(q.partnerId, q);
  }
  return [...best.values()];
}

/**
 * Publishing is the person's approval of everything on the offer. Lines flagged for review (margin below the
 * floor after the cap, an UNCERTAIN or stale government fee) stop the publish unless the person acknowledges
 * them, and the flagged lines with their reasons are written into the audit event so the approval is evidenced.
 */
export async function publishOffer(tx: Queryable, actor: SessionUser, offerId: string, acknowledgeReview = false): Promise<void> {
  const o = (await tx.query<{ status: OfferStatus }>("select status from offers where id = $1 for update", [offerId])).rows[0];
  if (!o) throw notFound("Offer not found");
  assertOffer(o.status, "published", "platform");
  const flagged = (
    await tx.query<{ code: string; reason: string | null; gov_unit_fils: number; client_unit_fils: number }>(
      "select code, reason, gov_unit_fils, client_unit_fils from offer_lines where offer_id = $1 and status <> 'ok' order by code",
      [offerId],
    )
  ).rows;
  if (flagged.length && !acknowledgeReview) {
    throw conflict(`${flagged.length} line(s) need a decision before this offer can go to the client: ${flagged.map((l) => `${l.code} (${l.reason ?? "review"})`).join("; ")}`);
  }
  await transition(tx, "offer", offerId, "published", "platform", {
    audit: {
      actor,
      action: "offer.published",
      data: {
        acknowledgedLines: flagged.map((l) => ({ code: l.code, reason: l.reason, govUnit: num(l.gov_unit_fils), clientUnit: num(l.client_unit_fils) })),
      },
    },
  });
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
  const r = await tx.query<{ id: string }>("select id from offers where status = 'published' and valid_to < app_now()::date order by id for update");
  for (const o of r.rows) await transition(tx, "offer", o.id, "expired", "system");
  return r.rows.length;
}

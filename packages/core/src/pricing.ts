import { applyBp, ceilTo, floorTo, splitByShares, type BasisPoints, type Fils } from "./money.ts";
import type { ContractingModel, Deliverable, MarginRule, PricingSettings } from "./types.ts";

export type LineStatus = "ok" | "ops_review";

export interface PricedLine {
  code: string;
  qty: number;
  model: ContractingModel;
  /** What the partner earns per unit (professional + third-party). */
  partnerUnitCost: Fils;
  /** Government fee per unit, passed through at cost. */
  govUnitFee: Fils;
  /** Reseller: MKW's price to the client per unit. Agent: the partner's own professional fee per unit. */
  clientUnitPrice: Fils;
  /** Agent model only: MKW's disclosed coordination fee per unit. Zero for reseller lines. */
  mkwFeeUnit: Fils;
  /** The highest professional price per unit the market cap allows. */
  capUnit: Fils;
  marginUnit: Fils;
  capped: boolean;
  status: LineStatus;
  reason?: string;
}

export interface LineInput {
  deliverable: Deliverable;
  qty: number;
  partnerUnitCost: Fils;
  govUnitFee: Fils;
  rule: MarginRule;
}

/**
 * Reseller lines: client price = max(cost × (1 + m), cost + floor), rounded up to the step,
 * then capped so (price, plus government fee where the market mid includes it) stays within market mid × cap factor.
 * If the cap pushes the margin below the floor, the line goes to ops review instead of being sent.
 *
 * Agent lines: the partner bills its own fee; MKW adds a disclosed fee = max(cost × m, floor), rounded up.
 */
export function priceLine(input: LineInput, settings: PricingSettings): PricedLine {
  const { deliverable: d, qty, partnerUnitCost: cost, govUnitFee: gov, rule } = input;
  if (!Number.isInteger(qty) || qty < 1) throw new Error(`qty must be a whole number of 1 or more, got ${qty}`);
  const marketCap = applyBp(d.marketMid, settings.capFactorBp);
  const capUnit = Math.max(0, d.midBasis === "incl_govt" ? marketCap - gov : marketCap);

  if (d.model === "agent") {
    const fee = ceilTo(Math.max(applyBp(cost, rule.rateBp), rule.floor), settings.roundTo);
    const overCap = cost + fee > capUnit;
    return {
      code: d.code,
      qty,
      model: "agent",
      partnerUnitCost: cost,
      govUnitFee: gov,
      clientUnitPrice: cost,
      mkwFeeUnit: fee,
      capUnit,
      marginUnit: fee,
      capped: false,
      status: overCap ? "ops_review" : "ok",
      reason: overCap ? "Partner fee plus MKW fee is above the market cap" : undefined,
    };
  }

  const byRule = ceilTo(Math.max(cost + applyBp(cost, rule.rateBp), cost + rule.floor), settings.roundTo);
  const capRounded = floorTo(capUnit, settings.roundTo);
  const capped = byRule > capRounded;
  const price = capped ? capRounded : byRule;
  const margin = price - cost;
  const belowFloor = margin < rule.floor;
  return {
    code: d.code,
    qty,
    model: "reseller",
    partnerUnitCost: cost,
    govUnitFee: gov,
    clientUnitPrice: price,
    mkwFeeUnit: 0,
    capUnit,
    marginUnit: margin,
    capped,
    status: belowFloor ? "ops_review" : "ok",
    reason: belowFloor ? "Market cap leaves less than the margin floor" : undefined,
  };
}

export interface OfferTotals {
  /** Professional fees the client pays: reseller prices plus agent partner fees. */
  professional: Fils;
  mkwFees: Fils;
  vat: Fils;
  government: Fils;
  clientTotal: Fils;
  partnerPayout: Fils;
  margin: Fils;
  marginBp: BasisPoints;
  linesNeedingReview: number;
}

export function offerTotals(lines: PricedLine[], settings: PricingSettings): OfferTotals {
  const professional = sum(lines.map((l) => l.clientUnitPrice * l.qty));
  const mkwFees = sum(lines.map((l) => l.mkwFeeUnit * l.qty));
  const government = sum(lines.map((l) => l.govUnitFee * l.qty));
  const vat = applyBp(professional + mkwFees, settings.vatBp);
  const partnerPayout = sum(lines.map((l) => l.partnerUnitCost * l.qty));
  const margin = sum(lines.map((l) => l.marginUnit * l.qty));
  const base = professional + mkwFees;
  return {
    professional,
    mkwFees,
    vat,
    government,
    clientTotal: professional + mkwFees + vat + government,
    partnerPayout,
    margin,
    marginBp: base === 0 ? 0 : Math.round((margin * 10_000) / base),
    linesNeedingReview: lines.filter((l) => l.status !== "ok").length,
  };
}

export interface PaymentPlan {
  clientOnAcceptance: Fils;
  clientOnCompletion: Fils;
  partnerKickoff: Fils;
  partnerKeyMilestone: Fils;
  partnerCompletion: Fils;
}

/**
 * Client pays a deposit share of fees and VAT plus all government fees on acceptance, the balance on completion.
 * Partner payouts split 40 / 40 / 20 by default; shares are basis points and must add up to 10000.
 */
export function paymentPlan(
  totals: OfferTotals,
  depositBp: BasisPoints = 5_000,
  payoutSharesBp: [BasisPoints, BasisPoints, BasisPoints] = [4_000, 4_000, 2_000],
): PaymentPlan {
  const feesAndVat = totals.professional + totals.mkwFees + totals.vat;
  const [onAccept, onComplete] = splitByShares(feesAndVat, [depositBp, 10_000 - depositBp]);
  const [k, m, c] = splitByShares(totals.partnerPayout, payoutSharesBp);
  return {
    clientOnAcceptance: (onAccept ?? 0) + totals.government,
    clientOnCompletion: onComplete ?? 0,
    partnerKickoff: k ?? 0,
    partnerKeyMilestone: m ?? 0,
    partnerCompletion: c ?? 0,
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

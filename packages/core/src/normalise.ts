import { applyBp, type BasisPoints, type Fils } from "./money.ts";
import type { CostQuote, Deliverable } from "./types.ts";

/**
 * Risk loading for partners that re-price after winning.
 * Under 5% of jobs changed: no loading. Rises in a straight line to 10% (1000 bp) at 30% of jobs, capped there.
 */
export function riskLoadingBp(changeOrderRate: number): BasisPoints {
  if (!Number.isFinite(changeOrderRate) || changeOrderRate < 0.05) return 0;
  const capped = Math.min(changeOrderRate, 0.3);
  return Math.round(((capped - 0.05) / 0.25) * 1_000);
}

export interface NormalisedCost {
  quoteId: string;
  partnerId: string;
  code: string;
  govFeeUsed: Fils;
  riskLoading: Fils;
  comparableCost: Fils;
  /** What the partner is paid per unit if chosen (professional + third-party). */
  partnerUnitCost: Fils;
}

/**
 * Comparable cost = professional fee + government fee (platform table when set) + gap cost + third-party costs + risk loading.
 * Using the platform's government fee figure stops a partner looking cheaper by under-stating official fees.
 */
export function normalise(quote: CostQuote, deliverable: Deliverable, changeOrderRate: number): NormalisedCost {
  if (quote.code !== deliverable.code) {
    throw new Error(`quote ${quote.id} is for ${quote.code}, not ${deliverable.code}`);
  }
  const govFeeUsed = deliverable.govFeeTable ?? quote.govFeeStated;
  const riskLoading = applyBp(quote.professionalFee, riskLoadingBp(changeOrderRate));
  return {
    quoteId: quote.id,
    partnerId: quote.partnerId,
    code: quote.code,
    govFeeUsed,
    riskLoading,
    comparableCost: quote.professionalFee + govFeeUsed + quote.gapCost + quote.thirdPartyCost + riskLoading,
    partnerUnitCost: quote.professionalFee + quote.thirdPartyCost,
  };
}

/** True when the quote is still valid on the given ISO date (YYYY-MM-DD). */
export function isQuoteValid(quote: CostQuote, onDate: string): boolean {
  return !quote.validTo || quote.validTo >= onDate;
}

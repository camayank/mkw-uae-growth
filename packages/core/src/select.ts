import { normalise, type NormalisedCost } from "./normalise.ts";
import type { CostQuote, Deliverable, PartnerProfile, SelectionWeights, Tier } from "./types.ts";

export interface ScoredQuote extends NormalisedCost {
  workingDays: number;
  quality: number;
  fit: number;
  /** 0–100, one decimal. */
  score: number;
  rank: number;
}

/**
 * Selection score (0–100) = cost × w1 + quality × w2 + timeline × w3 + fit × w4.
 * Cost and timeline score the best quote 100 and others in proportion (best / own).
 * Fit is 100 when the partner covers the code and has capacity, otherwise 0.
 */
export function scoreQuotes(
  quotes: CostQuote[],
  deliverable: Deliverable,
  partners: Map<string, PartnerProfile>,
  weights: SelectionWeights,
): ScoredQuote[] {
  const normalised = quotes.map((q) => {
    const p = partners.get(q.partnerId);
    return { q, p, n: normalise(q, deliverable, p?.changeOrderRate ?? 0) };
  });
  if (normalised.length === 0) return [];
  const minCost = Math.min(...normalised.map((x) => x.n.comparableCost));
  const minDays = Math.min(...normalised.map((x) => Math.max(1, x.q.workingDays)));
  const scored = normalised.map(({ q, p, n }) => {
    const costScore = (100 * Math.max(1, minCost)) / Math.max(1, n.comparableCost);
    const timeScore = (100 * minDays) / Math.max(1, q.workingDays);
    const quality = p?.quality ?? 0;
    const fit = p && p.capacityLeft > 0 && p.codes.includes(q.code) ? 100 : 0;
    const raw =
      (weights.costBp * costScore + weights.qualityBp * quality + weights.timelineBp * timeScore + weights.fitBp * fit) /
      10_000;
    return { ...n, workingDays: q.workingDays, quality, fit, score: Math.round(raw * 10) / 10, rank: 0 };
  });
  const sorted = [...scored].sort(byScoreThenCost);
  sorted.forEach((s, i) => (s.rank = i + 1));
  return sorted;
}

function byScoreThenCost(a: ScoredQuote, b: ScoredQuote): number {
  return b.score - a.score || a.comparableCost - b.comparableCost || a.partnerId.localeCompare(b.partnerId);
}

export interface Selection {
  chosen: ScoredQuote;
  fallback: ScoredQuote | null;
}

/**
 * Pick the cost base for a tier.
 * Essential = lowest comparable cost. Standard = top selection score. Priority = fewest working days.
 * The fallback is the best remaining quote by score.
 */
export function selectForTier(scored: ScoredQuote[], tier: Tier): Selection | null {
  if (scored.length === 0) return null;
  const pool = [...scored];
  const cmp: Record<Tier, (a: ScoredQuote, b: ScoredQuote) => number> = {
    essential: (a, b) => a.comparableCost - b.comparableCost || byScoreThenCost(a, b),
    standard: byScoreThenCost,
    priority: (a, b) => a.workingDays - b.workingDays || byScoreThenCost(a, b),
  };
  pool.sort(cmp[tier]);
  const chosen = pool[0]!;
  const fallback = [...scored].sort(byScoreThenCost).find((s) => s.partnerId !== chosen.partnerId) ?? null;
  return { chosen, fallback };
}

/** Rank band a partner may see after a decision, without revealing other partners' numbers. */
export function rankBand(own: ScoredQuote, chosen: ScoredQuote): "won" | "within_5pct" | "within_15pct" | "above_15pct" {
  if (own.quoteId === chosen.quoteId) return "won";
  const gap = (own.comparableCost - chosen.comparableCost) / Math.max(1, chosen.comparableCost);
  if (gap <= 0.05) return "within_5pct";
  if (gap <= 0.15) return "within_15pct";
  return "above_15pct";
}

import type { Deliverable, PartnerProfile } from "./types.ts";

export type AllocationReason =
  | "quoting_partner"
  | "partner_sourced"
  | "existing_relationship"
  | "next_ranked_fairness_cap"
  | "next_ranked_quoting_ineligible"
  | "next_ranked_declined"
  | "next_ranked_sla_timeout"
  | "manual_override";

export interface AllocationContext {
  /** Codes in the engagement (all must be covered by the chosen partner). */
  codes: string[];
  emirate: string;
  /** Partner whose cost built the accepted offer. */
  quotingPartnerId: string | null;
  /** Ranked by selection score, best first; the quoting partner may or may not be in it. */
  rankedPartnerIds: string[];
  /** A partner that brought this client onto the platform: the job is locked to it. */
  sourcedByPartnerId?: string | null;
  /** A partner the client already works with. */
  existingPartnerId?: string | null;
  clientOrgId: string;
  /** Free zone of the client, for audit approvals. */
  freeZone?: string | null;
  /** Partners already tried on this engagement (declined or timed out). */
  excluded?: string[];
  /** Share of this category's new jobs each partner took this month (0–1). */
  monthShare: Map<string, number>;
  /** Reason to record when the default partner is skipped for an upstream event. */
  retryReason?: "next_ranked_declined" | "next_ranked_sla_timeout";
  /**
   * Margin protection. The offer was priced on the quoting partner's cost; another partner may take
   * the work only if its own cost for these lines is no higher. Omitted means no cost check.
   */
  withinPricedCost?: (partnerId: string) => boolean;
}

export interface AllocationRules {
  fairnessCap: number;
  qualityBar: number;
  probationMaxLive: number;
  probationJobs: number;
}

export const DEFAULT_RULES: AllocationRules = {
  fairnessCap: 0.35,
  qualityBar: 60,
  probationMaxLive: 3,
  probationJobs: 5,
};

export interface EligibilityResult {
  eligible: boolean;
  failures: string[];
}

/** Hard filters. A partner failing any one check never receives the engagement. */
export function checkEligibility(
  p: PartnerProfile,
  ctx: Pick<AllocationContext, "codes" | "emirate" | "clientOrgId" | "freeZone">,
  deliverables: Map<string, Deliverable>,
  rules: AllocationRules = DEFAULT_RULES,
): EligibilityResult {
  const failures: string[] = [];
  if (!(p.status === "signed" || p.status === "pilot")) failures.push("not signed or on pilot");
  if (!p.licenceActive) failures.push("licence not active");
  if (!p.agreementSigned) failures.push("agreement not signed");
  if (p.capacityLeft <= 0) failures.push("no capacity left");
  if (!p.emirates.includes(ctx.emirate) && !p.emirates.includes("All")) failures.push(`does not cover ${ctx.emirate}`);
  if (p.conflicts.includes(ctx.clientOrgId)) failures.push("conflict of interest");
  const onProbation = p.deliveredOnTime < rules.probationJobs;
  if (onProbation && p.liveJobs >= rules.probationMaxLive) failures.push("probation cap reached");
  for (const code of ctx.codes) {
    if (!p.codes.includes(code)) failures.push(`does not offer ${code}`);
    const d = deliverables.get(code);
    for (const req of d?.requires ?? []) {
      if (req === "fta_tax_agent" && !p.ftaTaxAgent) failures.push("not an FTA registered tax agent");
      if (req === "registered_liquidator" && !p.registeredLiquidator) failures.push("not a registered liquidator");
      if (req === "licensed_law_firm" && !p.licensedLawFirm) failures.push("not a licensed law firm");
      if (req === "regulatory_adviser" && !p.regulatoryAdviser) failures.push("not an authorised regulatory adviser");
      if (req === "approved_auditor") {
        const zone = ctx.freeZone ?? "mainland";
        if (!p.approvedAuditorZones.includes(zone)) failures.push(`not an approved auditor for ${zone}`);
      }
    }
  }
  return { eligible: failures.length === 0, failures };
}

export interface AllocationDecision {
  partnerId: string | null;
  reason: AllocationReason | "no_eligible_partner";
  fallbackId: string | null;
  skipped: Array<{ partnerId: string; why: string[] }>;
}

/**
 * Allocation order:
 *  1. eligibility (hard filters)
 *  2. partner-sourced clients stay with that partner
 *  3. an eligible partner the client already works with
 *  4. the quoting partner, unless over the fairness cap while others above the quality bar have capacity
 *  5. otherwise the next-ranked eligible partner
 */
export function allocate(
  ctx: AllocationContext,
  partners: Map<string, PartnerProfile>,
  deliverables: Map<string, Deliverable>,
  rules: AllocationRules = DEFAULT_RULES,
): AllocationDecision {
  const excluded = new Set(ctx.excluded ?? []);
  const skipped: AllocationDecision["skipped"] = [];
  const failuresOf = (id: string): string[] | null => {
    const p = partners.get(id);
    if (!p) return null;
    const failures = checkEligibility(p, ctx, deliverables, rules).failures;
    if (id !== ctx.quotingPartnerId && ctx.withinPricedCost && !ctx.withinPricedCost(id)) {
      failures.push("cost above the price the client accepted");
    }
    return failures;
  };
  const isEligible = (id: string | null | undefined): id is string => {
    if (!id || excluded.has(id)) return false;
    const failures = failuresOf(id);
    if (!failures) return false;
    if (failures.length) skipped.push({ partnerId: id, why: failures });
    return failures.length === 0;
  };

  const order = unique([ctx.quotingPartnerId, ...ctx.rankedPartnerIds].filter((x): x is string => !!x));
  const eligibleRanked = order.filter((id) => !excluded.has(id) && failuresOf(id)?.length === 0);
  const fallbackAfter = (chosen: string) => eligibleRanked.find((id) => id !== chosen) ?? null;

  if (ctx.sourcedByPartnerId && isEligible(ctx.sourcedByPartnerId)) {
    return done(ctx.sourcedByPartnerId, "partner_sourced");
  }
  if (ctx.existingPartnerId && isEligible(ctx.existingPartnerId)) {
    return done(ctx.existingPartnerId, "existing_relationship");
  }

  const quoting = ctx.quotingPartnerId;
  if (quoting && isEligible(quoting)) {
    const overCap = (ctx.monthShare.get(quoting) ?? 0) >= rules.fairnessCap;
    const alternative = eligibleRanked.find(
      (id) => id !== quoting && (partners.get(id)?.quality ?? 0) >= rules.qualityBar,
    );
    if (overCap && alternative) return done(alternative, "next_ranked_fairness_cap");
    return done(quoting, ctx.retryReason ?? "quoting_partner");
  }

  const next = eligibleRanked[0];
  if (next) return done(next, ctx.retryReason ?? "next_ranked_quoting_ineligible");
  for (const id of order) if (!excluded.has(id)) isEligible(id);
  return { partnerId: null, reason: "no_eligible_partner", fallbackId: null, skipped: dedupe(skipped) };

  function done(id: string, reason: AllocationReason): AllocationDecision {
    return { partnerId: id, reason, fallbackId: fallbackAfter(id), skipped: dedupe(skipped) };
  }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function dedupe(xs: AllocationDecision["skipped"]): AllocationDecision["skipped"] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.partnerId) ? false : (seen.add(x.partnerId), true)));
}

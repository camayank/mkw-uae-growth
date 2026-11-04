/**
 * E18: what a client is told about each government fee on an offer, from the evidence recorded when the offer was
 * priced. One function serves the online proposal, the downloadable offer, the acceptance record and MKW's offer
 * review, so they cannot disagree. The disclosure is read from the offer line's snapshot, never from MKW's fee table
 * as it stands today: a fee verified, added or retired after quotation does not rewrite what the client was told.
 */

/** Where a quoted government fee came from, recorded when the offer line is priced. */
export const FEE_BASES = ["verified", "partner_stated", "uncertain", "stale"] as const;
export type FeeBasis = (typeof FEE_BASES)[number];

/** The client-facing label. LEGACY is a line priced before E18, which recorded no basis. */
export type FeeLabel = "VERIFIED" | "PARTNER-STATED" | "UNCERTAIN" | "STALE" | "LEGACY";

/** A fee verified longer ago than this is stale (matches `FEE_STALE_DAYS` in the API's fee lookup). */
export const FEE_STALE_DAYS = 90;

/** MKW's fee record for a code at a place, as the pricing reads it. Absent when MKW has no record. */
export interface FeeRecord {
  confidence: "UNCERTAIN" | "verified";
  stale: boolean;
}

/** What the offer line recorded about its government fee. `basis` null means the line predates E18. */
export interface FeeEvidence {
  basis: FeeBasis | null;
  verifiedAt?: string | null;
  quotedOn?: string | null;
}

export interface FeeDisclosure {
  code: string;
  label: FeeLabel;
  /** True only for VERIFIED: everything else is an estimate the client should treat as one. */
  confirmed: boolean;
  /** One plain sentence for the client. Never the internal reason, never a partner's name or cost. */
  text: string;
}

/**
 * The basis of a fee at quotation. The pricing uses MKW's record when there is one (verified or not) and the partner's
 * stated figure only when there is none (`normalise`), so the basis follows the record.
 */
export function feeBasis(record: FeeRecord | undefined): FeeBasis {
  if (!record) return "partner_stated";
  if (record.confidence === "UNCERTAIN") return "uncertain";
  return record.stale ? "stale" : "verified";
}

/**
 * Whether the basis needs a person's acknowledgement before the offer reaches the client. UNCERTAIN and STALE do, as
 * before E18 (`withFeeCheck`). A partner-stated fee does not: that is the existing rule, kept until the owner decides
 * otherwise (D100 recommends requiring it).
 */
export function feeNeedsReview(basis: FeeBasis): boolean {
  return basis === "uncertain" || basis === "stale";
}

export function feeLabel(basis: FeeBasis | null): FeeLabel {
  switch (basis) {
    case "verified":
      return "VERIFIED";
    case "partner_stated":
      return "PARTNER-STATED";
    case "uncertain":
      return "UNCERTAIN";
    case "stale":
      return "STALE";
    default:
      return "LEGACY";
  }
}

const AT_COST = "You pay the authority's actual fee, at cost.";

/**
 * The disclosure for one line, or null when the line carries no government fee. A zero fee from an unverified or stale
 * record is still disclosed (E18 review): "no government fee" is a statement about the authority like any other.
 */
export function feeDisclosure(code: string, govUnitFee: number, evidence: FeeEvidence): FeeDisclosure | null {
  if (!(govUnitFee > 0) && evidence.basis !== "uncertain" && evidence.basis !== "stale") return null;
  const label = feeLabel(evidence.basis);
  const on = evidence.verifiedAt ? ` on ${evidence.verifiedAt}` : "";
  const text = {
    VERIFIED: `Checked by MKW Advisors against the authority's published fee, verified${on}. ${AT_COST}`,
    "PARTNER-STATED": `Estimate given by the delivery partner firm; MKW Advisors has not yet confirmed it with the authority. ${AT_COST}`,
    // The sentence clients read before E18 for an unverified fee, unchanged.
    UNCERTAIN: "Estimate: MKW Advisors confirms this government fee with the authority before it is paid; you pay the actual fee, at cost.",
    STALE: `Estimate: MKW Advisors last verified this fee${on}, more than ${FEE_STALE_DAYS} days before this offer, and confirms it with the authority before it is paid. ${AT_COST}`,
    LEGACY: `Estimate: this offer was prepared before MKW Advisors recorded where each government fee came from. ${AT_COST}`,
  }[label];
  return { code, label, confirmed: label === "VERIFIED", text };
}

/** The disclosures for an offer's lines, in the order given, leaving out lines without a government fee. */
export function feeDisclosures(lines: Array<{ code: string; govUnitFee: number } & FeeEvidence>): FeeDisclosure[] {
  return lines.flatMap((l) => {
    const d = feeDisclosure(l.code, l.govUnitFee, l);
    return d ? [d] : [];
  });
}

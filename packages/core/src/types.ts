import type { BasisPoints, Fils } from "./money.ts";

export type OrgType = "client" | "partner" | "platform";

export type Role =
  | "client_owner"
  | "client_member"
  | "partner_admin"
  | "partner_staff"
  | "ops"
  | "finance"
  | "founder"
  | "agent";

export const ROLE_ORG: Record<Role, OrgType> = {
  client_owner: "client",
  client_member: "client",
  partner_admin: "partner",
  partner_staff: "partner",
  ops: "platform",
  finance: "platform",
  founder: "platform",
  agent: "platform",
};

/** Reseller: MKW is the seller of record. Agent: the licensed partner contracts the client; MKW charges a disclosed fee. */
export type ContractingModel = "reseller" | "agent";
export type Billing = "one_off" | "monthly" | "yearly";
export type MidBasis = "incl_govt" | "service_only";

export interface Deliverable {
  code: string;
  name: string;
  category: string;
  model: ContractingModel;
  billing: Billing;
  marketMid: Fils;
  midBasis: MidBasis;
  /** The platform's own government fee figure; when set it replaces the partner's stated figure for comparison. */
  govFeeTable: Fils | null;
  requiredEvidence: string[];
  /** Licence checks a partner must pass to receive this work. */
  requires?: Array<"fta_tax_agent" | "approved_auditor" | "registered_liquidator" | "licensed_law_firm" | "regulatory_adviser">;
}

export interface MarginRule {
  category: string;
  rateBp: BasisPoints;
  floor: Fils;
}

export interface SelectionWeights {
  costBp: BasisPoints;
  qualityBp: BasisPoints;
  timelineBp: BasisPoints;
  fitBp: BasisPoints;
}

export interface PricingSettings {
  /** Offers may not exceed market mid × this factor (10000 = 1.0x). */
  capFactorBp: BasisPoints;
  /** Client prices round up to this step. */
  roundTo: Fils;
  vatBp: BasisPoints;
  weights: SelectionWeights;
}

export const DEFAULT_SETTINGS: PricingSettings = {
  capFactorBp: 12_500,
  roundTo: 5_000,
  vatBp: 500,
  weights: { costBp: 4_000, qualityBp: 3_000, timelineBp: 1_500, fitBp: 1_500 },
};

/** One partner's cost for one deliverable, from a rate card or a sealed quote. */
export interface CostQuote {
  id: string;
  partnerId: string;
  code: string;
  professionalFee: Fils;
  govFeeStated: Fils;
  thirdPartyCost: Fils;
  workingDays: number;
  exclusions: string[];
  /** Price of items the scope needs but the quote excludes, priced at catalogue mid. */
  gapCost: Fils;
  source: "rate_card" | "rfq";
  validTo?: string;
}

export type PartnerStatus = "prospect" | "contacted" | "pilot" | "signed" | "paused";

export interface PartnerProfile {
  id: string;
  name: string;
  status: PartnerStatus;
  /** 0–100 from the scorecard. */
  quality: number;
  /** Share of jobs in the last 90 days whose price changed after acceptance (0–1). */
  changeOrderRate: number;
  capacityLeft: number;
  liveJobs: number;
  deliveredOnTime: number;
  licenceActive: boolean;
  agreementSigned: boolean;
  emirates: string[];
  codes: string[];
  ftaTaxAgent: boolean;
  /** Licensed to appear before UAE courts and notarise; needed for litigation and notary work. */
  licensedLawFirm?: boolean;
  /** Authorised to advise on DFSA, FSRA or VARA licensing. */
  regulatoryAdviser?: boolean;
  approvedAuditorZones: string[];
  registeredLiquidator: boolean;
  conflicts: string[];
}

export type Tier = "essential" | "standard" | "priority";

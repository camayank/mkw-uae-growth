import { aed, type CostQuote, type Deliverable, type MarginRule, type PartnerProfile } from "../src/index.ts";

export const deliverables = new Map<string, Deliverable>(
  (
    [
      { code: "SET-FZ-LIC", name: "Free zone licence and registration", category: "Setup", model: "reseller", billing: "one_off", marketMid: aed(12_000), midBasis: "incl_govt", govFeeTable: null, requiredEvidence: [] },
      { code: "VISA-RES", name: "Residence visa, per person", category: "Visa", model: "reseller", billing: "one_off", marketMid: aed(4_000), midBasis: "service_only", govFeeTable: null, requiredEvidence: [] },
      { code: "BANK-ACC", name: "Corporate bank account opening", category: "Banking", model: "reseller", billing: "one_off", marketMid: aed(3_000), midBasis: "service_only", govFeeTable: null, requiredEvidence: [] },
      { code: "AUD-EXT", name: "External statutory audit, per year", category: "Audit", model: "agent", billing: "yearly", marketMid: aed(12_000), midBasis: "service_only", govFeeTable: null, requiredEvidence: [], requires: ["approved_auditor"] },
      { code: "TAX-AGENT", name: "FTA registered tax agency, per year", category: "Tax", model: "agent", billing: "yearly", marketMid: aed(6_000), midBasis: "service_only", govFeeTable: null, requiredEvidence: [], requires: ["fta_tax_agent"] },
    ] satisfies Deliverable[]
  ).map((d) => [d.code, d]),
);

export const rules = new Map<string, MarginRule>([
  ["Setup", { category: "Setup", rateBp: 2_000, floor: aed(500) }],
  ["Visa", { category: "Visa", rateBp: 2_000, floor: aed(400) }],
  ["Banking", { category: "Banking", rateBp: 2_000, floor: aed(400) }],
  ["Audit", { category: "Audit", rateBp: 1_000, floor: aed(500) }],
  ["Tax", { category: "Tax", rateBp: 2_500, floor: aed(300) }],
]);

export function partner(id: string, over: Partial<PartnerProfile> = {}): PartnerProfile {
  return {
    id,
    name: `Partner ${id}`,
    status: "signed",
    quality: 75,
    changeOrderRate: 0,
    capacityLeft: 10,
    liveJobs: 0,
    deliveredOnTime: 10,
    licenceActive: true,
    agreementSigned: true,
    emirates: ["Dubai"],
    codes: ["SET-FZ-LIC", "VISA-RES", "BANK-ACC"],
    ftaTaxAgent: false,
    approvedAuditorZones: [],
    registeredLiquidator: false,
    conflicts: [],
    ...over,
  };
}

/** The same example rate cards as the Google Sheet's Rate Cards tab. */
export const sheetCards: CostQuote[] = [
  { id: "RC-EX1", partnerId: "P1", code: "SET-FZ-LIC", professionalFee: aed(3_500), govFeeStated: aed(9_500), thirdPartyCost: 0, workingDays: 7, exclusions: [], gapCost: 0, source: "rate_card" },
  { id: "RC-EX2", partnerId: "P2", code: "SET-FZ-LIC", professionalFee: aed(2_800), govFeeStated: aed(9_000), thirdPartyCost: 0, workingDays: 10, exclusions: ["Establishment card"], gapCost: aed(1_000), source: "rate_card" },
  { id: "RC-EX3", partnerId: "P1", code: "VISA-RES", professionalFee: aed(1_800), govFeeStated: aed(3_500), thirdPartyCost: 0, workingDays: 10, exclusions: [], gapCost: 0, source: "rate_card" },
  { id: "RC-EX4", partnerId: "P2", code: "BANK-ACC", professionalFee: aed(2_000), govFeeStated: 0, thirdPartyCost: 0, workingDays: 15, exclusions: [], gapCost: 0, source: "rate_card" },
];

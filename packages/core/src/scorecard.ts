/**
 * Partner scorecard, service guarantee and client document checklists (O6). Pure functions: the services
 * gather the inputs, these decide, the audit trail records both.
 */

export interface ScorecardInputs {
  /** Milestones approved by the client in the window. */
  milestonesDone: number;
  /** Of those, whose evidence the partner first submitted on or before the due date. */
  milestonesOnTime: number;
  /** Milestones submitted for MKW's check in the window. */
  qaSubmissions: number;
  /** Of those, passed first time. */
  qaFirstPass: number;
  /** Milestones the client disputed in the window. */
  disputes: number;
  /** Missed acceptance deadlines (lifetime, as the profile keeps them). */
  slaStrikes: number;
  /** Average client rating 1–5 in the window, or null when none. */
  rating: number | null;
  /** Engagements whose price changed after acceptance / engagements, last 90 days. */
  changeOrderRate: number;
}

export interface Scorecard {
  score: number;
  parts: { onTime: number; firstPass: number; disputes: number; strikes: number; rating: number };
  /** True when there was nothing to measure and the score is the neutral starting value. */
  provisional: boolean;
}

export const NEUTRAL_QUALITY = 60;

/**
 * Quality 0–100 = on-time 40 + first-pass QA 20 + disputes 15 + SLA strikes 15 + client rating 10.
 * A partner with no history keeps the neutral 60 so probation, not the score, limits it. Rates with no
 * observations score their full weight (nothing went wrong) except rating, which scores neutral.
 */
export function scorePartner(i: ScorecardInputs): Scorecard {
  const provisional = i.milestonesDone === 0 && i.qaSubmissions === 0 && i.slaStrikes === 0 && i.rating === null;
  if (provisional) return { score: NEUTRAL_QUALITY, parts: { onTime: 24, firstPass: 12, disputes: 9, strikes: 9, rating: 6 }, provisional: true };
  const onTime = i.milestonesDone === 0 ? 40 : Math.round((40 * i.milestonesOnTime) / i.milestonesDone);
  const firstPass = i.qaSubmissions === 0 ? 20 : Math.round((20 * i.qaFirstPass) / i.qaSubmissions);
  const disputes = i.milestonesDone === 0 ? 15 : Math.max(0, 15 - Math.round((15 * i.disputes) / i.milestonesDone));
  const strikes = Math.max(0, 15 - 5 * i.slaStrikes);
  const rating = i.rating === null ? 6 : Math.round((10 * (i.rating - 1)) / 4);
  const score = Math.max(0, Math.min(100, onTime + firstPass + disputes + strikes + rating));
  return { score, parts: { onTime, firstPass, disputes, strikes, rating }, provisional: false };
}

/** Working days late before the guarantee applies. */
export const GUARANTEE_DAYS = 5;
/** Owner decision (spec): 10% of the late step's fee. Basis points, kept in settings. */
export const DEFAULT_GUARANTEE_BP = 1000;

/**
 * The credit for a late step: a share (basis points) of the step's part of its line's professional fee.
 * The line's fee (client price excluding government fees and VAT, times quantity) is split equally across the
 * line's steps. Integer fils; rounds down so the client is never over-credited by rounding.
 */
export function guaranteeCredit(lineProfessionalFils: number, stepsInLine: number, guaranteeBp: number): number {
  if (lineProfessionalFils <= 0 || stepsInLine <= 0 || guaranteeBp <= 0) return 0;
  const stepFee = Math.floor(lineProfessionalFils / stepsInLine);
  return Math.floor((stepFee * guaranteeBp) / 10_000);
}

/** Who bears a delay. The partner bears it only when ops says so. */
export type DelayCause = "partner" | "client" | "government" | "mkw";

/** Documents the client supplies before a step can start, by service code. */
export const CLIENT_DOCUMENTS: Record<string, string[]> = {
  "SET-FZ-LIC": ["passport_copy", "photo", "entry_stamp_or_visa", "proof_of_address"],
  "SET-ML-LIC": ["passport_copy", "photo", "emirates_id", "tenancy_contract", "noc"],
  "VISA-RES": ["passport_copy", "photo", "entry_stamp_or_visa", "medical_fitness"],
  "VISA-FAM": ["passport_copy", "photo", "marriage_or_birth_certificate_attested", "tenancy_contract", "salary_certificate"],
  "VISA-GOLD": ["passport_copy", "photo", "proof_of_eligibility"],
  "BANK-ACC": ["passport_copy", "emirates_id", "trade_licence", "business_plan_or_profile"],
  "PRO-EID": ["passport_copy", "photo", "visa_copy"],
  "VAT-RET": ["sales_and_purchase_records"],
  "CT-RET": ["financial_statements"],
  "ACC-BOOK": ["bank_statements", "invoices_and_bills"],
};
const DEFAULT_CLIENT_DOCUMENTS = ["passport_copy"];

/** The checklist for a step: documents belong to the first step of each line, where the partner needs them. */
export function clientDocumentsFor(code: string, seq: number, firstSeqOfLine: number): string[] {
  if (seq !== firstSeqOfLine) return [];
  return CLIENT_DOCUMENTS[code] ?? DEFAULT_CLIENT_DOCUMENTS;
}

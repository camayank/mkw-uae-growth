/**
 * The rest of the Service Catalogue (O4): 62 codes added to the 20 starter codes in seed-data.ts, so all 83
 * services of the operating Sheet's "Service Catalogue" tab are quotable. Market mids are the Sheet's
 * mid-points (AED, Oct 2026, tentative). `row` is the Service Catalogue row the service came from; row 1
 * ("business setup, any jurisdiction") is covered by SET-FZ-LIC and SET-ML-LIC.
 *
 * Columns: code, name, category, model, billing, market mid (AED), mid basis, requires, required evidence, row.
 * Agent model is used where the licensed firm must be the provider (FTA tax agency, statutory and approved audits,
 * liquidation, regulatory licensing, litigation, notary). Everything here is a working estimate until a qualified
 * person verifies it; the catalogue screen says so.
 */
type Row = readonly [string, string, string, "reseller" | "agent", "one_off" | "monthly" | "yearly", number, "incl_govt" | "service_only", readonly string[], readonly string[], number];

export const CATALOGUE_EXTENSION: readonly Row[] = [
  // Company formation & licensing (Setup)
  ["SET-DIFC", "DIFC or ADGM company and CSP services", "Setup", "reseller", "one_off", 30_000, "incl_govt", [], ["certificate_of_incorporation", "commercial_licence"], 6],
  ["SET-BRANCH", "Branch or representative office of a foreign company", "Setup", "reseller", "one_off", 40_000, "service_only", [], ["initial_approval", "trade_licence"], 7],
  ["SET-FREELANCE", "Freelance licence or permit, per year", "Setup", "reseller", "yearly", 10_000, "incl_govt", [], ["freelance_permit"], 8],
  ["SET-RENEW", "Trade licence renewal and amendment", "Setup", "reseller", "yearly", 2_000, "service_only", [], ["renewed_licence"], 9],
  ["SET-HOLD", "Holding, SPV, foundation and corporate structuring", "Setup", "reseller", "one_off", 20_000, "service_only", [], ["structure_memo", "certificate_of_incorporation"], 10],
  ["ADV-ENTRY", "Market entry and feasibility study", "Advisory", "reseller", "one_off", 20_000, "service_only", [], ["feasibility_report"], 11],
  ["SET-LSA", "Local service agent or nominee arrangement, per year", "Setup", "reseller", "yearly", 12_000, "service_only", [], ["agent_agreement"], 12],
  ["SET-OFFICE", "Virtual office, flexi desk or business centre, per year", "Setup", "reseller", "yearly", 8_000, "service_only", [], ["tenancy_contract"], 14],
  // Government services & PRO
  ["PRO-TYPING", "Typing centre transaction", "PRO", "reseller", "one_off", 75, "service_only", [], ["submission_receipt"], 16],
  ["PRO-CLEAR", "Document clearing transaction", "PRO", "reseller", "one_off", 250, "service_only", [], ["submission_receipt"], 17],
  ["PRO-ATTEST", "Attestation and legalisation, per document", "PRO", "reseller", "one_off", 175, "service_only", [], ["attested_document"], 18],
  ["PRO-TRANS", "Legal translation, per page", "PRO", "reseller", "one_off", 100, "service_only", [], ["translated_document"], 19],
  ["PRO-EID", "Emirates ID, medical and labour card processing, per person", "PRO", "reseller", "one_off", 350, "service_only", [], ["emirates_id", "labour_card"], 20],
  ["PRO-GDRFA", "Amer or GDRFA immigration transaction", "PRO", "reseller", "one_off", 300, "service_only", [], ["submission_receipt"], 21],
  ["PRO-COURT", "Vehicle or court transaction", "PRO", "reseller", "one_off", 300, "service_only", [], ["submission_receipt"], 22],
  // Visas & residency
  ["VISA-RELOC", "Relocation support for a family", "Visa", "reseller", "one_off", 10_000, "service_only", [], ["relocation_report"], 26],
  ["VISA-CBI", "Second residency or citizenship by investment, agent fee", "Visa", "reseller", "one_off", 50_000, "service_only", [], ["application_receipt"], 27],
  // Accounting & finance
  ["ACC-IFRS", "Financial reporting pack (IFRS or management accounts)", "Accounting", "reseller", "one_off", 7_500, "service_only", [], ["financial_statements"], 33],
  ["ACC-MODEL", "Budgeting, forecasting and financial model", "Accounting", "reseller", "one_off", 10_000, "service_only", [], ["financial_model"], 34],
  ["ACC-VALUE", "Business valuation report", "Accounting", "reseller", "one_off", 20_000, "service_only", [], ["valuation_report"], 35],
  ["ACC-DD", "Due diligence and M&A support", "Accounting", "reseller", "one_off", 50_000, "service_only", [], ["due_diligence_report"], 36],
  ["ACC-ERP", "Accounting software or ERP implementation", "Accounting", "reseller", "one_off", 15_000, "service_only", [], ["go_live_signoff"], 37],
  ["ACC-RAISE", "Corporate finance and fundraising retainer", "Accounting", "reseller", "one_off", 20_000, "service_only", [], ["mandate_letter", "information_memorandum"], 38],
  ["ACC-FUND", "Fund accounting and administration, per year", "Accounting", "reseller", "yearly", 60_000, "service_only", [], ["nav_report"], 39],
  // Tax
  ["TAX-EXCISE", "Excise tax registration and returns, per year", "Tax", "reseller", "yearly", 3_000, "service_only", [], ["fta_trn_certificate"], 42],
  ["TAX-TP", "Transfer pricing documentation", "Tax", "reseller", "one_off", 12_000, "service_only", [], ["tp_report"], 43],
  ["TAX-TRC", "Tax residency certificate", "Tax", "reseller", "one_off", 1_750, "service_only", [], ["trc_certificate"], 44],
  ["TAX-DISPUTE", "Tax dispute, reconsideration or penalty waiver, per case", "Tax", "reseller", "one_off", 6_000, "service_only", [], ["fta_decision"], 45],
  ["TAX-INTL", "International and cross-border tax structuring", "Tax", "reseller", "one_off", 20_000, "service_only", [], ["structuring_memo"], 46],
  ["TAX-EINV", "E-invoicing readiness", "Tax", "reseller", "one_off", 8_000, "service_only", [], ["readiness_report"], 47],
  ["TAX-REP", "Tax agent representation before the FTA, per matter", "Tax", "agent", "one_off", 2_500, "service_only", ["fta_tax_agent"], ["fta_correspondence"], 48],
  ["TAX-AGENT-CT", "FTA registered tax agency (corporate tax), per year", "Tax", "agent", "yearly", 7_500, "service_only", ["fta_tax_agent"], ["fta_agent_link"], 50],
  ["TAX-MUWAFAQ", "FTA tax agency for SMEs (Muwafaq), per year", "Tax", "agent", "yearly", 2_000, "service_only", ["fta_tax_agent"], ["fta_agent_link"], 51],
  // Audit & assurance
  ["AUD-INT", "Internal audit, per year", "Audit", "reseller", "yearly", 40_000, "service_only", [], ["internal_audit_report"], 53],
  ["AUD-FZ", "Free zone approved auditor, per year", "Audit", "agent", "yearly", 8_000, "service_only", ["approved_auditor"], ["audit_report"], 54],
  ["AUD-RERA", "RERA and owners association audit, per building", "Audit", "agent", "yearly", 10_000, "service_only", ["approved_auditor"], ["audit_report"], 55],
  ["AUD-FORENSIC", "Forensic accounting and court expert, per case", "Audit", "reseller", "one_off", 30_000, "service_only", [], ["expert_report"], 56],
  ["AUD-ICV", "ICV certification, per certificate", "Audit", "reseller", "yearly", 10_000, "service_only", [], ["icv_certificate"], 57],
  ["AUD-ISO", "ISO certification, per standard", "Audit", "reseller", "one_off", 12_000, "service_only", [], ["iso_certificate"], 58],
  // Compliance & regulation
  ["CMP-KYC", "KYC and onboarding, per month", "Compliance", "reseller", "monthly", 1_500, "service_only", [], ["monthly_log"], 60],
  ["CMP-REGLIC", "Regulatory licensing (DFSA, FSRA, VARA)", "Compliance", "agent", "one_off", 100_000, "service_only", [], ["regulator_approval"], 61],
  ["CMP-GOV", "Corporate governance and risk advisory", "Compliance", "reseller", "one_off", 30_000, "service_only", [], ["governance_report"], 62],
  // Legal & IP
  ["LEG-CORP", "Corporate and commercial legal matter", "Legal & IP", "reseller", "one_off", 7_500, "service_only", [], ["signed_agreement"], 63],
  ["LEG-LIT", "Litigation, arbitration or debt recovery, per case", "Legal & IP", "agent", "one_off", 50_000, "service_only", [], ["court_filing"], 64],
  ["LEG-WILL", "Will and estate planning, per will", "Legal & IP", "reseller", "one_off", 8_000, "incl_govt", [], ["registered_will"], 65],
  ["LEG-IP", "Patents, IP and franchising", "Legal & IP", "reseller", "one_off", 25_000, "service_only", [], ["ip_filing"], 67],
  ["LEG-ESOP", "Cap table and ESOP management, per year", "Legal & IP", "reseller", "yearly", 15_000, "service_only", [], ["cap_table"], 68],
  ["LEG-NOTARY", "Notary service, per document", "Legal & IP", "agent", "one_off", 500, "incl_govt", [], ["notarised_document"], 69],
  // Private client & wealth
  ["PC-CLIENT", "Private client services, per year", "Private Client", "reseller", "yearly", 25_000, "service_only", [], ["engagement_letter"], 70],
  ["PC-FAMILY", "Family office services, per year", "Private Client", "reseller", "yearly", 100_000, "service_only", [], ["engagement_letter"], 71],
  ["PC-TRUST", "Trust, fiduciary and corporate administration, per year", "Private Client", "reseller", "yearly", 20_000, "service_only", [], ["trust_deed"], 72],
  ["PC-WEALTH", "Wealth and asset structuring, per structure", "Private Client", "reseller", "one_off", 50_000, "service_only", [], ["structuring_memo"], 73],
  // HR & people
  ["HR-OUT", "HR outsourcing and advisory, per month", "HR", "reseller", "monthly", 3_000, "service_only", [], ["monthly_log"], 74],
  ["HR-EOR", "Employer of record (PEO), per employee per month", "HR", "reseller", "monthly", 2_500, "service_only", [], ["payslip"], 75],
  ["HR-RECRUIT", "Recruitment, per hire", "HR", "reseller", "one_off", 15_000, "service_only", [], ["offer_letter"], 76],
  ["HR-INSURE", "Health and business insurance, per year", "HR", "reseller", "yearly", 3_000, "service_only", [], ["policy_schedule"], 77],
  // Business advisory
  ["ADV-STRAT", "Management and strategy consulting, per project", "Advisory", "reseller", "one_off", 30_000, "service_only", [], ["final_report"], 78],
  // Growth & technology
  ["GRW-MKT", "Marketing and digital marketing retainer, per month", "Growth", "reseller", "monthly", 4_000, "service_only", [], ["monthly_report"], 79],
  ["GRW-WEB", "Website or app development, per project", "Growth", "reseller", "one_off", 15_000, "service_only", [], ["go_live_signoff"], 80],
  ["GRW-IT", "IT and technology solution, per project", "Growth", "reseller", "one_off", 25_000, "service_only", [], ["go_live_signoff"], 81],
  // Other
  ["OTH-CUSTOMS", "Customs and import-export registration", "Other", "reseller", "one_off", 2_500, "incl_govt", [], ["customs_code"], 82],
  ["OTH-PROPERTY", "Real estate and property services", "Other", "reseller", "one_off", 10_000, "service_only", [], ["tenancy_contract"], 83],
] as const;

/** Default margin rules for the five categories the Sheet does not price yet. Marked for the owner to confirm. */
export const EXTENSION_MARGIN_RULES: Array<[string, number, number]> = [
  ["Private Client", 2_000, 50_000],
  ["HR", 2_000, 30_000],
  ["Advisory", 2_000, 50_000],
  ["Growth", 2_000, 50_000],
  ["Other", 2_000, 30_000],
];

/** Service Catalogue rows covered by the starter codes, for the row → code map on the catalogue screen. */
export const STARTER_ROWS: Record<string, number[]> = {
  "SET-FZ-LIC": [1, 4], "SET-ML-LIC": [3], "SET-OFF": [5], "ESR-UBO": [2], "LIQ-CO": [13], "PRO-RET": [15],
  "VISA-RES": [23], "VISA-FAM": [24], "VISA-GOLD": [25], "BANK-ACC": [28], "ACC-BOOK": [29], "ACC-FULL": [30],
  "PAY-WPS": [31], "CFO-FRAC": [32], "VAT-RET": [40], "CT-RET": [41], "TAX-AGENT": [49], "AUD-EXT": [52],
  "AML-GOAML": [59], "TM-REG": [66],
};

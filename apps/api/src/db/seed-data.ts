import { aed } from "@tasees/core";

/**
 * Catalogue and margin rules, matching the Deliverable Codes tab of the Google Sheet.
 * Market mids come from the Service Catalogue tab (mid-points of tentative ranges, Oct 2026).
 */
export const DELIVERABLES = [
  ["SET-FZ-LIC", "Free zone licence and registration", "Setup", "reseller", "one_off", 12_000, "incl_govt", [], ["initial_approval", "trade_licence"]],
  ["SET-ML-LIC", "Mainland licence and registration", "Setup", "reseller", "one_off", 22_000, "incl_govt", [], ["initial_approval", "trade_licence"]],
  ["SET-OFF", "Offshore company registration", "Setup", "reseller", "one_off", 12_000, "incl_govt", [], ["certificate_of_incorporation"]],
  ["VISA-RES", "Residence visa, per person", "Visa", "reseller", "one_off", 4_000, "service_only", [], ["entry_permit", "residence_visa"]],
  ["VISA-FAM", "Family visa, per dependant", "Visa", "reseller", "one_off", 2_500, "service_only", [], ["residence_visa"]],
  ["VISA-GOLD", "Golden visa application", "Visa", "reseller", "one_off", 8_000, "service_only", [], ["icp_approval"]],
  ["BANK-ACC", "Corporate bank account opening", "Banking", "reseller", "one_off", 3_000, "service_only", [], ["account_letter"]],
  ["PRO-RET", "PRO retainer, per month", "PRO", "reseller", "monthly", 2_500, "service_only", [], ["monthly_log"]],
  ["ACC-BOOK", "Bookkeeping, per month", "Accounting", "reseller", "monthly", 800, "service_only", [], ["monthly_accounts"]],
  ["ACC-FULL", "Outsourced accounting, per month", "Accounting", "reseller", "monthly", 1_200, "service_only", [], ["monthly_accounts"]],
  ["PAY-WPS", "Payroll and WPS, per month", "Accounting", "reseller", "monthly", 750, "service_only", [], ["wps_file"]],
  ["CFO-FRAC", "Fractional CFO, per month", "Accounting", "reseller", "monthly", 7_000, "service_only", [], ["monthly_report"]],
  ["VAT-RET", "VAT registration and returns, per year", "Tax", "reseller", "yearly", 3_000, "service_only", [], ["fta_trn_certificate"]],
  ["CT-RET", "Corporate tax registration and return, per year", "Tax", "reseller", "yearly", 2_500, "service_only", [], ["fta_trn_certificate"]],
  ["TAX-AGENT", "FTA registered tax agency, per year", "Tax", "agent", "yearly", 6_000, "service_only", ["fta_tax_agent"], ["fta_agent_link"]],
  ["AUD-EXT", "External statutory audit, per year", "Audit", "agent", "yearly", 12_000, "service_only", ["approved_auditor"], ["audit_report"]],
  ["LIQ-CO", "Company liquidation and deregistration", "Setup", "agent", "one_off", 15_000, "incl_govt", ["registered_liquidator"], ["deregistration_letter"]],
  ["AML-GOAML", "AML programme and goAML registration, per year", "Compliance", "reseller", "yearly", 8_000, "service_only", [], ["goaml_registration"]],
  ["TM-REG", "Trademark registration, one class", "Legal & IP", "reseller", "one_off", 8_000, "incl_govt", [], ["trademark_filing"]],
  ["ESR-UBO", "Company secretarial and registers, per year", "Setup", "reseller", "yearly", 6_000, "service_only", [], ["registers"]],
] as const;

export const MARGIN_RULES: Array<[string, number, number]> = [
  ["Setup", 2_000, aed(500)],
  ["Visa", 2_000, aed(400)],
  ["Banking", 2_000, aed(400)],
  ["PRO", 2_000, aed(300)],
  ["Accounting", 2_500, aed(150)],
  ["Tax", 2_500, aed(300)],
  ["Audit", 1_000, aed(500)],
  ["Compliance", 2_000, aed(500)],
  ["Legal & IP", 2_000, aed(500)],
];

/** Demo parties for local use. Firm names are invented, not real companies. */
export const DEMO = {
  platform: { name: "MKW Advisors", users: [
    ["founder@mkwadvisors.test", "MKW Founder", "founder"],
    ["ops@mkwadvisors.test", "Ops Manager", "ops"],
    ["finance@mkwadvisors.test", "Finance", "finance"],
  ] },
  partners: [
    {
      name: "Example Setup Partners FZ-LLC",
      email: "admin@setup-partner.test",
      staff: "staff@setup-partner.test",
      profile: { status: "signed", quality: 82, capacity: 12, deliveredOnTime: 12, licenceActive: true, agreementSigned: true, emirates: ["Dubai", "Sharjah"], codes: ["SET-FZ-LIC", "SET-ML-LIC", "VISA-RES", "VISA-FAM", "BANK-ACC", "PRO-RET"], ftaTaxAgent: false, approvedAuditorZones: [] },
      cards: [["SET-FZ-LIC", 3_500, 9_500, 7], ["SET-ML-LIC", 6_500, 14_000, 15], ["VISA-RES", 1_800, 3_500, 10], ["VISA-FAM", 1_500, 3_200, 10], ["BANK-ACC", 2_200, 0, 15], ["PRO-RET", 1_800, 0, 1]],
    },
    {
      name: "Example Corporate Services LLC",
      email: "admin@corporate-services.test",
      staff: "staff@corporate-services.test",
      profile: { status: "pilot", quality: 74, capacity: 6, deliveredOnTime: 2, licenceActive: true, agreementSigned: true, emirates: ["Dubai", "Abu Dhabi"], codes: ["SET-FZ-LIC", "VISA-RES", "BANK-ACC"], ftaTaxAgent: false, approvedAuditorZones: [] },
      cards: [["SET-FZ-LIC", 2_800, 9_000, 10], ["VISA-RES", 1_600, 3_500, 12], ["BANK-ACC", 2_000, 0, 15]],
    },
    {
      name: "Example Tax & Accounts LLC",
      email: "admin@tax-accounts.test",
      staff: "staff@tax-accounts.test",
      profile: { status: "signed", quality: 88, capacity: 20, deliveredOnTime: 30, licenceActive: true, agreementSigned: true, emirates: ["All"], codes: ["ACC-BOOK", "ACC-FULL", "PAY-WPS", "VAT-RET", "CT-RET", "TAX-AGENT", "AUD-EXT"], ftaTaxAgent: true, approvedAuditorZones: ["mainland", "IFZA", "DMCC", "RAKEZ"] },
      cards: [["ACC-BOOK", 650, 0, 5], ["ACC-FULL", 1_000, 0, 5], ["PAY-WPS", 600, 0, 3], ["VAT-RET", 2_200, 0, 10], ["CT-RET", 1_800, 0, 10], ["TAX-AGENT", 4_500, 0, 5], ["AUD-EXT", 8_000, 0, 20]],
    },
  ],
  client: { name: "Sample Trading FZ-LLC", email: "founder@sample-client.test", ownerName: "Sample Founder", member: "accounts@sample-client.test" },
} as const;

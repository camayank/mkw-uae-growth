/**
 * Working scoping rules and zone data (O5). Every row starts UNCERTAIN: a qualified person verifies each on the
 * Scoping page before the advice built on it is shown to a client as anything firmer than a rule of thumb.
 * Statements are plain English; thresholds come from the specification (VAT AED 375,000 / 187,500).
 */
export const SCOPING_RULES: Array<[string, "structure" | "zone" | "licence" | "obligation", string, Record<string, unknown>, string]> = [
  ["structure.free_zone_default", "structure", "A free zone licence suits services, technology and online businesses that sell outside the UAE mainland or internationally: 100% ownership, fast setup, low entry cost.", {}, ""],
  ["structure.requested_differs", "structure", "When the founder asks for one structure and the answers point to another, ops confirms which fits before pricing.", {}, ""],
  ["structure.free_zone_mainland_sales", "structure", "A free zone company selling into the mainland normally needs a distributor or a dual licence arrangement.", {}, ""],
  ["structure.mainland_onshore", "structure", "Selling to mainland customers, or needing a shop, warehouse or site, points to a mainland (DED/DET) licence.", {}, ""],
  ["structure.mainland_tenders", "structure", "A mainland licence can bid for government work and trade anywhere onshore.", {}, ""],
  ["structure.holding", "structure", "Holding vehicles fit offshore companies (RAK ICC, JAFZA offshore) or, with a larger budget and a need for a common-law registry, DIFC or ADGM.", { difcBudgetAed: 30000 }, ""],
  ["structure.offshore_no_visas", "structure", "Offshore companies cannot sponsor residence visas.", {}, ""],
  ["structure.financial_regulated", "structure", "Regulated financial activities need a licence from DFSA (DIFC), FSRA (ADGM) or the SCA.", {}, ""],
  ["licence.financial", "licence", "Financial activities need regulator approval before the licence issues.", {}, ""],
  ["licence.health", "licence", "Health activities need DHA, DoH or MOHAP approval in addition to the trade licence.", {}, ""],
  ["licence.education", "licence", "Education and training activities need KHDA or ADEK approval.", {}, ""],
  ["licence.food", "licence", "Food businesses need municipality food-safety approval and premises inspection.", {}, ""],
  ["licence.ecommerce", "licence", "E-commerce is a licensed activity; payment gateways need the licence and a corporate bank account.", {}, ""],
  ["obligation.corporate_tax", "obligation", "Register for UAE corporate tax after incorporation; 0% up to the threshold, 9% above, small business relief possible.", { ratePct: 9, thresholdAed: 375000 }, ""],
  ["obligation.vat_mandatory", "obligation", "VAT registration is mandatory above AED 375,000 of taxable supplies a year.", { thresholdAed: 375000 }, ""],
  ["obligation.vat_voluntary", "obligation", "VAT registration is voluntary from AED 187,500 of taxable supplies a year.", { thresholdAed: 187500 }, ""],
  ["obligation.vat_watch", "obligation", "Watch the VAT thresholds (AED 375,000 mandatory, AED 187,500 voluntary).", { mandatoryAed: 375000, voluntaryAed: 187500 }, ""],
  ["obligation.ubo", "obligation", "Keep an ultimate beneficial owner register and file it with the registrar.", {}, ""],
  ["obligation.goaml_dnfbp", "obligation", "Designated non-financial businesses must register on goAML and run an AML programme.", {}, ""],
  ["obligation.wps", "obligation", "Employees must be paid through the Wage Protection System; medical insurance is mandatory.", {}, ""],
];

/** Well-known places; costs are tentative ranges in AED including government fees (Oct 2026), all UNCERTAIN. */
export const ZONES: Array<[string, string, "free_zone" | "mainland" | "offshore" | "financial", number, number, number, number, string[]]> = [
  ["IFZA", "Dubai", "free_zone", 1, 12_000, 20_000, 7, ["consulting", "tech", "ecommerce", "trading"]],
  ["Meydan Free Zone", "Dubai", "free_zone", 1, 12_500, 20_000, 7, ["consulting", "tech", "ecommerce"]],
  ["DMCC", "Dubai", "free_zone", 1, 22_000, 35_000, 14, ["trading", "finance", "consulting"]],
  ["Dubai Silicon Oasis", "Dubai", "free_zone", 1, 15_000, 25_000, 10, ["tech"]],
  ["SHAMS", "Sharjah", "free_zone", 1, 6_000, 12_000, 5, ["consulting", "tech", "ecommerce"]],
  ["RAKEZ", "Ras Al Khaimah", "free_zone", 1, 7_000, 15_000, 7, ["trading", "consulting", "construction"]],
  ["Ajman Free Zone", "Ajman", "free_zone", 1, 6_000, 12_000, 5, ["trading", "ecommerce"]],
  ["Dubai DET mainland", "Dubai", "mainland", 2, 15_000, 35_000, 15, ["trading", "food", "construction", "consulting"]],
  ["Abu Dhabi DED mainland", "Abu Dhabi", "mainland", 2, 12_000, 30_000, 15, ["trading", "food", "construction", "consulting"]],
  ["Sharjah SEDD mainland", "Sharjah", "mainland", 2, 10_000, 25_000, 15, ["trading", "food", "construction"]],
  ["RAK ICC", "Ras Al Khaimah", "offshore", 0, 8_000, 15_000, 7, ["holding"]],
  ["JAFZA Offshore", "Dubai", "offshore", 0, 10_000, 20_000, 10, ["holding"]],
  ["DIFC", "Dubai", "financial", 2, 30_000, 60_000, 30, ["finance", "holding"]],
  ["ADGM", "Abu Dhabi", "financial", 2, 25_000, 50_000, 30, ["finance", "holding", "tech"]],
];

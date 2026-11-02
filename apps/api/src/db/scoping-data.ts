/**
 * Working scoping rules and zone data (O5). Every row starts UNCERTAIN: a qualified person verifies each on the
 * Scoping page before the advice built on it is shown to a client as anything firmer than a rule of thumb.
 * Statements are plain English; thresholds come from the specification (VAT AED 375,000 / 187,500).
 */
export const SCOPING_RULES: Array<[string, "structure" | "zone" | "licence" | "obligation" | "crossborder", string, Record<string, unknown>, string]> = [
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
  ["obligation.wps", "obligation", "Mainland employees must be paid through the Wage Protection System (MOHRE); medical insurance is mandatory.", {}, ""],
  ["obligation.payroll_zone", "obligation", "Free zone and DIFC/ADGM employees need medical insurance; salary payment and reporting follow the zone's own employment rules.", {}, ""],
  // E1: eligibility before recommendation. Exclusions, conditions and checks the engine applies; UNCERTAIN until verified.
  ["structure.offshore_no_premises", "structure", "An offshore company cannot lease premises or operate a place of business in the UAE.", {}, ""],
  ["structure.offshore_no_onshore_trade", "structure", "An offshore company cannot trade with customers in the UAE.", {}, ""],
  ["structure.offshore_activity", "structure", "Offshore companies suit holding and some international activities; each activity is confirmed with the registry.", {}, ""],
  ["structure.virtual_assets_regulated", "structure", "Virtual-asset activities need VARA (Dubai outside DIFC), FSRA (ADGM), DFSA (DIFC) or SCA authorisation.", {}, ""],
  ["structure.free_zone_onshore_premises", "structure", "Premises outside a free zone need a mainland licence or branch.", {}, ""],
  ["structure.industrial_licence", "structure", "Manufacturing needs an industrial licence and an industrial plot or unit with confirmed utilities.", {}, ""],
  ["structure.holding_free_zone", "structure", "Some free zones license holding companies; which, and on what terms, is confirmed per zone.", {}, ""],
  ["structure.mainland_holding", "structure", "Mainland companies can hold shares; a pure holding vehicle is more often offshore, in a free zone or in DIFC/ADGM.", {}, ""],
  ["structure.mainland_foreign_ownership", "structure", "Full foreign ownership is allowed for most mainland activities; strategic activities may need approvals or a UAE national shareholder.", {}, ""],
  ["structure.financial_zone_non_financial", "structure", "DIFC and ADGM license some non-financial businesses; each activity is confirmed.", {}, ""],
  ["structure.preferred_excluded", "structure", "When the structure the answers point to is excluded by a rule, the closest structure that remains is shown with the reason.", {}, ""],
  ["structure.no_viable_place", "structure", "When no place of the structure the answers point to fits every answer (budget, visas, facilities), the closest structure with a place that does is shown with the reason.", {}, ""],
  ["structure.no_viable_option", "structure", "When no structure or place survives the checks, no recommendation is made and a specialist assesses the case.", {}, ""],
  ["place.visa_capacity", "zone", "A place's maximum visa allocation, where known, is a hard limit.", {}, ""],
  ["place.visa_package", "zone", "Visas beyond the standard package need a larger package or more office space, at extra cost.", {}, ""],
  ["place.cost_estimate", "zone", "Setup cost estimates are held per place with their source and confidence.", {}, ""],
  ["place.budget", "zone", "A place whose lowest estimated setup cost is above the founder's budget is not recommended.", {}, ""],
  ["place.activity_listed", "zone", "Whether a place licenses an exact activity is confirmed against its own activity list, never assumed from a sector tag.", {}, ""],
  ["place.industrial_facilities", "zone", "Manufacturing needs industrial land or units with utilities at the place.", {}, ""],
  ["place.warehouse_facilities", "zone", "Storage needs warehousing at the place.", {}, ""],
  ["obligation.ct_qfzp", "obligation", "0% corporate tax for a free zone company applies only to qualifying income of a Qualifying Free Zone Person meeting the substance, qualifying activity, de minimis and audit conditions.", {}, ""],
  ["obligation.ct_small_business_relief", "obligation", "Small business relief (revenue up to AED 3 million) applies only to tax periods ending on or before 31 December 2026.", { revenueAed: 3000000, lastPeriodEnd: "2026-12-31" }, ""],
  ["obligation.vat_basis", "obligation", "The VAT registration test is taxable supplies and imports, not turnover.", {}, ""],
  ["obligation.vat_designated_zone", "obligation", "Some free zones are VAT designated zones for certain goods movements; services are not covered.", {}, ""],
  ["crossborder.founder_residence", "crossborder", "An owner tax resident abroad may be taxed there on the company's profits; management and control can decide tax residence.", {}, ""],
  ["crossborder.permanent_establishment", "crossborder", "Serving or working from abroad can create a permanent establishment in another country.", {}, ""],
  ["crossborder.corporate_shareholder", "crossborder", "A corporate owner brings transfer pricing, parent-country rules on foreign subsidiaries and document attestation.", {}, ""],
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

/**
 * E2 authorities: who licenses or registers each place, by name only. Parents, registrars and websites are recorded
 * as facts with a source (the Scoping page or the catalogue importer), never assumed here. Regulators are listed so
 * findings can name them; they license activities, not places.
 * Columns: id, name, kind, emirate (null: federal), aliases.
 */
export const AUTHORITIES: Array<[string, string, "free_zone_authority" | "mainland_department" | "offshore_registry" | "financial_centre" | "regulator", string | null, string[]]> = [
  ["ifza", "International Free Zone Authority", "free_zone_authority", "Dubai", ["IFZA"]],
  ["meydan_fz", "Meydan Free Zone", "free_zone_authority", "Dubai", ["Meydan FZ", "Meydan"]],
  ["dmcc", "Dubai Multi Commodities Centre", "free_zone_authority", "Dubai", ["DMCC"]],
  ["dso", "Dubai Silicon Oasis", "free_zone_authority", "Dubai", ["DSO", "Dubai Silicon Oasis Authority", "DSOA"]],
  ["shams", "Sharjah Media City", "free_zone_authority", "Sharjah", ["SHAMS", "Sharjah Media City Free Zone"]],
  ["rakez", "Ras Al Khaimah Economic Zone", "free_zone_authority", "Ras Al Khaimah", ["RAKEZ"]],
  ["ajman_fz", "Ajman Free Zone", "free_zone_authority", "Ajman", ["AFZ", "Ajman Free Zone Authority"]],
  // The offshore registry only: "JAFZA" alone means the free zone, whose own licence is not a place here yet.
  ["jafza_offshore", "JAFZA Offshore Companies Registry", "offshore_registry", "Dubai", ["JAFZA Offshore"]],
  ["uaq_ftz", "Umm Al Quwain Free Trade Zone", "free_zone_authority", "Umm Al Quwain", ["UAQ FTZ", "UAQ Free Trade Zone"]],
  ["fujairah_fz", "Fujairah Free Zone", "free_zone_authority", "Fujairah", ["FFZ", "Fujairah Free Zone Authority"]],
  ["fujairah_cc", "Fujairah Creative City", "free_zone_authority", "Fujairah", ["Creative City", "FCC"]],
  ["dubai_det", "Dubai Department of Economy and Tourism", "mainland_department", "Dubai", ["DET", "Dubai DED", "Dubai Economy", "Dubai mainland"]],
  ["ad_ded", "Abu Dhabi Department of Economic Development", "mainland_department", "Abu Dhabi", ["ADDED", "Abu Dhabi DED", "Abu Dhabi mainland"]],
  ["sharjah_sedd", "Sharjah Economic Development Department", "mainland_department", "Sharjah", ["SEDD", "Sharjah DED", "Sharjah mainland"]],
  ["rak_icc", "RAK International Corporate Centre", "offshore_registry", "Ras Al Khaimah", ["RAK ICC", "RAKICC"]],
  ["difc", "Dubai International Financial Centre", "financial_centre", "Dubai", ["DIFC"]],
  ["adgm", "Abu Dhabi Global Market", "financial_centre", "Abu Dhabi", ["ADGM"]],
  ["dfsa", "Dubai Financial Services Authority", "regulator", "Dubai", ["DFSA"]],
  ["fsra", "Financial Services Regulatory Authority", "regulator", "Abu Dhabi", ["FSRA"]],
  ["vara", "Virtual Assets Regulatory Authority", "regulator", "Dubai", ["VARA"]],
  ["sca", "Securities and Commodities Authority", "regulator", null, ["SCA"]],
  ["cbuae", "Central Bank of the UAE", "regulator", null, ["CBUAE", "UAE Central Bank"]],
];

/** Which authority each place belongs to: the place is the authority's own licence or registry (no inference). */
export const PLACE_AUTHORITY: Record<string, string> = {
  IFZA: "ifza",
  "Meydan Free Zone": "meydan_fz",
  DMCC: "dmcc",
  "Dubai Silicon Oasis": "dso",
  SHAMS: "shams",
  RAKEZ: "rakez",
  "Ajman Free Zone": "ajman_fz",
  "Dubai DET mainland": "dubai_det",
  "Abu Dhabi DED mainland": "ad_ded",
  "Sharjah SEDD mainland": "sharjah_sedd",
  "RAK ICC": "rak_icc",
  "JAFZA Offshore": "jafza_offshore",
  DIFC: "difc",
  ADGM: "adgm",
  "UAQ Free Trade Zone": "uaq_ftz",
  "Fujairah Free Zone": "fujairah_fz",
  "Fujairah Creative City": "fujairah_cc",
};

/**
 * Places in Umm Al Quwain and Fujairah, added with no figures: they stay inactive (never offered) until their cost,
 * visas and timeline are recorded as facts and the founder activates them. No number here is a market figure.
 */
export const PENDING_PLACES: Array<[string, string]> = [
  ["UAQ Free Trade Zone", "Umm Al Quwain"],
  ["Fujairah Free Zone", "Fujairah"],
  ["Fujairah Creative City", "Fujairah"],
];

import { describe, expect, it } from "vitest";
import { advise, assess, assessStructure, isViable, Rulebook, statusOf, weaker, type AdviceInput, type ScopingRule, type Zone } from "../src/index.ts";

/**
 * E1: eligibility before recommendation, against the scenarios in the owner's engineering contract (section 11).
 * Rules and places are fixtures here; every one is UNCERTAIN unless a test verifies it, as in the database today.
 */

const KEYS = [
  "structure.free_zone_default", "structure.requested_differs", "structure.free_zone_mainland_sales", "structure.mainland_onshore", "structure.mainland_tenders",
  "structure.holding", "structure.offshore_no_visas", "structure.financial_regulated", "structure.offshore_no_premises", "structure.offshore_no_onshore_trade",
  "structure.offshore_activity", "structure.virtual_assets_regulated", "structure.free_zone_onshore_premises", "structure.industrial_licence",
  "structure.holding_free_zone", "structure.mainland_holding", "structure.mainland_foreign_ownership", "structure.financial_zone_non_financial", "structure.preferred_excluded",
  "structure.no_viable_option", "structure.no_viable_place", "place.visa_capacity", "place.visa_package", "place.cost_estimate", "place.budget", "place.activity_listed",
  "place.industrial_facilities", "place.warehouse_facilities", "licence.financial", "licence.health", "licence.education", "licence.food", "licence.ecommerce",
  "obligation.corporate_tax", "obligation.ct_qfzp", "obligation.ct_small_business_relief", "obligation.vat_mandatory", "obligation.vat_voluntary",
  "obligation.vat_watch", "obligation.vat_basis", "obligation.vat_designated_zone", "obligation.ubo", "obligation.goaml_dnfbp", "obligation.wps", "obligation.payroll_zone",
  "crossborder.founder_residence", "crossborder.permanent_establishment", "crossborder.corporate_shareholder",
];
const rules: ScopingRule[] = KEYS.map((key) => ({ key, kind: "structure", statement: key, parameters: {}, sourceUrl: "", confidence: "UNCERTAIN" }));
const verifiedRules: ScopingRule[] = rules.map((r) => ({ ...r, confidence: "verified", verifiedBy: "A. Qualified", verifiedAt: "2026-11-01" }));

const z = (name: string, emirate: string, type: Zone["type"], visaQuota: number, min: number, max: number, activities: string[], extra: Partial<Zone> = {}): Zone => ({
  name, emirate, type, visaQuota, costMinFils: min * 100, costMaxFils: max * 100, timelineDays: 10, activities, sourceUrl: "", confidence: "UNCERTAIN", ...extra,
});
const zones: Zone[] = [
  z("IFZA", "Dubai", "free_zone", 1, 12_000, 20_000, ["consulting", "tech", "ecommerce", "trading"], { facilities: ["office"] }),
  z("DMCC", "Dubai", "free_zone", 1, 22_000, 35_000, ["trading", "finance"], { facilities: ["office", "warehouse"] }),
  z("KEZAD", "Abu Dhabi", "free_zone", 3, 18_000, 40_000, ["manufacturing", "trading"], { facilities: ["office", "warehouse", "industrial"] }),
  z("SHAMS", "Sharjah", "free_zone", 1, 6_000, 12_000, ["consulting", "tech"], { visaMax: 3 }),
  z("Dubai DET mainland", "Dubai", "mainland", 2, 15_000, 35_000, ["trading", "food", "health"]),
  z("Abu Dhabi DED mainland", "Abu Dhabi", "mainland", 2, 12_000, 30_000, ["trading", "manufacturing"]),
  z("RAK ICC", "Ras Al Khaimah", "offshore", 0, 8_000, 15_000, ["holding"], { visaMax: 0 }),
  z("DIFC", "Dubai", "financial", 2, 30_000, 60_000, ["finance", "holding"]),
  z("ADGM", "Abu Dhabi", "financial", 2, 25_000, 50_000, ["finance", "holding", "virtual_assets"]),
];

const base = (x: Partial<AdviceInput>): AdviceInput => ({ mode: "new_company", emirate: "Dubai", ...x });
const keysOf = (a: ReturnType<typeof advise>) => [...a.structure.reasons, ...a.licences, ...a.obligations, ...(a.crossBorder ?? [])].map((r) => r.ruleKey);
const structureStatus = (a: ReturnType<typeof advise>, s: string) => a.structures!.find((x) => x.structure === s)!.status;

describe("statuses", () => {
  it("an exclusion wins, then missing data, then anything unconfirmed, then conditions", () => {
    const f = (outcome: any, confidence: any = "verified", missing?: any) => ({ ruleKey: "k", outcome, text: "", confidence, missing });
    expect(statusOf([f("pass"), f("fail")])).toBe("INELIGIBLE");
    expect(statusOf([f("pass"), f("unknown", "verified", "data")])).toBe("DATA_UNAVAILABLE");
    expect(statusOf([f("pass"), f("unknown", "verified", "check")])).toBe("REQUIRES_VERIFICATION");
    expect(statusOf([f("pass", "UNCERTAIN")])).toBe("REQUIRES_VERIFICATION");
    expect(statusOf([f("pass"), f("condition")])).toBe("ELIGIBLE_CONDITIONAL");
    expect(statusOf([f("pass")])).toBe("ELIGIBLE_VERIFIED");
  });
});

describe("the contract's scenarios", () => {
  it("1. Indian SaaS founder selling to US clients, two visas: free zone, visa package flagged, cross-border review", () => {
    const a = advise(base({ activity: "tech", customers: "international", visas: 2, budgetAed: 25_000, foreignTaxResident: true }), rules, zones);
    expect(a.structure.recommendation).toBe("free_zone");
    expect(a.places[0]!.zone).toBe("IFZA");
    expect(a.places[0]!.findings!.find((f) => f.ruleKey === "place.visa_package")!.outcome).toBe("condition"); // standard package covers 1
    expect(keysOf(a)).toEqual(expect.arrayContaining(["crossborder.founder_residence", "crossborder.permanent_establishment", "obligation.ct_qfzp"]));
    expect(structureStatus(a, "offshore")).toBe("INELIGIBLE");
  });

  it("2. mainland retailer with a physical store: mainland; offshore excluded; free zone only with an onshore arrangement", () => {
    const a = advise(base({ activity: "trading", customers: "uae_mainland", premises: "retail", visas: 2 }), rules, zones);
    expect(a.structure.recommendation).toBe("mainland");
    expect(a.places[0]!.zone).toBe("Dubai DET mainland");
    const offshore = a.structures!.find((s) => s.structure === "offshore")!;
    expect(offshore.status).toBe("INELIGIBLE");
    expect(offshore.findings.map((f) => f.ruleKey)).toEqual(expect.arrayContaining(["structure.offshore_no_visas", "structure.offshore_no_premises", "structure.offshore_no_onshore_trade"]));
    const fz = a.structures!.find((s) => s.structure === "free_zone")!;
    expect(fz.findings.map((f) => f.ruleKey)).toEqual(expect.arrayContaining(["structure.free_zone_mainland_sales", "structure.free_zone_onshore_premises"]));
  });

  it("3. holding company requesting residence visas: never offshore, with the reason", () => {
    const a = advise(base({ activity: "holding", visas: 2, budgetAed: 12_000 }), rules, zones);
    expect(a.structure.recommendation).not.toBe("offshore");
    expect(a.places.every((p) => p.type !== "offshore")).toBe(true);
    expect(a.excluded!.find((p) => p.zone === "RAK ICC")!.findings!.some((f) => f.ruleKey === "structure.offshore_no_visas" && f.outcome === "fail")).toBe(true);
  });

  it("4. holding company needing no visas, small budget: offshore remains the fit", () => {
    const a = advise(base({ emirate: "Ras Al Khaimah", activity: "holding", visas: 0, budgetAed: 15_000 }), rules, zones);
    expect(a.structure.recommendation).toBe("offshore");
    expect(a.places[0]!.zone).toBe("RAK ICC");
  });

  it("5. foreign corporation setting up a UAE subsidiary: corporate-shareholder review flagged", () => {
    const a = advise(base({ activity: "consulting", customers: "both", visas: 1, ownerType: "company" }), rules, zones);
    expect(keysOf(a)).toContain("crossborder.corporate_shareholder");
  });

  it("6. manufacturing needing industrial land: only places with industrial facilities on record qualify; unknown ones say data is missing", () => {
    const input = base({ emirate: "Abu Dhabi", activity: "manufacturing", customers: "international", visas: 3 });
    const a = advise(input, rules, zones);
    expect(a.structure.recommendation).toBe("free_zone");
    expect(a.places[0]!.zone).toBe("KEZAD");
    expect(a.excluded!.find((p) => p.zone === "IFZA")!.findings!.some((f) => f.ruleKey === "place.industrial_facilities" && f.outcome === "fail")).toBe(true);
    // A place with no facilities on record is not excluded and not passed: it says the data is missing.
    const mainland = assess(input, rules, zones, "free_zone").viable.find((p) => p.zone === "Abu Dhabi DED mainland")!;
    expect(mainland.status).toBe("DATA_UNAVAILABLE");
    expect(mainland.findings.find((f) => f.ruleKey === "place.industrial_facilities")!.missing).toBe("data");
    expect(keysOf(a)).toContain("structure.industrial_licence");
  });

  it("7. food importer distributing on the mainland: mainland, with the food-safety approval", () => {
    const a = advise(base({ activity: "food", customers: "uae_mainland", visas: 3 }), rules, zones);
    expect(a.structure.recommendation).toBe("mainland");
    expect(keysOf(a)).toContain("licence.food");
  });

  it("8. cross-border e-commerce needing storage: places with no warehousing are excluded; designated-zone VAT point raised", () => {
    const a = advise(base({ activity: "ecommerce", customers: "international", premises: "warehouse", visas: 1 }), rules, zones);
    expect(a.excluded!.some((p) => p.zone === "IFZA" && p.findings!.some((f) => f.ruleKey === "place.warehouse_facilities"))).toBe(true);
    expect(a.places.some((p) => p.zone === "DMCC")).toBe(true);
    expect(keysOf(a)).toContain("obligation.vat_designated_zone");
    // A place with no facilities on record is neither excluded nor passed: the data is missing, as for industrial land.
    const shams = a.places.find((p) => p.zone === "SHAMS")!;
    expect(shams.status).toBe("DATA_UNAVAILABLE");
    expect(shams.findings!.find((f) => f.ruleKey === "place.warehouse_facilities")!.missing).toBe("data");
  });

  it("9. regulated financial services: a generic free zone is excluded; the regulator pathway is a condition, never verified outright", () => {
    const a = advise(base({ emirate: "Abu Dhabi", activity: "finance", customers: "international", visas: 3, budgetAed: 100_000 }), verifiedRules, zones.map((x) => ({ ...x, confidence: "verified" as const })));
    expect(structureStatus(a, "free_zone")).toBe("INELIGIBLE");
    expect(a.structure.recommendation).toBe("difc_adgm");
    expect(a.places[0]!.zone).toBe("ADGM");
    expect(structureStatus(a, "difc_adgm")).toBe("ELIGIBLE_CONDITIONAL");
    expect(a.places.every((p) => p.status !== "ELIGIBLE_VERIFIED")).toBe(true);
  });

  it("10. virtual-asset business: regulator approval is a condition everywhere it is viable; offshore excluded", () => {
    const a = advise(base({ activity: "virtual_assets", customers: "international", visas: 2 }), rules, zones);
    expect(structureStatus(a, "offshore")).toBe("INELIGIBLE");
    for (const s of a.structures!.filter((x) => isViable(x.status))) expect(s.findings.some((f) => f.ruleKey === "structure.virtual_assets_regulated")).toBe(true);
  });

  it("11. healthcare provider needing licensed premises: mainland, with the health regulator's approval", () => {
    const a = advise(base({ activity: "health", customers: "uae_mainland", premises: "clinic", visas: 4 }), rules, zones);
    expect(a.structure.recommendation).toBe("mainland");
    expect(a.structures!.find((s) => s.structure === "mainland")!.findings.some((f) => f.ruleKey === "licence.health" && f.outcome === "condition")).toBe(true);
  });

  it("12. university or training institute: education approval is a condition", () => {
    const a = advise(base({ activity: "education", customers: "both", premises: "office", visas: 5 }), rules, zones);
    expect(keysOf(a)).toContain("licence.education");
    for (const s of a.structures!.filter((x) => x.structure !== "offshore")) {
      if (s.structure !== "difc_adgm") expect(s.findings.some((f) => f.ruleKey === "licence.education")).toBe(true);
    }
  });

  it("13. free zone company that wants to sell on the mainland: the onshore arrangement is a condition, not a promise", () => {
    const a = advise(base({ jurisdiction: "free_zone", activity: "consulting", customers: "both", visas: 1 }), rules, zones);
    expect(a.structure.recommendation).toBe("free_zone");
    expect(a.structures!.find((s) => s.structure === "free_zone")!.findings.find((f) => f.ruleKey === "structure.free_zone_mainland_sales")!.outcome).toBe("condition");
  });

  it("15. visas beyond a place's limit exclude it; beyond the standard package only flag the extra cost", () => {
    const a = advise(base({ emirate: "Sharjah", activity: "consulting", customers: "international", visas: 6 }), rules, zones);
    expect(a.excluded!.find((p) => p.zone === "SHAMS")!.findings!.some((f) => f.ruleKey === "place.visa_capacity" && f.outcome === "fail")).toBe(true);
    expect(a.places.find((p) => p.zone === "IFZA")!.findings!.find((f) => f.ruleKey === "place.visa_package")!.outcome).toBe("condition");
  });

  it("16. a budget no option meets: no recommendation is invented, no price is claimed, a specialist is offered", () => {
    const a = advise(base({ activity: "consulting", customers: "international", visas: 1, budgetAed: 2_000 }), rules, zones);
    expect(a.places).toEqual([]);
    expect(a.noViableOption).toBe(true);
    expect(keysOf(a)).toContain("structure.no_viable_option");
    expect(a.excluded!.every((p) => p.findings!.some((f) => f.ruleKey === "place.budget" && f.outcome === "fail"))).toBe(true);
  });

  it("19. a place with no cost data says so when the budget matters", () => {
    const thin = [...zones, z("Unknown Zone", "Dubai", "free_zone", 1, 0, 0, ["consulting"])];
    const a = advise(base({ activity: "consulting", customers: "international", visas: 1, budgetAed: 50_000 }), rules, thin);
    const p = a.places.find((x) => x.zone === "Unknown Zone")!;
    expect(p.status).toBe("DATA_UNAVAILABLE");
    expect(p.findings!.some((f) => f.ruleKey === "place.cost_estimate" && f.missing === "data")).toBe(true);
    expect(a.places.findIndex((x) => x.zone === "Unknown Zone")).toBeGreaterThan(a.places.findIndex((x) => x.zone === "IFZA"));
  });

  it("21. contradictory answers are named, and the advice needs verification", () => {
    const a = advise(base({ jurisdiction: "offshore", activity: "consulting", customers: "international", visas: 2, officeNeeded: true, premises: "virtual", taxableSuppliesAed: 900_000, expectedTurnoverAed: 400_000 }), verifiedRules, zones);
    expect(a.contradictions).toHaveLength(4);
    expect(a.contradictions).toContain("You asked for an offshore company and premises in the UAE; an offshore company cannot lease premises or operate a place of business here.");
    expect(a.needsVerification).toBe(true);
    const asked = a.structure.reasons.find((r) => r.ruleKey === "structure.requested_differs")!;
    expect(asked.text).toMatch(/You asked for offshore, which does not fit: An offshore company cannot sponsor residence visas/);
  });
});

describe("corrections the contract names", () => {
  it("a sector tag is a preference, never a permission: every place still needs its activity list confirmed", () => {
    const a = advise(base({ activity: "consulting", customers: "international", visas: 1 }), verifiedRules, zones.map((x) => ({ ...x, confidence: "verified" as const })));
    for (const p of a.places) expect(p.findings!.find((f) => f.ruleKey === "place.activity_listed")!.missing).toBe("check");
    expect(a.places.every((p) => p.status === "REQUIRES_VERIFICATION")).toBe(true);
  });

  it("affordability is only claimed from the estimate, and the estimate's confidence travels with it", () => {
    const a = advise(base({ activity: "consulting", customers: "international", visas: 1, budgetAed: 30_000 }), verifiedRules, zones);
    const f = a.places.find((p) => p.zone === "IFZA")!.findings!.find((x) => x.ruleKey === "place.budget")!;
    expect(f.outcome).toBe("pass");
    expect(f.confidence).toBe("UNCERTAIN"); // the rule is verified, the cost data is not
  });

  it("VAT turns on taxable supplies; turnover alone is flagged as a stand-in", () => {
    const byTurnover = advise(base({ activity: "consulting", customers: "international", visas: 1, expectedTurnoverAed: 500_000 }), rules, zones);
    expect(keysOf(byTurnover)).toEqual(expect.arrayContaining(["obligation.vat_mandatory", "obligation.vat_basis"]));
    const bySupplies = advise(base({ activity: "consulting", customers: "international", visas: 1, expectedTurnoverAed: 500_000, taxableSuppliesAed: 100_000 }), rules, zones);
    expect(keysOf(bySupplies)).toContain("obligation.vat_watch");
    expect(keysOf(bySupplies)).not.toContain("obligation.vat_basis");
  });

  it("corporate tax separates the ordinary regime, the qualifying free zone conditions and small business relief", () => {
    const founder = base({ activity: "tech", customers: "international", visas: 1, expectedTurnoverAed: 1_000_000 });
    const fz = advise(founder, rules, zones, "2026-05-01");
    expect(keysOf(fz)).toEqual(expect.arrayContaining(["obligation.corporate_tax", "obligation.ct_qfzp", "obligation.ct_small_business_relief"]));
    // A company formed after 30 June 2026 has no tax period ending by 31 December 2026: relief is not offered to it,
    // and without a date the engine does not offer it either. An existing company may still have such a period.
    expect(keysOf(advise(founder, rules, zones, "2026-11-02"))).not.toContain("obligation.ct_small_business_relief");
    expect(keysOf(advise(founder, rules, zones))).not.toContain("obligation.ct_small_business_relief");
    expect(keysOf(advise({ mode: "services", emirate: "Dubai", expectedTurnoverAed: 1_000_000 }, rules, zones, "2026-11-02"))).toContain("obligation.ct_small_business_relief");
    expect(keysOf(advise({ mode: "services", emirate: "Dubai", expectedTurnoverAed: 1_000_000 }, rules, zones, "2027-01-15"))).not.toContain("obligation.ct_small_business_relief");
    const ml = advise(base({ activity: "trading", customers: "uae_mainland", premises: "retail", visas: 1, expectedTurnoverAed: 5_000_000 }), rules, zones, "2026-05-01");
    expect(keysOf(ml)).not.toContain("obligation.ct_qfzp");
    expect(keysOf(ml)).not.toContain("obligation.ct_small_business_relief");
  });

  it("missing facts are listed instead of assumed", () => {
    const a = advise(base({}), rules, zones);
    expect(a.missingFacts).toEqual(expect.arrayContaining(["What the business will do (its main activity)", "How many residence visas are needed"]));
    expect(a.structures!.every((s) => s.status !== "ELIGIBLE_VERIFIED")).toBe(true);
  });
});

describe("invariants over a matrix of founders", () => {
  const activities = ["trading", "consulting", "ecommerce", "tech", "holding", "finance", "virtual_assets", "health", "education", "food", "construction", "manufacturing", "other"] as const;
  const customers = ["uae_mainland", "international", "both", undefined] as const;
  const visaCounts = [0, 1, 4, 12];
  const budgets = [null, 5_000, 20_000, 200_000];
  const premises = [undefined, "none", "office", "retail", "warehouse"] as const;
  const inputs: AdviceInput[] = [];
  for (const activity of activities) for (const c of customers) for (const visas of visaCounts) for (const budgetAed of budgets) for (const p of premises) inputs.push(base({ activity, customers: c, visas, budgetAed, premises: p }));

  it(`holds for all ${activities.length * customers.length * visaCounts.length * budgets.length * premises.length} combinations`, () => {
    const book = new Rulebook(rules);
    for (const input of inputs) {
      const a = advise(input, rules, zones);
      const label = JSON.stringify(input);
      // The recommended structure is never one the rules exclude.
      if (a.structure.recommendation) expect(assessStructure(a.structure.recommendation as any, input, book).status, label).not.toBe("INELIGIBLE");
      // Offshore is never offered to a founder who needs visas, premises or onshore customers.
      if ((input.visas ?? 0) > 0 || (input.premises && !["none", "virtual"].includes(input.premises)) || input.customers === "uae_mainland" || input.customers === "both") {
        expect(a.places.some((p) => p.type === "offshore"), label).toBe(false);
      }
      // A regulated financial activity never gets a generic free zone.
      if (input.activity === "finance") expect(a.places.some((p) => p.type === "free_zone"), label).toBe(false);
      // Nothing offered carries an exclusion; nothing over the budget is offered.
      for (const p of a.places) {
        expect(p.findings!.some((f) => f.outcome === "fail"), label).toBe(false);
        if (input.budgetAed) expect(p.costMinFils, label).toBeLessThanOrEqual(input.budgetAed * 100);
      }
      // At most five options; none verified while the rules are not.
      expect(a.places.length).toBeLessThanOrEqual(5);
      expect(a.places.every((p) => p.status !== "ELIGIBLE_VERIFIED"), label).toBe(true);
      // With places but no recommendation, or a recommendation with no places, the advice says no option fits.
      if (!a.places.length) expect(a.noViableOption, label).toBe(true);
      // The first place offered is of the recommended structure: a recommendation is never shown over another
      // structure's places.
      if (a.places.length) {
        const t = a.places[0]!.type;
        expect(t === "financial" ? "difc_adgm" : t, label).toBe(a.structure.recommendation);
      }
    }
  });

  it("is deterministic and takes no commercial input", () => {
    const input = base({ activity: "tech", customers: "international", visas: 2, budgetAed: 20_000 });
    expect(JSON.stringify(advise(input, rules, zones))).toBe(JSON.stringify(advise(input, rules, [...zones].reverse())));
    // Commercial terms attached to the places (a partner's cost, MKW's margin, a commission) change nothing: the
    // ranking and every statement are the same, and none of those terms appears in the output.
    const commercial = zones.map((x, i) => ({ ...x, partnerCostFils: (i + 1) * 1_000_000, marginBp: (9 - i) * 500, commissionBp: i * 300 }));
    const withTerms = advise(input, rules, commercial as Zone[]);
    expect(JSON.stringify(withTerms)).toBe(JSON.stringify(advise(input, rules, zones)));
    expect(JSON.stringify(withTerms)).not.toMatch(/partnerCost|margin|commission/i);
  });
});

describe("review regressions", () => {
  it("a finding is never more confident than the weaker of its rule and the place data", () => {
    expect(weaker("rule_of_thumb", "UNCERTAIN")).toBe("UNCERTAIN");
    expect(weaker("verified", "rule_of_thumb")).toBe("rule_of_thumb");
    expect(weaker("verified", "verified")).toBe("verified");
    const thumb = rules.map((r) => ({ ...r, confidence: "rule_of_thumb" as const }));
    const a = advise(base({ activity: "tech", customers: "international", visas: 1, budgetAed: 100_000 }), thumb, zones); // places UNCERTAIN
    const budget = a.places.flatMap((p) => p.findings!).filter((f) => f.ruleKey === "place.budget");
    expect(budget.length).toBeGreaterThan(0);
    expect(budget.every((f) => f.confidence === "UNCERTAIN")).toBe(true);
  });

  it("a recommended structure with no place that fits moves to the closest structure that has one, and says why", () => {
    // Every free zone on record costs more than AED 10,000 at its lowest except SHAMS (6,000 to 12,000, so a
    // condition); with a budget of 5,000 no free zone fits, and no mainland place either: no option.
    const tight = advise(base({ activity: "consulting", customers: "international", visas: 1, budgetAed: 5_000 }), rules, zones);
    expect(tight.places).toHaveLength(0);
    expect(tight.noViableOption).toBe(true);
    // Without SHAMS, AED 12,000 fits no free zone (IFZA from 12,000 fits; drop it too) but fits Abu Dhabi DED mainland.
    const places = zones.filter((x) => x.name !== "SHAMS" && x.name !== "IFZA");
    const a = advise(base({ activity: "consulting", customers: "international", visas: 1, budgetAed: 12_000 }), rules, places);
    expect(a.structure.recommendation).toBe("mainland");
    expect(a.places[0]!.type).toBe("mainland");
    expect(a.structure.reasons.find((r) => r.ruleKey === "structure.no_viable_place")!.text).toMatch(/No free zone place we hold data for fits the answers on the budget\. mainland is the closest structure/);
    expect(a.noViableOption).toBe(false);
  });

  it("a place the founder names is promoted only within the recommended structure", () => {
    const a = advise(base({ activity: "tech", customers: "international", visas: 0, freeZone: "RAK ICC" }), rules, zones);
    expect(a.structure.recommendation).toBe("free_zone");
    expect(a.places[0]!.type).toBe("free_zone");
    const named = advise(base({ activity: "tech", customers: "international", visas: 0, freeZone: "SHAMS" }), rules, zones);
    expect(named.places[0]!.zone).toBe("SHAMS");
  });

  it("virtual assets name the right regulator for the emirate", () => {
    const text = (emirate: string) => advise(base({ emirate, activity: "virtual_assets", customers: "international" }), rules, zones).structure.reasons[0]!.text;
    expect(text("Dubai")).toMatch(/VARA/);
    expect(text("Sharjah")).toMatch(/SCA/);
    expect(text("Sharjah")).not.toMatch(/VARA/);
    expect(text("Abu Dhabi")).toMatch(/FSRA in ADGM/);
    const fz = assessStructure("free_zone", base({ activity: "virtual_assets" }), new Rulebook(rules)).findings.find((f) => f.ruleKey === "structure.virtual_assets_regulated")!;
    expect(fz.text).not.toMatch(/FSRA/);
  });

  it("the Wage Protection System is a mainland obligation; zones get their own payroll point", () => {
    const ml = advise(base({ activity: "trading", customers: "uae_mainland", premises: "retail", visas: 2 }), rules, zones);
    expect(ml.structure.recommendation).toBe("mainland");
    expect(keysOf(ml)).toContain("obligation.wps");
    const fz = advise(base({ activity: "tech", customers: "international", visas: 2 }), rules, zones);
    expect(keysOf(fz)).not.toContain("obligation.wps");
    expect(keysOf(fz)).toContain("obligation.payroll_zone");
  });

  it("a holding vehicle with visas in DIFC or ADGM is not said to sponsor visas on its own", () => {
    const a = advise(base({ activity: "holding", visas: 2, budgetAed: 80_000 }), rules, zones);
    expect(a.structure.recommendation).toBe("difc_adgm");
    expect(a.structure.reasons[0]!.text).toMatch(/carries no visas on its own/);
  });

  it("offshore with onshore customers is named as a contradiction", () => {
    const a = advise(base({ jurisdiction: "offshore", activity: "holding", customers: "both", visas: 0 }), rules, zones);
    expect(a.contradictions).toContain("You asked for an offshore company and customers in the UAE; an offshore company cannot trade with customers here.");
  });

  it("contradictory premises answers keep the premises requirement: offshore stays excluded", () => {
    const a = base({ jurisdiction: "offshore", activity: "holding", customers: "international", visas: 0, officeNeeded: true, premises: "none" });
    const off = assessStructure("offshore", a, new Rulebook(rules));
    expect(off.status).toBe("INELIGIBLE");
    expect(off.findings.some((f) => f.ruleKey === "structure.offshore_no_premises" && f.outcome === "fail")).toBe(true);
    expect(advise(a, rules, zones).contradictions).toContain("You said you need an office, and also that you need no physical premises.");
  });
});

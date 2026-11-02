import { describe, expect, it } from "vitest";
import { advise, engineTextsByRule, publicView, PUBLIC_DISCLAIMER, type AdviceInput, type ScopingRule, type Zone } from "../src/index.ts";

/**
 * E3 (D80): the public view shows only statements and figures a named person approved for public display. With no
 * approvals, no rule text and no figure reaches the public; with everything approved, the public sees what the advice
 * says. Checked over the same matrix of founders as the engine's invariants.
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
const rules: ScopingRule[] = KEYS.map((key) => ({ key, kind: "structure", statement: key, parameters: {}, sourceUrl: "", confidence: "verified", verifiedBy: "A", verifiedAt: "2026-11-01" }));
const z = (name: string, emirate: string, type: Zone["type"], visaQuota: number, min: number, max: number, activities: string[], extra: Partial<Zone> = {}): Zone => ({
  name, emirate, type, visaQuota, costMinFils: min * 100, costMaxFils: max * 100, timelineDays: 10, activities, sourceUrl: "", confidence: "verified", authority: `${name} Authority`, ...extra,
});
const zones: Zone[] = [
  z("IFZA", "Dubai", "free_zone", 1, 12_000, 20_000, ["consulting", "tech"], { facilities: ["office"], activitiesListed: ["tech"], activitiesListedConfidence: "verified", renewalMinFils: 900_000, renewalMaxFils: 1_100_000, renewalConfidence: "UNCERTAIN" }),
  z("KEZAD", "Abu Dhabi", "free_zone", 3, 18_000, 40_000, ["manufacturing"], { facilities: ["office", "warehouse", "industrial"] }),
  z("Dubai DET mainland", "Dubai", "mainland", 2, 15_000, 35_000, ["trading", "food"]),
  z("RAK ICC", "Ras Al Khaimah", "offshore", 0, 8_000, 15_000, ["holding"], { visaMax: 0 }),
  z("DIFC", "Dubai", "financial", 2, 30_000, 60_000, ["finance", "holding"]),
];
const base = (x: Partial<AdviceInput>): AdviceInput => ({ mode: "new_company", emirate: "Dubai", ...x });
const NONE = new Set<string>();
const ALL_RULES = new Set(KEYS);
const ALL_PLACES = new Set(zones.map((x) => x.name));
const texts = (a: ReturnType<typeof advise>) => [...a.structure.reasons, ...a.licences, ...a.obligations, ...(a.crossBorder ?? [])].map((r) => r.text);

describe("the public view (E3, D80)", () => {
  const inputs: AdviceInput[] = [];
  for (const activity of ["trading", "consulting", "holding", "finance", "manufacturing", "health"] as const)
    for (const customers of ["uae_mainland", "international", undefined] as const)
      for (const visas of [0, 2, 12]) for (const budgetAed of [null, 5_000, 50_000]) for (const premises of [undefined, "none", "retail", "warehouse"] as const) for (const jurisdiction of [undefined, "offshore"] as const)
        inputs.push(base({ activity, customers, visas, budgetAed, premises, jurisdiction, expectedTurnoverAed: 1_000_000, foreignTaxResident: true, ownerType: "company" }));

  it(`with nothing approved, no rule text and no figure reaches the public (${inputs.length} founders)`, () => {
    for (const input of inputs) {
      const a = advise(input, rules, zones, "2026-05-01");
      const p = publicView(a, NONE, NONE, "2026-05-01");
      const label = JSON.stringify(input);
      const json = JSON.stringify(p);
      for (const t of texts(a)) expect(json, label).not.toContain(JSON.stringify(t).slice(1, -1));
      for (const place of [...a.places, ...(a.excluded ?? [])]) {
        expect(json, label).not.toContain(String(place.costMinFils));
        for (const f of place.findings ?? []) expect(json, label).not.toContain(JSON.stringify(f.text).slice(1, -1));
      }
      // No figure key, no rule key, no outcome, no authority, no preference, no conclusion of any kind.
      expect(json, label).not.toMatch(/visaQuota|timelineDays|costM|renewal|ruleKey|outcome|authority|known for|does not fit|\.offshore_|\.budget/);
      // "Data missing" states what MKW does not hold, not a rule's conclusion, so it may stay.
      expect(p.places.every((x) => x.toBeVerified && !x.figures && x.why.length === 0 && (x.status === "REQUIRES_VERIFICATION" || x.status === "DATA_UNAVAILABLE")), label).toBe(true);
      expect(p.structure.confirmed, label).toBe(false);
      expect(p.structure.recommendation, label).toBeNull(); // the chosen structure is itself a conclusion
      expect(json, label).not.toMatch(/"recommendation":"/);
      expect(p.structures.every((s) => s.status === "REQUIRES_VERIFICATION" || s.status === "DATA_UNAVAILABLE"), label).toBe(true);
      expect(p.excluded, label).toHaveLength(0);
      expect(p.noViableOption, label).toBe(false);
      // Every place the engine knows is listed (excluded ones as "to be verified"), so an empty list never implies no fit.
      expect(p.places.length, label).toBe(a.places.length + (a.excluded?.length ?? 0));
      expect(p.approved, label).toMatchObject({ statements: 0, places: 0 });
      expect(p.disclaimer).toBe(PUBLIC_DISCLAIMER);
      // The founder's own questions are always shown; a contradiction that restates a rule is not.
      expect(p.missingFacts, label).toEqual(a.missingFacts);
      expect(p.contradictions.some((c) => /offshore company/.test(c)), label).toBe(false);
    }
  });

  it("with everything approved, the public sees what the advice says, figures included", () => {
    for (const input of inputs.filter((_, i) => i % 7 === 0)) {
      const a = advise(input, rules, zones, "2026-05-01");
      const p = publicView(a, ALL_RULES, ALL_PLACES, "2026-05-01");
      const label = JSON.stringify(input);
      expect([...p.structure.reasons, ...p.licences, ...p.obligations, ...p.crossBorder].map((s) => s.text), label).toEqual(texts(a));
      expect(p.structure.confirmed, label).toBe(!!a.structure.recommendation);
      expect(p.structure.recommendation, label).toBe(a.structure.recommendation ?? null);
      expect(p.places.map((x) => x.figures!.costMinFils), label).toEqual(a.places.map((x) => x.costMinFils));
      expect(p.noViableOption, label).toBe(!!a.noViableOption);
      expect(p.structures.map((s) => s.status), label).toEqual(a.structures!.map((s) => s.status));
      expect(p.excluded.map((x) => x.zone), label).toEqual((a.excluded ?? []).map((x) => x.zone));
      expect(p.contradictions, label).toEqual(a.contradictions);
      expect(p.approved.statements, label).toBe(p.approved.ofStatements);
    }
  });

  it("approves one rule and one place at a time, and nothing else leaks with them", () => {
    const a = advise(base({ activity: "holding", customers: "international", visas: 2, jurisdiction: "offshore", budgetAed: 50_000 }), rules, zones, "2026-05-01");
    const p = publicView(a, new Set(["structure.offshore_no_visas", "place.budget"]), new Set(["IFZA"]), "2026-05-01");
    // A place rule approved on its own shows nothing for places that are not approved: its text carries their figures.
    for (const x of p.places.filter((y) => y.zone !== "IFZA")) expect(x.findings.some((f) => f.ruleKey === "place.budget" || /budget/.test(f.text ?? ""))).toBe(false);
    expect(p.places.find((x) => x.zone === "IFZA")!.findings.find((f) => f.ruleKey === "place.budget")!.text).toMatch(/within the stated budget/);
    // An UNCERTAIN renewal estimate stays out of the public figures even on an approved place.
    expect(p.places.find((x) => x.zone === "IFZA")!.figures!.renewalMinFils).toBeNull();
    // The offshore exclusion is public; its text appears on the structure and in the contradiction.
    const off = p.structures.find((s) => s.structure === "offshore")!;
    expect(off.status).toBe("INELIGIBLE");
    expect(off.findings.find((f) => f.ruleKey === "structure.offshore_no_visas")!.text).toMatch(/cannot sponsor residence visas/);
    expect(p.contradictions.some((c) => /offshore company and 2 residence visa/.test(c))).toBe(true);
    // The recommendation's reasons are not all approved, so it is withheld; other structures stay "to be verified".
    expect(p.structure.confirmed).toBe(false);
    expect(p.structure.recommendation).toBeNull();
    // "You asked for offshore, which does not fit: ..." restates the offshore rule, so it is public only when that
    // rule is; requested_differs itself is not approved here, so it stays hidden.
    expect(p.structure.reasons.find((r) => r.topic === "a point about the structure" && r.text?.includes("You asked for"))).toBeUndefined();
    const withComposite = publicView(a, new Set(["structure.requested_differs"]), new Set(), "2026-05-01");
    expect(JSON.stringify(withComposite)).not.toMatch(/cannot sponsor residence visas/);
    const both = publicView(a, new Set(["structure.requested_differs", "structure.offshore_no_visas"]), new Set(), "2026-05-01");
    expect(JSON.stringify(both)).toMatch(/You asked for offshore, which does not fit: An offshore company cannot sponsor residence visas/);
    expect(p.structures.find((s) => s.structure === "free_zone")!.status).toBe("REQUIRES_VERIFICATION");
    // IFZA shows figures, nothing else does; IFZA's own findings still need their rules.
    const ifza = p.places.find((x) => x.zone === "IFZA");
    expect(ifza?.figures?.costMinFils).toBe(1_200_000);
    expect(p.places.filter((x) => x.zone !== "IFZA").every((x) => !x.figures)).toBe(true);
    expect(ifza!.findings.every((f) => f.toBeVerified || f.ruleKey === "structure.offshore_no_visas" || f.ruleKey === "place.budget")).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/partner|margin|payout|rate_?card/i);
  });

  it("a conclusion drawn from place rules (no option fits) is public only when those rules are approved", () => {
    const a = advise(base({ activity: "consulting", customers: "international", visas: 1, budgetAed: 5_000 }), rules, zones, "2026-05-01");
    expect(a.noViableOption).toBe(true);
    const hidden = publicView(a, new Set(["structure.no_viable_option", "structure.free_zone_default"]), new Set(), "2026-05-01");
    expect(hidden.noViableOption).toBe(false);
    expect(hidden.places.length).toBeGreaterThan(0); // the excluded places are listed as "to be verified"
    // The conclusion rests on every rule that excluded a place: the budget rule and, for the offshore registry, the
    // visa rule. With only the budget rule approved it stays hidden.
    const partly = publicView(a, new Set(["structure.no_viable_option", "structure.free_zone_default", "place.budget"]), new Set(), "2026-05-01");
    expect(partly.noViableOption).toBe(false);
    // The offshore registry fails on visas twice over (the structure rule and the place's visa limit): both count.
    const all = new Set(["structure.no_viable_option", "structure.free_zone_default", "place.budget", "structure.offshore_no_visas", "place.visa_capacity"]);
    const shown = publicView(a, all, new Set(), "2026-05-01");
    expect(shown.noViableOption).toBe(true);
    expect(shown.excluded.map((x) => x.zone)).toEqual(["RAK ICC"]); // excluded by a structure rule; the place rules still need each place approved
    const named = publicView(a, all, new Set(["IFZA"]), "2026-05-01");
    expect(named.excluded.map((x) => x.zone).sort()).toEqual(["IFZA", "RAK ICC"]);
  });

  it("the engine's wording per rule is enumerable, deterministic and covers every rule the engine can emit", () => {
    const t1 = engineTextsByRule(rules);
    const t2 = engineTextsByRule([...rules].reverse());
    expect([...t1.entries()]).toEqual([...t2.entries()]);
    expect(t1.get("structure.offshore_no_visas")!.some((x) => /cannot sponsor residence visas/.test(x))).toBe(true);
    expect(t1.get("structure.holding")!.length).toBeGreaterThanOrEqual(4);
    expect(t1.get("obligation.ct_small_business_relief")!.length).toBe(1);
    for (const key of KEYS.filter((k) => !["structure.requested_differs"].includes(k))) expect(t1.has(key), key).toBe(true);
  });
});

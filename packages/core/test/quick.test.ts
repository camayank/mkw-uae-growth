import { describe, expect, it } from "vitest";
import { advise, publicView, QUICK_BUDGETS, QUICK_EMIRATES, quickInput, quickMatch, type QuickAnswers, type QuickBudget, type ScopingRule, type Zone } from "../src/index.ts";

/**
 * E8 quick match: four answers to the place to look at first, with live counts. It is the full assessment's engine
 * and public filter (D80) on fewer answers: nothing unapproved is stated, a count falls only on an approved exclusion,
 * and the place shown first is the engine's own ranking.
 */
const KEYS = ["structure.free_zone_default", "structure.offshore_no_visas", "structure.holding", "structure.no_viable_option", "structure.no_viable_place", "structure.preferred_excluded", "place.visa_capacity", "place.visa_package", "place.cost_estimate", "place.budget", "place.activity_listed", "obligation.corporate_tax", "obligation.ct_qfzp"];
const rules: ScopingRule[] = KEYS.map((key) => ({ key, kind: "structure", statement: key, parameters: {}, sourceUrl: "", confidence: "verified", verifiedBy: "A", verifiedAt: "2026-11-01" }));
const z = (name: string, emirate: string, type: Zone["type"], visaQuota: number, min: number, max: number, activities: string[], extra: Partial<Zone> = {}): Zone => ({
  name, emirate, type, visaQuota, costMinFils: min * 100, costMaxFils: max * 100, timelineDays: 10, activities, sourceUrl: "https://example.test/" + name, confidence: "verified", authority: `${name} Authority`, activitiesListed: ["tech", "consulting", "trading"], activitiesListedConfidence: "verified", ...extra,
});
const zones: Zone[] = [
  z("IFZA", "Dubai", "free_zone", 1, 12_000, 20_000, ["consulting", "tech"], { visaMax: 6 }),
  z("SHAMS", "Sharjah", "free_zone", 1, 6_000, 12_000, ["consulting"], { visaMax: 3 }),
  z("RAKEZ", "Ras Al Khaimah", "free_zone", 2, 9_000, 16_000, ["trading"], { visaMax: 10 }),
  z("Dubai DET mainland", "Dubai", "mainland", 2, 22_000, 40_000, ["trading"]),
  z("RAK ICC", "Ras Al Khaimah", "offshore", 0, 8_000, 15_000, ["holding"], { visaMax: 0 }),
];
const NONE = new Set<string>();
const ALL_RULES = new Set(KEYS);
const ALL_PLACES = new Set(zones.map((x) => x.name));
const AS_OF = "2026-11-03";

describe("the quick match (E8)", () => {
  const cases: QuickAnswers[] = [];
  for (const activity of [undefined, "tech", "trading", "holding"] as const)
    for (const emirate of [undefined, "Dubai", "Fujairah"]) for (const visas of [undefined, 0, 2, 8]) for (const budget of [undefined, ...QUICK_BUDGETS.map((b) => b.id)] as Array<QuickBudget | undefined>) cases.push({ activity, emirate, visas, budget });

  it(`with nothing approved, no figure, rule text or exclusion reaches the public and every count is the whole list (${cases.length} founders)`, () => {
    for (const q of cases) {
      const m = quickMatch(q, rules, zones, NONE, NONE, AS_OF);
      const json = JSON.stringify(m);
      const label = JSON.stringify(q);
      expect(json, label).not.toMatch(/visaQuota|costM|timelineDays|authority|sourceUrl|AED|ruleKey|outcome/);
      expect(m.structure, label).toEqual({ recommendation: null, confirmed: false });
      expect(m.noViableOption, label).toBe(false);
      // An unapproved exclusion is a place still to be verified, so no answer makes a count fall.
      expect(m.byBudget.every((b) => b.options === m.options), label).toBe(true);
      expect(Object.values(m.byEmirate).reduce((a, b) => a + b, 0), label).toBe(zones.length);
      expect(m.approved, label).toEqual({ places: 0, ofPlaces: m.options });
      if (m.best) expect(m.best.toBeVerified && !m.best.figures, label).toBe(true);
    }
  });

  it("the place shown first is the full assessment's first place on the same answers, among the chosen emirate's places", () => {
    for (const q of cases) {
      const m = quickMatch(q, rules, zones, ALL_RULES, ALL_PLACES, AS_OF);
      const local = q.emirate ? zones.filter((x) => x.emirate === q.emirate) : zones;
      const inEmirate = publicView(advise(quickInput(q), rules, local, AS_OF), ALL_RULES, ALL_PLACES, AS_OF).places.filter((p) => p.status !== "INELIGIBLE");
      const everywhere = publicView(advise(quickInput(q), rules, zones, AS_OF), ALL_RULES, ALL_PLACES, AS_OF).places.filter((p) => p.status !== "INELIGIBLE");
      const ranked = m.options ? inEmirate : everywhere;
      expect(m.best?.zone ?? null, JSON.stringify(q)).toBe(ranked[0]?.zone ?? null);
      expect(m.alternatives.map((p) => p.zone), JSON.stringify(q)).toEqual(ranked.slice(1, 3).map((p) => p.zone));
      if (q.emirate && m.best) expect(m.best.emirate === q.emirate, JSON.stringify(q)).toBe(!m.bestElsewhere);
    }
  });

  it("the counts are not capped at the advice's first five places", () => {
    const many = Array.from({ length: 9 }, (_, i) => z(`Zone ${i}`, "Dubai", "free_zone", 2, 5_000 + i * 1_000, 9_000 + i * 1_000, ["tech"], { visaMax: 6 }));
    const m = quickMatch({ activity: "tech", emirate: "Dubai", visas: 1 }, rules, many, ALL_RULES, new Set(many.map((x) => x.name)), AS_OF);
    expect(m.options).toBe(9);
    expect(m.byBudget.find((b) => b.id === "up_to_15k")!.options).toBe(9);
    expect(quickMatch({ activity: "tech", emirate: "Dubai", visas: 1, budget: "up_to_15k" }, rules, many, ALL_RULES, new Set(many.map((x) => x.name)), AS_OF).options).toBe(9);
  });

  it("with everything approved, the counts fall with the budget and the visas, and the figures appear", () => {
    const tech = (x: Partial<QuickAnswers>) => quickMatch({ activity: "tech", ...x }, rules, zones, ALL_RULES, ALL_PLACES, AS_OF);
    const m = tech({ visas: 1 });
    const band = (id: QuickBudget) => m.byBudget.find((b) => b.id === id)!.options;
    // Lowest estimates: SHAMS 6,000, RAK ICC 8,000, RAKEZ 9,000, IFZA 12,000, DET 22,000 (RAK ICC carries no visas).
    expect([band("up_to_15k"), band("up_to_25k"), band("up_to_50k"), band("open")]).toEqual([3, 4, 4, 4]);
    expect(tech({ visas: 1, budget: "up_to_15k" }).options).toBe(3);
    expect(tech({ visas: 8 }).options).toBe(2); // SHAMS (3) and IFZA (6) cap below 8; RAKEZ and the mainland remain
    expect(m.best!.figures).toMatchObject({ costMinFils: expect.any(Number), visaQuota: expect.any(Number) });
    expect(m.approved.places).toBe(m.approved.ofPlaces);
    expect(m.byEmirate).toMatchObject({ Dubai: 2, Sharjah: 1, "Ras Al Khaimah": 1, Fujairah: 0 });
    expect(Object.keys(m.byEmirate)).toEqual([...QUICK_EMIRATES]);
  });

  it("an emirate narrows the list; an emirate with nothing open shows the closest place elsewhere and says so", () => {
    const dubai = quickMatch({ activity: "tech", emirate: "Dubai", visas: 1 }, rules, zones, ALL_RULES, ALL_PLACES, AS_OF);
    expect(dubai.options).toBe(2);
    expect(dubai.best!.emirate).toBe("Dubai");
    expect(dubai.bestElsewhere).toBe(false);
    const fujairah = quickMatch({ activity: "tech", emirate: "Fujairah", visas: 1 }, rules, zones, ALL_RULES, ALL_PLACES, AS_OF);
    expect(fujairah.options).toBe(0);
    expect(fujairah.bestElsewhere).toBe(true);
    expect(fujairah.best!.emirate).not.toBe("Fujairah");
    expect(fujairah.byBudget.every((b) => b.options === 0)).toBe(true);
  });

  it("the engine reads only the four answers: everything else is left unanswered", () => {
    expect(quickInput({ activity: "tech", emirate: "Dubai", visas: 2, budget: "up_to_25k" })).toEqual({ mode: "new_company", emirate: "Dubai", activity: "tech", visas: 2, budgetAed: 25_000 });
    expect(quickInput({})).toEqual({ mode: "new_company", emirate: "", visas: 0, budgetAed: null });
    expect(quickInput({ budget: "open" }).budgetAed).toBeNull();
  });
});

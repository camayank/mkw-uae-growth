import { describe, expect, it } from "vitest";
import { advise, assess, publicAssessment, quickMatch, type AdviceInput, type ScopingRule, type Structure, type Zone } from "../src/index.ts";

/**
 * E13 (D95): the public order of places uses only what the public may see: approved facts and the founder's own
 * answers. An unapproved estimate, activity list or condition never puts one place ahead of another; with everything
 * approved the order is the engine's; and the quick match names a lead only when a person approved that place.
 */
const KEYS = [
  "structure.free_zone_default", "structure.requested_differs", "structure.free_zone_mainland_sales", "structure.mainland_onshore", "structure.mainland_tenders",
  "structure.holding", "structure.offshore_no_visas", "structure.financial_regulated", "structure.offshore_no_premises", "structure.offshore_no_onshore_trade",
  "structure.offshore_activity", "structure.virtual_assets_regulated", "structure.free_zone_onshore_premises", "structure.industrial_licence",
  "structure.holding_free_zone", "structure.mainland_holding", "structure.mainland_foreign_ownership", "structure.financial_zone_non_financial", "structure.preferred_excluded",
  "structure.no_viable_option", "structure.no_viable_place", "place.visa_capacity", "place.visa_package", "place.cost_estimate", "place.budget", "place.activity_listed",
  "place.industrial_facilities", "place.warehouse_facilities",
  "obligation.corporate_tax", "obligation.ct_qfzp", "obligation.ct_small_business_relief", "obligation.vat_mandatory", "obligation.vat_voluntary",
  "obligation.vat_watch", "obligation.vat_basis", "obligation.vat_designated_zone", "obligation.ubo", "obligation.wps", "obligation.payroll_zone",
];
const rules: ScopingRule[] = KEYS.map((key) => ({ key, kind: "structure", statement: key, parameters: {}, sourceUrl: "", confidence: "verified", verifiedBy: "A", verifiedAt: "2026-11-01" }));
const z = (name: string, emirate: string, type: Zone["type"], visaQuota: number, min: number, activities: string[], extra: Partial<Zone> = {}): Zone => ({
  name, emirate, type, visaQuota, costMinFils: min * 100, costMaxFils: min * 200, timelineDays: 10, activities, sourceUrl: "https://example.test/" + name, confidence: "verified", authority: `${name} Authority`, ...extra,
});
const zones: Zone[] = [
  z("IFZA", "Dubai", "free_zone", 1, 12_000, ["consulting", "tech"], { visaMax: 6 }),
  z("Meydan", "Dubai", "free_zone", 2, 14_000, ["ecommerce"], { visaMax: 6 }),
  z("DMCC", "Dubai", "free_zone", 3, 30_000, ["trading"], { visaMax: 6 }),
  z("SHAMS", "Sharjah", "free_zone", 1, 6_000, ["consulting"], { visaMax: 3 }),
  z("RAKEZ", "Ras Al Khaimah", "free_zone", 2, 9_000, ["trading"], { visaMax: 10 }),
  z("KEZAD", "Abu Dhabi", "free_zone", 3, 18_000, ["manufacturing"], { facilities: ["office", "warehouse", "industrial"] }),
  z("Dubai DET mainland", "Dubai", "mainland", 2, 15_000, ["trading", "food"]),
  z("RAK ICC", "Ras Al Khaimah", "offshore", 0, 8_000, ["holding"], { visaMax: 0 }),
  z("DIFC", "Dubai", "financial", 2, 30_000, ["finance", "holding"]),
  // A second place of each other kind, so a status flip inside a kind could reorder it (independent review of E13).
  z("Ajman DED", "Ajman", "mainland", 2, 11_000, ["trading", "consulting"]),
  z("ADGM", "Abu Dhabi", "financial", 2, 25_000, ["finance"]),
  z("Ajman Offshore", "Ajman", "offshore", 0, 7_000, ["holding"], { visaMax: 0 }),
];
const NONE = new Set<string>();
const ALL_RULES = new Set(KEYS);
const ALL_PLACES = new Set(zones.map((x) => x.name));
const AS_OF = "2026-11-03";

const inputs: AdviceInput[] = [];
for (const activity of ["trading", "consulting", "tech", "holding", "finance", "manufacturing"] as const)
  for (const emirate of ["Dubai", "Sharjah", ""])
    for (const visas of [0, 2, 8]) for (const budgetAed of [null, 10_000, 15_000]) for (const freeZone of [undefined, "Meydan", "RAK ICC"]) for (const premises of [undefined, "warehouse"] as const)
      inputs.push({ mode: "new_company", emirate, activity, visas, budgetAed, ...(freeZone ? { freeZone } : {}), ...(premises ? { premises } : {}) });

const order = (input: AdviceInput, zs: Zone[], approvedRules: ReadonlySet<string>, approvedPlaces: ReadonlySet<string>) =>
  publicAssessment(input, rules, zs, approvedRules, approvedPlaces, AS_OF).places.map((p) => p.zone);

describe("the public order of places (E13, D95)", () => {
  it(`with everything approved, the public order is the engine's order (${inputs.length} founders)`, () => {
    for (const input of inputs) {
      const rec = (advise(input, rules, zones, AS_OF).structure.recommendation as Structure | null) ?? null;
      expect(order(input, zones, ALL_RULES, ALL_PLACES), JSON.stringify(input)).toEqual(assess(input, rules, zones, rec).viable.map((p) => p.zone));
    }
  });

  it("with nothing approved, places come by the founder's answers and then by name: never by an estimate no one checked", () => {
    for (const input of inputs) {
      const got = order(input, zones, NONE, NONE);
      const label = JSON.stringify(input);
      const score = (zone: string) => {
        const zz = zones.find((x) => x.name === zone)!;
        return (input.freeZone && (zz.name === input.freeZone) ? 5 : 0) + (input.emirate && zz.emirate === input.emirate ? 3 : 0);
      };
      const want = [...got].sort((x, y) => score(y) - score(x) || x.localeCompare(y));
      // The named place leads whatever its kind: no structure is confirmed with nothing approved.
      expect(got, label).toEqual(want);
    }
  });

  it("an unapproved place's estimates, activities, facilities or visa limits never move the order, a status, the confirmed structure or a statement", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const view = (input: AdviceInput, zs: Zone[], approved: ReadonlySet<string>) => {
      const v = publicAssessment(input, rules, zs, ALL_RULES, approved, AS_OF);
      const statements = [...v.structure.reasons, ...v.licences, ...v.obligations, ...v.crossBorder].map((x) => `${x.ruleKey ?? x.topic}:${x.text ?? ""}`);
      return { places: v.places.map((p) => `${p.zone}:${p.status}`), excluded: v.excluded.map((p) => p.zone), structure: v.structure.confirmed ? v.structure.recommendation : null, noViable: v.noViableOption, statements };
    };
    for (const approved of [NONE, new Set(["IFZA", "SHAMS"])])
      for (const input of inputs.filter((_, i) => i % 2 === 0)) {
        const base = view(input, zones, approved);
        for (let k = 0; k < 3; k++) {
          const shaken = zones.map((x) => {
            if (approved.has(x.name)) return x;
            const min = Math.round(rnd() * 5_000_000);
            return { ...x, costMinFils: min, costMaxFils: min + Math.round(rnd() * 2_000_000), activities: rnd() < 0.5 ? [] : [input.activity!, "other"], visaQuota: x.type === "offshore" ? 0 : Math.floor(rnd() * 4), visaMax: x.type === "offshore" ? 0 : rnd() < 0.3 ? undefined : Math.floor(rnd() * 10), facilities: rnd() < 0.5 ? undefined : rnd() < 0.5 ? ["office"] : ["office", "warehouse", "industrial"], activitiesListed: rnd() < 0.5 ? undefined : [input.activity!], activitiesListedConfidence: "verified" as const };
          });
          expect(view(input, shaken, approved), JSON.stringify({ input, approved: [...approved], k })).toEqual(base);
        }
      }
  });

  it("an unapproved estimate cannot switch the structure the public sees as confirmed (independent review of E13)", () => {
    // Consulting on AED 12,000 with every rule approved and no place: raising the free zones' unapproved estimates
    // above the budget makes the engine move to the mainland, but the public sees no confirmed structure either way.
    const input: AdviceInput = { mode: "new_company", emirate: "Dubai", activity: "consulting", visas: 1, budgetAed: 12_000 };
    const dear = zones.map((x) => (x.type === "free_zone" ? { ...x, costMinFils: 5_000_000, costMaxFils: 6_000_000 } : x));
    expect(advise(input, rules, dear, AS_OF).structure.recommendation).not.toBe(advise(input, rules, zones, AS_OF).structure.recommendation);
    const before = publicAssessment(input, rules, zones, ALL_RULES, NONE, AS_OF);
    const after = publicAssessment(input, rules, dear, ALL_RULES, NONE, AS_OF);
    expect(after.structure).toEqual(before.structure);
    expect(before.structure).toMatchObject({ recommendation: "free_zone", confirmed: true }); // what the structure rules say
    expect(after.places.map((p) => p.zone)).toEqual(before.places.map((p) => p.zone));
    // The structure's obligations are stated for the structure shown, not the engine's move (Codex review of E13).
    const said = (v: typeof before) => [...v.licences, ...v.obligations, ...v.crossBorder].map((x) => x.ruleKey ?? x.topic);
    expect(said(after)).toEqual(said(before));
    expect(after.obligations.some((x) => x.ruleKey === "obligation.ct_qfzp")).toBe(true);
    // With every place approved the public sees the engine's move, and its reason.
    const approvedAll = publicAssessment(input, rules, dear, ALL_RULES, new Set(dear.map((x) => x.name)), AS_OF);
    expect(approvedAll.structure).toMatchObject({ recommendation: "mainland", confirmed: true });
    expect(approvedAll.structure.reasons.some((r) => r.ruleKey === "structure.no_viable_place")).toBe(true);
  });

  it("an approved place with a lower checked estimate comes ahead of an unapproved one; approving it changes nothing else", () => {
    const input: AdviceInput = { mode: "new_company", emirate: "Dubai", activity: "consulting", visas: 1, budgetAed: null };
    // Nothing approved: the Dubai places by name.
    expect(order(input, zones, NONE, NONE).slice(0, 4)).toEqual(["DIFC", "DMCC", "Dubai DET mainland", "IFZA"]);
    // Meydan approved: its checked estimate and package put it first among the Dubai places; the rest keep their order.
    const meydan = order(input, zones, NONE, new Set(["Meydan"]));
    expect(meydan[0]).toBe("Meydan");
    expect(meydan.filter((x) => x !== "Meydan")).toEqual(order(input, zones, NONE, NONE).filter((x) => x !== "Meydan"));
  });
});

describe("the quick match names a lead only for an approved place (E13)", () => {
  it("nothing approved: no lead, three places to review, in the public order", () => {
    for (const activity of ["tech", "trading", "holding"] as const)
      for (const emirate of [undefined, "Dubai", "Fujairah"]) {
        const m = quickMatch({ activity, emirate, visas: 1 }, rules, zones, NONE, NONE, AS_OF);
        const label = JSON.stringify({ activity, emirate });
        expect(m.lead, label).toBe(false);
        const full = publicAssessment({ mode: "new_company", emirate: emirate ?? "", activity, visas: 1, budgetAed: null }, rules, zones, NONE, NONE, AS_OF).places;
        const here = emirate ? full.filter((p) => p.emirate === emirate) : full;
        expect([m.best, ...m.alternatives].map((p) => p?.zone), label).toEqual((here.length ? here : full).slice(0, 3).map((p) => p.zone));
      }
  });

  it("a lead when the first place is approved, and only then", () => {
    const q = { activity: "consulting" as const, emirate: "Dubai", visas: 1 };
    const ifza = quickMatch(q, rules, zones, ALL_RULES, new Set(["IFZA"]), AS_OF);
    expect(ifza.best?.zone).toBe("IFZA");
    expect(ifza.best?.figures?.costMinFils).toBe(1_200_000);
    expect(ifza.lead).toBe(true);
    // Rules approved but no place: the order falls back to the answers and the name, and nothing is presented as a lead.
    const rulesOnly = quickMatch(q, rules, zones, ALL_RULES, NONE, AS_OF);
    expect(rulesOnly.lead).toBe(false);
    // The free zone structure is confirmed, DIFC is ruled out for consulting by an approved rule: DMCC by name.
    expect(rulesOnly.best?.zone).toBe("DMCC");
    // In the full assessment a named place leads by the founder's own answer, approved or not; it carries no figure.
    const named = publicAssessment({ mode: "new_company", emirate: "Dubai", activity: "consulting", visas: 1, budgetAed: null, freeZone: "Meydan" }, rules, zones, ALL_RULES, new Set(["IFZA"]), AS_OF).places;
    expect(named[0]!.zone).toBe("Meydan");
    expect(named[0]!.toBeVerified && !named[0]!.figures).toBe(true);
  });
});

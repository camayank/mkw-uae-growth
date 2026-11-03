import { describe, expect, it } from "vitest";
import { advise, type AdviceInput, type ScopingRule, type Zone } from "../src/index.ts";

/**
 * E7B (contract 2D): one test per case the contract lists for the eligibility engine. Where the platform models the
 * case, the test asserts the engine's behaviour; where it does not, the test asserts the honest non-claim (a person
 * decides, nothing is invented) so a later change that starts guessing fails here.
 */
const KEYS = [
  "structure.free_zone_default", "structure.requested_differs", "structure.free_zone_mainland_sales", "structure.mainland_onshore", "structure.holding", "structure.offshore_no_visas",
  "structure.financial_regulated", "structure.offshore_no_premises", "structure.offshore_no_onshore_trade", "structure.virtual_assets_regulated", "structure.free_zone_onshore_premises",
  "structure.industrial_licence", "structure.mainland_foreign_ownership", "structure.preferred_excluded", "structure.no_viable_option", "structure.no_viable_place",
  "place.visa_capacity", "place.visa_package", "place.cost_estimate", "place.budget", "place.activity_listed", "place.industrial_facilities", "place.warehouse_facilities",
  "licence.financial", "licence.health", "licence.ecommerce", "obligation.corporate_tax", "obligation.ct_qfzp", "obligation.vat_mandatory", "obligation.vat_basis", "obligation.ubo",
  "crossborder.founder_residence", "crossborder.permanent_establishment", "crossborder.corporate_shareholder",
];
const rules: ScopingRule[] = KEYS.map((key) => ({ key, kind: "structure", statement: key, parameters: {}, sourceUrl: "", confidence: "verified", verifiedBy: "A", verifiedAt: "2026-11-01" }));
const z = (name: string, emirate: string, type: Zone["type"], visaQuota: number, min: number, max: number, activities: string[], extra: Partial<Zone> = {}): Zone => ({
  name, emirate, type, visaQuota, costMinFils: min * 100, costMaxFils: max * 100, timelineDays: 10, activities, sourceUrl: "https://x.gov.ae/", confidence: "verified", ...extra,
});
const zones: Zone[] = [
  z("IFZA", "Dubai", "free_zone", 1, 12_000, 20_000, ["consulting", "tech"], { facilities: ["office"], activitiesListed: ["tech"], activitiesListedConfidence: "verified", visaMax: 6 }),
  z("KEZAD", "Abu Dhabi", "free_zone", 3, 18_000, 40_000, ["manufacturing"], { facilities: ["office", "warehouse", "industrial"], visaMax: 50 }),
  z("SHAMS", "Sharjah", "free_zone", 1, 6_000, 12_000, ["consulting", "tech"], { visaMax: 3 }),
  z("Dubai DET mainland", "Dubai", "mainland", 2, 15_000, 35_000, ["trading", "food", "health"]),
  z("RAK ICC", "Ras Al Khaimah", "offshore", 0, 8_000, 15_000, ["holding"], { visaMax: 0 }),
  z("DIFC", "Dubai", "financial", 2, 30_000, 60_000, ["finance", "holding"]),
];
const run = (x: Partial<AdviceInput>) => advise({ mode: "new_company", emirate: "Dubai", ...x }, rules, zones, "2026-11-03");
const texts = (a: ReturnType<typeof advise>) => [...a.structure.reasons, ...a.licences, ...a.obligations, ...(a.crossBorder ?? [])].map((r) => r.text).join(" ");
const place = (a: ReturnType<typeof advise>, name: string) => [...a.places, ...(a.excluded ?? [])].find((p) => p.zone === name)!;
const findingOn = (a: ReturnType<typeof advise>, name: string, key: string) => place(a, name).findings!.find((f) => f.ruleKey === key);

describe("engine cases the contract lists (E7B, 2D)", () => {
  it("activity-specific permission: a sector tag never passes an activity; only the authority's own list does, at its evidence's confidence", () => {
    const a = run({ activity: "tech", customers: "international", visas: 1 });
    expect(findingOn(a, "IFZA", "place.activity_listed")).toMatchObject({ outcome: "pass", confidence: "verified" });
    // SHAMS is "known for" tech but has no activity list on record: the activity stays to confirm, never a pass.
    expect(findingOn(a, "SHAMS", "place.activity_listed")).toMatchObject({ outcome: "unknown" });
    expect(findingOn(a, "SHAMS", "place.activity_listed")!.text).toMatch(/confirm/i);
    // Exact licence activities (E7B `activity_codes`) are recorded for the verifier and shown; the engine still
    // confirms the group only, and says the exact activity is confirmed at scoping (D86).
    expect(texts(a)).not.toMatch(/exact activity .* (is|are) permitted/i);
  });

  it("multiple activities needing separate approvals: one activity is assessed, the rest is a person's call", () => {
    const a = run({ activity: "finance", customers: "both", visas: 2, description: "Payments platform that also trades goods and runs a clinic" });
    expect(a.structure.recommendation === null || ["difc_adgm", "mainland", "free_zone"].includes(a.structure.recommendation!)).toBe(true);
    expect(a.licences.some((l) => l.ruleKey === "licence.financial")).toBe(true);
    // Nothing in the advice claims the second and third activities are covered.
    expect(texts(a)).not.toMatch(/clinic|goods/i);
  });

  it("mainland access from a free zone is a condition, never a promise; selling onshore points to the mainland", () => {
    const a = run({ activity: "tech", customers: "both", visas: 1, jurisdiction: "free_zone" });
    expect(texts(a)).toMatch(/distributor|dual licence|branch|arrangement|mainland/i);
    expect(a.structures!.find((s) => s.structure === "free_zone")!.findings.some((f) => f.ruleKey === "structure.free_zone_mainland_sales" && f.outcome === "condition")).toBe(true);
  });

  it("residency requirements are never asserted as met: an owner abroad is a cross-border point for a specialist", () => {
    const a = run({ activity: "consulting", customers: "international", visas: 0, foreignTaxResident: true });
    expect(a.crossBorder!.some((c) => c.ruleKey === "crossborder.founder_residence")).toBe(true);
    expect(texts(a)).not.toMatch(/you (are|will be) tax resident in the UAE/i);
  });

  it("office and industrial space: a place with no facilities on record says the data is missing; one with them passes or is excluded", () => {
    const a = run({ activity: "manufacturing", customers: "both", visas: 3, premises: "industrial" });
    // A place with industrial facilities on record raises no industrial finding (it passes silently) and stays open.
    expect(findingOn(a, "KEZAD", "place.industrial_facilities")).toBeUndefined();
    expect(place(a, "KEZAD").status).not.toBe("INELIGIBLE");
    expect(findingOn(a, "IFZA", "place.industrial_facilities")).toMatchObject({ outcome: "fail" });
    expect(place(a, "Dubai DET mainland").status).toBe("DATA_UNAVAILABLE");
  });

  it("visa limits: beyond a place's ceiling excludes it; beyond the package only costs more", () => {
    const a = run({ activity: "tech", customers: "international", visas: 5 });
    expect(place(a, "SHAMS").status).toBe("INELIGIBLE");
    expect(findingOn(a, "IFZA", "place.visa_package")).toMatchObject({ outcome: "condition" });
    expect(place(a, "IFZA").status).toBe("ELIGIBLE_CONDITIONAL");
  });

  it("banking readiness is never promised: no statement says an account will open", () => {
    const a = run({ activity: "ecommerce", customers: "international", visas: 1 });
    expect(texts(a)).not.toMatch(/bank account (will|is) (be )?open/i);
    expect(texts(a)).not.toMatch(/guarantee/i);
  });

  it("a corporate shareholder brings a specialist review and document points, not a conclusion", () => {
    const a = run({ activity: "tech", customers: "international", visas: 1, ownerType: "company" });
    expect(a.crossBorder!.some((c) => c.ruleKey === "crossborder.corporate_shareholder")).toBe(true);
    expect(a.structure.recommendation).toBe("free_zone");
  });

  it("holding plus operating structures are not modelled: one entity is assessed and the combination is for a person", () => {
    const a = run({ activity: "holding", customers: "international", visas: 2, description: "Holding company above an operating trading company" });
    expect((a.missingFacts ?? []).length + a.structure.reasons.length).toBeGreaterThan(0);
    expect(texts(a)).not.toMatch(/two (companies|entities)|group structure is (fine|approved)/i);
    expect(a.structure.recommendation).not.toBe("offshore"); // visas rule out offshore for the holding vehicle
  });

  it("tax residency concerns are flagged, never decided", () => {
    const a = run({ activity: "consulting", customers: "international", visas: 1, foreignTaxResident: true });
    expect(texts(a)).toMatch(/management and control|tax resident abroad|permanent establishment/i);
    expect(texts(a)).not.toMatch(/is (not )?taxable in/i);
  });

  it("regulated activities: a generic free zone is excluded for finance and virtual assets; the regulator is a condition", () => {
    const fin = run({ activity: "finance", customers: "international", visas: 2 });
    expect(place(fin, "IFZA").status).toBe("INELIGIBLE");
    expect(place(fin, "DIFC").status).not.toBe("INELIGIBLE");
    expect(fin.licences.some((l) => l.ruleKey === "licence.financial")).toBe(true);
    const va = run({ activity: "virtual_assets", customers: "international", visas: 2 });
    expect(texts(va)).toMatch(/VARA|FSRA|DFSA|SCA/);
    expect([...va.structures!].find((s) => s.structure === "offshore")!.status).toBe("INELIGIBLE");
  });

  it("legal forms within one jurisdiction are on record for the verifier but never decide eligibility", () => {
    const a = run({ activity: "tech", customers: "international", visas: 1 });
    expect(JSON.stringify(a)).not.toMatch(/FZCO|FZE|LLC\b/);
    expect(place(a, "IFZA").status).not.toBe("INELIGIBLE");
  });

  it("a renewal is the services mode, not a fresh entity: no structure is recommended and the obligations are listed", () => {
    const a = advise({ mode: "services", emirate: "Dubai", expectedTurnoverAed: 1_000_000 }, rules, zones, "2026-11-03");
    expect(a.structure.recommendation).toBeNull();
    expect(a.places).toEqual([]);
    expect(a.obligations.length).toBeGreaterThan(0);
  });
});

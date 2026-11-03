import { describe, expect, it } from "vitest";
import { advise, GUIDE_FORBIDDEN, GUIDES, publicView, selectGuides, type ScopingRule, type Zone } from "../src/index.ts";

/**
 * E7A: general guidance is educational wording with no figure, rate, fee or statutory conclusion; its selection is
 * deterministic and reads the answers only. The public view carries a place's source link and facilities only when
 * the place is approved for display.
 */
describe("general guidance (E7A)", () => {
  it("every note is figure-free and never states a statutory conclusion", () => {
    expect(GUIDES.length).toBeGreaterThan(10);
    for (const g of GUIDES) {
      expect(`${g.title} ${g.text}`, g.id).not.toMatch(GUIDE_FORBIDDEN);
      expect(g.text.length, g.id).toBeGreaterThan(120);
      expect(`${g.title} ${g.text}`, g.id).not.toMatch(/margin|partner cost|payout|rate card|commission/i);
    }
    expect(new Set(GUIDES.map((g) => g.id)).size).toBe(GUIDES.length);
  });

  it("selects by the answers and the structures still open, deterministically, and always explains the labels", () => {
    const a = selectGuides({ activity: "manufacturing", customers: "both", visas: 3, ownerType: "company", foreignTaxResident: true, recommendation: null, structuresOpen: ["free_zone", "mainland"] });
    expect(a.map((g) => g.id)).toEqual(["reading.labels", "structure.free_zone", "structure.mainland", "industry.manufacturing", "situation.uae_customers", "situation.visas", "situation.corporate_shareholder", "situation.foreign_tax_resident", "situation.tax", "situation.banking"]);
    expect(selectGuides({ activity: "manufacturing", customers: "both", visas: 3, ownerType: "company", foreignTaxResident: true, recommendation: null, structuresOpen: ["free_zone", "mainland"] })).toEqual(a);
    // A confirmed recommendation narrows the structure notes to that one; a holding company gets no banking note.
    const h = selectGuides({ activity: "holding", visas: 0, ownerType: "individuals", recommendation: "offshore", structuresOpen: ["offshore", "free_zone"] });
    expect(h.map((g) => g.id)).toEqual(["reading.labels", "structure.offshore", "industry.holding", "situation.tax"]);
    // Virtual assets read the regulated-finance note; an activity without a note gets the general ones only.
    expect(selectGuides({ activity: "virtual_assets", visas: 0 }).map((g) => g.id)).toContain("industry.finance");
    expect(selectGuides({ activity: "other", visas: 0 }).map((g) => g.id)).toEqual(["reading.labels", "situation.tax", "situation.banking"]);
  });

  it("the public view carries a place's official source and facilities only when the place is approved", () => {
    const rules: ScopingRule[] = ["structure.free_zone_default", "place.cost_estimate", "place.visa_package"].map((key) => ({ key, kind: "structure", statement: key, parameters: {}, sourceUrl: "", confidence: "verified", verifiedBy: "A", verifiedAt: "2026-11-01" }));
    const zones: Zone[] = [
      { name: "IFZA", emirate: "Dubai", type: "free_zone", visaQuota: 1, costMinFils: 1_200_000, costMaxFils: 2_000_000, timelineDays: 10, activities: ["tech"], sourceUrl: "https://ifza.com/", confidence: "verified", facilities: ["office"] },
      { name: "SHAMS", emirate: "Sharjah", type: "free_zone", visaQuota: 1, costMinFils: 600_000, costMaxFils: 900_000, timelineDays: 7, activities: ["tech"], sourceUrl: "https://shams.ae/", confidence: "verified" },
    ];
    const a = advise({ mode: "new_company", emirate: "Dubai", activity: "tech", customers: "international", visas: 1 }, rules, zones, "2026-05-01");
    expect(a.places.find((p) => p.zone === "IFZA")).toMatchObject({ sourceUrl: "https://ifza.com/", facilities: ["office"] });
    const none = publicView(a, new Set(), new Set(), "2026-05-01");
    expect(JSON.stringify(none)).not.toMatch(/ifza\.com|shams\.ae|facilities|sourceUrl/);
    const one = publicView(a, new Set(), new Set(["IFZA"]), "2026-05-01");
    expect(one.places.find((p) => p.zone === "IFZA")).toMatchObject({ sourceUrl: "https://ifza.com/", facilities: ["office"] });
    expect(JSON.stringify(one.places.filter((p) => p.zone !== "IFZA"))).not.toMatch(/shams\.ae|facilities/);
  });
});

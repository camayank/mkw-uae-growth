import { describe, expect, it } from "vitest";
import { defaultNextVerification, effectiveConfidence, namesPlace, parseFactValue, assessPlace, assessStructure, Rulebook, type Zone } from "../src/index.ts";

describe("catalogue evidence (E2)", () => {
  it("parses money as integer fils, never floating point, and refuses what is not evidence", () => {
    expect(parseFactValue("place", "cost", "12,000 - 20,000")).toEqual({ ok: true, value: { minFils: 1_200_000, maxFils: 2_000_000 } });
    expect(parseFactValue("place", "cost", "AED 9999.99")).toEqual({ ok: true, value: { minFils: 999_999, maxFils: 999_999 } });
    expect(parseFactValue("place", "renewal_cost", "8000 to 11000.5")).toEqual({ ok: true, value: { minFils: 800_000, maxFils: 1_100_050 } });
    expect(parseFactValue("place", "cost", "20000-12000").ok).toBe(false);
    expect(parseFactValue("place", "cost", "0").ok).toBe(false);
    expect(parseFactValue("place", "cost", "1.234").ok).toBe(false);
  });

  it("parses lists, numbers and coordinates, and rejects anything outside the UAE or the known vocabulary", () => {
    expect(parseFactValue("place", "facilities", "Warehouse; office, office")).toEqual({ ok: true, value: ["office", "warehouse"] });
    expect(parseFactValue("place", "facilities", "spaceport").ok).toBe(false);
    expect(parseFactValue("place", "activities_listed", "Virtual assets; tech")).toEqual({ ok: true, value: ["tech", "virtual_assets"] });
    expect(parseFactValue("place", "visa_max", "no limit")).toEqual({ ok: true, value: null });
    expect(parseFactValue("place", "timeline_days", "0").ok).toBe(false);
    expect(parseFactValue("place", "coordinates", "25.2048, 55.2708")).toEqual({ ok: true, value: { lat: 25.2048, lng: 55.2708 } });
    expect(parseFactValue("place", "coordinates", "51.5, -0.12").ok).toBe(false); // London is not a UAE place
    expect(parseFactValue("authority", "website", "javascript:alert(1)").ok).toBe(false);
    expect(parseFactValue("place", "colour", "blue").ok).toBe(false);
    expect(parseFactValue("rule", "rule", "x").ok).toBe(false);
  });

  it("stale evidence drops one level; UNCERTAIN stays UNCERTAIN; the default period is 180 days", () => {
    expect(effectiveConfidence("verified", "2026-11-01", "2026-11-02")).toEqual({ confidence: "rule_of_thumb", stale: true });
    expect(effectiveConfidence("rule_of_thumb", "2026-11-01", "2026-11-02")).toEqual({ confidence: "UNCERTAIN", stale: true });
    expect(effectiveConfidence("verified", "2026-11-02", "2026-11-02")).toEqual({ confidence: "verified", stale: false });
    expect(effectiveConfidence("UNCERTAIN", "2020-01-01", "2026-11-02")).toEqual({ confidence: "UNCERTAIN", stale: false });
    expect(defaultNextVerification("2026-11-02")).toBe("2027-05-01");
  });

  it("a place is named by its name, its authority or an alias, whatever the case and punctuation", () => {
    const z = { name: "SHAMS", authority: "Sharjah Media City", aliases: ["Sharjah Media City Free Zone"] };
    expect(namesPlace(z, "shams")).toBe(true);
    expect(namesPlace(z, "Sharjah  media-city")).toBe(true);
    expect(namesPlace(z, "Sharjah Media City Free Zone")).toBe(true);
    expect(namesPlace(z, "Sharjah")).toBe(false);
    expect(namesPlace(z, "")).toBe(false);
  });

  it("an activity on the place's list passes at the weaker of the rule and that evidence; a missing one stays a check", () => {
    const rules = [{ key: "place.activity_listed", kind: "zone" as const, statement: "", parameters: {}, sourceUrl: "", confidence: "verified" as const }];
    const book = new Rulebook(rules);
    const z: Zone = {
      name: "X", emirate: "Dubai", type: "free_zone", visaQuota: 1, costMinFils: 1, costMaxFils: 2, timelineDays: 5, activities: [], sourceUrl: "", confidence: "UNCERTAIN",
      activitiesListed: ["tech"],
      evidence: { activities_listed: { field: "activities_listed", recorded: "verified", confidence: "verified", stale: false, evidenceDate: "2026-10-01", nextVerification: "2027-04-01", verifiedBy: "A", sourceUrl: "https://x.ae", factId: 1 } },
    };
    const a = { mode: "new_company" as const, emirate: "Dubai", activity: "tech" as const };
    const tech = assessPlace(z, assessStructure("free_zone", a, book), a, book).findings.find((f) => f.ruleKey === "place.activity_listed")!;
    expect(tech).toMatchObject({ outcome: "pass", confidence: "verified" });
    const b = { ...a, activity: "trading" as const };
    const trading = assessPlace(z, assessStructure("free_zone", b, book), b, book).findings.find((f) => f.ruleKey === "place.activity_listed")!;
    expect(trading).toMatchObject({ outcome: "unknown", missing: "check" });
  });
});

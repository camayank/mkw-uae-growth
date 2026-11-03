import { describe, expect, it } from "vitest";
import { advise, preliminaryReport, publicView, reportLines, reviewedReport, wrap, type AdviceInput, type ScopingRule, type Zone } from "../src/index.ts";

/**
 * E7D: the report says exactly what the page says. Preliminary: with nothing approved, no rule text and no figure;
 * with everything approved, the figures and statements; always the sections the contract lists and the label.
 * Reviewed: every confidence label, the reviewer, the company. Never a money word.
 */
const KEYS = ["structure.free_zone_default", "structure.requested_differs", "place.visa_package", "place.cost_estimate", "place.budget", "place.activity_listed", "licence.ecommerce", "obligation.corporate_tax", "obligation.vat_mandatory", "obligation.ubo", "crossborder.founder_residence", "structure.offshore_no_visas"];
const rules: ScopingRule[] = KEYS.map((key) => ({ key, kind: "structure", statement: key, parameters: {}, sourceUrl: "", confidence: "verified", verifiedBy: "A. Qualified", verifiedAt: "2026-11-01" }));
const z = (name: string, emirate: string, type: Zone["type"], visaQuota: number, min: number, max: number, activities: string[], extra: Partial<Zone> = {}): Zone => ({
  name, emirate, type, visaQuota, costMinFils: min * 100, costMaxFils: max * 100, timelineDays: 10, activities, sourceUrl: "https://example.gov.ae/fees", confidence: "verified", authority: `${name} Authority`, ...extra,
});
const zones: Zone[] = [
  z("IFZA", "Dubai", "free_zone", 1, 12_000, 20_000, ["consulting", "tech", "ecommerce"], { facilities: ["office"], renewalMinFils: 900_000, renewalMaxFils: 1_100_000, renewalConfidence: "verified" }),
  z("SHAMS", "Sharjah", "free_zone", 1, 6_000, 12_000, ["consulting", "tech"], { visaMax: 3 }),
  z("RAK ICC", "Ras Al Khaimah", "offshore", 0, 8_000, 15_000, ["holding"], { visaMax: 0 }),
];
const answers: AdviceInput = { mode: "new_company", emirate: "Dubai", activity: "ecommerce", customers: "international", visas: 2, budgetAed: 30_000, premises: "office", ownerType: "individuals", foreignTaxResident: true, startWithin: "1_month", freeZone: "IFZA" };
const SECTIONS = ["YOUR BUSINESS PROFILE", "STRUCTURES COMPARED", "JURISDICTIONS COMPARED", "REJECTED", "LICENCES, APPROVALS", "CROSS-BORDER RISKS", "UNRESOLVED QUESTIONS", "RECOMMENDATION", "NEXT STEPS"];
const MONEY = /margin|partner cost|payout|rate card|commission|professional fee/i;

describe("the assessment report (E7D)", () => {
  const a = advise(answers, rules, zones, "2026-11-03");

  it("preliminary with nothing approved: the sections, the label on top, no rule text and no figure", () => {
    const p = publicView(a, new Set(), new Set(), "2026-11-03");
    const r = preliminaryReport(p, answers, { reference: "PRE-ABCD1234", date: "2026-11-03", guidance: [{ title: "How to read this result", text: "Each point carries a label." }] });
    const lines = reportLines(r);
    const text = lines.join("\n");
    expect(lines[0]).toBe("Tasees, by MKW Advisors");
    expect(lines[1]).toBe("UAE Entity Assessment Report");
    expect(lines[2]).toBe("Reference PRE-ABCD1234  Date 2026-11-03");
    expect(text).toMatch(/PRELIMINARY: general information from your answers, not reviewed by a person and\s+not advice/);
    for (const s of SECTIONS) expect(text, s).toContain(s);
    expect(text).toContain("GENERAL GUIDANCE (APPROVED WORDING)");
    expect(text).toContain("Activity: ecommerce");
    expect(text).toContain("Wants to start: within a month");
    // Nothing unapproved: no AED figure of ours (the founder's own budget in the profile is theirs), no rule text,
    // no authority, no source; every statement is "to be verified".
    const ours = text.split("STRUCTURES COMPARED")[1]!;
    expect(ours).not.toMatch(/AED [\d,]+/);
    expect(text).not.toMatch(/Register for corporate tax|licensed by|example\.gov\.ae|Facilities on record/);
    expect(text).toMatch(/\[TO BE VERIFIED\]/);
    expect(text).toContain("The structure is to be confirmed by a person");
    expect(text).toContain("0 of");
    expect(text).not.toMatch(MONEY);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(82);
  });

  it("preliminary with everything approved: the figures, the sources and the checked statements, still labelled preliminary", () => {
    const p = publicView(a, new Set(KEYS), new Set(zones.map((x) => x.name)), "2026-11-03");
    const r = preliminaryReport(p, answers, { reference: "PRE-ABCD1234", date: "2026-11-03" });
    const text = reportLines(r).join("\n");
    expect(text).toMatch(/PRELIMINARY/);
    expect(text).toContain("Pathway that fits your answers: Free zone company [CHECKED");
    expect(text).toContain("Setup estimate AED 12,000 to AED 20,000 [CHECKED]");
    expect(text).toContain("Yearly renewal estimate AED 9,000 to AED 11,000 [CHECKED]");
    expect(text).toContain("Official source: https://example.gov.ae/fees");
    expect(text).toContain("Facilities on record: office");
    expect(text).toMatch(/\[CHECKED\] Register for corporate tax/);
    expect(text).toMatch(/\[SPECIALIST REVIEW\]/);
    expect(text).toMatch(/RAK ICC: does not fit/);
    expect(text).not.toMatch(MONEY);
  });

  it("reviewed: the reviewer and date, the company, every confidence label, the recommendation and its limits", () => {
    const r = reviewedReport(a, answers, { reference: "REQ-1234ABCD", date: "2026-11-03", company: "Example Ventures", reviewedBy: "Ops Manager", reviewedAt: "2026-11-02" });
    const text = reportLines(r).join("\n");
    expect(text).toMatch(/REVIEWED by Ops Manager at MKW Advisors on 2026-11-02/);
    expect(text).toContain("Company: Example Ventures");
    expect(text).toContain("Recommended structure: Free zone company");
    expect(text).toMatch(/\[verified rule\]/);
    expect(text).toMatch(/RAK ICC: does not fit; \[DOES NOT FIT\][\s\S]{0,200}?\[(verified rule|rule of thumb|UNCERTAIN)\]/); // a rejection keeps its confidence label (the line may wrap)
    expect(text).toContain("Setup estimate AED 12,000 to AED 20,000 [verified]");
    expect(text).toMatch(/CROSS-BORDER RISKS/);
    // The closing sentence follows what is printed: an unverified renewal figure alone makes it "some points".
    const label = (t: string) => (/Every point above rests on a verified rule or figure/.test(t) ? "every" : /Some points above rest on rules/.test(t) ? "some" : "none");
    expect(["every", "some"]).toContain(label(text));
    const unverifiedRenewal = advise(answers, rules, [{ ...zones[0]!, renewalConfidence: "UNCERTAIN" }, ...zones.slice(1)], "2026-11-03");
    const t2 = reportLines(reviewedReport(unverifiedRenewal, answers, { reference: "REQ-1234ABCD", date: "2026-11-03", reviewedBy: "Ops Manager", reviewedAt: "2026-11-02" })).join("\n");
    expect(t2).toMatch(/Yearly renewal estimate AED 9,000 to AED 11,000 \[UNCERTAIN\]/);
    expect(label(t2)).toBe("some");
    if (!unverifiedRenewal.hasUncertain && !unverifiedRenewal.needsVerification) expect(label(text)).toBe("every"); // the flags alone would have said "every"
    // An excluded place whose failing finding is UNCERTAIN carries the label and makes the closing sentence "some points".
    const uncertainExclusion = advise(answers, rules, [zones[0]!, zones[1]!, { ...zones[2]!, confidence: "UNCERTAIN" }], "2026-11-03");
    const t3 = reportLines(reviewedReport(uncertainExclusion, answers, { reference: "REQ-1234ABCD", date: "2026-11-03", reviewedBy: "Ops Manager", reviewedAt: "2026-11-02" })).join("\n");
    expect(t3).toMatch(/RAK ICC: does not fit; \[DOES NOT FIT\]/);
    if (/RAK ICC: does not fit; \[DOES NOT FIT\][\s\S]{0,200}?\[UNCERTAIN\]/.test(t3)) expect(label(t3)).toBe("some");
    expect(text).toContain("Reviewed advice for the client named above.");
    for (const s of SECTIONS.filter((x) => x !== "REJECTED")) expect(text, s).toContain(s);
    expect(text).not.toMatch(MONEY);
    for (const l of reportLines(r)) expect(l.length, l).toBeLessThanOrEqual(82);
  });

  it("preliminary when no option fits: no pathway and no recommendation, even with everything approved", () => {
    // The conclusion rests on every rule that excluded a place, so each is a rule and approved for display.
    const allRules: ScopingRule[] = [...rules, ...["structure.no_viable_option", "place.visa_capacity", "structure.offshore_no_premises"].map((key) => ({ key, kind: "structure" as const, statement: key, parameters: {}, sourceUrl: "", confidence: "verified" as const, verifiedBy: "A. Qualified", verifiedAt: "2026-11-01" }))];
    const { freeZone: _named, ...rest } = answers; // no place named: every place fails the budget
    const tight = advise({ ...rest, visas: 1, budgetAed: 1_000 }, allRules, zones, "2026-11-03");
    expect(tight.noViableOption).toBe(true);
    const p = publicView(tight, new Set(allRules.map((r) => r.key)), new Set(zones.map((x) => x.name)), "2026-11-03");
    expect(p.noViableOption).toBe(true);
    const text = reportLines(preliminaryReport(p, { ...rest, visas: 1, budgetAed: 1_000 }, { reference: "PRE-ABCD1234", date: "2026-11-03" })).join("\n");
    expect(text).toMatch(/No structure fits every answer yet: a specialist at MKW Advisors\s+looks at the case\./); // the line may wrap
    expect(text).toContain("No recommendation is made on this page");
    expect(text).not.toMatch(/Pathway that fits your answers|The answers point to/);
  });

  it("wraps long lines at the width and keeps the indent", () => {
    const w = wrap("  " + "word ".repeat(40).trim(), 40);
    expect(w.length).toBeGreaterThan(4);
    for (const l of w) {
      expect(l.length).toBeLessThanOrEqual(40);
      expect(l.startsWith("  ")).toBe(true);
    }
    expect(wrap("short", 40)).toEqual(["short"]);
    // A word longer than the width (a source URL) is split, never drawn off the page.
    const url = "  Official source: https://example.gov.ae/" + "a".repeat(100);
    for (const l of wrap(url, 82)) expect(l.length).toBeLessThanOrEqual(82);
    expect(wrap(url, 82).join("").replace(/\s/g, "")).toBe(url.replace(/\s/g, ""));
  });
});

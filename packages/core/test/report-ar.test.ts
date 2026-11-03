import { describe, expect, it } from "vitest";
import { advise, arabicReport, preliminaryReport, publicView, reviewedReport, type AdviceInput, type Report, type ScopingRule, type Zone } from "../src/index.ts";

/**
 * E16: the report in Arabic. Every line, heading and table cell the report writes itself is in Arabic; what the engine
 * or a person wrote stays as written, marked as a left-to-right island; no figure, place or tag is lost or changed.
 */
const KEYS = ["structure.free_zone_default", "structure.requested_differs", "place.visa_package", "place.cost_estimate", "place.budget", "place.activity_listed", "licence.ecommerce", "obligation.corporate_tax", "obligation.vat_mandatory", "obligation.ubo", "crossborder.founder_residence", "structure.offshore_no_visas"];
const rules: ScopingRule[] = KEYS.map((key) => ({ key, kind: "structure", statement: key, parameters: {}, sourceUrl: "", confidence: "verified", verifiedBy: "A. Qualified", verifiedAt: "2026-11-01" }));
const z = (name: string, emirate: string, type: Zone["type"], visaQuota: number, min: number, max: number, activities: string[], extra: Partial<Zone> = {}): Zone => ({
  name, emirate, type, visaQuota, costMinFils: min * 100, costMaxFils: max * 100, timelineDays: 10, activities, sourceUrl: "https://example.gov.ae/fees", confidence: "verified", authority: `${name} Authority`, ...extra,
});
const zones: Zone[] = [
  z("IFZA", "Dubai", "free_zone", 1, 12_000, 20_000, ["consulting", "tech", "ecommerce"], { facilities: ["office"], renewalMinFils: 900_000, renewalMaxFils: 1_100_000, renewalConfidence: "verified" }),
  z("SHAMS", "Sharjah", "free_zone", 1, 6_000, 12_000, ["consulting", "tech"], { visaMax: 3, confidence: "rule_of_thumb", stale: true }),
  z("RAK ICC", "Ras Al Khaimah", "offshore", 0, 8_000, 15_000, ["holding"], { visaMax: 0 }),
];
const ARABIC = /[؀-ۿ]/;
const ISLAND = /⁦[^⁦⁩]*⁩/g;

/** Everything in the report that is text the report wrote: with the English islands removed, no Latin word is left. */
function leftoverEnglish(r: Report): string[] {
  const all = [r.title, r.brand, r.statusLine, r.closing, ...r.sections.flatMap((s) => [s.heading, ...s.lines, ...(s.table ? [...s.table.columns, ...s.table.rows.flat()] : [])])];
  return all.filter((t) => /[A-Za-z]{2,}/.test(t.replace(ISLAND, "").replace(/MKW Advisors|AED/g, "")));
}

describe("the assessment report in Arabic (E16)", () => {
  const cases: Array<{ name: string; input: AdviceInput }> = [];
  for (const activity of ["ecommerce", "consulting", "holding", "tech"] as const)
    for (const visas of [0, 2, 12]) for (const budgetAed of [null, 1_000, 9_000, 30_000]) for (const foreignTaxResident of [true, false])
      for (const jurisdiction of [undefined, "offshore"] as const) for (const ownerType of ["company", "individuals"] as const)
        cases.push({ name: `${activity}/${visas}/${budgetAed}/${foreignTaxResident}/${jurisdiction}/${ownerType}`, input: { mode: "new_company", emirate: "Dubai", activity, customers: "international", visas, budgetAed, premises: "office", ownerType, foreignTaxResident, startWithin: "3_months", freeZone: "IFZA", ...(jurisdiction ? { jurisdiction } : {}) } });
  // And founders who answered little: the "missing" and "none" sentences.
  cases.push({ name: "bare", input: { mode: "new_company", emirate: "Dubai" } });
  cases.push({ name: "bare-holding", input: { mode: "new_company", emirate: "Sharjah", activity: "holding", visas: 3, jurisdiction: "offshore" } });

  it(`every word the report writes is in Arabic, preliminary and reviewed, with and without approvals (${cases.length} founders)`, () => {
    for (const { name, input } of cases) {
      const a = advise(input, rules, zones, "2026-11-03");
      const reports = [
        preliminaryReport(publicView(a, new Set(), new Set(), "2026-11-03"), input, { reference: "PRE-ABCD1234", date: "2026-11-03", company: "Sample Trading FZ-LLC", guidance: [{ title: "How to read this result", text: "Each point carries a label." }] }),
        preliminaryReport(publicView(a, new Set(KEYS), new Set(zones.map((x) => x.name)), "2026-11-03"), input, { reference: "PRE-ABCD1234", date: "2026-11-03" }),
        reviewedReport(a, input, { reference: "REQ-1234ABCD", date: "2026-11-03", company: "Sample Trading FZ-LLC", reviewedBy: "A. Reviewer", reviewedAt: "2026-11-03" }),
        reviewedReport(a, input, { reference: "REQ-1234ABCD", date: "2026-11-03" }),
      ];
      // What the report may keep in English: text that came from the data (the engine's wording, names, dates,
      // addresses, the founder's answers, guidance), never the report's own template sentences.
      const data = JSON.stringify([a, publicView(a, new Set(KEYS), new Set(zones.map((x) => x.name)), "2026-11-03"), input, zones, "Sample Trading FZ-LLC A. Reviewer 2026-11-03 How to read this result Each point carries a label."]).replace(/_/g, " ");
      for (const en of reports) {
        const ar = arabicReport(en);
        const islands = JSON.stringify(ar).match(/\u2066([^\u2066\u2069]*)\u2069/g)?.map((x) => x.slice(1, -1).replace(/:$/, "")) ?? [];
        // An amount is formatted from data (fils to "AED 12,000"); everything else must appear in the data as it stands.
        for (const i of islands) expect(/^AED [\d,]+$/.test(i) || data.includes(i) || i.split(", ").every((part) => data.includes(part)), `${name}: "${i}" is not data`).toBe(true);
        expect(ar.lang).toBe("ar");
        expect(leftoverEnglish(ar), name).toEqual([]);
        expect(ARABIC.test(ar.statusLine), name).toBe(true);
        // Same shape: every section, line and table cell is still there.
        expect(ar.sections.map((s) => s.lines.length), name).toEqual(en.sections.map((s) => s.lines.length));
        expect(ar.sections.map((s) => s.table?.rows.length ?? 0), name).toEqual(en.sections.map((s) => s.table?.rows.length ?? 0));
        // No figure, place name, address or tag is lost: every number and every URL in English is in the Arabic too.
        const flat = (r: Report) => JSON.stringify(r.sections);
        for (const n of flat(en).match(/\d[\d,]*/g) ?? []) expect(flat(ar), `${name}: ${n}`).toContain(n);
        for (const u of flat(en).match(/https?:\/\/[^\s"\]]+/g) ?? []) expect(flat(ar), `${name}: ${u}`).toContain(u);
        for (const placeName of ["IFZA", "SHAMS", "RAK ICC"]) if (flat(en).includes(placeName)) expect(flat(ar), placeName).toContain(placeName);
        expect((flat(en).match(/\[(CHECKED|TO BE VERIFIED|CONDITION|DOES NOT FIT|TO CONFIRM|PASS)\]/g) ?? []).length, name).toBe((flat(ar).match(/\[(تم التحقق|قيد التحقق|شرط|لا يناسب|للتأكيد|مستوفى)\]/g) ?? []).length);
      }
    }
  });

  it("the report's own wording reads in Arabic, data stays as written", () => {
    const input: AdviceInput = { mode: "new_company", emirate: "Dubai", activity: "ecommerce", visas: 2, budgetAed: 30_000, freeZone: "IFZA" };
    const a = advise(input, rules, zones, "2026-11-03");
    const ar = arabicReport(preliminaryReport(publicView(a, new Set(KEYS), new Set(["IFZA"]), "2026-11-03"), input, { reference: "PRE-ABCD1234", date: "2026-11-03" }));
    expect(ar.title).toBe("تقرير تقييم الكيان في الإمارات");
    expect(ar.sections.map((s) => s.heading)).toContain("مقارنة الجهات");
    const places = ar.sections.find((s) => s.heading === "مقارنة الجهات")!;
    expect(places.table!.columns).toEqual(["الجهة", "الإمارة", "الحالة", "تقدير التأسيس", "التأشيرات", "المدة"]);
    expect(places.table!.rows[0]).toEqual(["⁦IFZA⁩", "⁦Dubai⁩", expect.stringMatching(ARABIC), "من ⁦AED 12,000⁩ إلى ⁦AED 20,000⁩", "1", "نحو 10 يوم عمل"]);
    expect(ar.sections.find((s) => s.heading === "المصادر الرسمية")!.lines).toEqual(["⁦https://example.gov.ae/fees⁩"]);
  });
});

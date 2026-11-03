import { describe, expect, it } from "vitest";
import { arabicReport, type Report } from "@tasees/core";
import { reportInfo, reportPdf } from "../src/lib/report-pdf.ts";

/** E16: the report renderer's edges (independent review of E16): long items flow over pages, odd input never breaks it. */
const base = (sections: Report["sections"], extra: Partial<Report> = {}): Report => ({
  title: "UAE Entity Assessment Report", brand: "Tasees, by MKW Advisors", reference: "PRE-ABCD1234", date: "2026-11-03", status: "preliminary",
  statusLine: "PRELIMINARY: general information from your answers, not reviewed by a person and not advice.", closing: "Preliminary general information, not advice.", lang: "en", sections, ...extra,
});
const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

describe("the report renderer (E16)", () => {
  it("an item longer than a page flows onto the next pages line by line, and every word is drawn", async () => {
    const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const { pdf, text } = await reportPdf(base([{ heading: "Long", lines: [long, `[CHECKED] ${long}`, `  ${long}`] }]));
    expect(pages(pdf)).toBeGreaterThanOrEqual(6);
    const drawn = text.join(" ");
    for (const w of ["word0", "word999", "word1999"]) expect(drawn.split(w).length - 1).toBe(3);
  });

  it("an empty table, an empty section and a report with no section render without error", async () => {
    for (const r of [base([]), base([{ heading: "Empty", lines: [] }]), base([{ heading: "T", lines: ["x"], table: { columns: [], rows: [] } }]), base([{ heading: "T", lines: [], table: { columns: ["A", "B"], rows: [] } }])]) {
      const { pdf } = await reportPdf(r);
      expect(pdf.subarray(0, 7).toString("latin1")).toBe("%PDF-1.");
    }
  });

  it("odd text from data (line breaks, tabs, direction marks, emoji, a long cell) never breaks the layout or the Arabic", async () => {
    const odd = "Sample\nTrading\tFZ⁩-LLC ‮evil 😀 漢字";
    const r = base([
      { heading: "Your business profile", lines: [`Company: ${odd}`] },
      { heading: "Jurisdictions compared", lines: [], table: { columns: ["Place", "Emirate", "Status", "Setup estimate", "Visas", "Timeline"], rows: [["X".repeat(500), "Dubai", "to be verified", "AED 12,000 to AED 20,000", "1", "about 7 working days"]] } },
    ]);
    const en = await reportPdf(r);
    expect(en.text.join(" ")).toContain("AED 12,000 to AED 20,000");
    expect(en.text.join(" ")).not.toMatch(/[\t\n]/);
    const ar = await reportPdf(arabicReport(r));
    expect(ar.text.join(" ")).toContain("الشركة");
    // The data's own direction marks are taken out of the island, so the Arabic around it stays balanced.
    expect(arabicReport(r).sections[0]!.lines[0]).toBe("الشركة: ⁦Sample Trading FZ-LLC evil 😀 漢字⁩");
    // The metadata carries no direction mark.
    const info = reportInfo(arabicReport(base([], { status: "reviewed", statusLine: "REVIEWED by A. Reviewer at MKW Advisors on 2026-11-03." })));
    expect(info.Subject).toBe("تمت المراجعة من A. Reviewer في MKW Advisors بتاريخ 2026-11-03.");
    expect(JSON.stringify(info)).not.toMatch(/[\u2066-\u2069]/);
  });
});

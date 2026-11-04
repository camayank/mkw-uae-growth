import { describe, expect, it } from "vitest";
import { feeBasis, feeDisclosure, feeDisclosures, feeLabel, feeNeedsReview, FEE_BASES } from "../src/fee-disclosure.ts";

/** E18: one source of truth for what a client is told about a government fee. */
describe("government fee disclosure (E18)", () => {
  it("the basis follows MKW's record at quotation: none is partner-stated, unverified is uncertain, old is stale", () => {
    expect(feeBasis(undefined)).toBe("partner_stated");
    expect(feeBasis({ confidence: "UNCERTAIN", stale: false })).toBe("uncertain");
    expect(feeBasis({ confidence: "verified", stale: true })).toBe("stale");
    expect(feeBasis({ confidence: "verified", stale: false })).toBe("verified");
  });

  it("only uncertain and stale fees need an acknowledgement (the existing rule; D100 recommends partner-stated too)", () => {
    expect(FEE_BASES.filter(feeNeedsReview)).toEqual(["uncertain", "stale"]);
  });

  it("each basis has its label, and a line with no recorded basis is LEGACY, never verified", () => {
    expect([...FEE_BASES, null].map(feeLabel)).toEqual(["VERIFIED", "PARTNER-STATED", "UNCERTAIN", "STALE", "LEGACY"]);
    expect(feeDisclosure("X", 100, { basis: null })).toMatchObject({ label: "LEGACY", confirmed: false });
  });

  it("only VERIFIED is confirmed; every sentence says the actual fee is paid at cost and carries no internal word", () => {
    for (const basis of [...FEE_BASES, null]) {
      const d = feeDisclosure("X", 100, { basis, verifiedAt: "2026-10-01" })!;
      expect(d.confirmed).toBe(basis === "verified");
      expect(d.text).toMatch(/actual fee, at cost\.$/);
      expect(d.text).not.toMatch(/UNCERTAIN|review|ops|margin|partner cost|cost price/);
      if (basis !== "verified") expect(d.text).toMatch(/^Estimate/);
    }
    expect(feeDisclosure("X", 100, { basis: "verified", verifiedAt: "2026-10-01" })!.text).toContain("verified on 2026-10-01");
    expect(feeDisclosure("X", 100, { basis: "stale", verifiedAt: "2026-06-01" })!.text).toContain("last verified this fee on 2026-06-01");
  });

  it("a line without a government fee has nothing to disclose", () => {
    expect(feeDisclosure("X", 0, { basis: "partner_stated" })).toBeNull();
    // An unverified or stale "no fee" is still a statement about the authority, so it is disclosed (E18 review).
    expect(feeDisclosure("X", 0, { basis: "uncertain" })).toMatchObject({ label: "UNCERTAIN", confirmed: false });
    expect(feeDisclosure("X", 0, { basis: "stale", verifiedAt: "2026-06-01" })).toMatchObject({ label: "STALE" });
    expect(feeDisclosures([{ code: "A", govUnitFee: 0, basis: "verified" }, { code: "B", govUnitFee: 5, basis: "uncertain" }]).map((d) => d.code)).toEqual(["B"]);
  });
});

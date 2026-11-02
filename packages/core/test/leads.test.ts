import { describe, expect, it } from "vitest";
import { cleanAttribution, scoreLead, type AdviceInput } from "../src/index.ts";

const base = (x: Partial<AdviceInput>): AdviceInput => ({ mode: "new_company", emirate: "Dubai", ...x });

describe("lead scores and segments (E4)", () => {
  it("are deterministic, bounded and explained", () => {
    const a = base({ activity: "finance", customers: "both", visas: 8, premises: "retail", budgetAed: 100_000, foreignTaxResident: true, ownerType: "company", freeZone: "DIFC" });
    const s1 = scoreLead(a, { phoneGiven: true, consultationRequested: true, recovered: 2, contradictions: 1, missingFacts: 3, noViableOption: true });
    const s2 = scoreLead(a, { phoneGiven: true, consultationRequested: true, recovered: 2, contradictions: 1, missingFacts: 3, noViableOption: true });
    expect(s1).toEqual(s2);
    expect(s1.complexity).toBe(100);
    expect(s1.intent).toBe(95);
    expect(s1.segment).toBe("regulated");
    expect(s1.highIntent).toBe(true);
    expect(s1.factors).toEqual(expect.arrayContaining(["regulated activity", "owner tax resident abroad", "asked for a call"]));
    const none = scoreLead(base({}));
    expect(none).toMatchObject({ complexity: 10, intent: 10, segment: "starter", highIntent: false, factors: [] });
  });

  it("rise with the facts that should raise them and never fall because of them", () => {
    const plain = base({ activity: "consulting", customers: "international", visas: 1 });
    const s0 = scoreLead(plain);
    expect(scoreLead({ ...plain, budgetAed: 20_000 }).intent).toBeGreaterThan(s0.intent);
    expect(scoreLead({ ...plain, freeZone: "IFZA" }).intent).toBeGreaterThan(s0.intent);
    expect(scoreLead(plain, { consultationRequested: true }).intent).toBeGreaterThan(s0.intent);
    expect(scoreLead(plain, { recovered: 1 }).intent).toBeGreaterThan(s0.intent);
    expect(scoreLead({ ...plain, foreignTaxResident: true }).complexity).toBeGreaterThan(s0.complexity);
    expect(scoreLead({ ...plain, visas: 12 }).complexity).toBeGreaterThan(s0.complexity);
    expect(scoreLead(plain, { contradictions: 2 }).complexity).toBeGreaterThan(s0.complexity);
    expect(scoreLead({ ...plain, budgetAed: 20_000 }).complexity).toBe(s0.complexity);
  });

  it("segments by what a person must check first", () => {
    expect(scoreLead(base({ activity: "consulting", customers: "international", visas: 1 })).segment).toBe("starter");
    expect(scoreLead(base({ activity: "trading", customers: "both", visas: 4, premises: "warehouse" })).segment).toBe("standard");
    expect(scoreLead(base({ activity: "manufacturing", customers: "both", visas: 10, premises: "industrial" }), { missingFacts: 4 }).segment).toBe("complex");
    expect(scoreLead(base({ activity: "health", customers: "uae_mainland", visas: 2 })).segment).toBe("regulated");
    expect(scoreLead(base({ activity: "tech", customers: "international", visas: 1, foreignTaxResident: true })).segment).toBe("cross_border");
    expect(scoreLead(base({ activity: "tech", customers: "international", visas: 1, ownerType: "company" })).segment).toBe("standard"); // a corporate owner adds complexity, not a border
    // Regulated wins over cross-border: the regulator's approval is the first thing to check.
    expect(scoreLead(base({ activity: "finance", foreignTaxResident: true })).segment).toBe("regulated");
  });

  it("take no commercial input", () => {
    const a = base({ activity: "tech", customers: "international", visas: 2 });
    const withTerms = { ...a, partnerCostFils: 1_000_000, marginBp: 2_500, commissionBp: 500 } as AdviceInput;
    expect(scoreLead(withTerms)).toEqual(scoreLead(a));
    expect(JSON.stringify(scoreLead(withTerms))).not.toMatch(/partner|margin|commission/i);
  });

  it("keeps attribution to its known fields, trimmed and bounded", () => {
    const c = cleanAttribution({ utm_source: " google ", utm_campaign: "x".repeat(200), referrer: "https://example.test/page?code=ABCDE23456", landing: "/selector.html?code=ABCDE23456&utm_source=google", password: "secret", email: "a@b.c" });
    // A recovery code is never kept: it is a capability to read the saved answers.
    expect(c).toEqual({ source: "google", medium: null, campaign: "x".repeat(80), term: null, content: null, referrer: "https://example.test/page", landing: "/selector.html?utm_source=google" });
    expect(cleanAttribution({ landing: "/selector.html?utm_source=x&code=ABCDE23456" }).landing).toBe("/selector.html?utm_source=x");
    expect(cleanAttribution({ landing: "/selector.html?code=ABCDE23456" }).landing).toBe("/selector.html");
    expect(JSON.stringify(c)).not.toMatch(/secret|a@b\.c/);
    expect(cleanAttribution(null)).toMatchObject({ source: null, campaign: null });
  });
});

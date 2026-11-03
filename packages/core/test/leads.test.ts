import { describe, expect, it } from "vitest";
import { cleanAttribution, nextBestAction, SCORE_BASE, scoreLead, type AdviceInput, type LeadState } from "../src/index.ts";

const base = (x: Partial<AdviceInput>): AdviceInput => ({ mode: "new_company", emirate: "Dubai", ...x });

describe("lead scores and segments (E4)", () => {
  it("are deterministic, bounded and explained", () => {
    const a = base({ activity: "finance", customers: "both", visas: 8, premises: "retail", budgetAed: 100_000, foreignTaxResident: true, ownerType: "company", freeZone: "DIFC" });
    const s1 = scoreLead(a, { phoneGiven: true, consultationRequested: true, recovered: 2, contradictions: 1, missingFacts: 3, noViableOption: true });
    const s2 = scoreLead(a, { phoneGiven: true, consultationRequested: true, recovered: 2, contradictions: 1, missingFacts: 3, noViableOption: true });
    expect(s1).toEqual(s2);
    expect(s1.complexity).toBe(100);
    expect(s1.intent).toBe(100); // E7C added "a clear activity"
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
    expect(c).toEqual({ source: "google", medium: null, campaign: "x".repeat(80), term: null, content: null, referrer: "https://example.test/page", landing: "/selector.html?utm_source=google", visitor: null });
    expect(cleanAttribution({ visitor: "v1abcdefghij" }).visitor).toBe("v1abcdefghij");
    expect(cleanAttribution({ visitor: "bad id!" }).visitor).toBeNull();
    expect(cleanAttribution({ landing: "/selector.html?utm_source=x&code=ABCDE23456" }).landing).toBe("/selector.html?utm_source=x");
    expect(cleanAttribution({ landing: "/selector.html?code=ABCDE23456" }).landing).toBe("/selector.html");
    expect(JSON.stringify(c)).not.toMatch(/secret|a@b\.c/);
    expect(cleanAttribution(null)).toMatchObject({ source: null, campaign: null });
  });
});

describe("lead scores with evidence and the next best action (E7C)", () => {
  const base = { mode: "new_company" as const, emirate: "Dubai" };
  it("each score is its base plus the points of its evidence, and the new factors count once", () => {
    const s = scoreLead({ ...base, activity: "manufacturing", customers: "both", visas: 4, budgetAed: 150_000, expectedTurnoverAed: 2_000_000, startWithin: "1_month", ownerType: "company" }, { phoneGiven: true });
    expect(s.complexity).toBe(Math.min(100, SCORE_BASE + s.evidence.value.reduce((n, x) => n + x.points, 0)));
    expect(s.intent).toBe(Math.min(100, SCORE_BASE + s.evidence.readiness.reduce((n, x) => n + x.points, 0)));
    expect(s.evidence.value.map((x) => x.factor)).toEqual(expect.arrayContaining(["industrial premises", "corporate owner", "setup budget of AED 100,000 or more", "expected revenue of AED 1 million or more", "a payroll of three or more"]));
    expect(s.evidence.readiness.map((x) => x.factor)).toEqual(expect.arrayContaining(["wants to start within a month", "a clear activity", "phone number given", "budget given"]));
    // Revenue counts at one level only; "later" and "other" add nothing.
    const mid = scoreLead({ ...base, activity: "other", expectedTurnoverAed: 400_000, startWithin: "later" });
    expect(mid.evidence.value).toEqual([{ factor: "expected revenue above the VAT threshold", points: 5 }]);
    expect(mid.evidence.readiness).toEqual([]);
    // Monotone in the start date.
    const soon = scoreLead({ ...base, activity: "tech", startWithin: "1_month" }).intent;
    expect(soon).toBeGreaterThan(scoreLead({ ...base, activity: "tech", startWithin: "3_months" }).intent);
    expect(scoreLead({ ...base, activity: "tech", startWithin: "3_months" }).intent).toBeGreaterThan(scoreLead({ ...base, activity: "tech" }).intent);
  });

  it("names one action and the reason for every state, with the engagement and closure ending the work", () => {
    const st = (x: Partial<LeadState>): LeadState => ({ status: "new", highIntent: false, intent: 20, consultationRequested: false, hasOwner: false, followupOpen: false, followupDue: false, requestId: null, offerPublished: false, offerAccepted: false, engagement: false, daysSinceCreated: 0, daysSinceUpdate: 0, ...x });
    expect(nextBestAction(st({}))).toMatchObject({ action: "Assign an owner", urgent: false });
    expect(nextBestAction(st({ highIntent: true, intent: 70 }))).toMatchObject({ action: "Assign an owner", urgent: true });
    expect(nextBestAction(st({ status: "routed", hasOwner: true, highIntent: true, intent: 75 }))).toMatchObject({ action: "Call today", urgent: true });
    expect(nextBestAction(st({ status: "routed", hasOwner: true }))).toMatchObject({ action: "Make first contact", urgent: false });
    expect(nextBestAction(st({ status: "routed", hasOwner: true, daysSinceCreated: 3 })).urgent).toBe(true);
    expect(nextBestAction(st({ status: "routed", hasOwner: true, consultationRequested: true }))).toMatchObject({ action: "Book the call they asked for", urgent: true });
    expect(nextBestAction(st({ status: "contacted", hasOwner: true, followupOpen: true, followupDue: true }))).toMatchObject({ action: "Do the follow-up that is due", urgent: true });
    expect(nextBestAction(st({ status: "contacted", hasOwner: true, requestId: "r" }))).toMatchObject({ action: "Get the proposal out" });
    expect(nextBestAction(st({ status: "contacted", hasOwner: true }))).toMatchObject({ action: "Turn the enquiry into a request" });
    expect(nextBestAction(st({ status: "contacted", hasOwner: true, requestId: "r", offerPublished: true, daysSinceUpdate: 4 }))).toMatchObject({ action: "Chase the proposal", urgent: true });
    expect(nextBestAction(st({ status: "consultation", hasOwner: true }))).toMatchObject({ action: "Follow up after the call" });
    expect(nextBestAction(st({ status: "contacted", requestId: "r", offerAccepted: true })).action).toMatch(/on the engagement/);
    expect(nextBestAction(st({ status: "converted" })).urgent).toBe(false);
    expect(nextBestAction(st({ status: "closed" })).action).toMatch(/closed/);
    expect(nextBestAction(st({ status: "anonymised" })).action).toMatch(/anonymised/);
    for (const status of ["new", "routed", "contacted", "consultation", "converted", "closed", "anonymised"] as const) {
      const n = nextBestAction(st({ status }));
      expect(n.action.length).toBeGreaterThan(3);
      expect(n.why.length).toBeGreaterThan(10);
    }
  });
});

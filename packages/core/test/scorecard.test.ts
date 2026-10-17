import { describe, expect, it } from "vitest";
import { clientDocumentsFor, guaranteeCredit, scorePartner, type ScorecardInputs } from "../src/index.ts";

const base: ScorecardInputs = { milestonesDone: 10, milestonesOnTime: 10, qaSubmissions: 10, qaFirstPass: 10, disputes: 0, slaStrikes: 0, rating: 5, changeOrderRate: 0 };

describe("scorecard", () => {
  it("scores a perfect record 100 and a partner with no history the neutral 60", () => {
    expect(scorePartner(base).score).toBe(100);
    const fresh = scorePartner({ ...base, milestonesDone: 0, milestonesOnTime: 0, qaSubmissions: 0, qaFirstPass: 0, rating: null });
    expect(fresh).toMatchObject({ score: 60, provisional: true });
  });

  it("weights on-time 40, first-pass 20, disputes 15, strikes 15, rating 10", () => {
    expect(scorePartner({ ...base, milestonesOnTime: 5 }).parts.onTime).toBe(20);
    expect(scorePartner({ ...base, qaFirstPass: 5 }).parts.firstPass).toBe(10);
    expect(scorePartner({ ...base, disputes: 2 }).parts.disputes).toBe(12);
    expect(scorePartner({ ...base, slaStrikes: 2 }).parts.strikes).toBe(5);
    expect(scorePartner({ ...base, slaStrikes: 9 }).parts.strikes).toBe(0);
    expect(scorePartner({ ...base, rating: 1 }).parts.rating).toBe(0);
    expect(scorePartner({ ...base, rating: 3 }).parts.rating).toBe(5);
    expect(scorePartner({ ...base, rating: null }).parts.rating).toBe(6);
    expect(scorePartner({ ...base, milestonesOnTime: 5, qaFirstPass: 5, disputes: 2, slaStrikes: 2, rating: 3 }).score).toBe(20 + 10 + 12 + 5 + 5);
  });

  it("never leaves 0..100 and treats a rate with no observations as nothing went wrong", () => {
    expect(scorePartner({ ...base, milestonesDone: 0, milestonesOnTime: 0, disputes: 0 }).parts).toMatchObject({ onTime: 40, disputes: 15 });
    expect(scorePartner({ ...base, slaStrikes: 100, rating: 1, milestonesOnTime: 0, qaFirstPass: 0, disputes: 50 }).score).toBe(0);
  });
});

describe("service guarantee", () => {
  it("credits the share of the late step's fee, rounding down, and nothing on nonsense", () => {
    // AED 9,000 line over 3 steps = AED 3,000 per step; 10% = AED 300.
    expect(guaranteeCredit(900_000, 3, 1000)).toBe(30_000);
    // AED 1,000 over 3 steps = 33,333 fils per step; 10% = 3,333.3 → 3,333.
    expect(guaranteeCredit(100_000, 3, 1000)).toBe(3_333);
    expect(guaranteeCredit(0, 3, 1000)).toBe(0);
    expect(guaranteeCredit(100_000, 0, 1000)).toBe(0);
    expect(guaranteeCredit(100_000, 3, 0)).toBe(0);
    expect(guaranteeCredit(100_000, 1, 10_000)).toBe(100_000);
  });
});

describe("client document checklist", () => {
  it("belongs to the first step of a line and falls back to a passport copy", () => {
    expect(clientDocumentsFor("SET-FZ-LIC", 1, 1)).toContain("passport_copy");
    expect(clientDocumentsFor("SET-FZ-LIC", 2, 1)).toEqual([]);
    expect(clientDocumentsFor("TM-REG", 4, 4)).toEqual(["passport_copy"]);
  });
});

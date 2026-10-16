import { describe, expect, it } from "vitest";
import {
  aed,
  DEFAULT_SETTINGS,
  normalise,
  offerTotals,
  paymentPlan,
  priceLine,
  rankBand,
  riskLoadingBp,
  scoreQuotes,
  selectForTier,
  splitByShares,
} from "../src/index.ts";
import { deliverables, partner, rules, sheetCards } from "./fixtures.ts";

const partners = new Map([
  ["P1", partner("P1")],
  ["P2", partner("P2", { changeOrderRate: 0.1 })],
]);

describe("normalisation", () => {
  it("adds gap cost and risk loading so exclusions cannot look cheaper", () => {
    const n = normalise(sheetCards[1]!, deliverables.get("SET-FZ-LIC")!, 0.1);
    // 2,800 + 9,000 + 1,000 gap + 5% of 2,800 risk loading (rate 10% of jobs -> 200 bp)
    expect(riskLoadingBp(0.1)).toBe(200);
    expect(n.comparableCost).toBe(aed(2_800 + 9_000 + 1_000) + aed(56));
  });

  it("uses the platform government fee table when set", () => {
    const d = { ...deliverables.get("SET-FZ-LIC")!, govFeeTable: aed(10_000) };
    const n = normalise(sheetCards[1]!, d, 0);
    expect(n.govFeeUsed).toBe(aed(10_000));
  });

  it("caps risk loading at 10%", () => {
    expect(riskLoadingBp(0)).toBe(0);
    expect(riskLoadingBp(0.3)).toBe(1_000);
    expect(riskLoadingBp(0.9)).toBe(1_000);
  });
});

describe("selection", () => {
  const fz = sheetCards.filter((c) => c.code === "SET-FZ-LIC");
  const scored = scoreQuotes(fz, deliverables.get("SET-FZ-LIC")!, partners, DEFAULT_SETTINGS.weights);

  it("matches the Google Sheet scores for the example cards", () => {
    // Sheet uses 5% risk loading entered by hand on RC-EX2; here P2's 10% change-order rate gives 2%.
    const p1 = scored.find((s) => s.partnerId === "P1")!;
    expect(p1.rank).toBe(1);
    expect(p1.score).toBeGreaterThan(90);
  });

  it("chooses by tier", () => {
    expect(selectForTier(scored, "standard")!.chosen.partnerId).toBe("P1");
    expect(selectForTier(scored, "priority")!.chosen.partnerId).toBe("P1");
    expect(selectForTier(scored, "essential")!.chosen.partnerId).toBe("P2");
    expect(selectForTier(scored, "standard")!.fallback!.partnerId).toBe("P2");
  });

  it("tells a losing partner only its rank band", () => {
    const sel = selectForTier(scored, "standard")!;
    const loser = scored.find((s) => s.partnerId === "P2")!;
    expect(rankBand(loser, sel.chosen)).toBe("within_5pct");
    expect(rankBand(sel.chosen, sel.chosen)).toBe("won");
  });
});

describe("margin pricing", () => {
  const line = (code: string, qty: number, cost: number, gov: number) => {
    const d = deliverables.get(code)!;
    return priceLine({ deliverable: d, qty, partnerUnitCost: aed(cost), govUnitFee: aed(gov), rule: rules.get(d.category)! }, DEFAULT_SETTINGS);
  };

  it("reproduces the Offer Builder example exactly", () => {
    const lines = [line("SET-FZ-LIC", 1, 3_500, 9_500), line("VISA-RES", 2, 1_800, 3_500), line("BANK-ACC", 1, 2_000, 0)];
    expect(lines.map((l) => l.clientUnitPrice)).toEqual([aed(4_200), aed(2_200), aed(2_400)]);
    const t = offerTotals(lines, DEFAULT_SETTINGS);
    expect(t.professional).toBe(aed(11_000));
    expect(t.vat).toBe(aed(550));
    expect(t.government).toBe(aed(16_500));
    expect(t.clientTotal).toBe(aed(28_050));
    expect(t.partnerPayout).toBe(aed(9_100));
    expect(t.margin).toBe(aed(1_900));
    expect(t.marginBp).toBe(1_727);
    const plan = paymentPlan(t);
    expect(plan.clientOnAcceptance).toBe(aed(22_275));
    expect(plan.clientOnCompletion).toBe(aed(5_775));
    expect([plan.partnerKickoff, plan.partnerKeyMilestone, plan.partnerCompletion]).toEqual([aed(3_640), aed(3_640), aed(1_820)]);
  });

  it("applies the floor when the rate gives less", () => {
    const l = line("VISA-RES", 1, 1_000, 0);
    // 20% of 1,000 = 200 < floor 400 -> 1,400
    expect(l.clientUnitPrice).toBe(aed(1_400));
    expect(l.status).toBe("ok");
  });

  it("caps at market mid x factor and sends to ops review when the cap eats the floor", () => {
    // Visa cap = 4,000 x 1.25 = 5,000. Cost 4,800 -> rule price 5,760, capped to 5,000, margin 200 < 400 floor.
    const l = line("VISA-RES", 1, 4_800, 0);
    expect(l.capped).toBe(true);
    expect(l.clientUnitPrice).toBe(aed(5_000));
    expect(l.status).toBe("ops_review");
  });

  it("takes government fees off the cap when the market mid includes them", () => {
    const l = line("SET-FZ-LIC", 1, 3_500, 9_500);
    expect(l.capUnit).toBe(aed(15_000 - 9_500));
  });

  it("prices agent-model work as the partner fee plus a disclosed MKW fee", () => {
    const l = line("AUD-EXT", 1, 8_000, 0);
    expect(l.model).toBe("agent");
    expect(l.clientUnitPrice).toBe(aed(8_000));
    expect(l.mkwFeeUnit).toBe(aed(800));
    expect(l.marginUnit).toBe(aed(800));
  });

  it("never charges margin on government fees", () => {
    const a = line("SET-FZ-LIC", 1, 3_500, 0);
    const b = line("SET-FZ-LIC", 1, 3_500, 5_000);
    expect(a.marginUnit).toBe(b.marginUnit);
  });

  it("rejects a quantity below one", () => {
    expect(() => line("VISA-RES", 0, 1_000, 0)).toThrow();
  });
});

describe("splitByShares", () => {
  it("always adds back to the total", () => {
    for (const total of [1, 7, 101, 99_999, 1_234_567]) {
      const parts = splitByShares(total, [4_000, 4_000, 2_000]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

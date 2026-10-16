import { describe, expect, it } from "vitest";
import { allocate, checkEligibility, type AllocationContext } from "../src/index.ts";
import { deliverables, partner } from "./fixtures.ts";

const base: AllocationContext = {
  codes: ["SET-FZ-LIC"],
  emirate: "Dubai",
  quotingPartnerId: "P1",
  rankedPartnerIds: ["P1", "P2", "P3"],
  clientOrgId: "C1",
  monthShare: new Map(),
};

const map = (...ps: ReturnType<typeof partner>[]) => new Map(ps.map((p) => [p.id, p]));

describe("eligibility", () => {
  it("blocks prospects, lapsed licences, missing coverage and conflicts", () => {
    const fails = checkEligibility(
      partner("X", { status: "prospect", licenceActive: false, emirates: ["Sharjah"], conflicts: ["C1"] }),
      base,
      deliverables,
    ).failures;
    expect(fails).toEqual(
      expect.arrayContaining(["not signed or on pilot", "licence not active", "does not cover Dubai", "conflict of interest"]),
    );
  });

  it("requires FTA registration for tax agency and audit approval for the client's zone", () => {
    const p = partner("T", { codes: ["TAX-AGENT", "AUD-EXT"] });
    expect(checkEligibility(p, { ...base, codes: ["TAX-AGENT"] }, deliverables).failures).toContain("not an FTA registered tax agent");
    expect(checkEligibility({ ...p, ftaTaxAgent: true }, { ...base, codes: ["TAX-AGENT"] }, deliverables).eligible).toBe(true);
    const ifza = { ...base, codes: ["AUD-EXT"], freeZone: "IFZA" };
    expect(checkEligibility(p, ifza, deliverables).eligible).toBe(false);
    expect(checkEligibility({ ...p, approvedAuditorZones: ["IFZA"] }, ifza, deliverables).eligible).toBe(true);
  });

  it("caps live jobs while on probation", () => {
    const p = partner("N", { deliveredOnTime: 2, liveJobs: 3 });
    expect(checkEligibility(p, base, deliverables).failures).toContain("probation cap reached");
  });
});

describe("allocation", () => {
  it("gives the job to the quoting partner by default, with a fallback", () => {
    const d = allocate(base, map(partner("P1"), partner("P2"), partner("P3")), deliverables);
    expect(d).toMatchObject({ partnerId: "P1", reason: "quoting_partner", fallbackId: "P2" });
  });

  it("moves to the next-ranked partner when the quoting partner is over the fairness cap", () => {
    const d = allocate({ ...base, monthShare: new Map([["P1", 0.4]]) }, map(partner("P1"), partner("P2"), partner("P3")), deliverables);
    expect(d).toMatchObject({ partnerId: "P2", reason: "next_ranked_fairness_cap" });
  });

  it("never re-routes to a partner whose cost is above the price the client accepted", () => {
    const ps = map(partner("P1"), partner("P2"), partner("P3"));
    const capped = { ...base, monthShare: new Map([["P1", 0.4]]) };
    const d = allocate({ ...capped, withinPricedCost: (id) => id === "P3" }, ps, deliverables);
    expect(d).toMatchObject({ partnerId: "P3", reason: "next_ranked_fairness_cap" });
    expect(d.skipped.some((s) => s.partnerId === "P2")).toBe(false); // P2 is simply not an alternative
    const none = allocate({ ...capped, withinPricedCost: () => false }, ps, deliverables);
    expect(none).toMatchObject({ partnerId: "P1", reason: "quoting_partner", fallbackId: null });
    const declined = allocate({ ...base, excluded: ["P1"], withinPricedCost: () => false, retryReason: "next_ranked_declined" }, ps, deliverables);
    expect(declined.partnerId).toBeNull();
  });

  it("keeps the quoting partner when no one else clears the quality bar", () => {
    const d = allocate(
      { ...base, monthShare: new Map([["P1", 0.4]]) },
      map(partner("P1"), partner("P2", { quality: 40 }), partner("P3", { quality: 50 })),
      deliverables,
    );
    expect(d.partnerId).toBe("P1");
  });

  it("locks partner-sourced clients to their partner", () => {
    const d = allocate({ ...base, sourcedByPartnerId: "P3" }, map(partner("P1"), partner("P2"), partner("P3")), deliverables);
    expect(d).toMatchObject({ partnerId: "P3", reason: "partner_sourced" });
  });

  it("skips declined partners and records the reason", () => {
    const d = allocate(
      { ...base, excluded: ["P1"], retryReason: "next_ranked_declined" },
      map(partner("P1"), partner("P2"), partner("P3")),
      deliverables,
    );
    expect(d).toMatchObject({ partnerId: "P2", reason: "next_ranked_declined", fallbackId: "P3" });
  });

  it("returns no partner, with reasons, when nobody is eligible", () => {
    const d = allocate(base, map(partner("P1", { capacityLeft: 0 }), partner("P2", { status: "paused" })), deliverables);
    expect(d.partnerId).toBeNull();
    expect(d.reason).toBe("no_eligible_partner");
    expect(d.skipped.map((s) => s.partnerId)).toEqual(expect.arrayContaining(["P1", "P2"]));
  });
});

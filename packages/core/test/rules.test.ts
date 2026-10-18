import { describe, expect, it } from "vitest";
import {
  addWorkingHours,
  assertMilestone,
  buildScope,
  forbiddenFields,
  maskContacts,
  milestonesFor,
  payoutStagesEligible,
  serialize,
  workingHoursBetween,
} from "../src/index.ts";

describe("working-hour clocks (Dubai, Mon to Fri, 09:00 to 18:00)", () => {
  it("rolls past the end of the day", () => {
    // Thu 15 Oct 2026, 16:00 Dubai = 12:00Z. 4 working hours -> Fri 11:00 Dubai = 07:00Z.
    expect(addWorkingHours(new Date("2026-10-15T12:00:00Z"), 4).toISOString()).toBe("2026-10-16T07:00:00.000Z");
  });

  it("skips the weekend", () => {
    // Fri 16 Oct, 17:00 Dubai = 13:00Z. 2 hours -> Mon 19 Oct 10:00 Dubai = 06:00Z.
    expect(addWorkingHours(new Date("2026-10-16T13:00:00Z"), 2).toISOString()).toBe("2026-10-19T06:00:00.000Z");
  });

  it("skips holidays", () => {
    const cal = { holidays: ["2026-10-19"], workingWeekdays: [1, 2, 3, 4, 5], dayStart: 9, dayEnd: 18 };
    expect(addWorkingHours(new Date("2026-10-16T13:00:00Z"), 2, cal).toISOString()).toBe("2026-10-20T06:00:00.000Z");
  });

  it("measures elapsed working hours", () => {
    expect(workingHoursBetween(new Date("2026-10-16T13:00:00Z"), new Date("2026-10-19T06:00:00Z"))).toBeCloseTo(2, 1);
  });
});

describe("visibility", () => {
  const offer = {
    id: "O1",
    tier: "standard",
    clientTotal: 2_805_000,
    partnerPayout: 910_000,
    margin: 190_000,
    lines: [{ code: "VISA-RES", qty: 2, clientUnitPrice: 220_000, partnerUnitCost: 180_000, marginUnit: 40_000 }],
  };

  it("never gives a client the partner cost or margin", () => {
    const out = serialize("offer", "client_owner", offer, { lines: "offerLine" });
    expect(out).not.toHaveProperty("margin");
    expect(out).not.toHaveProperty("partnerPayout");
    const line = (out.lines as Record<string, unknown>[])[0]!;
    expect(line).toHaveProperty("clientUnitPrice");
    expect(line).not.toHaveProperty("partnerUnitCost");
    expect(line).not.toHaveProperty("marginUnit");
  });

  it("never gives ops the margin; finance sees it", () => {
    expect(serialize("offer", "ops", offer)).not.toHaveProperty("margin");
    expect(serialize("offer", "finance", offer)).toHaveProperty("margin");
  });

  it("gives a partner admin its own cost on engagement lines but not the client price", () => {
    const out = serialize("engagementLine", "partner_admin", { code: "X", clientUnitPrice: 1, partnerUnitCost: 2 });
    expect(out).toEqual({ code: "X", partnerUnitCost: 2 });
    expect(serialize("engagementLine", "partner_staff", { code: "X", clientUnitPrice: 1, partnerUnitCost: 2 })).toEqual({ code: "X" });
  });

  it("drops unknown fields by default", () => {
    expect(serialize("offerLine", "founder", { code: "X", secretThing: 1 })).toEqual({ code: "X" });
  });

  it("lists forbidden fields for leak tests", () => {
    expect(forbiddenFields("offerLine", "client_owner")).toEqual(
      expect.arrayContaining(["partnerUnitCost", "marginUnit", "partnerId"]),
    );
  });
});

describe("contact masking", () => {
  it("hides emails, phone numbers and WhatsApp links", () => {
    const r = maskContacts("Call me on +971 50 123 4567 or mail ali@example.ae, or wa.me/971501234567");
    expect(r.masked).toBe(true);
    expect(r.text).not.toMatch(/971|example\.ae/);
  });

  it("leaves short numbers such as amounts and dates alone", () => {
    const r = maskContacts("Licence costs AED 12,000 and is ready on 20-10-2026");
    expect(r.text).toBe("Licence costs AED 12,000 and is ready on 20-10-2026");
  });
});

describe("state machines", () => {
  it("requires QA to pass evidence before the client can approve", () => {
    expect(() => assertMilestone("evidence_submitted", "client_approved", "client")).toThrow();
    expect(() => assertMilestone("qa_passed", "client_approved", "client")).not.toThrow();
    expect(() => assertMilestone("evidence_submitted", "qa_passed", "partner")).toThrow();
  });

  it("releases payout stages only as work is approved", () => {
    expect(payoutStagesEligible(true, [{ isKey: true, status: "qa_passed" }])).toEqual(["kickoff"]);
    expect(
      payoutStagesEligible(true, [
        { isKey: true, status: "client_approved" },
        { isKey: false, status: "client_approved" },
      ]),
    ).toEqual(["kickoff", "key_milestone", "completion"]);
  });
});

describe("scoping", () => {
  const known = new Set(["SET-FZ-LIC", "SET-OFF", "VISA-RES", "VISA-FAM", "BANK-ACC", "ACC-BOOK"]);

  it("turns intake answers into deliverable codes", () => {
    const s = buildScope({ mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 2, addOns: ["BANK-ACC"] }, known);
    expect(s.lines).toEqual([
      { code: "SET-FZ-LIC", qty: 1 },
      { code: "VISA-RES", qty: 2 },
      { code: "BANK-ACC", qty: 1 },
    ]);
  });

  it("drops visas for offshore companies and says why", () => {
    const s = buildScope({ mode: "new_company", jurisdiction: "offshore", emirate: "Ras Al Khaimah", visas: 2 }, known);
    expect(s.lines).toEqual([{ code: "SET-OFF", qty: 1 }]);
    expect(s.notes.join(" ")).toMatch(/cannot sponsor/);
  });

  it("gives every deliverable milestones with one key milestone", () => {
    for (const code of ["SET-FZ-LIC", "VISA-RES", "ACC-BOOK"]) {
      const ms = milestonesFor(code, 1);
      expect(ms.filter((m) => m.isKey)).toHaveLength(1);
      expect(ms.every((m) => m.evidence.length > 0)).toBe(true);
    }
  });
});

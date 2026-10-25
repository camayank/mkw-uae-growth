import { describe, expect, it } from "vitest";
import { QUEUE_POLICY, rankQueue, triage, UAE_CALENDAR, type QueueKind } from "../src/index.ts";

// Monday 19 October 2026, 10:00 in Dubai.
const monday10 = new Date("2026-10-19T06:00:00Z");
const hoursLater = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

describe("triage", () => {
  it("sets the target in working hours, across a weekend and a holiday", () => {
    // Friday 23 October, 17:00 Dubai: one working hour that day, three on the next working day.
    const fridayLate = new Date("2026-10-23T13:00:00Z");
    expect(triage({ kind: "dispute", at: fridayLate }, fridayLate).dueAt.toISOString()).toBe("2026-10-26T08:00:00.000Z");
    const withHoliday = { ...UAE_CALENDAR, holidays: ["2026-10-26"] };
    expect(triage({ kind: "dispute", at: fridayLate }, fridayLate, withHoliday).dueAt.toISOString()).toBe("2026-10-27T08:00:00.000Z");
  });

  it("marks items on track, due soon or overdue, and says by how much", () => {
    const fresh = triage({ kind: "qa", at: monday10 }, monday10);
    expect(fresh).toMatchObject({ level: "on_track", hoursLeft: 9, factors: ["within its target"] });
    const soon = triage({ kind: "dispute", at: monday10 }, hoursLater(monday10, 3));
    expect(soon.level).toBe("due_soon");
    expect(soon.factors[0]).toBe("1 working hour left of its 4 working hours target");
    const late = triage({ kind: "dispute", at: monday10 }, hoursLater(monday10, 6.5));
    expect(late.level).toBe("overdue");
    expect(late.hoursLeft).toBeCloseTo(-2.5, 1);
    expect(late.factors[0]).toBe("2.5 working hours past its 4 working hours target");
  });

  it("lists every factor it counts and caps the score at 100", () => {
    const t = triage({ kind: "dispute", at: monday10, signals: { clientWaiting: true, partnerWaiting: true, moneyWaiting: true, weakPartner: true } }, hoursLater(monday10, 48));
    expect(t.risk).toBe(100);
    expect(t.factors).toEqual([
      expect.stringMatching(/past its 4 working hours target/),
      "a client is waiting on it",
      "a partner is waiting on it",
      "money is waiting to move",
      "the partner's last scorecard is below the quality bar",
    ]);
  });

  it("ranks overdue before due, a dispute before a lead, then the earliest target", () => {
    const now = hoursLater(monday10, 5);
    const ranked = rankQueue(
      [
        { id: "lead", kind: "lead" as QueueKind, at: monday10 },
        { id: "dispute", kind: "dispute" as QueueKind, at: hoursLater(monday10, 4) },
        { id: "late-offer", kind: "offer_review" as QueueKind, at: monday10 },
        { id: "qa-older", kind: "qa" as QueueKind, at: monday10 },
        { id: "qa-newer", kind: "qa" as QueueKind, at: hoursLater(monday10, 1) },
      ],
      now,
    );
    expect(ranked.map((r) => r.id)).toEqual(["late-offer", "dispute", "qa-older", "qa-newer", "lead"]);
    expect(ranked[0]!.level).toBe("overdue");
  });

  it("only orders: every item survives ranking unchanged apart from its triage", () => {
    const items = (Object.keys(QUEUE_POLICY) as QueueKind[]).map((kind, i) => ({ kind, at: hoursLater(monday10, -i), ref: `r${i}` }));
    const ranked = rankQueue(items, monday10);
    expect(ranked).toHaveLength(items.length);
    expect(new Set(ranked.map((r) => r.ref))).toEqual(new Set(items.map((i) => i.ref)));
    for (const r of ranked) expect(r.risk).toBeGreaterThanOrEqual(QUEUE_POLICY[r.kind].weight);
  });
});

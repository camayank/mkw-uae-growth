import { describe, expect, it } from "vitest";
import { BACKLOG_CSV_HEADER, BACKLOG_FIELDS, backlogCsv, coverageMatrix, type CoverageAuthority, type CoveragePlace, type FieldEvidence } from "../src/index.ts";

/**
 * E7B: the coverage matrix counts each authority and place once, keeps historical places out of the candidates and
 * the tasks, lists the evidence to obtain first wave first, and writes a backlog the importer reads back.
 */
const ev = (field: string, extra: Partial<FieldEvidence> = {}): FieldEvidence => ({ field, recorded: "verified", confidence: "verified", stale: false, evidenceDate: "2026-10-01", nextVerification: "2027-03-30", verifiedBy: "A", sourceUrl: "https://x.gov.ae/", factId: 1, sourceKind: "official", ...extra });
const place = (name: string, emirate: string, placeKind: CoveragePlace["placeKind"], x: Partial<CoveragePlace> = {}): CoveragePlace => ({
  name, emirate, placeKind, status: "active", priority: null, authorityId: null, authority: null, evidence: {}, has: {}, confidence: "UNCERTAIN", stale: false, ...x,
});
const auth = (id: string, kind: CoverageAuthority["kind"], emirate: string | null, parentId: string | null = null): CoverageAuthority => ({ id, name: id, kind, emirate, parentId, active: true });

describe("coverage matrix (E7B)", () => {
  const authorities = [auth("ifza", "free_zone_authority", "Dubai"), auth("dso", "free_zone_authority", "Dubai"), auth("dtec", "free_zone_authority", "Dubai", "dso"), auth("sca", "regulator", null)];
  const places = [
    place("IFZA", "Dubai", "free_zone", { priority: 1, authorityId: "ifza", authority: "ifza", has: { cost: true, visa_quota: true, timeline_days: true }, evidence: { cost: ev("cost"), visa_quota: ev("visa_quota", { recorded: "rule_of_thumb", confidence: "rule_of_thumb" }), timeline_days: ev("timeline_days", { stale: true, confidence: "rule_of_thumb", nextVerification: "2026-01-01" }) } }),
    place("DTEC", "Dubai", "sub_zone", { authorityId: "dtec", authority: "dtec", has: { cost: true, visa_quota: true, timeline_days: true, renewal_cost: true }, evidence: { renewal_cost: ev("renewal_cost", { recorded: "rule_of_thumb", confidence: "rule_of_thumb", sourceKind: "intermediary" }), cost: ev("cost", { nextVerification: "2026-11-10" }) } }),
    place("Old Zone", "Sharjah", "free_zone", { status: "historical", has: { cost: true } }),
    place("UAQ FTZ", "Umm Al Quwain", "free_zone", { status: "inactive", priority: 2 }),
  ];
  const m = coverageMatrix("2026-11-03", authorities, places, [{ kind: "rule", subject: "obligation.corporate_tax", state: "not approved" }]);

  it("counts each authority and place once; a sub-zone is a place under its parent, never a second authority", () => {
    expect(m.authorities).toMatchObject({ total: 4, active: 4, byKind: { free_zone_authority: 3, regulator: 1 }, byEmirate: { Dubai: 3, federal: 1 } });
    expect(m.places).toMatchObject({ total: 4, active: 2, inactive: 1, historical: 1, priority: 1, byKind: { free_zone: 2, sub_zone: 1 } });
    expect(m.places.matrix).toEqual({ Dubai: { free_zone: 1, sub_zone: 1 }, "Umm Al Quwain": { free_zone: 1 } }); // the historical place is not counted
    expect(m.emirates).toEqual(["Dubai", "Sharjah", "Umm Al Quwain"]);
    expect(Object.values(m.places.byKind).reduce((a, b) => a + b, 0)).toBe(m.places.total - m.places.historical);
  });

  it("measures verification per field, lists expiring evidence, and carries the outstanding approvals", () => {
    expect(m.fields.cost).toEqual({ onRecord: 2, verified: 2, stale: 0, of: 3 });
    expect(m.fields.timeline_days).toEqual({ onRecord: 2, verified: 0, stale: 1, of: 3 });
    expect(m.fields.renewal_cost).toEqual({ onRecord: 1, verified: 0, stale: 0, of: 3 });
    expect(m.expiring).toMatchObject({ stale: 1, within30: 1, within90: 1 });
    expect(m.expiring.items[0]).toMatchObject({ place: "IFZA", field: "timeline_days", stale: true });
    expect(m.approvals).toEqual({ outstanding: 1, items: [{ kind: "rule", subject: "obligation.corporate_tax", state: "not approved" }] });
  });

  it("lists one task per place and field still to obtain, first wave first, with the reason, and none for historical places", () => {
    expect(m.tasks.some((t) => t.place === "Old Zone")).toBe(false);
    expect(m.tasks[0]).toMatchObject({ place: "IFZA", field: "renewal_cost", reason: "missing" });
    const ifza = m.tasks.filter((t) => t.place === "IFZA");
    expect(ifza.map((t) => t.field)).toEqual(BACKLOG_FIELDS.filter((f) => f !== "cost")); // cost is verified and current
    expect(ifza.find((t) => t.field === "visa_quota")?.reason).toBe("unverified");
    expect(ifza.find((t) => t.field === "timeline_days")?.reason).toBe("stale");
    expect(ifza.find((t) => t.field === "renewal_cost")?.reason).toBe("missing");
    const dtec = m.tasks.filter((t) => t.place === "DTEC");
    expect(dtec.find((t) => t.field === "renewal_cost")?.reason).toBe("intermediary");
    expect(dtec.find((t) => t.field === "cost")?.reason).toBe("due");
    // Order: priority 1, then 2, then none; within a place, the backlog's field order.
    const order = m.tasks.map((t) => t.priority ?? 99);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(m.tasks.filter((t) => t.place === "UAQ FTZ").length).toBe(BACKLOG_FIELDS.length);
    for (const t of m.tasks) expect(t.ask).toMatch(/^Obtain /);
    // Deterministic.
    expect(coverageMatrix("2026-11-03", authorities, places, [])).toMatchObject({ tasks: m.tasks });
  });

  it("writes the backlog in the importer's layout with no value, so importing it back writes nothing", () => {
    const csv = backlogCsv(m.tasks);
    const [header, first] = csv.trim().split("\n");
    expect(header).toBe(BACKLOG_CSV_HEADER.join(","));
    expect(header).toMatch(/^Kind,Place or authority,Field,Value,Source,Evidence date,Confidence/);
    expect(first).toMatch(/^place,IFZA,renewal_cost,,,,,,,,,official,"missing: Obtain /);
    expect(csv).toMatch(/wave 1/);
    expect(csv.split("\n").filter(Boolean).length).toBe(m.tasks.length + 1);
  });
});

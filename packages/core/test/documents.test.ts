import { describe, expect, it } from "vitest";
import { documentPlan, type PlannedDocument, type PlannedStep } from "../src/index.ts";

/** E15: the client's documents as needed now, needed later and already sent. */
const steps: PlannedStep[] = [
  { id: "licence", seq: 1, dueDate: "2026-11-05" },
  { id: "visa", seq: 4, dueDate: "2026-11-10" },
  { id: "bank", seq: 7, dueDate: "2026-11-10" },
  { id: "vat", seq: 9, dueDate: "2026-11-17" },
  { id: "undated", seq: 11, dueDate: null },
  { id: "done", seq: 0, dueDate: "2026-11-01", approved: true },
];
const doc = (id: string, milestoneId: string, status: PlannedDocument["status"] = "requested"): PlannedDocument => ({ id, milestoneId, status });
const TODAY = "2026-11-03";

describe("the client's documents, grouped (E15)", () => {
  it("at acceptance only the first step's documents are needed now; the rest are later, by step and date", () => {
    const docs = [doc("l1", "licence"), doc("l2", "licence"), doc("v1", "visa"), doc("b1", "bank"), doc("t1", "vat"), doc("u1", "undated")];
    const plan = documentPlan(docs, steps, TODAY);
    expect(plan.now).toEqual(["l1", "l2"]);
    expect(plan.nowBy).toBe("2026-11-05");
    expect(plan.later).toEqual([
      { milestoneId: "visa", dueDate: "2026-11-10", ids: ["v1"] },
      { milestoneId: "bank", dueDate: "2026-11-10", ids: ["b1"] },
      { milestoneId: "vat", dueDate: "2026-11-17", ids: ["t1"] },
      { milestoneId: "undated", dueDate: null, ids: ["u1"] },
    ]);
    expect(plan.submitted).toEqual([]);
  });

  it("once the first batch is sent, the next steps due (together, the same day) come forward", () => {
    const docs = [doc("l1", "licence", "uploaded"), doc("l2", "licence", "received"), doc("v1", "visa"), doc("b1", "bank"), doc("t1", "vat")];
    const plan = documentPlan(docs, steps, TODAY);
    expect(plan.now).toEqual(["v1", "b1"]);
    expect(plan.nowBy).toBe("2026-11-10");
    expect(plan.later.map((l) => l.milestoneId)).toEqual(["vat"]);
    expect(plan.submitted).toEqual(["l1", "l2"]);
  });

  it("a document sent back, or one for a step due today or late, is always needed now", () => {
    const docs = [doc("l1", "licence"), doc("t1", "vat", "rejected"), doc("v1", "visa")];
    expect(documentPlan(docs, steps, TODAY).now).toEqual(["l1", "t1"]);
    // The date is the most urgent one: the licence's 5 November, not the sent-back VAT document's 17th.
    expect(documentPlan(docs, steps, TODAY).nowBy).toBe("2026-11-05");
    // On 10 November the licence's documents are late and the visa's are due: all needed now.
    expect(documentPlan(docs, steps, "2026-11-10").now).toEqual(["l1", "v1", "t1"]);
  });

  it("a document left open on a step already approved never takes over 'now' (independent review of E15)", () => {
    // The approved step is due first and is late, yet the licence's documents are the ones needed now.
    const docs = [doc("x1", "done"), doc("x2", "done", "rejected"), doc("l1", "licence"), doc("v1", "visa")];
    const plan = documentPlan(docs, steps, TODAY);
    expect(plan.now).toEqual(["l1"]);
    expect(plan.nowBy).toBe("2026-11-05");
    expect(plan.later).toEqual([
      { milestoneId: "visa", dueDate: "2026-11-10", ids: ["v1"] },
      { milestoneId: "done", dueDate: "2026-11-01", ids: ["x1", "x2"], approved: true },
    ]);
    // Only approved-step leftovers: nothing is needed now.
    expect(documentPlan([doc("x1", "done")], steps, TODAY)).toMatchObject({ now: [], nowBy: null, later: [{ milestoneId: "done", approved: true }] });
    // A document whose step is not in the list goes later, without a date.
    expect(documentPlan([doc("l1", "licence"), doc("m1", "missing")], steps, TODAY).later).toEqual([{ milestoneId: "missing", dueDate: null, ids: ["m1"] }]);
  });

  it("every document is in exactly one group; sent-back and late documents are now; nothing later is due before or with the first batch", () => {
    const statuses = ["requested", "uploaded", "received", "rejected"] as const;
    let seed = 3;
    const rnd = (n: number) => ((seed = (seed * 48271) % 2147483647) % n);
    for (let k = 0; k < 300; k++) {
      const docs = Array.from({ length: 1 + rnd(12) }, (_, i) => doc(`d${i}`, steps[rnd(steps.length)]!.id, statuses[rnd(4)]));
      const today = `2026-11-${String(1 + rnd(20)).padStart(2, "0")}`;
      const plan = documentPlan(docs, steps, today);
      const label = JSON.stringify({ docs, today });
      const all = [...plan.now, ...plan.later.flatMap((l) => l.ids), ...plan.submitted].sort();
      expect(all, label).toEqual(docs.map((d) => d.id).sort());
      const stepOf = (id: string) => steps.find((s) => s.id === docs.find((d) => d.id === id)!.milestoneId)!;
      const statusOf = (id: string) => docs.find((d) => d.id === id)!.status;
      const open = docs.filter((d) => (d.status === "requested" || d.status === "rejected") && !stepOf(d.id).approved);
      expect(plan.now.length > 0, label).toBe(open.length > 0);
      for (const id of plan.submitted) expect(["uploaded", "received"]).toContain(statusOf(id));
      for (const id of plan.now) expect(stepOf(id).approved, label).toBeFalsy();
      // Every sent-back document, and every one for a step due today or late, is needed now (approved steps aside).
      for (const d of open) if (d.status === "rejected" || (stepOf(d.id).dueDate ?? "9999") <= today) expect(plan.now, label).toContain(d.id);
      // Nothing later (on a step not approved) is due before or on the same day as the first batch waiting now.
      const dueOf = (id: string) => stepOf(id).dueDate ?? "9999";
      const nowWaiting = plan.now.filter((id) => statusOf(id) === "requested").map(dueOf);
      for (const l of plan.later.filter((x) => !x.approved)) for (const id of l.ids) for (const n of nowWaiting) expect(dueOf(id) > n, label).toBe(true);
      expect(plan.nowBy, label).toBe(plan.now.map(dueOf).filter((x) => x !== "9999").sort()[0] ?? null);
    }
  });
});

import { describe, expect, it } from "vitest";
import { documentPlan, type PlannedDocument, type PlannedStep } from "../src/index.ts";

/** E15: the client's documents as needed now, needed later and already sent. */
const steps: PlannedStep[] = [
  { id: "licence", seq: 1, dueDate: "2026-11-05" },
  { id: "visa", seq: 4, dueDate: "2026-11-10" },
  { id: "bank", seq: 7, dueDate: "2026-11-10" },
  { id: "vat", seq: 9, dueDate: "2026-11-17" },
  { id: "undated", seq: 11, dueDate: null },
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
    // On 10 November the licence's documents are late and the visa's are due: all needed now.
    expect(documentPlan(docs, steps, "2026-11-10").now).toEqual(["l1", "v1", "t1"]);
  });

  it("every document is in exactly one group, and nothing is needed now only when nothing is missing", () => {
    const statuses = ["requested", "uploaded", "received", "rejected"] as const;
    let seed = 3;
    const rnd = (n: number) => ((seed = (seed * 48271) % 2147483647) % n);
    for (let k = 0; k < 300; k++) {
      const docs = Array.from({ length: 1 + rnd(12) }, (_, i) => doc(`d${i}`, steps[rnd(steps.length)]!.id, statuses[rnd(4)]));
      const today = `2026-11-0${1 + rnd(9)}`;
      const plan = documentPlan(docs, steps, today);
      const all = [...plan.now, ...plan.later.flatMap((l) => l.ids), ...plan.submitted].sort();
      expect(all).toEqual(docs.map((d) => d.id).sort());
      const missing = docs.filter((d) => d.status === "requested" || d.status === "rejected");
      expect(plan.now.length > 0).toBe(missing.length > 0);
      for (const id of plan.submitted) expect(["uploaded", "received"]).toContain(docs.find((d) => d.id === id)!.status);
      // Nothing later is due before something now (sent-back documents aside).
      const dueOf = (id: string) => steps.find((s) => s.id === docs.find((d) => d.id === id)!.milestoneId)!.dueDate ?? "9999";
      const nowWaiting = plan.now.filter((id) => docs.find((d) => d.id === id)!.status === "requested").map(dueOf);
      for (const l of plan.later) for (const id of l.ids) for (const n of nowWaiting) expect(dueOf(id) >= n).toBe(true);
    }
  });
});

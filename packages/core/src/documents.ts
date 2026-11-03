/**
 * E15: the client's documents in three groups, so a new engagement does not open on one intimidating total.
 *
 * Every line's first step asks for its documents when the offer is accepted (O6), so a company with a licence, two
 * visas, a bank account and VAT is asked for a dozen or more at once, some for steps weeks away. The client sees:
 *  - **needed now**: anything sent back, anything for a step due today or already late, and the documents for the
 *    step that comes first among those still waiting (with every step due the same day). Uploading them brings the
 *    next batch forward, so "now" is never empty while something is missing;
 *  - **needed later**: the rest, step by step in the order they are due, each with its date. Uploading early is fine;
 *  - **already sent**: uploaded (being checked) or received.
 *
 * Pure. Dates are YYYY-MM-DD (Gulf calendar days); a step with no due date comes last.
 */
export type DocumentStatus = "requested" | "uploaded" | "received" | "rejected";

export interface PlannedDocument {
  id: string;
  milestoneId: string;
  status: DocumentStatus;
}

export interface PlannedStep {
  id: string;
  seq: number;
  dueDate: string | null;
}

export interface DocumentPlan {
  /** Document request ids to upload now, in step order. */
  now: string[];
  /** The latest due date among the steps "now" is for (null when nothing is needed now). */
  nowBy: string | null;
  /** The rest still to upload, grouped by step, in the order the steps are due. */
  later: Array<{ milestoneId: string; dueDate: string | null; ids: string[] }>;
  /** Uploaded or received. */
  submitted: string[];
}

const LAST = "9999-12-31";

export function documentPlan(docs: PlannedDocument[], steps: PlannedStep[], today: string): DocumentPlan {
  const step = new Map(steps.map((s) => [s.id, s]));
  const due = (d: PlannedDocument) => step.get(d.milestoneId)?.dueDate ?? LAST;
  const seq = (d: PlannedDocument) => step.get(d.milestoneId)?.seq ?? Number.MAX_SAFE_INTEGER;
  const order = (x: PlannedDocument, y: PlannedDocument) => due(x).localeCompare(due(y)) || seq(x) - seq(y);
  const outstanding = docs.filter((d) => d.status === "requested" || d.status === "rejected").sort(order);
  const waiting = outstanding.filter((d) => d.status === "requested");
  const first = waiting.length ? due(waiting[0]!) : null;
  const isNow = (d: PlannedDocument) => d.status === "rejected" || due(d) <= today || due(d) === first;
  const now = outstanding.filter(isNow);
  const later = new Map<string, string[]>();
  for (const d of outstanding.filter((x) => !isNow(x))) later.set(d.milestoneId, [...(later.get(d.milestoneId) ?? []), d.id]);
  const nowDates = now.map(due).filter((x) => x !== LAST).sort();
  return {
    now: now.map((d) => d.id),
    nowBy: nowDates.length ? nowDates[nowDates.length - 1]! : null,
    later: [...later.entries()].map(([milestoneId, ids]) => ({ milestoneId, dueDate: step.get(milestoneId)?.dueDate ?? null, ids })),
    submitted: docs.filter((d) => d.status === "uploaded" || d.status === "received").map((d) => d.id),
  };
}

/**
 * E15: the client's documents in three groups, so a new engagement does not open on one intimidating total.
 *
 * Every line's first step asks for its documents when the offer is accepted (O6), so a company with a licence, two
 * visas, a bank account and VAT is asked for a dozen or more at once, some for steps weeks away. The client sees:
 *  - **needed now**: anything sent back, anything for a step due today or already late, and the documents for the
 *    step that comes first among those still waiting (with every step due the same day). Uploading them brings the
 *    next batch forward, so "now" is never empty while a step not yet approved is missing a document;
 *  - **needed later**: the rest, step by step in the order they are due, each with its date. Uploading early is fine;
 *  - **already sent**: uploaded (being checked) or received.
 * A document still open on a step the client already approved never counts as needed now (independent review of
 * E15): it would push the documents that hold up real work aside and say a finished step "cannot finish". It is
 * listed last among the later ones, marked as for an approved step.
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
  /** The client approved the step (or it was approved for them): its documents no longer hold anything up. */
  approved?: boolean;
}

export interface DocumentPlan {
  /** Document request ids to upload now, in step order. */
  now: string[];
  /** The earliest due date among the steps "now" is for: the date that matters most (null when none has a date). */
  nowBy: string | null;
  /** The rest still to upload, grouped by step, in the order the steps are due; steps already approved last. */
  later: Array<{ milestoneId: string; dueDate: string | null; ids: string[]; approved?: boolean }>;
  /** Uploaded or received. */
  submitted: string[];
}

const LAST = "9999-12-31";

export function documentPlan(docs: PlannedDocument[], steps: PlannedStep[], today: string): DocumentPlan {
  const step = new Map(steps.map((s) => [s.id, s]));
  const due = (d: PlannedDocument) => step.get(d.milestoneId)?.dueDate ?? LAST;
  const seq = (d: PlannedDocument) => step.get(d.milestoneId)?.seq ?? Number.MAX_SAFE_INTEGER;
  const approved = (d: PlannedDocument) => !!step.get(d.milestoneId)?.approved;
  const order = (x: PlannedDocument, y: PlannedDocument) => Number(approved(x)) - Number(approved(y)) || due(x).localeCompare(due(y)) || seq(x) - seq(y);
  const outstanding = docs.filter((d) => d.status === "requested" || d.status === "rejected").sort(order);
  const waiting = outstanding.filter((d) => d.status === "requested" && !approved(d));
  const first = waiting.length ? due(waiting[0]!) : null;
  const isNow = (d: PlannedDocument) => !approved(d) && (d.status === "rejected" || due(d) <= today || due(d) === first);
  const now = outstanding.filter(isNow);
  const later = new Map<string, string[]>();
  for (const d of outstanding.filter((x) => !isNow(x))) later.set(d.milestoneId, [...(later.get(d.milestoneId) ?? []), d.id]);
  const nowDates = now.map(due).filter((x) => x !== LAST).sort();
  return {
    now: now.map((d) => d.id),
    nowBy: nowDates[0] ?? null,
    later: [...later.entries()].map(([milestoneId, ids]) => ({ milestoneId, dueDate: step.get(milestoneId)?.dueDate ?? null, ids, ...(step.get(milestoneId)?.approved ? { approved: true } : {}) })),
    submitted: docs.filter((d) => d.status === "uploaded" || d.status === "received").map((d) => d.id),
  };
}

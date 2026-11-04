/**
 * State machines. Each transition lists who may make it; anything not listed is refused.
 * A milestone is only complete on evidence: QA must pass evidence before the client can approve.
 */
/**
 * Every status each machine's row may hold. The database's check constraint on each status column lists exactly these
 * (migration 027; `test/transitions.test.ts` compares them). A status no move reaches is still listed: a request is
 * created `scoped` and a change order `priced`, so `draft` and `proposed` are the columns' defaults that the code never
 * writes today.
 */
export const STATUSES = {
  request: ["draft", "scoped", "quoting", "offered", "closed"],
  offer: ["draft", "ops_review", "published", "accepted", "expired", "withdrawn"],
  engagement: ["awaiting_payment", "allocating", "in_delivery", "completed", "cancelled", "disputed"],
  milestone: ["pending", "in_progress", "evidence_submitted", "qa_passed", "qa_rejected", "client_approved", "disputed"],
  payout: ["pending", "eligible", "released", "withheld"],
  change_order: ["proposed", "priced", "approved", "rejected"],
  file: ["pending", "clean", "infected", "failed", "not_scanned"],
} as const;

export type RequestStatus = (typeof STATUSES.request)[number];
export type OfferStatus = (typeof STATUSES.offer)[number];
export type EngagementStatus = (typeof STATUSES.engagement)[number];
export type MilestoneStatus = (typeof STATUSES.milestone)[number];
export type PayoutStatus = (typeof STATUSES.payout)[number];
export type ChangeOrderStatus = (typeof STATUSES.change_order)[number];
export type FileStatus = (typeof STATUSES.file)[number];

export type Actor = "client" | "partner" | "platform" | "system";

interface Transition<S extends string> {
  from: S;
  to: S;
  by: Actor[];
}

const milestoneTransitions: Transition<MilestoneStatus>[] = [
  { from: "pending", to: "in_progress", by: ["partner", "platform"] },
  { from: "in_progress", to: "evidence_submitted", by: ["partner"] },
  { from: "qa_rejected", to: "evidence_submitted", by: ["partner"] },
  { from: "evidence_submitted", to: "qa_passed", by: ["platform"] },
  { from: "evidence_submitted", to: "qa_rejected", by: ["platform"] },
  { from: "qa_passed", to: "client_approved", by: ["client", "system"] },
  { from: "qa_passed", to: "disputed", by: ["client"] },
  { from: "disputed", to: "in_progress", by: ["platform"] },
  { from: "disputed", to: "client_approved", by: ["platform"] },
];

const offerTransitions: Transition<OfferStatus>[] = [
  { from: "draft", to: "ops_review", by: ["system", "platform"] },
  { from: "draft", to: "published", by: ["platform"] },
  { from: "ops_review", to: "published", by: ["platform"] },
  { from: "published", to: "accepted", by: ["client"] },
  { from: "published", to: "expired", by: ["system"] },
  { from: "published", to: "withdrawn", by: ["platform"] },
  { from: "draft", to: "withdrawn", by: ["platform"] },
  { from: "ops_review", to: "withdrawn", by: ["platform"] },
];

const engagementTransitions: Transition<EngagementStatus>[] = [
  { from: "awaiting_payment", to: "allocating", by: ["system", "platform"] },
  { from: "awaiting_payment", to: "cancelled", by: ["client", "platform"] },
  { from: "allocating", to: "in_delivery", by: ["partner", "platform"] },
  { from: "in_delivery", to: "completed", by: ["system", "platform"] },
  { from: "in_delivery", to: "disputed", by: ["client", "platform"] },
  { from: "disputed", to: "in_delivery", by: ["platform"] },
  { from: "in_delivery", to: "cancelled", by: ["platform"] },
];

/**
 * A request (E21). Ops price it (offers) or ask partners for quotes (quoting), and may go back and forth while no offer
 * is accepted. The client's acceptance closes it, from `quoting` too: a rebuild that finds a price missing leaves the
 * offers already published open. A closed request is never priced or quoted again (before E21 a rebuild on a closed
 * request let the client accept a second engagement on it). Building the same state again (a second request for
 * quotes, a rebuild of offers) is not a move: `transition()` treats it as done (`idempotent`).
 */
const requestTransitions: Transition<RequestStatus>[] = [
  { from: "scoped", to: "quoting", by: ["platform"] },
  { from: "scoped", to: "offered", by: ["platform"] },
  { from: "quoting", to: "offered", by: ["platform"] },
  { from: "offered", to: "quoting", by: ["platform"] },
  { from: "offered", to: "closed", by: ["client"] },
  { from: "quoting", to: "closed", by: ["client"] },
];

/**
 * A partner payout (E21). Eligible by the tested rule (`payoutStagesEligible`, or the change order's payment received),
 * released by finance (one payout, or a payout run marked paid), withheld when the client's money is refunded. A
 * released or withheld payout never moves again.
 */
const payoutTransitions: Transition<PayoutStatus>[] = [
  { from: "pending", to: "eligible", by: ["system"] },
  { from: "eligible", to: "released", by: ["platform"] },
  { from: "pending", to: "withheld", by: ["platform"] },
  { from: "eligible", to: "withheld", by: ["platform"] },
];

/** A change order (E21): priced by the margin rule when the partner raises it, then decided once by the client. */
const changeOrderTransitions: Transition<ChangeOrderStatus>[] = [
  { from: "priced", to: "approved", by: ["client"] },
  { from: "priced", to: "rejected", by: ["client"] },
];

/**
 * An uploaded file's malware scan (E22). The upload records the first result (pending, clean, infected, failed, or
 * not_scanned when the owner allows unscanned files under T6); after that only a scanner's verdict moves it, by the
 * system. A failed scan that fails again is not a move (its attempts are counted). An infected file never moves again:
 * a person uploads a clean copy. Only `clean` and, if allowed, `not_scanned` are ever served (`apps/api/src/lib/uploads.ts`).
 */
const fileTransitions: Transition<FileStatus>[] = [
  { from: "pending", to: "clean", by: ["system"] },
  { from: "pending", to: "infected", by: ["system"] },
  { from: "pending", to: "failed", by: ["system"] },
  { from: "failed", to: "clean", by: ["system"] },
  { from: "failed", to: "infected", by: ["system"] },
  { from: "not_scanned", to: "clean", by: ["system"] },
  { from: "not_scanned", to: "infected", by: ["system"] },
];

/**
 * The machines that move money and work, as data (O13; requests, payouts and change orders since E21). The API changes
 * their status only through these (`apps/api/src/lib/transition.ts`).
 */
export const MACHINES = {
  milestone: milestoneTransitions,
  offer: offerTransitions,
  engagement: engagementTransitions,
  request: requestTransitions,
  payout: payoutTransitions,
  change_order: changeOrderTransitions,
  file: fileTransitions,
} as const;
export type MachineName = keyof typeof MACHINES;
export type MachineStatus<M extends MachineName> = (typeof MACHINES)[M][number]["to"];

/** What can happen next from a status: every destination, or only those `by` may choose. */
export function nextStates(machine: MachineName, from: string, by?: Actor): string[] {
  const table = MACHINES[machine] as Transition<string>[];
  return [...new Set(table.filter((t) => t.from === from && (!by || t.by.includes(by))).map((t) => t.to))];
}

function check<S extends string>(table: Transition<S>[], from: S, to: S, by: Actor): void {
  const ok = table.some((t) => t.from === from && t.to === to && t.by.includes(by));
  if (ok) return;
  const next = [...new Set(table.filter((t) => t.from === from && t.by.includes(by)).map((t) => t.to))];
  throw new TransitionError(
    `${by} cannot move from ${from} to ${to}; ${next.length ? `from ${from} ${by} can move to ${next.join(" or ")}` : `nothing ${by} can do changes ${from}`}`,
  );
}

export function assertTransition(machine: MachineName, from: string, to: string, by: Actor): void {
  check(MACHINES[machine] as Transition<string>[], from, to, by);
}

export class TransitionError extends Error {
  override name = "TransitionError";
}

export const assertMilestone = (from: MilestoneStatus, to: MilestoneStatus, by: Actor) =>
  check(milestoneTransitions, from, to, by);
export const assertOffer = (from: OfferStatus, to: OfferStatus, by: Actor) => check(offerTransitions, from, to, by);
export const assertEngagement = (from: EngagementStatus, to: EngagementStatus, by: Actor) =>
  check(engagementTransitions, from, to, by);

export type PayoutStage = "kickoff" | "key_milestone" | "completion";

/**
 * Payout eligibility:
 *  kickoff        when the partner accepts the allocation
 *  key_milestone  when the milestone marked key is client-approved
 *  completion     when every milestone is client-approved
 */
export function payoutStagesEligible(
  accepted: boolean,
  milestones: Array<{ isKey: boolean; status: MilestoneStatus }>,
): PayoutStage[] {
  const stages: PayoutStage[] = [];
  if (accepted) stages.push("kickoff");
  if (milestones.some((m) => m.isKey && m.status === "client_approved")) stages.push("key_milestone");
  if (milestones.length > 0 && milestones.every((m) => m.status === "client_approved")) stages.push("completion");
  return stages;
}

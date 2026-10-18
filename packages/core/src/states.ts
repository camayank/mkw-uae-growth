/**
 * State machines. Each transition lists who may make it; anything not listed is refused.
 * A milestone is only complete on evidence: QA must pass evidence before the client can approve.
 */
export type RequestStatus = "draft" | "scoped" | "quoting" | "offered" | "closed";
export type OfferStatus = "draft" | "ops_review" | "published" | "accepted" | "expired" | "withdrawn";
export type EngagementStatus = "awaiting_payment" | "allocating" | "in_delivery" | "completed" | "cancelled" | "disputed";
export type MilestoneStatus =
  | "pending"
  | "in_progress"
  | "evidence_submitted"
  | "qa_passed"
  | "qa_rejected"
  | "client_approved"
  | "disputed";
export type PayoutStatus = "pending" | "eligible" | "released" | "withheld";
export type ChangeOrderStatus = "proposed" | "priced" | "approved" | "rejected";

type Actor = "client" | "partner" | "platform" | "system";

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

function check<S extends string>(table: Transition<S>[], from: S, to: S, by: Actor): void {
  const ok = table.some((t) => t.from === from && t.to === to && t.by.includes(by));
  if (!ok) throw new TransitionError(`${by} cannot move from ${from} to ${to}`);
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

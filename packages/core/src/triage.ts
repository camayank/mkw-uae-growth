import { addWorkingHours, UAE_CALENDAR, workingHoursBetween, type WorkCalendar } from "./sla.ts";

/**
 * The ops triage queue's order (O11). Every item gets a target time in working hours and a risk score built from a
 * few named factors; the score orders the queue and decides nothing. Each factor is returned as a sentence so ops
 * can see why an item sits where it does.
 */
export type QueueKind =
  | "system_alert"
  | "dispute"
  | "delivery_failed"
  | "delivery_unknown"
  | "offer_review"
  | "qa"
  | "unallocated"
  | "scoping"
  | "offer_ready"
  | "documents_overdue"
  | "needs_quote"
  | "obligation_evidence"
  | "obligation"
  | "delay"
  | "licence_expiring"
  | "payout"
  | "credit"
  | "partner_document"
  | "ai_draft"
  | "document_check"
  | "lead"
  | "partner_review";

export interface QueuePolicy {
  /** Working hours from the item's arrival to its target (one working day is 9 hours). */
  targetHours: number;
  /** How much the item matters before its clock is counted, 0 to 40. */
  weight: number;
  label: string;
}

export const QUEUE_POLICY: Record<QueueKind, QueuePolicy> = {
  system_alert: { targetHours: 1, weight: 40, label: "Platform alert" },
  dispute: { targetHours: 4, weight: 35, label: "Client raised an issue" },
  delivery_failed: { targetHours: 2, weight: 25, label: "Message not delivered" },
  delivery_unknown: { targetHours: 2, weight: 25, label: "Delivery not confirmed" },
  offer_review: { targetHours: 4, weight: 25, label: "Offer needs a price decision" },
  qa: { targetHours: 9, weight: 25, label: "Evidence to check" },
  unallocated: { targetHours: 4, weight: 25, label: "No partner for some lines" },
  scoping: { targetHours: 4, weight: 20, label: "Scoping advice to review" },
  offer_ready: { targetHours: 4, weight: 20, label: "Offer ready to publish" },
  documents_overdue: { targetHours: 9, weight: 20, label: "Client documents overdue" },
  needs_quote: { targetHours: 9, weight: 15, label: "Needs a request for quote" },
  obligation_evidence: { targetHours: 9, weight: 15, label: "Filing evidence to check" },
  obligation: { targetHours: 9, weight: 15, label: "Compliance date to confirm" },
  delay: { targetHours: 9, weight: 15, label: "Late step to attribute" },
  licence_expiring: { targetHours: 18, weight: 15, label: "Partner licence expiring" },
  payout: { targetHours: 18, weight: 15, label: "Payout ready" },
  credit: { targetHours: 18, weight: 10, label: "Guarantee credit for finance" },
  partner_document: { targetHours: 18, weight: 10, label: "Partner document to verify" },
  ai_draft: { targetHours: 9, weight: 10, label: "AI draft to decide" },
  document_check: { targetHours: 9, weight: 10, label: "Document check to confirm" },
  lead: { targetHours: 9, weight: 5, label: "Public lead for an existing account" },
  partner_review: { targetHours: 27, weight: 5, label: "Partner application to review" },
};

/** Facts about an item that raise its risk. Each is known to the caller from the item's own rows. */
export interface QueueSignals {
  /** A client cannot move until MKW acts. */
  clientWaiting?: boolean;
  /** A partner cannot move (or be paid) until MKW acts. */
  partnerWaiting?: boolean;
  /** Money is waiting to move (a payout, a credit, a refund). */
  moneyWaiting?: boolean;
  /** The partner on the engagement scored below the quality bar on its last scorecard. */
  weakPartner?: boolean;
}

export interface TriageItem {
  kind: QueueKind;
  /** When the item arrived in the queue. */
  at: Date;
  signals?: QueueSignals;
}

export interface Triage {
  dueAt: Date;
  /** Working hours left before the target (negative when past it). */
  hoursLeft: number;
  level: "overdue" | "due_soon" | "on_track";
  /** 0 to 100. Orders the queue; decides nothing. */
  risk: number;
  /** Why the item is ranked where it is, one sentence per factor. */
  factors: string[];
}

/** "Due soon" means within this many working hours of the target. */
export const DUE_SOON_HOURS = 2;

const hours = (h: number) => {
  const r = Math.round(h * 10) / 10;
  return `${r} working hour${r === 1 ? "" : "s"}`;
};

/** Arrival times older than this are counted from here: the result is the same (long overdue) and the clock stays fast. */
export const OLDEST_ARRIVAL_DAYS = 730;

export function triage(item: TriageItem, now: Date, cal: WorkCalendar = UAE_CALENDAR): Triage {
  const policy = QUEUE_POLICY[item.kind];
  // One bad row (a missing or absurd arrival time) must never take the whole queue down.
  const oldest = new Date(now.getTime() - OLDEST_ARRIVAL_DAYS * 86_400_000);
  const at = !Number.isFinite(item.at.getTime()) ? now : item.at < oldest ? oldest : item.at;
  const dueAt = addWorkingHours(at, policy.targetHours, cal);
  const hoursLeft = now <= dueAt ? workingHoursBetween(now, dueAt, cal) : -workingHoursBetween(dueAt, now, cal);
  const factors: string[] = [];
  let risk = policy.weight;
  let level: Triage["level"] = "on_track";
  if (now > dueAt) {
    level = "overdue";
    const late = -hoursLeft;
    risk += 30 + Math.min(20, Math.round(late * 2));
    factors.push(`${hours(late)} past its ${hours(policy.targetHours)} target`);
  } else if (hoursLeft <= DUE_SOON_HOURS) {
    level = "due_soon";
    risk += 15;
    factors.push(`${hours(hoursLeft)} left of its ${hours(policy.targetHours)} target`);
  }
  const s = item.signals ?? {};
  if (s.clientWaiting) {
    risk += 10;
    factors.push("a client is waiting on it");
  }
  if (s.partnerWaiting) {
    risk += 5;
    factors.push("a partner is waiting on it");
  }
  if (s.moneyWaiting) {
    risk += 5;
    factors.push("money is waiting to move");
  }
  if (s.weakPartner) {
    risk += 10;
    factors.push("the partner's last scorecard is below the quality bar");
  }
  if (!factors.length) factors.push("within its target");
  return { dueAt, hoursLeft, level, risk: Math.max(0, Math.min(100, risk)), factors };
}

/** Rank items: highest risk first, then the earliest target, then the oldest. */
export function rankQueue<T extends TriageItem>(items: T[], now: Date, cal: WorkCalendar = UAE_CALENDAR): Array<T & Triage> {
  return items
    .map((i) => ({ ...i, ...triage(i, now, cal) }))
    .sort((a, b) => b.risk - a.risk || a.dueAt.getTime() - b.dueAt.getTime() || a.at.getTime() - b.at.getTime());
}

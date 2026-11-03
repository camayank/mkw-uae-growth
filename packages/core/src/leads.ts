/**
 * Lead scoring and segments (E4). Two scores from the founder's answers and what they did on the public selector:
 * how complex the case is (how much a person must check before anything is priced) and how ready the founder is to
 * act. Both are heuristics that order a person's attention; they never decide anything for a lead, and they take
 * no commercial input (no partner, price list or margin).
 *
 * Pure and deterministic: the same answers and signals give the same scores, bounded 0 to 100.
 */
import type { AdviceInput } from "./advice.ts";

export type Segment = "starter" | "standard" | "complex" | "regulated" | "cross_border";

export interface LeadSignals {
  /** The founder saved the assessment and came back to it. */
  recovered?: number;
  /** A phone number was given. */
  phoneGiven?: boolean;
  /** The founder asked for a call. */
  consultationRequested?: boolean;
  /** Contradictions and missing facts the engine reported. */
  contradictions?: number;
  missingFacts?: number;
  /** The engine found no structure or place that fits. */
  noViableOption?: boolean;
}

export interface ScoreFactor {
  factor: string;
  points: number;
}

export interface LeadScore {
  /** Commercial value and complexity: what a person must check, and how much the case is worth looking after. */
  complexity: number;
  /** Purchase readiness: how ready the founder is to act. */
  intent: number;
  segment: Segment;
  highIntent: boolean;
  /** Why, in a person's words (both scores together, as E4 recorded them). */
  factors: string[];
  /** E7C: the evidence behind each score; the points of each list sum to that score less its base of 10. */
  evidence: { readiness: ScoreFactor[]; value: ScoreFactor[] };
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const REGULATED = new Set(["finance", "virtual_assets", "health", "education", "food"]);
/** Base each score starts from, so a founder who gave nothing still has a number a person can read. */
export const SCORE_BASE = 10;

export function scoreLead(a: AdviceInput, s: LeadSignals = {}): LeadScore {
  const factors: string[] = [];
  const value: ScoreFactor[] = [];
  const readiness: ScoreFactor[] = [];
  const v = (factor: string, points: number) => (value.push({ factor, points }), factors.push(factor));
  const r = (factor: string, points: number) => (readiness.push({ factor, points }), factors.push(factor));

  // Commercial value and complexity: what a person must check before pricing, and what the case is worth.
  if (a.activity && REGULATED.has(a.activity)) v("regulated activity", 35);
  if (a.activity === "holding") v("holding structure", 15);
  if (a.activity === "manufacturing" || a.premises === "industrial") v("industrial premises", 15);
  if (a.foreignTaxResident) v("owner tax resident abroad", 20);
  if (a.ownerType === "company") v("corporate owner", 15);
  if (a.customers === "both") v("customers onshore and abroad", 10);
  if ((a.visas ?? 0) >= 6) v(`${a.visas} visas`, 10);
  if (a.premises && !["none", "virtual", "office"].includes(a.premises)) v(`${a.premises} premises`, 10);
  if ((s.contradictions ?? 0) > 0) v("contradictory answers", 10);
  if ((s.missingFacts ?? 0) >= 3) v("several facts missing", 10);
  if (s.noViableOption) v("no option fits every answer", 15);
  // E7C: investment size and ongoing compliance (yearly tax, VAT and payroll work after setup).
  if ((a.budgetAed ?? 0) >= 100_000) v("setup budget of AED 100,000 or more", 10);
  if ((a.expectedTurnoverAed ?? 0) >= 1_000_000) v("expected revenue of AED 1 million or more", 10);
  else if ((a.expectedTurnoverAed ?? 0) >= 375_000) v("expected revenue above the VAT threshold", 5);
  if ((a.visas ?? 0) >= 3 && (a.visas ?? 0) < 6) v("a payroll of three or more", 5);

  // Purchase readiness: how ready the founder is to act.
  if (a.budgetAed != null && a.budgetAed > 0) r("budget given", 20);
  if ((a.visas ?? 0) > 0) r("visas needed", 10);
  if (a.freeZone) r("a place in mind", 10);
  if (a.activity && a.customers) r("activity and customers given", 10);
  if ((s.recovered ?? 0) > 0) r("came back to the saved result", 10);
  if (s.phoneGiven) r("phone number given", 10);
  if (s.consultationRequested) r("asked for a call", 15);
  // E7C: a start date, and an activity that is not "something else".
  if (a.startWithin === "1_month") r("wants to start within a month", 20);
  else if (a.startWithin === "3_months") r("wants to start within three months", 10);
  if (a.activity && a.activity !== "other") r("a clear activity", 5);

  const c = clamp(SCORE_BASE + value.reduce((n, x) => n + x.points, 0));
  const i = clamp(SCORE_BASE + readiness.reduce((n, x) => n + x.points, 0));
  // Regulated first (the regulator's approval is the first thing to check), then an owner abroad; a corporate owner
  // adds complexity but is not cross-border by itself.
  const segment: Segment = a.activity && REGULATED.has(a.activity) ? "regulated" : a.foreignTaxResident ? "cross_border" : c >= 50 ? "complex" : c <= 20 && (a.visas ?? 0) <= 2 ? "starter" : "standard";
  return { complexity: c, intent: i, segment, highIntent: i >= 60, factors, evidence: { readiness, value } };
}

/** What the pipeline knows about a lead when it chooses the next best action (E7C). */
export interface LeadState {
  status: "new" | "routed" | "contacted" | "consultation" | "converted" | "closed" | "anonymised";
  highIntent: boolean;
  intent: number;
  consultationRequested: boolean;
  hasOwner: boolean;
  /** An open follow-up and whether it is already due. */
  followupOpen: boolean;
  followupDue: boolean;
  /** What the lead's request became. */
  requestId: string | null;
  offerPublished: boolean;
  offerAccepted: boolean;
  engagement: boolean;
  /** Days since the lead arrived and since anything last happened to it. */
  daysSinceCreated: number;
  daysSinceUpdate: number;
}

export interface NextAction {
  action: string;
  why: string;
  /** The lead needs a person today. */
  urgent: boolean;
}

/**
 * The next best action for a lead, explained. A rule, not a model: it reads the lead's state only and names one
 * thing for the adviser to do. The adviser can override it with a reason; the override is shown beside this.
 */
export function nextBestAction(l: LeadState): NextAction {
  if (l.status === "anonymised") return { action: "Nothing: anonymised under the retention rule", why: "The personal data is gone; only the counts remain.", urgent: false };
  if (l.status === "closed") return { action: "Nothing: closed", why: "Reopen by setting a status only if the person comes back.", urgent: false };
  if (l.engagement || l.offerAccepted || l.status === "converted") return { action: "Nothing: the client is on the engagement", why: "An offer was accepted; what follows is on the engagement, not the lead.", urgent: false };
  if (l.offerPublished) return { action: "Chase the proposal", why: `An offer is published and not yet decided; a call settles it. ${l.daysSinceUpdate >= 3 ? "Nothing has happened for three days or more." : ""}`.trim(), urgent: l.daysSinceUpdate >= 3 };
  if (l.followupDue) return { action: "Do the follow-up that is due", why: "A person set a follow-up and its date has passed.", urgent: true };
  if (l.status === "new" && !l.hasOwner) return { action: "Assign an owner", why: l.highIntent ? "A high-readiness lead with nobody on it; every day costs." : "Nobody owns this lead yet; routing by segment is set on Settings.", urgent: l.highIntent };
  if (l.consultationRequested && !["consultation", "contacted"].includes(l.status)) return { action: "Book the call they asked for", why: "The founder asked for a call and gave their times; nothing is booked until a person does it.", urgent: true };
  if (["new", "routed"].includes(l.status)) return { action: l.highIntent ? "Call today" : "Make first contact", why: l.highIntent ? `Readiness ${l.intent}: budget, visas or a call request say they are ready; ${l.daysSinceCreated >= 2 ? "and two days have passed" : "do it while it is warm"}.` : "No contact yet; a first reply within a working day is the promise on the page.", urgent: l.highIntent || l.daysSinceCreated >= 2 };
  if (l.status === "contacted" && l.requestId && !l.offerPublished) return { action: "Get the proposal out", why: "The request exists and has no published offer: scoping or pricing is the bottleneck.", urgent: l.daysSinceUpdate >= 3 };
  if (l.status === "contacted" && !l.requestId) return { action: "Turn the enquiry into a request", why: "Contact was made but no request exists yet; the held enquiry is converted on the Pipeline.", urgent: false };
  if (l.status === "consultation") return { action: "Follow up after the call", why: l.followupOpen ? "A follow-up is set; keep to it." : "No follow-up is set after the call; set one so it reaches the queue.", urgent: !l.followupOpen && l.daysSinceUpdate >= 2 };
  return { action: "Review", why: "No rule matched; a person looks at the lead.", urgent: false };
}

/** Attribution captured on a public page: the UTM fields, the referrer and the landing page. Nothing else. */
export interface Attribution {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  term?: string | null;
  content?: string | null;
  referrer?: string | null;
  landing?: string | null;
  /** E7C: the random id the browser kept for the session on the public page, joining the funnel to the lead. */
  visitor?: string | null;
}

const clean = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
/** A landing page or referrer without a recovery code: the code is a capability to read the answers, never stored in clear. */
const withoutCode = (v: string | null) => (v ? v.replace(/([?&])code=[^&#]*(&?)/gi, (_m, p1: string, p2: string) => (p2 ? p1 : "")).replace(/[?&]$/, "") : v);

/** Keep the attribution to its known fields, each trimmed and bounded; anything else is dropped. */
export function cleanAttribution(raw: Record<string, unknown> | null | undefined): Attribution {
  const r = raw ?? {};
  return {
    source: clean(r.source ?? r.utm_source, 80),
    medium: clean(r.medium ?? r.utm_medium, 80),
    campaign: clean(r.campaign ?? r.utm_campaign, 80),
    term: clean(r.term ?? r.utm_term, 120),
    content: clean(r.content ?? r.utm_content, 120),
    referrer: withoutCode(clean(r.referrer, 300)),
    landing: withoutCode(clean(r.landing, 200)),
    visitor: /^[A-Za-z0-9_-]{8,32}$/.test(String(r.visitor ?? "")) ? String(r.visitor) : null,
  };
}

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

export interface LeadScore {
  complexity: number;
  intent: number;
  segment: Segment;
  highIntent: boolean;
  /** Why, in a person's words. */
  factors: string[];
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const REGULATED = new Set(["finance", "virtual_assets", "health", "education", "food"]);

export function scoreLead(a: AdviceInput, s: LeadSignals = {}): LeadScore {
  const factors: string[] = [];
  let complexity = 10;
  let intent = 10;

  // Complexity: what a person must check before pricing.
  if (a.activity && REGULATED.has(a.activity)) (complexity += 35), factors.push("regulated activity");
  if (a.activity === "holding") (complexity += 15), factors.push("holding structure");
  if (a.activity === "manufacturing" || a.premises === "industrial") (complexity += 15), factors.push("industrial premises");
  if (a.foreignTaxResident) (complexity += 20), factors.push("owner tax resident abroad");
  if (a.ownerType === "company") (complexity += 15), factors.push("corporate owner");
  if (a.customers === "both") (complexity += 10), factors.push("customers onshore and abroad");
  if ((a.visas ?? 0) >= 6) (complexity += 10), factors.push(`${a.visas} visas`);
  if (a.premises && !["none", "virtual", "office"].includes(a.premises)) (complexity += 10), factors.push(`${a.premises} premises`);
  if ((s.contradictions ?? 0) > 0) (complexity += 10), factors.push("contradictory answers");
  if ((s.missingFacts ?? 0) >= 3) (complexity += 10), factors.push("several facts missing");
  if (s.noViableOption) (complexity += 15), factors.push("no option fits every answer");

  // Intent: how ready the founder is to act.
  if (a.budgetAed != null && a.budgetAed > 0) (intent += 20), factors.push("budget given");
  if ((a.visas ?? 0) > 0) (intent += 10), factors.push("visas needed");
  if (a.freeZone) (intent += 10), factors.push("a place in mind");
  if (a.activity && a.customers) (intent += 10), factors.push("activity and customers given");
  if ((s.recovered ?? 0) > 0) (intent += 10), factors.push("came back to the saved result");
  if (s.phoneGiven) (intent += 10), factors.push("phone number given");
  if (s.consultationRequested) (intent += 15), factors.push("asked for a call");

  const c = clamp(complexity);
  const i = clamp(intent);
  // Regulated first (the regulator's approval is the first thing to check), then an owner abroad; a corporate owner
  // adds complexity but is not cross-border by itself.
  const segment: Segment = a.activity && REGULATED.has(a.activity) ? "regulated" : a.foreignTaxResident ? "cross_border" : c >= 50 ? "complex" : c <= 20 && (a.visas ?? 0) <= 2 ? "starter" : "standard";
  return { complexity: c, intent: i, segment, highIntent: i >= 60, factors };
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
  };
}

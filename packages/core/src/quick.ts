/**
 * The quick match (E8): four answers (what the business does, the emirate, the visas, a budget band) to the place a
 * founder should look at first, with live counts of the places still open as they answer. It is the same engine and
 * the same public filter as the full assessment (D80): a place counts as open unless an approved rule excluded it,
 * so a count only falls on a conclusion the public may see; a figure appears only for an approved place; and the
 * place shown first is the engine's own ranking, never a commercial choice.
 *
 * Pure. The caller loads the rules and places and decides what is approved.
 */
import { advise, type Activity, type AdviceInput, type ScopingRule, type Zone } from "./advice.ts";
import { assess, type EligibilityStatus } from "./eligibility.ts";
import { publicStatus, publicView, PUBLIC_DISCLAIMER, type PublicPlace } from "./public.ts";

export const QUICK_EMIRATES = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"] as const;

/** The budget bands the page offers, in AED; "open" is "more, or not sure yet" and filters nothing. An owner decision (D90). */
export const QUICK_BUDGETS = [
  { id: "up_to_15k", maxAed: 15_000 },
  { id: "up_to_25k", maxAed: 25_000 },
  { id: "up_to_50k", maxAed: 50_000 },
  { id: "open", maxAed: null },
] as const;
export type QuickBudget = (typeof QUICK_BUDGETS)[number]["id"];

export interface QuickAnswers {
  activity?: Activity;
  /** One of the seven emirates, or absent for "anywhere". */
  emirate?: string | null;
  visas?: number;
  budget?: QuickBudget;
}

/** A place as the quick match shows it: the public view of it, with its findings reduced to counts. */
export interface QuickPlace {
  zone: string;
  emirate: string;
  type: PublicPlace["type"];
  status: EligibilityStatus;
  figures?: PublicPlace["figures"];
  authority?: string | null;
  sourceUrl?: string;
  toBeVerified: boolean;
  /** Approved conditions on this place, and the points a person confirms (unapproved or unknown). */
  conditions: number;
  toConfirm: number;
}

export interface QuickMatch {
  disclaimer: string;
  asOf?: string;
  /** Places still open for every answer given, in the chosen emirate when one is chosen. */
  options: number;
  /** Places still open anywhere in the UAE, for the other answers. */
  everywhere: number;
  /** Places still open per emirate, for the other answers. */
  byEmirate: Record<string, number>;
  /** Places still open per budget band, for the other answers (in the chosen emirate when one is chosen). */
  byBudget: Array<{ id: QuickBudget; maxAed: number | null; options: number }>;
  /** The place to look at first, the engine's top-ranked open place; null when none is open. */
  best: QuickPlace | null;
  /** The chosen emirate has no open place, so `best` is the closest elsewhere. */
  bestElsewhere: boolean;
  /** The next two open places. */
  alternatives: QuickPlace[];
  /** The structure, only when every reason behind it is approved (as in the full assessment). */
  structure: { recommendation: string | null; confirmed: boolean };
  /** True only when the rules behind "no option fits" are approved. */
  noViableOption: boolean;
  approved: { places: number; ofPlaces: number };
}

export const budgetAed = (b: QuickBudget | undefined): number | null => QUICK_BUDGETS.find((x) => x.id === b)?.maxAed ?? null;

/** The engine's input for the quick answers: everything else is left unanswered, as the full assessment would. */
export const quickInput = (q: QuickAnswers, budget: QuickBudget | undefined = q.budget): AdviceInput => ({
  mode: "new_company",
  emirate: q.emirate ?? "",
  ...(q.activity ? { activity: q.activity } : {}),
  visas: q.visas ?? 0,
  budgetAed: budgetAed(budget),
});

const quickPlace = (p: PublicPlace): QuickPlace => ({
  zone: p.zone,
  emirate: p.emirate,
  type: p.type,
  status: p.status,
  ...(p.figures ? { figures: p.figures } : {}),
  ...(p.authority !== undefined ? { authority: p.authority } : {}),
  ...(p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}),
  toBeVerified: p.toBeVerified,
  conditions: p.findings.filter((f) => f.outcome === "condition").length,
  toConfirm: p.findings.filter((f) => f.toBeVerified || f.outcome === "unknown").length,
});

export function quickMatch(q: QuickAnswers, rules: ScopingRule[], zones: Zone[], approvedRules: ReadonlySet<string>, approvedPlaces: ReadonlySet<string>, asOf?: string): QuickMatch {
  // The counts: every place on record, open unless the public may see why it is excluded (the advice lists only its
  // first five fits, so the counts come from the eligibility check itself, which gives each place the same status).
  const openPlaces = (budget: QuickBudget | undefined) => {
    const r = assess(quickInput(q, budget), rules, zones, null);
    return [...r.viable, ...r.excluded].filter((p) => publicStatus(p.status, p.findings, approvedPlaces.has(p.zone), approvedRules) !== "INELIGIBLE");
  };
  const here = <T extends { emirate: string }>(places: T[]) => (q.emirate ? places.filter((p) => p.emirate === q.emirate) : places);
  const open = openPlaces(q.budget);
  const byEmirate = Object.fromEntries(QUICK_EMIRATES.map((e) => [e, open.filter((p) => p.emirate === e).length]));
  const byBudget = QUICK_BUDGETS.map((b) => ({ id: b.id, maxAed: b.maxAed, options: b.id === (q.budget ?? "open") ? here(open).length : here(openPlaces(b.id)).length }));
  // The ranking: the engine's own order, among the chosen emirate's places when it has an open one, else among all.
  const view = (zs: Zone[]) => publicView(advise(quickInput(q), rules, zs, asOf), approvedRules, approvedPlaces, asOf);
  const local = q.emirate && here(open).length ? view(zones.filter((z) => z.emirate === q.emirate)) : null;
  const shown = local ?? view(zones);
  const ranked = shown.places.filter((p) => p.status !== "INELIGIBLE");
  return {
    disclaimer: PUBLIC_DISCLAIMER,
    ...(asOf ? { asOf } : {}),
    options: here(open).length,
    everywhere: open.length,
    byEmirate,
    byBudget,
    best: ranked[0] ? quickPlace(ranked[0]) : null,
    bestElsewhere: !!q.emirate && !local && ranked.length > 0,
    alternatives: ranked.slice(1, 3).map(quickPlace),
    structure: { recommendation: shown.structure.recommendation, confirmed: shown.structure.confirmed },
    noViableOption: shown.noViableOption,
    approved: { places: here(open).filter((p) => approvedPlaces.has(p.zone)).length, ofPlaces: here(open).length },
  };
}

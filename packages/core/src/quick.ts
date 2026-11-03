/**
 * The quick match (E8): four answers (what the business does, the emirate, the visas, a budget band) to the places a
 * founder should review first, with live counts of the places not yet ruled out as they answer. It is the same engine and
 * the same public filter as the full assessment (D80): a place counts as open unless an approved rule excluded it,
 * so a count only falls on a conclusion the public may see; a figure appears only for an approved place; and the
 * places come in the public order (E13), which uses only approved facts and the founder's answers, never a
 * commercial choice.
 *
 * Pure. The caller loads the rules and places and decides what is approved.
 */
import { type Activity, type AdviceInput, type ScopingRule, type Zone } from "./advice.ts";
import { assess, type EligibilityStatus } from "./eligibility.ts";
import { publicAssessment, publicStatus, PUBLIC_DISCLAIMER, type PublicPlace } from "./public.ts";

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
  /** Places MKW holds on record per emirate, whatever the answers: a zero means "none on record", never "none fits". */
  onRecord: Record<string, number>;
  /** Places still open per budget band, for the other answers (in the chosen emirate when one is chosen). */
  byBudget: Array<{ id: QuickBudget; maxAed: number | null; options: number }>;
  /** The first open place in the public order (E13, D95); null when none is open. */
  best: QuickPlace | null;
  /**
   * E13: `best` may be named as "a place worth reviewing first": a named person approved it for public display, so what
   * put it first is on record. Otherwise the places are listed without a lead ("places to review").
   */
  lead: boolean;
  /** The chosen emirate has no open place, so `best` is the closest elsewhere. */
  bestElsewhere: boolean;
  /** The next two open places, in the public order. */
  alternatives: QuickPlace[];
  /** The structure, only when every reason behind it is approved (as in the full assessment). */
  structure: { recommendation: string | null; confirmed: boolean };
  /** True only when the rules behind "no option fits" are approved. */
  noViableOption: boolean;
  approved: { places: number; ofPlaces: number };
  /**
   * E11, the homepage's package cards: per kind of place, the places still open (for the answers given, in the chosen
   * emirate when one is chosen) and the lowest setup estimate among them that a named person approved for public
   * display (null: none approved, shown as "to be verified").
   */
  byType: Record<Zone["type"], { places: number; onRecord: number; fromFils: number | null; fromZone: string | null }>;
}

export const QUICK_TYPES: Array<Zone["type"]> = ["free_zone", "mainland", "financial", "offshore"];

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
  const isOpen = (p: { zone: string; status: EligibilityStatus; findings: Parameters<typeof publicStatus>[1] }) => publicStatus(p.status, p.findings, approvedPlaces.has(p.zone), approvedRules) !== "INELIGIBLE";
  // The counts: every place on record, open unless the public may see why it is excluded (the advice lists only its
  // first five fits, so the counts come from the eligibility check itself, which gives each place the same status).
  const openPlaces = (budget: QuickBudget | undefined) => {
    const r = assess(quickInput(q, budget), rules, zones, null);
    return [...r.viable, ...r.excluded].filter(isOpen);
  };
  const here = <T extends { emirate: string }>(places: T[]) => (q.emirate ? places.filter((p) => p.emirate === q.emirate) : places);
  const open = openPlaces(q.budget);
  const byEmirate = Object.fromEntries(QUICK_EMIRATES.map((e) => [e, open.filter((p) => p.emirate === e).length]));
  const onRecord = Object.fromEntries(QUICK_EMIRATES.map((e) => [e, zones.filter((z) => z.emirate === e).length]));
  const byBudget = QUICK_BUDGETS.map((b) => ({ id: b.id, maxAed: b.maxAed, options: b.id === (q.budget ?? "open") ? here(open).length : here(openPlaces(b.id)).length }));
  // The full public assessment on these answers, over every place: its structure, its "no option fits" and its order
  // are the quick match's, so "see the full comparison" never opens on a different conclusion or a different first
  // place. The order uses only what the public may see (E13, D95). Within the chosen emirate when it has an open place
  // there, else across the UAE.
  const fullView = publicAssessment(quickInput(q), rules, zones, approvedRules, approvedPlaces, asOf);
  const local = here(fullView.places);
  const ranked = (local.length ? local : fullView.places).slice(0, 3);
  return {
    disclaimer: PUBLIC_DISCLAIMER,
    ...(asOf ? { asOf } : {}),
    options: here(open).length,
    everywhere: open.length,
    byEmirate,
    onRecord,
    byBudget,
    best: ranked[0] ? quickPlace(ranked[0]) : null,
    lead: !!ranked[0] && !ranked[0].toBeVerified,
    bestElsewhere: !!q.emirate && !local.length && ranked.length > 0,
    alternatives: ranked.slice(1, 3).map(quickPlace),
    structure: { recommendation: fullView.structure.recommendation, confirmed: fullView.structure.confirmed },
    noViableOption: fullView.noViableOption,
    approved: { places: here(open).filter((p) => approvedPlaces.has(p.zone)).length, ofPlaces: here(open).length },
    byType: Object.fromEntries(
      QUICK_TYPES.map((t) => {
        const ofType = here(open).filter((p) => p.type === t);
        // The figure is one approved place's, named with it: never a claim about the whole kind.
        const cheapest = ofType.filter((p) => approvedPlaces.has(p.zone) && p.costMinFils > 0).sort((x, y) => x.costMinFils - y.costMinFils || x.zone.localeCompare(y.zone))[0];
        const onRecord = zones.filter((z) => z.type === t && (!q.emirate || z.emirate === q.emirate)).length;
        return [t, { places: ofType.length, onRecord, fromFils: cheapest?.costMinFils ?? null, fromZone: cheapest?.zone ?? null }];
      }),
    ) as QuickMatch["byType"],
  };
}

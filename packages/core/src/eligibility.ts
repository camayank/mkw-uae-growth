/**
 * Eligibility before recommendation (E1). Every structure and every place is first checked against explicit rules:
 * a confirmed incompatibility excludes it, a requirement the founder must meet is a condition, a fact nobody has
 * given (or a rule nobody has verified) needs verification, and data we do not hold is said to be missing. Only what
 * survives is ranked, and the ranking uses the founder's preferences, never MKW's commercial terms: no partner,
 * price list or margin is an input here.
 *
 * Pure and deterministic: the rules and places come in with their confidence, so no outcome is more certain than
 * the evidence behind it. Every finding names the rule it came from, for the audit trail and the reviewer.
 */
import type { Activity, AdviceInput, Confidence, ScopingRule, Zone } from "./advice.ts";

export const ELIGIBILITY_ENGINE_VERSION = "e1.2";

export type EligibilityStatus = "ELIGIBLE_VERIFIED" | "ELIGIBLE_CONDITIONAL" | "REQUIRES_VERIFICATION" | "INELIGIBLE" | "DATA_UNAVAILABLE";
export type Structure = "free_zone" | "mainland" | "offshore" | "difc_adgm";
export const STRUCTURES: Structure[] = ["free_zone", "mainland", "offshore", "difc_adgm"];

/**
 * One check's result. `fail` excludes; `condition` is something the founder must obtain or arrange; `unknown` is a
 * gap: a fact the founder has not given (`fact`), a point a qualified person must confirm (`check`), or data MKW does
 * not hold (`data`); `pass` is a check that holds.
 */
export interface Finding {
  ruleKey: string;
  outcome: "pass" | "fail" | "condition" | "unknown";
  text: string;
  confidence: Confidence;
  missing?: "fact" | "check" | "data";
}

export interface StructureAssessment {
  structure: Structure;
  status: EligibilityStatus;
  findings: Finding[];
}

export interface PlaceAssessment {
  zone: string;
  emirate: string;
  type: Zone["type"];
  structure: Structure;
  status: EligibilityStatus;
  findings: Finding[];
  visaQuota: number;
  costMinFils: number;
  costMaxFils: number;
  timelineDays: number;
  /** The place data's own confidence (cost, visas, timeline). */
  confidence: Confidence;
  /** Plain-English reasons it ranks where it does (preferences, not eligibility). */
  why: string[];
}

const ORDER: EligibilityStatus[] = ["ELIGIBLE_VERIFIED", "ELIGIBLE_CONDITIONAL", "REQUIRES_VERIFICATION", "DATA_UNAVAILABLE", "INELIGIBLE"];
export const statusRank = (s: EligibilityStatus) => ORDER.indexOf(s);
export const isViable = (s: EligibilityStatus) => s !== "INELIGIBLE";

const CONFIDENCE_ORDER: Confidence[] = ["UNCERTAIN", "rule_of_thumb", "verified"];
/** The weaker of two confidences: a statement is never more certain than the least certain thing behind it. */
export const weaker = (x: Confidence, y: Confidence): Confidence => (CONFIDENCE_ORDER.indexOf(x) <= CONFIDENCE_ORDER.indexOf(y) ? x : y);

/**
 * The status a set of findings supports. An exclusion wins; then missing data; then anything unconfirmed (a missing
 * fact, a point to check, or a rule or data row nobody has verified); then conditions; only then verified.
 */
export function statusOf(findings: Finding[]): EligibilityStatus {
  // Nothing checked is not the same as nothing wrong.
  if (findings.length === 0) return "REQUIRES_VERIFICATION";
  if (findings.some((f) => f.outcome === "fail")) return "INELIGIBLE";
  if (findings.some((f) => f.outcome === "unknown" && f.missing === "data")) return "DATA_UNAVAILABLE";
  if (findings.some((f) => f.outcome === "unknown" || f.confidence !== "verified")) return "REQUIRES_VERIFICATION";
  if (findings.some((f) => f.outcome === "condition")) return "ELIGIBLE_CONDITIONAL";
  return "ELIGIBLE_VERIFIED";
}

const REGULATED_FINANCE: Activity[] = ["finance"];
const PREMISES_ACTIVITIES: Activity[] = ["food", "health", "construction", "manufacturing"];

/** Whether the founder needs a physical place of business in the UAE (shop, clinic, site, plant, warehouse, office). */
function needsPremises(a: AdviceInput): boolean | null {
  if (a.premises) return a.premises !== "none" && a.premises !== "virtual";
  if (a.officeNeeded !== undefined) return a.officeNeeded;
  if (a.activity && PREMISES_ACTIVITIES.includes(a.activity)) return true;
  return null;
}
const sellsOnshore = (a: AdviceInput) => (a.customers === undefined ? null : a.customers === "uae_mainland" || a.customers === "both");

export class Rulebook {
  constructor(private readonly rules: ScopingRule[]) {}
  confidence(key: string): Confidence {
    return this.rules.find((r) => r.key === key)?.confidence ?? "UNCERTAIN";
  }
  /** A finding under a named rule, as confident as that rule. */
  f(ruleKey: string, outcome: Finding["outcome"], text: string, missing?: Finding["missing"]): Finding {
    return { ruleKey, outcome, text, confidence: this.confidence(ruleKey), ...(missing ? { missing } : {}) };
  }
}

/** Structure-level checks: what the law of the structure allows, whatever the place. */
export function assessStructure(s: Structure, a: AdviceInput, book: Rulebook): StructureAssessment {
  const out: Finding[] = [];
  const visas = a.visas ?? 0;
  const premises = needsPremises(a);
  const onshore = sellsOnshore(a);
  const act = a.activity;

  if (s === "offshore") {
    if (visas > 0) out.push(book.f("structure.offshore_no_visas", "fail", "An offshore company cannot sponsor residence visas, and the founder needs " + visas + "."));
    if (premises) out.push(book.f("structure.offshore_no_premises", "fail", "An offshore company cannot lease premises or operate a place of business in the UAE."));
    if (onshore) out.push(book.f("structure.offshore_no_onshore_trade", "fail", "An offshore company cannot trade with customers in the UAE."));
    if (act && (REGULATED_FINANCE.includes(act) || act === "virtual_assets")) out.push(book.f("structure.financial_regulated", "fail", "Regulated financial and virtual-asset activities need a regulator's licence; an offshore company cannot hold one."));
    if (act === "holding") out.push(book.f("structure.holding", "pass", "An offshore company can hold shares and assets for a group with no UAE operations."));
    else if (act) out.push(book.f("structure.offshore_activity", "unknown", "Offshore companies suit holding and some international activities; whether this activity is allowed must be confirmed with the registry.", "check"));
    else out.push(book.f("structure.offshore_activity", "unknown", "The activity is not known yet.", "fact"));
    if (visas === 0 && a.visas === undefined) out.push(book.f("structure.offshore_no_visas", "unknown", "Whether anyone needs a residence visa is not known yet.", "fact"));
  }

  if (s === "free_zone") {
    // The "finance" answer is regulated financial services (banking, lending, investment, insurance, payments; the
    // question says so); accounting and bookkeeping are "consulting". A regulated activity cannot run on a commercial
    // free zone licence.
    if (act === "finance") out.push(book.f("structure.financial_regulated", "fail", "A regulated financial activity needs a regulator-specific licence (DFSA in DIFC, FSRA in ADGM, or the Central Bank or SCA onshore); a commercial free zone licence is not enough."));
    if (act === "virtual_assets") out.push(book.f("structure.virtual_assets_regulated", "condition", "Virtual-asset activities need the regulator's licence on top of the company licence: VARA in Dubai, the SCA in the other emirates."));
    if (onshore) out.push(book.f("structure.free_zone_mainland_sales", "condition", "Selling to customers on the mainland from a free zone needs a distributor, a mainland branch or an activity-specific permit; which applies depends on the activity and emirate."));
    if (premises && onshore) out.push(book.f("structure.free_zone_onshore_premises", "condition", "A shop, clinic or site outside the zone needs a mainland licence or branch; the free zone licence covers premises inside the zone only."));
    if (act === "health") out.push(book.f("licence.health", "condition", "Health activities need DHA, DoH or MOHAP approval and licensed premises."));
    if (act === "education") out.push(book.f("licence.education", "condition", "Education and training activities need KHDA, ADEK or the relevant ministry's approval."));
    if (act === "food") out.push(book.f("licence.food", "condition", "Food businesses need municipality food-safety approval and premises inspection."));
    if (act === "manufacturing") out.push(book.f("structure.industrial_licence", "condition", "Manufacturing needs an industrial licence and an industrial plot or unit with the utilities it needs."));
    if (act === "holding") out.push(book.f("structure.holding_free_zone", "unknown", "Some free zones license holding companies; which ones, and on what terms, must be confirmed.", "check"));
    if (!act) out.push(book.f("structure.free_zone_default", "unknown", "The activity is not known yet.", "fact"));
    else if (!out.some((f) => f.outcome !== "pass")) out.push(book.f("structure.free_zone_default", "pass", "A free zone licence suits this activity for customers outside the mainland, with full foreign ownership."));
  }

  if (s === "mainland") {
    if (act === "finance") out.push(book.f("structure.financial_regulated", "condition", "Regulated financial activity onshore needs Central Bank or SCA licensing before the trade licence."));
    if (act === "virtual_assets") out.push(book.f("structure.virtual_assets_regulated", "condition", "Virtual-asset activity onshore needs VARA (Dubai) or SCA approval."));
    if (act === "health") out.push(book.f("licence.health", "condition", "Health activities need DHA, DoH or MOHAP approval and licensed premises."));
    if (act === "education") out.push(book.f("licence.education", "condition", "Education and training activities need KHDA, ADEK or the relevant ministry's approval."));
    if (act === "food") out.push(book.f("licence.food", "condition", "Food businesses need municipality food-safety approval and premises inspection."));
    if (act === "manufacturing") out.push(book.f("structure.industrial_licence", "condition", "Manufacturing needs an industrial licence and an industrial plot or unit with the utilities it needs."));
    if (act === "holding") out.push(book.f("structure.mainland_holding", "unknown", "Mainland companies can hold shares, but a pure holding vehicle is more often set up offshore, in a free zone or in DIFC/ADGM; confirm the mainland route is worth its cost.", "check"));
    if (act && act !== "holding") out.push(book.f("structure.mainland_foreign_ownership", "unknown", "Full foreign ownership is allowed for most mainland activities; a few strategic activities need approvals or a UAE national shareholder. Confirm for the exact activity.", "check"));
    if (!act) out.push(book.f("structure.mainland_onshore", "unknown", "The activity is not known yet.", "fact"));
    if (onshore || premises) out.push(book.f("structure.mainland_onshore", "pass", "A mainland licence can trade anywhere onshore and lease premises outside the free zones."));
  }

  if (s === "difc_adgm") {
    if (act === "finance") out.push(book.f("structure.financial_regulated", "condition", "The activity needs DFSA (DIFC) or FSRA (ADGM) authorisation before it starts; capital and staffing rules depend on the activity."));
    if (act === "virtual_assets") out.push(book.f("structure.virtual_assets_regulated", "condition", "Virtual-asset activity in ADGM needs FSRA authorisation; DIFC has its own regime under the DFSA."));
    if (act === "holding") out.push(book.f("structure.holding", "pass", "DIFC and ADGM offer holding and special-purpose vehicles under common law."));
    if (onshore) out.push(book.f("structure.free_zone_mainland_sales", "condition", "Selling to customers on the mainland from DIFC or ADGM needs an onshore arrangement; confirm what applies."));
    if (premises && onshore) out.push(book.f("structure.free_zone_onshore_premises", "condition", "Premises outside the financial free zone need a mainland licence or branch."));
    if (act && !["finance", "virtual_assets", "holding"].includes(act)) out.push(book.f("structure.financial_zone_non_financial", "unknown", "DIFC and ADGM also license some non-financial businesses; confirm this activity and its cost against the alternatives.", "check"));
    if (!act) out.push(book.f("structure.financial_regulated", "unknown", "The activity is not known yet.", "fact"));
  }

  return { structure: s, status: statusOf(out), findings: out };
}

const structureOfZone = (z: Zone): Structure => (z.type === "financial" ? "difc_adgm" : z.type);

/** Place-level checks: the package and the facts we hold about one place, on top of its structure's findings. */
export function assessPlace(z: Zone, structure: StructureAssessment, a: AdviceInput, book: Rulebook): PlaceAssessment {
  const out: Finding[] = [...structure.findings];
  const placeFinding = (ruleKey: string, outcome: Finding["outcome"], text: string, missing?: Finding["missing"]): Finding => ({
    ruleKey,
    outcome,
    text,
    // A place finding is as confident as the weaker of its rule and the place's own data.
    confidence: weaker(book.confidence(ruleKey), z.confidence),
    ...(missing ? { missing } : {}),
  });
  const visas = a.visas ?? 0;
  if (z.visaMax != null && visas > z.visaMax) out.push(placeFinding("place.visa_capacity", "fail", `${z.name} allows at most ${z.visaMax} visa(s); the founder needs ${visas}.`));
  else if (visas > z.visaQuota) out.push(placeFinding("place.visa_package", "condition", `The standard package covers ${z.visaQuota} visa(s); ${visas} need a larger package or more office space. That cost is not in the estimate.`));
  else if (visas > 0) out.push(placeFinding("place.visa_package", "pass", `The standard package covers the ${visas} visa(s) needed.`));

  if (a.budgetAed != null && a.budgetAed > 0) {
    const budget = Math.round(a.budgetAed * 100);
    if (!z.costMinFils || !z.costMaxFils) out.push(placeFinding("place.cost_estimate", "unknown", `No cost estimate is held for ${z.name}.`, "data"));
    else if (z.costMinFils > budget) out.push(placeFinding("place.budget", "fail", `The lowest estimated setup cost is above the stated budget of AED ${a.budgetAed.toLocaleString("en-US")}.`));
    else if (z.costMaxFils > budget) out.push(placeFinding("place.budget", "condition", "The estimate's upper end is above the stated budget; the package chosen decides which."));
    else out.push(placeFinding("place.budget", "pass", "The estimated setup cost is within the stated budget."));
  }

  // Sector strength is a preference, never permission: the authority's own activity list decides (E2).
  if (a.activity && a.activity !== "holding") out.push(placeFinding("place.activity_listed", "unknown", `Whether ${z.name} licenses this exact activity must be confirmed against its activity list.`, "check"));

  if (a.activity === "manufacturing") {
    if (z.facilities && !z.facilities.includes("industrial")) out.push(placeFinding("place.industrial_facilities", "fail", `${z.name} has no industrial plots or units on record.`));
    else if (!z.facilities) out.push(placeFinding("place.industrial_facilities", "unknown", `Industrial land and utilities at ${z.name} are not on record.`, "data"));
  }
  if (a.premises === "warehouse" && z.facilities && !z.facilities.includes("warehouse")) {
    out.push(placeFinding("place.warehouse_facilities", "fail", `${z.name} has no warehousing on record.`));
  }

  const why: string[] = [];
  if (z.emirate === a.emirate) why.push(`in ${a.emirate}`);
  if (a.activity && z.activities.includes(a.activity)) why.push(`known for ${a.activity.replace(/_/g, " ")} businesses`);
  if (a.freeZone && z.name.toLowerCase() === a.freeZone.toLowerCase()) why.push("the place you named");
  if (visas > 0 && visas <= z.visaQuota) why.push(`${z.visaQuota} visa(s) in the standard package`);
  return {
    zone: z.name,
    emirate: z.emirate,
    type: z.type,
    structure: structure.structure,
    status: statusOf(out),
    findings: out,
    visaQuota: z.visaQuota,
    costMinFils: z.costMinFils,
    costMaxFils: z.costMaxFils,
    timelineDays: z.timelineDays,
    confidence: z.confidence,
    why,
  };
}

/** Preference score among places that survived the checks. No commercial input exists to weigh. */
function preference(p: PlaceAssessment, a: AdviceInput, preferred: Structure | null): number {
  let s = 0;
  if (preferred && p.structure === preferred) s += 10;
  if (a.freeZone && p.zone.toLowerCase() === a.freeZone.toLowerCase()) s += 5;
  if (p.emirate === a.emirate) s += 3;
  if (a.activity && p.why.some((w) => w.startsWith("known for"))) s += 2;
  if ((a.visas ?? 0) <= p.visaQuota) s += 1;
  return s;
}

export interface Assessment {
  version: string;
  structures: StructureAssessment[];
  /** Viable places, best first (eligibility status, then the founder's preferences). */
  viable: PlaceAssessment[];
  /** Places excluded, with the findings that excluded them. */
  excluded: PlaceAssessment[];
}

export function assess(a: AdviceInput, rules: ScopingRule[], zones: Zone[], preferred: Structure | null): Assessment {
  const book = new Rulebook(rules);
  const structures = STRUCTURES.map((s) => assessStructure(s, a, book));
  const byStructure = new Map(structures.map((s) => [s.structure, s]));
  const places = zones.map((z) => assessPlace(z, byStructure.get(structureOfZone(z))!, a, book));
  // The recommended structure's places first, then the other viable structures by their status; within each, the
  // place's own status, then the founder's preferences, then the lower estimate.
  const group = (p: PlaceAssessment) => (p.structure === preferred ? -1 : statusRank(byStructure.get(p.structure)!.status));
  const viable = places
    .filter((p) => isViable(p.status))
    .sort((x, y) => group(x) - group(y) || statusRank(x.status) - statusRank(y.status) || preference(y, a, preferred) - preference(x, a, preferred) || x.costMinFils - y.costMinFils || x.zone.localeCompare(y.zone));
  // When the founder named a place, keep it first if it is viable and of the recommended structure (a place of
  // another structure never jumps ahead of the recommendation), whatever its status rank.
  if (a.freeZone) {
    const i = viable.findIndex((p) => p.zone.toLowerCase() === a.freeZone!.toLowerCase());
    if (i > 0 && (!preferred || viable[i]!.structure === preferred)) viable.unshift(...viable.splice(i, 1));
  }
  const excluded = places.filter((p) => !isViable(p.status)).sort((x, y) => x.zone.localeCompare(y.zone));
  return { version: ELIGIBILITY_ENGINE_VERSION, structures, viable, excluded };
}

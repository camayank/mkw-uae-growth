/**
 * The public view of an advice (E3). The owner authorised, on 2 Nov 2026, that the public selector shows only
 * statements and figures a named person has approved for public display, once per version (D80). This module
 * applies that: from an advice and the sets of approved rule keys and place names, it keeps approved text and
 * figures and turns everything else into a placeholder that says "to be verified" and carries no text, no figure,
 * no rule key and no outcome. A conclusion (a recommendation, an exclusion, "no option fits") is shown only when
 * every rule it rests on is approved.
 *
 * Pure. It never reads the rules or places itself; the caller decides what is approved.
 */
import { advise, asCandidate, type Advice, type AdviceInput, type Candidate, type Reasoned, type ScopingRule, type Zone } from "./advice.ts";
import { assess, ELIGIBILITY_ENGINE_VERSION, statusRank, type EligibilityStatus, type Finding, type Structure } from "./eligibility.ts";

export const PUBLIC_DISCLAIMER =
  "This is preliminary, general information from your answers, not advice. Rules and figures change, and only the points marked as checked have been approved for public display by a named person at MKW Advisors. Nothing here is a statutory conclusion. Ask for a review and a person will confirm what applies to you before anything is priced or filed.";

/** What an unapproved statement is about, in neutral words: never the rule key, which would state the conclusion. */
const TOPIC: Record<string, string> = { structure: "a point about the structure", place: "a point about this place", licence: "a licence or approval", obligation: "an obligation after setup", crossborder: "a cross-border point" };
export const topicOf = (ruleKey: string): string => TOPIC[ruleKey.split(".")[0] ?? ""] ?? "a point";

export interface PublicStatement {
  /** What the statement is about, always; the rule key itself only when approved. */
  topic: string;
  ruleKey?: string;
  text?: string;
  toBeVerified: boolean;
}

export interface PublicFinding extends PublicStatement {
  /** Only when approved: an unapproved finding says nothing about passing or failing. */
  outcome?: Finding["outcome"];
}

export interface PublicStructure {
  structure: Structure;
  /** `INELIGIBLE` only when the failing rule is approved; otherwise the status softens to REQUIRES_VERIFICATION. */
  status: EligibilityStatus;
  findings: PublicFinding[];
}

export interface PublicPlace {
  zone: string;
  emirate: string;
  type: Candidate["type"];
  /** Only for approved places. */
  authority?: string | null;
  status: EligibilityStatus;
  /** Figures appear only when the place is approved for public display. */
  figures?: { visaQuota: number; costMinFils: number; costMaxFils: number; timelineDays: number; renewalMinFils?: number | null; renewalMaxFils?: number | null; renewalToBeVerified?: boolean };
  /** E7A, only for approved places: the official source behind the figures, and the facilities on record (null: not on record). */
  sourceUrl?: string;
  facilities?: string[] | null;
  findings: PublicFinding[];
  /** Preferences in the founder's words, only for approved places. */
  why: string[];
  toBeVerified: boolean;
}

export interface PublicAssessment {
  disclaimer: string;
  structure: { recommendation: Structure | null; confirmed: boolean; reasons: PublicStatement[] };
  structures: PublicStructure[];
  places: PublicPlace[];
  excluded: PublicPlace[];
  licences: PublicStatement[];
  obligations: PublicStatement[];
  crossBorder: PublicStatement[];
  missingFacts: string[];
  contradictions: string[];
  /** `recommendation` is null unless every reason behind it is approved (then `confirmed` is true). */
  /** True only when the rules behind "no option fits" are approved. */
  noViableOption: boolean;
  /** How much of the result a person has approved for public display. */
  approved: { statements: number; ofStatements: number; places: number; ofPlaces: number };
  engineVersion?: string;
  asOf?: string;
  /** E7A: general guidance notes approved for public display, chosen from the answers; filled by the service. */
  guidance?: PublicGuide[];
}

export interface PublicGuide {
  id: string;
  title: string;
  text: string;
  about: string;
}

/** Contradictions that restate a rule are shown only when that rule is approved; the rest are the founder's own answers. */
const CONTRADICTION_RULES: Array<[RegExp, string]> = [
  [/offshore company and \d+ residence visa/, "structure.offshore_no_visas"],
  [/offshore company and premises/, "structure.offshore_no_premises"],
  [/offshore company and customers in the UAE/, "structure.offshore_no_onshore_trade"],
  [/pure holding company does not sell/, "structure.holding"],
];

/** A finding the public may read: its rule approved and, for a place rule (it carries the place's figures), the place too. */
export const publicFindingOk = (f: Finding, placeApproved: boolean, approvedRules: ReadonlySet<string>): boolean =>
  !!f.ruleKey && approvedRules.has(f.ruleKey) && (placeApproved || !f.ruleKey.startsWith("place."));

/** The status the public sees: an exclusion needs its failing rule approved; a fit needs every finding approved. */
export function publicStatus(status: EligibilityStatus, findings: Finding[], placeApproved: boolean, approvedRules: ReadonlySet<string>): EligibilityStatus {
  if (status === "INELIGIBLE") return findings.some((f) => f.outcome === "fail" && publicFindingOk(f, placeApproved, approvedRules)) ? "INELIGIBLE" : "REQUIRES_VERIFICATION";
  if (status === "ELIGIBLE_VERIFIED" || status === "ELIGIBLE_CONDITIONAL") return findings.every((f) => publicFindingOk(f, placeApproved, approvedRules)) ? status : "REQUIRES_VERIFICATION";
  return status;
}

const structureOfType = (t: Candidate["type"]): Structure => (t === "financial" ? "difc_adgm" : t);

/**
 * E13 (D95): the order of places on every public screen. It is the engine's order (`assess`) computed on what the
 * public may see only, so an unapproved condition or estimate never puts one place ahead of another while the reason
 * stays hidden:
 * 1. the structure, when the public may see it is the recommended one, then the other structures by the status the
 *    public sees;
 * 2. the place's status as the public sees it (`publicStatus`; for an unapproved place "data unavailable" orders like
 *    "to be verified", since it comes from the place's unapproved record);
 * 3. the founder's own answers (the place they named, the emirate they chose) and, for an approved place only, what
 *    its approved record says (it lists the activity; its standard package covers the visas), with the engine's weights;
 * 4. an approved place's lowest setup estimate, ahead of places with no approved estimate;
 * 5. the name.
 * The place the founder named leads, as in the engine, unless it is of another structure than the confirmed one.
 * With nothing approved this is the founder's answers, then the name. With everything approved it is the engine's
 * order exactly (a core test holds both). Staff keep the engine's order, which uses everything on record.
 */
export function publicOrder(places: Candidate[], approvedRules: ReadonlySet<string>, approvedPlaces: ReadonlySet<string>, confirmed: Structure | null, structureStatus: ReadonlyMap<Structure, EligibilityStatus>): Candidate[] {
  const named = (p: Candidate) => p.why.includes("the place you named");
  const keyed = places.map((p) => {
    const ok = approvedPlaces.has(p.zone);
    const structure = structureOfType(p.type);
    const group = confirmed && structure === confirmed ? -1 : statusRank(structureStatus.get(structure) ?? "REQUIRES_VERIFICATION");
    // "Data unavailable" on an unapproved place comes from its unapproved record (what it lists, its facilities): it
    // orders like "to be verified", so no unchecked record moves a place.
    const shown = publicStatus(p.status ?? "REQUIRES_VERIFICATION", p.findings ?? [], ok, approvedRules);
    const status = statusRank(!ok && shown === "DATA_UNAVAILABLE" ? "REQUIRES_VERIFICATION" : shown);
    const has = (f: (w: string) => boolean) => p.why.some(f);
    const score = (named(p) ? 5 : 0) + (has((w) => w.startsWith("in ")) ? 3 : 0) + (ok ? (has((w) => w.startsWith("known for")) ? 2 : 0) + (has((w) => w.endsWith("visa(s) in the standard package")) ? 1 : 0) : 0);
    const cost = ok ? p.costMinFils : Number.POSITIVE_INFINITY;
    return { p, group, status, score, cost };
  });
  keyed.sort((x, y) => x.group - y.group || x.status - y.status || y.score - x.score || (x.cost === y.cost ? 0 : x.cost < y.cost ? -1 : 1) || x.p.zone.localeCompare(y.p.zone));
  const out = keyed.map((k) => k.p);
  const i = out.findIndex(named);
  if (i > 0 && (!confirmed || structureOfType(out[i]!.type) === confirmed)) out.unshift(...out.splice(i, 1));
  return out;
}

/**
 * The public assessment of a founder's answers (E3, E13): the engine over every place on record (not only the advice's
 * first five, which the engine chose on everything it holds), filtered to what is approved and in the public order.
 */
export function publicAssessment(input: AdviceInput, rules: ScopingRule[], zones: Zone[], approvedRules: ReadonlySet<string>, approvedPlaces: ReadonlySet<string>, asOf?: string): PublicAssessment {
  const advice = advise(input, rules, zones, asOf);
  return publicView({ ...advice, places: assess(input, rules, zones, null).viable.map(asCandidate) }, approvedRules, approvedPlaces, asOf);
}

export function publicView(a: Advice, approvedRules: ReadonlySet<string>, approvedPlaces: ReadonlySet<string>, asOf?: string): PublicAssessment {
  const ruleOk = (key: string | undefined) => !!key && approvedRules.has(key);
  const statement = (r: Reasoned): PublicStatement => {
    const ok = ruleOk(r.ruleKey) && (r.basedOn ?? []).every((k) => approvedRules.has(k));
    return { topic: topicOf(r.ruleKey ?? ""), ...(ok ? { ruleKey: r.ruleKey, text: r.text } : {}), toBeVerified: !ok };
  };
  const findingOk = (f: Finding, placeApproved: boolean) => publicFindingOk(f, placeApproved, approvedRules);
  const finding = (f: Finding, placeApproved: boolean): PublicFinding => {
    const ok = findingOk(f, placeApproved);
    return { topic: topicOf(f.ruleKey), ...(ok ? { ruleKey: f.ruleKey, text: f.text, outcome: f.outcome } : {}), toBeVerified: !ok };
  };
  const softStatus = (status: EligibilityStatus, findings: Finding[], placeApproved: boolean): EligibilityStatus => publicStatus(status, findings, placeApproved, approvedRules);
  const place = (p: Candidate): PublicPlace => {
    const ok = approvedPlaces.has(p.zone);
    const findings = (p.findings ?? []).map((f) => finding(f, ok));
    // A renewal estimate is shown only when its own evidence is at least a rule of thumb.
    const renewal = ok && p.renewalMinFils != null && p.renewalConfidence && p.renewalConfidence !== "UNCERTAIN";
    return {
      zone: p.zone,
      emirate: p.emirate,
      type: p.type,
      ...(ok && p.authority !== undefined ? { authority: p.authority } : {}),
      status: softStatus(p.status ?? "REQUIRES_VERIFICATION", p.findings ?? [], ok),
      ...(ok ? { figures: { visaQuota: p.visaQuota, costMinFils: p.costMinFils, costMaxFils: p.costMaxFils, timelineDays: p.timelineDays, renewalMinFils: renewal ? p.renewalMinFils! : null, renewalMaxFils: renewal ? (p.renewalMaxFils ?? p.renewalMinFils!) : null, ...(p.renewalMinFils != null && !renewal ? { renewalToBeVerified: true } : {}) } } : {}),
      ...(ok && p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}),
      ...(ok && p.facilities !== undefined ? { facilities: p.facilities } : {}),
      findings,
      why: ok ? p.why : [],
      toBeVerified: !ok,
    };
  };
  const reasons = a.structure.reasons.map(statement);
  // The structure the engine chose is a conclusion: the public sees it only when every reason behind it is approved.
  const chosen = (a.structure.recommendation as Structure | null) ?? null;
  const confirmed = !!chosen && reasons.length > 0 && reasons.every((r) => !r.toBeVerified);
  const recommendation = confirmed ? chosen : null;
  const licences = a.licences.map(statement);
  const obligations = a.obligations.map(statement);
  const crossBorder = (a.crossBorder ?? []).map(statement);
  const all = [...reasons, ...licences, ...obligations, ...crossBorder];
  // A place the engine excluded is shown as excluded only when the public may see why; otherwise it is a place
  // still to be verified, listed with the others, so "no place fits" is never implied by an empty list.
  const excludedAll = (a.excluded ?? []).map((c) => ({ c, p: place(c) }));
  const excluded = excludedAll.filter((x) => x.p.status === "INELIGIBLE").map((x) => x.p);
  const structures = (a.structures ?? []).map((s) => ({ structure: s.structure, status: softStatus(s.status, s.findings, true), findings: s.findings.map((f) => finding(f, true)) }));
  const places = publicOrder([...a.places, ...excludedAll.filter((x) => x.p.status !== "INELIGIBLE").map((x) => x.c)], approvedRules, approvedPlaces, recommendation, new Map(structures.map((s) => [s.structure, s.status]))).map(place);
  const contradictions = (a.contradictions ?? []).filter((c) => {
    const gate = CONTRADICTION_RULES.find(([re]) => re.test(c));
    return !gate || approvedRules.has(gate[1]);
  });
  // "No option fits" is a conclusion of the rules that excluded everything: shown only when they are approved.
  const noViable = reasons.find((r, i) => a.structure.reasons[i]?.ruleKey === "structure.no_viable_option");
  const noViableOption = !!a.noViableOption && !!noViable && !noViable.toBeVerified;
  return {
    disclaimer: PUBLIC_DISCLAIMER,
    structure: { recommendation, confirmed, reasons },
    structures,
    places,
    excluded,
    licences,
    obligations,
    crossBorder,
    missingFacts: a.missingFacts ?? [],
    contradictions,
    noViableOption,
    approved: { statements: all.filter((s) => !s.toBeVerified).length, ofStatements: all.length, places: places.filter((p) => !p.toBeVerified).length, ofPlaces: places.length },
    ...(a.engineVersion ? { engineVersion: a.engineVersion } : {}),
    ...(asOf ? { asOf } : {}),
  };
}

/**
 * The texts the engine can emit under each rule key, found by running it over a matrix of founders (D80: what the
 * founder approves is the engine's wording, not the rule's summary). Deterministic for one engine version; a digest
 * of a key's texts is part of the rule's public-display version, so a reworded engine lapses the approval.
 */
export function engineTextsByRule(rules: ScopingRule[]): Map<string, string[]> {
  const verified = rules.map((r) => ({ ...r, confidence: "verified" as const }));
  const z = (name: string, emirate: string, type: Zone["type"], visaQuota: number, extra: Partial<Zone> = {}): Zone => ({
    name, emirate, type, visaQuota, costMinFils: 1_000_000, costMaxFils: 2_000_000, timelineDays: 7, activities: [], sourceUrl: "", confidence: "verified", ...extra,
  });
  const zones: Zone[] = [
    z("A free zone", "Dubai", "free_zone", 1, { facilities: ["office"], activitiesListed: ["tech"], activitiesListedConfidence: "verified", renewalMinFils: 500_000, renewalMaxFils: 700_000, renewalConfidence: "verified" }),
    z("A zone with land", "Abu Dhabi", "free_zone", 3, { facilities: ["office", "warehouse", "industrial"], visaMax: 5 }),
    z("A mainland department", "Dubai", "mainland", 2),
    z("An offshore registry", "Ras Al Khaimah", "offshore", 0, { visaMax: 0 }),
    z("A financial centre", "Dubai", "financial", 2),
    z("A place without figures", "Sharjah", "free_zone", 1, { costMinFils: 0, costMaxFils: 0, confidence: "UNCERTAIN" }),
  ];
  const out = new Map<string, Set<string>>();
  const add = (key: string | undefined, text: string) => {
    if (!key) return;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(text);
  };
  const activities = ["trading", "consulting", "ecommerce", "tech", "holding", "finance", "virtual_assets", "health", "education", "food", "construction", "manufacturing", "other", undefined] as const;
  for (const activity of activities)
    for (const customers of ["uae_mainland", "international", "both", undefined] as const)
      for (const visas of [0, 2, 12, undefined])
        for (const premises of [undefined, "none", "retail", "warehouse"] as const)
          for (const jurisdiction of [undefined, "offshore", "mainland"] as const)
            for (const emirate of ["Dubai", "Abu Dhabi", "Sharjah"])
              for (const budgetAed of [null, 5_000, 80_000]) {
                const input: AdviceInput = { mode: "new_company", emirate, activity, customers, visas, premises, jurisdiction, budgetAed, expectedTurnoverAed: 1_000_000, taxableSuppliesAed: 400_000, ownerType: "company", foreignTaxResident: true, officeNeeded: premises === "retail" ? true : undefined };
                const a = advise(input, verified, zones, "2026-05-01");
                for (const r of [...a.structure.reasons, ...a.licences, ...a.obligations, ...(a.crossBorder ?? [])]) add(r.ruleKey, r.text);
                for (const s of a.structures ?? []) for (const f of s.findings) add(f.ruleKey, f.text);
                for (const p of [...a.places, ...(a.excluded ?? [])]) for (const f of p.findings ?? []) add(f.ruleKey, f.text);
              }
  // Services mode statements (small business relief for an existing company, the VAT points) too.
  for (const turnover of [100_000, 250_000, 1_000_000, 5_000_000]) {
    const a = advise({ mode: "services", emirate: "Dubai", expectedTurnoverAed: turnover }, verified, zones, "2026-05-01");
    for (const r of [...a.licences, ...a.obligations]) add(r.ruleKey, r.text);
  }
  return new Map([...out.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, [...v].sort()]));
}

export const ENGINE_TEXTS_VERSION = ELIGIBILITY_ENGINE_VERSION;

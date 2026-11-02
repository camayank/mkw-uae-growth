import type { IntakeAnswers } from "./scope.ts";
import { assess, isViable, statusRank, type EligibilityStatus, type Finding, type PlaceAssessment, type Structure, type StructureAssessment, ELIGIBILITY_ENGINE_VERSION } from "./eligibility.ts";

/**
 * Scoping intelligence: turn a founder's answers into an explained recommendation. Pure: rules and zones are
 * passed in (they live in the database with their confidence and sign-off), so what the engine says is never
 * more certain than the rule it came from. Nothing here is a statutory conclusion; ops approves before a
 * client sees it, and a person files everything.
 */
export type Confidence = "verified" | "rule_of_thumb" | "UNCERTAIN";

export interface ScopingRule {
  key: string;
  kind: "structure" | "zone" | "licence" | "obligation" | "crossborder";
  statement: string;
  parameters: Record<string, unknown>;
  sourceUrl: string;
  confidence: Confidence;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
}

export interface Zone {
  name: string;
  emirate: string;
  type: "free_zone" | "mainland" | "offshore" | "financial";
  /** Residence visas available with the standard package. */
  visaQuota: number;
  /** The most visas the place allows at all, when known (null: not on record). Offshore is 0. */
  visaMax?: number | null;
  /** Setup cost range including government fees, fils. */
  costMinFils: number;
  costMaxFils: number;
  timelineDays: number;
  /** Activity groups the zone is known for: a preference signal, never a permission. */
  activities: string[];
  /** Facilities on record ("office", "warehouse", "industrial", "retail"); null: not on record. */
  facilities?: string[] | null;
  sourceUrl: string;
  confidence: Confidence;
}

export interface Reasoned {
  text: string;
  confidence: Confidence;
  ruleKey?: string;
}

export interface Candidate {
  zone: string;
  emirate: string;
  type: Zone["type"];
  visaQuota: number;
  costMinFils: number;
  costMaxFils: number;
  timelineDays: number;
  confidence: Confidence;
  why: string[];
  /** E1: the place's eligibility and the findings behind it (absent on advice stored before E1). */
  status?: EligibilityStatus;
  findings?: Finding[];
}

export interface Advice {
  structure: { recommendation: IntakeAnswers["jurisdiction"] | null; reasons: Reasoned[] };
  places: Candidate[];
  licences: Reasoned[];
  obligations: Reasoned[];
  /** True when any statement shown is not a verified rule. */
  hasUncertain: boolean;
  /** E1: every structure's eligibility with its findings. */
  structures?: StructureAssessment[];
  /** E1: material places excluded, with why. */
  excluded?: Candidate[];
  /** E1: cross-border points for a specialist's review. */
  crossBorder?: Reasoned[];
  /** E1: facts the founder has not given that would change the answer. */
  missingFacts?: string[];
  /** E1: answers that contradict each other; the advice says so instead of picking one silently. */
  contradictions?: string[];
  /** E1: no structure survived the checks; the founder needs a specialist assessment, not a best guess. */
  noViableOption?: boolean;
  /** E1: something shown still needs a qualified person's confirmation (an unverified rule, data or a check). */
  needsVerification?: boolean;
  /** E1: the engine version the advice was computed with. */
  engineVersion?: string;
}

export type Activity =
  | "trading"
  | "consulting"
  | "ecommerce"
  | "tech"
  | "holding"
  | "finance"
  | "virtual_assets"
  | "health"
  | "education"
  | "food"
  | "construction"
  | "manufacturing"
  | "other";
export type Customers = "uae_mainland" | "international" | "both";
export type Premises = "none" | "virtual" | "office" | "retail" | "warehouse" | "industrial" | "clinic";

export interface AdviceInput extends IntakeAnswers {
  activity?: Activity;
  customers?: Customers;
  officeNeeded?: boolean;
  /** E1: the kind of premises the business needs, when known. */
  premises?: Premises;
  budgetAed?: number | null;
  expectedTurnoverAed?: number | null;
  /** E1: expected taxable supplies (the VAT test), when known; turnover alone is not the test. */
  taxableSuppliesAed?: number | null;
  /** E1: who will own the company. */
  ownerType?: "individuals" | "company";
  /** E1: a founder or owner is tax resident outside the UAE. */
  foreignTaxResident?: boolean;
  description?: string;
}

const rule = (rules: ScopingRule[], key: string) => rules.find((r) => r.key === key);
const say = (rules: ScopingRule[], key: string, text: string): Reasoned => {
  const r = rule(rules, key);
  return { text, confidence: r?.confidence ?? "UNCERTAIN", ruleKey: key };
};


const words = (s: string) => s.replace(/_/g, " ");
const toStructure = (j: IntakeAnswers["jurisdiction"] | null | undefined): Structure | null =>
  j === "free_zone" || j === "mainland" || j === "offshore" || j === "difc_adgm" ? j : null;

/**
 * The structure the founder's facts point to first, with the reason, before any eligibility check. The checks then
 * decide whether it survives; if not, the next viable structure is chosen and the reason it changed is shown.
 */
function preferredStructure(a: AdviceInput, rules: ScopingRule[]): { structure: Structure; reasons: Reasoned[] } {
  const wantsOnshore = a.customers === "uae_mainland" || a.customers === "both";
  if (a.activity === "holding") {
    const common = (a.budgetAed ?? 0) >= 30_000;
    if ((a.visas ?? 0) > 0) {
      return {
        structure: common ? "difc_adgm" : "free_zone",
        reasons: [say(rules, "structure.holding", common ? "A holding vehicle that also needs residence visas fits DIFC or ADGM, which can sponsor visas, given the budget for a common-law registry." : "A holding vehicle that also needs residence visas needs a company that can sponsor them: a free zone company licensed for holding activity, not an offshore company.")],
      };
    }
    return {
      structure: common ? "difc_adgm" : "offshore",
      reasons: [say(rules, "structure.holding", common ? "A holding or investment vehicle with the budget for a common-law registry fits DIFC or ADGM." : "A pure holding vehicle with no UAE operations and no visas fits an offshore company (RAK ICC or JAFZA offshore).")],
    };
  }
  if (a.activity === "finance") {
    return { structure: "difc_adgm", reasons: [say(rules, "structure.financial_regulated", "Regulated financial activity needs a regulator's licence (DFSA in DIFC, FSRA in ADGM, or the SCA or Central Bank onshore); the financial free zones are the usual route.")] };
  }
  if (a.activity === "virtual_assets") {
    return {
      structure: a.emirate === "Abu Dhabi" ? "difc_adgm" : "free_zone",
      reasons: [say(rules, "structure.virtual_assets_regulated", a.emirate === "Abu Dhabi" ? "Virtual-asset activity in Abu Dhabi is authorised by the FSRA in ADGM." : "Virtual-asset activity in Dubai outside DIFC is licensed by VARA; the company itself is usually set up in a free zone.")],
    };
  }
  if (a.activity === "manufacturing") {
    return {
      structure: wantsOnshore ? "mainland" : "free_zone",
      reasons: [say(rules, "structure.industrial_licence", wantsOnshore ? "Manufacturing mostly for the UAE market points to a mainland industrial licence; free zone plants selling onshore pay customs on entry." : "Manufacturing mostly for export points to an industrial free zone, where goods move without customs duty.")],
    };
  }
  if (wantsOnshore && (a.activity === "trading" || a.activity === "food" || a.activity === "construction" || a.activity === "health" || a.officeNeeded || a.premises === "retail" || a.premises === "clinic")) {
    const reasons = [say(rules, "structure.mainland_onshore", "Selling to customers across the UAE mainland, or needing a physical shop, clinic, warehouse or site, points to a mainland (DED/DET) licence.")];
    if (a.customers === "uae_mainland") reasons.push(say(rules, "structure.mainland_tenders", "A mainland licence can bid for government work and trade anywhere onshore."));
    return { structure: "mainland", reasons };
  }
  const reasons = [say(rules, "structure.free_zone_default", "A free zone licence gives full foreign ownership, fast setup and a low entry cost for services, technology and online businesses serving customers outside the mainland or internationally.")];
  if (wantsOnshore) reasons.push(say(rules, "structure.free_zone_mainland_sales", "Selling into the mainland from a free zone usually goes through a distributor, a branch or a permit; check before relying on it."));
  return { structure: "free_zone", reasons };
}

/** Fallback order when the preferred structure is excluded. */
const FALLBACK: Structure[] = ["free_zone", "mainland", "difc_adgm", "offshore"];

const asCandidate = (p: PlaceAssessment): Candidate => ({
  zone: p.zone,
  emirate: p.emirate,
  type: p.type,
  visaQuota: p.visaQuota,
  costMinFils: p.costMinFils,
  costMaxFils: p.costMaxFils,
  timelineDays: p.timelineDays,
  confidence: p.confidence,
  why: p.why,
  status: p.status,
  findings: p.findings,
});

/** Answers that cannot both be true. The engine never resolves these by guessing; a person asks the founder. */
function contradictions(a: AdviceInput): string[] {
  const c: string[] = [];
  if (a.officeNeeded === true && (a.premises === "none" || a.premises === "virtual")) c.push("You said you need an office, and also that you need no physical premises.");
  if (a.officeNeeded === false && a.premises && !["none", "virtual"].includes(a.premises)) c.push(`You said you need no office, and also that you need ${a.premises} premises.`);
  if (a.taxableSuppliesAed != null && a.expectedTurnoverAed != null && a.taxableSuppliesAed > a.expectedTurnoverAed) c.push("Expected taxable supplies are higher than expected turnover; supplies are part of turnover.");
  if (a.activity === "holding" && (a.customers === "uae_mainland" || a.customers === "both") && a.premises === "retail") c.push("A pure holding company does not sell to customers from a shop; is there an operating business as well?");
  if (a.jurisdiction === "offshore" && (a.visas ?? 0) > 0) c.push(`You asked for an offshore company and ${a.visas} residence visa(s); an offshore company cannot sponsor visas.`);
  return c;
}

/** Facts that would change the answer, in the founder's words. */
function missingFacts(a: AdviceInput): string[] {
  if (a.mode !== "new_company") return [];
  const m: string[] = [];
  if (!a.activity) m.push("What the business will do (its main activity)");
  if (a.customers === undefined) m.push("Who the customers are: on the UAE mainland, abroad, or both");
  if (a.visas === undefined) m.push("How many residence visas are needed");
  if (a.premises === undefined && a.officeNeeded === undefined) m.push("Whether the business needs premises (office, shop, warehouse, plant)");
  if (a.budgetAed == null) m.push("The setup budget");
  if (a.taxableSuppliesAed == null) m.push("Expected taxable supplies in the first twelve months (for VAT)");
  if (a.ownerType === undefined) m.push("Whether the owners are individuals or a company");
  if (a.foreignTaxResident === undefined) m.push("Whether any owner is tax resident outside the UAE");
  return m;
}

export function advise(a: AdviceInput, rules: ScopingRule[], zones: Zone[]): Advice {
  const licences: Reasoned[] = [];
  const obligations: Reasoned[] = [];
  const crossBorder: Reasoned[] = [];
  let reasons: Reasoned[] = [];
  let recommendation: Structure | null = null;
  let structures: StructureAssessment[] = [];
  let viable: PlaceAssessment[] = [];
  let excluded: PlaceAssessment[] = [];
  let noViableOption = false;

  if (a.mode === "new_company") {
    const pref = preferredStructure(a, rules);
    // Assess every structure first; the preference only chooses among the ones that survive.
    structures = assess(a, rules, [], null).structures;
    const by = new Map(structures.map((s) => [s.structure, s]));
    const prefAssessment = by.get(pref.structure)!;
    reasons = pref.reasons;
    if (isViable(prefAssessment.status)) recommendation = pref.structure;
    else {
      const next = [...FALLBACK].filter((s) => isViable(by.get(s)!.status)).sort((x, y) => statusRank(by.get(x)!.status) - statusRank(by.get(y)!.status) || FALLBACK.indexOf(x) - FALLBACK.indexOf(y))[0];
      const why = prefAssessment.findings.filter((f) => f.outcome === "fail").map((f) => f.text).join(" ");
      if (next) {
        recommendation = next;
        reasons.push(say(rules, "structure.preferred_excluded", `${words(pref.structure)} would otherwise fit, but it is excluded: ${why} ${words(next)} is the closest structure that remains.`));
      } else {
        noViableOption = true;
        reasons.push(say(rules, "structure.no_viable_option", `No structure we can assess fits all the answers: ${why} A specialist needs to look at this case; we will not guess.`));
      }
    }
    const requested = toStructure(a.jurisdiction);
    if (requested && requested !== recommendation) {
      const r = by.get(requested)!;
      const fails = r.findings.filter((f) => f.outcome === "fail").map((f) => f.text);
      reasons.push(
        say(
          rules,
          "structure.requested_differs",
          fails.length
            ? `You asked for ${words(requested)}, which does not fit: ${fails.join(" ")}`
            : `You asked for ${words(requested)}; the answers above point to ${words(String(recommendation ?? "a specialist review"))}. Ops will confirm which fits before pricing.`,
        ),
      );
    }
    const all = assess(a, rules, zones, recommendation);
    viable = all.viable;
    excluded = all.excluded;
    if (!noViableOption && viable.length === 0) {
      noViableOption = true;
      reasons.push(say(rules, "structure.no_viable_option", "No place we hold data for fits every answer (visas, budget, premises). A specialist needs to look at this case; we will not guess."));
    }
  }

  // Regulator approvals by activity (statements; the eligibility findings carry the same keys as conditions).
  if (a.activity === "health") licences.push(say(rules, "licence.health", "Health activities need DHA (Dubai), DoH (Abu Dhabi) or MOHAP approval in addition to the trade licence, and licensed premises."));
  if (a.activity === "education") licences.push(say(rules, "licence.education", "Education and training activities need KHDA (Dubai), ADEK (Abu Dhabi) or the relevant ministry's approval."));
  if (a.activity === "food") licences.push(say(rules, "licence.food", "Food businesses need municipality food-safety approval and premises inspection; importers also register products."));
  if (a.activity === "ecommerce") licences.push(say(rules, "licence.ecommerce", "E-commerce activities are licensed as such; payment gateway onboarding needs the licence and a corporate bank account."));
  if (a.activity === "finance") licences.push(say(rules, "licence.financial", "Financial activities need regulator approval before the licence issues; timelines and capital rules depend on the activity."));
  if (a.activity === "virtual_assets") licences.push(say(rules, "structure.virtual_assets_regulated", "Virtual-asset services need VARA, FSRA or SCA authorisation before any client activity."));
  if (a.activity === "manufacturing") licences.push(say(rules, "structure.industrial_licence", "Manufacturing needs an industrial licence and a plot or unit with power and water capacity confirmed."));

  // Corporate tax: the ordinary regime, and where a free zone is in play, the qualifying free zone regime's conditions.
  obligations.push(say(rules, "obligation.corporate_tax", "Register for corporate tax with the FTA after incorporation. Taxable income above AED 375,000 a year is taxed at 9%; the first AED 375,000 at 0%."));
  if (recommendation === "free_zone" || recommendation === "difc_adgm") {
    obligations.push(say(rules, "obligation.ct_qfzp", "A free zone company pays 0% only on qualifying income, and only as a Qualifying Free Zone Person: adequate substance in the zone, qualifying activities, the de minimis test, audited accounts and no election out. Income from mainland customers is generally not qualifying. A tax adviser should confirm."));
  }
  const revenue = a.expectedTurnoverAed ?? null;
  if (revenue !== null && revenue <= 3_000_000) {
    obligations.push(say(rules, "obligation.ct_small_business_relief", "Small business relief (revenue up to AED 3 million) may apply, but only to tax periods ending on or before 31 December 2026, and not to qualifying free zone persons. A tax adviser should confirm."));
  }

  // VAT: the test is taxable supplies (and imports), not turnover.
  const supplies = a.taxableSuppliesAed ?? null;
  const basis = supplies ?? revenue;
  if (basis !== null && basis >= 375_000) obligations.push(say(rules, "obligation.vat_mandatory", "Taxable supplies and imports above AED 375,000 in twelve months (or expected in the next thirty days) make VAT registration mandatory."));
  else if (basis !== null && basis >= 187_500) obligations.push(say(rules, "obligation.vat_voluntary", "Taxable supplies or expenses above AED 187,500 in twelve months allow voluntary VAT registration."));
  else obligations.push(say(rules, "obligation.vat_watch", "VAT registration becomes mandatory once taxable supplies and imports pass AED 375,000 in twelve months (voluntary from AED 187,500); watch the threshold."));
  if (supplies === null && revenue !== null) obligations.push(say(rules, "obligation.vat_basis", "This VAT point uses expected turnover as a stand-in. The test is taxable supplies: zero-rated exports count, exempt and out-of-scope supplies do not. Confirm the split."));
  if (recommendation === "free_zone" && (a.activity === "trading" || a.activity === "ecommerce" || a.activity === "manufacturing")) {
    obligations.push(say(rules, "obligation.vat_designated_zone", "Some free zones are VAT designated zones, where certain movements of goods are outside the scope of UAE VAT; services are not. Confirm the zone's status and the goods' route."));
  }

  obligations.push(say(rules, "obligation.ubo", "Keep an ultimate beneficial owner register and file it with the registrar."));
  if (["trading", "holding", "finance", "virtual_assets", "other"].includes(a.activity ?? "other")) obligations.push(say(rules, "obligation.goaml_dnfbp", "If the activity is a designated non-financial business (real estate, precious metals, corporate services, audit), register on goAML and run an AML programme."));
  if ((a.visas ?? 0) > 0 && recommendation !== "offshore") obligations.push(say(rules, "obligation.wps", "Employees on visas must be paid through the Wage Protection System; medical insurance is mandatory."));

  // Cross-border: never a conclusion, always a specialist's review.
  if (a.foreignTaxResident) {
    crossBorder.push(say(rules, "crossborder.founder_residence", "An owner tax resident abroad may be taxed there on the company's profits or dividends (controlled foreign company and similar rules), and where the company is managed from can decide its tax residence. A cross-border tax adviser should review."));
    if (a.customers === "international" || a.customers === "both") crossBorder.push(say(rules, "crossborder.permanent_establishment", "Serving customers abroad, or working from abroad, can create a taxable presence (permanent establishment) in another country. Review before launch."));
  }
  if (a.ownerType === "company") {
    crossBorder.push(say(rules, "crossborder.corporate_shareholder", "A corporate owner brings transfer pricing on related-party dealings, the parent country's rules on foreign subsidiaries, and documents to attest for the registry and the bank. Review with the group's advisers."));
  }

  const statements = [...reasons, ...licences, ...obligations, ...crossBorder];
  const places = viable.slice(0, 5).map(asCandidate);
  const hasUncertain = statements.some((r) => r.confidence !== "verified") || places.some((p) => p.confidence !== "verified");
  const needsVerification = hasUncertain || contradictions(a).length > 0 || places.some((p) => p.status !== "ELIGIBLE_VERIFIED" && p.status !== "ELIGIBLE_CONDITIONAL") || structures.some((s) => s.structure === recommendation && s.status === "REQUIRES_VERIFICATION");
  return {
    structure: { recommendation, reasons },
    places,
    licences,
    obligations,
    hasUncertain,
    structures,
    excluded: excluded.map(asCandidate),
    crossBorder,
    missingFacts: missingFacts(a),
    contradictions: contradictions(a),
    noViableOption,
    needsVerification,
    engineVersion: ELIGIBILITY_ENGINE_VERSION,
  };
}

/** The viable places for one structure, best first (used when ops changes the structure at approval). */
export function rankPlaces(a: AdviceInput, zones: Zone[], recommendation: IntakeAnswers["jurisdiction"] | null | undefined, rules: ScopingRule[] = []): Candidate[] {
  const s = toStructure(recommendation);
  if (!s) return [];
  return assess(a, rules, zones, s)
    .viable.filter((p) => p.structure === s)
    .slice(0, 5)
    .map(asCandidate);
}

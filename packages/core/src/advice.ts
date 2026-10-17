import type { IntakeAnswers } from "./scope.ts";

/**
 * Scoping intelligence: turn a founder's answers into an explained recommendation. Pure: rules and zones are
 * passed in (they live in the database with their confidence and sign-off), so what the engine says is never
 * more certain than the rule it came from. Nothing here is a statutory conclusion; ops approves before a
 * client sees it, and a person files everything.
 */
export type Confidence = "verified" | "rule_of_thumb" | "UNCERTAIN";

export interface ScopingRule {
  key: string;
  kind: "structure" | "zone" | "licence" | "obligation";
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
  /** Setup cost range including government fees, fils. */
  costMinFils: number;
  costMaxFils: number;
  timelineDays: number;
  /** Activity groups the zone is known for; empty means general. */
  activities: string[];
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
}

export interface Advice {
  structure: { recommendation: IntakeAnswers["jurisdiction"] | null; reasons: Reasoned[] };
  places: Candidate[];
  licences: Reasoned[];
  obligations: Reasoned[];
  /** True when any statement shown is not a verified rule. */
  hasUncertain: boolean;
}

export type Activity = "trading" | "consulting" | "ecommerce" | "tech" | "holding" | "finance" | "health" | "education" | "food" | "construction" | "other";
export type Customers = "uae_mainland" | "international" | "both";

export interface AdviceInput extends IntakeAnswers {
  activity?: Activity;
  customers?: Customers;
  officeNeeded?: boolean;
  budgetAed?: number | null;
  expectedTurnoverAed?: number | null;
  description?: string;
}

const rule = (rules: ScopingRule[], key: string) => rules.find((r) => r.key === key);
const say = (rules: ScopingRule[], key: string, text: string): Reasoned => {
  const r = rule(rules, key);
  return { text, confidence: r?.confidence ?? "UNCERTAIN", ruleKey: key };
};

export function advise(a: AdviceInput, rules: ScopingRule[], zones: Zone[]): Advice {
  const reasons: Reasoned[] = [];
  const licences: Reasoned[] = [];
  const obligations: Reasoned[] = [];
  let recommendation: IntakeAnswers["jurisdiction"] | null = null;

  if (a.mode === "new_company") {
    const wantsOnshore = a.customers === "uae_mainland" || a.customers === "both";
    if (a.activity === "holding") {
      recommendation = (a.budgetAed ?? 0) >= 30_000 ? "difc_adgm" : "offshore";
      reasons.push(say(rules, "structure.holding", recommendation === "difc_adgm" ? "A holding or investment vehicle with the budget for a common-law registry fits DIFC or ADGM." : "A pure holding vehicle with no UAE operations fits an offshore company (RAK ICC or JAFZA offshore)."));
      if ((a.visas ?? 0) > 0) reasons.push(say(rules, "structure.offshore_no_visas", "Offshore companies cannot sponsor residence visas; a free zone company would be needed for the visas."));
    } else if (a.activity === "finance") {
      recommendation = "difc_adgm";
      reasons.push(say(rules, "structure.financial_regulated", "Regulated financial activity needs a licence from DFSA (DIFC), FSRA (ADGM) or the SCA; the financial free zones are the usual route."));
      licences.push(say(rules, "licence.financial", "Financial activities need regulator approval before the licence issues; timelines and capital rules depend on the activity."));
    } else if (wantsOnshore && (a.activity === "trading" || a.activity === "food" || a.activity === "construction" || a.officeNeeded)) {
      recommendation = "mainland";
      reasons.push(say(rules, "structure.mainland_onshore", "Selling to customers across the UAE mainland, or needing a physical shop, warehouse or site, points to a mainland (DED/DET) licence."));
      if (a.customers === "uae_mainland") reasons.push(say(rules, "structure.mainland_tenders", "A mainland licence can bid for government work and trade anywhere onshore."));
    } else {
      recommendation = "free_zone";
      reasons.push(say(rules, "structure.free_zone_default", "A free zone licence gives 100% ownership, fast setup and a low entry cost for services, technology and online businesses serving customers outside the mainland or internationally."));
      if (wantsOnshore) reasons.push(say(rules, "structure.free_zone_mainland_sales", "Selling into the mainland from a free zone usually goes through a distributor or a dual licence; check before relying on it."));
    }
    if (a.jurisdiction && a.jurisdiction !== "not_sure" && a.jurisdiction !== recommendation) {
      reasons.push({ text: `You asked for ${a.jurisdiction.replace("_", " ")}; the answers above point to ${String(recommendation).replace("_", " ")}. Ops will confirm which fits before pricing.`, confidence: "rule_of_thumb" });
    }
  }

  // Special approvals by activity.
  if (a.activity === "health") licences.push(say(rules, "licence.health", "Health activities need DHA (Dubai), DoH (Abu Dhabi) or MOHAP approval in addition to the trade licence."));
  if (a.activity === "education") licences.push(say(rules, "licence.education", "Education and training activities need KHDA (Dubai) or ADEK (Abu Dhabi) approval."));
  if (a.activity === "food") licences.push(say(rules, "licence.food", "Food businesses need municipality food-safety approval and premises inspection."));
  if (a.activity === "ecommerce") licences.push(say(rules, "licence.ecommerce", "E-commerce activities are licensed as such; payment gateway onboarding needs the licence and a corporate bank account."));

  // Follow-on obligations.
  obligations.push(say(rules, "obligation.corporate_tax", "Register for corporate tax with the FTA after incorporation; 0% applies up to the threshold and 9% above it, with small business relief possible."));
  const turnover = a.expectedTurnoverAed ?? null;
  if (turnover !== null && turnover >= 375_000) obligations.push(say(rules, "obligation.vat_mandatory", "Taxable supplies above AED 375,000 a year make VAT registration mandatory."));
  else if (turnover !== null && turnover >= 187_500) obligations.push(say(rules, "obligation.vat_voluntary", "Taxable supplies above AED 187,500 a year allow voluntary VAT registration."));
  else obligations.push(say(rules, "obligation.vat_watch", "VAT registration becomes mandatory once taxable supplies pass AED 375,000 a year (voluntary from AED 187,500); watch the threshold."));
  obligations.push(say(rules, "obligation.ubo", "Keep an ultimate beneficial owner register and file it with the registrar."));
  if (["trading", "holding", "finance", "other"].includes(a.activity ?? "other")) obligations.push(say(rules, "obligation.goaml_dnfbp", "If the activity is a designated non-financial business (real estate, precious metals, corporate services, audit), register on goAML and run an AML programme."));
  if ((a.visas ?? 0) > 0 && recommendation !== "offshore") obligations.push(say(rules, "obligation.wps", "Employees on visas must be paid through the Wage Protection System; medical insurance is mandatory."));

  // Candidate places for the recommended structure, in the chosen emirate first.
  const type: Zone["type"] | null = recommendation === "free_zone" ? "free_zone" : recommendation === "mainland" ? "mainland" : recommendation === "offshore" ? "offshore" : recommendation === "difc_adgm" ? "financial" : null;
  const places: Candidate[] = [];
  if (type) {
    const fit = zones
      .filter((z) => z.type === type)
      .map((z) => {
        const why: string[] = [];
        let score = 0;
        if (z.emirate === a.emirate) {
          score += 3;
          why.push(`in ${a.emirate}`);
        }
        if (a.activity && z.activities.includes(a.activity)) {
          score += 2;
          why.push(`known for ${a.activity}`);
        }
        if ((a.visas ?? 0) <= z.visaQuota) {
          score += 1;
          why.push(`${z.visaQuota} visa(s) in the standard package`);
        } else why.push(`standard package covers ${z.visaQuota} visa(s); more cost extra`);
        if (a.budgetAed && z.costMinFils <= a.budgetAed * 100) {
          score += 1;
          why.push("within budget");
        }
        if (a.freeZone && z.name.toLowerCase() === a.freeZone.toLowerCase()) {
          score += 5;
          why.push("the zone you named");
        }
        return { z, score, why };
      })
      .sort((x, y) => y.score - x.score || x.z.costMinFils - y.z.costMinFils)
      .slice(0, 3);
    for (const { z, why } of fit) {
      places.push({ zone: z.name, emirate: z.emirate, type: z.type, visaQuota: z.visaQuota, costMinFils: z.costMinFils, costMaxFils: z.costMaxFils, timelineDays: z.timelineDays, confidence: z.confidence, why });
    }
  }

  const all = [...reasons, ...licences, ...obligations];
  const hasUncertain = all.some((r) => r.confidence !== "verified") || places.some((p) => p.confidence !== "verified");
  return { structure: { recommendation, reasons }, places, licences, obligations, hasUncertain };
}

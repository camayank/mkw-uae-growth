/**
 * General guidance for the public selector (E7A). Short educational notes a founder can read whatever the state of
 * the catalogue: what a structure is, what a kind of business usually has to think about, how to read the result.
 *
 * Every note is general information, never a statement about the founder's case, a figure, a rate, a fee or a
 * statutory conclusion (a test enforces the wording). A note is a draft until the founder approves its version for
 * public display (D80, kind `guide`); the public sees only approved notes, labelled "general information".
 *
 * Pure: selection depends on the answers and the engine's conclusions only.
 */
import type { AdviceInput } from "./advice.ts";
import type { Structure } from "./eligibility.ts";

export interface Guide {
  id: string;
  title: string;
  text: string;
  /** What the note is about, for the Scoping page and the public label. */
  about: "structure" | "industry" | "situation" | "reading";
}

/** The facts selection reads: the answers and, when the engine reached one, the structure it chose. */
export interface GuideContext {
  activity?: AdviceInput["activity"];
  customers?: AdviceInput["customers"];
  visas?: number | null;
  premises?: AdviceInput["premises"];
  ownerType?: AdviceInput["ownerType"];
  foreignTaxResident?: boolean;
  /** The structure the engine recommends, when the public may see it; null otherwise. */
  recommendation?: Structure | null;
  /** Structures the engine still lists as possible (any status but INELIGIBLE). */
  structuresOpen?: Structure[];
}

const g = (id: string, about: Guide["about"], title: string, text: string): Guide => ({ id, about, title, text });

export const GUIDES: Guide[] = [
  g("reading.labels", "reading", "How to read this result",
    "Each point carries a label. \"Checked\" means a named person at MKW Advisors has approved that statement or figure for public display. \"With conditions\" means it fits if something is confirmed. \"To be verified\" means the rule or figure exists but has not been approved for the public yet, so nothing is stated. \"Data missing\" means MKW Advisors does not hold the record that would settle it. \"Specialist review\" means a person with the right qualification looks at it before anything is concluded. Nothing here is advice until a person has reviewed your case."),
  g("structure.free_zone", "structure", "What a free zone company is",
    "A free zone is a designated area with its own licensing authority and registry. A company licensed there is a UAE company that can usually be fully owned by its founders, trades with the world from the zone, and sponsors residence visas within the zone's rules. Selling directly inside the UAE mainland is a separate question that depends on the activity and on arrangements the authorities allow; the result above flags it where it applies. Each zone has its own activity list, premises options and renewal cycle."),
  g("structure.mainland", "structure", "What a mainland company is",
    "A mainland company is licensed by an emirate's economic department and can trade anywhere in the UAE, take government and large-company contracts, and open branches across emirates. It needs premises the department accepts and follows the emirate's rules on ownership for the chosen activity. Setup involves the department, the immigration authority for visas and, for some activities, a sector regulator."),
  g("structure.offshore", "structure", "What an offshore company is",
    "An offshore company is a registry company for holding assets, shares or intellectual property and for international dealings. It does not trade inside the UAE, does not lease business premises there and does not sponsor residence visas. Founders who need visas, an office or UAE customers look at a free zone or mainland company instead."),
  g("structure.difc_adgm", "structure", "What DIFC and ADGM are",
    "DIFC in Dubai and ADGM in Abu Dhabi are financial centres with their own common-law courts, registrars and regulators. They are the usual home for regulated financial activity and for holding and investment vehicles that want a common-law framework, and they also license non-financial businesses. Regulated activity there means a licence from the centre's regulator before the business starts, with its own application and capital rules."),
  g("industry.consulting", "industry", "Consulting and professional services",
    "Most advisory and professional businesses can be licensed in a free zone or on the mainland. The questions that decide between them are where the clients are, whether the firm needs an office clients visit, and how many people need visas. Some professions are licensed by a professional body as well as the economic authority; the result flags those as licences and approvals."),
  g("industry.tech", "industry", "Software and technology",
    "Software, platforms and digital services are licensed under technology or IT activities in most zones and on the mainland. Points that usually matter are the visa count for the team, whether customers are in the UAE or abroad, where the data sits, and whether the product touches payments, lending or virtual assets, which brings a regulator into the picture."),
  g("industry.trading", "industry", "Trading goods",
    "Trading needs the activity to cover the goods traded, an importer code with customs where goods cross the border, and premises that match the stock: a desk for pure re-export, a warehouse for goods held in the UAE. Selling to UAE customers from a free zone has its own rules; mainland trading does not have that question but has premises and ownership rules of its own."),
  g("industry.ecommerce", "industry", "Selling online",
    "An online business is licensed under e-commerce or trading activities. What matters is where the customers are, where the goods are stored and shipped from, and whether payments are collected directly or through a provider. Delivery into the UAE mainland from a free zone is one of the points the result flags for confirmation."),
  g("industry.manufacturing", "industry", "Manufacturing and industrial activity",
    "Manufacturing needs an industrial licence and premises built for it: a plot or unit with the utilities and approvals the activity needs, which not every zone offers. Environmental, civil defence and municipal approvals usually come before production starts. The result says \"data missing\" for a place whose industrial facilities are not on record rather than assuming them."),
  g("industry.holding", "industry", "Holding and investment structures",
    "A holding company owns shares or assets and does not trade. Offshore registries, free zones and the financial centres all offer holding vehicles; the choice turns on whether the owners need visas, where the assets and subsidiaries sit, and the tax residence of the owners. A holding vehicle that also needs visas needs a structure that can sponsor them, which an offshore company cannot."),
  g("industry.finance", "industry", "Regulated financial services",
    "Banking, lending, investment, insurance, payments and virtual assets are regulated activities. A general company licence is never enough: the regulator for the chosen location licenses the activity first, with its own application, capital and governance requirements, and that process sets the timeline. The result marks these as specialist review."),
  g("situation.uae_customers", "situation", "Selling inside the UAE",
    "A business with UAE customers chooses between a mainland licence, which can trade across the UAE, and a free zone licence, which trades from the zone and reaches the mainland through arrangements that depend on the activity, such as a distributor, a branch or a permit. Which arrangement applies, and whether it suits the business model, is confirmed by a person before anything is priced."),
  g("situation.visas", "situation", "Residence visas",
    "A company sponsors residence visas for its owners and staff within the limits of its licence and premises. Each place offers a number of visas with its standard package and a ceiling that depends on the space leased. Dependants are sponsored by the resident, not the company. Medical tests, Emirates ID and visa stamping follow the entry permit for each person."),
  g("situation.corporate_shareholder", "situation", "A company as the owner",
    "When a company rather than a person owns the new entity, the registry asks for the parent's documents, often attested and translated, and for the ultimate beneficial owners behind it. Group structures, tax residence of the parent and transfer pricing between the companies are points a tax specialist reviews before the structure is settled."),
  g("situation.foreign_tax_resident", "situation", "Owners who are tax resident elsewhere",
    "Where an owner is tax resident outside the UAE, that country's rules on controlled foreign companies, permanent establishment and the place of effective management can reach the UAE company. None of that is decided by the UAE licence. A cross-border tax specialist reviews it before the structure is settled; the result lists the points for that review."),
  g("situation.tax", "situation", "Corporate tax and VAT after setup",
    "A UAE company registers with the Federal Tax Authority and keeps accounting records from the start. Whether and when it registers for VAT depends on its taxable supplies, and its corporate tax position depends on its activity, where it is licensed and whether it qualifies for any relief. The result lists the obligations that apply as rules a person confirms; it does not calculate tax."),
  g("situation.banking", "situation", "Opening a bank account",
    "Banks onboard a new company on its licence, its owners' documents, a business plan and proof of where the money comes from and goes. Activities, countries and ownership chains that banks treat as higher risk take longer. Account opening is a separate step after the licence, with its own timeline, and the choice of structure and place affects how it goes."),
];

const WANTS_ONSHORE = (c: GuideContext) => c.customers === "uae_mainland" || c.customers === "both";

/** The notes that apply to a founder, in reading order. Deterministic; nothing commercial is read. */
export function selectGuides(c: GuideContext, guides: Guide[] = GUIDES): Guide[] {
  const want = new Set<string>(["reading.labels"]);
  const open = new Set<Structure>(c.structuresOpen ?? []);
  const structures: Structure[] = c.recommendation ? [c.recommendation] : [...open];
  for (const s of structures) want.add(`structure.${s}`);
  if (c.activity && GUIDES.some((x) => x.id === `industry.${c.activity}`)) want.add(`industry.${c.activity}`);
  if (c.activity === "virtual_assets") want.add("industry.finance");
  if (WANTS_ONSHORE(c)) want.add("situation.uae_customers");
  if ((c.visas ?? 0) > 0) want.add("situation.visas");
  if (c.ownerType === "company") want.add("situation.corporate_shareholder");
  if (c.foreignTaxResident) want.add("situation.foreign_tax_resident");
  if (c.activity !== "holding") want.add("situation.banking");
  want.add("situation.tax");
  return guides.filter((x) => want.has(x.id));
}

/** Words a general note never uses: figures, rates, money and the verbs of a statutory conclusion. */
export const GUIDE_FORBIDDEN = /\d|%|AED|dirham|\bmust\b|\bmandatory\b|required by law|\bguarantee|\billegal\b|\bexempt\b/i;

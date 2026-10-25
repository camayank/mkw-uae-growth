/**
 * The AI model behind one interface. Output is a draft with confidence UNCERTAIN, written into a review queue;
 * a person approves or discards it. The memory model is deterministic (keyword rules) so tests and development
 * never call the internet. The Claude API adapter is wired when MKW supplies a key and a monthly cap (`AI=anthropic`).
 */
export interface ScopeDraft {
  /** Suggested deliverable codes with quantities. */
  lines: Array<{ code: string; qty: number; why: string }>;
  structure: "free_zone" | "mainland" | "offshore" | "difc_adgm" | null;
  activity: string | null;
  flags: string[];
  summary: string;
}

/**
 * What the document checker may tell the model about an upload (O11): the file's name and what people declared about
 * it, and what the step asked for. Never the file's owner, contact details or price.
 */
export interface DocumentCheckInput {
  subject: "evidence" | "document_request" | "partner_document" | "obligation";
  fileName: string;
  /** What the uploader said it is (evidence type, requested document, partner document kind, obligation title). */
  declaredType: string;
  /** What the step needs (a milestone's evidence types; otherwise the declared type). */
  required: string[];
  reference: string | null;
  expiresOn: string | null;
  /** Today in Dubai, YYYY-MM-DD. */
  today: string;
}

export interface DocumentCheck {
  /** The kind of document the model thinks it is, in the platform's words, or null. */
  detectedType: string | null;
  /** Whether it answers what the step asked for: true, false, or null when the model cannot tell. */
  matchesRequirement: boolean | null;
  /** Dates found (YYYY-MM-DD). */
  dates: string[];
  expiry: string | null;
  /** Problems for the reviewer, each one sentence. */
  issues: string[];
  summary: string;
  /** What the model looked at, so the reviewer knows how much the check is worth. */
  basis: string;
}

export interface AiModel {
  kind: string;
  /** Draft a scope from a founder's free-text description. Never throws for ordinary input; returns an empty draft instead. */
  draftScope(text: string, knownCodes: string[]): Promise<ScopeDraft>;
  /** A first check of an uploaded document, for a person to agree or disagree with. */
  checkDocument(input: DocumentCheckInput): Promise<DocumentCheck>;
}

/** Words that name a kind of document, as they appear in file names. Longest phrases first. */
const DOCUMENT_WORDS: Array<[RegExp, string]> = [
  [/emirates[\s_-]*id|\beid\b/i, "emirates_id"],
  [/trade[\s_-]*licen[cs]e|commercial[\s_-]*licen[cs]e|\blicen[cs]e\b/i, "trade_licence"],
  [/certificate[\s_-]*of[\s_-]*incorporation|incorporation/i, "certificate_of_incorporation"],
  [/memorandum|\bmoa\b|articles/i, "moa"],
  [/passport/i, "passport"],
  [/residence[\s_-]*visa|\bvisa\b/i, "residence_visa"],
  [/entry[\s_-]*permit/i, "entry_permit"],
  [/establishment[\s_-]*card/i, "establishment_card"],
  [/ejari|tenancy|lease/i, "tenancy_contract"],
  [/\btrn\b|vat[\s_-]*certificate|tax[\s_-]*registration/i, "fta_trn_certificate"],
  [/acknowledg|\back\b|filing[\s_-]*receipt|submission/i, "submission_receipt"],
  [/receipt/i, "receipt"],
  [/insurance|policy/i, "insurance"],
  [/bank[\s_-]*letter|account[\s_-]*letter|\biban\b/i, "account_letter"],
  [/financial[\s_-]*statements|balance[\s_-]*sheet/i, "financial_statements"],
  [/audit[\s_-]*report/i, "audit_report"],
  [/invoice/i, "invoice"],
  [/agreement|contract|signed/i, "signed_agreement"],
  [/approval/i, "initial_approval"],
];
const OK_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "webp", "heic", "doc", "docx", "xls", "xlsx", "csv"];

/** Dates written in a file name: 2026-10-18, 18-10-2026, 18.10.2026 or 18_10_2026. Impossible dates are dropped. */
function datesIn(name: string): string[] {
  const out = new Set<string>();
  const real = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return y > 1990 && y < 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  for (const m of name.matchAll(/(\d{4})[-_.](\d{2})[-_.](\d{2})/g)) {
    const v = real(+m[1]!, +m[2]!, +m[3]!);
    if (v) out.add(v);
  }
  for (const m of name.matchAll(/(?<!\d)(\d{2})[-_.](\d{2})[-_.](\d{4})(?!\d)/g)) {
    const v = real(+m[3]!, +m[2]!, +m[1]!);
    if (v) out.add(v);
  }
  return [...out].sort();
}

const words = (t: string) => t.replace(/_/g, " ");
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The in-memory check: reads the file name and the declared fields only, and says so. */
function memoryCheck(input: DocumentCheckInput): DocumentCheck {
  const issues: string[] = [];
  const name = input.fileName;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (!ext) issues.push("The file has no extension, so its type cannot be told from its name.");
  else if (!OK_EXTENSIONS.includes(ext)) issues.push(`A .${ext} file is not a usual document format (PDF or a photo is expected).`);
  const required = input.required.length ? input.required : [input.declaredType];
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, "_");
  const stem = norm(name.replace(/\.[a-z0-9]+$/i, ""));
  // A type the step itself names, written out in the file name ("document_checklist.pdf"), counts as recognised.
  const named = required.find((r) => {
    const w = norm(r).split("_").filter((x) => x.length > 2);
    return w.length > 0 && w.every((x) => stem.includes(x));
  });
  const detectedType = DOCUMENT_WORDS.find(([re]) => re.test(name.replace(/\.[a-z0-9]+$/i, "")))?.[1] ?? named ?? null;
  // Same family when the two names share a meaningful word (licence and commercial_licence; receipt and eid_receipt).
  const family = (a: string, b: string) => {
    const wa = norm(a).split("_").filter((w) => w.length > 2);
    const wb = new Set(norm(b).split("_").filter((w) => w.length > 2));
    return norm(a) === norm(b) || wa.some((w) => wb.has(w));
  };
  let matchesRequirement: boolean | null = null;
  if (detectedType) {
    matchesRequirement = required.some((r) => family(detectedType, r));
    if (!matchesRequirement) issues.push(`The file name reads like a ${words(detectedType)}, but the step asks for ${required.map(words).join(" or ")}.`);
  } else if (input.subject === "evidence" && !required.some((r) => family(input.declaredType, r))) {
    issues.push(`It was uploaded as ${words(input.declaredType)}, which is not one of the evidence types this step asks for (${required.map(words).join(", ")}).`);
    matchesRequirement = false;
  }
  const dates = datesIn(name);
  const expiry = input.expiresOn ?? null;
  if (expiry) {
    const left = daysBetween(input.today, expiry);
    if (left < 0) issues.push(`The declared expiry (${expiry}) has passed.`);
    else if (left <= 30) issues.push(`The declared expiry (${expiry}) is ${left} day(s) away.`);
  } else if (input.subject === "partner_document" && ["trade_licence", "insurance"].includes(input.declaredType)) {
    issues.push("No expiry date was given; check it on the document.");
  }
  if (input.subject === "partner_document" && input.declaredType === "trade_licence" && !input.reference) issues.push("No licence number was given; check it on the document.");
  const what = detectedType ? `looks like a ${words(detectedType)}` : "could not be identified from its name";
  const summary = `${name} ${what}${matchesRequirement === true ? " and matches what the step asked for" : matchesRequirement === false ? ", which may not be what the step asked for" : ""}. ${issues.length ? `${issues.length} point(s) to check.` : "Nothing to flag from the name and the declared details."}`;
  return { detectedType, matchesRequirement, dates, expiry, issues, summary, basis: "file name and the declared details only; the file itself was not read" };
}

const KEYWORDS: Array<[RegExp, string, string]> = [
  [/\b(bank|account)\b/i, "BANK-ACC", "mentions a bank account"],
  [/\b(vat)\b/i, "VAT-RET", "mentions VAT"],
  [/\b(corporate tax|\bct\b)/i, "CT-RET", "mentions corporate tax"],
  [/\b(bookkeep|accounts|accounting)\b/i, "ACC-BOOK", "mentions accounting"],
  [/\b(payroll|salar)/i, "PAY-WPS", "mentions payroll"],
  [/\b(pro |government liaison|pro services)/i, "PRO-RET", "mentions PRO services"],
  [/\b(trademark|brand protection)\b/i, "TM-REG", "mentions a trademark"],
  [/\b(audit)\b/i, "AUD-EXT", "mentions an audit"],
  [/\b(golden visa)\b/i, "VISA-GOLD", "mentions a golden visa"],
  [/\b(office|flexi|desk)\b/i, "SET-OFFICE", "mentions an office"],
];

export function memoryModel(): AiModel {
  return {
    kind: "memory",
    async draftScope(text, knownCodes) {
      const known = new Set(knownCodes);
      const lines: ScopeDraft["lines"] = [];
      const visas = /(\d+)\s*(residence )?visas?/i.exec(text);
      const mainland = /\b(mainland|onshore|retail|shop|restaurant|warehouse)\b/i.test(text);
      const offshore = /\b(offshore|holding only|hold shares)\b/i.test(text);
      const structure: ScopeDraft["structure"] = offshore ? "offshore" : mainland ? "mainland" : /\b(fund|regulated|difc|adgm)\b/i.test(text) ? "difc_adgm" : "free_zone";
      const setup = structure === "offshore" ? "SET-OFF" : structure === "mainland" ? "SET-ML-LIC" : "SET-FZ-LIC";
      if (/\b(set ?up|setting up|incorporat\w*|new company|start\w*|launch\w*|build\w*|found\w*|register\w*|licen[cs]e\w*|company|business|startup)\b/i.test(text) && known.has(setup)) lines.push({ code: setup, qty: 1, why: "describes setting up a company" });
      if (visas && structure !== "offshore" && known.has("VISA-RES")) lines.push({ code: "VISA-RES", qty: Math.min(50, Number(visas[1])), why: `asks for ${visas[1]} visa(s)` });
      for (const [re, code, why] of KEYWORDS) if (re.test(text) && known.has(code) && !lines.some((l) => l.code === code)) lines.push({ code, qty: 1, why });
      const activity = /\b(consult|advis)/i.test(text) ? "consulting" : /\b(e-?commerce|online store|shopify|amazon)\b/i.test(text) ? "ecommerce" : /\b(software|app|saas|tech)\b/i.test(text) ? "tech" : /\b(trad|import|export|goods)\b/i.test(text) ? "trading" : /\b(clinic|medical|health)\b/i.test(text) ? "health" : /\b(school|training|academy)\b/i.test(text) ? "education" : null;
      const flags: string[] = [];
      if (activity === "health") flags.push("Health activity: regulator approval likely needed");
      if (activity === "education") flags.push("Education activity: KHDA/ADEK approval likely needed");
      if (/\b(crypto|token|exchange)\b/i.test(text)) flags.push("Virtual assets: VARA/SCA licensing; not a standard setup");
      if (/\b(urgent|asap|this week)\b/i.test(text)) flags.push("Client in a hurry: priority tier");
      return { lines, structure, activity, flags, summary: lines.length ? `Draft scope with ${lines.length} line(s) from the description; UNCERTAIN until ops reviews.` : "Nothing recognisable in the description; ops to scope by hand." };
    },
    async checkDocument(input) {
      return memoryCheck(input);
    },
  };
}

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): AiModel {
  // Only the memory model exists until an API key and a monthly cap are supplied; AI=anthropic names the future adapter.
  void env;
  return memoryModel();
}

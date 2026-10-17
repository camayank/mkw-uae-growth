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

export interface AiModel {
  kind: string;
  /** Draft a scope from a founder's free-text description. Never throws for ordinary input; returns an empty draft instead. */
  draftScope(text: string, knownCodes: string[]): Promise<ScopeDraft>;
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
  };
}

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): AiModel {
  // Only the memory model exists until an API key and a monthly cap are supplied; AI=anthropic names the future adapter.
  void env;
  return memoryModel();
}

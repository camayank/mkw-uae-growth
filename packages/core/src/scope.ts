/**
 * Scoping: turn intake answers into a scope sheet of standard deliverable codes,
 * and give each engagement its milestones from templates. Deterministic rules first;
 * an AI scoping agent may propose additions, which ops approves.
 */
export interface IntakeAnswers {
  mode: "new_company" | "services";
  jurisdiction?: "free_zone" | "mainland" | "offshore" | "difc_adgm" | "not_sure";
  emirate: string;
  freeZone?: string | null;
  visas?: number;
  dependants?: number;
  addOns?: string[];
  services?: string[];
}

export interface ScopeLine {
  code: string;
  qty: number;
}

export interface ScopeSheet {
  lines: ScopeLine[];
  notes: string[];
}

const SETUP_CODE: Record<string, string> = {
  free_zone: "SET-FZ-LIC",
  mainland: "SET-ML-LIC",
  offshore: "SET-OFF",
  difc_adgm: "SET-FZ-LIC",
  not_sure: "SET-FZ-LIC",
};

export function buildScope(a: IntakeAnswers, knownCodes: Set<string>): ScopeSheet {
  const lines: ScopeLine[] = [];
  const notes: string[] = [];
  const add = (code: string, qty = 1) => {
    if (!knownCodes.has(code)) {
      notes.push(`Unknown code ${code} left out; ops to review`);
      return;
    }
    const existing = lines.find((l) => l.code === code);
    if (existing) existing.qty += qty;
    else lines.push({ code, qty });
  };

  if (a.mode === "new_company") {
    const j = a.jurisdiction ?? "not_sure";
    add(SETUP_CODE[j] ?? "SET-FZ-LIC");
    if (j === "not_sure") notes.push("Client unsure of jurisdiction: priced as free zone; partner to compare with mainland");
    if (j === "difc_adgm") notes.push("DIFC or ADGM requested: needs a request for quote, rate cards may not apply");
    if (j === "offshore" && (a.visas ?? 0) > 0) notes.push("Offshore companies cannot sponsor residence visas: visas left out");
    const visas = j === "offshore" ? 0 : Math.max(0, Math.floor(a.visas ?? 0));
    if (visas > 0) add("VISA-RES", visas);
    const deps = Math.max(0, Math.floor(a.dependants ?? 0));
    if (deps > 0) add("VISA-FAM", deps);
  }
  for (const code of [...(a.addOns ?? []), ...(a.services ?? [])]) add(code);
  if (lines.length === 0) notes.push("No deliverables selected");
  return { lines, notes };
}

export interface MilestoneTemplate {
  name: string;
  isKey: boolean;
  /** Working days from kick-off. */
  dueOffsetDays: number;
  evidence: string[];
}

export const MILESTONE_TEMPLATES: Record<string, MilestoneTemplate[]> = {
  "SET-FZ-LIC": [
    { name: "Documents collected and verified", isKey: false, dueOffsetDays: 2, evidence: ["document_checklist"] },
    { name: "Initial approval issued", isKey: true, dueOffsetDays: 5, evidence: ["initial_approval"] },
    { name: "Licence and establishment card issued", isKey: false, dueOffsetDays: 10, evidence: ["trade_licence", "establishment_card"] },
  ],
  "SET-ML-LIC": [
    { name: "Trade name reserved and initial approval", isKey: false, dueOffsetDays: 3, evidence: ["initial_approval"] },
    { name: "Memorandum signed and Ejari registered", isKey: true, dueOffsetDays: 10, evidence: ["moa", "ejari"] },
    { name: "Trade licence issued", isKey: false, dueOffsetDays: 15, evidence: ["trade_licence"] },
  ],
  "VISA-RES": [
    { name: "Entry permit issued", isKey: true, dueOffsetDays: 5, evidence: ["entry_permit"] },
    { name: "Medical and Emirates ID biometrics done", isKey: false, dueOffsetDays: 9, evidence: ["medical_receipt", "eid_receipt"] },
    { name: "Residence visa stamped", isKey: false, dueOffsetDays: 12, evidence: ["residence_visa"] },
  ],
  "BANK-ACC": [
    { name: "Bank-ready file submitted", isKey: true, dueOffsetDays: 5, evidence: ["bank_submission"] },
    { name: "Account opened", isKey: false, dueOffsetDays: 20, evidence: ["account_letter"] },
  ],
  "CT-RET": [
    { name: "Corporate tax registration", isKey: true, dueOffsetDays: 5, evidence: ["fta_trn_certificate"] },
    { name: "Return filed", isKey: false, dueOffsetDays: 30, evidence: ["fta_filing_receipt"] },
  ],
  "VAT-RET": [
    { name: "VAT registration", isKey: true, dueOffsetDays: 10, evidence: ["fta_trn_certificate"] },
    { name: "First return filed", isKey: false, dueOffsetDays: 60, evidence: ["fta_filing_receipt"] },
  ],
};

const DEFAULT_TEMPLATE: MilestoneTemplate[] = [
  { name: "Kick-off and documents received", isKey: false, dueOffsetDays: 2, evidence: ["document_checklist"] },
  { name: "Main deliverable completed", isKey: true, dueOffsetDays: 10, evidence: ["deliverable_proof"] },
  { name: "Handover and close", isKey: false, dueOffsetDays: 12, evidence: ["handover_note"] },
];

export function milestonesFor(code: string, qty: number): Array<MilestoneTemplate & { code: string }> {
  const template = MILESTONE_TEMPLATES[code] ?? DEFAULT_TEMPLATE;
  const suffix = qty > 1 ? ` (${qty})` : "";
  return template.map((m) => ({ ...m, name: `${m.name}${suffix}`, code }));
}

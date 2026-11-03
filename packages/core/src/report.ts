/**
 * The UAE Entity Assessment Report (E7D): the same assessment a founder sees on screen, as a document they can keep
 * and send. Two kinds, from real application data only:
 * - preliminary, from the public view (D80: only approved statements and figures, the rest "to be verified"), with
 *   no person's review behind it, and it says so at the top and in the closing note;
 * - reviewed, from the advice a named person at MKW Advisors approved for the client, with the reviewer and date.
 *
 * Pure: builds a structure of sections and lines; the API turns the lines into the text PDF. Never a partner cost,
 * a margin or a payout: the inputs do not carry them, and a test walks the output.
 */
import type { Advice, AdviceInput, Candidate, Reasoned } from "./advice.ts";
import type { EligibilityStatus, Finding } from "./eligibility.ts";
import type { PublicAssessment, PublicFinding, PublicPlace, PublicStatement } from "./public.ts";

export interface ReportSection {
  heading: string;
  lines: string[];
}

export interface Report {
  title: string;
  brand: string;
  reference: string;
  date: string;
  status: "preliminary" | "reviewed";
  statusLine: string;
  sections: ReportSection[];
}

export interface ReportMeta {
  reference: string;
  date: string;
  company?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  /** Approved general guidance to append (preliminary reports). */
  guidance?: Array<{ title: string; text: string }>;
}

const STRUCTURE: Record<string, string> = { free_zone: "Free zone company", mainland: "Mainland company", offshore: "Offshore company", difc_adgm: "DIFC or ADGM company" };
const STATUS_LABEL: Record<EligibilityStatus, string> = {
  ELIGIBLE_VERIFIED: "fits",
  ELIGIBLE_CONDITIONAL: "fits, with conditions",
  REQUIRES_VERIFICATION: "to be verified",
  DATA_UNAVAILABLE: "data missing",
  INELIGIBLE: "does not fit",
};
const words = (s: string | null | undefined) => String(s ?? "").replace(/_/g, " ");
const aed = (fils: number) => `AED ${Math.round(fils / 100).toLocaleString("en-US")}`;
const CONF: Record<string, string> = { verified: "verified rule", rule_of_thumb: "rule of thumb", UNCERTAIN: "UNCERTAIN" };
const FIG: Record<string, string> = { verified: "verified", rule_of_thumb: "rule of thumb", UNCERTAIN: "UNCERTAIN" };

/** The founder's profile from the answers, one line per answer given. */
function profileLines(a: AdviceInput): string[] {
  const row = (k: string, v: string | number | null | undefined) => (v == null || v === "" ? null : `${k}: ${v}`);
  return [
    row("Activity", words(a.activity)),
    row("Customers", a.customers === "uae_mainland" ? "inside the UAE" : a.customers === "international" ? "outside the UAE" : a.customers === "both" ? "inside and outside the UAE" : null),
    row("Residence visas", a.visas),
    row("Premises", words(a.premises)),
    row("Setup budget", a.budgetAed != null ? `AED ${Number(a.budgetAed).toLocaleString("en-US")}` : null),
    row("Expected yearly revenue", a.expectedTurnoverAed != null ? `AED ${Number(a.expectedTurnoverAed).toLocaleString("en-US")}` : null),
    row("Owners", a.ownerType === "company" ? "a company" : a.ownerType === "individuals" ? "one or more individuals" : null),
    row("Owner tax resident outside the UAE", a.foreignTaxResident === true ? "yes" : a.foreignTaxResident === false ? "no" : null),
    row("Structure in mind", a.jurisdiction && a.jurisdiction !== "not_sure" ? STRUCTURE[a.jurisdiction] ?? words(a.jurisdiction) : null),
    row("Wants to start", a.startWithin === "1_month" ? "within a month" : a.startWithin === "3_months" ? "within three months" : a.startWithin === "later" ? "later" : null),
    row("Emirate", a.emirate),
    row("Place in mind", a.freeZone ?? null),
  ].filter((x): x is string => !!x);
}

const pubStatement = (s: PublicStatement) => (s.text ? `[CHECKED] ${s.text}` : `[TO BE VERIFIED] ${s.topic}`);
const pubFinding = (f: PublicFinding) => (f.text ? `[${f.outcome === "condition" ? "CONDITION" : f.outcome === "fail" ? "DOES NOT FIT" : f.outcome === "unknown" ? "TO CONFIRM" : "CHECKED"}] ${f.text}` : `[TO BE VERIFIED] ${f.topic}`);

function pubPlaceLines(p: PublicPlace): string[] {
  const out = [`${p.zone} (${p.emirate}${p.authority ? `, licensed by ${p.authority}` : ""}): ${STATUS_LABEL[p.status]}`];
  if (p.figures) {
    out.push(`  Setup estimate ${aed(p.figures.costMinFils)} to ${aed(p.figures.costMaxFils)} [CHECKED]; ${p.figures.visaQuota} visa(s) in the standard package; about ${p.figures.timelineDays} working days`);
    if (p.figures.renewalMinFils) out.push(`  Yearly renewal estimate ${aed(p.figures.renewalMinFils)} to ${aed(p.figures.renewalMaxFils ?? p.figures.renewalMinFils)} [CHECKED]`);
    else if (p.figures.renewalToBeVerified) out.push("  Yearly renewal: to be verified");
    else out.push("  Yearly renewal: not on record");
  } else out.push("  Figures: to be verified by a person");
  if (p.facilities) out.push(`  Facilities on record: ${p.facilities.map(words).join(", ")}`);
  if (p.sourceUrl) out.push(`  Official source: ${p.sourceUrl}`);
  for (const f of p.findings) if (f.text || f.toBeVerified) out.push(`  ${pubFinding(f)}`);
  return out;
}

/** The preliminary report: what the public page shows, and nothing more. */
export function preliminaryReport(p: PublicAssessment, answers: AdviceInput, meta: ReportMeta): Report {
  const rec = p.structure.recommendation && p.structure.confirmed ? STRUCTURE[p.structure.recommendation] ?? words(p.structure.recommendation) : null;
  const fitting = p.places.filter((x) => x.status !== "INELIGIBLE");
  const unresolved = [...p.missingFacts.map((m) => `[DATA MISSING] ${m}`), ...p.contradictions.map((c) => `[ANSWERS TO CHECK] ${c}`)];
  const sections: ReportSection[] = [
    { heading: "Your business profile", lines: [...(meta.company ? [`Company: ${meta.company}`] : []), ...profileLines(answers)] },
    {
      heading: "Structures compared",
      lines: [
        rec ? `Pathway that fits your answers: ${rec} [CHECKED: every reason behind it is approved for public display]` : p.noViableOption ? "No structure fits every answer yet: a specialist at MKW Advisors looks at the case." : "The structure is to be confirmed by a person: not every reason behind it is approved for public display yet.",
        ...p.structure.reasons.map(pubStatement),
        ...p.structures.map((s) => `${STRUCTURE[s.structure] ?? s.structure}: ${STATUS_LABEL[s.status]}${s.findings.filter((f) => f.text).slice(0, 2).map((f) => `; ${pubFinding(f)}`).join("")}`),
      ],
    },
    {
      heading: "Jurisdictions compared",
      lines: fitting.length ? fitting.flatMap(pubPlaceLines) : [p.noViableOption ? "No place fits every answer yet." : "No places to show yet; a person reviews which fit."],
    },
    {
      heading: "Rejected or uncertain alternatives",
      lines: p.excluded.length ? p.excluded.map((x) => { const f = x.findings.find((y) => y.outcome === "fail" && y.text); return `${x.zone}: does not fit${f ? `; ${f.text}` : " (the reason is to be verified by a person)"}`; }) : ["None shown: every place the engine knows is listed above, as fitting or to be verified."],
    },
    { heading: "Licences, approvals and what follows after setup", lines: [...p.licences, ...p.obligations].length ? [...p.licences, ...p.obligations].map(pubStatement) : ["Nothing to show yet."] },
    { heading: "Cross-border risks for a specialist", lines: p.crossBorder.length ? p.crossBorder.map((s) => `${pubStatement(s)} [SPECIALIST REVIEW]`) : ["None raised by your answers."] },
    { heading: "Unresolved questions", lines: unresolved.length ? unresolved : ["None: every answer the engine needed was given."] },
    {
      heading: "Recommendation, subject to review",
      lines: [
        rec ? `The answers point to: ${rec}. A person at MKW Advisors confirms it against the current rules before anything is priced.` : "No recommendation is made on this page; a person at MKW Advisors reviews the case first.",
        `${p.approved.statements} of ${p.approved.ofStatements} statements and ${p.approved.places} of ${p.approved.ofPlaces} places in this report have been checked by a named person for public display; the rest are marked to be verified.`,
      ],
    },
  ];
  if (meta.guidance?.length) sections.push({ heading: "General guidance (approved wording)", lines: meta.guidance.flatMap((g) => [`${g.title}:`, g.text, ""]) });
  sections.push({
    heading: "Next steps",
    lines: [
      "Ask MKW Advisors to review this: a person checks every point marked to be verified, confirms what applies to you, and sends priced offers from vetted partner firms. No payment until you accept an offer.",
      "Open the page again with your saved code to see this result on the rules of that day.",
      `Rules and place data as of ${p.asOf ?? meta.date}.`,
    ],
  });
  return {
    title: "UAE Entity Assessment Report",
    brand: "Tasees, by MKW Advisors",
    reference: meta.reference,
    date: meta.date,
    status: "preliminary",
    statusLine: "PRELIMINARY: general information from your answers, not reviewed by a person and not advice.",
    sections,
  };
}

const reasoned = (r: Reasoned) => `${r.text} [${CONF[r.confidence] ?? r.confidence}]`;
const finding = (f: Finding) => `[${f.outcome === "condition" ? "CONDITION" : f.outcome === "fail" ? "DOES NOT FIT" : f.outcome === "unknown" ? "TO CONFIRM" : "PASS"}] ${f.text} [${CONF[f.confidence] ?? f.confidence}]`;
function placeLines(p: Candidate): string[] {
  const out = [`${p.zone} (${p.emirate}${p.authority ? `, licensed by ${p.authority}` : ""}): ${STATUS_LABEL[p.status ?? "REQUIRES_VERIFICATION"]}`];
  out.push(`  Setup estimate ${aed(p.costMinFils)} to ${aed(p.costMaxFils)} [${FIG[p.confidence] ?? p.confidence}${p.stale ? ", stale" : ""}]; ${p.visaQuota} visa(s) in the standard package; about ${p.timelineDays} working days`);
  if (p.renewalMinFils != null) out.push(`  Yearly renewal estimate ${aed(p.renewalMinFils)} to ${aed(p.renewalMaxFils ?? p.renewalMinFils)} [${FIG[p.renewalConfidence ?? "UNCERTAIN"]}]`);
  if (p.facilities) out.push(`  Facilities on record: ${p.facilities.map(words).join(", ")}`);
  if (p.sourceUrl) out.push(`  Source: ${p.sourceUrl}`);
  for (const w of p.why) out.push(`  ${w}`);
  for (const f of p.findings ?? []) if (f.outcome !== "pass") out.push(`  ${finding(f)}`);
  return out;
}

/** The reviewed report: the advice a named person approved for this client, with every confidence label. */
export function reviewedReport(a: Advice, answers: AdviceInput, meta: ReportMeta): Report {
  const rec = a.structure.recommendation ? STRUCTURE[a.structure.recommendation] ?? words(a.structure.recommendation) : null;
  const unresolved = [...(a.missingFacts ?? []).map((m) => `[DATA MISSING] ${m}`), ...(a.contradictions ?? []).map((c) => `[ANSWERS TO CHECK] ${c}`)];
  const sections: ReportSection[] = [
    { heading: "Your business profile", lines: [...(meta.company ? [`Company: ${meta.company}`] : []), ...profileLines(answers)] },
    {
      heading: "Structures compared",
      lines: [
        a.noViableOption ? "No structure fits every answer as they stand; the structure named below is an explanation, not a recommendation." : rec ? `Recommended structure: ${rec}` : "No structure recommended.",
        ...a.structure.reasons.map(reasoned),
        ...(a.structures ?? []).map((s) => `${STRUCTURE[s.structure] ?? s.structure}: ${STATUS_LABEL[s.status]}${s.findings.filter((f) => f.outcome !== "pass").slice(0, 2).map((f) => `; ${finding(f)}`).join("")}`),
      ],
    },
    { heading: "Jurisdictions compared", lines: a.places.length ? a.places.flatMap(placeLines) : ["No place fits every answer."] },
    // A rejection carries its finding with the confidence label, as on the advice page.
    { heading: "Rejected alternatives", lines: (a.excluded ?? []).length ? (a.excluded ?? []).map((x) => { const f = (x.findings ?? []).find((y) => y.outcome === "fail"); return `${x.zone}: does not fit${f ? `; ${finding(f)}` : ""}`; }) : ["None."] },
    { heading: "Licences, approvals and what follows after setup", lines: [...a.licences, ...a.obligations].map(reasoned) },
    { heading: "Cross-border risks for a specialist", lines: (a.crossBorder ?? []).length ? (a.crossBorder ?? []).map((r) => `${reasoned(r)} [SPECIALIST REVIEW]`) : ["None raised by the answers."] },
    { heading: "Unresolved questions", lines: unresolved.length ? unresolved : ["None."] },
  ];
  // The closing sentence is decided by what the report prints, not by the advice's flags alone: a renewal figure
  // can be unverified while every rule and setup figure is verified.
  const anyUnverified = a.hasUncertain || a.needsVerification || sections.some((s) => s.lines.some((l) => /\[(UNCERTAIN|rule of thumb)\]/.test(l)));
  sections.push(
    {
      heading: "Recommendation and its limits",
      lines: [
        anyUnverified ? "Some points above rest on rules or figures marked rule of thumb or UNCERTAIN; they are confirmed before the offer is priced and nothing is filed on them." : "Every point above rests on a verified rule or figure as of the data date.",
        `Rules and place data as of ${a.dataVersion?.asOf ?? meta.date}. Nothing in this report is a statutory conclusion or a filing; a priced offer follows a person's scoping review.`,
      ],
    },
    { heading: "Next steps", lines: ["Your request is with MKW Advisors; the offers that follow price exactly the structure and place settled here. Sign in to Tasees to follow the request and reply to any question."] },
  );
  return {
    title: "UAE Entity Assessment Report",
    brand: "Tasees, by MKW Advisors",
    reference: meta.reference,
    date: meta.date,
    status: "reviewed",
    statusLine: meta.reviewedBy ? `REVIEWED by ${meta.reviewedBy} at MKW Advisors on ${meta.reviewedAt ?? meta.date}.` : "REVIEWED by MKW Advisors.",
    sections,
  };
}

/** Wrap a line at a width, keeping its indent; blank lines stay. */
export function wrap(line: string, width = 82): string[] {
  if (line.length <= width) return [line];
  const indent = line.match(/^\s*/)![0];
  const out: string[] = [];
  let cur = "";
  const room = Math.max(8, width - indent.length);
  const words = line.trim().split(/\s+/).flatMap((w) => (w.length > room ? (w.match(new RegExp(`.{1,${room}}`, "g")) ?? [w]) : [w])); // a long URL is split, never drawn off the page
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if ((indent + next).length > width && cur) { out.push(indent + cur); cur = word; } else cur = next;
  }
  if (cur) out.push(indent + cur);
  return out;
}

/** The report as lines for the text PDF: a header on page one, each section titled, the status on every section. */
export function reportLines(r: Report, width = 82): string[] {
  const lines: string[] = [r.brand, r.title, `Reference ${r.reference}  Date ${r.date}`, "", ...wrap(r.statusLine, width), ""];
  for (const s of r.sections) {
    lines.push(s.heading.toUpperCase(), "-".repeat(Math.min(width, s.heading.length)));
    for (const l of s.lines) lines.push(...wrap(l, width));
    lines.push("");
  }
  lines.push(...wrap(`${r.status === "preliminary" ? "Preliminary general information, not advice." : "Reviewed advice for the client named above."} Tasees is a service of MKW Advisors; partner firms deliver the work; MKW Advisors manages scope, price, quality and payment. Nothing is filed automatically.`, width));
  return lines;
}

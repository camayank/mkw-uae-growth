/**
 * The jurisdiction coverage matrix (E7B): what the catalogue holds for every authority and place, counted once each,
 * and the evidence still to obtain, ordered by the first commercial wave. Pure: the service loads the rows, this
 * module counts and lists. Nothing here invents a figure; a missing record is a task, never a value.
 */
import type { Confidence } from "./advice.ts";
import { PLACE_FIELDS, type AuthorityKind, type FieldEvidence, type PlaceKind, type PlaceStatus } from "./catalogue.ts";

export interface CoverageAuthority {
  id: string;
  name: string;
  kind: AuthorityKind;
  emirate: string | null;
  parentId: string | null;
  active: boolean;
}

export interface CoveragePlace {
  name: string;
  emirate: string;
  placeKind: PlaceKind;
  status: PlaceStatus;
  priority: number | null;
  authorityId: string | null;
  authority: string | null;
  /** Evidence per field as it stands today (absent: nothing on record). */
  evidence: Record<string, FieldEvidence | undefined>;
  /** Current values the matrix counts as "on record". */
  has: Partial<Record<(typeof PLACE_FIELDS)[number], boolean>>;
  confidence: Confidence;
  stale: boolean;
}

export interface CoverageApproval {
  kind: "rule" | "place" | "guide";
  subject: string;
  state: "not approved" | "lapsed";
}

/** The fields the verifier is asked for, in the order a place's record is read. */
export const BACKLOG_FIELDS = ["cost", "renewal_cost", "government_charges", "visa_quota", "visa_max", "timeline_days", "facilities", "activities_listed", "activity_codes", "legal_forms", "conditions", "exclusions"] as const;
export type BacklogField = (typeof BACKLOG_FIELDS)[number];
export type TaskReason = "missing" | "unverified" | "stale" | "due" | "intermediary";

export interface EvidenceTask {
  place: string;
  emirate: string;
  authority: string | null;
  priority: number | null;
  field: BacklogField;
  reason: TaskReason;
  /** What the verifier should obtain, in one line. */
  ask: string;
}

export interface CoverageMatrix {
  asOf: string;
  emirates: string[];
  authorities: { total: number; active: number; byKind: Record<string, number>; byEmirate: Record<string, number> };
  places: {
    total: number;
    active: number;
    inactive: number;
    historical: number;
    priority: number;
    byKind: Record<string, number>;
    /** emirate → kind → count of places that are not historical. */
    matrix: Record<string, Record<string, number>>;
  };
  /** Per field: places (not historical) with a value on record, with verified and unexpired evidence, and stale. */
  fields: Record<string, { onRecord: number; verified: number; stale: number; of: number }>;
  expiring: { stale: number; within30: number; within90: number; items: Array<{ place: string; field: string; nextVerification: string | null; stale: boolean }> };
  approvals: { outstanding: number; items: CoverageApproval[] };
  tasks: EvidenceTask[];
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const ASK: Record<BacklogField, string> = {
  cost: "the all-in setup cost range for the standard package, from the authority's published fee schedule",
  renewal_cost: "the yearly renewal cost range, from the authority's published fee schedule",
  government_charges: "the authority's own charges (registration, licence, establishment card) as published",
  visa_quota: "the number of residence visas in the standard package",
  visa_max: "the most visas the place allows, and what decides it (office size, package)",
  timeline_days: "the published setup time in working days",
  facilities: "the facilities the place offers (office, warehouse, industrial, retail, clinic)",
  activities_listed: "which of our activity groups the authority's own activity list covers",
  activity_codes: "the exact licence activities (code and name) for the groups we serve, from the authority's list",
  legal_forms: "the legal forms the authority registers (FZE, FZCO, LLC, branch, ...)",
  conditions: "conditions and exceptions on the licence (approvals, minimum space, nationality, capital)",
  exclusions: "charges the published fees leave out (visas, medical, Emirates ID, attestation, office)",
};

/** Count everything once, and list what is still to obtain. */
export function coverageMatrix(asOf: string, authorities: CoverageAuthority[], places: CoveragePlace[], approvals: CoverageApproval[]): CoverageMatrix {
  const count = (keys: Array<string | null | undefined>) => {
    const out: Record<string, number> = {};
    for (const k of keys) out[k ?? "federal"] = (out[k ?? "federal"] ?? 0) + 1;
    return out;
  };
  const live = places.filter((p) => p.status !== "historical");
  const emirates = [...new Set([...places.map((p) => p.emirate), ...authorities.map((a) => a.emirate).filter((e): e is string => !!e)])].sort();
  const matrix: Record<string, Record<string, number>> = {};
  for (const p of live) {
    matrix[p.emirate] ??= {};
    matrix[p.emirate]![p.placeKind] = (matrix[p.emirate]![p.placeKind] ?? 0) + 1;
  }
  const fields: CoverageMatrix["fields"] = {};
  for (const f of PLACE_FIELDS) {
    const onRecord = live.filter((p) => p.has[f]).length;
    const verified = live.filter((p) => p.has[f] && p.evidence[f]?.confidence === "verified" && !p.evidence[f]?.stale).length;
    const stale = live.filter((p) => p.has[f] && p.evidence[f]?.stale).length;
    fields[f] = { onRecord, verified, stale, of: live.length };
  }
  const in30 = addDays(asOf, 30);
  const in90 = addDays(asOf, 90);
  const expiringItems: CoverageMatrix["expiring"]["items"] = [];
  for (const p of live)
    for (const [field, e] of Object.entries(p.evidence)) {
      if (!e || !p.has[field as BacklogField]) continue;
      if (e.stale || (e.nextVerification && e.nextVerification <= in90)) expiringItems.push({ place: p.name, field, nextVerification: e.nextVerification, stale: e.stale });
    }
  expiringItems.sort((a, b) => Number(b.stale) - Number(a.stale) || (a.nextVerification ?? "").localeCompare(b.nextVerification ?? "") || a.place.localeCompare(b.place));
  const tasks: EvidenceTask[] = [];
  for (const p of live) {
    for (const field of BACKLOG_FIELDS) {
      const e = p.evidence[field];
      let reason: TaskReason | null = null;
      if (!p.has[field]) reason = "missing";
      else if (e?.stale) reason = "stale";
      else if (e && e.recorded !== "verified") reason = e.sourceKind === "intermediary" ? "intermediary" : "unverified";
      else if (e?.nextVerification && e.nextVerification <= in30) reason = "due";
      if (!reason) continue;
      tasks.push({ place: p.name, emirate: p.emirate, authority: p.authority, priority: p.priority, field, reason, ask: `Obtain ${ASK[field]}${reason === "missing" ? "" : reason === "stale" ? "; the evidence on record is past its re-verification date" : reason === "intermediary" ? "; the figure on record comes from an intermediary, not the authority" : reason === "due" ? "; the evidence on record is due for re-checking" : "; the figure on record is not verified"}.` });
    }
  }
  const prio = (t: EvidenceTask) => t.priority ?? 99;
  tasks.sort((a, b) => prio(a) - prio(b) || a.place.localeCompare(b.place) || BACKLOG_FIELDS.indexOf(a.field) - BACKLOG_FIELDS.indexOf(b.field));
  return {
    asOf,
    emirates,
    authorities: { total: authorities.length, active: authorities.filter((a) => a.active).length, byKind: count(authorities.map((a) => a.kind)), byEmirate: count(authorities.map((a) => a.emirate)) },
    places: {
      total: places.length,
      active: places.filter((p) => p.status === "active").length,
      inactive: places.filter((p) => p.status === "inactive").length,
      historical: places.filter((p) => p.status === "historical").length,
      priority: live.filter((p) => p.priority === 1).length,
      byKind: count(live.map((p) => p.placeKind)),
      matrix,
    },
    fields,
    expiring: { stale: expiringItems.filter((x) => x.stale).length, within30: expiringItems.filter((x) => !x.stale && x.nextVerification! <= in30).length, within90: expiringItems.filter((x) => !x.stale).length, items: expiringItems },
    approvals: { outstanding: approvals.length, items: approvals },
    tasks,
  };
}

/** The importer's own column layout, one row per task, for the verifier to fill in and send back. */
export const BACKLOG_CSV_HEADER = ["Kind", "Place or authority", "Field", "Value", "Source", "Evidence date", "Confidence", "Verified by", "Next verification", "Effective date", "Reference", "Source kind", "Note", "To obtain"];
/** The importer's columns left blank for the verifier (nothing pre-filled, not even the source kind); the ask sits in
 *  a last column the importer does not read, so it never becomes a fact's note. */
export function backlogCsv(tasks: EvidenceTask[]): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [BACKLOG_CSV_HEADER.join(",")];
  for (const t of tasks) lines.push(["place", t.place, t.field, "", "", "", "", "", "", "", "", "", "", `${t.reason}: ${t.ask}${t.priority ? ` (wave ${t.priority})` : ""}`].map(cell).join(","));
  return lines.join("\n") + "\n";
}

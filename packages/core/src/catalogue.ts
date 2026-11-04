/**
 * The jurisdiction catalogue's evidence rules (E2). Every figure and permission the engine uses is a recorded fact:
 * a value, its source, the date of the evidence, a confidence, a named verifier when verified, and the date by which
 * it must be checked again. Facts are append-only; the latest one for a subject and field is the current value.
 *
 * Pure: parsing a fact's value, and working out how much confidence a fact still deserves on a given day. A fact past
 * its re-verification date drops one level (verified to rule of thumb, rule of thumb to UNCERTAIN) and is labelled
 * stale, so old evidence can never pass as verified.
 */
import type { Activity, Confidence } from "./advice.ts";

export type SubjectKind = "place" | "authority" | "rule";

/** Days a verified fact stays current when no re-verification date is given (D77). */
export const DEFAULT_REVERIFY_DAYS = 180;
/** The longest any fact may go before it must be checked again: two years. */
export const MAX_REVERIFY_DAYS = 730;

export const PLACE_FIELDS = ["cost", "renewal_cost", "visa_quota", "visa_max", "timeline_days", "facilities", "activities_listed", "activity_codes", "legal_forms", "government_charges", "conditions", "exclusions", "coordinates"] as const;
export const AUTHORITY_FIELDS = ["parent", "registrar", "website"] as const;
export type PlaceField = (typeof PLACE_FIELDS)[number];
export type AuthorityField = (typeof AUTHORITY_FIELDS)[number];

/** Place fields the engine's eligibility and ranking rely on: their weakest confidence is the place's confidence. */
export const ENGINE_FIELDS: PlaceField[] = ["cost", "visa_quota", "timeline_days", "visa_max", "facilities"];
/** Of those, the ones every place has a value for (the others count only once recorded). */
export const ALWAYS_PRESENT: PlaceField[] = ["cost", "visa_quota", "timeline_days"];

export const FIELD_LABEL: Record<string, string> = {
  cost: "Setup cost range (AED)",
  renewal_cost: "Yearly renewal cost range (AED)",
  visa_quota: "Visas in the standard package",
  visa_max: "Most visas allowed",
  timeline_days: "Setup time (working days)",
  facilities: "Facilities",
  activities_listed: "Activity groups on the authority's list",
  legal_forms: "Legal forms",
  coordinates: "Coordinates (latitude, longitude)",
  activity_codes: "Exact licence activities (code and name)",
  government_charges: "Government charges (AED)",
  conditions: "Conditions and exceptions",
  exclusions: "Additional charges and exclusions",
  parent: "Parent authority",
  registrar: "Registrar",
  website: "Official website",
};

export const FACILITIES = ["office", "warehouse", "industrial", "retail", "clinic"] as const;

/** E7B: what a place is, so an inventory counts each thing once. A sub-zone sits under its parent authority. */
export const PLACE_KINDS = ["free_zone", "sub_zone", "offshore_registry", "mainland", "financial_centre", "industrial_development"] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];
export const PLACE_KIND_LABEL: Record<PlaceKind, string> = {
  free_zone: "Free zone operating location",
  sub_zone: "Sub-zone or specialised district",
  offshore_registry: "Offshore registry",
  mainland: "Mainland authority",
  financial_centre: "Regulated financial centre",
  industrial_development: "Non-free-zone industrial development",
};
export const PLACE_STATUSES = ["active", "inactive", "historical"] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];
export const AUTHORITY_KINDS = ["free_zone_authority", "mainland_department", "offshore_registry", "financial_centre", "regulator", "industrial_development"] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];
/** Where a fact's source comes from: the authority or regulator itself, or an intermediary (an agent, a news page). */
export const SOURCE_KINDS = ["official", "intermediary"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const ACTIVITIES: Activity[] = ["trading", "consulting", "ecommerce", "tech", "holding", "finance", "virtual_assets", "health", "education", "food", "construction", "manufacturing", "other"];

const CONFIDENCE_ORDER: Confidence[] = ["UNCERTAIN", "rule_of_thumb", "verified"];
const down = (c: Confidence): Confidence => CONFIDENCE_ORDER[Math.max(0, CONFIDENCE_ORDER.indexOf(c) - 1)]!;

export interface EffectiveConfidence {
  confidence: Confidence;
  /** Past its re-verification date on `asOf`. */
  stale: boolean;
}

/** How much confidence a fact recorded at `confidence` still deserves on `asOf` (YYYY-MM-DD). */
export function effectiveConfidence(confidence: Confidence, nextVerification: string | null | undefined, asOf: string): EffectiveConfidence {
  if (confidence === "UNCERTAIN") return { confidence, stale: false };
  if (nextVerification && nextVerification < asOf) return { confidence: down(confidence), stale: true };
  return { confidence, stale: false };
}

/** The re-verification date to use when none is given: the evidence date plus the default period. */
export function defaultNextVerification(evidenceDate: string, days = DEFAULT_REVERIFY_DAYS): string {
  const d = new Date(`${evidenceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Evidence behind one current value, as the engine and the console see it. */
export interface FieldEvidence {
  field: string;
  /** Confidence as recorded. */
  recorded: Confidence;
  /** Confidence it deserves today. */
  confidence: Confidence;
  stale: boolean;
  evidenceDate: string | null;
  nextVerification: string | null;
  verifiedBy: string | null;
  sourceUrl: string;
  factId: number | null;
  /** E7B: where the source comes from, when the figure takes effect, and the exact reference in the source. */
  sourceKind?: SourceKind;
  effectiveDate?: string | null;
  reference?: string;
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };
const ok = (value: unknown): Parsed => ({ ok: true, value });
const bad = (error: string): Parsed => ({ ok: false, error });

/** The most an amount may be: AED 1 billion, far above any setup fee and well inside safe integer fils. */
export const MAX_AED = 1_000_000_000;
const aedToFils = (s: string): number | null => {
  const t = s.replace(/aed/i, "").replace(/,/g, "").trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(t) || Number(t.split(".")[0]) > MAX_AED) return null;
  // Integer fils without floating point: whole dirhams and up to two decimals.
  const [whole, dec = ""] = t.split(".");
  return Number(whole) * 100 + Number(dec.padEnd(2, "0"));
};
const list = (s: string) =>
  s
    .split(/[;,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const int = (s: string, min: number, max: number): number | null => (/^\d+$/.test(s.trim()) && Number(s) >= min && Number(s) <= max ? Number(s) : null);

/**
 * Parse a fact's value from the text a person types or a spreadsheet holds. Money is AED in, integer fils out; lists
 * are separated by semicolons or commas. Returns the value as stored, or why it cannot be.
 */
export function parseFactValue(kind: SubjectKind, field: string, text: string): Parsed {
  const s = String(text ?? "").trim();
  if (kind === "place") {
    switch (field) {
      case "cost":
      case "renewal_cost": {
        const m = s.match(/^(.+?)\s*(?:-|–|to)\s*(.+)$/i);
        const [lo, hi] = m ? [aedToFils(m[1]!), aedToFils(m[2]!)] : [aedToFils(s), aedToFils(s)];
        if (lo === null || hi === null) return bad(`"${s}" is not an AED amount or range (for example 12000-20000)`);
        if (lo > hi) return bad("the lower amount is above the upper one");
        if (lo === 0 && hi === 0) return bad("a cost of zero is not evidence; leave the fact unrecorded instead");
        return ok({ minFils: lo, maxFils: hi });
      }
      case "visa_quota": {
        const n = int(s, 0, 100);
        return n === null ? bad(`"${s}" is not a number of visas`) : ok(n);
      }
      case "visa_max": {
        if (/^(none|no limit|unlimited)$/i.test(s)) return ok(null);
        const n = int(s, 0, 5000);
        return n === null ? bad(`"${s}" is not a number of visas (or "no limit")`) : ok(n);
      }
      case "timeline_days": {
        const n = int(s, 1, 365);
        return n === null ? bad(`"${s}" is not a number of working days between 1 and 365`) : ok(n);
      }
      case "facilities": {
        const v = list(s).map((x) => x.toLowerCase());
        const unknown = v.filter((x) => !(FACILITIES as readonly string[]).includes(x));
        if (!v.length) return bad("no facilities given");
        return unknown.length ? bad(`unknown facilities: ${unknown.join(", ")} (use ${FACILITIES.join(", ")})`) : ok([...new Set(v)].sort());
      }
      case "activities_listed": {
        const v = list(s).map((x) => x.toLowerCase().replace(/\s+/g, "_"));
        const unknown = v.filter((x) => !(ACTIVITIES as string[]).includes(x));
        if (!v.length) return bad("no activity groups given");
        return unknown.length ? bad(`unknown activity groups: ${unknown.join(", ")}`) : ok([...new Set(v)].sort());
      }
      case "legal_forms": {
        const v = list(s);
        if (!v.length || v.some((x) => x.length > 80)) return bad("give one or more legal forms, each under 80 characters");
        return ok([...new Set(v)]);
      }
      case "activity_codes": {
        // "6201 · Software development; 6202 · IT consultancy": a code and a name each, as the authority lists them.
        const v = list(s);
        if (!v.length || v.some((x) => x.length > 160)) return bad("give one or more activities as the authority lists them (code and name), each under 160 characters");
        return ok([...new Set(v)]);
      }
      case "conditions":
      case "exclusions": {
        const v = list(s);
        if (!v.length || v.some((x) => x.length > 240)) return bad("give one or more items, each under 240 characters");
        return ok([...new Set(v)]);
      }
      case "government_charges": {
        const m = s.match(/^(.+?)\s*(?:-|–|to)\s*(.+)$/i);
        const [lo, hi] = m ? [aedToFils(m[1]!), aedToFils(m[2]!)] : [aedToFils(s), aedToFils(s)];
        if (lo === null || hi === null) return bad(`"${s}" is not an AED amount or range`);
        if (lo > hi) return bad("the lower amount is above the upper one");
        return ok({ minFils: lo, maxFils: hi });
      }
      case "coordinates": {
        const m = s.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
        if (!m) return bad(`"${s}" is not "latitude, longitude"`);
        const lat = Number(m[1]);
        const lng = Number(m[2]);
        if (lat < 22 || lat > 27 || lng < 51 || lng > 57) return bad("the coordinates are not in the UAE");
        return ok({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 });
      }
    }
    return bad(`"${field}" is not a place field (${PLACE_FIELDS.join(", ")})`);
  }
  if (kind === "authority") {
    switch (field) {
      case "parent":
        return /^[a-z0-9_]+$/.test(s) ? ok(s) : bad("give the parent authority's id");
      case "registrar":
        return s.length >= 2 && s.length <= 200 ? ok(s) : bad("give the registrar's name");
      case "website":
        return /^https?:\/\/\S+$/i.test(s) ? ok(s) : bad("the website must be an http(s) link");
    }
    return bad(`"${field}" is not an authority field (${AUTHORITY_FIELDS.join(", ")})`);
  }
  return bad("rule facts are recorded by verifying the rule");
}

/** Lower-case, single-spaced, without punctuation: how names and aliases are compared. */
export const normaliseName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// E23: evidence operations ----------------------------------------------------------------------------------------

/** What a new fact is, against the current one for the same subject and field. */
export type FactChangeKind = "first" | "same" | "change" | "conflict";
export interface FactChange {
  kind: FactChangeKind;
  /** In words, for the verifier and the audit trail. */
  reason: string;
}
export interface FactForChange {
  value: unknown;
  confidence: Confidence;
  evidenceDate: string;
  nextVerification?: string | null;
  sourceUrl?: string | null;
  sourceKind?: SourceKind | null;
}

const RANK: Record<Confidence, number> = { verified: 2, rule_of_thumb: 1, UNCERTAIN: 0 };

/** Deep equality for fact values (numbers, strings, arrays, plain objects). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameValue(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * A contradicting source never changes a figure on its own (E23). A differing value is a conflict when it is weaker
 * than the current figure deserves today, older than the current evidence, or of the same date from another source;
 * otherwise it is a change (newer evidence, at least as strong), which supersedes. The verifier decides a conflict.
 */
export function classifyFactChange(current: FactForChange | null, incoming: FactForChange, asOf: string): FactChange {
  if (!current) return { kind: "first", reason: "the first fact recorded for this field" };
  if (sameValue(current.value, incoming.value)) return { kind: "same", reason: "the same value as the current fact" };
  const today = effectiveConfidence(current.confidence, current.nextVerification ?? null, asOf);
  if (RANK[incoming.confidence] < RANK[today.confidence]) {
    return { kind: "conflict", reason: `a ${incoming.confidence} ${incoming.sourceKind === "intermediary" ? "intermediary " : ""}source contradicts the current ${today.confidence} figure${today.stale ? " (stale)" : ""}` };
  }
  if (incoming.evidenceDate < current.evidenceDate) {
    return { kind: "conflict", reason: `older evidence (${incoming.evidenceDate}) contradicts the current figure (evidence ${current.evidenceDate})` };
  }
  if (incoming.evidenceDate === current.evidenceDate && (incoming.sourceUrl ?? "") !== (current.sourceUrl ?? "")) {
    return { kind: "conflict", reason: `two sources of the same date (${incoming.evidenceDate}) disagree` };
  }
  return { kind: "change", reason: `newer evidence (${incoming.evidenceDate}, ${incoming.confidence}) supersedes the figure of ${current.evidenceDate}` };
}

export interface VersionDiff<T extends { id: number; value: unknown }> {
  previous: unknown;
  /** For amounts: the difference; for ranges: the difference of each bound; null when values are not comparable. */
  delta: number | { minFils: number; maxFils: number } | null;
}

const isRange = (v: unknown): v is { minFils: number; maxFils: number } =>
  !!v && typeof v === "object" && typeof (v as { minFils?: unknown }).minFils === "number" && typeof (v as { maxFils?: unknown }).maxFils === "number";

/**
 * Each version against what it replaced, oldest first: the fact it superseded when `previousOf` says so (a conflict
 * recorded in between is not what a new figure replaced), else the version listed before it.
 */
export function diffVersions<T extends { id: number; value: unknown }>(versions: T[], previousOf?: (v: T) => unknown): Array<T & VersionDiff<T>> {
  return versions.map((v, i) => {
    const named = previousOf?.(v);
    const prev = named !== undefined ? named : i > 0 ? versions[i - 1]!.value : null;
    let delta: VersionDiff<T>["delta"] = null;
    if (i > 0) {
      if (typeof v.value === "number" && typeof prev === "number") delta = v.value - prev;
      else if (isRange(v.value) && isRange(prev)) delta = { minFils: v.value.minFils - prev.minFils, maxFils: v.value.maxFils - prev.maxFils };
    }
    return { ...v, previous: prev, delta };
  });
}

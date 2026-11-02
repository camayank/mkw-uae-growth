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

export const PLACE_FIELDS = ["cost", "renewal_cost", "visa_quota", "visa_max", "timeline_days", "facilities", "activities_listed", "legal_forms", "coordinates"] as const;
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
  parent: "Parent authority",
  registrar: "Registrar",
  website: "Official website",
};

export const FACILITIES = ["office", "warehouse", "industrial", "retail", "clinic"] as const;
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

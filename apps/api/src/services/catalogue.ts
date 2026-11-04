import { createHash } from "node:crypto";
import {
  ALWAYS_PRESENT,
  ENGINE_FIELDS,
  FIELD_LABEL,
  PLACE_FIELDS,
  AUTHORITY_FIELDS,
  defaultNextVerification,
  effectiveConfidence,
  normaliseName,
  parseFactValue,
  weaker,
  ELIGIBILITY_ENGINE_VERSION,
  MAX_REVERIFY_DAYS,
  PLACE_KINDS,
  PLACE_STATUSES,
  coverageMatrix,
  backlogCsv,
  type CoverageApproval,
  type CoveragePlace,
  type PlaceKind,
  type PlaceStatus,
  type SourceKind,
  type Confidence,
  type DataVersion,
  type FieldEvidence,
  type ScopingRule,
  type SubjectKind,
  type Zone, classifyFactChange, diffVersions, type FactChange,
} from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import type { Queryable as Q } from "../lib/db.ts";

/** Today in the Gulf (Asia/Dubai) by the application clock: the day evidence is dated and judged on (D77). */
export async function catalogueToday(tx: Q): Promise<string> {
  const r = await tx.query<{ d: string }>("select gulf(app_now())::text as d");
  return String(r.rows[0]!.d).slice(0, 10);
}

/**
 * The jurisdiction catalogue (E2): authorities, places and rules, each current value backed by the latest recorded
 * fact. Facts are append-only (the database refuses update and delete); recording one also refreshes the current-value
 * cache on the place, authority or rule in the same transaction, and writes one audit event.
 */

export interface FactInput {
  subjectKind: SubjectKind;
  subject: string;
  field: string;
  value: unknown;
  sourceUrl?: string;
  evidenceDate: string;
  confidence: Confidence;
  verifiedBy?: string | null;
  nextVerification?: string | null;
  note?: string;
  /** E23: recorded by the founder's own verification of the place or rule, so a would-be conflict is a change. */
  decided?: boolean;
  /** E7B: when the figure takes effect, the exact reference in the source, and whether the source is official. */
  effectiveDate?: string | null;
  reference?: string;
  sourceKind?: SourceKind;
}

const httpUrl = (u: string) => /^https?:\/\/\S+$/i.test(u.trim());
const isoDate = (s: string | null | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

interface FactRow {
  id: number;
  subject_kind: SubjectKind;
  subject: string;
  field: string;
  value: unknown;
  source_url: string;
  evidence_date: string;
  confidence: Confidence;
  verified_by: string | null;
  next_verification: string | null;
  note: string;
  recorded_at: string;
  effective_date: string | null;
  reference: string;
  source_kind: SourceKind;
  /** E23: what the fact was against the current one when recorded, and the verifier's decision. */
  supersedes_id?: number | string | null;
  change_kind?: "first" | "same" | "change" | "conflict";
  change_reason?: string;
}

const FACT_COLUMNS = `id, subject_kind, subject, field, value, source_url, evidence_date::text as evidence_date, confidence, verified_by,
  next_verification::text as next_verification, note, recorded_at, effective_date::text as effective_date, reference, source_kind,
  supersedes_id, change_kind, change_reason`;

/** The same columns qualified with the facts table's alias, for queries that join other tables. */
const FACT_COLUMNS_F = FACT_COLUMNS.replace(/(^|,\s*)(\w+)/g, "$1f.$2");

/**
 * E23: a fact counts as current only if it is not a conflict, or the verifier accepted it. The newest such fact per
 * field is the figure the engine and every screen use; an unreviewed or kept conflict never is.
 */
const CURRENT_FACT = `(f.change_kind <> 'conflict' or exists (select 1 from catalogue_fact_reviews r where r.fact_id = f.id and r.decision = 'accept'))`;

/** The latest fact per subject and field, for one kind of subject. */
async function latestFacts(tx: Queryable, kind: SubjectKind): Promise<Map<string, Map<string, FactRow>>> {
  const r = await tx.query<FactRow>(
    `select distinct on (subject, field) ${FACT_COLUMNS} from catalogue_facts f where subject_kind = $1 and ${CURRENT_FACT} order by subject, field, id desc`,
    [kind],
  );
  const out = new Map<string, Map<string, FactRow>>();
  for (const f of r.rows) {
    if (!out.has(f.subject)) out.set(f.subject, new Map());
    out.get(f.subject)!.set(f.field, { ...f, id: num(f.id) });
  }
  return out;
}

const evidenceOf = (f: FactRow, asOf: string): FieldEvidence => {
  const e = effectiveConfidence(f.confidence, f.next_verification, asOf);
  return {
    field: f.field,
    recorded: f.confidence,
    confidence: e.confidence,
    stale: e.stale,
    evidenceDate: f.evidence_date,
    nextVerification: f.next_verification,
    verifiedBy: f.verified_by,
    sourceUrl: f.source_url,
    factId: f.id,
    sourceKind: f.source_kind ?? "official",
    effectiveDate: f.effective_date ?? null,
    reference: f.reference ?? "",
  };
};

/** A value on record before E2 (the seed, or a verification made before facts existed), with what it deserves today. */
const legacyEvidence = (field: string, confidence: Confidence, verifiedAt: string | null, verifiedBy: string | null, sourceUrl: string, asOf: string): FieldEvidence => {
  const next = confidence === "UNCERTAIN" || !verifiedAt ? null : defaultNextVerification(verifiedAt);
  const e = effectiveConfidence(confidence, next, asOf);
  return { field, recorded: confidence, confidence: e.confidence, stale: e.stale, evidenceDate: verifiedAt, nextVerification: next, verifiedBy, sourceUrl, factId: null };
};

/** Scoping rules with the confidence each deserves on `asOf` (a rule past its re-verification date drops a level). */
export async function loadRules(tx: Queryable, asOf?: string): Promise<Array<ScopingRule & { recorded: ScopingRule["confidence"]; stale: boolean; version: number; nextVerification: string | null }>> {
  const day = asOf ?? (await catalogueToday(tx));
  const r = await tx.query<Record<string, unknown>>("select *, verified_at::text as verified_at_text, next_verification::text as next_text from scoping_rules order by kind, key");
  return r.rows.map((x) => {
    const recorded = x.confidence as Confidence;
    const verifiedAt = x.verified_at_text ? String(x.verified_at_text).slice(0, 10) : null;
    const next = (x.next_text as string | null) ?? (recorded !== "UNCERTAIN" && verifiedAt ? defaultNextVerification(verifiedAt) : null);
    const e = effectiveConfidence(recorded, next, day);
    return {
      key: String(x.key),
      kind: x.kind as ScopingRule["kind"],
      statement: String(x.statement),
      parameters: (x.parameters as Record<string, unknown>) ?? {},
      sourceUrl: String(x.source_url ?? ""),
      confidence: e.confidence,
      recorded,
      stale: e.stale,
      version: num(x.version),
      nextVerification: next,
      verifiedBy: (x.verified_by as string | null) ?? null,
      verifiedAt,
    };
  });
}

export type Place = Zone & {
  active: boolean;
  placeholder: boolean;
  authorityId: string | null;
  legalForms: string[] | null;
  coordinates: { lat: number; lng: number } | null;
  /** E7B: classification, status, first-wave priority and the verifier's extra records. */
  placeKind: PlaceKind;
  status: PlaceStatus;
  priority: number | null;
  activityCodes: string[] | null;
  govChargesMinFils: number | null;
  govChargesMaxFils: number | null;
  conditions: string[] | null;
  exclusions: string[] | null;
};

/** Places with their current values and the evidence behind each, judged on `asOf`. */
export async function loadPlaces(tx: Queryable, asOf?: string, opts: { includeInactive?: boolean } = {}): Promise<Place[]> {
  const day = asOf ?? (await catalogueToday(tx));
  const rows = await tx.query<Record<string, unknown>>(
    `select z.*, z.verified_at::text as verified_at_text, a.name as authority_name,
       coalesce((select array_agg(alias order by alias) from authority_aliases x where x.authority_id = z.authority_id), '{}') as aliases
     from zones z left join authorities a on a.id = z.authority_id
     ${opts.includeInactive ? "" : "where z.active"} order by z.emirate, z.name`,
  );
  const facts = await latestFacts(tx, "place");
  return rows.rows.map((z) => {
    const name = String(z.name);
    const base = z.confidence as Confidence;
    const verifiedAt = z.verified_at_text ? String(z.verified_at_text).slice(0, 10) : null;
    const mine = facts.get(name) ?? new Map<string, FactRow>();
    const evidence: Record<string, FieldEvidence> = {};
    for (const field of PLACE_FIELDS) {
      const f = mine.get(field);
      if (f) evidence[field] = evidenceOf(f, day);
      else if (ALWAYS_PRESENT.includes(field)) evidence[field] = legacyEvidence(field, base, verifiedAt, (z.verified_by as string | null) ?? null, String(z.source_url ?? ""), day);
    }
    // The place is as confident as the weakest evidence the engine relies on.
    const used = ENGINE_FIELDS.map((f) => evidence[f]).filter((e): e is FieldEvidence => !!e);
    const confidence = used.reduce<Confidence>((c, e) => weaker(c, e.confidence), "verified");
    return {
      name,
      emirate: String(z.emirate),
      type: z.type as Zone["type"],
      visaQuota: num(z.visa_quota),
      visaMax: z.visa_max == null ? null : num(z.visa_max),
      facilities: (z.facilities as string[] | null) ?? null,
      costMinFils: num(z.cost_min_fils),
      costMaxFils: num(z.cost_max_fils),
      timelineDays: num(z.timeline_days),
      activities: (z.activities as string[]) ?? [],
      sourceUrl: String(z.source_url ?? ""),
      confidence,
      authority: (z.authority_name as string | null) ?? null,
      aliases: (z.aliases as string[]) ?? [],
      activitiesListed: (z.activities_listed as string[] | null) ?? null,
      ...(z.activities_listed ? { activitiesListedConfidence: evidence.activities_listed?.confidence ?? "UNCERTAIN" } : {}),
      renewalMinFils: z.renewal_min_fils == null ? null : num(z.renewal_min_fils),
      renewalMaxFils: z.renewal_max_fils == null ? null : num(z.renewal_max_fils),
      ...(z.renewal_min_fils != null ? { renewalConfidence: evidence.renewal_cost?.confidence ?? "UNCERTAIN" } : {}),
      evidence,
      stale: used.some((e) => e.stale) || !!evidence.activities_listed?.stale,
      active: !!z.active,
      placeholder: !!z.placeholder,
      authorityId: (z.authority_id as string | null) ?? null,
      legalForms: (z.legal_forms as string[] | null) ?? null,
      coordinates: z.latitude == null ? null : { lat: Number(z.latitude), lng: Number(z.longitude) },
      placeKind: (z.place_kind as PlaceKind) ?? "free_zone",
      status: (z.status as PlaceStatus) ?? (z.active ? "active" : "inactive"),
      priority: z.priority == null ? null : num(z.priority),
      activityCodes: (z.activity_codes as string[] | null) ?? null,
      govChargesMinFils: z.gov_charges_min_fils == null ? null : num(z.gov_charges_min_fils),
      govChargesMaxFils: z.gov_charges_max_fils == null ? null : num(z.gov_charges_max_fils),
      conditions: (z.conditions as string[] | null) ?? null,
      exclusions: (z.exclusions as string[] | null) ?? null,
    };
  });
}

/** What the engine sees, without the console-only fields (so the digest covers exactly what the advice used). */
export const engineZone = (p: Place): Zone => {
  const { active: _a, placeholder: _p, authorityId: _i, legalForms: _l, coordinates: _c, evidence: _e, placeKind: _k, status: _s, priority: _r, activityCodes: _ac, govChargesMinFils: _g1, govChargesMaxFils: _g2, conditions: _co, exclusions: _ex, ...z } = p;
  return z;
};

/**
 * The rules and data an advice is computed from: the day, a digest of the effective rules and places (so a new fact,
 * a verification or evidence going stale all change it), and the latest fact on record.
 */
export async function dataVersionOf(tx: Queryable, asOf: string, rules: ScopingRule[], zones: Zone[]): Promise<DataVersion> {
  const digest = createHash("sha256")
    .update(JSON.stringify({ engine: ELIGIBILITY_ENGINE_VERSION, rules: rules.map((r) => [r.key, r.confidence, r.statement, r.parameters]), zones }))
    .digest("hex")
    .slice(0, 16);
  const last = (await tx.query<{ id: number | null }>("select max(id) as id from catalogue_facts")).rows[0]?.id;
  return { asOf, digest, lastFactId: num(last ?? 0) };
}

/** The engine's inputs as they stand today, with their version. */
export async function engineInputs(tx: Queryable) {
  const asOf = await catalogueToday(tx);
  const rules = await loadRules(tx, asOf);
  const zones = (await loadPlaces(tx, asOf)).map(engineZone);
  return { asOf, rules, zones, dataVersion: await dataVersionOf(tx, asOf, rules, zones) };
}

/** Append one fact (validated) and refresh the current-value cache. No role check: callers decide who may. */
export async function appendFact(tx: Queryable, actor: SessionUser | null, input: FactInput): Promise<{ id: number; change: { kind: FactChange["kind"]; reason: string; supersedes: number | null } }> {
  const { subjectKind: kind, subject, field } = input;
  if (!isoDate(input.evidenceDate)) throw badRequest("The evidence date must be a date (YYYY-MM-DD)");
  const today = await catalogueToday(tx);
  if (input.evidenceDate > today) throw badRequest("The evidence date cannot be in the future");
  const sourceUrl = (input.sourceUrl ?? "").trim();
  if (sourceUrl && !httpUrl(sourceUrl)) throw badRequest("The source must be an http(s) link");
  const verifiedBy = input.verifiedBy?.trim() || null;
  let next = input.nextVerification?.trim() || null;
  if (next && !isoDate(next)) throw badRequest("The re-verification date must be a date (YYYY-MM-DD)");
  if (input.confidence !== "UNCERTAIN" && !next) next = defaultNextVerification(input.evidenceDate);
  if (next && next <= input.evidenceDate) throw badRequest("The re-verification date must be after the evidence date");
  if (next && next > defaultNextVerification(input.evidenceDate, MAX_REVERIFY_DAYS)) throw badRequest("Evidence must be checked again within two years: set an earlier re-verification date");
  if (input.confidence === "verified") {
    if (!verifiedBy || verifiedBy.length < 2) throw badRequest("Name the person who verified this");
    if (!sourceUrl) throw badRequest("A verified fact needs an http(s) source link");
  }
  // E7B: an intermediary's figure is labelled as such and is at most a rule of thumb; only the authority's own
  // publication can be verified. The effective date is a date; the reference is free text.
  const sourceKind: SourceKind = input.sourceKind ?? "official";
  if (sourceKind === "intermediary" && input.confidence === "verified") throw badRequest("A figure from an intermediary cannot be verified: record it as a rule of thumb, or cite the authority's own page");
  const effectiveDate = input.effectiveDate?.trim() || null;
  if (effectiveDate && !isoDate(effectiveDate)) throw badRequest("The effective date must be a date (YYYY-MM-DD)");
  const reference = (input.reference ?? "").trim().slice(0, 300);

  if (kind === "place") {
    if (!(PLACE_FIELDS as readonly string[]).includes(field)) throw badRequest(`Unknown place field ${field}`);
    if (!(await tx.query("select 1 from zones where name = $1 for update", [subject])).rows.length) throw notFound(`No place named ${subject}`);
  } else if (kind === "authority") {
    if (!(AUTHORITY_FIELDS as readonly string[]).includes(field)) throw badRequest(`Unknown authority field ${field}`);
    if (!(await tx.query("select 1 from authorities where id = $1 for update", [subject])).rows.length) throw notFound(`No authority ${subject}`);
    if (field === "parent") {
      const parent = String(input.value);
      if (parent === subject) throw badRequest("An authority cannot be its own parent");
      if (!(await tx.query("select 1 from authorities where id = $1", [parent])).rows.length) throw badRequest(`No authority ${parent}`);
      // No cycles: walk up from the proposed parent.
      const chain = await tx.query<{ id: string }>(
        `with recursive up(id, parent_id) as (select id, parent_id from authorities where id = $1
           union all select a.id, a.parent_id from authorities a join up on a.id = up.parent_id) select id from up`,
        [parent],
      );
      if (chain.rows.some((r) => r.id === subject)) throw badRequest("That parent would make a loop");
    }
  } else if (kind === "rule") {
    if (field !== "rule") throw badRequest("Rule facts record a rule version");
    if (!(await tx.query("select 1 from scoping_rules where key = $1 for update", [subject])).rows.length) throw notFound(`No rule ${subject}`);
  }

  // E23: what this fact is against the current one. A conflict is recorded but changes nothing until the verifier decides.
  const classified = await classifyIncoming(tx, { ...input, sourceUrl, sourceKind, nextVerification: next }, today);
  const current = classified.current;
  const change: FactChange =
    classified.change.kind === "conflict" && input.decided
      ? { kind: "change", reason: `${classified.change.reason}; recorded by the founder's own verification as the figure in force` }
      : classified.change;
  const r = (
    await tx.query<{ id: number }>(
      `insert into catalogue_facts (subject_kind, subject, field, value, source_url, evidence_date, confidence, verified_by, next_verification, note, recorded_by, effective_date, reference, source_kind, supersedes_id, change_kind, change_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [kind, subject, field, JSON.stringify(input.value ?? null), sourceUrl, input.evidenceDate, input.confidence, verifiedBy, next, input.note?.trim() ?? "", actor?.id ?? null, effectiveDate, reference, sourceKind, current?.id ?? null, change.kind, change.reason],
    )
  ).rows[0]!;

  if (change.kind !== "conflict") await refreshCache(tx, kind, subject, field, input.value);
  await audit(tx, actor, "catalogue.fact_recorded", kind === "place" ? "zone" : kind === "authority" ? "authority" : "scoping_rule", subject, {
    factId: num(r.id),
    field,
    confidence: input.confidence,
    evidenceDate: input.evidenceDate,
    nextVerification: next,
    sourceKind,
    change: change.kind,
    reason: change.reason,
    ...(current ? { supersedes: current.id } : {}),
    ...(effectiveDate ? { effectiveDate } : {}),
  });
  return { id: num(r.id), change: { kind: change.kind, reason: change.reason, supersedes: current?.id ?? null } };
}

/** The current fact for one field (E23's rule), or null. */
async function currentFact(tx: Queryable, kind: SubjectKind, subject: string, field: string): Promise<FactRow | null> {
  const r = await tx.query<FactRow>(`select ${FACT_COLUMNS} from catalogue_facts f where subject_kind = $1 and subject = $2 and field = $3 and ${CURRENT_FACT} order by id desc limit 1`, [kind, subject, field]);
  const f = r.rows[0];
  return f ? { ...f, id: num(f.id) } : null;
}

/** Classify an incoming fact against the current one, without recording it (the importer's dry run asks too). */
export async function classifyIncoming(
  tx: Queryable,
  input: Pick<FactInput, "subjectKind" | "subject" | "field" | "value" | "confidence" | "evidenceDate"> & { sourceUrl?: string | null; sourceKind?: SourceKind | null; nextVerification?: string | null },
  asOf?: string,
): Promise<{ current: FactRow | null; change: FactChange }> {
  const today = asOf ?? (await catalogueToday(tx));
  const current = await currentFact(tx, input.subjectKind, input.subject, input.field);
  const change = classifyFactChange(
    current ? { value: current.value, confidence: current.confidence, evidenceDate: current.evidence_date, nextVerification: current.next_verification, sourceUrl: current.source_url, sourceKind: current.source_kind ?? "official" } : null,
    { value: input.value, confidence: input.confidence, evidenceDate: input.evidenceDate, nextVerification: input.nextVerification ?? null, sourceUrl: input.sourceUrl ?? "", sourceKind: input.sourceKind ?? "official" },
    today,
  );
  return { current, change };
}

/** The current-value cache on the place or authority: what the engine reads without walking the facts. */
async function refreshCache(tx: Queryable, kind: SubjectKind, subject: string, field: string, value: unknown): Promise<void> {
  const v = value as any;
  if (kind === "place") {
    const set: Record<string, string> = {
      cost: "cost_min_fils = $2, cost_max_fils = $3",
      renewal_cost: "renewal_min_fils = $2, renewal_max_fils = $3",
      visa_quota: "visa_quota = $2",
      visa_max: "visa_max = $2",
      timeline_days: "timeline_days = $2",
      facilities: "facilities = $2",
      activities_listed: "activities_listed = $2",
      legal_forms: "legal_forms = $2",
      coordinates: "latitude = $2, longitude = $3",
      activity_codes: "activity_codes = $2",
      government_charges: "gov_charges_min_fils = $2, gov_charges_max_fils = $3",
      conditions: "conditions = $2",
      exclusions: "exclusions = $2",
    };
    const params =
      field === "cost" || field === "renewal_cost" || field === "government_charges" ? [v.minFils, v.maxFils] : field === "coordinates" ? [v.lat, v.lng] : [v];
    await tx.query(`update zones set ${set[field]}, updated_at = app_now() where name = $1`, [subject, ...params]);
  } else if (kind === "authority") {
    const col = { parent: "parent_id", registrar: "registrar", website: "website" }[field as "parent" | "registrar" | "website"];
    await tx.query(`update authorities set ${col} = $2 where id = $1`, [subject, v]);
  }
}

/**
 * E23: the verifier's decision on a conflict, once. `accept` makes the new figure current, if nothing newer has
 * superseded the field since; `keep` leaves the current figure. Either way the conflict leaves the queue.
 */
export async function reviewFactConflict(tx: Queryable, actor: SessionUser, factId: number, decision: "accept" | "keep", note: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder decides an evidence conflict");
  if (note.trim().length < 5) throw badRequest("Say why, in a few words: the decision is kept with the fact");
  const f = (await tx.query<FactRow>(`select ${FACT_COLUMNS} from catalogue_facts f where id = $1`, [factId])).rows[0];
  if (!f) throw notFound("No such fact");
  if (f.change_kind !== "conflict") throw conflict("This fact is not a conflict: nothing to decide");
  if ((await tx.query("select 1 from catalogue_fact_reviews where fact_id = $1", [factId])).rows.length) throw conflict("This conflict has already been decided");
  const before = await currentFact(tx, f.subject_kind as SubjectKind, f.subject, f.field);
  if (decision === "accept" && before && num(before.id) > num(f.id)) throw conflict("The field has been recorded again since this figure: it cannot become current. Keep it, or record a new fact.");
  await tx.query("insert into catalogue_fact_reviews (fact_id, decision, note, reviewed_by) values ($1, $2, $3, $4)", [factId, decision, note.trim(), actor.id]);
  if (decision === "accept") {
    const now = await currentFact(tx, f.subject_kind as SubjectKind, f.subject, f.field);
    if (now) await refreshCache(tx, f.subject_kind as SubjectKind, f.subject, f.field, now.value);
  }
  await audit(tx, actor, "catalogue.conflict_reviewed", f.subject_kind === "place" ? "zone" : f.subject_kind === "authority" ? "authority" : "scoping_rule", f.subject, {
    factId: num(f.id),
    field: f.field,
    decision,
    note: note.trim(),
  });
  return { ok: true };
}

/** E23: every version of one field, oldest first, each against the one before, with what it is and whether it is current. */
export async function compareVersions(tx: Queryable, kind: SubjectKind, subject: string, field: string) {
  const asOf = await catalogueToday(tx);
  const r = await tx.query<FactRow & { recorded_by_name: string | null; review_decision: string | null; review_note: string | null; review_by: string | null; review_at: string | null }>(
    `select ${FACT_COLUMNS_F}, u.name as recorded_by_name, rv.decision as review_decision, rv.note as review_note, ru.name as review_by, rv.at::text as review_at
       from catalogue_facts f left join users u on u.id = f.recorded_by
       left join catalogue_fact_reviews rv on rv.fact_id = f.id left join users ru on ru.id = rv.reviewed_by
      where f.subject_kind = $1 and f.subject = $2 and f.field = $3 order by f.id`,
    [kind, subject, field],
  );
  const current = await currentFact(tx, kind, subject, field);
  const byId = new Map(r.rows.map((f) => [num(f.id), f.value]));
  const supersedes = (f: FactRow) => (f.supersedes_id === null || f.supersedes_id === undefined ? null : num(f.supersedes_id));
  const versions = diffVersions(
    r.rows.map((f) => ({ id: num(f.id), value: f.value, supersedesId: supersedes(f) })),
    (v) => (v.supersedesId === null ? null : (byId.get(v.supersedesId) ?? null)),
  ).map((d, i) => {
    const f = r.rows[i]!;
    return {
      ...d,
      evidenceDate: f.evidence_date,
      confidence: f.confidence,
      effective: effectiveConfidence(f.confidence, f.next_verification, asOf),
      sourceUrl: f.source_url,
      sourceKind: f.source_kind ?? "official",
      verifiedBy: f.verified_by,
      recordedBy: f.recorded_by_name,
      recordedAt: f.recorded_at,
      change: { kind: f.change_kind ?? "change", reason: f.change_reason ?? "", supersedes: f.supersedes_id === null || f.supersedes_id === undefined ? null : num(f.supersedes_id) },
      review: f.review_decision ? { decision: f.review_decision, note: f.review_note, by: f.review_by, at: f.review_at } : null,
      current: current?.id === num(f.id),
    };
  });
  return { subjectKind: kind, subject, field, label: FIELD_LABEL[field] ?? field, versions };
}

/** The founder records a fact from the console, typed as text (the importer parses the same way). */
export async function recordFact(tx: Queryable, actor: SessionUser, input: Omit<FactInput, "value"> & { valueText: string }) {
  if (actor.role !== "founder") throw forbidden("Only the founder records catalogue evidence");
  const parsed = parseFactValue(input.subjectKind, input.field, input.valueText);
  if (!parsed.ok) throw badRequest(`${FIELD_LABEL[input.field] ?? input.field}: ${parsed.error}`);
  return appendFact(tx, actor, { ...input, value: parsed.value });
}

/** Every fact recorded for one subject, newest first, each with what it deserves today. */
export async function factHistory(tx: Queryable, kind: SubjectKind, subject: string) {
  const asOf = await catalogueToday(tx);
  const r = await tx.query<FactRow & { recorded_by_name: string | null; review_decision: string | null; review_note: string | null; review_by: string | null; review_at: string | null }>(
    `select f.id, f.subject_kind, f.subject, f.field, f.value, f.source_url, f.evidence_date::text as evidence_date, f.confidence, f.verified_by,
       f.next_verification::text as next_verification, f.note, f.recorded_at, f.effective_date::text as effective_date, f.reference, f.source_kind, u.name as recorded_by_name,
       f.supersedes_id, f.change_kind, f.change_reason, rv.decision as review_decision, rv.note as review_note, ru.name as review_by, rv.at::text as review_at
     from catalogue_facts f left join users u on u.id = f.recorded_by
     left join catalogue_fact_reviews rv on rv.fact_id = f.id left join users ru on ru.id = rv.reviewed_by
     where f.subject_kind = $1 and f.subject = $2 order by f.id desc`,
    [kind, subject],
  );
  // Current per field by E23's rule: the newest fact that is not an unreviewed or kept conflict.
  const current = new Set<number>();
  const seen = new Set<string>();
  for (const f of r.rows) {
    if (seen.has(f.field)) continue;
    if (f.change_kind === "conflict" && f.review_decision !== "accept") continue;
    seen.add(f.field);
    current.add(num(f.id));
  }
  return r.rows.map((f) => ({
    id: num(f.id),
    field: f.field,
    label: FIELD_LABEL[f.field] ?? f.field,
    value: f.value,
    sourceUrl: f.source_url,
    evidenceDate: f.evidence_date,
    confidence: f.confidence,
    effective: effectiveConfidence(f.confidence, f.next_verification, asOf),
    verifiedBy: f.verified_by,
    nextVerification: f.next_verification,
    note: f.note,
    recordedBy: f.recorded_by_name,
    recordedAt: f.recorded_at,
    current: current.has(num(f.id)),
    effectiveDate: f.effective_date ?? null,
    reference: f.reference ?? "",
    sourceKind: f.source_kind ?? "official",
    change: { kind: f.change_kind ?? "change", reason: f.change_reason ?? "", supersedes: f.supersedes_id === null || f.supersedes_id === undefined ? null : num(f.supersedes_id) },
    review: f.review_decision ? { decision: f.review_decision, note: f.review_note, by: f.review_by, at: f.review_at } : null,
  }));
}

/** Authorities and places, with each place's evidence and what is stale or due within 30 days. */
export async function catalogueOverview(tx: Queryable) {
  const asOf = await catalogueToday(tx);
  const soon = defaultNextVerification(asOf, 30);
  const authorities = await tx.query<Record<string, unknown>>(
    `select a.*, coalesce((select array_agg(alias order by alias) from authority_aliases x where x.authority_id = a.id), '{}') as aliases
     from authorities a order by a.kind, a.emirate nulls first, a.name`,
  );
  const places = await loadPlaces(tx, asOf, { includeInactive: true });
  const rules = await loadRules(tx, asOf);
  const due = (e: FieldEvidence) => !e.stale && !!e.nextVerification && e.nextVerification <= soon;
  return {
    asOf,
    authorities: authorities.rows.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      emirate: a.emirate,
      parentId: a.parent_id,
      registrar: a.registrar,
      website: a.website,
      active: a.active,
      aliases: a.aliases,
    })),
    places: places.map((p) => ({
      name: p.name,
      emirate: p.emirate,
      type: p.type,
      authority: p.authority,
      authorityId: p.authorityId,
      active: p.active,
      placeholder: p.placeholder,
      confidence: p.confidence,
      stale: p.stale,
      evidence: Object.values(p.evidence ?? {}),
      due: Object.values(p.evidence ?? {}).filter(due).map((e) => e.field),
      activitiesListed: p.activitiesListed,
      legalForms: p.legalForms,
      coordinates: p.coordinates,
      renewalMinFils: p.renewalMinFils,
      renewalMaxFils: p.renewalMaxFils,
      placeKind: p.placeKind,
      status: p.status,
      priority: p.priority,
      activityCodes: p.activityCodes,
      govChargesMinFils: p.govChargesMinFils,
      govChargesMaxFils: p.govChargesMaxFils,
      conditions: p.conditions,
      exclusions: p.exclusions,
    })),
    rules: { stale: rules.filter((r) => r.stale).map((r) => r.key), due: rules.filter((r) => !r.stale && r.nextVerification && r.nextVerification <= soon).map((r) => r.key) },
    fields: { place: PLACE_FIELDS.map((f) => ({ field: f, label: FIELD_LABEL[f] })), authority: AUTHORITY_FIELDS.map((f) => ({ field: f, label: FIELD_LABEL[f] })) },
  };
}

/** Resolve a name a person typed (a place's name, its authority's name, or an alias) to a place. */
export async function placeByName(tx: Queryable, name: string, places?: Place[]): Promise<string | null> {
  const n = normaliseName(name);
  const all = places ?? (await loadPlaces(tx, undefined, { includeInactive: true }));
  const exact = all.filter((p) => normaliseName(p.name) === n);
  if (exact.length === 1) return exact[0]!.name;
  const hit = all.filter((p) => [p.authority ?? "", ...(p.aliases ?? [])].some((x) => x && normaliseName(x) === n));
  return hit.length === 1 ? hit[0]!.name : null;
}

/**
 * E7B: the founder classifies a place (what it is), sets its status (offered, waiting for figures, kept for the
 * record) and its first-wave priority. `active` follows the status so the engine's switch stays one thing. A place
 * with placeholder figures cannot be made active here: its figures are recorded first (as in verifyZone).
 */
export async function setPlaceStatus(tx: Queryable, actor: SessionUser, name: string, input: { placeKind?: PlaceKind; status?: PlaceStatus; priority?: number | null }) {
  if (actor.role !== "founder") throw forbidden("Only the founder classifies places");
  const before = (await tx.query<Record<string, unknown>>("select name, place_kind, status, priority, placeholder, active from zones where name = $1 for update", [name])).rows[0];
  if (!before) throw notFound(`No place named ${name}`);
  if (input.placeKind && !(PLACE_KINDS as readonly string[]).includes(input.placeKind)) throw badRequest("Unknown place kind");
  if (input.status && !(PLACE_STATUSES as readonly string[]).includes(input.status)) throw badRequest("Unknown status");
  if (input.priority != null && !(Number.isInteger(input.priority) && input.priority >= 1 && input.priority <= 9)) throw badRequest("Priority is 1 (first) to 9, or none");
  const status = input.status ?? (before.status as PlaceStatus);
  if (status === "active" && before.placeholder) {
    const recorded = new Set((await tx.query<{ field: string }>("select distinct field from catalogue_facts where subject_kind = 'place' and subject = $1", [name])).rows.map((x) => x.field));
    const missing = ["cost", "visa_quota", "timeline_days"].filter((f) => !recorded.has(f));
    if (missing.length) throw badRequest(`This place has no ${missing.join(", ").replace(/_/g, " ")} on record yet: record them before offering it`);
  }
  await tx.query("update zones set place_kind = coalesce($2, place_kind), status = $3, active = $4, priority = $5, updated_at = app_now() where name = $1", [
    name,
    input.placeKind ?? null,
    status,
    status === "active",
    input.priority === undefined ? (before.priority == null ? null : num(before.priority)) : input.priority,
  ]);
  await audit(tx, actor, "catalogue.place_classified", "zone", name, { before: { placeKind: before.place_kind, status: before.status, priority: before.priority }, after: input });
  return { ok: true };
}

/** E7B: the coverage matrix and the evidence backlog, from the catalogue as it stands today. */
export async function coverageReport(tx: Queryable, approvals: CoverageApproval[]) {
  const asOf = await catalogueToday(tx);
  const authorities = (await tx.query<Record<string, unknown>>("select id, name, kind, emirate, parent_id, active from authorities order by name")).rows;
  const places = await loadPlaces(tx, asOf, { includeInactive: true });
  const rows: CoveragePlace[] = places.map((p) => ({
    name: p.name,
    emirate: p.emirate,
    placeKind: p.placeKind,
    status: p.status,
    priority: p.priority,
    authorityId: p.authorityId,
    authority: p.authority ?? null,
    evidence: p.evidence ?? {},
    // A placeholder place counts a figure as on record once a fact records it (the placeholder flag is never cleared);
    // "no limit" for the most visas is a recorded value too, so the evidence decides, not the cached number.
    has: {
      cost: !!p.evidence?.cost?.factId || (!p.placeholder && p.costMinFils > 0),
      renewal_cost: p.renewalMinFils != null,
      visa_quota: !p.placeholder || !!p.evidence?.visa_quota?.factId,
      visa_max: !!p.evidence?.visa_max,
      timeline_days: !p.placeholder || !!p.evidence?.timeline_days?.factId,
      facilities: !!p.facilities,
      activities_listed: !!p.activitiesListed,
      activity_codes: !!p.activityCodes,
      legal_forms: !!p.legalForms,
      government_charges: p.govChargesMinFils != null,
      conditions: !!p.conditions,
      exclusions: !!p.exclusions,
      coordinates: !!p.coordinates,
    },
    confidence: p.confidence,
    stale: !!p.stale,
  }));
  const matrix = coverageMatrix(
    asOf,
    authorities.map((a) => ({ id: String(a.id), name: String(a.name), kind: a.kind as never, emirate: (a.emirate as string | null) ?? null, parentId: (a.parent_id as string | null) ?? null, active: !!a.active })),
    rows,
    approvals,
  );
  // E23: conflicts waiting for the founder, beside the backlog.
  const openConflicts = num((await tx.query<{ n: number }>(
    `select count(*)::int as n from catalogue_facts f where f.change_kind = 'conflict'
       and not exists (select 1 from catalogue_fact_reviews r where r.fact_id = f.id)
       and not exists (select 1 from catalogue_facts n where n.subject_kind = f.subject_kind and n.subject = f.subject and n.field = f.field and n.id > f.id
                       and (n.change_kind = 'change' or exists (select 1 from catalogue_fact_reviews r2 where r2.fact_id = n.id and r2.decision = 'accept')))`,
  )).rows[0]!.n);
  return { ...matrix, conflicts: { open: openConflicts } };
}

export { backlogCsv };


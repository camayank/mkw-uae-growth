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
  type Confidence,
  type DataVersion,
  type FieldEvidence,
  type ScopingRule,
  type SubjectKind,
  type Zone,
} from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, forbidden, notFound } from "../lib/errors.ts";
import { dbToday } from "./repo.ts";

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
}

const FACT_COLUMNS = `id, subject_kind, subject, field, value, source_url, evidence_date::text as evidence_date, confidence, verified_by,
  next_verification::text as next_verification, note, recorded_at`;

/** The latest fact per subject and field, for one kind of subject. */
async function latestFacts(tx: Queryable, kind: SubjectKind): Promise<Map<string, Map<string, FactRow>>> {
  const r = await tx.query<FactRow>(
    `select distinct on (subject, field) ${FACT_COLUMNS} from catalogue_facts where subject_kind = $1 order by subject, field, id desc`,
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
  const day = asOf ?? (await dbToday(tx));
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

export type Place = Zone & { active: boolean; authorityId: string | null; legalForms: string[] | null; coordinates: { lat: number; lng: number } | null };

/** Places with their current values and the evidence behind each, judged on `asOf`. */
export async function loadPlaces(tx: Queryable, asOf?: string, opts: { includeInactive?: boolean } = {}): Promise<Place[]> {
  const day = asOf ?? (await dbToday(tx));
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
      renewalMinFils: z.renewal_min_fils == null ? null : num(z.renewal_min_fils),
      renewalMaxFils: z.renewal_max_fils == null ? null : num(z.renewal_max_fils),
      evidence,
      stale: used.some((e) => e.stale),
      active: !!z.active,
      authorityId: (z.authority_id as string | null) ?? null,
      legalForms: (z.legal_forms as string[] | null) ?? null,
      coordinates: z.latitude == null ? null : { lat: Number(z.latitude), lng: Number(z.longitude) },
    };
  });
}

/** What the engine sees, without the console-only fields (so the digest covers exactly what the advice used). */
export const engineZone = (p: Place): Zone => {
  const { active: _a, authorityId: _i, legalForms: _l, coordinates: _c, evidence: _e, ...z } = p;
  return z;
};

/**
 * The rules and data an advice is computed from: the day, a digest of the effective rules and places (so a new fact,
 * a verification or evidence going stale all change it), and the latest fact on record.
 */
export async function dataVersionOf(tx: Queryable, asOf: string, rules: ScopingRule[], zones: Zone[]): Promise<DataVersion> {
  const digest = createHash("sha256")
    .update(JSON.stringify({ rules: rules.map((r) => [r.key, r.confidence, r.statement]), zones }))
    .digest("hex")
    .slice(0, 16);
  const last = (await tx.query<{ id: number | null }>("select max(id) as id from catalogue_facts")).rows[0]?.id;
  return { asOf, digest, lastFactId: num(last ?? 0) };
}

/** The engine's inputs as they stand today, with their version. */
export async function engineInputs(tx: Queryable) {
  const asOf = await dbToday(tx);
  const rules = await loadRules(tx, asOf);
  const zones = (await loadPlaces(tx, asOf)).map(engineZone);
  return { asOf, rules, zones, dataVersion: await dataVersionOf(tx, asOf, rules, zones) };
}

/** Append one fact (validated) and refresh the current-value cache. No role check: callers decide who may. */
export async function appendFact(tx: Queryable, actor: SessionUser | null, input: FactInput): Promise<{ id: number }> {
  const { subjectKind: kind, subject, field } = input;
  if (!isoDate(input.evidenceDate)) throw badRequest("The evidence date must be a date (YYYY-MM-DD)");
  const sourceUrl = (input.sourceUrl ?? "").trim();
  if (sourceUrl && !httpUrl(sourceUrl)) throw badRequest("The source must be an http(s) link");
  const verifiedBy = input.verifiedBy?.trim() || null;
  let next = input.nextVerification?.trim() || null;
  if (next && !isoDate(next)) throw badRequest("The re-verification date must be a date (YYYY-MM-DD)");
  if (input.confidence !== "UNCERTAIN" && !next) next = defaultNextVerification(input.evidenceDate);
  if (next && next <= input.evidenceDate) throw badRequest("The re-verification date must be after the evidence date");
  if (input.confidence === "verified") {
    if (!verifiedBy || verifiedBy.length < 2) throw badRequest("Name the person who verified this");
    if (!sourceUrl) throw badRequest("A verified fact needs an http(s) source link");
  }

  if (kind === "place") {
    if (!(PLACE_FIELDS as readonly string[]).includes(field)) throw badRequest(`Unknown place field ${field}`);
    if (!(await tx.query("select 1 from zones where name = $1", [subject])).rows.length) throw notFound(`No place named ${subject}`);
  } else if (kind === "authority") {
    if (!(AUTHORITY_FIELDS as readonly string[]).includes(field)) throw badRequest(`Unknown authority field ${field}`);
    if (!(await tx.query("select 1 from authorities where id = $1", [subject])).rows.length) throw notFound(`No authority ${subject}`);
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
  }

  const r = (
    await tx.query<{ id: number }>(
      `insert into catalogue_facts (subject_kind, subject, field, value, source_url, evidence_date, confidence, verified_by, next_verification, note, recorded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [kind, subject, field, JSON.stringify(input.value ?? null), sourceUrl, input.evidenceDate, input.confidence, verifiedBy, next, input.note?.trim() ?? "", actor?.id ?? null],
    )
  ).rows[0]!;

  // The current-value cache.
  const v = input.value as any;
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
    };
    const params =
      field === "cost" || field === "renewal_cost" ? [v.minFils, v.maxFils] : field === "coordinates" ? [v.lat, v.lng] : [v];
    await tx.query(`update zones set ${set[field]}, updated_at = app_now() where name = $1`, [subject, ...params]);
  } else if (kind === "authority") {
    const col = { parent: "parent_id", registrar: "registrar", website: "website" }[field as "parent" | "registrar" | "website"];
    await tx.query(`update authorities set ${col} = $2 where id = $1`, [subject, v]);
  }
  await audit(tx, actor, "catalogue.fact_recorded", kind === "place" ? "zone" : kind === "authority" ? "authority" : "scoping_rule", subject, {
    factId: num(r.id),
    field,
    confidence: input.confidence,
    evidenceDate: input.evidenceDate,
    nextVerification: next,
  });
  return { id: num(r.id) };
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
  const asOf = await dbToday(tx);
  const r = await tx.query<FactRow & { recorded_by_name: string | null }>(
    `select f.id, f.subject_kind, f.subject, f.field, f.value, f.source_url, f.evidence_date::text as evidence_date, f.confidence, f.verified_by,
       f.next_verification::text as next_verification, f.note, f.recorded_at, u.name as recorded_by_name
     from catalogue_facts f left join users u on u.id = f.recorded_by where f.subject_kind = $1 and f.subject = $2 order by f.id desc`,
    [kind, subject],
  );
  const current = new Set<number>();
  const seen = new Set<string>();
  for (const f of r.rows) if (!seen.has(f.field)) (seen.add(f.field), current.add(num(f.id)));
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
  }));
}

/** Authorities and places, with each place's evidence and what is stale or due within 30 days. */
export async function catalogueOverview(tx: Queryable) {
  const asOf = await dbToday(tx);
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
      confidence: p.confidence,
      stale: p.stale,
      evidence: Object.values(p.evidence ?? {}),
      due: Object.values(p.evidence ?? {}).filter(due).map((e) => e.field),
      activitiesListed: p.activitiesListed,
      legalForms: p.legalForms,
      coordinates: p.coordinates,
      renewalMinFils: p.renewalMinFils,
      renewalMaxFils: p.renewalMaxFils,
    })),
    rules: { stale: rules.filter((r) => r.stale).map((r) => r.key), due: rules.filter((r) => !r.stale && r.nextVerification && r.nextVerification <= soon).map((r) => r.key) },
    fields: { place: PLACE_FIELDS.map((f) => ({ field: f, label: FIELD_LABEL[f] })), authority: AUTHORITY_FIELDS.map((f) => ({ field: f, label: FIELD_LABEL[f] })) },
  };
}

/** Resolve a name a person typed (a place's name, its authority's name, or an alias) to a place. */
export async function placeByName(tx: Queryable, name: string): Promise<string | null> {
  const n = normaliseName(name);
  const places = await loadPlaces(tx, undefined, { includeInactive: true });
  const hit = places.filter((p) => [p.name, p.authority ?? "", ...(p.aliases ?? [])].some((x) => x && normaliseName(x) === n));
  return hit.length === 1 ? hit[0]!.name : null;
}

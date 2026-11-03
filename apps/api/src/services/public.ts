import { createHash } from "node:crypto";
import { advise, ENGINE_FIELDS, ENGINE_TEXTS_VERSION, engineTextsByRule, GUIDES, publicView, selectGuides, type AdviceInput, type Guide, type PublicAssessment, type ScopingRule } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { engineInputs, engineZone, loadPlaces, loadRules, type Place } from "./catalogue.ts";

/**
 * Public display (E3, D80): what the public selector may show. A named person approves a rule (by its version) or a
 * place (by the digest of its current figures and evidence) once; a new version never inherits the approval. The
 * public assessment itself writes nothing: it is the same engine, filtered to what is approved.
 */

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/**
 * The version of a place the public would see: everything the page shows for it (figures, renewal, facilities,
 * activity list, authority, what it is known for) with the confidence of each and the facts behind them.
 */
export const placeVersion = (p: Place): string =>
  digest({
    cost: [p.costMinFils, p.costMaxFils],
    renewal: [p.renewalMinFils ?? null, p.renewalMaxFils ?? null, p.renewalConfidence ?? null],
    visas: [p.visaQuota, p.visaMax ?? null],
    days: p.timelineDays,
    facilities: p.facilities ?? null,
    listed: [p.activitiesListed ?? null, p.activitiesListedConfidence ?? null],
    activities: p.activities,
    authority: p.authority ?? null,
    source: p.sourceUrl ?? "",
    confidence: p.confidence,
    stale: !!p.stale,
    evidence: [...ENGINE_FIELDS, "renewal_cost", "activities_listed"].map((f) => p.evidence?.[f]?.factId ?? null),
  });

/**
 * The texts the engine emits under each rule key, memoised per engine version: what the founder approves is this
 * wording, not the rule's summary, and a reworded engine lapses the approval.
 */
let textsCache: { version: string; keys: string; texts: Map<string, string[]> } | null = null;
export function engineTexts(rules: ScopingRule[]): Map<string, string[]> {
  const keys = rules.map((r) => r.key).join(",");
  if (!textsCache || textsCache.version !== ENGINE_TEXTS_VERSION || textsCache.keys !== keys) textsCache = { version: ENGINE_TEXTS_VERSION, keys, texts: engineTextsByRule(rules) };
  return textsCache.texts;
}

/** A rule's public-display version: its verification version, the confidence it deserves today, and its wording. */
export const ruleVersion = (r: { version: number; confidence: string }, texts: string[]): string => `${r.version}:${r.confidence}:${digest([ENGINE_TEXTS_VERSION, texts])}`;

/** E7A: a guidance note's public-display version is its wording; an edited note lapses the approval. */
export const guideVersion = (g: Guide): string => digest([g.title, g.text]);

interface ApprovalRow {
  id: number;
  subject_kind: "rule" | "place" | "guide";
  subject: string;
  version: string;
  note: string;
  approved_by_name: string | null;
  approved_at: string;
  revoked_at: string | null;
}

/** The latest approval per subject, revoked or not. */
async function latestApprovals(tx: Queryable): Promise<Map<string, ApprovalRow>> {
  const r = await tx.query<ApprovalRow>(
    `select distinct on (a.subject_kind, a.subject) a.id, a.subject_kind, a.subject, a.version, a.note, u.name as approved_by_name, a.approved_at, a.revoked_at
     from public_approvals a left join users u on u.id = a.approved_by order by a.subject_kind, a.subject, a.id desc`,
  );
  return new Map(r.rows.map((x) => [`${x.subject_kind}:${x.subject}`, { ...x, id: num(x.id) }]));
}

export interface DisplayState {
  approved: boolean;
  /** An approval exists but for an earlier version: it lapsed. */
  lapsed: boolean;
  version: string;
  approvedVersion: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  note: string;
}

const stateOf = (row: ApprovalRow | undefined, version: string): DisplayState => {
  const live = !!row && !row.revoked_at;
  return {
    approved: live && row!.version === version,
    lapsed: live && row!.version !== version,
    version,
    approvedVersion: live ? row!.version : null,
    approvedBy: live ? row!.approved_by_name : null,
    approvedAt: live ? row!.approved_at : null,
    note: live ? row!.note : "",
  };
};

/** Every rule's and active place's current version with its public-display state, and the engine's wording per rule. */
export async function displayOverview(tx: Queryable, loaded?: { rules: Awaited<ReturnType<typeof loadRules>>; places: Place[] }) {
  const approvals = await latestApprovals(tx);
  const rules = loaded?.rules ?? (await loadRules(tx));
  const places = loaded?.places ?? (await loadPlaces(tx));
  const texts = engineTexts(rules);
  return {
    rules: rules.map((r) => {
      const t = texts.get(r.key) ?? [];
      return { key: r.key, kind: r.kind, statement: r.statement, confidence: r.confidence, stale: r.stale, version: r.version, texts: t, display: stateOf(approvals.get(`rule:${r.key}`), ruleVersion(r, t)) };
    }),
    places: places.map((p) => ({ name: p.name, emirate: p.emirate, type: p.type, confidence: p.confidence, stale: !!p.stale, display: stateOf(approvals.get(`place:${p.name}`), placeVersion(p)) })),
    // E7A: the general guidance notes, each a draft until the founder approves its wording.
    guides: GUIDES.map((g) => ({ id: g.id, title: g.title, text: g.text, about: g.about, display: stateOf(approvals.get(`guide:${g.id}`), guideVersion(g)) })),
  };
}

/** The sets the public view is filtered with, as things stand now. */
export async function approvedNow(tx: Queryable, loaded?: { rules: Awaited<ReturnType<typeof loadRules>>; places: Place[] }): Promise<{ rules: Set<string>; places: Set<string>; guides: Set<string> }> {
  const o = await displayOverview(tx, loaded);
  return { rules: new Set(o.rules.filter((r) => r.display.approved).map((r) => r.key)), places: new Set(o.places.filter((p) => p.display.approved).map((p) => p.name)), guides: new Set(o.guides.filter((g) => g.display.approved).map((g) => g.id)) };
}

export type DisplayKind = "rule" | "place" | "guide";
const ENTITY: Record<DisplayKind, string> = { rule: "scoping_rule", place: "zone", guide: "guide" };

export async function approveForDisplay(tx: Queryable, actor: SessionUser, kind: DisplayKind, subject: string, note: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder approves what the public selector shows");
  const o = await displayOverview(tx);
  const item = kind === "rule" ? o.rules.find((r) => r.key === subject) : kind === "place" ? o.places.find((p) => p.name === subject) : o.guides.find((g) => g.id === subject);
  if (!item) throw notFound(`No ${kind} ${subject}`);
  if (item.display.approved) throw conflict("This version is already approved for public display");
  // What the public may see must be what a person has checked: an UNCERTAIN rule or place cannot be approved. A
  // guidance note is general information with no rule behind it: the founder's approval is the check (D85).
  if ("confidence" in item && item.confidence === "UNCERTAIN") throw badRequest(`${kind === "rule" ? "The rule" : "The place"} is UNCERTAIN: verify it (or mark it a rule of thumb) with a source before approving it for public display`);
  if ((item as { stale?: boolean }).stale) throw badRequest(`${kind === "rule" ? "The rule's verification" : "The place's evidence"} is past its re-verification date: check it again before approving it for public display`);
  // An approval of a newer version supersedes the earlier one, so exactly one approval is ever live per subject.
  await tx.query("update public_approvals set revoked_by = $3, revoked_at = app_now(), revoke_note = 'superseded by a newer version' where subject_kind = $1 and subject = $2 and revoked_at is null", [kind, subject, actor.id]);
  const r = (
    await tx.query<{ id: number }>("insert into public_approvals (subject_kind, subject, version, note, approved_by) values ($1,$2,$3,$4,$5) returning id", [kind, subject, item.display.version, note.trim(), actor.id])
  ).rows[0]!;
  await audit(tx, actor, "public_display.approved", ENTITY[kind], subject, { approvalId: num(r.id), version: item.display.version, note: note.trim() });
  return { ok: true, version: item.display.version };
}

export async function revokeDisplay(tx: Queryable, actor: SessionUser, kind: DisplayKind, subject: string, note: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder revokes public display");
  const live = (await tx.query<{ id: number }>("select id from public_approvals where subject_kind = $1 and subject = $2 and revoked_at is null order by id desc limit 1", [kind, subject])).rows[0];
  if (!live) throw conflict("Nothing is approved for public display here");
  await tx.query("update public_approvals set revoked_by = $2, revoked_at = app_now(), revoke_note = $3 where id = $1", [live.id, actor.id, note.trim()]);
  await audit(tx, actor, "public_display.revoked", ENTITY[kind], subject, { approvalId: num(live.id), note: note.trim() });
  return { ok: true };
}

/**
 * A public assessment: the engine on the founder's answers, filtered to what is approved. Nothing is written: no
 * request, no lead, no audit row. The answers are not kept.
 */
export async function publicAssess(tx: Queryable, answers: AdviceInput): Promise<PublicAssessment> {
  const asOf = (await tx.query<{ d: string }>("select gulf(app_now())::text as d")).rows[0]!.d.slice(0, 10);
  const rules = await loadRules(tx, asOf);
  const places = await loadPlaces(tx, asOf);
  const { dataVersion } = await engineInputs(tx);
  const advice = { ...advise({ ...answers, mode: "new_company" }, rules, places.map(engineZone), asOf), dataVersion };
  const ok = await approvedNow(tx, { rules, places });
  const view = publicView(advice, ok.rules, ok.places, asOf);
  // E7A: general guidance chosen from the answers and what the public may see of the engine's conclusions; only
  // notes the founder approved are included, and they carry no figure (a core test enforces the wording).
  const guidance = selectGuides({
    activity: answers.activity, customers: answers.customers, visas: answers.visas, premises: answers.premises, ownerType: answers.ownerType, foreignTaxResident: answers.foreignTaxResident,
    recommendation: view.structure.recommendation, structuresOpen: view.structures.filter((s) => s.status !== "INELIGIBLE").map((s) => s.structure),
  }).filter((g) => ok.guides.has(g.id)).map((g) => ({ id: g.id, title: g.title, text: g.text, about: g.about }));
  return { ...view, guidance };
}

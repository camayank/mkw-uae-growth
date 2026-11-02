import { advise, assessStructure, needsVerificationOf, rankPlaces, Rulebook, statusOf, type Advice, type AdviceInput, type EligibilityStatus, type Finding, type ScopingRule, type Structure, type Zone } from "@tasees/core";
import { appendFact, catalogueToday, engineInputs, engineZone, loadPlaces, loadRules } from "./catalogue.ts";
import { assessmentContext } from "./handoff.ts";
import { rescopeForStructure } from "./structure.ts";
import { withdrawOffers } from "../lib/transition.ts";
import { audit, lockAuditChain, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";

/**
 * Scoping intelligence (O5): rules and zones carry a confidence and a sign-off; advice is recomputed from them
 * and approved by ops before a client sees it; the founder verifies rules and zone data by name and date.
 */

/** The rules as they stand on `asOf` (default: today by the application clock), stale ones downgraded (E2). */
export async function loadScopingRules(tx: Queryable, asOf?: string): Promise<ScopingRule[]> {
  return loadRules(tx, asOf);
}

/** The active places the engine ranks, with their evidence judged on `asOf` (E2). */
export async function loadZones(tx: Queryable, asOf?: string): Promise<Zone[]> {
  return (await loadPlaces(tx, asOf)).map(engineZone);
}

export async function scopingOverview(tx: Queryable) {
  const zones = (await loadPlaces(tx, undefined, { includeInactive: true })).sort((x, y) => x.type.localeCompare(y.type) || x.emirate.localeCompare(y.emirate) || x.name.localeCompare(y.name));
  const pending = await tx.query<{ n: number }>("select count(*)::int as n from requests where advice_status = 'pending_review'");
  return {
    // E2: each rule with the confidence it deserves today, its version and when it must be checked again.
    rules: (await loadRules(tx)).map((x) => ({ key: x.key, kind: x.kind, statement: x.statement, parameters: x.parameters, sourceUrl: x.sourceUrl, confidence: x.confidence, recorded: x.recorded, stale: x.stale, version: x.version, nextVerification: x.nextVerification, verifiedBy: x.verifiedBy, verifiedAt: x.verifiedAt })),
    // E2: the confidence a place deserves today (its weakest evidence, downgraded when stale), not the raw column.
    zones: zones.map((z) => ({ name: z.name, emirate: z.emirate, type: z.type, visaQuota: z.visaQuota, costMin: z.costMinFils, costMax: z.costMaxFils, timelineDays: z.timelineDays, activities: z.activities, sourceUrl: z.sourceUrl, confidence: z.confidence, stale: !!z.stale, placeholder: z.placeholder, verifiedBy: z.evidence?.cost?.verifiedBy ?? null, verifiedAt: z.evidence?.cost?.evidenceDate ?? null, active: z.active })),
    pendingReviews: num(pending.rows[0]?.n),
  };
}

const httpUrl = (u: string) => /^https?:\/\/\S+$/i.test(u.trim());

/** The founder records a named person's verification of a rule (or marks it a rule of thumb), with its source. */
export async function verifyRule(tx: Queryable, actor: SessionUser, key: string, input: { confidence: "verified" | "rule_of_thumb" | "UNCERTAIN"; verifiedBy?: string; sourceUrl?: string; statement?: string; nextVerification?: string }) {
  if (actor.role !== "founder") throw forbidden("Only the founder verifies scoping rules");
  const before = (await tx.query<Record<string, unknown>>("select * from scoping_rules where key = $1", [key])).rows[0];
  if (!before) throw notFound("Rule not found");
  const sourceUrl = (input.sourceUrl ?? String(before.source_url ?? "")).trim();
  if (sourceUrl && !httpUrl(sourceUrl)) throw badRequest("The source must be an http(s) link");
  if (input.confidence === "verified") {
    if (!input.verifiedBy || input.verifiedBy.trim().length < 2) throw badRequest("Name the person who verified the rule");
    if (!sourceUrl) throw badRequest("A verified rule needs an http(s) source link");
  }
  // E2: every verification is a new rule version, recorded as an append-only fact with its re-verification date.
  const today = await catalogueToday(tx);
  const statement = input.statement?.trim() || String(before.statement);
  const fact = await appendFact(tx, actor, {
    subjectKind: "rule",
    subject: key,
    field: "rule",
    value: { statement, confidence: input.confidence, version: num(before.version) + 1 },
    sourceUrl,
    evidenceDate: today,
    confidence: input.confidence,
    verifiedBy: input.confidence === "verified" ? input.verifiedBy!.trim() : null,
    nextVerification: input.nextVerification ?? null,
  });
  const next = (await tx.query<{ d: string | null }>("select next_verification::text as d from catalogue_facts where id = $1", [fact.id])).rows[0]?.d ?? null;
  await tx.query(
    `update scoping_rules set confidence = $2, verified_by = $3, verified_at = case when $2 = 'verified' then app_now()::date else null end,
       source_url = $4, statement = $5, version = version + 1, next_verification = $6, updated_at = app_now() where key = $1`,
    [key, input.confidence, input.confidence === "verified" ? input.verifiedBy!.trim() : null, sourceUrl, statement, next],
  );
  await audit(tx, actor, "scoping.rule_verified", "scoping_rule", key, {
    before: { confidence: before.confidence, verifiedBy: before.verified_by, statement: before.statement, sourceUrl: before.source_url },
    after: { confidence: input.confidence, verifiedBy: input.verifiedBy ?? null, statement: input.statement ?? before.statement, sourceUrl },
  });
  return { ok: true };
}

/**
 * The founder records a place's figures with one confidence (E2: as facts, one per figure). Marking a place verified
 * without new figures verifies the figures on record. Activating or deactivating a place is a decision, audited.
 */
export async function verifyZone(
  tx: Queryable,
  actor: SessionUser,
  name: string,
  input: { confidence: "verified" | "rule_of_thumb" | "UNCERTAIN"; verifiedBy?: string; sourceUrl?: string; costMinFils?: number; costMaxFils?: number; visaQuota?: number; timelineDays?: number; active?: boolean; nextVerification?: string },
) {
  if (actor.role !== "founder") throw forbidden("Only the founder verifies zone data");
  const before = (await tx.query<Record<string, unknown>>("select * from zones where name = $1", [name])).rows[0];
  if (!before) throw notFound("Zone not found");
  const sourceUrl = (input.sourceUrl ?? String(before.source_url ?? "")).trim();
  if (input.confidence === "verified" && (!input.verifiedBy || !httpUrl(sourceUrl))) throw badRequest("A verified zone needs the verifier's name and an http(s) source link");
  const costMin = input.costMinFils ?? num(before.cost_min_fils);
  const costMax = input.costMaxFils ?? num(before.cost_max_fils);
  if (costMin > costMax) throw badRequest("Minimum cost is above the maximum");
  const today = await catalogueToday(tx);
  const common = { subjectKind: "place" as const, subject: name, sourceUrl, evidenceDate: today, confidence: input.confidence, verifiedBy: input.verifiedBy ?? null, nextVerification: input.nextVerification ?? null };
  // A place added without figures (Umm Al Quwain, Fujairah) holds placeholders, not data. Each figure counts only
  // once it is given here or recorded as a fact; a placeholder is never verified, and the place is not offered until
  // its cost, visas and timeline are all on record.
  const recorded = new Set((await tx.query<{ field: string }>("select distinct field from catalogue_facts where subject_kind = 'place' and subject = $1", [name])).rows.map((x) => x.field));
  const given: Record<string, boolean> = { cost: input.costMinFils !== undefined && input.costMaxFils !== undefined, visa_quota: input.visaQuota !== undefined, timeline_days: input.timelineDays !== undefined };
  const have = (f: string) => given[f] || recorded.has(f) || !before.placeholder;
  const missing = ["cost", "visa_quota", "timeline_days"].filter((f) => !have(f));
  if (missing.length && (input.confidence !== "UNCERTAIN" || input.active === true)) {
    throw badRequest(`This place has no ${missing.join(", ").replace(/_/g, " ")} on record yet: give them before verifying or offering it`);
  }
  if (have("cost") && costMin > 0 && costMax > 0) await appendFact(tx, actor, { ...common, field: "cost", value: { minFils: costMin, maxFils: costMax } });
  if (have("visa_quota")) await appendFact(tx, actor, { ...common, field: "visa_quota", value: input.visaQuota ?? num(before.visa_quota) });
  if (have("timeline_days")) await appendFact(tx, actor, { ...common, field: "timeline_days", value: input.timelineDays ?? num(before.timeline_days) });
  await tx.query(
    `update zones set confidence = $2, verified_by = $3, verified_at = case when $2 = 'verified' then app_now()::date else null end, source_url = $4,
       active = coalesce($5, active), updated_at = app_now() where name = $1`,
    [name, input.confidence, input.confidence === "verified" ? input.verifiedBy!.trim() : null, sourceUrl, input.active ?? null],
  );
  await audit(tx, actor, "scoping.zone_verified", "zone", name, { before: { confidence: before.confidence, costMin: num(before.cost_min_fils), costMax: num(before.cost_max_fils), visaQuota: num(before.visa_quota), active: before.active }, after: input });
  return { ok: true };
}

/** Ops reads a request's advice (always), recomputes it from current rules, edits the structure, and approves it. */
export async function requestScoping(tx: Queryable, requestId: string) {
  const r = (
    await tx.query<Record<string, unknown>>(
      `select r.id, r.answers, r.scope, r.notes, r.status, r.advice, r.advice_status, r.advice_reviewed_at, r.source, r.created_at, o.name as client, u.name as reviewed_by
       from requests r join orgs o on o.id = r.client_org_id left join users u on u.id = r.advice_reviewed_by where r.id = $1`,
      [requestId],
    )
  ).rows[0];
  if (!r) throw notFound("Request not found");
  const drafts = (await tx.query<Record<string, unknown>>("select id, kind, model, output, confidence, status, created_at from ai_drafts where request_id = $1 order by created_at desc", [requestId])).rows;
  // E2: advice awaiting review whose rules or data have changed since (a new fact, a verification, evidence gone
  // stale) must be recomputed before approval; the review says so.
  const advice = r.advice as Advice | null;
  const dataChanged = !!advice && r.advice_status !== "approved" ? advice.dataVersion?.digest !== (await engineInputs(tx)).dataVersion.digest : false;
  // E5: a request that came from a saved public assessment shows then against now.
  const assessment = await assessmentContext(tx, requestId);
  return { ...r, drafts, dataChanged, assessment };
}

/** Why advice cannot be approved as it stands, or null: its rules and data must be the ones in force now (E2). */
async function staleAdviceReason(tx: Queryable, advice: Advice): Promise<string | null> {
  if (!advice.dataVersion) return "This advice was computed before the catalogue recorded data versions. Recompute it from current rules, check it, then approve.";
  const now = (await engineInputs(tx)).dataVersion;
  if (advice.dataVersion.digest === now.digest) return null;
  return `The rules or catalogue data changed since this advice was computed on ${advice.dataVersion.asOf} (a new fact, a verification, or evidence past its re-verification date). Recompute it, check it, then approve.`;
}

/** Advice from the rules and catalogue as they stand today, stamped with the data version it used (E2). */
export async function adviseNow(tx: Queryable, answers: AdviceInput): Promise<Advice> {
  const { asOf, rules, zones, dataVersion } = await engineInputs(tx);
  return { ...advise(answers, rules, zones, asOf), dataVersion };
}

export async function recomputeAdvice(tx: Queryable, actor: SessionUser, requestId: string) {
  if (!["ops", "founder"].includes(actor.role)) throw forbidden("Only ops recomputes advice");
  // Lock order (lib/context.ts): the audit chain first, then rows.
  await lockAuditChain(tx);
  const r = (await tx.query<{ answers: AdviceInput; advice_status: string }>("select answers, advice_status from requests where id = $1 for update", [requestId])).rows[0];
  if (!r) throw notFound("Request not found");
  const advice = await adviseNow(tx, r.answers);
  await tx.query("update requests set advice = $2, advice_status = 'pending_review', advice_reviewed_by = null, advice_reviewed_at = null where id = $1", [requestId, JSON.stringify(advice)]);
  await audit(tx, actor, "scoping.recomputed", "request", requestId, { hasUncertain: advice.hasUncertain, previousStatus: r.advice_status });
  return advice;
}

/**
 * Ops approves the advice the client will see. Statements may be removed (not reworded) and the recommended
 * structure may be changed; anything UNCERTAIN that stays is shown to the client with that label, and the
 * approval records exactly what was approved.
 */
export async function approveAdvice(tx: Queryable, actor: SessionUser, requestId: string, edits: { removeRuleKeys?: string[]; structure?: AdviceInput["jurisdiction"]; removePlaces?: string[]; note?: string }) {
  if (!["ops", "founder"].includes(actor.role)) throw forbidden("Only ops approves scoping advice");
  // Lock order (lib/context.ts): the audit chain first, then the request row, which orders this against a concurrent
  // recompute or draft approval of the same request.
  await lockAuditChain(tx);
  const r = (await tx.query<{ advice: Advice | null; advice_status: string; answers: AdviceInput }>("select advice, advice_status, answers from requests where id = $1 for update", [requestId])).rows[0];
  if (!r) throw notFound("Request not found");
  if (!r.advice) throw conflict("This request has no scoping advice to approve");
  const stale = await staleAdviceReason(tx, r.advice);
  if (stale) throw conflict(stale);
  const drop = new Set(edits.removeRuleKeys ?? []);
  const dropPlaces = new Set(edits.removePlaces ?? []);
  const keep = <T extends { ruleKey?: string }>(items: T[]) => items.filter((i) => !i.ruleKey || !drop.has(i.ruleKey));
  // A statement ops removes is removed everywhere the client could read it, findings included; a status shown is
  // the one the remaining findings support (the quote gate re-checks the structure against the rules regardless).
  const keepFindings = <T extends { findings?: Finding[]; status?: EligibilityStatus }>(items: T[]): T[] =>
    items.map((i) => {
      if (!i.findings) return i;
      const findings = keep(i.findings);
      return findings.length === i.findings.length ? i : { ...i, findings, status: statusOf(findings) };
    });
  const recommendation = edits.structure && edits.structure !== "not_sure" ? edits.structure : r.advice.structure.recommendation;
  const rules = await loadScopingRules(tx);
  // E1: a structure the rules exclude (offshore for a founder who needs visas) cannot be approved, whoever picks it.
  if (recommendation) {
    const check = assessStructure(recommendation as Structure, r.answers, new Rulebook(rules));
    if (check.status === "INELIGIBLE") {
      throw conflict(`${recommendation.replace(/_/g, " ")} cannot be approved for this request: ${check.findings.filter((f) => f.outcome === "fail").map((f) => f.text).join(" ")}`);
    }
  }
  // A different structure means different places: rank them again for that structure rather than show a
  // mainland recommendation over free-zone candidates.
  const places = recommendation === r.advice.structure.recommendation ? r.advice.places : rankPlaces(r.answers, await loadZones(tx), recommendation, rules);
  // Everything the engine said travels with the approval (E1: every structure's status, the excluded places and why,
  // cross-border points, missing facts, contradictions); ops removes statements, never rewords them.
  const approved: Advice = {
    ...r.advice,
    structure: { recommendation, reasons: keep(r.advice.structure.reasons) },
    places: keepFindings(places.filter((p) => !dropPlaces.has(p.zone))),
    ...(r.advice.structures ? { structures: keepFindings(r.advice.structures) } : {}),
    ...(r.advice.excluded ? { excluded: keepFindings(r.advice.excluded) } : {}),
    licences: keep(r.advice.licences),
    obligations: keep(r.advice.obligations),
    ...(r.advice.crossBorder ? { crossBorder: keep(r.advice.crossBorder) } : {}),
    hasUncertain: false,
  };
  approved.hasUncertain = [...approved.structure.reasons, ...approved.licences, ...approved.obligations, ...(approved.crossBorder ?? [])].some((x) => x.confidence !== "verified") || approved.places.some((p) => p.confidence !== "verified");
  // Once a structure is approved there is an option; what still needs confirming is worked out from what is shown.
  if (r.advice.noViableOption !== undefined) approved.noViableOption = !recommendation;
  if (r.advice.needsVerification !== undefined) approved.needsVerification = needsVerificationOf(approved);
  // E1: the approved structure settles the request: answers and scope follow, and offers priced for another
  // structure are withdrawn so none of them can be published. An accepted offer cannot be re-scoped here.
  let rescoped: Awaited<ReturnType<typeof rescopeForStructure>> = null;
  if (recommendation && r.answers.mode === "new_company" && recommendation !== r.answers.jurisdiction) {
    const accepted = (await tx.query("select 1 from offers where request_id = $1 and status = 'accepted'", [requestId])).rows.length;
    if (accepted) throw conflict("An offer for this request is already accepted: change the structure through a change order, not the scoping review");
    rescoped = await rescopeForStructure(tx, requestId, recommendation as Structure);
    // Offers priced on lines that changed are withdrawn; when the lines are the same ("not sure" was priced as a
    // free zone, and a free zone is settled) the offers stand.
    // Compared on code and quantity: the stored lines are jsonb, whose key order differs from a fresh object's.
    const key = (ls: Array<{ code: string; qty: number }>) => ls.map((l) => `${l.code}x${Number(l.qty)}`).sort().join(",");
    if (rescoped && key(rescoped.before) !== key(rescoped.after)) await withdrawOffers(tx, requestId, null, actor);
  }
  await tx.query("update requests set advice = $2, advice_status = 'approved', advice_reviewed_by = $3, advice_reviewed_at = app_now() where id = $1", [requestId, JSON.stringify(approved), actor.id]);
  await audit(tx, actor, "scoping.approved", "request", requestId, {
    removedRules: [...drop],
    removedPlaces: [...dropPlaces],
    structure: approved.structure.recommendation,
    structureChanged: recommendation !== r.advice.structure.recommendation,
    rescoped: rescoped ? { from: rescoped.from, before: rescoped.before, after: rescoped.after } : null,
    uncertainShown: approved.hasUncertain,
    note: edits.note ?? "",
  });
  return approved;
}

/** Search by name or reference, for MKW staff. Partners and clients never reach this. */
export async function search(tx: Queryable, q: string) {
  const term = q.trim();
  if (term.length < 2) return { clients: [], partners: [], engagements: [], offers: [] };
  const like = `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const prefix = term.toLowerCase().replace(/[^0-9a-f]/g, "");
  const [clients, partners, engagements, offers] = await Promise.all([
    tx.query("select id, name from orgs where type = 'client' and lower(name) like $1 order by name limit 10", [like]),
    tx.query("select id, name, profile->>'status' as status from orgs where type = 'partner' and lower(name) like $1 order by name limit 10", [like]),
    tx.query(
      `select e.id, e.status, e.emirate, o.name as client from engagements e join orgs o on o.id = e.client_org_id
       where lower(o.name) like $1 or ($2 <> '' and e.id::text like $2 || '%') order by e.created_at desc limit 10`,
      [like, prefix],
    ),
    tx.query(
      `select f.id, f.tier, f.status, o.name as client from offers f join orgs o on o.id = f.client_org_id
       where lower(o.name) like $1 or ($2 <> '' and f.id::text like $2 || '%') order by f.created_at desc limit 10`,
      [like, prefix],
    ),
  ]);
  return { clients: clients.rows, partners: partners.rows, engagements: engagements.rows, offers: offers.rows };
}

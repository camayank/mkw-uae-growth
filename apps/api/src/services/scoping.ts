import { advise, type Advice, type AdviceInput, type ScopingRule, type Zone } from "@tasees/core";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";

/**
 * Scoping intelligence (O5): rules and zones carry a confidence and a sign-off; advice is recomputed from them
 * and approved by ops before a client sees it; the founder verifies rules and zone data by name and date.
 */

export async function loadScopingRules(tx: Queryable): Promise<ScopingRule[]> {
  const r = await tx.query<Record<string, unknown>>("select * from scoping_rules order by kind, key");
  return r.rows.map((x) => ({
    key: String(x.key),
    kind: x.kind as ScopingRule["kind"],
    statement: String(x.statement),
    parameters: (x.parameters as Record<string, unknown>) ?? {},
    sourceUrl: String(x.source_url ?? ""),
    confidence: x.confidence as ScopingRule["confidence"],
    verifiedBy: (x.verified_by as string | null) ?? null,
    verifiedAt: x.verified_at ? String(x.verified_at).slice(0, 10) : null,
  }));
}

export async function loadZones(tx: Queryable): Promise<Zone[]> {
  const r = await tx.query<Record<string, unknown>>("select * from zones where active order by emirate, name");
  return r.rows.map((z) => ({
    name: String(z.name),
    emirate: String(z.emirate),
    type: z.type as Zone["type"],
    visaQuota: num(z.visa_quota),
    costMinFils: num(z.cost_min_fils),
    costMaxFils: num(z.cost_max_fils),
    timelineDays: num(z.timeline_days),
    activities: (z.activities as string[]) ?? [],
    sourceUrl: String(z.source_url ?? ""),
    confidence: z.confidence as Zone["confidence"],
  }));
}

export async function scopingOverview(tx: Queryable) {
  const rules = await tx.query<Record<string, unknown>>("select *, verified_at::text as verified_at_text from scoping_rules order by kind, key");
  const zones = await tx.query<Record<string, unknown>>("select *, verified_at::text as verified_at_text from zones order by type, emirate, name");
  const pending = await tx.query<{ n: number }>("select count(*)::int as n from requests where advice_status = 'pending_review'");
  return {
    rules: rules.rows.map((x) => ({ key: x.key, kind: x.kind, statement: x.statement, parameters: x.parameters, sourceUrl: x.source_url, confidence: x.confidence, verifiedBy: x.verified_by, verifiedAt: x.verified_at_text ? String(x.verified_at_text).slice(0, 10) : null })),
    zones: zones.rows.map((z) => ({ name: z.name, emirate: z.emirate, type: z.type, visaQuota: num(z.visa_quota), costMin: num(z.cost_min_fils), costMax: num(z.cost_max_fils), timelineDays: num(z.timeline_days), activities: z.activities, sourceUrl: z.source_url, confidence: z.confidence, verifiedBy: z.verified_by, verifiedAt: z.verified_at_text ? String(z.verified_at_text).slice(0, 10) : null, active: z.active })),
    pendingReviews: num(pending.rows[0]?.n),
  };
}

const httpUrl = (u: string) => /^https?:\/\/\S+$/i.test(u.trim());

/** The founder records a named person's verification of a rule (or marks it a rule of thumb), with its source. */
export async function verifyRule(tx: Queryable, actor: SessionUser, key: string, input: { confidence: "verified" | "rule_of_thumb" | "UNCERTAIN"; verifiedBy?: string; sourceUrl?: string; statement?: string }) {
  if (actor.role !== "founder") throw forbidden("Only the founder verifies scoping rules");
  const before = (await tx.query<Record<string, unknown>>("select * from scoping_rules where key = $1", [key])).rows[0];
  if (!before) throw notFound("Rule not found");
  const sourceUrl = (input.sourceUrl ?? String(before.source_url ?? "")).trim();
  if (input.confidence === "verified") {
    if (!input.verifiedBy || input.verifiedBy.trim().length < 2) throw badRequest("Name the person who verified the rule");
    if (!httpUrl(sourceUrl)) throw badRequest("A verified rule needs an http(s) source link");
  }
  await tx.query(
    `update scoping_rules set confidence = $2, verified_by = $3, verified_at = case when $2 = 'verified' then app_now()::date else null end,
       source_url = $4, statement = coalesce($5, statement), updated_at = app_now() where key = $1`,
    [key, input.confidence, input.confidence === "verified" ? input.verifiedBy!.trim() : null, sourceUrl, input.statement?.trim() || null],
  );
  await audit(tx, actor, "scoping.rule_verified", "scoping_rule", key, {
    before: { confidence: before.confidence, verifiedBy: before.verified_by, statement: before.statement, sourceUrl: before.source_url },
    after: { confidence: input.confidence, verifiedBy: input.verifiedBy ?? null, statement: input.statement ?? before.statement, sourceUrl },
  });
  return { ok: true };
}

export async function verifyZone(tx: Queryable, actor: SessionUser, name: string, input: { confidence: "verified" | "rule_of_thumb" | "UNCERTAIN"; verifiedBy?: string; sourceUrl?: string; costMinFils?: number; costMaxFils?: number; visaQuota?: number; timelineDays?: number; active?: boolean }) {
  if (actor.role !== "founder") throw forbidden("Only the founder verifies zone data");
  const before = (await tx.query<Record<string, unknown>>("select * from zones where name = $1", [name])).rows[0];
  if (!before) throw notFound("Zone not found");
  const sourceUrl = (input.sourceUrl ?? String(before.source_url ?? "")).trim();
  if (input.confidence === "verified" && (!input.verifiedBy || !httpUrl(sourceUrl))) throw badRequest("A verified zone needs the verifier's name and an http(s) source link");
  if (input.costMinFils !== undefined && input.costMaxFils !== undefined && input.costMinFils > input.costMaxFils) throw badRequest("Minimum cost is above the maximum");
  await tx.query(
    `update zones set confidence = $2, verified_by = $3, verified_at = case when $2 = 'verified' then app_now()::date else null end, source_url = $4,
       cost_min_fils = coalesce($5, cost_min_fils), cost_max_fils = coalesce($6, cost_max_fils), visa_quota = coalesce($7, visa_quota),
       timeline_days = coalesce($8, timeline_days), active = coalesce($9, active), updated_at = app_now() where name = $1`,
    [name, input.confidence, input.confidence === "verified" ? input.verifiedBy!.trim() : null, sourceUrl, input.costMinFils ?? null, input.costMaxFils ?? null, input.visaQuota ?? null, input.timelineDays ?? null, input.active ?? null],
  );
  await audit(tx, actor, "scoping.zone_verified", "zone", name, { before: { confidence: before.confidence, costMin: num(before.cost_min_fils), costMax: num(before.cost_max_fils), visaQuota: num(before.visa_quota) }, after: input });
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
  return { ...r, drafts };
}

export async function recomputeAdvice(tx: Queryable, actor: SessionUser, requestId: string) {
  if (!["ops", "founder"].includes(actor.role)) throw forbidden("Only ops recomputes advice");
  const r = (await tx.query<{ answers: AdviceInput; advice_status: string }>("select answers, advice_status from requests where id = $1", [requestId])).rows[0];
  if (!r) throw notFound("Request not found");
  const advice = advise(r.answers, await loadScopingRules(tx), await loadZones(tx));
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
  const r = (await tx.query<{ advice: Advice | null; advice_status: string }>("select advice, advice_status from requests where id = $1", [requestId])).rows[0];
  if (!r) throw notFound("Request not found");
  if (!r.advice) throw conflict("This request has no scoping advice to approve");
  const drop = new Set(edits.removeRuleKeys ?? []);
  const dropPlaces = new Set(edits.removePlaces ?? []);
  const keep = <T extends { ruleKey?: string }>(items: T[]) => items.filter((i) => !i.ruleKey || !drop.has(i.ruleKey));
  const approved: Advice = {
    structure: { recommendation: edits.structure ?? r.advice.structure.recommendation, reasons: keep(r.advice.structure.reasons) },
    places: r.advice.places.filter((p) => !dropPlaces.has(p.zone)),
    licences: keep(r.advice.licences),
    obligations: keep(r.advice.obligations),
    hasUncertain: false,
  };
  approved.hasUncertain = [...approved.structure.reasons, ...approved.licences, ...approved.obligations].some((x) => x.confidence !== "verified") || approved.places.some((p) => p.confidence !== "verified");
  await tx.query("update requests set advice = $2, advice_status = 'approved', advice_reviewed_by = $3, advice_reviewed_at = app_now() where id = $1", [requestId, JSON.stringify(approved), actor.id]);
  await audit(tx, actor, "scoping.approved", "request", requestId, {
    removedRules: [...drop],
    removedPlaces: [...dropPlaces],
    structure: approved.structure.recommendation,
    uncertainShown: approved.hasUncertain,
    note: edits.note ?? "",
  });
  return approved;
}

/** Search by name or reference, for MKW staff. Partners and clients never reach this. */
export async function search(tx: Queryable, q: string) {
  const term = q.trim();
  if (term.length < 2) return { clients: [], partners: [], engagements: [], offers: [] };
  const like = `%${term.toLowerCase()}%`;
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

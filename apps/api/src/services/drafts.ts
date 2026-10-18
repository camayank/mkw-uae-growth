import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { conflict, forbidden, notFound } from "../lib/errors.ts";
import type { AiModel } from "../lib/ai.ts";
import { loadDeliverables } from "./repo.ts";

/**
 * The AI review queue (O5). A draft is written by the model, read by a person, and either approved (which
 * applies it) or discarded. Nothing a model writes changes a request or reaches a client on its own.
 */

export async function draftScopeForRequest(tx: Queryable, actor: SessionUser | null, requestId: string, model: AiModel) {
  const r = (await tx.query<{ answers: { description?: string } }>("select answers from requests where id = $1", [requestId])).rows[0];
  if (!r) throw notFound("Request not found");
  const text = r.answers.description?.trim() ?? "";
  if (!text) return null;
  const known = [...(await loadDeliverables(tx)).keys()];
  const output = await model.draftScope(text, known);
  const row = (
    await tx.query<{ id: string }>(
      "insert into ai_drafts (kind, request_id, model, input, output) values ('scope', $1, $2, $3, $4) returning id",
      [requestId, model.kind, JSON.stringify({ description: text }), JSON.stringify(output)],
    )
  ).rows[0]!;
  await audit(tx, actor, "ai.draft_created", "ai_draft", row.id, { kind: "scope", requestId, model: model.kind, lines: output.lines.length });
  return { id: row.id, output };
}

export async function listDrafts(tx: Queryable, status = "pending") {
  const r = await tx.query<Record<string, unknown>>(
    `select d.*, o.name as client, u.name as reviewer from ai_drafts d
       left join requests r on r.id = d.request_id left join orgs o on o.id = r.client_org_id left join users u on u.id = d.reviewed_by
     where d.status = $1 order by d.created_at desc limit 100`,
    [status],
  );
  return r.rows.map((d) => ({ id: d.id, kind: d.kind, requestId: d.request_id, engagementId: d.engagement_id, model: d.model, input: d.input, output: d.output, confidence: d.confidence, status: d.status, client: d.client, reviewer: d.reviewer, reviewedAt: d.reviewed_at, note: d.review_note, createdAt: d.created_at }));
}

/** Approving a scope draft replaces the request's scope lines with the draft's (ops may trim them first). */
export async function reviewDraft(tx: Queryable, actor: SessionUser, draftId: string, decision: "approve" | "discard", note: string, keepCodes?: string[]) {
  if (!["ops", "founder"].includes(actor.role)) throw forbidden("Only ops reviews AI drafts");
  const d = (await tx.query<Record<string, unknown>>("select * from ai_drafts where id = $1", [draftId])).rows[0];
  if (!d) throw notFound("Draft not found");
  if (d.status !== "pending") throw conflict(`This draft was already ${String(d.status)}`);
  if (decision === "approve" && d.kind === "scope" && d.request_id) {
    const req = (await tx.query<{ status: string }>("select status from requests where id = $1", [String(d.request_id)])).rows[0];
    // Only before partners are asked to quote: once an RFQ is out, sealed quotes are for the scope as sent.
    if (!req || req.status !== "scoped") throw conflict("Partners have already been asked to quote this scope (or it has been priced); the scope can no longer change from a draft");
    const output = d.output as { lines: Array<{ code: string; qty: number }> };
    const known = await loadDeliverables(tx);
    const lines = output.lines.filter((l) => known.has(l.code) && (!keepCodes || keepCodes.includes(l.code))).map((l) => ({ code: l.code, qty: Math.max(1, Math.floor(l.qty)) }));
    if (!lines.length) throw conflict("Nothing left to apply: discard the draft instead");
    // The audit event records who approved what; request notes are read by clients and partners, so nothing
    // about the draft or the reviewer goes there.
    await tx.query("update requests set scope = $2 where id = $1", [String(d.request_id), JSON.stringify({ lines })]);
  }
  await tx.query("update ai_drafts set status = $2, reviewed_by = $3, reviewed_at = app_now(), review_note = $4 where id = $1", [draftId, decision === "approve" ? "approved" : "discarded", actor.id, note]);
  await audit(tx, actor, decision === "approve" ? "ai.draft_approved" : "ai.draft_discarded", "ai_draft", draftId, { kind: d.kind, requestId: d.request_id, note, keepCodes: keepCodes ?? null, appliedBy: actor.name });
  return { ok: true };
}

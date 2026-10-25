import { asPlatform, audit } from "../lib/context.ts";
import type { Database, Queryable } from "../lib/db.ts";
import { redactFileName, type AiModel, type DocumentCheckInput } from "../lib/ai.ts";
import type { Notifier } from "../lib/notify.ts";

/**
 * The document checker (O11), the outbox's first agent subscriber. Each upload writes a `document_check` event in
 * the upload's own transaction; this handler asks the model for a first check and files it as a draft (UNCERTAIN)
 * beside the upload. The draft never changes the document or the step: a person agrees or disagrees with it.
 * Only metadata reaches the model (see DocumentCheckInput). A model failure is retried by the outbox and, if it
 * persists, simply leaves no draft.
 */
export type CheckSubject = DocumentCheckInput["subject"];

interface Loaded {
  input: Omit<DocumentCheckInput, "today">;
  engagementId: string | null;
}

async function loadSubject(tx: Queryable, subject: CheckSubject, id: string): Promise<Loaded | null> {
  if (subject === "evidence") {
    const r = (
      await tx.query<{ file_name: string; type: string; required: string[]; engagement_id: string }>(
        "select e.file_name, e.type, m.evidence_required as required, e.engagement_id from evidence e join milestones m on m.id = e.milestone_id where e.id = $1",
        [id],
      )
    ).rows[0];
    return r ? { input: { subject, fileName: r.file_name, declaredType: r.type, required: r.required ?? [], reference: null, expiresOn: null }, engagementId: r.engagement_id } : null;
  }
  if (subject === "document_request") {
    const r = (await tx.query<{ file_name: string | null; kind: string; engagement_id: string }>("select file_name, kind, engagement_id from document_requests where id = $1", [id])).rows[0];
    return r?.file_name ? { input: { subject, fileName: r.file_name, declaredType: r.kind, required: [r.kind], reference: null, expiresOn: null }, engagementId: r.engagement_id } : null;
  }
  if (subject === "partner_document") {
    const r = (await tx.query<{ file_name: string; kind: string; reference: string | null; expires_on: string | null }>("select file_name, kind, reference, expires_on::text from partner_documents where id = $1", [id])).rows[0];
    return r ? { input: { subject, fileName: r.file_name, declaredType: r.kind, required: [r.kind], reference: r.reference, expiresOn: r.expires_on }, engagementId: null } : null;
  }
  const r = (await tx.query<{ evidence_name: string | null; kind: string; engagement_id: string | null }>("select evidence_name, kind, engagement_id from obligations where id = $1", [id])).rows[0];
  // Filing evidence is the authority's acknowledgement or receipt for the filing.
  return r?.evidence_name ? { input: { subject, fileName: r.evidence_name, declaredType: r.kind, required: ["submission_receipt", "receipt"], reference: null, expiresOn: null }, engagementId: r.engagement_id } : null;
}

export function registerDocumentChecker(notify: Notifier, db: Database, model: AiModel) {
  notify.on("document_check", {
    async handle(row) {
      const { subject, id } = row.payload as { subject: CheckSubject; id: string };
      const loaded = await asPlatform(db, null, async (tx) => {
        // One draft per event, however often the dispatcher sees it.
        const seen = (await tx.query("select 1 from ai_drafts where kind = 'document_check' and input->>'outboxId' = $1", [String(row.id)])).rows.length > 0;
        if (seen) return null;
        const l = await loadSubject(tx, subject, id);
        const today = (await tx.query<{ d: string }>("select (app_now() at time zone 'Asia/Dubai')::date::text as d")).rows[0]!.d;
        return l ? { ...l, today } : null;
      });
      if (!loaded) return;
      // The model sees the file name reduced to document words, dates and the extension (no names, no ID numbers).
      const input: DocumentCheckInput = { ...loaded.input, fileName: redactFileName(loaded.input.fileName, [loaded.input.declaredType, ...loaded.input.required]), today: loaded.today };
      const output = await model.checkDocument(input);
      await asPlatform(db, null, async (tx) => {
        const d = (
          await tx.query<{ id: string }>(
            `insert into ai_drafts (kind, engagement_id, subject_type, subject_id, model, input, output)
             values ('document_check', $1, $2, $3, $4, $5, $6)
             on conflict ((input->>'outboxId')) where kind = 'document_check' do nothing returning id`,
            [loaded.engagementId, subject, id, model.kind, JSON.stringify({ ...input, outboxId: String(row.id) }), JSON.stringify(output)],
          )
        ).rows[0];
        if (d) await audit(tx, null, "ai.draft_created", "ai_draft", d.id, { kind: "document_check", subject, subjectId: id, model: model.kind, issues: output.issues.length });
      });
    },
    async check(row) {
      const has = await asPlatform(db, null, async (tx) => (await tx.query("select 1 from ai_drafts where kind = 'document_check' and input->>'outboxId' = $1", [String(row.id)])).rows.length > 0);
      return has ? "done" : "not_done";
    },
  });
}

/**
 * A replacement upload (a client document sent back, filing evidence uploaded again) makes the earlier upload's
 * pending checks obsolete: they are closed as superseded, so no one confirms a verdict against the wrong file.
 */
export async function supersedeChecks(tx: Queryable, subject: CheckSubject, id: string): Promise<void> {
  const old = await tx.query<{ id: string }>(
    `update ai_drafts set status = 'discarded', reviewed_at = app_now(), review_note = 'superseded by a newer upload'
      where kind = 'document_check' and subject_type = $1 and subject_id = $2 and status = 'pending' returning id`,
    [subject, id],
  );
  for (const d of old.rows) await audit(tx, null, "ai.draft_superseded", "ai_draft", d.id, { kind: "document_check", subject, subjectId: id });
}

/** The latest document check for each upload, keyed `subject:id`, for showing beside the upload. */
export async function latestChecks(tx: Queryable, subjects: Array<{ type: CheckSubject; id: string }>) {
  if (!subjects.length) return new Map<string, Record<string, unknown>>();
  const r = await tx.query<{ subject_type: string; subject_id: string; id: string; status: string; output: Record<string, unknown>; created_at: string }>(
    `select distinct on (subject_type, subject_id) subject_type, subject_id, id, status, output, created_at::text
       from ai_drafts where kind = 'document_check' and (subject_type || ':' || subject_id::text) = any($1)
      order by subject_type, subject_id, created_at desc`,
    [subjects.map((s) => `${s.type}:${s.id}`)],
  );
  return new Map(r.rows.map((d) => [`${d.subject_type}:${d.subject_id}`, { id: d.id, status: d.status, check: d.output, at: d.created_at }]));
}

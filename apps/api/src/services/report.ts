import { preliminaryReport, reportLines, reviewedReport, type Advice, type AdviceInput } from "@tasees/core";
import { asPlatform, asUser, type SessionUser } from "../lib/context.ts";
import type { Database, Queryable } from "../lib/db.ts";
import { notFound } from "../lib/errors.ts";
import { textPdf } from "../lib/pdf.ts";
import { recoverAssessment } from "./leads.ts";
import { publicAssess } from "./public.ts";

/**
 * The UAE Entity Assessment Report (E7D) as a PDF. Preliminary from a saved public result (what the page shows,
 * D80), reviewed from the advice a named person approved for the client. The writer is the repository's own text
 * PDF (D26); the content is built in core from the same data the screens read.
 */

const today = async (tx: Queryable) => (await tx.query<{ d: string }>("select gulf(app_now())::text as d")).rows[0]!.d.slice(0, 10);
/** A reference a person can quote: the first eight characters of the row id, upper case, never the recovery code. */
const ref = (id: string, prefix: string) => `${prefix}-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

export async function publicReportPdf(tx: Queryable, code: string): Promise<{ pdf: Buffer; filename: string }> {
  const saved = await recoverAssessment(tx, code);
  if (!saved) throw notFound("No saved result with that code");
  const result = await publicAssess(tx, saved.answers);
  const date = await today(tx);
  const report = preliminaryReport(result, saved.answers, { reference: ref(saved.id, "PRE"), date, guidance: (result.guidance ?? []).map((g) => ({ title: g.title, text: g.text })) });
  return { pdf: textPdf(reportLines(report), `${report.title} ${report.reference}`), filename: `uae-entity-assessment-${report.reference}.pdf` };
}

/**
 * The client's own request: the reviewed report once the advice is approved, a preliminary one from the answers until
 * then. The request is read as the client (row-level security and the column grants decide what they see, and
 * `app_approved_advice` returns the advice only once approved); the reviewer's name, which the client role cannot
 * read, is looked up by the platform for the one request the client could read.
 */
export async function clientReportPdf(db: Database, user: SessionUser, requestId: string): Promise<{ pdf: Buffer; filename: string; status: "preliminary" | "reviewed" }> {
  const r = await asUser(db, user, async (tx) => {
    const row = (
      await tx.query<{ id: string; answers: AdviceInput; advice: Advice | null; advice_reviewed_at: string | null; company: string }>(
        "select r.id, r.answers, app_approved_advice(r.id) as advice, r.advice_reviewed_at::text as advice_reviewed_at, o.name as company from requests r join orgs o on o.id = r.client_org_id where r.id = $1",
        [requestId],
      )
    ).rows[0];
    if (!row) throw notFound("Request not found");
    return { ...row, date: await today(tx) };
  });
  const reference = ref(r.id, "REQ");
  if (r.advice) {
    const reviewedBy = await asPlatform(db, null, async (tx) => (await tx.query<{ name: string | null }>("select u.name from requests q left join users u on u.id = q.advice_reviewed_by where q.id = $1", [r.id])).rows[0]?.name ?? null);
    const report = reviewedReport(r.advice, r.answers, { reference, date: r.date, company: r.company, reviewedBy, reviewedAt: r.advice_reviewed_at ? r.advice_reviewed_at.slice(0, 10) : null });
    return { pdf: textPdf(reportLines(report), `${report.title} ${reference}`), filename: `uae-entity-assessment-${reference}.pdf`, status: "reviewed" };
  }
  // Not reviewed yet: the public view of the client's own answers, labelled preliminary, so nothing unapproved is stated.
  const result = await asPlatform(db, null, (tx) => publicAssess(tx, r.answers));
  const report = preliminaryReport(result, r.answers, { reference, date: r.date, company: r.company });
  report.statusLine = "PRELIMINARY: your request is with MKW Advisors for review; this is general information from your answers, not advice.";
  return { pdf: textPdf(reportLines(report), `${report.title} ${reference}`), filename: `uae-entity-assessment-${reference}.pdf`, status: "preliminary" };
}



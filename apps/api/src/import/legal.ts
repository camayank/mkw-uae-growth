import type { Queryable } from "../lib/db.ts";
import { upsertLegalText, type LegalKind } from "../services/legal.ts";
import { newReport, type Report } from "./common.ts";

/**
 * A legal text in markdown → a new version of the client terms or the Partner Network Agreement (O10). The kind is
 * read from the first heading. Identical text is unchanged; changed text becomes the next version, a draft until the
 * founder records the lawyer's sign-off. The agreement is addressed to partners, so it must not use the name Tasees.
 */
export function legalKindOf(md: string): { kind: LegalKind; title: string } {
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? "";
  if (/client terms/i.test(title)) return { kind: "client_terms", title };
  if (/partner network agreement/i.test(title)) return { kind: "partner_agreement", title };
  throw new Error(`Cannot tell which legal text this is from its title "${title}" (expected "... Client Terms" or "... Partner Network Agreement")`);
}

export async function importLegal(tx: Queryable, md: string, source: string): Promise<Report> {
  const { kind, title } = legalKindOf(md);
  const report = newReport(`legal (${kind})`, source);
  if (kind === "partner_agreement" && /\btasees\b/i.test(md)) {
    report.rows.push({ line: 1, ref: kind, action: "skipped", reason: 'the agreement mentions "Tasees"; partners only ever see MKW Advisors. Remove it and import again' });
    return report;
  }
  const r = await upsertLegalText(tx, kind, title, md, source.split("/").pop() ?? source);
  report.rows.push({
    line: 1,
    ref: `${kind} v${r.version}`,
    action: r.action,
    reason: r.action === "created" ? "new version, shown as Draft, pending legal review until the founder records the lawyer's sign-off" : "same text as the current version",
  });
  return report;
}

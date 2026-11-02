import { AUTHORITY_FIELDS, FIELD_LABEL, PLACE_FIELDS, normaliseName, parseFactValue, type Confidence, type SubjectKind } from "@tasees/core";
import type { SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { appendFact, loadPlaces, placeByName } from "../services/catalogue.ts";
import { excelDate } from "./xlsx.ts";
import { newReport, readTable, sameValue, type Report, type ReportRow } from "./common.ts";

/**
 * Catalogue facts (E2): a verifier's sheet of evidence → append-only facts on places and authorities.
 *
 * Columns: Place or authority, Field, Value, Source, Evidence date, Confidence, and optionally Kind (place or
 * authority, default place), Verified by, Next verification, Note. A field may be its key (`cost`) or its label.
 * Values are typed as a person would (AED ranges like 12000-20000, lists separated by semicolons, "25.2, 55.3").
 *
 * - A row whose latest fact already says the same thing (value, source, dates, confidence, verifier) is unchanged,
 *   so a second run writes nothing.
 * - A verified row needs a named verifier, an http(s) source and an importing founder (`--as`); without the founder it
 *   is skipped, so a file alone can never make anything verified.
 * - Unknown places, authorities or fields are skipped with the reason; nothing is guessed. Nobody is notified.
 */
export async function importCatalogueFacts(tx: Queryable, grid: string[][], source: string, actor: SessionUser | null = null): Promise<Report> {
  const report = newReport("catalogue-facts", source);
  const t = readTable(grid, ["Place or authority", "Field", "Value", "Source", "Evidence date", "Confidence"]);
  if (!t) throw new Error('No header row with "Place or authority", "Field", "Value", "Source", "Evidence date" and "Confidence"');
  const C = {
    kind: t.col("Kind"),
    subject: t.col("Place or authority"),
    field: t.col("Field"),
    value: t.col("Value"),
    source: t.col("Source"),
    evidence: t.col("Evidence date"),
    confidence: t.col("Confidence"),
    verifiedBy: t.col("Verified by"),
    next: t.col("Next verification"),
    note: t.col("Note"),
  };
  const cell = (cells: string[], i: number) => (i >= 0 ? String(cells[i] ?? "").trim() : "");
  const fieldKey = (kind: SubjectKind, raw: string): string | null => {
    const n = normaliseName(raw);
    const keys: readonly string[] = kind === "place" ? PLACE_FIELDS : AUTHORITY_FIELDS;
    return keys.find((k) => normaliseName(k) === n || normaliseName(FIELD_LABEL[k] ?? "") === n) ?? null;
  };
  const authorities = (await tx.query<{ id: string; name: string; aliases: string[] }>(
    "select a.id, a.name, coalesce((select array_agg(alias) from authority_aliases x where x.authority_id = a.id), '{}') as aliases from authorities a",
  )).rows;
  const authorityBy = (raw: string): string | null => {
    const n = normaliseName(raw);
    const hit = authorities.filter((a) => a.id === raw || [a.name, ...a.aliases].some((x) => normaliseName(x) === n));
    return hit.length === 1 ? hit[0]!.id : null;
  };
  const places = await loadPlaces(tx, undefined, { includeInactive: true });
  const CONF: Record<string, Confidence> = { verified: "verified", "rule of thumb": "rule_of_thumb", rule_of_thumb: "rule_of_thumb", uncertain: "UNCERTAIN" };

  for (const { line, cells } of t.rows) {
    const rawSubject = cell(cells, C.subject);
    const rawField = cell(cells, C.field);
    const row: ReportRow = { line, ref: `${rawSubject || "(no subject)"} · ${rawField || "(no field)"}`, action: "skipped" };
    report.rows.push(row);
    if (!rawSubject && !rawField && !cell(cells, C.value)) {
      report.rows.pop();
      continue;
    }
    const kindRaw = cell(cells, C.kind).toLowerCase() || "place";
    if (kindRaw !== "place" && kindRaw !== "authority") {
      row.reason = `kind "${kindRaw}" is neither place nor authority`;
      continue;
    }
    const kind = kindRaw as SubjectKind;
    const subject = kind === "place" ? await placeByName(tx, rawSubject, places) : authorityBy(rawSubject);
    if (!subject) {
      row.reason = `no single ${kind} matches "${rawSubject}"`;
      continue;
    }
    const field = fieldKey(kind, rawField);
    if (!field) {
      row.reason = `"${rawField}" is not a ${kind} field`;
      continue;
    }
    row.ref = `${subject} · ${field}`;
    const parsed = parseFactValue(kind, field, cell(cells, C.value));
    if (!parsed.ok) {
      row.reason = parsed.error;
      continue;
    }
    const confidence = CONF[cell(cells, C.confidence).toLowerCase()];
    if (!confidence) {
      row.reason = `confidence "${cell(cells, C.confidence)}" is not Verified, Rule of thumb or UNCERTAIN`;
      continue;
    }
    const evidenceDate = excelDate(cell(cells, C.evidence));
    if (!evidenceDate) {
      row.reason = `evidence date "${cell(cells, C.evidence)}" is not a date`;
      continue;
    }
    const nextRaw = cell(cells, C.next);
    const next = nextRaw ? excelDate(nextRaw) : null;
    if (nextRaw && !next) {
      row.reason = `next verification "${nextRaw}" is not a date`;
      continue;
    }
    const verifiedBy = cell(cells, C.verifiedBy) || null;
    if (confidence === "verified" && !actor) {
      row.reason = "verified evidence is recorded only with the importing founder named (--as)";
      continue;
    }
    const sourceUrl = cell(cells, C.source);
    const latest = (
      await tx.query<{ value: unknown; source_url: string; evidence_date: string; confidence: string; verified_by: string | null; next_verification: string | null }>(
        `select value, source_url, evidence_date::text as evidence_date, confidence, verified_by, next_verification::text as next_verification
         from catalogue_facts where subject_kind = $1 and subject = $2 and field = $3 order by id desc limit 1`,
        [kind, subject, field],
      )
    ).rows[0];
    if (
      latest &&
      sameValue(latest.value, parsed.value) &&
      latest.source_url === sourceUrl &&
      latest.evidence_date === evidenceDate &&
      latest.confidence === confidence &&
      (latest.verified_by ?? null) === verifiedBy &&
      (!next || latest.next_verification === next)
    ) {
      row.action = "unchanged";
      continue;
    }
    try {
      await appendFact(tx, actor, { subjectKind: kind, subject, field, value: parsed.value, sourceUrl, evidenceDate, confidence, verifiedBy, nextVerification: next, note: cell(cells, C.note) });
    } catch (e) {
      row.reason = (e as Error).message;
      continue;
    }
    row.action = latest ? "updated" : "created";
    row.reason = `${FIELD_LABEL[field] ?? field}, ${confidence}`;
  }
  return report;
}

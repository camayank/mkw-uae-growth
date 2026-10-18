import { asPlatform, type SessionUser } from "../lib/context.ts";
import type { Database, Queryable } from "../lib/db.ts";

/**
 * Shared plumbing for the go-live importers (O10).
 *
 * Every importer runs inside one platform transaction. A dry run executes exactly the same code and then rolls the
 * transaction back, so the dry-run report is what `--apply` will do, row for row. Importers take no notifier:
 * importing never emails or notifies anyone. Each created or updated record writes one audit event; unchanged and
 * skipped rows write nothing, which is what makes a second run a no-op.
 */

export type Action = "created" | "updated" | "unchanged" | "skipped";

export interface ReportRow {
  /** Row number in the source (spreadsheet row or table line), for the person fixing the file. */
  line: number;
  /** A reference that identifies the record without personal or contact data (Partner ID, code and place, date). */
  ref: string;
  /** Human label for the console (may hold a firm's name); left out of redacted evidence. */
  label?: string;
  action: Action;
  /** Why it was skipped, or what changed. */
  reason?: string;
  /** Things to look at that did not stop the row (unknown codes dropped, fields kept for MKW to confirm). */
  warnings?: string[];
}

export interface Report {
  kind: string;
  source: string;
  applied: boolean;
  rows: ReportRow[];
  /** Notes about the whole file (columns ignored, settings the platform holds elsewhere). */
  notes: string[];
}

export const newReport = (kind: string, source: string): Report => ({ kind, source, applied: false, rows: [], notes: [] });

class DryRun extends Error {
  constructor(readonly report: Report) {
    super("dry run");
  }
}

/** Run an importer as a dry run (rolled back) or for real. */
export async function runImport(db: Database, actor: SessionUser | null, apply: boolean, fn: (tx: Queryable) => Promise<Report>): Promise<Report> {
  try {
    return await asPlatform(db, actor, async (tx) => {
      const report = await fn(tx);
      report.applied = apply;
      if (!apply) throw new DryRun(report);
      return report;
    });
  } catch (e) {
    if (e instanceof DryRun) return e.report;
    throw e;
  }
}

export function counts(r: Report): Record<Action, number> {
  const c: Record<Action, number> = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const row of r.rows) c[row.action]++;
  return c;
}

/** Console report: one line per row, then the totals. */
export function formatReport(r: Report): string {
  const verb = (a: Action) => (r.applied ? a : a === "skipped" || a === "unchanged" ? a : `would be ${a}`);
  const lines = r.rows.map((row) => {
    const w = row.warnings?.length ? `  [${row.warnings.join("; ")}]` : "";
    return `${verb(row.action).padEnd(16)} row ${String(row.line).padStart(3)}  ${row.ref}${row.label ? `  ${row.label}` : ""}${row.reason ? `  — ${row.reason}` : ""}${w}`;
  });
  const c = counts(r);
  const total = `${r.kind}: ${c.created} created, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skipped} skipped${r.applied ? "" : " (dry run: nothing written; run again with --apply)"}`;
  return [...lines, ...r.notes.map((n) => `note  ${n}`), total].join("\n");
}

/**
 * Evidence copy for the repository: counts, references and reasons only. Labels (firm names) are left out and any
 * email address, phone number or web address that slipped into a reason is masked.
 */
export function redactedMarkdown(r: Report, when: string): string {
  const mask = (s: string) =>
    s
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
      .replace(/\+?\d[\d\s()-]{7,}\d/g, "[phone]")
      .replace(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ae|com|net|org|io|co)\b\S*/gi, "[web]");
  const c = counts(r);
  const out = [
    `# Import dry run: ${r.kind}`,
    "",
    `Source: \`${r.source.split("/").pop()}\` · ${when} · ${r.applied ? "applied" : "dry run (rolled back)"}. Firm names and contact details removed.`,
    "",
    "| Created | Updated | Unchanged | Skipped |",
    "| ---: | ---: | ---: | ---: |",
    `| ${c.created} | ${c.updated} | ${c.unchanged} | ${c.skipped} |`,
    "",
    "| Row | Reference | Result | Reason | Warnings |",
    "| ---: | --- | --- | --- | --- |",
    ...r.rows.map((row) => `| ${row.line} | ${mask(row.ref)} | ${row.action} | ${mask(row.reason ?? "")} | ${mask((row.warnings ?? []).join("; "))} |`),
  ];
  if (r.notes.length) out.push("", "Notes:", "", ...r.notes.map((n) => `- ${mask(n)}`));
  return out.join("\n") + "\n";
}

// Reading tables ------------------------------------------------------------------------------------------------

/** Header text reduced to words: "Professional fee (AED, excl. VAT)" → "professional fee"; "Govt" → "government". */
export function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bgovt\b/g, "government")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface Table {
  /** Index in the grid of the header row. */
  headerAt: number;
  header: string[];
  /** Data rows after the header, with their 1-based line numbers in the source. */
  rows: Array<{ line: number; cells: string[] }>;
  /** Column index for the first alias that matches, or -1. */
  col: (...aliases: string[]) => number;
}

/** Find the header row (the first row holding every `required` header, compared normalised) and the rows below it. */
export function readTable(grid: string[][], required: string[]): Table | null {
  const want = required.map(normaliseHeader);
  const headerAt = grid.findIndex((r) => {
    const have = new Set((r ?? []).map((c) => normaliseHeader(String(c ?? ""))));
    return want.every((w) => have.has(w));
  });
  if (headerAt < 0) return null;
  const header = grid[headerAt]!.map((c) => String(c ?? ""));
  const norm = header.map(normaliseHeader);
  const rows = grid
    .slice(headerAt + 1)
    .map((cells, i) => ({ line: headerAt + i + 2, cells: (cells ?? []).map((c) => String(c ?? "").trim()) }))
    .filter((r) => r.cells.some((c) => c !== ""));
  const col = (...aliases: string[]) => {
    for (const a of aliases.map(normaliseHeader)) {
      const i = norm.indexOf(a);
      if (i >= 0) return i;
    }
    return -1;
  };
  return { headerAt, header, rows, col };
}

/** Split a list cell ("A; B, C") into trimmed items; "None", "No", "-" and blanks mean none. */
export function listCell(v: string | undefined): string[] {
  const s = String(v ?? "").trim();
  if (!s || /^(none|no|n\/a|-)$/i.test(s)) return [];
  return s
    .split(/[;,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** A blank cell, or one that only says "None". */
export const isBlank = (v: string | undefined) => !String(v ?? "").trim() || /^none$/i.test(String(v).trim());

/** AED written in a cell ("1,250.50", "AED 1250") as integer fils, without floating point. Null when blank or not money. */
export function aedToFils(v: string | undefined): number | null {
  const s = String(v ?? "")
    .replace(/aed/i, "")
    .replace(/[,\s]/g, "")
    .trim();
  if (!s) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Shallow comparison of two JSON-able values, key order ignored. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v ?? null;
}

/** Owner-Decisions.md and MKW-Company-Details.md: markdown tables as rows of cells (header row first). */
export function markdownTables(md: string): string[][][] {
  const tables: string[][][] = [];
  let current: string[][] | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      current = null;
      continue;
    }
    const cells = line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue; // the --- separator
    if (!current) tables.push((current = []));
    current.push(cells);
  }
  return tables;
}

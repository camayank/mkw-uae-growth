import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { excelDate, type Workbook } from "./xlsx.ts";
import { aedToFils, isBlank, newReport, readTable, type Report, type ReportRow } from "./common.ts";

/**
 * Government fees tab → the fee table (O10). Rows without a fee are skipped. A row is `verified` only when
 * "Verified by" names the fee verifier the owner named in Owner-Decisions.md (row 12), "Verified on" is a date and
 * the source is an http(s) link (the same conditions the founder's Verify button checks). Every other row is
 * UNCERTAIN, so pricing stops any line resting on it for ops. A live row with the same figures is unchanged; a
 * different one for the same code, place and effective date is retired and replaced, as the console does.
 */
export async function importFees(tx: Queryable, book: Workbook, source: string, feeVerifier: string | null, actor: SessionUser | null = null): Promise<Report> {
  const report = newReport("fees", source);
  const grid = book.get("Government fees");
  if (!grid) throw new Error('The workbook has no "Government fees" tab');
  const t = readTable(grid, ["Code", "Emirate", "Fee (AED)"]);
  if (!t) throw new Error('No header row with "Code", "Emirate" and "Fee (AED)" on the Government fees tab');
  const C = {
    code: t.col("Code"),
    emirate: t.col("Emirate"),
    zone: t.col("Free zone (blank = whole emirate)", "Free zone"),
    fee: t.col("Fee (AED)", "Fee"),
    url: t.col("Source URL (official page)", "Source URL"),
    note: t.col("Source note"),
    from: t.col("Effective from"),
    by: t.col("Verified by"),
    on: t.col("Verified on"),
  };
  report.notes.push(feeVerifier ? `Fee verifier named in Owner-Decisions.md: rows verified only by that person count as verified.` : "No fee verifier is named in Owner-Decisions.md (row 12): every imported fee stays UNCERTAIN.");
  const codes = new Set((await tx.query<{ code: string }>("select code from deliverables")).rows.map((r) => r.code));
  const today = (await tx.query<{ d: string }>("select (app_now() at time zone 'Asia/Dubai')::date::text as d")).rows[0]!.d;
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");

  for (const { line, cells } of t.rows) {
    const code = cell(cells, C.code).toUpperCase();
    const emirate = cell(cells, C.emirate);
    const zone = isBlank(cell(cells, C.zone)) ? null : cell(cells, C.zone);
    const row: ReportRow = { line, ref: `${code} ${emirate}${zone ? ` / ${zone}` : ""}`, action: "skipped" };
    report.rows.push(row);
    const fee = aedToFils(cell(cells, C.fee));
    if (fee === null) {
      row.reason = isBlank(cell(cells, C.fee)) ? "no fee yet" : `fee "${cell(cells, C.fee)}" is not an amount`;
      continue;
    }
    if (!codes.has(code)) {
      row.reason = `unknown service code "${code}"`;
      continue;
    }
    if (!emirate) {
      row.reason = "no emirate";
      continue;
    }
    const fromRaw = cell(cells, C.from);
    const effectiveFrom = isBlank(fromRaw) ? today : excelDate(fromRaw);
    if (!effectiveFrom) {
      row.reason = `effective-from "${fromRaw}" is not a date`;
      continue;
    }
    const sourceUrl = cell(cells, C.url);
    const sourceNote = cell(cells, C.note);
    const by = cell(cells, C.by);
    const on = excelDate(cell(cells, C.on));
    const verified = !!feeVerifier && by.toLowerCase() === feeVerifier.toLowerCase() && !!on && /^https?:\/\//i.test(sourceUrl);
    if (by && !verified) row.warnings = [feeVerifier && by.toLowerCase() !== feeVerifier.toLowerCase() ? "verified by someone other than the named fee verifier: stays UNCERTAIN" : "verification incomplete (named verifier, date and an http(s) source are all needed): stays UNCERTAIN"];
    const confidence = verified ? "verified" : "UNCERTAIN";

    const live = (
      await tx.query<Record<string, unknown>>(
        "select id, fee_fils, source_url, source_note, confidence, verified_by, verified_at::text as verified_at from government_fees where code = $1 and emirate = $2 and free_zone is not distinct from $3 and effective_from = $4::date and retired_at is null",
        [code, emirate, zone, effectiveFrom],
      )
    ).rows[0];
    if (
      live &&
      num(live.fee_fils) === fee &&
      live.source_url === sourceUrl &&
      live.source_note === sourceNote &&
      live.confidence === confidence &&
      (live.verified_by ?? null) === (verified ? by : null) &&
      (live.verified_at ? String(live.verified_at).slice(0, 10) : null) === (verified ? on : null)
    ) {
      row.action = "unchanged";
      continue;
    }
    if (live) await tx.query("update government_fees set retired_at = app_now() where id = $1", [live.id]);
    const created = (
      await tx.query<{ id: string }>(
        `insert into government_fees (code, emirate, free_zone, fee_fils, source_url, source_note, effective_from, confidence, verified_by, verified_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [code, emirate, zone, fee, sourceUrl, sourceNote, effectiveFrom, confidence, verified ? by : null, verified ? on : null],
      )
    ).rows[0]!;
    await audit(tx, actor, "fees.imported", "government_fee", created.id, {
      code,
      emirate,
      freeZone: zone,
      fee,
      effectiveFrom,
      confidence,
      verifiedBy: verified ? by : null,
      replaced: live ? live.id : null,
      source: source.split("/").pop(),
    });
    row.action = live ? "updated" : "created";
    row.reason = `AED ${(fee / 100).toFixed(2)} from ${effectiveFrom}, ${confidence}`;
  }
  return report;
}

/**
 * Import partner rate cards from a CSV export of the "Rate Cards" tab of the operating Google Sheet (or the go-live
 * workbook's "Rate card template" tab). Kept for the existing command; it runs the O10 rate-card importer:
 *
 *   pnpm import:sheet path/to/rate-cards.csv            # dry run: shows what would change, writes nothing
 *   pnpm import:sheet path/to/rate-cards.csv --apply    # writes, with an audit event per card
 *
 * Accepts the Sheet's real headers ("Professional fee (AED, excl. VAT)", "Government fee stated (AED)",
 * "Third-party costs (AED)", "Timeline (working days)") and the short ones. See `pnpm import` for the other kinds.
 */
import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, pendingMigrations } from "../lib/db.ts";
import { formatReport, runImport } from "../import/common.ts";
import { importRateCards } from "../import/rate-cards.ts";
import { readXlsx } from "../import/xlsx.ts";

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("Usage: import:sheet <rate-cards.csv | workbook.xlsx> [--apply]");
  process.exit(2);
}
const apply = flags.includes("--apply");
const grid: string[][] = /\.xlsx$/i.test(file)
  ? (readXlsx(await readFile(file), ["Rate card template"]).get("Rate card template") ?? [])
  : parse(await readFile(file, "utf8"), { relax_column_count: true, skip_empty_lines: false });

if (!process.env.DATABASE_URL && !(process.env.PGLITE_DIR && existsSync(join(process.env.PGLITE_DIR, "PG_VERSION")))) {
  console.error("Set DATABASE_URL, or PGLITE_DIR pointing at an existing development database, to say which database to import into.");
  process.exit(2);
}
const db = await openDatabase();
const pending = await pendingMigrations(db);
if (pending.length) {
  console.error(`The database is missing migrations (${pending.join(", ")}); start the server once so it migrates. The importer never changes the schema.`);
  await db.close();
  process.exit(2);
}
try {
  const report = await runImport(db, null, apply, (tx) => importRateCards(tx, grid, file));
  console.log(formatReport(report));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 2;
}
await db.close();

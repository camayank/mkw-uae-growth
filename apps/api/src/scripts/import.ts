/**
 * Go-live importers (O10). Dry run by default; `--apply` writes. Re-running changes nothing. Nobody is emailed.
 *
 *   pnpm import <kind> <file> [--apply] [--as founder@email] [--decisions Owner-Decisions.md] [--evidence dir]
 *   pnpm import all data/import [--apply] --as founder@email
 *
 * Kinds and files:
 *   partners     Tasees-Go-Live-Data.xlsx           Partners tab → partner prospects (no users unless Admin email is filled)
 *   rate-cards   rate-cards.csv or the .xlsx         Sheet export, or the workbook's "Rate card template" tab
 *   fees         Tasees-Go-Live-Data.xlsx           Government fees tab (verified only by the fee verifier in --decisions)
 *   holidays     Tasees-Go-Live-Data.xlsx           UAE holidays tab → the working-time calendar
 *   company      MKW-Company-Details.md              company fields through the founder's settings (needs --as)
 *   decisions    Owner-Decisions.md                  answers through Settings and Rules (needs --as when anything applies)
 *   legal        Tasees-Client-Terms.md, MKW-Partner-Network-Agreement.md   new version of a legal text
 *   all          a folder holding the five files above, in that order
 *
 * `--evidence dir` also writes a redacted copy of each report (no firm names or contact details) to dir/<kind>.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrate, openDatabase, type Database } from "../lib/db.ts";
import { sessionUserForEmail } from "../lib/auth.ts";
import type { SessionUser } from "../lib/context.ts";
import { formatReport, redactedMarkdown, runImport, type Report } from "../import/common.ts";
import { readXlsx } from "../import/xlsx.ts";
import { importPartners } from "../import/partners.ts";
import { importRateCards } from "../import/rate-cards.ts";
import { importFees } from "../import/fees.ts";
import { importHolidays } from "../import/holidays.ts";
import { feeVerifierFrom, importCompany, importDecisions, parseDecisions } from "../import/decisions.ts";
import { importLegal } from "../import/legal.ts";
import { parse } from "csv-parse/sync";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !["--as", "--decisions", "--evidence"].includes(args[i - 1] ?? ""));
const [kind, file] = positional;
const apply = args.includes("--apply");
const KINDS = ["partners", "rate-cards", "fees", "holidays", "company", "decisions", "legal", "all"];
if (!kind || !file || !KINDS.includes(kind)) {
  console.error(`Usage: import <${KINDS.join("|")}> <file or folder> [--apply] [--as founder@email] [--decisions Owner-Decisions.md] [--evidence dir]`);
  process.exit(2);
}

const db = await openDatabase();
await migrate(db);
const asEmail = flag("--as");
const actor: SessionUser | null = asEmail ? await sessionUserForEmail(db, asEmail) : null;
if (actor && actor.role !== "founder") {
  console.error(`${asEmail} is not a founder account`);
  process.exit(2);
}
const evidenceDir = flag("--evidence");
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function grid(path: string, tab: string): Promise<string[][]> {
  if (/\.csv$/i.test(path)) return parse(await readFile(path, "utf8"), { relax_column_count: true, skip_empty_lines: false });
  const sheet = readXlsx(await readFile(path)).get(tab);
  if (!sheet) throw new Error(`The workbook has no "${tab}" tab`);
  return sheet;
}

async function feeVerifier(decisionsPath: string | undefined): Promise<string | null> {
  if (!decisionsPath) return null;
  return feeVerifierFrom(parseDecisions(await readFile(decisionsPath, "utf8")));
}

async function one(db: Database, k: string, path: string, decisionsPath?: string): Promise<Report> {
  switch (k) {
    case "partners": {
      const book = readXlsx(await readFile(path));
      return runImport(db, actor, apply, (tx) => importPartners(tx, book, path, actor));
    }
    case "rate-cards": {
      const g = await grid(path, "Rate card template");
      return runImport(db, actor, apply, (tx) => importRateCards(tx, g, path, actor));
    }
    case "fees": {
      const book = readXlsx(await readFile(path));
      const verifier = await feeVerifier(decisionsPath);
      return runImport(db, actor, apply, (tx) => importFees(tx, book, path, verifier, actor));
    }
    case "holidays": {
      const book = readXlsx(await readFile(path));
      return runImport(db, actor, apply, (tx) => importHolidays(tx, book, path, actor));
    }
    case "company": {
      const md = await readFile(path, "utf8");
      return runImport(db, actor, apply, (tx) => importCompany(tx, md, path, actor));
    }
    case "decisions": {
      const md = await readFile(path, "utf8");
      return runImport(db, actor, apply, (tx) => importDecisions(tx, md, path, actor));
    }
    case "legal": {
      const md = await readFile(path, "utf8");
      return runImport(db, actor, apply, (tx) => importLegal(tx, md, path));
    }
  }
  throw new Error(`Unknown kind ${k}`);
}

const plan: Array<[string, string, string?]> =
  kind === "all"
    ? [
        ["legal", join(file, "Tasees-Client-Terms.md")],
        ["legal", join(file, "MKW-Partner-Network-Agreement.md")],
        ["partners", join(file, "Tasees-Go-Live-Data.xlsx")],
        ["holidays", join(file, "Tasees-Go-Live-Data.xlsx")],
        ["fees", join(file, "Tasees-Go-Live-Data.xlsx"), join(file, "Owner-Decisions.md")],
        ["rate-cards", join(file, "Tasees-Go-Live-Data.xlsx")],
        ["company", join(file, "MKW-Company-Details.md")],
        ["decisions", join(file, "Owner-Decisions.md")],
      ]
    : [[kind, file, flag("--decisions")]];

let failed = false;
for (const [k, path, decisions] of plan) {
  try {
    const report = await one(db, k, path, decisions);
    console.log(`\n== ${report.kind} from ${path}\n${formatReport(report)}`);
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      const name = report.kind.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "");
      await writeFile(join(evidenceDir, `${name}.md`), redactedMarkdown(report, stamp));
    }
  } catch (e) {
    failed = true;
    console.error(`\n== ${k} from ${path}: FAILED, nothing written for this file\n${(e as Error).message}`);
  }
}
await db.close();
process.exit(failed ? 1 : 0);

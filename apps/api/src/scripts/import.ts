/**
 * Go-live importers (O10). Dry run by default; `--apply` writes. Re-running changes nothing. Nobody is emailed.
 *
 *   pnpm import <kind> <file> [--apply] [--as founder@email] [--decisions Owner-Decisions.md] [--evidence dir]
 *   pnpm import all data/import [--apply] --as founder@email
 *
 * Kinds and files:
 *   partners     Tasees-Go-Live-Data.xlsx           Partners tab → partner prospects (no users unless Admin email is filled)
 *   rate-cards   rate-cards.csv or the .xlsx         Sheet export, or the workbook's "Rate card template" tab
 *   fees         Tasees-Go-Live-Data.xlsx           Government fees tab (verified only by the fee verifier in --decisions, with --as)
 *   holidays     Tasees-Go-Live-Data.xlsx           UAE holidays tab → the working-time calendar
 *   company      MKW-Company-Details.md              company fields through the founder's settings (needs --as)
 *   decisions    Owner-Decisions.md                  answers through Settings and Rules (needs --as when anything applies)
 *   legal        Tasees-Client-Terms.md, MKW-Partner-Network-Agreement.md   new version of a legal text
 *   all          a folder holding the five files above; every step runs in ONE transaction, in that order, so the
 *                dry run shows exactly what applying does (rate cards see the partners created just before)
 *
 * The target database must be named: DATABASE_URL, or PGLITE_DIR pointing at an existing development database. The
 * importer never migrates: a database with pending migrations is refused (start the server once to migrate it).
 * `--evidence dir` also writes a redacted copy of each report (no firm names or contact details) to dir/<kind>.md.
 * `--from-storage` reads the file (or, for `all`, the folder) from the configured storage bucket instead of local disk,
 * so on staging the go-live files stay in the private UAE bucket and never enter the container image:
 *   node dist/scripts/import.js all import/ --from-storage --as connect@mkwadvisors.com
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "csv-parse/sync";
import { openDatabase, pendingMigrations, type Queryable } from "../lib/db.ts";
import { sessionUserForEmail } from "../lib/auth.ts";
import type { SessionUser } from "../lib/context.ts";
import { storageFromEnv } from "../lib/storage.ts";
import { formatReport, redactedMarkdown, runImports, type Report } from "../import/common.ts";
import { readXlsx } from "../import/xlsx.ts";
import { importPartners } from "../import/partners.ts";
import { importRateCards } from "../import/rate-cards.ts";
import { importFees } from "../import/fees.ts";
import { importHolidays } from "../import/holidays.ts";
import { feeVerifierFrom, importCompany, importDecisions, parseDecisions } from "../import/decisions.ts";
import { importLegal } from "../import/legal.ts";
import { checkConfigOrExit } from "../lib/config.ts";

checkConfigOrExit();

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !["--as", "--decisions", "--evidence"].includes(args[i - 1] ?? ""));
const [kind, fileArg] = positional;
const apply = args.includes("--apply");
const KINDS = ["partners", "rate-cards", "fees", "holidays", "company", "decisions", "legal", "all"];
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};
if (!kind || !fileArg || !KINDS.includes(kind)) fail(`Usage: import <${KINDS.join("|")}> <file or folder> [--apply] [--as founder@email] [--decisions Owner-Decisions.md] [--evidence dir] [--from-storage]`);

// Name the target explicitly: an unset DATABASE_URL must not quietly create and report against an empty database.
if (!process.env.DATABASE_URL) {
  const dir = process.env.PGLITE_DIR;
  if (!dir) fail("Set DATABASE_URL (staging, production) or PGLITE_DIR (a development database) to say which database to import into.");
  if (!existsSync(join(dir!, "PG_VERSION"))) fail(`No database at PGLITE_DIR=${dir}. Seed or start the server once first.`);
}
const db = await openDatabase();
const pending = await pendingMigrations(db);
if (pending.length) {
  await db.close();
  fail(`The database is missing migrations (${pending.join(", ")}). Start the server once so it migrates, then import. The importer never changes the schema.`);
}
console.log(`Target: ${process.env.DATABASE_URL ? `Postgres at ${new URL(process.env.DATABASE_URL).host}` : `development database ${process.env.PGLITE_DIR}`} · ${apply ? "APPLY" : "dry run"}`);

const asEmail = flag("--as");
const actor: SessionUser | null = asEmail ? await sessionUserForEmail(db, asEmail) : null;
if (actor && actor.role !== "founder") fail(`${asEmail} is not a founder account`);
const evidenceDir = flag("--evidence");
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

const GO_LIVE_FILES = ["Tasees-Client-Terms.md", "MKW-Partner-Network-Agreement.md", "Tasees-Go-Live-Data.xlsx", "MKW-Company-Details.md", "Owner-Decisions.md"];
let file = fileArg!;
let decisionsPath = flag("--decisions");
let tempDir: string | null = null;
if (args.includes("--from-storage")) {
  // Copy the named objects to a private temporary folder for this run; it is deleted at the end.
  const { storage } = storageFromEnv();
  tempDir = await mkdtemp(join(tmpdir(), "tasees-import-"));
  const keys = kind === "all" ? GO_LIVE_FILES.map((n) => `${file.replace(/\/?$/, "/")}${n}`) : [file, ...(decisionsPath ? [decisionsPath] : [])];
  for (const key of keys) {
    try {
      await writeFile(join(tempDir, basename(key)), await storage.get(key));
    } catch (e) {
      console.error(`Could not read ${key} from storage: ${(e as Error).message}`);
    }
  }
  file = kind === "all" ? tempDir : join(tempDir, basename(file));
  if (decisionsPath) decisionsPath = join(tempDir, basename(decisionsPath));
}

type Step = (tx: Queryable) => Promise<Report>;

async function step(k: string, path: string, decisions?: string): Promise<Step> {
  switch (k) {
    case "partners": {
      const book = readXlsx(await readFile(path), ["Partners"]);
      return (tx) => importPartners(tx, book, path, actor);
    }
    case "rate-cards": {
      const grid = /\.csv$/i.test(path)
        ? (parse(await readFile(path, "utf8"), { relax_column_count: true, skip_empty_lines: false }) as string[][])
        : readXlsx(await readFile(path), ["Rate card template"]).get("Rate card template");
      if (!grid) throw new Error('The workbook has no "Rate card template" tab');
      return (tx) => importRateCards(tx, grid, path, actor);
    }
    case "fees": {
      const book = readXlsx(await readFile(path), ["Government fees"]);
      const verifier = decisions ? feeVerifierFrom(parseDecisions(await readFile(decisions, "utf8"))) : null;
      return (tx) => importFees(tx, book, path, verifier, actor);
    }
    case "holidays": {
      const book = readXlsx(await readFile(path), ["UAE holidays"]);
      return (tx) => importHolidays(tx, book, path, actor);
    }
    case "company": {
      const md = await readFile(path, "utf8");
      return (tx) => importCompany(tx, md, path, actor);
    }
    case "decisions": {
      const md = await readFile(path, "utf8");
      return (tx) => importDecisions(tx, md, path, actor);
    }
    case "legal": {
      const md = await readFile(path, "utf8");
      return (tx) => importLegal(tx, md, path);
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
    : [[kind!, file, decisionsPath]];

let exitCode = 0;
try {
  const steps: Step[] = [];
  for (const [k, path, decisions] of plan) steps.push(await step(k, path, decisions));
  const reports = await runImports(db, actor, apply, steps);
  for (const [i, report] of reports.entries()) {
    console.log(`\n== ${report.kind} from ${plan[i]![1]}\n${formatReport(report)}`);
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      const name = report.kind.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "");
      await writeFile(join(evidenceDir, `${name}.md`), redactedMarkdown(report, stamp));
    }
  }
} catch (e) {
  exitCode = 1;
  console.error(`\nFAILED, nothing written: ${(e as Error).message}`);
}
await db.close();
if (tempDir) await rm(tempDir, { recursive: true, force: true });
process.exit(exitCode);

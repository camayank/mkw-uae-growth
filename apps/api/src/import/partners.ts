import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { excelDate, type Workbook } from "./xlsx.ts";
import { isBlank, listCell, newReport, readTable, sameValue, type Report, type ReportRow } from "./common.ts";

/**
 * Partners tab → partner organisations as prospects (O10).
 *
 * - Matched on Partner ID (`profile.sourceId`), never on name, so a re-import updates the same firm.
 * - Created with status `prospect` and no users. A partner admin is added only when "Admin email" is filled, as
 *   `invite_pending`: that person cannot sign in until MKW moves the firm to pilot, which sends the invitation.
 * - Emirates and service codes are checked against the platform's lists; unknown values are reported, never guessed.
 * - `ftaTaxAgent` is never set here. A person confirms the firm on the FTA register and ticks it in the console.
 * - Once a firm has moved past `contacted`, MKW's console is the record: the row is skipped, not overwritten.
 * - Priority score and routing rank are not stored (they rank outreach, not delivery).
 */

export const EMIRATES = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"];
const EMIRATE_ALIASES: Record<string, string> = { rak: "Ras Al Khaimah", uaq: "Umm Al Quwain", "abu dhabi": "Abu Dhabi", ad: "Abu Dhabi", dxb: "Dubai", shj: "Sharjah" };

const SHEET_OWNED_STATUSES = ["prospect", "contacted"];

function emirate(v: string): string | null {
  const k = v.trim().toLowerCase();
  return EMIRATES.find((e) => e.toLowerCase() === k) ?? EMIRATE_ALIASES[k] ?? null;
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** The profile fields this importer owns. Anything else on the profile belongs to the console and is left alone. */
interface SheetFields {
  sourceId: string;
  segment: string;
  emirates: string[];
  codes: string[];
  freeZones: string[];
  contact: { email: string | null; phone: string | null; website: string | null };
  capacity: number;
  licenceNumber: string | null;
  licensingAuthority: string | null;
  declaredLicenceExpiry: string | null;
  approvedAuditorZones: string[];
  registeredLiquidator: boolean;
  ftaTaxAgentClaim: string | null;
  ftaAgentsListed: number | null;
  agreementSignedDeclared: string | null;
  importNotes: string | null;
}

const FIELD_KEYS: Array<keyof SheetFields> = [
  "sourceId",
  "segment",
  "emirates",
  "codes",
  "freeZones",
  "contact",
  "capacity",
  "licenceNumber",
  "licensingAuthority",
  "declaredLicenceExpiry",
  "approvedAuditorZones",
  "registeredLiquidator",
  "ftaTaxAgentClaim",
  "ftaAgentsListed",
  "agreementSignedDeclared",
  "importNotes",
];

export async function importPartners(tx: Queryable, book: Workbook, source: string, actor: SessionUser | null = null): Promise<Report> {
  const report = newReport("partners", source);
  const grid = book.get("Partners");
  if (!grid) throw new Error('The workbook has no "Partners" tab');
  const t = readTable(grid, ["Partner ID", "Firm", "Service codes (platform)"]);
  if (!t) throw new Error('No header row with "Partner ID", "Firm" and "Service codes (platform)" on the Partners tab');
  const C = {
    id: t.col("Partner ID"),
    firm: t.col("Firm"),
    segment: t.col("Segment"),
    emirates: t.col("Head office emirates", "Emirates"),
    codes: t.col("Service codes (platform)"),
    zones: t.col("Free zones served"),
    website: t.col("Website"),
    email: t.col("Business email"),
    phone: t.col("Business phone"),
    status: t.col("Status"),
    capacity: t.col("Capacity (jobs per month)", "Capacity"),
    fta: t.col("FTA tax agent (verify)", "FTA tax agent"),
    taan: t.col("FTA agents listed (TAAN count)"),
    auditor: t.col("Approved auditor zones"),
    liquidator: t.col("Registered liquidator"),
    licenceNumber: t.col("Trade licence number"),
    authority: t.col("Licensing authority"),
    expiry: t.col("Licence expiry"),
    adminName: t.col("Admin name (when signing)", "Admin name"),
    adminEmail: t.col("Admin email (when signing)", "Admin email"),
    signed: t.col("Agreement signed on"),
    notes: t.col("Notes"),
  };
  report.notes.push("Not stored: Priority score and Routing rank (outreach ranking), Codes from, Services as listed.");

  const known = new Set((await tx.query<{ code: string }>("select code from deliverables")).rows.map((r) => r.code));
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
  const seen = new Set<string>();

  for (const { line, cells } of t.rows) {
    const sourceId = cell(cells, C.id);
    const name = cell(cells, C.firm);
    const row: ReportRow = { line, ref: sourceId || "(no Partner ID)", label: name, action: "skipped", warnings: [] };
    report.rows.push(row);
    if (!sourceId) {
      row.reason = "no Partner ID";
      continue;
    }
    if (!name) {
      row.reason = "no firm name";
      continue;
    }
    if (seen.has(sourceId)) {
      row.reason = "Partner ID appears twice in the file; only the first row is used";
      continue;
    }
    seen.add(sourceId);
    const w = row.warnings!;

    // Emirates and codes: keep what the platform knows, report the rest.
    const emirates: string[] = [];
    for (const e of listCell(cell(cells, C.emirates))) {
      const m = emirate(e);
      if (m && !emirates.includes(m)) emirates.push(m);
      else if (!m) w.push(`unknown emirate "${e}" not imported`);
    }
    const codes: string[] = [];
    const unknown: string[] = [];
    for (const c of listCell(cell(cells, C.codes)).map((x) => x.toUpperCase())) {
      if (known.has(c)) {
        if (!codes.includes(c)) codes.push(c);
      } else if (!unknown.includes(c)) unknown.push(c);
    }
    if (unknown.length) w.push(`unknown service codes not imported: ${unknown.join(", ")}`);
    if (!codes.length) w.push("no known service codes");

    const rawEmail = cell(cells, C.email).toLowerCase();
    const email = rawEmail && EMAIL.test(rawEmail) ? rawEmail : null;
    if (rawEmail && !email) w.push("business email is not a valid address; not imported");
    const capRaw = cell(cells, C.capacity);
    let capacity = 10;
    if (capRaw) {
      const n = Number(capRaw);
      if (Number.isInteger(n) && n >= 1 && n <= 500) capacity = n;
      else w.push(`capacity "${capRaw}" is not a whole number from 1 to 500; 10 used`);
    } else w.push("no capacity; 10 used");
    const expiryRaw = cell(cells, C.expiry);
    const expiry = isBlank(expiryRaw) ? null : excelDate(expiryRaw);
    if (!isBlank(expiryRaw) && !expiry) w.push(`licence expiry "${expiryRaw}" is not a date; not imported`);
    const signedRaw = cell(cells, C.signed);
    const signedOn = isBlank(signedRaw) ? null : excelDate(signedRaw);
    const ftaRaw = cell(cells, C.fta);
    if (ftaRaw && !/^no$/i.test(ftaRaw)) w.push(`FTA tax agent "${ftaRaw}": stays off until a person confirms the firm on the FTA register and ticks it in the console`);
    const sheetStatus = cell(cells, C.status);
    if (sheetStatus && !/^prospect$/i.test(sheetStatus)) w.push(`status "${sheetStatus}" in the file; the firm is a prospect until MKW moves it in the console`);
    const taanRaw = cell(cells, C.taan);
    const taan = taanRaw && /^\d+$/.test(taanRaw) ? Number(taanRaw) : null;

    const fields: SheetFields = {
      sourceId,
      segment: cell(cells, C.segment),
      emirates,
      codes,
      freeZones: listCell(cell(cells, C.zones)).map((z) => z.replace(/…$/, "").trim()).filter(Boolean),
      contact: { email, phone: cell(cells, C.phone) || null, website: cell(cells, C.website) || null },
      capacity,
      licenceNumber: isBlank(cell(cells, C.licenceNumber)) ? null : cell(cells, C.licenceNumber),
      licensingAuthority: isBlank(cell(cells, C.authority)) ? null : cell(cells, C.authority),
      declaredLicenceExpiry: expiry,
      approvedAuditorZones: listCell(cell(cells, C.auditor)),
      registeredLiquidator: /^yes$/i.test(cell(cells, C.liquidator)),
      ftaTaxAgentClaim: ftaRaw || null,
      ftaAgentsListed: taan,
      agreementSignedDeclared: signedOn,
      importNotes: cell(cells, C.notes) || null,
    };

    const existing = (
      await tx.query<{ id: string; name: string; profile: Record<string, unknown> }>("select id, name, profile from orgs where type = 'partner' and profile->>'sourceId' = $1", [sourceId])
    ).rows[0];

    if (!existing) {
      const sameName = (await tx.query("select 1 from orgs where type = 'partner' and lower(name) = lower($1) and not (profile ? 'sourceId')", [name])).rows.length;
      if (sameName) {
        row.reason = "a partner with this name already exists on the platform without a Partner ID; link or rename it by hand (ask the owner)";
        continue;
      }
      const profile = { ...fields, status: "prospect", licenceActive: false, agreementSigned: false, ftaTaxAgent: false, quality: 60, changeOrderRate: 0, deliveredOnTime: 0 };
      const org = (await tx.query<{ id: string }>("insert into orgs (type, name, profile) values ('partner', $1, $2) returning id", [name, JSON.stringify(profile)])).rows[0]!;
      await audit(tx, actor, "partner.imported", "org", org.id, { sourceId, action: "created", source: source.split("/").pop(), codes: codes.length, emirates });
      row.action = "created";
      row.reason = `${codes.length} services, ${emirates.join(" + ") || "no emirate"}, capacity ${capacity}`;
      await addAdmin(tx, actor, org.id, cell(cells, C.adminEmail), cell(cells, C.adminName) || name, row);
      continue;
    }

    const status = String(existing.profile.status ?? "prospect");
    if (!SHEET_OWNED_STATUSES.includes(status)) {
      row.action = "unchanged";
      row.reason = `the firm is ${status}; MKW's console is the record now, so the file does not overwrite it`;
      continue;
    }
    const changed = FIELD_KEYS.filter((k) => !sameValue(existing.profile[k], fields[k]));
    const renamed = existing.name !== name;
    if (changed.length || renamed) {
      await tx.query("update orgs set name = $2, profile = profile || $3::jsonb where id = $1", [existing.id, name, JSON.stringify(fields)]);
      await audit(tx, actor, "partner.imported", "org", existing.id, { sourceId, action: "updated", source: source.split("/").pop(), changed: [...changed, ...(renamed ? ["name"] : [])] });
      row.action = "updated";
      row.reason = `changed: ${[...changed, ...(renamed ? ["name"] : [])].join(", ")}`;
    } else {
      row.action = "unchanged";
    }
    await addAdmin(tx, actor, existing.id, cell(cells, C.adminEmail), cell(cells, C.adminName) || name, row);
  }
  for (const r of report.rows) if (r.warnings && !r.warnings.length) delete r.warnings;
  return report;
}

/** Add the firm's admin as `invite_pending` (no sign-in, no email) when the file names one and nobody uses that address. */
async function addAdmin(tx: Queryable, actor: SessionUser | null, orgId: string, rawEmail: string, name: string, row: ReportRow) {
  const email = rawEmail.trim().toLowerCase();
  if (!email || isBlank(email)) return;
  if (!EMAIL.test(email)) {
    (row.warnings ??= []).push("admin email is not a valid address; no admin added");
    return;
  }
  const existing = (await tx.query<{ org_id: string; status: string }>("select org_id, status from users where email = $1", [email])).rows[0];
  if (existing) {
    if (existing.org_id !== orgId) (row.warnings ??= []).push("admin email already belongs to another account; no admin added");
    return;
  }
  const u = (await tx.query<{ id: string }>("insert into users (org_id, email, name, role, status) values ($1, $2, $3, 'partner_admin', 'invite_pending') returning id", [orgId, email, name.trim().slice(0, 200)])).rows[0]!;
  await audit(tx, actor, "user.added_pending_invite", "user", u.id, { orgId, role: "partner_admin", invitedWhen: "MKW moves the firm to pilot" });
  (row.warnings ??= []).push("admin added, invitation held until MKW moves the firm to pilot");
  if (row.action === "unchanged") {
    row.action = "updated";
    row.reason = "admin added";
  }
}

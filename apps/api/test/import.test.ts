import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionUserForEmail } from "../src/lib/auth.ts";
import type { SessionUser } from "../src/lib/context.ts";
import { counts, formatReport, redactedMarkdown, runImport, type Report } from "../src/import/common.ts";
import { importPartners } from "../src/import/partners.ts";
import { importRateCards } from "../src/import/rate-cards.ts";
import { importFees } from "../src/import/fees.ts";
import { importHolidays } from "../src/import/holidays.ts";
import { feeVerifierFrom, importCompany, importDecisions, parseDecisions } from "../src/import/decisions.ts";
import { importLegal } from "../src/import/legal.ts";
import { excelDate, readXlsx } from "../src/import/xlsx.ts";
import { loadCalendar } from "../src/services/calendar.ts";
import { asPlatform } from "../src/lib/context.ts";
import { withClock } from "../src/lib/db.ts";
import { addWorkingDays } from "@tasees/core";
import { DEMO } from "../src/db/seed-data.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";
import { makeXlsx, makeXlsxRaw } from "./xlsx-fixture.ts";
import { consoleTransport } from "../src/lib/notify.ts";
import { nameAnswer } from "../src/import/decisions.ts";
import { runImports } from "../src/import/common.ts";

/** O10: go-live importers. Dry run writes nothing, apply writes, a second apply changes nothing, nobody is notified. */

const PARTNER_HEADER = [
  "Partner ID", "Firm", "Segment", "Head office emirates", "Service codes (platform)", "Codes from", "Services as listed", "Free zones served", "Website",
  "Business email", "Business phone", "Status", "Capacity (jobs per month)", "Priority score", "Routing rank", "FTA tax agent (verify)",
  "FTA agents listed (TAAN count)", "Approved auditor zones", "Registered liquidator", "Trade licence number", "Licensing authority", "Licence expiry",
  "Admin name (when signing)", "Admin email (when signing)", "Agreement signed on", "Notes",
];
type Cell = string | number | null;
const partnerRow = (o: Record<string, Cell>): Cell[] => PARTNER_HEADER.map((h) => o[h] ?? null);

function partnersBook(capacityAlpha: number | string = 15) {
  return makeXlsx({
    Partners: [
      ["One row per firm to create on the platform as a prospect."],
      PARTNER_HEADER,
      partnerRow({ "Partner ID": "GB9001", Firm: "Alpha Setup FZ LLC", Segment: "Setup", "Head office emirates": "Dubai; RAK", "Service codes (platform)": "SET-FZ-LIC; VISA-RES; FOO-BAR", "Free zones served": "IFZA, DMCC", Website: "alpha.test", "Business email": "info@alpha.test", "Business phone": "+971 4 000 0001", Status: "Prospect", "Capacity (jobs per month)": capacityAlpha, "Priority score": 86, "Routing rank": 86, "FTA tax agent (verify)": "Likely: check the FTA register", "Approved auditor zones": "None", "Registered liquidator": "None", "Trade licence number": "None" }),
      partnerRow({ "Partner ID": "GB9002", Firm: "Beta Tax LLC", Segment: "Tax agency", "Head office emirates": "Abu Dhabi; Narnia", "Service codes (platform)": "VAT-RET; CT-RET; TAX-AGENT", "Business email": "hello@beta.test", Status: "Prospect", "Capacity (jobs per month)": 20, "FTA tax agent (verify)": "Yes", "Registered liquidator": "Yes", "Licence expiry": 46418, "Admin name (when signing)": "Beta Admin", "Admin email (when signing)": "Admin@Beta.test", Notes: "Called once" }),
      partnerRow({ "Partner ID": "GB9001", Firm: "Alpha again", "Service codes (platform)": "SET-FZ-LIC" }),
      partnerRow({ Firm: "No ID Firm", "Service codes (platform)": "SET-FZ-LIC" }),
      partnerRow({ "Partner ID": "GB9003", Firm: DEMO.partners[0].name, "Service codes (platform)": "SET-FZ-LIC" }),
    ],
  });
}

const q = <T extends Record<string, any> = Record<string, any>>(env: TestEnv, sql: string, params: unknown[] = []) => asPlatform(env.db, null, (tx) => tx.query<T>(sql, params));
const count = async (env: TestEnv, sql: string, params: unknown[] = []) => Number((await q<{ n: string }>(env, sql, params)).rows[0]!.n);
const audits = (env: TestEnv) => count(env, "select count(*) as n from audit_events");
const notifications = (env: TestEnv) => count(env, "select count(*) as n from notifications");

describe("go-live importers", () => {
  let env: TestEnv;
  let founder: SessionUser;
  let notificationsAtStart: number;
  beforeAll(async () => {
    env = await makeEnv();
    founder = await sessionUserForEmail(env.db, EMAILS.founder);
    notificationsAtStart = await notifications(env);
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("reads a workbook: inline strings, numbers and date serials", () => {
    const book = readXlsx(partnersBook());
    const grid = book.get("Partners")!;
    expect(grid[1]![0]).toBe("Partner ID");
    expect(grid[2]![1]).toBe("Alpha Setup FZ LLC");
    expect(excelDate("46418")).toBe("2027-01-31");
    expect(excelDate("2026-12-02")).toBe("2026-12-02");
    expect(excelDate("31/01/2027")).toBe("2027-01-31");
    expect(excelDate("soon")).toBeNull();
    expect(() => readXlsx(Buffer.from("not a zip at all, just text"))).toThrow(/not an .xlsx/i);
    expect(excelDate("13/13/2027")).toBeNull();
    expect(excelDate("2027-02-30")).toBeNull();
    expect(excelDate("5")).toBeNull(); // not a plausible date serial
    expect([...readXlsx(partnersBook(), ["Nope"]).keys()]).toEqual([]);
  });

  it("refuses hostile workbooks quickly instead of hanging", () => {
    const raw = (sheetXml: string) => {
      const book = makeXlsx({ S: [["x"]] });
      // Rebuild with a hand-written sheet part.
      return makeXlsxRaw(book, sheetXml);
    };
    const t0 = Date.now();
    expect(() => readXlsx(raw('<worksheet><sheetData><row r="300000000"><c r="A300000000" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>'))).toThrow(/row beyond/);
    expect(() => readXlsx(raw('<worksheet><sheetData><row r="1"><c r="AAAAAA1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>'))).toThrow(/column beyond/);
    expect(() => readXlsx(raw(`<worksheet><sheetData>${"<row>".repeat(20_000)}</sheetData></worksheet>`))).toThrow(/never closed/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  describe("partners", () => {
    const run = (apply: boolean, cap: number | string = 15) => {
      const book = readXlsx(partnersBook(cap));
      return runImport(env.db, null, apply, (tx) => importPartners(tx, book, "/data/import/Tasees-Go-Live-Data.xlsx"));
    };

    it("dry run reports every row and writes nothing", async () => {
      const a = await audits(env);
      const orgs = await count(env, "select count(*) as n from orgs");
      const r = await run(false);
      expect(r.applied).toBe(false);
      expect(counts(r)).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: 3 });
      const byLine = Object.fromEntries(r.rows.map((x) => [x.line, x]));
      expect(byLine[5]!.reason).toMatch(/twice/);
      expect(byLine[6]!.reason).toMatch(/no Partner ID/);
      expect(byLine[7]!.reason).toMatch(/already exists on the platform without a Partner ID/);
      expect(byLine[3]!.warnings!.join(" ")).toMatch(/unknown service codes not imported: FOO-BAR/);
      expect(byLine[4]!.warnings!.join(" ")).toMatch(/unknown emirate "Narnia"/);
      expect(byLine[4]!.warnings!.join(" ")).toMatch(/FTA tax agent "Yes": stays off/);
      expect(await audits(env)).toBe(a);
      expect(await count(env, "select count(*) as n from orgs")).toBe(orgs);
      expect(await count(env, "select count(*) as n from users where email = 'admin@beta.test'")).toBe(0);
    });

    it("apply creates prospects with no sign-in, one audit event per record, and no notification", async () => {
      const a = await audits(env);
      const r = await run(true);
      expect(counts(r)).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: 3 });
      const alpha = (await q<{ name: string; profile: any }>(env, "select name, profile from orgs where profile->>'sourceId' = 'GB9001'")).rows[0]!;
      expect(alpha.name).toBe("Alpha Setup FZ LLC");
      expect(alpha.profile).toMatchObject({ status: "prospect", ftaTaxAgent: false, licenceActive: false, agreementSigned: false, codes: ["SET-FZ-LIC", "VISA-RES"], emirates: ["Dubai", "Ras Al Khaimah"], capacity: 15, freeZones: ["IFZA", "DMCC"] });
      expect(alpha.profile.contact).toEqual({ email: "info@alpha.test", phone: "+971 4 000 0001", website: "alpha.test" });
      expect(alpha.profile.priorityScore).toBeUndefined();
      const beta = (await q<{ id: string; profile: any }>(env, "select id, profile from orgs where profile->>'sourceId' = 'GB9002'")).rows[0]!;
      expect(beta.profile).toMatchObject({ ftaTaxAgent: false, registeredLiquidator: true, declaredLicenceExpiry: "2027-01-31", emirates: ["Abu Dhabi"], codes: ["VAT-RET", "CT-RET", "TAX-AGENT"] });
      expect(beta.profile.licenceExpiry).toBeUndefined(); // the licence watch runs only on a verified document
      const admin = (await q<{ status: string; role: string; org_id: string }>(env, "select status, role, org_id from users where email = 'admin@beta.test'")).rows[0]!;
      expect(admin).toEqual({ status: "invite_pending", role: "partner_admin", org_id: beta.id });
      expect(await audits(env)).toBe(a + 3); // two firms and one held admin
      // The held admin cannot get a sign-in code.
      await env.call("anon", "POST", "/api/auth/request-code", { email: "admin@beta.test" });
      expect(await count(env, "select count(*) as n from login_codes where email = 'admin@beta.test'")).toBe(0);
      expect(await notifications(env)).toBe(notificationsAtStart);
      expect(env.emails.filter((m) => /alpha|beta/i.test(m.to))).toHaveLength(0);
    });

    it("a second apply changes nothing; a changed cell updates only that firm", async () => {
      const a = await audits(env);
      const again = await run(true);
      expect(counts(again)).toEqual({ created: 0, updated: 0, unchanged: 2, skipped: 3 });
      expect(await audits(env)).toBe(a);
      const changed = await run(true, 25);
      expect(counts(changed)).toEqual({ created: 0, updated: 1, unchanged: 1, skipped: 3 });
      expect(changed.rows.find((x) => x.ref === "GB9001")!.reason).toBe("changed: capacity");
      expect(await audits(env)).toBe(a + 1);
      expect(await notifications(env)).toBe(notificationsAtStart);
    });

    it("keeps what MKW changed in the console when the file is imported again", async () => {
      const alpha = (await q<{ id: string }>(env, "select id from orgs where profile->>'sourceId' = 'GB9001'")).rows[0]!;
      expect((await env.call("ops", "PUT", `/api/ops/partners/${alpha.id}`, { capacity: 40, codes: ["SET-FZ-LIC"] })).status).toBe(200);
      const r = await run(true, 30); // the file changes capacity again
      const row = r.rows.find((x) => x.ref === "GB9001")!;
      expect(row.action).toBe("unchanged");
      expect(row.warnings!.join(" ")).toMatch(/kept MKW's changes to codes, capacity/);
      const p = (await q<{ profile: any }>(env, "select profile from orgs where id = $1", [alpha.id])).rows[0]!.profile;
      expect([p.capacity, p.codes]).toEqual([40, ["SET-FZ-LIC"]]);
    });

    it("leaves a firm alone once MKW has moved it past contacted", async () => {
      const beta = (await q<{ id: string }>(env, "select id from orgs where profile->>'sourceId' = 'GB9002'")).rows[0]!;
      expect((await env.call("ops", "POST", `/api/ops/partners/${beta.id}/status`, { status: "applied", note: "Sent the form" })).status).toBe(200);
      await q(env, "update orgs set profile = profile || '{\"ftaTaxAgent\": true}'::jsonb where id = $1", [beta.id]); // a person confirmed the FTA register
      const r = await run(true);
      const row = r.rows.find((x) => x.ref === "GB9002")!;
      expect(row.action).toBe("unchanged");
      expect(row.reason).toMatch(/applied; MKW's console is the record/);
      const p = (await q<{ profile: any }>(env, "select profile from orgs where id = $1", [beta.id])).rows[0]!.profile;
      expect(p.ftaTaxAgent).toBe(true);
    });

    it("the console cannot set a status directly, only through the gated move", async () => {
      const alpha = (await q<{ id: string }>(env, "select id from orgs where profile->>'sourceId' = 'GB9001'")).rows[0]!;
      expect((await env.call("ops", "PUT", `/api/ops/partners/${alpha.id}`, { status: "pilot" })).status).toBe(400);
    });

    it("the evidence copy carries no firm names or contact details", async () => {
      const r = await run(false);
      const md = redactedMarkdown(r, "test");
      expect(md).not.toMatch(/Alpha Setup|Beta Tax|@|\+971|alpha\.test/);
      expect(md).toMatch(/GB9001/);
      expect(formatReport(r)).toMatch(/Alpha Setup FZ LLC/); // the console report keeps names for MKW
    });
  });

  describe("rate cards", () => {
    const REAL = ["Card ID", "Partner ID", "Partner", "Code", "Deliverable", "Professional fee (AED, excl. VAT)", "Government fee stated (AED)", "Third-party costs (AED)", "Timeline (working days)", "Exclusions (one per line or ; )", "Valid to", "Status"];
    const grid = (fee = "4,500"): string[][] => [
      ["One row per firm per service it prices."],
      REAL,
      ["RC-0001", "GB0001", "Example Partner", "SET-FZ-LIC", "Free zone licence", "", "", "", "", "", "46418", "Example"],
      ["RC-0002", "GB9001", "Alpha Setup FZ LLC", "VISA-RES", "Residence visa", "", "", "", "", "", "46418", "Draft"],
      ["RC-0003", "GB9001", "Alpha Setup FZ LLC", "SET-FZ-LIC", "Free zone licence", fee, "2500", "", "7", "Office lease; Visa medicals", "46418", "Active"],
      ["RC-0004", "GB7777", "Nobody LLC", "SET-FZ-LIC", "", "1000", "", "", "5", "", "46418", "Active"],
      ["RC-0005", "GB9001", "Alpha Setup FZ LLC", "NOPE-1", "", "1000", "", "", "5", "", "46418", "Active"],
      ["RC-0006", "GB9001", "Alpha Setup FZ LLC", "VISA-FAM", "", "", "", "", "5", "", "46418", "Active"],
      ["RC-0007", "", DEMO.partners[0].name, "SET-ML-LIC", "", "6000.50", "", "150", "10", "", "2027-03-31", "Active"],
    ];
    const run = (g: string[][], apply: boolean) => runImport(env.db, null, apply, (tx) => importRateCards(tx, g, "rate-cards.csv"));

    it("accepts the Sheet's real header row and lists every skipped row with its reason", async () => {
      const r = await run(grid(), false);
      // The demo partner already prices SET-ML-LIC, so that row updates its card.
      expect(counts(r)).toEqual({ created: 1, updated: 1, unchanged: 0, skipped: 5 });
      const reasons = r.rows.filter((x) => x.action === "skipped").map((x) => x.reason);
      expect(reasons).toEqual([
        "example row",
        "status Draft and no professional fee: mark it Active once the firm has confirmed the price",
        "partner GB7777 is not on the platform yet",
        'unknown service code "NOPE-1"',
        "no professional fee",
      ]);
    });

    it("writes integer fils, matches by Partner ID or name, and is idempotent", async () => {
      const a = await audits(env);
      await run(grid(), true);
      const card = (await q<Record<string, unknown>>(env, "select r.professional_fils, r.gov_stated_fils, r.working_days, r.exclusions, r.valid_to::text as valid_to from rate_cards r join orgs o on o.id = r.partner_org_id where o.profile->>'sourceId' = 'GB9001' and r.code = 'SET-FZ-LIC'")).rows[0]!;
      expect(card).toEqual({ professional_fils: 450000, gov_stated_fils: 250000, working_days: 7, exclusions: ["Office lease", "Visa medicals"], valid_to: "2027-01-31" });
      const byName = (await q<{ professional_fils: number; third_party_fils: number }>(env, "select r.professional_fils, r.third_party_fils from rate_cards r join orgs o on o.id = r.partner_org_id where o.name = $1 and r.code = 'SET-ML-LIC'", [DEMO.partners[0].name])).rows[0]!;
      expect(Number(byName.professional_fils)).toBe(600050);
      expect(Number(byName.third_party_fils)).toBe(15000);
      expect(await audits(env)).toBe(a + 2);
      expect(counts(await run(grid(), true))).toEqual({ created: 0, updated: 0, unchanged: 2, skipped: 5 });
      expect(await audits(env)).toBe(a + 2);
      const changed = await run(grid("4,750"), true);
      expect(changed.rows.find((x) => x.ref.startsWith("RC-0003"))!.action).toBe("updated");
      expect(await audits(env)).toBe(a + 3);
      expect(await notifications(env)).toBe(notificationsAtStart);
    });

    it("does not overwrite a card the partner changed in the portal since the last import", async () => {
      expect((await env.call("setup", "PUT", "/api/partner/rate-cards", { cards: [{ code: "SET-ML-LIC", professionalAed: 7000, workingDays: 10 }] })).status).toBe(200);
      const r = await run(grid("4,750"), true);
      expect(r.rows.find((x) => x.ref.startsWith("RC-0003"))!.action).toBe("unchanged");
      expect(r.rows.find((x) => x.ref.startsWith("RC-0007"))).toMatchObject({ action: "unchanged", reason: "changed on the platform since the last import; the file does not overwrite it" });
      const fils = (await q<{ professional_fils: number }>(env, "select r.professional_fils from rate_cards r join orgs o on o.id = r.partner_org_id where o.name = $1 and r.code = 'SET-ML-LIC'", [DEMO.partners[0].name])).rows[0]!;
      expect(Number(fils.professional_fils)).toBe(700000);
      // An unknown Partner ID is never matched by the firm's name instead.
      const wrongId = [["Card ID", "Partner ID", "Partner", "Code", "Professional fee", "Timeline", "Valid to"], ["RC-9", "GB7777", "Alpha Setup FZ LLC", "SET-OFF", "1000", "3", "2027-01-31"]];
      expect((await run(wrongId, false)).rows[0]!.reason).toBe("partner GB7777 is not on the platform yet");
    });

    it("accepts the short headers of older exports too", async () => {
      const short = [["Card ID", "Partner ID", "Partner", "Code", "Professional fee", "Govt fee stated", "Third-party", "Timeline", "Exclusions", "Valid to"], ["RC-1", "GB9001", "", "SET-FZ-LIC", "4750", "2500", "", "7", "Office lease; Visa medicals", "2027-01-31"]];
      expect(counts(await run(short, false))).toEqual({ created: 0, updated: 0, unchanged: 1, skipped: 0 });
    });
  });

  describe("government fees", () => {
    const book = (by = "Aisha Verifier", extra: Cell[][] = []) =>
      readXlsx(
        makeXlsx({
          "Government fees": [
            ["Fees the platform charges at cost."],
            ["Code", "Service", "Emirate", "Free zone (blank = whole emirate)", "Fee (AED)", "Source URL (official page)", "Source note", "Effective from", "Confidence", "Verified by", "Verified on"],
            ["SET-FZ-LIC", "Free zone licence", "Dubai", "IFZA", null, null, null, null, "UNCERTAIN", null, null],
            ["SET-FZ-LIC", "Free zone licence", "Dubai", "DMCC", "12,000", "https://dmcc.example/fees", "Fee schedule 2026", "2026-10-01", "UNCERTAIN", by, "2026-10-15"],
            ["SET-ML-LIC", "Mainland licence", "Sharjah", null, "9000", "https://sedd.example/fees", "", "2026-10-01", "UNCERTAIN", null, null],
            ["NOPE-1", "?", "Dubai", null, "100", "", "", "", "", "", ""],
            ...extra,
          ],
        }),
      );
    const run = (verifier: string | null, by?: string, who: SessionUser | null = founder, db = env.db, extra: Cell[][] = []) => runImport(db, who, true, (tx) => importFees(tx, book(by, extra), "go-live.xlsx", verifier, who));
    const live = (zone: string | null) =>
      q<{ id: string; fee_fils: number; confidence: string; verified_by: string | null }>(env, "select id, fee_fils, confidence, verified_by from government_fees where retired_at is null and free_zone is not distinct from $1 and source_url like '%.example/%'", [zone]);

    it("skips rows without a fee, and records a verification only for the named verifier, a date, a source and the founder", async () => {
      const dry = await runImport(env.db, null, false, (tx) => importFees(tx, book(), "go-live.xlsx", "Aisha Verifier", null));
      expect(counts(dry)).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: 2 });
      expect(dry.rows[0]!.reason).toBe("no fee yet");
      expect(dry.rows[3]!.reason).toMatch(/unknown service code/);
      expect(dry.rows[1]!.reason).toMatch(/UNCERTAIN/);
      expect(dry.rows[1]!.warnings![0]).toMatch(/only when the founder runs the import/);
      const r = await run("Aisha Verifier");
      expect(r.rows[1]!.reason).toMatch(/verified/);
      expect((await live("DMCC")).rows.map((x) => [Number(x.fee_fils), x.confidence, x.verified_by])).toEqual([[1_200_000, "verified", "Aisha Verifier"]]);
      expect((await live(null)).rows.map((x) => [Number(x.fee_fils), x.confidence])).toEqual([[900_000, "UNCERTAIN"]]);
      const ev = (await q<{ actor_user_id: string }>(env, "select actor_user_id from audit_events where action = 'fees.imported' and data->>'confidence' = 'verified'")).rows;
      expect(ev.length).toBe(1);
      expect(ev[0]!.actor_user_id).toBe(founder.id);
    });

    it("is idempotent; a verified row is kept when the file no longer says who verified it", async () => {
      const a = await audits(env);
      expect(counts(await run("Aisha Verifier"))).toEqual({ created: 0, updated: 0, unchanged: 2, skipped: 2 });
      expect(await audits(env)).toBe(a);
      const other = await run("Aisha Verifier", "Somebody Else");
      expect(other.rows[1]).toMatchObject({ action: "unchanged", reason: "verified on the platform; kept as it is" });
      expect(other.rows[1]!.warnings![0]).toMatch(/someone other than the named fee verifier/);
      expect((await live("DMCC")).rows[0]!.confidence).toBe("verified");
      expect(await audits(env)).toBe(a);
    });

    it("never undoes the console: a fee verified there stays verified, a retired fee stays retired", async () => {
      const sharjah = (await live(null)).rows[0]!;
      expect((await env.call("founder", "POST", `/api/admin/fees/${sharjah.id}/verify`, { verifiedBy: "Aisha Verifier" })).status).toBe(200);
      const r = await run(null);
      expect(r.rows[2]).toMatchObject({ action: "unchanged", reason: "verified on the platform; kept as it is" });
      expect((await live(null)).rows[0]!.confidence).toBe("verified");
      expect((await env.call("ops", "POST", `/api/admin/fees/${sharjah.id}/retire`, { reason: "Wrong authority" })).status).toBe(200);
      const again = await run(null);
      expect(again.rows[2]).toMatchObject({ action: "skipped", reason: "retired on the platform; the file does not bring it back" });
      expect((await live(null)).rows).toHaveLength(0);
    });

    it("a fee with no effective date is the same row tomorrow", async () => {
      const offshore: Cell[][] = [["SET-OFF", "Offshore", "Ras Al Khaimah", "RAK ICC", "1500", "https://rakicc.example/fees", "", null, "UNCERTAIN", null, null]];
      expect((await run(null, undefined, founder, env.db, offshore)).rows[4]!.action).toBe("created");
      const a = await audits(env);
      const tomorrow = withClock(env.db, () => new Date(Date.now() + 86_400_000));
      const next = await run(null, undefined, founder, tomorrow, offshore);
      expect(next.rows[4]!.action).toBe("unchanged");
      expect(await audits(env)).toBe(a);
      expect((await live("RAK ICC")).rows).toHaveLength(1);
    });
  });

  describe("holidays", () => {
    const book = (status = "Expected") =>
      readXlsx(
        makeXlsx({
          "UAE holidays": [
            ["For the platform's working-time clock."],
            ["Date", "Holiday", "Status", "Note"],
            ["2026-12-02", "Eid Al Etihad (National Day)", status, "Confirm when announced"],
            ["2026-12-03", "Eid Al Etihad (National Day)", "Expected", ""],
            ["2027-03-09", "Eid Al Fitr", "Maybe", "Moon sighting"],
            ["someday", "Unknown", "Expected", ""],
          ],
        }),
      );

    it("loads dates with their status, and the working-time clock skips them", async () => {
      const before = await asPlatform(env.db, null, (tx) => loadCalendar(tx));
      const r = await runImport(env.db, null, true, (tx) => importHolidays(tx, book(), "go-live.xlsx"));
      expect(counts(r)).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: 2 });
      const cal = await asPlatform(env.db, null, (tx) => loadCalendar(tx));
      expect(cal.holidays).toEqual(["2026-12-02", "2026-12-03"]);
      // Tuesday 1 Dec 2026, 10:00 GST + 1 working day: Friday 4 Dec with the holidays, Wednesday 2 Dec without.
      const start = new Date("2026-12-01T06:00:00Z");
      expect(addWorkingDays(start, 1, before).toISOString().slice(0, 10)).toBe("2026-12-02");
      expect(addWorkingDays(start, 1, cal).toISOString().slice(0, 10)).toBe("2026-12-04");
      const list = (await env.call("ops", "GET", "/api/admin/holidays")).body;
      expect(list[0]).toMatchObject({ date: "2026-12-02", status: "expected" });
    });

    it("is idempotent; a confirmed date is an update", async () => {
      const a = await audits(env);
      expect(counts(await runImport(env.db, null, true, (tx) => importHolidays(tx, book(), "go-live.xlsx")))).toEqual({ created: 0, updated: 0, unchanged: 2, skipped: 2 });
      expect(await audits(env)).toBe(a);
      const c = await runImport(env.db, null, true, (tx) => importHolidays(tx, book("Confirmed"), "go-live.xlsx"));
      expect(c.rows[0]!.action).toBe("updated");
      expect(await audits(env)).toBe(a + 1);
    });

    it("keeps the founder's calendar: no downgrade, no comeback for a removed date", async () => {
      const back = await runImport(env.db, null, true, (tx) => importHolidays(tx, book("Expected"), "go-live.xlsx"));
      expect(back.rows[0]).toMatchObject({ action: "unchanged", reason: "changed on Settings; the founder's version stands" });
      expect((await env.call("founder", "DELETE", "/api/admin/holidays/2026-12-03", { reason: "Not a holiday this year" })).status).toBe(200);
      const again = await runImport(env.db, null, true, (tx) => importHolidays(tx, book("Expected"), "go-live.xlsx"));
      expect(again.rows[1]).toMatchObject({ action: "skipped", reason: "removed on Settings; the file does not bring it back" });
      expect((await asPlatform(env.db, null, (tx) => loadCalendar(tx))).holidays).toEqual(["2026-12-02"]);
      expect((await env.call("founder", "PUT", "/api/admin/holidays", { date: "2027-02-30", name: "Impossible", status: "expected", reason: "test" })).status).toBe(400);
    });
  });

  describe("owner decisions and company details", () => {
    const decisions = (row1: string, row3: string, row12: string) => `# Owner decisions

| # | Decision | Suggestion | Your answer |
| --- | --- | --- | --- |
| 1 | Margin rates and floors per category | Keep the Sheet's values | ${row1} |
| 2 | Fairness cap and quality bar | 35% | |
| 3 | Client deposit | 50% of fees | ${row3} |
| 12 | Named fee verifier (government fees, monthly) | Name: | ${row12} |
`;

    it("a blank answer changes nothing", async () => {
      const a = await audits(env);
      const r = await runImport(env.db, null, true, (tx) => importDecisions(tx, decisions("", "", ""), "Owner-Decisions.md", null));
      expect(counts(r)).toEqual({ created: 0, updated: 0, unchanged: 4, skipped: 0 });
      expect(r.rows[0]!.reason).toMatch(/no answer/);
      expect(await audits(env)).toBe(a);
    });

    it("Agree schedules the suggested rules from tomorrow as the founder; other answers are reported, not guessed", async () => {
      // Start from an Accounting rule that differs from the suggestion; the others already match it.
      await q(env, "update margin_rule_versions set rate_bp = 3000 where category = 'Accounting'");
      const md = decisions("Agree", "60%", "Name: Aisha Verifier");
      expect(feeVerifierFrom(parseDecisions(md))).toBe("Aisha Verifier");
      await expect(runImport(env.db, null, true, (tx) => importDecisions(tx, md, "Owner-Decisions.md", null))).rejects.toThrow(/--as/);
      const r = await runImport(env.db, founder, true, (tx) => importDecisions(tx, md, "Owner-Decisions.md", founder));
      expect(r.rows[0]!.action).toBe("updated");
      const tomorrow = (await q<{ d: string }>(env, "select (app_now()::date + 1)::text as d")).rows[0]!.d;
      expect(r.rows[0]!.reason).toBe(`rules scheduled from ${tomorrow} for Accounting; offers already built keep their rules`);
      expect(r.rows[2]!.action).toBe("skipped");
      expect(r.rows[2]!.reason).toMatch(/code change \(for the owner\)/);
      expect(r.rows[3]!.reason).toBe("fee verifier recorded");
      const acc = (await q<{ rate_bp: number; floor_fils: number; effective_from: string }>(env, "select rate_bp, floor_fils, effective_from::text as effective_from from margin_rule_versions where category = 'Accounting' order by effective_from desc limit 1")).rows[0]!;
      expect([Number(acc.rate_bp), Number(acc.floor_fils), acc.effective_from]).toEqual([2500, 15000, tomorrow]);
      const ev = (await q<{ actor_user_id: string; n: string }>(env, "select actor_user_id, count(*) as n from audit_events where action = 'rules.margin_scheduled' group by actor_user_id")).rows;
      expect(ev.every((e) => e.actor_user_id === founder.id)).toBe(true);
      const a = await audits(env);
      const again = await runImport(env.db, founder, true, (tx) => importDecisions(tx, md, "Owner-Decisions.md", founder));
      expect(again.rows[0]!.reason).toBe("the rules already match the suggestion");
      expect(again.rows[3]!.reason).toBe("already recorded");
      expect(await audits(env)).toBe(a);
    });

    it("company details go through the founder's settings; bank numbers and bad TRNs are refused", async () => {
      const md = `| Field | Value |
| --- | --- |
| Legal name (as on the trade licence) | MKW Advisors FZ-LLC |
| VAT TRN (15 digits; blank if not yet registered) | 12345 |
| IBAN | AE07 0331 2345 6789 0123 456 |
| Client sender email | tasees@mkwadvisors.com |
| Bank name (account details go on Settings, not here) | |
`;
      const r = await runImport(env.db, founder, true, (tx) => importCompany(tx, md, "MKW-Company-Details.md", founder));
      expect(r.rows.map((x) => x.action)).toEqual(["updated", "skipped", "skipped", "skipped", "unchanged"]);
      expect(r.rows[1]!.reason).toMatch(/15 digits/);
      expect(r.rows[2]!.reason).toMatch(/never imported/);
      expect(r.rows[3]!.reason).toMatch(/EMAIL_FROM_CLIENT/);
      const company = (await q<{ value: any }>(env, "select value from settings where key = 'company'")).rows[0]!.value;
      expect(company.legalName).toBe("MKW Advisors FZ-LLC");
      expect(company.iban).toBe("");
      const again = await runImport(env.db, founder, true, (tx) => importCompany(tx, md, "MKW-Company-Details.md", founder));
      expect(again.rows[0]!.reason).toBe("already set");
    });
  });

  describe("several importers at once", () => {
    it("run in one transaction: the dry run's rate cards see the partners created just before, and nothing stays", async () => {
      const book = readXlsx(makeXlsx({ Partners: [PARTNER_HEADER, partnerRow({ "Partner ID": "GB9100", Firm: "Gamma Visas LLC", "Service codes (platform)": "VISA-RES", "Capacity (jobs per month)": 5 })] }));
      const cards = [["Card ID", "Partner ID", "Partner", "Code", "Professional fee", "Timeline", "Valid to", "Status"], ["RC-1", "GB9100", "Gamma Visas LLC", "VISA-RES", "800", "5", "2027-01-31", "Active"]];
      const a = await audits(env);
      const reports = await runImports(env.db, null, false, [(tx) => importPartners(tx, book, "x.xlsx"), (tx) => importRateCards(tx, cards, "x.csv")]);
      expect(reports.map((r) => counts(r).created)).toEqual([1, 1]);
      expect(reports.every((r) => r.applied === false)).toBe(true);
      expect(await count(env, "select count(*) as n from orgs where profile->>'sourceId' = 'GB9100'")).toBe(0);
      expect(await audits(env)).toBe(a);
    });
  });

  describe("legal texts", () => {
    const terms = (extra = "") => `# Tasees Client Terms\n\nDraft for review by a UAE lawyer before use.\n\n## 1. Who we are\n\nTasees is a service of MKW Advisors.${extra}\n`;
    it("adds a version, leaves identical text alone, and refuses an agreement that names Tasees", async () => {
      const first: Report = await runImport(env.db, null, true, (tx) => importLegal(tx, terms(), "Tasees-Client-Terms.md"));
      expect(first.rows[0]).toMatchObject({ action: "created", ref: "client_terms v1" });
      expect((await runImport(env.db, null, true, (tx) => importLegal(tx, terms(), "Tasees-Client-Terms.md"))).rows[0]!.action).toBe("unchanged");
      expect((await runImport(env.db, null, true, (tx) => importLegal(tx, terms(" Updated."), "Tasees-Client-Terms.md"))).rows[0]).toMatchObject({ action: "created", ref: "client_terms v2" });
      const bad = await runImport(env.db, null, true, (tx) => importLegal(tx, "# MKW Partner Network Agreement\n\nWork from Tasees clients is offered to partners under this agreement.\n", "pna.md"));
      expect(bad.rows[0]!.action).toBe("skipped");
      expect(await count(env, "select count(*) as n from legal_documents where kind = 'partner_agreement'")).toBe(0);
      expect(await notifications(env)).toBe(notificationsAtStart);
    });
  });

  describe("invitation on pilot", () => {
    it("the held admin is invited, from MKW Advisors, only when MKW moves the firm to pilot", async () => {
      const beta = (await q<{ id: string }>(env, "select id from orgs where profile->>'sourceId' = 'GB9002'")).rows[0]!;
      const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
      const lic = await env.call("ops", "POST", `/api/partners/${beta.id}/documents`, { kind: "trade_licence", fileName: "licence.pdf", contentBase64: pdf, reference: "DED-9", expiresOn: "2027-12-31" });
      expect(lic.status).toBe(200);
      expect((await env.call("ops", "POST", `/api/ops/partner-documents/${lic.body.id}/review`, { decision: "verified", note: "Checked on the DED portal" })).status).toBe(200);
      expect((await env.call("ops", "POST", `/api/ops/partners/${beta.id}/status`, { status: "under_review", note: "Licence checked" })).status).toBe(200);
      expect(await notifications(env)).toBe(notificationsAtStart); // no active user at the firm yet: nobody to tell
      const moved = await env.call("ops", "POST", `/api/ops/partners/${beta.id}/status`, { status: "pilot", note: "Pilot partner" });
      expect(moved.status).toBe(200);
      expect(moved.body.invited).toBe(1);
      expect((await q<{ status: string }>(env, "select status from users where email = 'admin@beta.test'")).rows[0]!.status).toBe("active");
      const sent = (await q<{ template: string; audience: string }>(env, "select template, audience from notifications where to_email = 'admin@beta.test' order by created_at")).rows;
      expect(sent.map((n) => n.template)).toEqual(["user_invited", "partner_status_changed"]);
      const mail = env.emails.filter((m) => m.to === "admin@beta.test");
      expect(mail.length).toBe(2);
      expect(mail.every((m) => m.fromName.startsWith("MKW Advisors") && !/\bTasees\b/.test(`${m.fromName} ${m.subject} ${m.text}`))).toBe(true);
    });

    it("a held invitation can be cancelled, and cannot be released any other way", async () => {
      const book = readXlsx(makeXlsx({ Partners: [PARTNER_HEADER, partnerRow({ "Partner ID": "GB9200", Firm: "Delta Tax LLC", "Service codes (platform)": "VAT-RET", "Head office emirates": "Dubai", "Admin email (when signing)": "wrong@delta.test" })] }));
      await runImport(env.db, null, true, (tx) => importPartners(tx, book, "x.xlsx"));
      const u = (await q<{ id: string; org_id: string }>(env, "select id, org_id from users where email = 'wrong@delta.test'")).rows[0]!;
      expect((await env.call("founder", "POST", `/api/admin/users/${u.id}/reactivate`)).status).toBe(409);
      expect((await env.call("founder", "POST", `/api/admin/users/${u.id}/deactivate`)).status).toBe(200);
      expect((await q<{ status: string }>(env, "select status from users where id = $1", [u.id])).rows[0]!.status).toBe("deactivated");
      const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
      const lic = await env.call("ops", "POST", `/api/partners/${u.org_id}/documents`, { kind: "trade_licence", fileName: "licence.pdf", contentBase64: pdf, expiresOn: "2027-12-31" });
      await env.call("ops", "POST", `/api/ops/partner-documents/${lic.body.id}/review`, { decision: "verified", note: "Checked" });
      for (const status of ["applied", "under_review"]) await env.call("ops", "POST", `/api/ops/partners/${u.org_id}/status`, { status, note: "Next step" });
      const moved = await env.call("ops", "POST", `/api/ops/partners/${u.org_id}/status`, { status: "pilot", note: "Pilot" });
      expect(moved.body.invited).toBe(0);
      expect(await count(env, "select count(*) as n from notifications where to_email = 'wrong@delta.test'")).toBe(0);
    });
  });
});

describe("logs and names", () => {
  it("the console email transport never writes a sign-in code to the logs", async () => {
    const lines: string[] = [];
    await consoleTransport((m) => lines.push(m)).deliver({ to: "a@b.test", from: "x@y.test", fromName: "Tasees", subject: "482913 is your Tasees sign-in code", text: "Your code is 482913" });
    expect(lines.join("\n")).not.toMatch(/482913/);
    expect(lines.join("\n")).toMatch(/•••••• is your Tasees sign-in code/);
    // A document number that merely contains six digits stays readable.
    await consoleTransport((m) => lines.push(m)).deliver({ to: "a@b.test", from: "x@y.test", fromName: "Tasees", subject: "Tax invoice TI-2026-000001 for AED 10.00", text: "" });
    expect(lines.join("\n")).toMatch(/TI-2026-000001/);
  });

  it("only a person's name counts as a verifier", () => {
    expect(nameAnswer("Name: Aisha Verifier")).toBe("Aisha Verifier");
    expect(nameAnswer("J. O'Neil-Smith")).toBe("J. O'Neil-Smith");
    for (const a of ["not sure yet", "Agree", "TBC", "to be found", "x", "", "Name:", "123 Main"]) expect(nameAnswer(a)).toBeNull();
  });

  it("the evidence copy masks contact details but keeps dates", () => {
    const md = redactedMarkdown({ kind: "holidays", source: "x.xlsx", applied: false, notes: [], rows: [{ line: 3, ref: "2027-01-31", action: "created", reason: "call +971 4 000 0001 or info@x.test, see example.ae" }] }, "now");
    expect(md).toMatch(/2027-01-31/);
    expect(md).not.toMatch(/\+971|info@x\.test|example\.ae/);
  });
});


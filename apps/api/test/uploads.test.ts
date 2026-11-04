import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { checkUpload } from "../src/lib/storage.ts";
import { eicar, memoryScanner } from "../src/lib/scanner.ts";
import { scanHeldFiles } from "../src/lib/uploads.ts";
import { createSession } from "../src/lib/auth.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E22: an upload is what its name says, and is held until a malware scan finds it clean. Written before the fix; on
 * `main` at 548fa49 a PNG named .pdf was stored, and every uploaded file was served at once with no scan
 * (`docs/evidence/E22/before-fix.txt`).
 */
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");
const PDF = Buffer.from("%PDF-1.4 E22 test\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR")]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const zip = (...names: string[]) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`\0\0${names.join("\0")}\0`)]);
const key = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");

describe("the content check (E22)", () => {
  it("accepts each allowed type when its bytes are that type", () => {
    for (const [name, data] of [
      ["a.pdf", PDF], ["a.png", PNG], ["a.jpg", JPEG], ["a.jpeg", JPEG], ["a.webp", WEBP], ["a.doc", OLE], ["a.xls", OLE],
      ["a.docx", zip("[Content_Types].xml", "word/document.xml")], ["a.xlsx", zip("[Content_Types].xml", "xl/workbook.xml")],
      ["a.csv", Buffer.from("name,amount\nA,1\n")], ["a.txt", Buffer.from("Passport number noted by hand\n")],
    ] as const) {
      expect(() => checkUpload(name, data), name).not.toThrow();
    }
  });

  it("refuses a file whose bytes are another type, and says what it looks like", () => {
    expect(() => checkUpload("licence.pdf", PNG)).toThrow(/not a PDF.*PNG image/);
    expect(() => checkUpload("photo.png", PDF)).toThrow(/not a PNG.*PDF/);
    expect(() => checkUpload("photo.jpg", Buffer.from("MZ\x90\0"))).toThrow(/not a JPEG/);
    expect(() => checkUpload("letter.docx", zip("xl/workbook.xml"))).toThrow(/not a Word/);
    expect(() => checkUpload("sheet.xlsx", zip("word/document.xml"))).toThrow(/not an Excel/);
    expect(() => checkUpload("letter.doc", PDF)).toThrow(/not a Word/);
    expect(() => checkUpload("notes.txt", Buffer.from([0x4d, 0x5a, 0x00, 0x01]))).toThrow(/not a text/);
    expect(() => checkUpload("rows.csv", PNG)).toThrow(/not a CSV/);
    expect(() => checkUpload("empty.pdf", Buffer.alloc(0))).toThrow(/empty/);
  });
});

/** An engagement in delivery with its first milestone started, and the partner who delivers it. */
async function delivering(env: TestEnv) {
  const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
  const offerId = (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
  await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`, { acknowledgeReview: true });
  const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId as string;
  const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
  await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-TT-E22" });
  const e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
  for (const a of e.allocations) await env.call(key(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
  const who = key(e.allocations[0].partner);
  const m = (await env.call(who, "GET", `/api/engagements/${engagementId}`)).body.milestones[0];
  await env.call(who, "POST", `/api/milestones/${m.id}/start`);
  return { engagementId, who, m };
}
const get = (env: TestEnv, who: string, url: string) => env.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${env.tokens[who]}` } });

describe("with the test scanner (E22)", () => {
  let env: TestEnv;
  let d: Awaited<ReturnType<typeof delivering>>;
  beforeAll(async () => {
    env = await makeEnv();
    d = await delivering(env);
  });
  afterAll(() => env.db.close());

  it("refuses an upload whose content is not its type, over the API", async () => {
    const r = await env.call(d.who, "POST", `/api/milestones/${d.m.id}/evidence`, { type: d.m.evidenceRequired[0], fileName: "licence.pdf", contentBase64: b64(PNG) });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/not a PDF/);
  });

  it("serves a clean file, and records what it is", async () => {
    expect((await env.call(d.who, "POST", `/api/milestones/${d.m.id}/evidence`, { type: d.m.evidenceRequired[0], fileName: "licence.pdf", contentBase64: b64(PDF) })).status).toBe(200);
    const ev = (await env.call("client", "GET", `/api/engagements/${d.engagementId}`)).body.evidence.at(-1);
    expect(ev.scan).toBe("clean");
    expect((await get(env, "client", `/api/evidence/${ev.id}/file`)).statusCode).toBe(200);
    const row = (await asPlatform(env.db, null, (tx) => tx.query<any>("select f.status, f.detected_type, f.size_bytes, f.sha256, f.scanner from file_scans f join evidence e on e.file_key = f.key where e.id = $1", [ev.id]))).rows[0];
    expect(row).toMatchObject({ status: "clean", detected_type: "pdf", size_bytes: PDF.length, scanner: "memory (test double, not a malware scan)" });
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("holds an infected file: nobody downloads it, nobody passes QA on it, and ops are alerted", async () => {
    const infected = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(eicar())]);
    expect((await env.call(d.who, "POST", `/api/milestones/${d.m.id}/evidence`, { type: d.m.evidenceRequired[0], fileName: "bad.pdf", contentBase64: b64(infected) })).status).toBe(200);
    const ev = (await env.call("client", "GET", `/api/engagements/${d.engagementId}`)).body.evidence.at(-1);
    expect(ev.scan).toBe("infected");
    for (const who of ["client", d.who, "ops"]) {
      const r = await get(env, who, `/api/evidence/${ev.id}/file`);
      expect(r.statusCode, who).toBe(409);
      expect(r.body).toMatch(/malware/);
      expect(r.body).not.toContain("EICAR");
    }
    // Everything the step needs is uploaded, one file is infected: QA cannot pass it.
    for (const type of d.m.evidenceRequired.slice(1)) await env.call(d.who, "POST", `/api/milestones/${d.m.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: b64(PDF) });
    expect((await env.call(d.who, "POST", `/api/milestones/${d.m.id}/submit`)).status).toBe(200);
    const qa = await env.call("ops", "POST", `/api/ops/milestones/${d.m.id}/qa`, { pass: true });
    expect(qa.status).toBe(409);
    expect(qa.body.message).toMatch(/malware/);
    expect((await env.call("ops", "POST", `/api/ops/milestones/${d.m.id}/qa`, { pass: false, note: "One file was refused by the malware scan; upload a clean copy" })).status).toBe(200);
    const events = (await asPlatform(env.db, null, (tx) => tx.query<any>("select action, data from audit_events where action like 'file.%' order by id"))).rows;
    expect(events.at(-1)).toMatchObject({ action: "file.held", data: { status: "infected" } });
    expect((await env.call("ops", "POST", "/api/ops/jobs/run")).status).toBe(200);
    const system = (await env.call("ops", "GET", "/api/ops/system")).body;
    expect(system.uploads).toMatchObject({ scanner: { name: "memory (test double, not a malware scan)", live: false } });
    expect(system.uploads.byStatus.infected).toBe(1);
    expect(system.alerts.find((a: any) => a.kind === "upload_held" && !a.closedAt)?.summary).toMatch(/malware/);
  });

  it("clients and partners never read the scan table; they see a file's status only", async () => {
    const client = (await env.call("client", "GET", "/api/me")).body;
    const partner = (await env.call(d.who, "GET", "/api/me")).body;
    await expect(asUser(env.db, client, (tx) => tx.query("select * from file_scans"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select * from file_scans"))).rejects.toThrow(/permission denied/);
    // Status moves only through the file machine.
    const fk = (await asPlatform(env.db, null, (tx) => tx.query<any>("select key from file_scans where status = 'infected' limit 1"))).rows[0].key;
    await expect(asPlatform(env.db, null, (tx) => tx.query("update file_scans set status = 'bogus' where key = $1", [fk]))).rejects.toThrow(/check constraint/);
  });
});

describe("with no scanner (staging until T6) (E22)", () => {
  let env: TestEnv;
  let d: Awaited<ReturnType<typeof delivering>>;
  beforeAll(async () => {
    env = await makeEnv(undefined, { scanner: null });
    d = await delivering(env);
  });
  afterAll(() => env.db.close());

  it("holds every upload until a scan finds it clean, on every route that serves a file", async () => {
    // Evidence.
    expect((await env.call(d.who, "POST", `/api/milestones/${d.m.id}/evidence`, { type: d.m.evidenceRequired[0], fileName: "licence.pdf", contentBase64: b64(PDF) })).status).toBe(200);
    const ev = (await env.call("client", "GET", `/api/engagements/${d.engagementId}`)).body.evidence.at(-1);
    expect(ev.scan).toBe("pending");
    const held = await get(env, "client", `/api/evidence/${ev.id}/file`);
    expect(held.statusCode).toBe(409);
    expect(held.body).toMatch(/not been scanned/);
    // A client document: held, and the partner cannot mark it received.
    const docs = (await env.call("client", "GET", `/api/engagements/${d.engagementId}`)).body.documentRequests;
    expect((await env.call("client", "POST", `/api/document-requests/${docs[0].id}/upload`, { fileName: "passport.pdf", contentBase64: b64(PDF) })).status).toBe(200);
    expect((await get(env, d.who, `/api/document-requests/${docs[0].id}/file`)).statusCode).toBe(409);
    const received = await env.call(d.who, "POST", `/api/document-requests/${docs[0].id}/decide`, { decision: "received" });
    expect(received.status).toBe(409);
    expect(received.body.message).toMatch(/not been scanned/);
    // A partner document: held, and ops cannot verify it.
    const firm = (await env.call(d.who, "GET", "/api/me")).body.orgId;
    const pd = await env.call(d.who, "POST", `/api/partners/${firm}/documents`, { kind: "insurance", fileName: "policy.pdf", contentBase64: b64(PDF) });
    expect(pd.status).toBe(200);
    expect((await get(env, d.who, `/api/partner-documents/${pd.body.id}/file`)).statusCode).toBe(409);
    expect((await env.call("ops", "POST", `/api/ops/partner-documents/${pd.body.id}/review`, { decision: "verified" })).status).toBe(409);
    // A clean scan later (the jobs step, once a scanner exists) releases them all.
    const scanner = memoryScanner();
    expect(await scanHeldFiles(env.db, { storage: env.storage, scanner })).toMatchObject({ clean: 3, infected: 0, failed: 0 });
    expect((await get(env, "client", `/api/evidence/${ev.id}/file`)).statusCode).toBe(200);
    expect((await get(env, d.who, `/api/document-requests/${docs[0].id}/file`)).statusCode).toBe(200);
    expect((await get(env, d.who, `/api/partner-documents/${pd.body.id}/file`)).statusCode).toBe(200);
    expect((await env.call(d.who, "POST", `/api/document-requests/${docs[0].id}/decide`, { decision: "received" })).status).toBe(200);
    const moves = (await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'file.status_changed'"))).rows;
    expect(moves.map((m: any) => `${m.data.from}>${m.data.to}`)).toEqual(["pending>clean", "pending>clean", "pending>clean"]);
    // The jobs step does nothing while no scanner is configured, and says so on the System page.
    const system = (await env.call("ops", "GET", "/api/ops/system")).body;
    expect(system.uploads.scanner).toEqual({ name: null, live: false });
  });
});

describe("a scanner that fails (E22)", () => {
  it("a failed scan holds the file, and the retry releases it", async () => {
    const scanner = memoryScanner();
    scanner.failing = true;
    const env = await makeEnv(undefined, { scanner });
    try {
      const d = await delivering(env);
      expect((await env.call(d.who, "POST", `/api/milestones/${d.m.id}/evidence`, { type: d.m.evidenceRequired[0], fileName: "licence.pdf", contentBase64: b64(PDF) })).status).toBe(200);
      const ev = (await env.call("client", "GET", `/api/engagements/${d.engagementId}`)).body.evidence.at(-1);
      expect(ev.scan).toBe("failed");
      expect((await get(env, "client", `/api/evidence/${ev.id}/file`)).statusCode).toBe(409);
      expect(await scanHeldFiles(env.db, { storage: env.storage, scanner })).toMatchObject({ failed: 1 });
      scanner.failing = false;
      expect(await scanHeldFiles(env.db, { storage: env.storage, scanner })).toMatchObject({ clean: 1 });
      expect((await get(env, "client", `/api/evidence/${ev.id}/file`)).statusCode).toBe(200);
      const attempts = (await asPlatform(env.db, null, (tx) => tx.query<any>("select attempts from file_scans"))).rows[0].attempts;
      expect(attempts).toBe(3);
    } finally {
      await env.db.close();
    }
  });
});

describe("unscanned files allowed by the owner (T6, UPLOADS_UNSCANNED=allow) (E22)", () => {
  it("serves them, labelled as not scanned, and a scanner added later still scans them", async () => {
    const env = await makeEnv(undefined, { scanner: null, allowUnscanned: true });
    try {
      const d = await delivering(env);
      expect((await env.call(d.who, "POST", `/api/milestones/${d.m.id}/evidence`, { type: d.m.evidenceRequired[0], fileName: "licence.pdf", contentBase64: b64(PDF) })).status).toBe(200);
      const ev = (await env.call("client", "GET", `/api/engagements/${d.engagementId}`)).body.evidence.at(-1);
      expect(ev.scan).toBe("not_scanned");
      expect((await get(env, "client", `/api/evidence/${ev.id}/file`)).statusCode).toBe(200);
      expect(await scanHeldFiles(env.db, { storage: env.storage, scanner: memoryScanner() })).toMatchObject({ clean: 1 });
      // Another client never sees it, whatever its state.
      await env.call("ops", "POST", "/api/ops/clients", { company: "Other E22 LLC", ownerName: "Other Owner", ownerEmail: "owner@other-e22.test" });
      env.tokens.other = await createSession(env.db, "owner@other-e22.test");
      expect((await get(env, "other", `/api/evidence/${ev.id}/file`)).statusCode).toBe(404);
    } finally {
      await env.db.close();
    }
  });
});

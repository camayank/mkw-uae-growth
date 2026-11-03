import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { createSession } from "../src/lib/auth.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E7D over HTTP: the public report is a PDF of the saved result, preliminary and free of money internals; the
 * client's report is their own only, preliminary until a person approves the advice and reviewed after, naming the
 * reviewer; booking a call is ops and founder only, audited, and turns the call request into a queued follow-up.
 */
const pdfText = (buf: string) => buf.replace(/\\\(/g, "(").replace(/\\\)/g, ")");
const MONEY = /margin|partner cost|payout|rate card|commission|professional fee|partnerUnit/i;

describe("the assessment report and the consultation booking (E7D)", () => {
  let env: TestEnv;
  const answers = { emirate: "Dubai", activity: "tech", customers: "international", visas: 2, budgetAed: 30_000, premises: "office", ownerType: "individuals", foreignTaxResident: false, startWithin: "3_months" };
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("the public report: a PDF of the saved result, preliminary, rate-limited, nothing written and not a return visit", async () => {
    const { code } = (await env.call("anon", "POST", "/api/public/assessments", { answers })).body;
    const before = { audit: await count("audit_events"), outbox: await count("outbox") };
    const r = await env.send("anon", "GET", `/api/public/assessments/${code}/report.pdf`);
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/application\/pdf/);
    expect(String(r.headers["content-disposition"])).toMatch(/attachment; filename="uae-entity-assessment-PRE-[0-9A-F]{8}\.pdf"/);
    const text = pdfText(String(r.body));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("Tasees, by MKW Advisors");
    expect(text).toContain("UAE Entity Assessment Report");
    expect(text).toMatch(/PRELIMINARY: general information from your answers/);
    expect(text).toContain("YOUR BUSINESS PROFILE");
    expect(text).toContain("JURISDICTIONS COMPARED");
    expect(text).not.toContain(code); // the recovery code never appears in the document
    expect(text).not.toMatch(/AED [\d,]+ to AED/); // nothing is approved for public display in a fresh demo
    expect(text).not.toMatch(MONEY);
    expect(await count("audit_events")).toBe(before.audit);
    expect(await count("outbox")).toBe(before.outbox);
    // A download is not a return visit: the recovery counter the lead score reads is untouched.
    expect((await asPlatform(env.db, null, (tx) => tx.query("select recovered from assessments"))).rows[0]).toEqual({ recovered: 0 });
    expect((await env.send("anon", "GET", "/api/public/assessments/ZZZZZZZZZZ/report.pdf")).status).toBe(404);
    expect((await env.send("anon", "GET", "/api/public/assessments/nope/report.pdf")).status).toBe(404);
    // Rate-limited per IP.
    let last = 200;
    for (let i = 0; i < 40 && last !== 429; i++) last = (await env.send("anon", "GET", `/api/public/assessments/${code}/report.pdf`)).status;
    expect(last).toBe(429);
  });

  it("the client's report: own requests only, preliminary until the advice is approved, reviewed after with the reviewer named", async () => {
    const r = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "not_sure", ...answers } });
    expect(r.status).toBe(200);
    const id = r.body.id as string;
    let p = await env.send("client", "GET", `/api/client/requests/${id}/report.pdf`);
    expect(p.status).toBe(200);
    expect(String(p.headers["content-type"])).toMatch(/application\/pdf/);
    let text = pdfText(String(p.body));
    expect(text).toMatch(/PRELIMINARY: your request is with MKW Advisors for review/);
    expect(text).toContain("Company: ");
    expect(text).not.toMatch(/REVIEWED by/);
    expect(text).not.toMatch(/\[(verified rule|rule of thumb|UNCERTAIN)\]|Recommended structure|AED [\d,]+ to AED/); // the unapproved advice stays out
    expect(text).toMatch(/\[TO BE VERIFIED\]/);
    expect((await env.send("client", "GET", "/api/client/requests/not-a-uuid/report.pdf")).status).toBe(404);
    // A services request for the existing company has no assessment behind it: no report, and the page offers no link.
    const svc = await env.call("client", "POST", "/api/requests", { answers: { mode: "services", emirate: "Dubai", services: ["VAT-RET"] } });
    expect(svc.status, JSON.stringify(svc.body)).toBe(200);
    expect((await env.send("client", "GET", `/api/client/requests/${svc.body.id}/report.pdf`)).status).toBe(404);
    const home = (await env.call("client", "GET", "/api/client/home")).body;
    expect(home.requests.find((x: any) => x.id === svc.body.id).mode).toBe("services");
    expect(home.requests.find((x: any) => x.id === id).mode).toBe("new_company");
    // Another client, a partner and an anonymous caller cannot read it.
    const other = await env.call("ops", "POST", "/api/ops/clients", { company: "Other Trading LLC", ownerName: "Other Owner", ownerEmail: "other-owner@example.test" });
    expect(other.status).toBe(200);
    env.tokens.other = await createSession(env.db, "other-owner@example.test");
    expect((await env.send("other", "GET", `/api/client/requests/${id}/report.pdf`)).status).toBe(404);
    expect((await env.send("setup", "GET", `/api/client/requests/${id}/report.pdf`)).status).toBe(403);
    expect((await env.send("anon", "GET", `/api/client/requests/${id}/report.pdf`)).status).toBe(401);
    // A person approves the advice: the report becomes the reviewed one, with every confidence label and the reviewer.
    expect((await env.call("ops", "POST", `/api/ops/requests/${id}/scoping/approve`, {})).status).toBe(200);
    p = await env.send("client", "GET", `/api/client/requests/${id}/report.pdf`);
    text = pdfText(String(p.body));
    expect(text).toMatch(/REVIEWED by .+ at MKW Advisors on \d{4}-\d{2}-\d{2}/);
    expect(text).toContain("Recommended structure: Free zone company");
    expect(text).toMatch(/\[(UNCERTAIN|rule of thumb|verified rule)\]/);
    expect(text).toContain("Reviewed advice for the client named above.");
    expect(text).not.toMatch(MONEY);
    expect(text).not.toMatch(/margin|payout/i); // "partner firms deliver the work" is the brand line, so "partner" alone is allowed
  });

  it("booking a call: ops and founder only, audited, the lead moves to consultation and a follow-up reaches the queue when due", async () => {
    expect((await env.call("anon", "POST", "/api/public/intake", { company: "Call Me Co", name: "C. Founder", email: "callme@example.test", consent: true, consentVersion: "2026-11-selector-v1", answers: { mode: "new_company", jurisdiction: "not_sure", ...answers }, consultation: { wanted: true, times: "Tuesday afternoons" } })).status).toBe(200);
    const l = (await env.call("ops", "GET", "/api/ops/pipeline/leads")).body.find((x: any) => x.company === "Call Me Co");
    expect((await env.call("ops", "GET", "/api/ops/queue")).body.items.some((x: any) => x.kind === "consultation" && /Call Me Co/.test(x.detail))).toBe(true);
    const at = new Date(env.clock.now.getTime() + 2 * 86_400_000).toISOString();
    expect((await env.call("finance", "POST", `/api/ops/pipeline/leads/${l.id}/consultation`, { at })).status).toBe(403);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${l.id}/consultation`, { at: "not a date" })).status).toBe(400);
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${l.id}/consultation`, { at: "2027-01-12" })).status).toBe(400); // a date needs a time
    const b = await env.call("ops", "POST", `/api/ops/pipeline/leads/${l.id}/consultation`, { at, note: "Zoom link sent by the adviser" });
    expect(b.status).toBe(200);
    const d = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${l.id}`)).body;
    expect(d.status).toBe("consultation");
    expect(d.consultationBookedFor).toBeTruthy();
    expect(d.firstContactAt).toBeTruthy();
    expect(d.owner).toBeTruthy(); // the booker owns it when nobody did
    expect(d.notes.some((n: any) => n.kind === "followup" && /Call booked for .* GST/.test(n.body) && !n.done_at)).toBe(true);
    // Rebooking closes the earlier follow-up: one open call in the queue, the status unchanged.
    expect((await env.call("ops", "POST", `/api/ops/pipeline/leads/${l.id}/consultation`, { at: new Date(env.clock.now.getTime() + 4 * 86_400_000).toISOString() })).status).toBe(200);
    const d2 = (await env.call("ops", "GET", `/api/ops/pipeline/leads/${l.id}`)).body;
    expect(d2.notes.filter((n: any) => n.kind === "followup" && /Call booked for/.test(n.body) && !n.done_at)).toHaveLength(1);
    expect(d2.notes.some((n: any) => n.kind === "status" && n.body === "call rebooked")).toBe(true);
    expect(d2.notes.some((n: any) => n.kind === "status" && /consultation → consultation/.test(n.body))).toBe(false);
    expect(d.nextAction.action).toBe("Follow up after the call");
    expect((await asPlatform(env.db, null, (tx) => tx.query("select data from audit_events where action = 'lead.consultation_booked'"))).rows).toHaveLength(2);
    // The call request leaves the queue; the follow-up appears there once due.
    let q = (await env.call("ops", "GET", "/api/ops/queue")).body;
    expect(q.items.some((x: any) => x.kind === "consultation" && /Call Me Co/.test(x.detail))).toBe(false);
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 5 * 86_400_000); // past the rebooked time
    try {
      q = (await env.call("ops", "GET", "/api/ops/queue")).body;
      expect(q.items.some((x: any) => /Call booked for/.test(x.detail ?? "") || x.kind === "followup")).toBe(true);
    } finally {
      env.clock.now = saved;
    }
    // Nothing was sent.
    expect(env.emails.filter((e) => e.to === "callme@example.test").length).toBe(1); // the intake acknowledgement only
  });

  const count = async (table: string): Promise<number> => (await asPlatform(env.db, null, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`))).rows[0]!.n;
});

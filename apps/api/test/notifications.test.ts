import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { sesTransport } from "../src/lib/notify.ts";
import { signV4 } from "../src/lib/sigv4.ts";
import { renderTemplate, TEMPLATE_AUDIENCE, type Audience, type TemplateName } from "../src/lib/templates.ts";
import { EMAILS, makeEnv, type TestEnv } from "./helpers.ts";

const ALL: TemplateName[] = Object.keys(TEMPLATE_AUDIENCE) as TemplateName[];
const SAMPLE_VARS = {
  code: "123456",
  offerId: "11111111-2222-3333-4444-555555555555",
  engagementId: "66666666-7777-8888-9999-000000000000",
  amountFils: 1234550,
  deadline: "2026-10-20T06:00:00Z",
  milestoneId: "m",
  allocationId: "a",
  changeOrderId: "c",
  payoutId: "p",
  orgName: "Example Firm LLC",
  number: "TI-2026-000001",
  runReference: "PR-2026-0001",
  bankReference: "FT26290ABC",
  count: 2,
  role: "partner_admin",
  total: 3,
  qa: 2,
  payout: 1,
};

describe("templates and branding", () => {
  it("never say Tasees to partners or MKW staff, and always Tasees, by MKW Advisors to clients", () => {
    for (const t of ALL) {
      for (const audience of ["client", "partner", "staff"] as Audience[]) {
        const r = renderTemplate(t, audience, SAMPLE_VARS, "https://app.test");
        const text = `${r.subject}\n${r.body}`;
        if (audience === "client") expect(text).toContain("Tasees, by MKW Advisors");
        else {
          expect(text).not.toMatch(/tasees/i);
          expect(text).toContain("MKW Advisors");
        }
        expect(text).not.toMatch(/undefined|NaN|\[object/);
      }
    }
  });

  it("formats money and times for the UAE and never carries a whole database id", () => {
    const r = renderTemplate("payment_due", "client", SAMPLE_VARS, "https://app.test/");
    expect(r.subject).toBe("Deposit of AED 12,345.50 to start your engagement");
    expect(r.body).toContain("reference 66666666");
    expect(r.body).toContain("https://app.test/#/engagement/66666666-7777-8888-9999-000000000000");
    const a = renderTemplate("allocation_offered", "partner", SAMPLE_VARS, "https://app.test");
    expect(a.body).toContain("20 Oct, 10:00 GST");
    expect(renderTemplate("login_code", "client", SAMPLE_VARS, "x").inApp).toBe(false);
    expect(renderTemplate("offer_ready", "client", SAMPLE_VARS, "x").inApp).toBe(true);
  });
});

describe("notifications through a flow", () => {
  let env: TestEnv;
  let engagementId: string;
  let clientId: string;

  beforeAll(async () => {
    env = await makeEnv();
    clientId = (await env.call("client", "GET", "/api/me")).body.id;
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    const offerId = built.body.offerIds[0];
    await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
    engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    const eng = await env.call("finance", "GET", `/api/engagements/${engagementId}`);
    await env.call("finance", "POST", `/api/ops/payments/${eng.body.payments[0].id}/mark-paid`, { reference: "BANK-1" });
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("records every send with its audience, sender and delivery result", async () => {
    const rows = await asPlatform(env.db, null, (tx) => tx.query<any>("select template, audience, to_email, status, provider_ref, in_app, user_id from notifications order by created_at"));
    const byTemplate = Object.fromEntries(rows.rows.map((r) => [r.template, r]));
    expect(byTemplate.offer_ready).toMatchObject({ audience: "client", to_email: EMAILS.client, status: "sent", in_app: true, user_id: clientId });
    expect(byTemplate.payment_due).toMatchObject({ audience: "client", status: "sent" });
    expect(byTemplate.allocation_offered).toMatchObject({ audience: "partner", status: "sent", in_app: true });
    expect(rows.rows.every((r) => r.provider_ref?.startsWith("mem-"))).toBe(true);
    const offerEmail = env.emails.find((e) => e.subject === "Your offers are ready")!;
    expect(offerEmail).toMatchObject({ to: EMAILS.client, from: "tasees@mkwadvisors.test", fromName: "Tasees, by MKW Advisors" });
    const partnerEmail = env.emails.find((e) => e.subject.startsWith("New work from MKW Advisors"))!;
    expect(partnerEmail.from).toBe("partners@mkwadvisors.test");
    expect(partnerEmail.fromName).toBe("MKW Advisors");
    expect(`${partnerEmail.subject} ${partnerEmail.text}`).not.toMatch(/tasees/i);
  });

  it("shows each person only their own bell, and marks it read", async () => {
    const mine = await env.call("client", "GET", "/api/notifications");
    expect(mine.status).toBe(200);
    expect(mine.body.unread).toBe(2);
    expect(mine.body.items.map((i: any) => i.template).sort()).toEqual(["offer_ready", "payment_due"]);
    expect(mine.body.items[0]).not.toHaveProperty("toEmail");
    const member = await env.call("clientMember", "GET", "/api/notifications");
    expect(member.body.items).toEqual([]);
    const partner = await env.call("setup", "GET", "/api/notifications");
    expect(partner.body.items.map((i: any) => i.template)).toEqual(["allocation_offered"]);
    const read = await env.call("client", "POST", "/api/notifications/read", { ids: [mine.body.items[0].id] });
    expect(read.body.marked).toBe(1);
    expect((await env.call("client", "GET", "/api/notifications")).body.unread).toBe(1);
    expect((await env.call("client", "POST", "/api/notifications/read", {})).body.marked).toBe(1);
    expect((await env.call("client", "GET", "/api/notifications")).body.unread).toBe(0);
    expect((await env.call("anon", "GET", "/api/notifications")).status).toBe(401);
  });

  it("the database hides other people's rows and the delivery internals from clients and partners", async () => {
    const client = (await env.call("client", "GET", "/api/me")).body;
    const partner = (await env.call("setup", "GET", "/api/me")).body;
    const seen = await asUser(env.db, client, (tx) => tx.query<any>("select user_id from notifications"));
    expect(seen.rows.every((r) => r.user_id === client.id)).toBe(true);
    expect(seen.rows.length).toBeGreaterThan(0);
    await expect(asUser(env.db, client, (tx) => tx.query("select vars from notifications"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select error, provider_ref from notifications"))).rejects.toThrow(/permission denied/);
    const partnerRows = await asUser(env.db, partner, (tx) => tx.query<any>("select template from notifications"));
    expect(partnerRows.rows.map((r) => r.template)).not.toContain("offer_ready");
    expect((await env.call("client", "GET", "/api/admin/notifications")).status).toBe(403);
    const log = await env.call("finance", "GET", "/api/admin/notifications");
    expect(log.status).toBe(200);
    expect(log.body.length).toBeGreaterThanOrEqual(3);
    expect(log.body[0]).toHaveProperty("status");
  });

  it("sign-in codes are emailed but never written down: not in the bell, not in the delivery log, not in vars", async () => {
    const r = await env.call("anon", "POST", "/api/auth/request-code", { email: EMAILS.client });
    const code: string = r.body.devCode;
    expect(code).toMatch(/^\d{6}$/);
    const rows = await asPlatform(env.db, null, (tx) => tx.query<any>("select in_app, status, subject, body, vars from notifications where template = 'login_code'"));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ in_app: false, status: "sent", subject: "(sign-in code: not recorded)", body: "", vars: {} });
    const mine = await env.call("client", "GET", "/api/notifications");
    expect(mine.body.items.map((i: any) => i.template)).not.toContain("login_code");
    // The email itself carries the code; the delivery log that ops can read does not.
    expect(env.emails.at(-1)!.subject).toBe(`${code} is your Tasees, by MKW Advisors sign-in code`);
    const log = await env.call("ops", "GET", "/api/admin/notifications");
    expect(JSON.stringify(log.body)).not.toContain(code);
    const anyRow = await asPlatform(env.db, null, (tx) => tx.query<any>("select 1 from notifications where subject like $1 or body like $1 or vars::text like $1", [`%${code}%`]));
    expect(anyRow.rows).toEqual([]);
  });

  it("sends nothing for a transaction that rolls back, and only after one that commits", async () => {
    const before = env.emails.length;
    await asPlatform(env.db, null, async (tx) => {
      await env.notify.send({ to: EMAILS.client, channel: "email", template: "offer_ready", vars: { offerId: "rolled-back" } });
      await tx.query("select 1");
      throw new Error("rollback");
    }).catch((e) => {
      if ((e as Error).message !== "rollback") throw e;
    });
    await env.notify.flush();
    await new Promise((r) => setImmediate(r));
    await env.notify.flush();
    expect(env.emails.length).toBe(before);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select 1 from notifications where vars->>'offerId' = 'rolled-back'"))).rows).toEqual([]);
    let flushedDuringTx = false;
    await asPlatform(env.db, null, async (tx) => {
      await env.notify.send({ to: EMAILS.client, channel: "email", template: "offer_ready", vars: { offerId: "committed" } });
      await new Promise((r) => setImmediate(r)); // give an eager flush every chance to run too early
      await tx.query("select 1");
      flushedDuringTx = env.emails.length > before;
    });
    expect(flushedDuringTx).toBe(false);
    await env.notify.flush();
    expect(env.emails.length).toBe(before + 1);
    expect((await asPlatform(env.db, null, (tx) => tx.query("select status from notifications where vars->>'offerId' = 'committed'"))).rows).toEqual([{ status: "sent" }]);
  });

  it("skips deactivated recipients and records that it did", async () => {
    const orgs = await env.call("founder", "GET", "/api/admin/orgs");
    const member = orgs.body.flatMap((o: any) => o.users).find((u: any) => u.email === EMAILS.clientMember);
    await env.call("founder", "POST", `/api/admin/users/${member.id}/deactivate`);
    const before = env.emails.length;
    await env.notify.send({ to: EMAILS.clientMember, channel: "email", template: "offer_ready", vars: { offerId: "x" } });
    await env.notify.flush();
    expect(env.emails.length).toBe(before);
    const row = await asPlatform(env.db, null, (tx) => tx.query<any>("select status, error, in_app, subject from notifications where to_email = $1 and template = 'offer_ready'", [EMAILS.clientMember]));
    expect(row.rows[0]).toMatchObject({ status: "skipped", error: "recipient not active", in_app: false });
    expect(row.rows[0].subject).not.toContain("offers");
    await env.call("founder", "POST", `/api/admin/users/${member.id}/reactivate`);
  });

  it("a provider failure is recorded and never blocks the business action", async () => {
    for (const who of ["setup", "corp", "tax"]) {
      const home = await env.call(who, "GET", "/api/partner/home");
      for (const a of home.body.allocations.filter((x: any) => !x.acceptedAt && !x.declinedAt)) {
        expect((await env.call(who, "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" })).status).toBe(200);
      }
    }
    env.transport.failNext = "MessageRejected: address not verified";
    const co = await env.call("setup", "POST", `/api/engagements/${engagementId}/change-orders`, { description: "Extra attestation", partnerCostAed: 1000 });
    expect(co.status).toBe(200); // the change order exists even though the email bounced
    const rows = await asPlatform(env.db, null, (tx) => tx.query<any>("select template, status, error, audience from notifications where template = 'change_order_to_approve' order by created_at"));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: "failed", audience: "client" });
    expect(rows.rows[0].error).toContain("MessageRejected");
    // The failed row is still the client's in-app notification, and the next one goes through.
    const clientBell = await env.call("client", "GET", "/api/notifications");
    const item = clientBell.body.items.find((i: any) => i.template === "change_order_to_approve");
    expect(item).toBeTruthy();
    expect(item.body).not.toContain("Extra attestation"); // the partner's free text stays out
    expect((await env.call("setup", "POST", `/api/engagements/${engagementId}/change-orders`, { description: "Second change", partnerCostAed: 500 })).status).toBe(200);
    const again = await asPlatform(env.db, null, (tx) => tx.query<any>("select status from notifications where template = 'change_order_to_approve' order by created_at"));
    expect(again.rows.map((r) => r.status).sort()).toEqual(["failed", "sent"]); // same frozen clock, so order is not fixed
  });

  it("a QA note never leaves the platform in a message", async () => {
    const eng = await env.call("ops", "GET", `/api/engagements/${engagementId}`);
    const m = eng.body.milestones[0];
    await env.call("setup", "POST", `/api/milestones/${m.id}/start`);
    for (const t of m.evidenceRequired) await env.call("setup", "POST", `/api/milestones/${m.id}/evidence`, { type: t, fileName: `${t}.pdf`, contentBase64: Buffer.from("%PDF").toString("base64") });
    await env.call("setup", "POST", `/api/milestones/${m.id}/submit`);
    const r = await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: false, note: "Stamp missing on page 2, call Ali on 050 999 8888" });
    expect(r.status).toBe(200);
    const sent = env.emails.find((e) => e.subject === "A step was sent back for rework")!;
    expect(sent).toBeTruthy();
    expect(sent.text).not.toContain("Stamp missing");
    expect(sent.text).not.toContain("050 999");
    expect(sent.text).toContain(`#/engagement/${engagementId}`);
  });
});

describe("ops digest rule", () => {
  let env: TestEnv;
  const digests = () => asPlatform(env.db, null, async (tx) => (await tx.query<any>("select to_email, body from notifications where template = 'ops_digest' order by created_at")).rows);
  beforeAll(async () => {
    env = await makeEnv(new Date("2026-10-19T04:30:00Z")); // Monday 08:30 GST
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] }); // one draft offer in the queue
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("goes once to ops and the founder on a working morning, then not again that day", async () => {
    const first = await env.call("founder", "POST", "/api/ops/jobs/run");
    expect(first.body.opsDigests).toBe(2);
    const claim = await asPlatform(env.db, null, (tx) => tx.query<any>("select day::text, recipients from digest_runs"));
    expect(claim.rows).toEqual([{ day: "2026-10-19", recipients: 2 }]);
    expect(env.emails.filter((e) => e.subject.startsWith("Ops digest")).length).toBe(2); // emailed from the job path too
    const rows = await digests();
    expect(rows.map((r) => r.to_email).sort()).toEqual([EMAILS.founder, EMAILS.ops].sort());
    expect(rows[0].body).toContain("Offers ready to publish: 1");
    expect(rows[0].body).not.toMatch(/tasees/i);
    env.clock.now = new Date("2026-10-19T05:30:00Z"); // 09:30 GST, same day
    expect((await env.call("founder", "POST", "/api/ops/jobs/run")).body.opsDigests).toBe(0);
    expect((await digests()).length).toBe(2);
  });

  it("stays silent outside the window, on Friday evening and on Saturday", async () => {
    env.clock.now = new Date("2026-10-20T07:00:00Z"); // Tuesday 11:00 GST: window closed
    expect((await env.call("founder", "POST", "/api/ops/jobs/run")).body.opsDigests).toBe(0);
    env.clock.now = new Date("2026-10-23T14:30:00Z"); // Friday 18:30 GST
    expect((await env.call("founder", "POST", "/api/ops/jobs/run")).body.opsDigests).toBe(0);
    env.clock.now = new Date("2026-10-24T04:30:00Z"); // Saturday 08:30 GST
    expect((await env.call("founder", "POST", "/api/ops/jobs/run")).body.opsDigests).toBe(0);
    env.clock.now = new Date("2026-10-26T04:05:00Z"); // Monday 08:05 GST
    expect((await env.call("founder", "POST", "/api/ops/jobs/run")).body.opsDigests).toBe(2);
    expect((await digests()).length).toBe(4);
  });
});

describe("SES transport", () => {
  const creds = { accessKeyId: "SESKEY", secretAccessKey: "ses/secret", region: "me-central-1" };
  const received: Array<{ auth: string; body: any; headers: Record<string, string | string[] | undefined> }> = [];
  let server: Server;
  let endpoint = "";
  let nextStatus = 200;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);
      const auth = String(req.headers.authorization ?? "");
      const m = /SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
      const headers: Record<string, string> = {};
      for (const h of m?.[1]?.split(";") ?? []) headers[h] = h === "host" ? String(req.headers.host) : String(req.headers[h]);
      const payloadHash = (await import("node:crypto")).createHash("sha256").update(raw).digest("hex");
      const expected = signV4({ method: "POST", path: "/v2/email/outbound-emails", headers, payloadHash, region: creds.region, service: "ses", accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, amzDate: headers["x-amz-date"]! });
      if (expected.signature !== m?.[2]) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ message: "The request signature we calculated does not match" }));
      }
      received.push({ auth, body: JSON.parse(raw.toString()), headers: req.headers });
      res.writeHead(nextStatus, { "content-type": "application/json" });
      res.end(nextStatus === 200 ? JSON.stringify({ MessageId: "0100018-abc" }) : JSON.stringify({ message: "Email address is not verified." }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("signs a SendEmail call that the service accepts and returns the message id", async () => {
    const t = sesTransport({ ...creds, endpoint });
    const r = await t.deliver({ to: "client@example.test", from: "tasees@mkwadvisors.com", fromName: "Tasees, by MKW Advisors", subject: "Hello", text: "Body" });
    expect(r.providerRef).toBe("0100018-abc");
    expect(received[0]!.body).toMatchObject({
      // Quoted: the display name has a comma, which an unquoted address header would split on.
      FromEmailAddress: '"Tasees, by MKW Advisors" <tasees@mkwadvisors.com>',
      Destination: { ToAddresses: ["client@example.test"] },
      Content: { Simple: { Subject: { Data: "Hello" }, Body: { Text: { Data: "Body" } } } },
    });
    expect(received[0]!.auth).toContain("/me-central-1/ses/aws4_request");
  });

  it("reports the provider's refusal as an error", async () => {
    nextStatus = 400;
    const t = sesTransport({ ...creds, endpoint });
    await expect(t.deliver({ to: "x@example.test", from: "a@b.c", fromName: "MKW Advisors", subject: "s", text: "t" })).rejects.toThrow(/not verified/);
    nextStatus = 200;
    const wrong = sesTransport({ ...creds, secretAccessKey: "bad", endpoint });
    await expect(wrong.deliver({ to: "x@example.test", from: "a@b.c", fromName: "MKW Advisors", subject: "s", text: "t" })).rejects.toThrow(/signature/);
  });
});

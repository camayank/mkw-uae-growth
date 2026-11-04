import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { loginOwnsSchema, prepareDatabase, scramVerifier } from "../src/lib/db.ts";
import { signWebhook } from "../src/lib/payments.ts";
import { runJobs } from "../src/jobs/run.ts";
import { nightlyAuditCheck } from "../src/services/system.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E19: the audit trail is append-only at the database, and the application runs as a login that owns nothing. Before
 * E19, staging logged in as the database's master user, which owns every table: a compromised process could leave the
 * per-request role, read anything, switch a guard off or edit the audit trail.
 */
const PG = !!process.env.TEST_DATABASE_URL;

describe("the audit trail is append-only (E19)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  it("no application role can change, remove or truncate an audit event", async () => {
    await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    for (const sql of [
      "update audit_events set data = '{}'::jsonb where id = (select max(id) from audit_events)",
      "delete from audit_events where id = (select max(id) from audit_events)",
      "truncate audit_events",
    ]) {
      await expect(asPlatform(env.db, null, (tx) => tx.query(sql))).rejects.toThrow(/permission denied|append-only/);
    }
    // Even with the privilege (as the owner, the trigger on), the change is refused.
    await expect(env.db.transaction((tx) => tx.query("update audit_events set data = '{}'::jsonb where id = (select max(id) from audit_events)"))).rejects.toThrow(/append-only/);
    expect((await asPlatform(env.db, null, (tx) => tx.query<{ broken_id: number | null }>("select * from audit_verify()"))).rows[0]!.broken_id).toBeNull();
  });

  it.skipIf(!PG)("on PostgreSQL, the owner of the tables is refused as the application's login in production, and may migrate elsewhere", async () => {
    expect(await loginOwnsSchema(env.db)).toBe(true);
    await expect(prepareDatabase(env.db, { production: true })).rejects.toThrow(/logs in as the owner of its tables/);
    expect(await prepareDatabase(env.db, { production: false })).toEqual([]); // development and tests: the owner migrates
  });

  it("a SCRAM verifier is computed as libpq does (RFC 7677 test vector shape) and never contains the password", () => {
    const v = scramVerifier("correct-horse-battery-staple-0123456789", Buffer.alloc(16, 7));
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
    expect(v).not.toContain("correct-horse");
    expect(scramVerifier("correct-horse-battery-staple-0123456789", Buffer.alloc(16, 7))).toBe(v); // deterministic for a salt
    expect(() => scramVerifier("has a space")).toThrow(/printable ASCII/);
  });
});

describe.skipIf(!PG)("the application as a runtime login that owns nothing (PostgreSQL, E19)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv(undefined, {}, { runtimeLogin: true });
  });
  afterAll(() => env.db.close());

  it("is not the owner and starts in production on a current schema", async () => {
    expect(await loginOwnsSchema(env.db)).toBe(false);
    expect(await prepareDatabase(env.db, { production: true })).toEqual([]);
  });

  it("runs a whole engagement: request, offer, acceptance, payment, allocation, every step delivered and approved, jobs and the nightly audit check", async () => {
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    expect(req.status).toBe(200);
    const offerId = (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`, { acknowledgeReview: true })).status).toBe(200);
    const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    expect(engagementId).toBeTruthy();
    const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
    const raw = JSON.stringify({ kind: "payment.paid", paymentId: deposit.id, amountFils: deposit.amount, reference: "PSP-RT" });
    const sig = signWebhook("test-secret", raw, Math.floor(env.clock.now.getTime() / 1000));
    expect((await env.app.inject({ method: "POST", url: "/api/webhooks/payments", headers: { "content-type": "application/json", "x-webhook-timestamp": sig.timestamp, "x-webhook-signature": sig.signature }, payload: raw })).statusCode).toBe(200);
    for (const who of ["setup", "corp", "tax"]) {
      for (const a of (await env.call(who, "GET", "/api/partner/home")).body.allocations.filter((x: any) => !x.acceptedAt && x.engagementId === engagementId)) {
        expect((await env.call(who, "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" })).status).toBe(200);
      }
    }
    const byName = new Map([["Example Setup Partners FZ-LLC", "setup"], ["Example Corporate Services LLC", "corp"], ["Example Tax & Accounts LLC", "tax"]]);
    let ops = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const partnerOf = new Map<string, string>(ops.lines.map((l: any) => [l.code, byName.get(l.partner)!]));
    for (const m of ops.milestones) {
      const who = partnerOf.get(m.code)!;
      for (const type of m.evidenceRequired) {
        expect((await env.call(who, "POST", `/api/milestones/${m.id}/evidence`, { type, fileName: `${type}.pdf`, contentBase64: Buffer.from("%PDF-1.4 test").toString("base64") })).status).toBe(200);
      }
      expect((await env.call(who, "POST", `/api/milestones/${m.id}/submit`)).status).toBe(200);
      expect((await env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true })).status).toBe(200);
      expect((await env.call("client", "POST", `/api/milestones/${m.id}/review`, { approve: true })).status).toBe(200);
    }
    ops = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    expect(ops.engagement.status).toBe("completed");
    const jobs = await runJobs(env.db, { notify: env.notify, storage: env.storage, provider: env.provider });
    expect(jobs.errors).toEqual([]);
    expect(await asPlatform(env.db, null, (tx) => nightlyAuditCheck(tx))).toBe(0); // no break in the chain
  });

  it("cannot leave the per-request role, read without one, change the audit trail or switch off a guard", async () => {
    // Without a role the login reads nothing, and RESET ROLE inside a request leaves it with nothing either.
    await expect(env.db.transaction((tx) => tx.query("select count(*) from offers"))).rejects.toThrow(/permission denied/);
    await expect(asPlatform(env.db, null, async (tx) => {
      await tx.query("reset role");
      return tx.query("select count(*) from offers");
    })).rejects.toThrow(/permission denied/);
    // The audit trail, the fee evidence guard and the role grants are out of its reach.
    await expect(asPlatform(env.db, null, (tx) => tx.query("update audit_events set data = '{}'::jsonb where id = (select max(id) from audit_events)"))).rejects.toThrow(/permission denied|append-only/);
    await expect(asPlatform(env.db, null, (tx) => tx.query("alter table audit_events disable trigger audit_events_no_change"))).rejects.toThrow(/must be owner/);
    await expect(asPlatform(env.db, null, (tx) => tx.query("alter table offer_lines disable trigger offer_lines_fee_evidence"))).rejects.toThrow(/must be owner/);
    await expect(env.db.transaction((tx) => tx.query("create role sneaky login"))).rejects.toThrow(/permission denied/);
  });
});

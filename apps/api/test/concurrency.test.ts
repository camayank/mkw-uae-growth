import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * O13: requests that arrive at the same moment. On PGlite they queue; in CI the same tests run on PostgreSQL 16, where
 * they truly overlap. Either way one wins, the other is refused or gets the first answer, and nothing is created twice.
 */
const rows = <T = any>(env: TestEnv, sql: string, params: unknown[] = []) => asPlatform(env.db, null, async (tx) => (await tx.query<T & Record<string, unknown>>(sql, params)).rows);
const partnerKey = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");
const both = <T>(a: Promise<T>, b: Promise<T>) => Promise.all([a, b]);
const statuses = (rs: Array<{ status: number }>) => rs.map((r) => r.status).sort();
const pdf = Buffer.from("%PDF-1.4 test").toString("base64");

describe("at the same moment", () => {
  let env: TestEnv;
  let offerId: string;
  let engagementId: string;
  beforeAll(async () => {
    env = await makeEnv();
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    offerId = (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
  });
  afterAll(() => env.db.close());

  it("two acceptances of one offer make one engagement", async () => {
    const rs = await both(env.call("client", "POST", `/api/client/offers/${offerId}/accept`), env.call("client", "POST", `/api/client/offers/${offerId}/accept`));
    expect(statuses(rs)).toEqual([200, 409]);
    engagementId = rs.find((r) => r.status === 200)!.body.engagementId;
    expect(await rows(env, "select count(*)::int as n from engagements where offer_id = $1", [offerId])).toEqual([{ n: 1 }]);
    expect(await rows(env, "select count(*)::int as n from payments where engagement_id = $1 and kind = 'deposit'", [engagementId])).toEqual([{ n: 1 }]);
  });

  it("the deposit recorded twice at once is paid once: one invoice, one allocation run", async () => {
    const deposit = (await rows(env, "select id from payments where engagement_id = $1 and kind = 'deposit'", [engagementId]))[0].id;
    const rs = await both(
      env.call("finance", "POST", `/api/ops/payments/${deposit}/mark-paid`, { reference: "BANK-TT-1" }),
      env.call("finance", "POST", `/api/ops/payments/${deposit}/mark-paid`, { reference: "BANK-TT-1" }),
    );
    expect(statuses(rs)).toEqual([200, 200]); // the second finds it paid: webhooks may repeat
    expect(await rows(env, "select count(*)::int as n from audit_events where action = 'payment.paid' and entity_id = $1", [deposit])).toEqual([{ n: 1 }]);
    expect(await rows(env, "select count(*)::int as n from invoices where payment_id = $1", [deposit])).toEqual([{ n: 1 }]);
    const allocations = await rows(env, "select codes from allocations where engagement_id = $1", [engagementId]);
    const codes = allocations.flatMap((a) => a.codes as string[]);
    expect(new Set(codes).size).toBe(codes.length); // no line offered twice
  });

  it("two answers to one allocation accept it once and create its steps once", async () => {
    const e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const [first, ...rest] = e.allocations;
    const who = partnerKey(first.partner);
    const rs = await both(
      env.call(who, "POST", `/api/allocations/${first.id}/respond`, { decision: "accept" }),
      env.call(who, "POST", `/api/allocations/${first.id}/respond`, { decision: "accept" }),
    );
    expect(statuses(rs)).toEqual([200, 409]);
    for (const a of rest) await env.call(partnerKey(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
    const dupes = await rows(env, "select code, name, partner_org_id, count(*)::int as n from milestones where engagement_id = $1 group by 1, 2, 3 having count(*) > 1", [engagementId]);
    expect(dupes).toEqual([]);
    expect(await rows(env, "select count(*)::int as n from payouts where engagement_id = $1 and stage = 'kickoff' group by partner_org_id having count(*) > 1", [engagementId])).toEqual([]);
  });

  it("two QA decisions on one step: one passes, the other is refused", async () => {
    const e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    const m = e.milestones[0];
    const who = partnerKey(e.lines.find((l: any) => l.code === m.code).partner);
    for (const type of m.evidenceRequired?.length ? m.evidenceRequired : ["document"]) {
      await env.call(who, "POST", `/api/milestones/${m.id}/evidence`, { type, fileName: "proof.pdf", contentBase64: pdf });
    }
    expect((await env.call(who, "POST", `/api/milestones/${m.id}/submit`)).status).toBe(200);
    const rs = await both(env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true }), env.call("ops", "POST", `/api/ops/milestones/${m.id}/qa`, { pass: true }));
    expect(statuses(rs)).toEqual([200, 409]);
    expect(await rows(env, "select count(*)::int as n from audit_events where action = 'milestone.qa_passed' and entity_id = $1", [m.id])).toEqual([{ n: 1 }]);
  });

  it("two releases of one payout release it once", async () => {
    const payout = (await rows(env, "insert into payouts (engagement_id, partner_org_id, stage, amount_fils, status) values ($1, $2, 'change_order', 212000, 'eligible') returning id", [engagementId, env.ids.partnerOrgIds[0]]))[0].id;
    expect((await env.call("setup", "POST", `/api/payouts/${payout}/invoice`, { number: "V-RACE-1", amountAed: 2120, vatAed: 106, fileName: "v.pdf", contentBase64: pdf })).status).toBe(200);
    const rs = await both(env.call("finance", "POST", `/api/ops/payouts/${payout}/release`), env.call("finance", "POST", `/api/ops/payouts/${payout}/release`));
    expect(statuses(rs)).toEqual([200, 409]);
    expect(await rows(env, "select count(*)::int as n from audit_events where action = 'payout.released' and entity_id = $1", [payout])).toEqual([{ n: 1 }]);
  });

  it("two payout runs at once: one run, every payout in it once", async () => {
    for (const who of ["setup", "corp", "tax"]) await env.call(who, "PUT", "/api/partner/bank", { beneficiary: `${who} LLC`, iban: "AE07 0331 2345 6789 0123 456", bank: "Emirates NBD" });
    const payout = (await rows(env, "insert into payouts (engagement_id, partner_org_id, stage, amount_fils, status) values ($1, $2, 'change_order', 100000, 'eligible') returning id", [engagementId, env.ids.partnerOrgIds[0]]))[0].id;
    await env.call("setup", "POST", `/api/payouts/${payout}/invoice`, { number: "V-RACE-2", amountAed: 1000, vatAed: 50, fileName: "v.pdf", contentBase64: pdf });
    const rs = await both(env.call("finance", "POST", "/api/ops/payout-runs"), env.call("finance", "POST", "/api/ops/payout-runs"));
    expect(statuses(rs)).toEqual([200, 409]);
    expect(await rows(env, "select count(*)::int as n from payout_runs")).toEqual([{ n: 1 }]);
    expect(await rows(env, "select run_id is not null as in_run from payouts where id = $1", [payout])).toEqual([{ in_run: true }]);
  });

  it("two deposits paid at once never give a partner more work than its capacity", async () => {
    const engagements: string[] = [];
    for (let i = 0; i < 2; i++) {
      const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 0 } });
      const offer = (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
      await env.call("ops", "POST", `/api/ops/offers/${offer}/publish`);
      engagements.push((await env.call("client", "POST", `/api/client/offers/${offer}/accept`)).body.engagementId);
    }
    // Room for exactly one more engagement across every partner.
    const live = `(select count(distinct a.engagement_id) from allocations a join engagements e on e.id = a.engagement_id
       where a.partner_org_id = o.id and (a.accepted_at is not null or (a.declined_at is null and a.timed_out_at is null))
         and e.status in ('allocating', 'in_delivery', 'disputed'))`;
    await rows(env, `update orgs o set profile = jsonb_set(profile, '{capacity}', to_jsonb(${live} + case when o.id = $1 then 1 else 0 end)) where type = 'partner'`, [env.ids.partnerOrgIds[0]]);
    const deposits = await rows(env, "select id from payments where engagement_id = any($1::uuid[]) and kind = 'deposit'", [engagements]);
    await both(...(deposits.map((d) => env.call("finance", "POST", `/api/ops/payments/${d.id}/mark-paid`, { reference: `TT-${d.id.slice(0, 6)}` })) as [Promise<any>, Promise<any>]));
    const over = await rows(env, `select o.name from orgs o where type = 'partner' and ${live} > (o.profile->>'capacity')::int`);
    expect(over).toEqual([]);
    const allocated = await rows(env, "select count(distinct engagement_id)::int as n from allocations where engagement_id = any($1::uuid[])", [engagements]);
    expect(allocated).toEqual([{ n: 1 }]);
  });

  it("the same idempotency key twice at once creates one request", async () => {
    const before = (await rows(env, "select count(*)::int as n from requests"))[0].n;
    const body = { answers: { mode: "services", emirate: "Dubai", services: ["vat_registration"] } };
    const rs = await both(
      env.send("client", "POST", "/api/requests", body, { "idempotency-key": "race-key-000001" }),
      env.send("client", "POST", "/api/requests", body, { "idempotency-key": "race-key-000001" }),
    );
    // The second either waited for the first answer (a replay) or was told the first is still running.
    expect(rs.map((r) => r.status).sort()).toSatisfy((s: number[]) => (s[0] === 200 && s[1] === 200) || (s[0] === 200 && s[1] === 409));
    expect((await rows(env, "select count(*)::int as n from requests"))[0].n).toBe(before + 1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser, type SessionUser } from "../src/lib/context.ts";
import { createSession, sha256 } from "../src/lib/auth.ts";
import { signWebhook } from "../src/lib/payments.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E19: what each party may read of an engagement it shares with others. The first two tests were written before the
 * fix and failed on `main` at 95ee18d (`docs/evidence/E19/before-fix.txt`): a partner firm read the cost another firm
 * put on its change order, and partner staff were sent payouts, payout lines and rate-card figures although the spec
 * gives them no money figure (PRODUCT_SPEC, roles).
 */
const NO_MONEY = /amount|payout|professional|govStated|thirdParty|partnerUnit|partner_fils|clientUnit|margin/i;

describe("role isolation (E19)", () => {
  let env: TestEnv;
  let engagementId: string;
  let offerId: string;
  let partners: string[];
  beforeAll(async () => {
    env = await makeEnv();
    // One engagement delivered by more than one partner firm: a licence, a bank account and VAT returns.
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1, addOns: ["BANK-ACC", "VAT-RET"] } });
    offerId = (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0];
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`, { acknowledgeReview: true })).status).toBe(200);
    engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    const deposit = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body.payments.find((p: any) => p.kind === "deposit");
    const raw = JSON.stringify({ kind: "payment.paid", paymentId: deposit.id, amountFils: deposit.amount, reference: "PSP-E19" });
    const sig = signWebhook("test-secret", raw, Math.floor(env.clock.now.getTime() / 1000));
    await env.app.inject({ method: "POST", url: "/api/webhooks/payments", headers: { "content-type": "application/json", "x-webhook-timestamp": sig.timestamp, "x-webhook-signature": sig.signature }, payload: raw });
    const accepted = new Set<string>();
    for (const who of ["setup", "corp", "tax"]) {
      for (const a of (await env.call(who, "GET", "/api/partner/home")).body.allocations.filter((x: any) => !x.acceptedAt && x.engagementId === engagementId)) {
        if ((await env.call(who, "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" })).status === 200) accepted.add(who);
      }
    }
    partners = [...accepted];
  });
  afterAll(() => env.db.close());

  const me = async (who: string) => (await env.call(who, "GET", "/api/me")).body as SessionUser;

  it("one partner firm never reads the cost another firm put on its change order, at the database or over the API", async () => {
    expect(partners.length).toBeGreaterThanOrEqual(2);
    const [raiser, other] = partners as [string, string];
    const co = await env.call(raiser, "POST", `/api/engagements/${engagementId}/change-orders`, { description: "Extra filing for the raiser only", partnerCostAed: 1_234 });
    expect(co.status).toBe(200);
    // The firm that raised it sees it, with its own cost.
    const own = (await env.call(raiser, "GET", `/api/engagements/${engagementId}`)).body.changeOrders;
    expect(own).toEqual([expect.objectContaining({ description: "Extra filing for the raiser only", partner: 123_400 })]);
    // The other firm on the same engagement sees neither the change order nor its figure.
    const theirs = await env.call(other, "GET", `/api/engagements/${engagementId}`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.changeOrders).toEqual([]);
    expect(JSON.stringify(theirs.body)).not.toContain("123400");
    const otherUser = await me(other);
    const rows = await asUser(env.db, otherUser, (tx) => tx.query("select id, partner_fils from change_orders where engagement_id = $1", [engagementId]));
    expect(rows.rows).toEqual([]);
    // The client still sees the change order (once priced, its own price; never the partner's cost).
    const client = (await env.call("client", "GET", `/api/engagements/${engagementId}`)).body.changeOrders;
    expect(client).toHaveLength(1);
    expect(JSON.stringify(client)).not.toContain("123400");
  });

  it("partner staff are sent no money figure: work, dashboard, engagement and rate card", async () => {
    // The admin of the same firm still sees the firm's figures.
    const admin = (await env.call("setup", "GET", "/api/partner/home")).body;
    expect(admin.allocations.some((a: any) => a.payoutTotal > 0)).toBe(true);
    expect(admin.rateCards.some((c: any) => c.professional > 0)).toBe(true);
    // Staff of that firm get the work, without a figure.
    const home = await env.call("setupStaff", "GET", "/api/partner/home");
    expect(home.status).toBe(200);
    expect(home.body.allocations.length).toBeGreaterThan(0);
    expect(home.body.rateCards.length).toBeGreaterThan(0);
    // The lists keep their shape for the screens, empty where every entry is a figure.
    const { payouts, ...rest } = home.body;
    expect(payouts).toEqual([]);
    expect(JSON.stringify(rest)).not.toMatch(NO_MONEY);
    const dash = await env.call("setupStaff", "GET", "/api/partner/dashboard");
    expect(dash.status).toBe(200);
    const { payouts: dashPayouts, ...dashRest } = dash.body;
    expect(dashPayouts).toEqual([]);
    expect(JSON.stringify(dashRest)).not.toMatch(NO_MONEY);
    expect(partners).toContain("setup"); // the staff below belong to this firm, which delivers part of the engagement
    {
      const eng = await env.call("setupStaff", "GET", `/api/engagements/${engagementId}`);
      expect(eng.status).toBe(200);
      expect(eng.body.milestones.length).toBeGreaterThan(0);
      const { payouts: engPayouts, ...engRest } = eng.body;
      expect(engPayouts).toEqual([]);
      expect(JSON.stringify(engRest)).not.toMatch(/"amount"|payout|partner_fils|"partner":\d|partnerUnit|clientUnit|govUnit|margin/i);
    }
  });

  it("a client member reads the offer and the engagement with the owner's figures and never a partner's cost or margin", async () => {
    const offer = await env.call("clientMember", "GET", `/api/client/offers/${offerId}`);
    expect(offer.status).toBe(200);
    expect(offer.body.clientTotal).toBeGreaterThan(0);
    expect(JSON.stringify(offer.body)).not.toMatch(/margin|partnerUnit|partner_unit|payout|capUnit|cap_unit|partnerCost/i);
    const eng = await env.call("clientMember", "GET", `/api/engagements/${engagementId}`);
    expect(eng.status).toBe(200);
    expect(JSON.stringify(eng.body)).not.toMatch(/margin|partnerUnit|partner_unit|payout|capUnit|"partner":\d/i);
    const statement = await env.call("clientMember", "GET", "/api/client/statement");
    expect(statement.status).toBe(200);
    expect(JSON.stringify(statement.body)).not.toMatch(/margin|partnerUnit|payout/i);
  });

  it("signing out ends that session only; a session past its expiry is refused", async () => {
    const email = "founder@sample-client.test";
    const a = await createSession(env.db, email);
    const b = await createSession(env.db, email);
    const meWith = (token: string) => env.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    expect((await meWith(a)).statusCode).toBe(200);
    const out = await env.app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${a}` } });
    expect(out.statusCode).toBe(200);
    expect((await meWith(a)).statusCode).toBe(401);
    expect((await meWith(b)).statusCode).toBe(200); // another device stays signed in
    // Expiry is the database's: a session whose time has passed is refused, even with a valid token.
    await asPlatform(env.db, null, (tx) => tx.query("update sessions set expires_at = now() - interval '1 minute' where token_hash = $1", [sha256(b)]));
    expect((await meWith(b)).statusCode).toBe(401);
  });
});

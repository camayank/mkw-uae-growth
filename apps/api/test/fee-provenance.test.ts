import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { verifyAuditChain } from "../src/lib/audit.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E18: a quoted government fee keeps the evidence it was quoted on. These four tests were written first and run against
 * the code before E18 (`docs/evidence/E18/before-fix.txt`): the client's disclosure followed MKW's fee table as it is
 * today rather than as it was at quotation, the PDF said nothing about where a fee came from, and an ops price change
 * cleared a fee that still needed a decision.
 */
const ANSWERS = { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 };
const CODE = "SET-FZ-LIC";

describe("government fee provenance: the defects (E18)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  const build = async () => {
    const req = await env.call("client", "POST", "/api/requests", { answers: ANSWERS });
    return (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] })).body.offerIds[0] as string;
  };
  const proposal = async (offerId: string) => (await env.call("client", "GET", `/api/client/offers/${offerId}`)).body;
  const pdfText = async (offerId: string) => (await env.app.inject({ method: "GET", url: `/api/client/offers/${offerId}/pdf`, headers: { authorization: `Bearer ${env.tokens.client}` } })).body;
  const addFee = async (feeAed: number) => (await env.call("ops", "POST", "/api/admin/fees", { code: CODE, emirate: "Dubai", feeAed, sourceUrl: "https://example.gov.ae/fees" })).body.id as string;
  const verify = (id: string) => env.call("founder", "POST", `/api/admin/fees/${id}/verify`, { verifiedBy: "A. Verifier" });
  const retireAll = async () => {
    for (const f of (await env.call("ops", "GET", "/api/admin/fees")).body.fees.filter((x: any) => x.code === CODE && !x.retiredAt)) {
      await env.call("ops", "POST", `/api/admin/fees/${f.id}/retire`, { reason: "test reset" });
    }
  };

  it("a fee quoted as the partner stated it keeps that disclosure after MKW verifies a fee record for it", async () => {
    await retireAll();
    const offerId = await build();
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`)).status).toBe(200);
    const before = await proposal(offerId);
    const note = before.proposal.feeNotes[CODE];
    expect(note).toBeTruthy();
    // After publication, MKW records and verifies the authority's fee, at a different amount.
    expect((await verify(await addFee(7_777))).status).toBe(200);
    const after = await proposal(offerId);
    expect(after.government).toBe(before.government); // the quoted amount never changed
    expect(after.proposal.feeNotes[CODE]).toBe(note); // so neither may what the client is told about it
    await retireAll();
  });

  it("a fee quoted from an unverified record keeps its estimate disclosure after the record is verified", async () => {
    await retireAll();
    const feeId = await addFee(9_000);
    const offerId = await build();
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`, { acknowledgeReview: true })).status).toBe(200);
    const note = (await proposal(offerId)).proposal.feeNotes[CODE];
    expect(note).toMatch(/estimate/i);
    expect((await verify(feeId)).status).toBe(200);
    expect((await proposal(offerId)).proposal.feeNotes[CODE]).toBe(note);
    await retireAll();
  });

  it("the downloadable offer says what the online proposal says about each government fee", async () => {
    await retireAll();
    const offerId = await build();
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`)).status).toBe(200);
    const note: string = (await proposal(offerId)).proposal.feeNotes[CODE];
    expect(note).toBeTruthy();
    expect(await pdfText(offerId)).toContain(note.slice(0, 40));
  });

  it("an ops price on a line whose government fee needs a decision does not clear that decision", async () => {
    await retireAll();
    await addFee(9_000); // UNCERTAIN: the line goes to review
    const offerId = await build();
    expect((await env.call("ops", "POST", `/api/ops/offers/${offerId}/lines/${CODE}/price`, { clientUnitAed: 6_000 })).status).toBe(200);
    const r = await env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(new RegExp(CODE));
    await retireAll();
  });
});

describe("government fee provenance: twelve scenarios end to end (E18)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(() => env.db.close());

  const sql = <T = any>(q: string, p: unknown[] = []) => asPlatform(env.db, null, async (tx) => (await tx.query<T & Record<string, unknown>>(q, p)).rows);
  const build = async (tiers = ["standard"]) => {
    const req = await env.call("client", "POST", "/api/requests", { answers: ANSWERS });
    return (await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers })).body.offerIds as string[];
  };
  const clientView = async (offerId: string) => (await env.call("client", "GET", `/api/client/offers/${offerId}`)).body;
  const pdf = async (offerId: string, who = "client") => env.app.inject({ method: "GET", url: `/api/client/offers/${offerId}/pdf`, headers: { authorization: `Bearer ${env.tokens[who]}` } });
  // The offer PDF's text, with the PDF string escapes for brackets and backslashes undone.
  const words = (body: string) => body.replace(/\\([()\\])/g, "$1");
  const addFee = async (feeAed: number) => (await env.call("ops", "POST", "/api/admin/fees", { code: CODE, emirate: "Dubai", feeAed, sourceUrl: "https://example.gov.ae/fees" })).body.id as string;
  const verify = (id: string) => env.call("founder", "POST", `/api/admin/fees/${id}/verify`, { verifiedBy: "A. Verifier" });
  const retireAll = async () => {
    for (const f of (await env.call("ops", "GET", "/api/admin/fees")).body.fees.filter((x: any) => x.code === CODE && !x.retiredAt)) {
      await env.call("ops", "POST", `/api/admin/fees/${f.id}/retire`, { reason: "test reset" });
    }
  };
  const line = async (offerId: string) => (await sql("select * from offer_lines where offer_id = $1 and code = $2", [offerId, CODE]))[0]!;
  const disclosure = async (offerId: string) => (await clientView(offerId)).proposal.feeDisclosures.find((d: any) => d.code === CODE);
  const publish = (offerId: string, acknowledgeReview = false) => env.call("ops", "POST", `/api/ops/offers/${offerId}/publish`, acknowledgeReview ? { acknowledgeReview } : undefined);
  const today = () => env.clock.now.toISOString().slice(0, 10);

  it("1. a partner-stated fee with no MKW record: PARTNER-STATED, recorded as such, and published under the existing rule (no acknowledgement)", async () => {
    await retireAll();
    const [offerId] = await build();
    const l = await line(offerId!);
    expect(l).toMatchObject({ gov_fee_basis: "partner_stated", gov_fee_id: null, gov_fee_review: "none", gov_fee_emirate: "Dubai" });
    expect(String(l.gov_fee_quoted_on instanceof Date ? l.gov_fee_quoted_on.toISOString() : l.gov_fee_quoted_on).slice(0, 10)).toBe(today());
    expect((await publish(offerId!)).status).toBe(200);
    const d = await disclosure(offerId!);
    expect(d).toMatchObject({ label: "PARTNER-STATED", confirmed: false });
    expect(d.text).toMatch(/^Estimate given by the delivery partner firm; MKW Advisors has not yet confirmed it/);
    expect((await clientView(offerId!)).proposal.feeNotes[CODE]).toBe(d.text);
  });

  it("2. a current verified fee: VERIFIED with the date, the record's own amount, no review", async () => {
    await retireAll();
    const feeId = await addFee(8_500);
    expect((await verify(feeId)).status).toBe(200);
    const [offerId] = await build();
    const l = await line(offerId!);
    expect(l).toMatchObject({ gov_fee_basis: "verified", gov_fee_id: feeId, gov_fee_review: "none", gov_fee_verified_by: "A. Verifier", gov_fee_source_url: "https://example.gov.ae/fees" });
    expect(Number(l.gov_unit_fils)).toBe(850_000);
    expect((await publish(offerId!)).status).toBe(200);
    const d = await disclosure(offerId!);
    expect(d).toMatchObject({ label: "VERIFIED", confirmed: true });
    expect(d.text).toContain(`verified on ${today()}`);
    expect((await clientView(offerId!)).proposal.feeNotes[CODE]).toBeUndefined(); // a verified fee needs no estimate note
    await retireAll();
  });

  it("3. an unverified fee: UNCERTAIN, refused without an acknowledgement, and the acknowledgement is recorded once with who and when", async () => {
    await retireAll();
    await addFee(9_000);
    const [offerId] = await build();
    expect((await line(offerId!)).gov_fee_review).toBe("required");
    expect((await publish(offerId!)).status).toBe(409);
    expect((await publish(offerId!, true)).status).toBe(200);
    const ops = (await env.call("ops", "GET", "/api/me")).body;
    const l = await line(offerId!);
    expect(l.gov_fee_review).toBe("acknowledged");
    expect(l.gov_fee_ack_by).toBe(ops.id);
    expect(l.gov_fee_ack_at).toBeTruthy();
    expect((await disclosure(offerId!)).label).toBe("UNCERTAIN");
    // The acknowledgement cannot be rewritten afterwards, even by the platform.
    await expect(sql("update offer_lines set gov_fee_ack_at = now() - interval '1 day' where id = $1", [l.id])).rejects.toThrow(/not changed once recorded/);
    await retireAll();
  });

  it("4. a stale verified fee: STALE with the date it was last verified, and it needs an acknowledgement", async () => {
    await retireAll();
    const feeId = await addFee(8_800);
    expect((await verify(feeId)).status).toBe(200);
    await sql("update government_fees set verified_at = ($1::date - 91) where id = $2", [today(), feeId]);
    const [offerId] = await build();
    expect(await line(offerId!)).toMatchObject({ gov_fee_basis: "stale", gov_fee_review: "required" });
    expect((await publish(offerId!)).status).toBe(409);
    expect((await publish(offerId!, true)).status).toBe(200);
    const d = await disclosure(offerId!);
    expect(d.label).toBe("STALE");
    expect(d.text).toMatch(/last verified this fee on \d{4}-\d{2}-\d{2}, more than 90 days before this offer/);
    await retireAll();
  });

  it("5 and 8. a record created after publication changes neither the online proposal nor the PDF, byte for byte", async () => {
    await retireAll();
    const [offerId] = await build();
    expect((await publish(offerId!)).status).toBe(200);
    const before = { view: await clientView(offerId!), pdf: (await pdf(offerId!)).body };
    expect((await verify(await addFee(7_000))).status).toBe(200);
    const after = { view: await clientView(offerId!), pdf: (await pdf(offerId!)).body };
    expect(after.view.proposal.feeDisclosures).toEqual(before.view.proposal.feeDisclosures);
    expect(after.view.government).toBe(before.view.government);
    expect(after.pdf).toBe(before.pdf);
    // And the PDF says what the screen says: each fee's label and the first line of its sentence.
    for (const d of after.view.proposal.feeDisclosures) {
      expect(words(after.pdf)).toContain(`(${d.label})`);
      expect(words(after.pdf)).toContain(d.text.slice(0, 50));
    }
    expect(after.pdf).not.toMatch(/as published on the offer date/);
    await retireAll();
  });

  it("6. a record retired and replaced by a different verified amount after publication leaves the quotation as it was", async () => {
    await retireAll();
    const feeId = await addFee(8_500);
    expect((await verify(feeId)).status).toBe(200);
    const [offerId] = await build();
    expect((await publish(offerId!)).status).toBe(200);
    const before = await disclosure(offerId!);
    await retireAll();
    expect((await verify(await addFee(9_900))).status).toBe(200);
    expect(await disclosure(offerId!)).toEqual(before);
    expect(Number((await line(offerId!)).gov_unit_fils)).toBe(850_000);
    expect((await line(offerId!)).gov_fee_id).toBe(feeId); // still points at the record it was quoted on
    // Nobody can rewrite a quoted fee or its evidence in place, not even the platform's own role.
    await expect(sql("update offer_lines set gov_unit_fils = 990000 where offer_id = $1", [offerId])).rejects.toThrow(/not changed after pricing/);
    await expect(sql("update offer_lines set gov_fee_basis = 'partner_stated' where offer_id = $1", [offerId])).rejects.toThrow(/not changed after pricing/);
    await retireAll();
  });

  it("7. an offer accepted before the fee table changes: the acceptance records the disclosures the client accepted, and they still match", async () => {
    await retireAll();
    await addFee(9_000);
    const [offerId] = await build();
    expect((await publish(offerId!, true)).status).toBe(200);
    const shown = (await clientView(offerId!)).proposal.feeDisclosures;
    const engagementId = (await env.call("client", "POST", `/api/client/offers/${offerId}/accept`)).body.engagementId;
    expect(engagementId).toBeTruthy();
    await retireAll();
    expect((await verify(await addFee(9_500))).status).toBe(200);
    const ev = (await sql("select data from audit_events where action = 'offer.accepted' and entity_id = $1", [engagementId]))[0]!;
    expect(ev.data.governmentFees).toEqual(shown.map((d: any) => ({ code: d.code, label: d.label, text: d.text })));
    expect((await clientView(offerId!)).proposal.feeDisclosures).toEqual(shown);
    // The engagement carries the quoted amount, not today's table.
    const el = (await sql("select gov_unit_fils from engagement_lines where engagement_id = $1 and code = $2", [engagementId, CODE]))[0]!;
    expect(Number(el.gov_unit_fils)).toBe(900_000);
    await retireAll();
  });

  it("9. an offer priced before E18 has no recorded basis: LEGACY everywhere, never verified, and no evidence can be added to it later", async () => {
    await retireAll();
    const feeId = await addFee(8_500);
    expect((await verify(feeId)).status).toBe(200); // a verified record exists today, which must not make the old line verified
    const [offerId] = await build();
    // Model a line priced before migration 023: the evidence columns empty. Done as the database owner with the guard
    // off, as the migration found every older row.
    await env.db.transaction(async (tx) => {
      await tx.query("alter table offer_lines disable trigger offer_lines_fee_evidence");
      await tx.query(
        `update offer_lines set gov_fee_basis = null, gov_fee_id = null, gov_fee_emirate = null, gov_fee_free_zone = null, gov_fee_source_url = null,
           gov_fee_verified_by = null, gov_fee_verified_at = null, gov_fee_quoted_on = null, gov_fee_review = null where offer_id = $1`,
        [offerId],
      );
      await tx.query("alter table offer_lines enable trigger offer_lines_fee_evidence");
    });
    expect((await publish(offerId!)).status).toBe(200);
    const d = await disclosure(offerId!);
    expect(d).toMatchObject({ label: "LEGACY", confirmed: false });
    expect(d.text).toMatch(/^Estimate: this offer was prepared before MKW Advisors recorded/);
    expect(words((await pdf(offerId!)).body)).toContain("(LEGACY)");
    const ops = (await env.call("ops", "GET", `/api/ops/offers/${offerId}`)).body;
    expect(ops.lines.find((l: any) => l.code === CODE).govFee).toMatchObject({ basis: null, disclosure: { label: "LEGACY" } });
    // Evidence cannot be back-filled: that would present an old quotation as checked.
    await expect(sql("update offer_lines set gov_fee_basis = 'verified' where offer_id = $1", [offerId])).rejects.toThrow(/not changed after pricing/);
    await retireAll();
  });

  it("10. no one reads more than their role allows: the client gets the label and sentence only, partners nothing", async () => {
    await retireAll();
    await addFee(9_000);
    const [offerId] = await build();
    expect((await publish(offerId!, true)).status).toBe(200);
    const view = await clientView(offerId!);
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/margin|partnerUnit|partner_unit|payout|capUnit|cap_unit|A\. Verifier|example\.gov\.ae|gov_fee_id|recordId|ack/i);
    expect(Object.keys(view.proposal.feeDisclosures[0]).sort()).toEqual(["code", "confirmed", "label", "text"]);
    // At the database the client role is granted none of the evidence columns.
    const client = (await env.call("client", "GET", "/api/me")).body;
    await expect(asUser(env.db, client, (tx) => tx.query("select gov_fee_verified_by from offer_lines where offer_id = $1", [offerId]))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, client, (tx) => tx.query("select gov_fee_basis from offer_lines where offer_id = $1", [offerId]))).rejects.toThrow(/permission denied/);
    // Partners never see a client's offer, its PDF or MKW's review of it.
    expect((await env.call("setup", "GET", `/api/client/offers/${offerId}`)).status).toBe(403);
    expect((await pdf(offerId!, "setup")).statusCode).toBe(403);
    expect((await env.call("setup", "GET", `/api/ops/offers/${offerId}`)).status).toBe(403);
    expect((await env.call("client", "GET", `/api/ops/offers/${offerId}`)).status).toBe(403);
    // Ops see the evidence but still never the margin.
    const ops = (await env.call("ops", "GET", `/api/ops/offers/${offerId}`)).body;
    const l = ops.lines.find((x: any) => x.code === CODE);
    expect(l.govFee).toMatchObject({ basis: "uncertain", review: "acknowledged", sourceUrl: "https://example.gov.ae/fees" });
    expect(l).not.toHaveProperty("marginUnit");
    expect(ops).not.toHaveProperty("margin");
    await retireAll();
  });

  it("11. two publications at the same moment: one wins, the fee acknowledgement and the audit event are written once", async () => {
    await retireAll();
    await addFee(9_000);
    const [offerId] = await build();
    const results = await Promise.all([publish(offerId!, true), publish(offerId!, true)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await sql("select count(*)::int as n from audit_events where action = 'offer.published' and entity_id = $1", [offerId]))[0]!.n).toBe(1);
    expect((await line(offerId!)).gov_fee_review).toBe("acknowledged");
    await retireAll();
  });

  it("12. the money reconciles and the audit chain records each fee's evidence and holds", async () => {
    await retireAll();
    await addFee(9_000);
    const [offerId] = await build();
    expect((await publish(offerId!, true)).status).toBe(200);
    const lines = await sql("select code, qty, gov_unit_fils, gov_fee_basis from offer_lines where offer_id = $1", [offerId]);
    const offer = (await sql("select government_fils, client_total_fils, professional_fils, mkw_fees_fils, vat_fils from offers where id = $1", [offerId]))[0]!;
    expect(lines.reduce((s, l) => s + Number(l.qty) * Number(l.gov_unit_fils), 0)).toBe(Number(offer.government_fils));
    expect(Number(offer.client_total_fils)).toBe(Number(offer.professional_fils) + Number(offer.mkw_fees_fils) + Number(offer.vat_fils) + Number(offer.government_fils));
    const p = (await clientView(offerId!)).proposal;
    expect(p.depositFils + p.balanceFils).toBe(Number(offer.client_total_fils));
    const built = (await sql("select data from audit_events where action = 'offer.built' and entity_id = $1", [offerId]))[0]!;
    const byCode = (xs: any[]) => [...xs].sort((a, b) => String(a.code).localeCompare(String(b.code)));
    expect(byCode(built.data.governmentFees.map(({ feeId: _f, ...rest }: any) => rest))).toEqual(byCode(lines.map((l) => ({ code: l.code, unitFils: Number(l.gov_unit_fils), basis: l.gov_fee_basis }))));
    expect(built.data.governmentFees.find((g: any) => g.code === CODE).feeId).toBeTruthy();
    const published = (await sql("select data from audit_events where action = 'offer.published' and entity_id = $1", [offerId]))[0]!;
    expect(published.data.governmentFees).toEqual(p.feeDisclosures.map((d: any) => ({ code: d.code, label: d.label })));
    expect(published.data.acknowledgedLines).toEqual([expect.objectContaining({ code: CODE, govFeeBasis: "uncertain" })]);
    expect((await asPlatform(env.db, null, (tx) => verifyAuditChain(tx))).brokenId).toBeNull();
    await retireAll();
  });
});

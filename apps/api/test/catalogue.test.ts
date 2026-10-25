import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ceilTo, floorTo, applyBp } from "@tasees/core";
import { asPlatform, asUser } from "../src/lib/context.ts";
import { CATALOGUE_EXTENSION, STARTER_ROWS } from "../src/db/catalogue.ts";
import { DELIVERABLES } from "../src/db/seed-data.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * O4: the full catalogue, the government fee table with verification and staleness, margin rules with effective
 * dates, and the Offer Builder rule reproduced through the API for ten sample requests.
 */
describe("catalogue", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("loads all 83 Service Catalogue services as 82 codes, each with a category rule and evidence", async () => {
    const cat = await env.call("finance", "GET", "/api/admin/catalogue");
    expect(cat.status).toBe(200);
    expect(cat.body).toHaveLength(DELIVERABLES.length + CATALOGUE_EXTENSION.length);
    expect(cat.body).toHaveLength(82);
    const rows = new Set<number>();
    for (const c of CATALOGUE_EXTENSION) rows.add(c[9]);
    for (const list of Object.values(STARTER_ROWS)) for (const r of list) rows.add(r);
    expect(rows.size).toBe(83);
    expect([...rows].sort((a, b) => a - b)).toEqual(Array.from({ length: 83 }, (_, i) => i + 1));
    for (const d of cat.body) {
      expect(d.rule, `${d.code} has no margin rule`).toBeTruthy();
      expect(d.requiredEvidence.length, `${d.code} has no evidence type`).toBeGreaterThan(0);
      expect(d.marketMid).toBeGreaterThan(0);
      if (d.model === "agent") expect(d.requires.length, `${d.code} is agent model but names no licence requirement`).toBeGreaterThan(0);
    }
    const codes = cat.body.map((d: any) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    // A client sees the catalogue list it always saw (name, category, model, billing), nothing about rules.
    const client = await env.call("client", "GET", "/api/deliverables");
    expect(client.body).toHaveLength(82);
    expect(client.body[0]).not.toHaveProperty("rule");
  });

  it("marks the five new categories' rules as defaults the owner must confirm, and hides rates from ops", async () => {
    expect((await env.call("ops", "GET", "/api/admin/rules")).status).toBe(403);
    const opsCat = await env.call("ops", "GET", "/api/admin/catalogue");
    expect(opsCat.body[0]).not.toHaveProperty("rule");
    const fees = await env.call("ops", "GET", "/api/admin/fees");
    expect(fees.status).toBe(200);
    expect(fees.body).not.toHaveProperty("categories");
    const r = await env.call("finance", "GET", "/api/admin/rules");
    const pc = r.body.categories.find((c: any) => c.category === "Private Client");
    expect(pc.current).toEqual({ rateBp: 2000, floor: 50_000 });
    expect(pc.history[0].note).toMatch(/UNCERTAIN until the owner confirms/);
    const setup = r.body.categories.find((c: any) => c.category === "Setup");
    expect(setup.current).toEqual({ rateBp: 2000, floor: 50_000 });
    expect(setup.codes).toBeGreaterThan(5);
  });

  it("keeps rules, versions and fees away from clients and partners", async () => {
    for (const who of ["client", "setup"]) {
      expect((await env.call(who, "GET", "/api/admin/catalogue")).status).toBe(403);
      expect((await env.call(who, "GET", "/api/admin/rules")).status).toBe(403);
      expect((await env.call(who, "POST", "/api/admin/fees", { code: "SET-FZ-LIC", emirate: "Dubai", feeAed: 1 })).status).toBe(403);
    }
    const client = (await env.call("client", "GET", "/api/me")).body;
    const partner = (await env.call("setup", "GET", "/api/me")).body;
    await expect(asUser(env.db, client, (tx) => tx.query("select * from government_fees"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select * from margin_rule_versions"))).rejects.toThrow(/permission denied/);
    await expect(asUser(env.db, partner, (tx) => tx.query("select * from margin_rules"))).rejects.toThrow(/permission denied/);
    expect((await env.call("ops", "PUT", "/api/admin/rules/Setup", { rateBp: 2500, floorAed: 500, effectiveFrom: "2030-01-01", note: "ops tries" })).status).toBe(403);
    expect((await env.call("finance", "PUT", "/api/admin/rules/Setup", { rateBp: 2500, floorAed: 500, effectiveFrom: "2030-01-01", note: "finance tries" })).status).toBe(403);
  });
});

describe("government fee table", () => {
  let env: TestEnv;
  let requestId: string;
  const build = async () => {
    const r = await env.call("ops", "POST", `/api/ops/requests/${requestId}/build-offers`, { tiers: ["standard"] });
    expect(r.status).toBe(200);
    const offer = await env.call("finance", "GET", `/api/ops/offers/${r.body.offerIds[0]}`);
    return { offer: offer.body, line: offer.body.lines.find((l: any) => l.code === "SET-FZ-LIC") };
  };
  beforeAll(async () => {
    env = await makeEnv();
    // The client typed the zone in lower case; the fee table says "IFZA". Matching must not care.
    requestId = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", freeZone: "ifza", visas: 1 } })).body.id;
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("uses the partner's stated fee, and says so, when the table has no row", async () => {
    const { offer, line } = await build();
    expect(offer.status).toBe("draft");
    expect(line.govUnitFee).toBe(950_000); // AED 9,500 from the chosen rate card
    expect(line.reason).toMatch(/as stated by the partner \(no table row\)/);
    expect(line.status).toBe("ok");
  });

  it("an UNCERTAIN fee replaces the partner's figure and stops the line for a person", async () => {
    const added = await env.call("ops", "POST", "/api/admin/fees", { code: "SET-FZ-LIC", emirate: "Dubai", feeAed: 9_000, sourceUrl: "https://example.gov.ae/fees", sourceNote: "Emirate-wide figure" });
    expect(added.status).toBe(200);
    expect(added.body.confidence).toBe("UNCERTAIN");
    const { offer, line } = await build();
    expect(line.govUnitFee).toBe(900_000);
    expect(line.status).toBe("ops_review");
    expect(line.reason).toMatch(/UNCERTAIN/);
    expect(offer.status).toBe("ops_review");
    expect(offer.linesNeedingReview).toBe(1);
    // A client never sees an offer in review; publishing it needs an explicit acknowledgement, which is audited line by line.
    expect((await env.call("client", "GET", `/api/client/offers/${offer.id}`)).status).toBe(404);
    const refused = await env.call("ops", "POST", `/api/ops/offers/${offer.id}/publish`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/SET-FZ-LIC.*UNCERTAIN/);
    expect((await env.call("client", "GET", `/api/client/offers/${offer.id}`)).status).toBe(404);
    expect((await env.call("ops", "POST", `/api/ops/offers/${offer.id}/publish`, { acknowledgeReview: true })).status).toBe(200);
    const ev = await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'offer.published' and entity_id = $1", [offer.id]));
    expect(ev.rows[0].data.acknowledgedLines).toEqual([{ code: "SET-FZ-LIC", reason: expect.stringMatching(/UNCERTAIN/), govUnit: 900_000, clientUnit: expect.any(Number) }]);
  });

  it("a free-zone row beats the emirate row, and a verified row clears the review", async () => {
    const zone = await env.call("ops", "POST", "/api/admin/fees", { code: "SET-FZ-LIC", emirate: "Dubai", freeZone: "IFZA", feeAed: 8_900, sourceUrl: "https://ifza.example/fees", sourceNote: "IFZA 1 visa package" });
    expect((await env.call("ops", "POST", `/api/admin/fees/${zone.body.id}/verify`, { verifiedBy: "Ops" })).status).toBe(403);
    const verified = await env.call("founder", "POST", `/api/admin/fees/${zone.body.id}/verify`, { verifiedBy: "A. Qualified, FTA-registered tax agent" });
    expect(verified.status).toBe(200);
    const { offer, line } = await build();
    expect(line.govUnitFee).toBe(890_000);
    expect(line.status).toBe("ok");
    expect(line.reason ?? null).toBeNull();
    expect(offer.status).toBe("draft");
    // Another emirate's request does not see the Dubai rows.
    const other = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Sharjah", visas: 1 } })).body.id;
    const r = await env.call("ops", "POST", `/api/ops/requests/${other}/build-offers`, { tiers: ["standard"] });
    const o = await env.call("finance", "GET", `/api/ops/offers/${r.body.offerIds[0]}`);
    expect(o.body.lines.find((l: any) => l.code === "SET-FZ-LIC").govUnitFee).toBe(950_000);
    const overview = await env.call("ops", "GET", "/api/admin/fees");
    const row = overview.body.fees.find((f: any) => f.id === zone.body.id);
    expect(row).toMatchObject({ confidence: "verified", verifiedBy: "A. Qualified, FTA-registered tax agent", stale: false, freeZone: "IFZA" });
  });

  it("a fee verified more than 90 days ago is stale and goes back to review", async () => {
    // 91 days before the application's clock, not the machine's: the app judges staleness on its own clock.
    await asPlatform(env.db, null, (tx) => tx.query("update government_fees set verified_at = ($1::date - 91) where free_zone = 'IFZA'", [env.clock.now.toISOString().slice(0, 10)]));
    const { offer, line } = await build();
    expect(line.status).toBe("ops_review");
    expect(line.reason).toMatch(/over 90 days ago/);
    expect(offer.status).toBe("ops_review");
    const overview = await env.call("ops", "GET", "/api/admin/fees");
    expect(overview.body.fees.find((f: any) => f.freeZone === "IFZA").stale).toBe(true);
  });

  it("refuses to verify a fee with no source, and retiring a row falls back to the next", async () => {
    const noSource = await env.call("ops", "POST", "/api/admin/fees", { code: "VISA-RES", emirate: "Dubai", feeAed: 3_000 });
    expect((await env.call("founder", "POST", `/api/admin/fees/${noSource.body.id}/verify`, { verifiedBy: "Someone" })).status).toBe(400);
    const overview = await env.call("ops", "GET", "/api/admin/fees");
    const zoneRow = overview.body.fees.find((f: any) => f.freeZone === "IFZA");
    expect((await env.call("ops", "POST", `/api/admin/fees/${zoneRow.id}/retire`, { reason: "Zone changed its package" })).status).toBe(200);
    const { line } = await build();
    expect(line.govUnitFee).toBe(900_000); // back to the emirate-wide UNCERTAIN row
    expect(line.reason).toMatch(/UNCERTAIN/);
    const audits = await asPlatform(env.db, null, (tx) => tx.query<{ action: string }>("select action from audit_events where action like 'fees.%' order by id"));
    expect(audits.rows.map((a) => a.action)).toEqual(["fees.added", "fees.added", "fees.verified", "fees.added", "fees.retired"]);
  });
});

describe("margin rules with effective dates", () => {
  let env: TestEnv;
  let requestId: string;
  beforeAll(async () => {
    env = await makeEnv(new Date("2026-10-19T06:00:00Z"));
    requestId = (await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } })).body.id;
  });
  afterAll(async () => {
    await env.db.close();
  });

  it("applies a scheduled rule only from its date, and earlier offers keep their figures", async () => {
    const first = await env.call("ops", "POST", `/api/ops/requests/${requestId}/build-offers`, { tiers: ["standard"] });
    const before = (await env.call("finance", "GET", `/api/ops/offers/${first.body.offerIds[0]}`)).body;
    const setupLine = before.lines.find((l: any) => l.code === "SET-FZ-LIC");
    expect(setupLine.clientUnitPrice).toBe(ceilTo(Math.max(setupLine.partnerUnitCost + applyBp(setupLine.partnerUnitCost, 2000), setupLine.partnerUnitCost + 50_000), 5_000));

    expect((await env.call("founder", "PUT", "/api/admin/rules/Setup", { rateBp: 3000, floorAed: 1000, effectiveFrom: "2026-10-18", note: "backdated" })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/rules/Setup", { rateBp: 3000, floorAed: 1000, effectiveFrom: "2026-10-19", note: "today: would change a rule already used" })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/rules/Nonsense", { rateBp: 3000, floorAed: 1000, effectiveFrom: "2026-10-20", note: "no such category" })).status).toBe(404);
    const scheduled = await env.call("founder", "PUT", "/api/admin/rules/Setup", { rateBp: 3000, floorAed: 1000, effectiveFrom: "2026-10-20", note: "Owner decision 19 Oct: setup margin to 30% / AED 1,000" });
    expect(scheduled.status).toBe(200);
    const overview = await env.call("founder", "GET", "/api/admin/rules");
    const setup = overview.body.categories.find((c: any) => c.category === "Setup");
    expect(setup.current).toEqual({ rateBp: 2000, floor: 50_000 });
    expect(setup.scheduled).toHaveLength(1);
    expect(setup.scheduled[0]).toMatchObject({ rateBp: 3000, floor: 100_000, effectiveFrom: "2026-10-20" });

    // Still 19 Oct: a rebuild prices on the old rule.
    const same = await env.call("ops", "POST", `/api/ops/requests/${requestId}/build-offers`, { tiers: ["standard"] });
    const stillOld = (await env.call("finance", "GET", `/api/ops/offers/${same.body.offerIds[0]}`)).body;
    expect(stillOld.lines.find((l: any) => l.code === "SET-FZ-LIC").clientUnitPrice).toBe(setupLine.clientUnitPrice);

    // 20 Oct: the new rule is in force; the earlier offer is untouched.
    env.clock.now = new Date("2026-10-20T06:00:00Z");
    const later = await env.call("ops", "POST", `/api/ops/requests/${requestId}/build-offers`, { tiers: ["standard"] });
    const after = (await env.call("finance", "GET", `/api/ops/offers/${later.body.offerIds[0]}`)).body;
    const newLine = after.lines.find((l: any) => l.code === "SET-FZ-LIC");
    expect(newLine.clientUnitPrice).toBe(ceilTo(Math.max(newLine.partnerUnitCost + applyBp(newLine.partnerUnitCost, 3000), newLine.partnerUnitCost + 100_000), 5_000));
    expect(newLine.clientUnitPrice).toBeGreaterThan(setupLine.clientUnitPrice);
    const old = await asPlatform(env.db, null, (tx) => tx.query<any>("select client_unit_fils, (select rules_as_of::text from offers where id = $1) as as_of from offer_lines where offer_id = $1 and code = 'SET-FZ-LIC'", [first.body.offerIds[0]]));
    expect(old.rows[0].client_unit_fils).toBe(setupLine.clientUnitPrice);
    expect(old.rows[0].as_of).toBe("2026-10-19");
    const asOf = await asPlatform(env.db, null, (tx) => tx.query<any>("select rules_as_of::text as d from offers where id = $1", [later.body.offerIds[0]]));
    expect(asOf.rows[0].d).toBe("2026-10-20");
    const ev = await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'rules.margin_scheduled'"));
    expect(ev.rows[0].data).toMatchObject({ before: { rateBp: 2000, floor: 50_000 }, after: { rateBp: 3000, floor: 100_000 }, effectiveFrom: "2026-10-20" });
    // The jobs sweep brings the cached current rule in line.
    const jobs = await env.call("founder", "POST", "/api/ops/jobs/run");
    expect(jobs.body.rulesRefreshed).toBe(1);
    const cached = await asPlatform(env.db, null, (tx) => tx.query<any>("select rate_bp from margin_rules where category = 'Setup'"));
    expect(cached.rows[0].rate_bp).toBe(3000);
    // A change order on an engagement priced under the old rule still uses the old rule.
    const published = await env.call("ops", "POST", `/api/ops/offers/${first.body.offerIds[0]}/publish`);
    expect(published.status).toBe(409); // withdrawn by the later builds: only the latest set is live
    const live = await env.call("ops", "POST", `/api/ops/offers/${later.body.offerIds[0]}/publish`);
    expect(live.status).toBe(200);
  });

  it("lets only the founder change pricing settings, never VAT, with the change audited", async () => {
    expect((await env.call("ops", "PUT", "/api/admin/pricing-settings", { roundToAed: 100, note: "x" })).status).toBe(403);
    expect((await env.call("founder", "PUT", "/api/admin/pricing-settings", { capFactorBp: 50_000, note: "too high" })).status).toBe(400);
    expect((await env.call("founder", "PUT", "/api/admin/pricing-settings", { roundToAed: 7, note: "odd step" })).status).toBe(400);
    const r = await env.call("founder", "PUT", "/api/admin/pricing-settings", { roundToAed: 100, capFactorBp: 13_000, note: "Round to AED 100 for the pilot" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ roundTo: 10_000, capFactorBp: 13_000, vatBp: 500 });
    const built = await env.call("ops", "POST", `/api/ops/requests/${requestId}/build-offers`, { tiers: ["standard"] });
    const offer = (await env.call("finance", "GET", `/api/ops/offers/${built.body.offerIds[0]}`)).body;
    for (const l of offer.lines) if (l.model === "reseller") expect(l.clientUnitPrice % 10_000).toBe(0);
    const ev = await asPlatform(env.db, null, (tx) => tx.query<any>("select data from audit_events where action = 'rules.pricing_settings_changed'"));
    expect(ev.rows[0].data.before.roundTo).toBe(5_000);
    expect(ev.rows[0].data.after.roundTo).toBe(10_000);
  });
});

describe("Offer Builder rule reproduced for ten sample requests", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeEnv();
  });
  afterAll(async () => {
    await env.db.close();
  });

  const SAMPLES: Array<{ name: string; answers: Record<string, unknown> }> = [
    { name: "free zone, 2 visas, bank account", answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 2, addOns: ["BANK-ACC"] } },
    { name: "mainland, 3 visas, 1 dependant", answers: { mode: "new_company", jurisdiction: "mainland", emirate: "Dubai", visas: 3, dependants: 1 } },
    { name: "free zone, no visas, bookkeeping", answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Sharjah", visas: 0, addOns: ["ACC-BOOK"] } },
    { name: "existing company: VAT and CT", answers: { mode: "services", emirate: "Dubai", services: ["VAT-RET", "CT-RET"] } },
    { name: "existing company: bookkeeping, payroll, PRO", answers: { mode: "services", emirate: "Abu Dhabi", services: ["ACC-BOOK", "PAY-WPS", "PRO-RET"] } },
    { name: "existing company: audit (agent) and tax agency (agent)", answers: { mode: "services", emirate: "Dubai", services: ["AUD-EXT", "TAX-AGENT"] } },
    { name: "existing company: licence renewal, flexi desk, Emirates ID", answers: { mode: "services", emirate: "Dubai", services: ["SET-RENEW", "SET-OFFICE", "PRO-EID"] } },
    { name: "existing company: TRC, IFRS pack, excise", answers: { mode: "services", emirate: "Dubai", services: ["TAX-TRC", "ACC-IFRS", "TAX-EXCISE"] } },
    { name: "golden visa plus AML programme", answers: { mode: "services", emirate: "Dubai", services: ["VISA-GOLD", "AML-GOAML", "ESR-UBO"] } },
    { name: "free zone, 1 visa, full accounting and VAT", answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1, addOns: ["ACC-FULL", "VAT-RET"] } },
  ];

  it("prices every line of every sample by the rule, to the fils", async () => {
    const rules = (await env.call("finance", "GET", "/api/admin/rules")).body;
    const ruleFor = (cat: string) => rules.categories.find((c: any) => c.category === cat).current as { rateBp: number; floor: number };
    const settings = rules.settings as { capFactorBp: number; roundTo: number; vatBp: number };
    const cat = (await env.call("finance", "GET", "/api/admin/catalogue")).body as any[];
    let linesChecked = 0;
    for (const sample of SAMPLES) {
      const req = await env.call("client", "POST", "/api/requests", { answers: sample.answers });
      expect(req.status, sample.name).toBe(200);
      const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, {});
      expect(built.status, sample.name).toBe(200);
      expect(built.body.missing, `${sample.name}: no rate card`).toEqual([]);
      expect(built.body.offerIds.length).toBeGreaterThan(0);
      for (const offerId of built.body.offerIds) {
        const offer = (await env.call("finance", "GET", `/api/ops/offers/${offerId}`)).body;
        let professional = 0, mkwFees = 0, government = 0, payout = 0;
        for (const l of offer.lines) {
          const d = cat.find((x) => x.code === l.code);
          const rule = ruleFor(d.category);
          const cost = l.partnerUnitCost;
          const cap = applyBp(d.marketMid, settings.capFactorBp) - (d.midBasis === "incl_govt" ? l.govUnitFee : 0);
          if (l.model === "agent") {
            const fee = ceilTo(Math.max(applyBp(cost, rule.rateBp), rule.floor), settings.roundTo);
            expect(l.mkwFeeUnit, `${sample.name} ${l.code} MKW fee`).toBe(fee);
            expect(l.clientUnitPrice, `${sample.name} ${l.code} agent price`).toBe(cost);
            mkwFees += fee * l.qty;
          } else {
            const byRule = ceilTo(Math.max(cost + applyBp(cost, rule.rateBp), cost + rule.floor), settings.roundTo);
            const expected = Math.min(byRule, floorTo(Math.max(0, cap), settings.roundTo));
            expect(l.clientUnitPrice, `${sample.name} ${l.code} price`).toBe(expected);
            expect(l.marginUnit, `${sample.name} ${l.code} margin`).toBe(expected - cost);
            if (expected - cost < rule.floor) expect(l.status).toBe("ops_review");
          }
          professional += l.clientUnitPrice * l.qty;
          government += l.govUnitFee * l.qty;
          payout += cost * l.qty;
          linesChecked += 1;
        }
        expect(offer.professional, `${sample.name} professional total`).toBe(professional);
        expect(offer.mkwFees).toBe(mkwFees);
        expect(offer.government).toBe(government);
        expect(offer.partnerPayout).toBe(payout);
        expect(offer.vat).toBe(applyBp(professional + mkwFees, settings.vatBp));
        expect(offer.clientTotal).toBe(professional + mkwFees + offer.vat + government);
        expect(offer.margin).toBe(professional + mkwFees - payout);
      }
    }
    expect(linesChecked).toBeGreaterThanOrEqual(25);
  });

  it("matches hand-computed figures for known rate cards (independent of the engine's helpers)", async () => {
    // Corporate-services: SET-FZ-LIC 2,800 → 2,800 × 1.2 = 3,360 → up to 50 = 3,400. VISA-RES 1,600 → max(1,920, 2,000) = 2,000.
    // Setup partner: SET-ML-LIC 6,500 → 7,800. Tax partner: AUD-EXT (agent) 8,000 → MKW fee max(800, 500) = 800;
    // TAX-AGENT (agent) 4,500 → max(1,125, 300) = 1,125 → 1,150. ACC-BOOK 650 → max(812.5, 800) → 850 (cap 1,000 holds).
    const essential = async (answers: Record<string, unknown>) => {
      const req = await env.call("client", "POST", "/api/requests", { answers });
      const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["essential"] });
      const offer = (await env.call("finance", "GET", `/api/ops/offers/${built.body.offerIds[0]}`)).body;
      return Object.fromEntries(offer.lines.map((l: any) => [l.code, l]));
    };
    const a = await essential({ mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 });
    expect(a["SET-FZ-LIC"]).toMatchObject({ partnerUnitCost: 280_000, clientUnitPrice: 340_000, marginUnit: 60_000 });
    expect(a["VISA-RES"]).toMatchObject({ partnerUnitCost: 160_000, clientUnitPrice: 200_000, marginUnit: 40_000 });
    const b = await essential({ mode: "new_company", jurisdiction: "mainland", emirate: "Dubai", visas: 0 });
    expect(b["SET-ML-LIC"]).toMatchObject({ partnerUnitCost: 650_000, clientUnitPrice: 780_000 });
    const c = await essential({ mode: "services", emirate: "Dubai", services: ["AUD-EXT", "TAX-AGENT", "ACC-BOOK"] });
    expect(c["AUD-EXT"]).toMatchObject({ model: "agent", partnerUnitCost: 800_000, clientUnitPrice: 800_000, mkwFeeUnit: 80_000 });
    expect(c["TAX-AGENT"]).toMatchObject({ model: "agent", partnerUnitCost: 450_000, mkwFeeUnit: 115_000 });
    expect(c["ACC-BOOK"]).toMatchObject({ partnerUnitCost: 65_000, clientUnitPrice: 85_000, marginUnit: 20_000 });
  });

  it("reproduces the Sheet's own OF-0001 example through the API", async () => {
    // Example partner 1 cards: SET-FZ-LIC 3,500 + govt 9,500; VISA-RES 1,800 + govt 3,500; partner 2 BANK-ACC 2,000.
    // The demo seed carries the same figures for the setup partner and the corporate-services partner.
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 2, addOns: ["BANK-ACC"] } });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["essential"] });
    const offer = (await env.call("finance", "GET", `/api/ops/offers/${built.body.offerIds[0]}`)).body;
    const by = Object.fromEntries(offer.lines.map((l: any) => [l.code, l]));
    // Essential takes the lowest comparable cost: corporate-services' SET-FZ-LIC (2,800 + 9,000) and BANK-ACC (2,000), VISA-RES (1,600 + 3,500).
    expect(by["SET-FZ-LIC"].clientUnitPrice).toBe(ceilTo(Math.max(280_000 + applyBp(280_000, 2000), 280_000 + 50_000), 5_000));
    expect(by["BANK-ACC"]).toMatchObject({ partnerUnitCost: 200_000, clientUnitPrice: 240_000, govUnitFee: 0 });
    expect(by["VISA-RES"]).toMatchObject({ qty: 2, clientUnitPrice: ceilTo(Math.max(160_000 + applyBp(160_000, 2000), 160_000 + 40_000), 5_000) });
    // And the Sheet's worked figures hold for its exact inputs (the core test reproduces them to the fils).
    const { priceLine, offerTotals, DEFAULT_SETTINGS } = await import("@tasees/core");
    const d = (code: string, mid: number, basis: "incl_govt" | "service_only") => ({ code, name: code, category: "x", model: "reseller" as const, billing: "one_off" as const, marketMid: mid, midBasis: basis, govFeeTable: null, requiredEvidence: [], requires: [] });
    const lines = [
      priceLine({ deliverable: d("SET-FZ-LIC", 1_200_000, "incl_govt"), qty: 1, partnerUnitCost: 350_000, govUnitFee: 950_000, rule: { category: "Setup", rateBp: 2000, floor: 50_000 } }, DEFAULT_SETTINGS),
      priceLine({ deliverable: d("VISA-RES", 400_000, "service_only"), qty: 2, partnerUnitCost: 180_000, govUnitFee: 350_000, rule: { category: "Visa", rateBp: 2000, floor: 40_000 } }, DEFAULT_SETTINGS),
      priceLine({ deliverable: d("BANK-ACC", 300_000, "service_only"), qty: 1, partnerUnitCost: 200_000, govUnitFee: 0, rule: { category: "Banking", rateBp: 2000, floor: 40_000 } }, DEFAULT_SETTINGS),
    ];
    const t = offerTotals(lines, DEFAULT_SETTINGS);
    expect([t.professional, t.vat, t.government, t.clientTotal, t.partnerPayout, t.margin]).toEqual([1_100_000, 55_000, 1_650_000, 2_805_000, 910_000, 190_000]);
  });
});

import { aed, DEFAULT_SETTINGS } from "@tasees/core";
import { asPlatform } from "../lib/context.ts";
import type { Database } from "../lib/db.ts";
import { DELIVERABLES, DEMO, MARGIN_RULES } from "./seed-data.ts";
import { CATALOGUE_EXTENSION, EXTENSION_MARGIN_RULES, STARTER_ROWS } from "./catalogue.ts";

/** Catalogue, margin rules and settings. Safe to run more than once. */
export async function seedCatalogue(db: Database): Promise<void> {
  await asPlatform(db, null, async (tx) => {
    const upsert = async (code: string, name: string, category: string, model: string, billing: string, mid: number, basis: string, requires: readonly string[], evidence: readonly string[], row: number | null) =>
      tx.query(
        `insert into deliverables (code, name, category, model, billing, market_mid_fils, mid_basis, requires, required_evidence, sheet_row)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (code) do update set name = excluded.name, category = excluded.category, model = excluded.model,
           billing = excluded.billing, market_mid_fils = excluded.market_mid_fils, mid_basis = excluded.mid_basis,
           requires = excluded.requires, required_evidence = excluded.required_evidence, sheet_row = excluded.sheet_row`,
        [code, name, category, model, billing, aed(mid), basis, [...requires], [...evidence], row],
      );
    for (const [code, name, category, model, billing, mid, basis, requires, evidence] of DELIVERABLES) {
      await upsert(code, name, category, model, billing, mid, basis, requires, evidence, STARTER_ROWS[code]?.[0] ?? null);
    }
    for (const [code, name, category, model, billing, mid, basis, requires, evidence, row] of CATALOGUE_EXTENSION) {
      await upsert(code, name, category, model, billing, mid, basis, requires, evidence, row);
    }
    // Margin rules: the current rule per category is a cache of the version in force; versions are never overwritten,
    // so a rule the founder changed from the console is not reset by a restart (insert only when the category is new).
    for (const [category, rate, floor] of [...MARGIN_RULES, ...EXTENSION_MARGIN_RULES]) {
      const existing = await tx.query("select 1 from margin_rule_versions where category = $1", [category]);
      if (existing.rows.length) continue;
      await tx.query("insert into margin_rules (category, rate_bp, floor_fils) values ($1,$2,$3) on conflict (category) do nothing", [category, rate, floor]);
      await tx.query(
        "insert into margin_rule_versions (category, rate_bp, floor_fils, effective_from, note) values ($1,$2,$3, date '2026-01-01', $4) on conflict do nothing",
        [category, rate, floor, EXTENSION_MARGIN_RULES.some(([c]) => c === category) ? "Default for a category the Sheet does not price yet: UNCERTAIN until the owner confirms" : "Starter rule from the Deliverable Codes tab"],
      );
    }
    await tx.query(
      `insert into settings (key, value) values ('pricing', $1) on conflict (key) do nothing`,
      [JSON.stringify(DEFAULT_SETTINGS)],
    );
  });
}

export interface DemoIds {
  platformOrgId: string;
  partnerOrgIds: string[];
  clientOrgId: string;
}

/** Demo organisations, users and rate cards. Only for development and tests. */
export async function seedDemo(db: Database): Promise<DemoIds> {
  return asPlatform(db, null, async (tx) => {
    const existing = await tx.query<{ id: string }>("select id from orgs where type = 'platform' limit 1");
    if (existing.rows[0]) {
      const partners = await tx.query<{ id: string }>("select id from orgs where type = 'partner' order by created_at, name");
      const client = await tx.query<{ id: string }>("select id from orgs where type = 'client' order by created_at limit 1");
      return { platformOrgId: existing.rows[0].id, partnerOrgIds: partners.rows.map((r) => r.id), clientOrgId: client.rows[0]!.id };
    }
    const org = async (type: string, name: string, profile: unknown = {}) =>
      (await tx.query<{ id: string }>("insert into orgs (type, name, profile) values ($1,$2,$3) returning id", [type, name, JSON.stringify(profile)])).rows[0]!.id;
    const user = (orgId: string, email: string, name: string, role: string) =>
      tx.query("insert into users (org_id, email, name, role) values ($1,$2,$3,$4)", [orgId, email, name, role]);

    const platformOrgId = await org("platform", DEMO.platform.name);
    for (const [email, name, role] of DEMO.platform.users) await user(platformOrgId, email, name, role);

    const partnerOrgIds: string[] = [];
    for (const p of DEMO.partners) {
      const id = await org("partner", p.name, p.profile);
      partnerOrgIds.push(id);
      await user(id, p.email, `${p.name} admin`, "partner_admin");
      await user(id, p.staff, `${p.name} staff`, "partner_staff");
      for (const [code, fee, gov, days] of p.cards) {
        await tx.query(
          `insert into rate_cards (partner_org_id, code, professional_fils, gov_stated_fils, working_days, valid_to)
           values ($1,$2,$3,$4,$5, current_date + 90)`,
          [id, code, aed(fee), aed(gov), days],
        );
      }
    }
    const clientOrgId = await org("client", DEMO.client.name);
    await user(clientOrgId, DEMO.client.email, DEMO.client.ownerName, "client_owner");
    await user(clientOrgId, DEMO.client.member, "Accounts Assistant", "client_member");
    return { platformOrgId, partnerOrgIds, clientOrgId };
  });
}

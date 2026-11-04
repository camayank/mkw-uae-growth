import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openPglite } from "../src/lib/db.ts";

/**
 * E23 (independent review): migration 030 backfills `catalogue_facts`, which is append-only for everyone. On a database
 * that already holds facts (staging after E7B's imports) the backfill must still run: the owner lifts the guard for it.
 */
const DIR = join(__dirname, "..", "migrations");

describe("migrations over existing data", () => {
  it("030 backfills facts recorded before it: first, same and change in order, each naming what it superseded", async () => {
    const db = await openPglite();
    try {
      const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
      const before = files.filter((f) => f < "030_");
      const after = files.filter((f) => f >= "030_");
      await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
      for (const f of before) await db.exec(readFileSync(join(DIR, f), "utf8"));
      await db.exec(`insert into zones (name, emirate, type, confidence) values ('Test Zone', 'Dubai', 'free_zone', 'UNCERTAIN')`).catch(async () => {
        // The zones table may need more columns than the test knows: fall back to the seed's shape by copying one row's defaults.
        await db.exec(`insert into zones (name, emirate, type) values ('Test Zone', 'Dubai', 'free_zone')`);
      });
      await db.exec(`insert into catalogue_facts (subject_kind, subject, field, value, evidence_date, confidence) values
        ('place', 'Test Zone', 'visa_quota', '1', current_date - 3, 'UNCERTAIN'),
        ('place', 'Test Zone', 'visa_quota', '2', current_date - 2, 'UNCERTAIN'),
        ('place', 'Test Zone', 'visa_quota', '2', current_date - 1, 'UNCERTAIN')`);
      for (const f of after) await db.exec(readFileSync(join(DIR, f), "utf8"));
      const rows = (await db.transaction((tx) => tx.query<any>("select id, change_kind, supersedes_id from catalogue_facts where subject = 'Test Zone' order by id"))).rows;
      expect(rows.map((r) => [r.change_kind, r.supersedes_id === null ? null : Number(r.supersedes_id)])).toEqual([["first", null], ["change", Number(rows[0].id)], ["same", Number(rows[1].id)]]);
      // The guard is back.
      await expect(db.transaction((tx) => tx.query("update catalogue_facts set note = 'x' where subject = 'Test Zone'"))).rejects.toThrow(/append-only/);
    } finally {
      await db.close();
    }
  });
});

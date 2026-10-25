/**
 * On PostgreSQL every test file gets its own database, but roles belong to the whole server. Migration 001 creates the
 * three application roles if they are missing; test files starting in parallel on a fresh server would race to create
 * them. Create them once here, before any file runs. Nothing to do on PGlite (each file has its own server).
 */
import pg from "pg";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'app_client') then create role app_client nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'app_partner') then create role app_partner nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'app_platform') then create role app_platform nologin; end if;
      end $$`);
    await client.query("grant app_client, app_partner, app_platform to current_user");
  } finally {
    await client.end();
  }
}

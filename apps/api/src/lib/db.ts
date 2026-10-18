import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
}

/** Anything that can run a parameterised query: a pool, a client or a transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database {
  /** Run `fn` inside one transaction; it commits when `fn` resolves and rolls back when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "pglite" | "postgres";
}

/** Embedded Postgres for development and tests. `dataDir` undefined means in memory. */
export async function openPglite(dataDir?: string): Promise<Database> {
  // PGlite creates only the last folder of its data directory; a fresh checkout has no `data/` at all.
  if (dataDir) mkdirSync(dirname(resolve(dataDir)), { recursive: true });
  // int8 (bigint) as JS numbers: every amount here is a safe integer of fils.
  const db = new PGlite(dataDir, { parsers: { 20: (v: string) => Number(v) } });
  await db.waitReady;
  await db.exec("set timezone to 'UTC'");
  return {
    kind: "pglite",
    transaction: (fn) => db.transaction(async (tx) => fn({ query: (s, p) => tx.query(s, p as unknown[]) as never })),
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}

/** Postgres over the network for staging and production. */
export async function openPostgres(connectionString: string): Promise<Database> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Postgres returns bigint as text; amounts here fit safely in JS numbers (under 2^53 fils).
  pg.types.setTypeParser(20, (v) => Number(v));
  // The audit functions pin their own time zone and date style (migration 002); this keeps every other
  // timestamp the application reads in UTC as well. A failure here is logged, never hidden.
  pool.on("connect", (client) => {
    client.query("set timezone to 'UTC'").catch((e) => console.error("could not set the session time zone to UTC", e));
  });
  return {
    kind: "postgres",
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: (s, p) => client.query(s, p) as never });
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

export async function openDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (url) return openPostgres(url);
  return openPglite(process.env.PGLITE_DIR ?? "./data/pglite");
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(db: Database): Promise<string[]> {
  await db.exec(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const done = await db.transaction((tx) =>
      tx.query<{ name: string }>("select name from schema_migrations where name = $1", [file]),
    );
    if (done.rows.length > 0) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await db.exec(sql);
    await db.transaction((tx) => tx.query("insert into schema_migrations (name) values ($1)", [file]));
    applied.push(file);
  }
  return applied;
}

/** Postgres bigint may arrive as a string from some drivers; amounts are always safe integers here. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Give every transaction the application clock, so database timestamps (app_now()) and
 * domain rules agree. Without a clock the database uses its own now().
 */
export function withClock(db: Database, now?: () => Date): Database {
  if (!now) return db;
  return {
    ...db,
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('app.now', $1, true)", [now().toISOString()]);
        return fn(tx);
      }),
  };
}

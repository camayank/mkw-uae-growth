import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
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
  // An idle connection the server ends (a restart, a failover, an administrator) must not end the process: without
  // this listener node-postgres re-throws the error and the app exits. The pool opens a new connection when needed.
  pool.on("error", (e) => console.error(JSON.stringify({ level: "error", msg: "idle database connection lost", error: e.message })));
  return {
    kind: "postgres",
    async transaction(fn) {
      const client = await pool.connect();
      // A connection that could not even roll back is broken: destroy it instead of returning it to the pool.
      let broken: Error | undefined;
      try {
        await client.query("begin");
        const result = await fn({ query: (s, p) => client.query(s, p) as never });
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch((e: Error) => {
          broken = e;
        });
        throw err;
      } finally {
        client.release(broken);
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

/** Any number; the same for every process, so two tasks starting at once take turns. */
const MIGRATION_LOCK = 72_434_210;

/**
 * Apply pending migrations in name order. On Postgres every file runs in its own transaction holding an advisory
 * lock and re-checks whether another process (the app, the scheduled jobs task, a one-off task) applied it in the
 * meantime, so tasks starting together never run the same DDL twice (O10). PGlite is single-process.
 */
export async function migrate(db: Database): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  if (db.kind === "postgres") {
    await db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await tx.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    });
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const ran = await db.transaction(async (tx) => {
        await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
        if ((await tx.query("select 1 from schema_migrations where name = $1", [file])).rows.length) return false;
        await tx.query(sql); // no parameters: the simple protocol runs every statement in the file
        await tx.query("insert into schema_migrations (name) values ($1)", [file]);
        return true;
      });
      if (ran) applied.push(file);
    }
    return applied;
  }
  await db.exec(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
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

/** Migrations not yet applied to this database (all of them when it has never been migrated). Changes nothing. */
export async function pendingMigrations(db: Database): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const exists = await db.transaction((tx) => tx.query<{ ok: boolean }>("select to_regclass('schema_migrations') is not null as ok"));
  if (!exists.rows[0]?.ok) return files;
  const done = new Set((await db.transaction((tx) => tx.query<{ name: string }>("select name from schema_migrations"))).rows.map((r) => r.name));
  return files.filter((f) => !done.has(f));
}

/**
 * Whether this connection's login owns the application's tables (E19). The owner can migrate; it can also disable a
 * trigger or step out of the per-request role, so it must not be what the application logs in as in production.
 * PGlite is single-user and always the owner.
 */
export async function loginOwnsSchema(db: Database): Promise<boolean> {
  if (db.kind !== "postgres") return true;
  const r = await db.transaction((tx) =>
    tx.query<{ n: number }>("select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = current_user"),
  );
  return num(r.rows[0]?.n) > 0;
}

/**
 * Prepare the database at start (E19). The owner (development, tests, the demo) migrates as before. In production the
 * application logs in as the runtime login, which owns nothing: it never migrates (the migration step does, as the
 * owner, `scripts/migrate.ts`) and refuses to start on a schema that is behind. Logging in as the owner in production
 * is refused.
 */
export async function prepareDatabase(db: Database, opts: { production: boolean }): Promise<string[]> {
  if (await loginOwnsSchema(db)) {
    if (opts.production && db.kind === "postgres") {
      throw new Error(
        "The application logs in as the owner of its tables. In production set DATABASE_URL to the runtime login (a member of app_runtime) and run the migration step (scripts/migrate.ts) as the owner (E19).",
      );
    }
    return migrate(db);
  }
  const pending = await pendingMigrations(db);
  if (pending.length) throw new Error(`The database is missing migrations (${pending.join(", ")}). Run the migration step (scripts/migrate.ts) as the owner first (E19).`);
  return [];
}

/**
 * A SCRAM-SHA-256 verifier for a password, in the form Postgres stores (RFC 7677, as libpq's PQencryptPasswordConn).
 * Sending the verifier rather than the password keeps the password out of any statement the server may log.
 * Passwords are printable ASCII, so SASLprep leaves them unchanged.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error("The runtime login's password must be printable ASCII with no spaces");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * Create or update the application's runtime login (E19): it may log in, inherits only `app_runtime` (which can switch
 * to the three application roles and read the migration list) and owns nothing. Run by the migration step as the
 * owner, with the login's name and password from the secrets store. The password reaches Postgres only as a verifier.
 */
export async function ensureRuntimeLogin(db: Database, user: string, password: string): Promise<void> {
  if (db.kind !== "postgres") throw new Error("A runtime login exists only on PostgreSQL");
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(user)) throw new Error("The runtime login's name must be lower-case letters, digits or _ (3 to 63)");
  if (password.length < 24) throw new Error("The runtime login's password must be at least 24 characters");
  const ident = pg.escapeIdentifier(user);
  const verifier = pg.escapeLiteral(scramVerifier(password));
  await db.transaction(async (tx) => {
    // One migration step at a time: every app task's migration container may start at once (E19 review).
    await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    const exists = (await tx.query("select 1 from pg_roles where rolname = $1", [user])).rows.length > 0;
    // CREATE may state every attribute. ALTER may not name SUPERUSER unless the caller is a superuser, which RDS's
    // master user is not (E19 review), so the attributes are checked below instead.
    if (exists) await tx.query(`alter role ${ident} with login inherit nocreatedb nocreaterole password ${verifier}`);
    else await tx.query(`create role ${ident} with login inherit nocreatedb nocreaterole nosuperuser password ${verifier}`);
    // Settings the login may have given itself since (a default role, a search path) are cleared.
    await tx.query(`alter role ${ident} reset all`);
    await tx.query(`grant app_runtime to ${ident}`);
    const r = (
      await tx.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolbypassrls: boolean; rolreplication: boolean }>(
        "select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication from pg_roles where rolname = $1",
        [user],
      )
    ).rows[0]!;
    const unsafe = Object.entries(r).filter(([, v]) => v === true).map(([k]) => k);
    if (unsafe.length) throw new Error(`${user} has ${unsafe.join(", ")}; the runtime login must have none of them`);
    const owns = await tx.query<{ n: number }>("select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = $1", [user]);
    if (num(owns.rows[0]?.n) > 0) throw new Error(`${user} owns tables; the runtime login must own nothing`);
  });
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

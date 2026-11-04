import type { FastifyInstance } from "fastify";
import { createSession } from "../src/lib/auth.ts";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { ensureRuntimeLogin, migrate, openPglite, openPostgres, type Database } from "../src/lib/db.ts";
import { memoryTransport, recordingNotifier, type Notifier, type OutboundEmail } from "../src/lib/notify.ts";
import { memoryProvider } from "../src/lib/payments.ts";
import { memoryModel } from "../src/lib/ai.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { memoryScanner } from "../src/lib/scanner.ts";
import { seedCatalogue, seedDemo, type DemoIds } from "../src/db/seed.ts";
import { DEMO } from "../src/db/seed-data.ts";
import { buildApp, type AppOptions } from "../src/server.ts";

export interface TestEnv {
  app: FastifyInstance;
  db: Database;
  ids: DemoIds;
  notify: Notifier;
  /** Emails the memory transport delivered, oldest first. */
  emails: OutboundEmail[];
  transport: ReturnType<typeof memoryTransport>;
  storage: ReturnType<typeof memoryStorage>;
  provider: ReturnType<typeof memoryProvider>;
  clock: { now: Date };
  tokens: Record<string, string>;
  call: <T = any>(who: string, method: string, url: string, body?: unknown) => Promise<{ status: number; body: T }>;
  /** Like `call`, with extra request headers and the response headers back. */
  send: <T = any>(who: string, method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T; headers: Record<string, unknown> }>;
}

export const EMAILS = {
  founder: "founder@mkwadvisors.test",
  ops: "ops@mkwadvisors.test",
  finance: "finance@mkwadvisors.test",
  setup: DEMO.partners[0].email,
  setupStaff: DEMO.partners[0].staff,
  corp: DEMO.partners[1].email,
  tax: DEMO.partners[2].email,
  client: DEMO.client.email,
  clientMember: DEMO.client.member,
} as const;

/**
 * Tests run on PGlite in memory by default. Set TEST_DATABASE_URL to a Postgres server (a role with CREATEDB and
 * CREATEROLE) to run the same suites on real Postgres: each environment gets its own database, dropped on close.
 */
async function openTestDatabase(): Promise<Database & { url?: string }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openPglite();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const name = `tasees_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${name}`);
  await admin.end();
  const dbUrl = new URL(url);
  dbUrl.pathname = `/${name}`;
  const db = await openPostgres(dbUrl.toString());
  return {
    ...db,
    url: dbUrl.toString(),
    async close() {
      await db.close();
      const drop = new pg.Client({ connectionString: url });
      await drop.connect();
      await drop.query(`drop database ${name} with (force)`);
      await drop.end();
    },
  };
}

export async function makeEnv(
  start = new Date("2026-10-19T06:00:00Z"),
  extra: Partial<Pick<AppOptions, "trustProxy" | "logger" | "alertEmail" | "startedAt" | "webDir" | "appUrl" | "scanner" | "allowUnscanned">> = {},
  opts: { runtimeLogin?: boolean } = {},
): Promise<TestEnv> {
  const owner = await openTestDatabase();
  await migrate(owner);
  await seedCatalogue(owner);
  // E19: on PostgreSQL, run the application as a runtime login that owns nothing, as staging does: the owner migrates
  // and seeds the catalogue, then everything else (the demo seed, the app, the tests' sessions) uses the runtime login.
  const db = opts.runtimeLogin && owner.kind === "postgres" ? await runtimeDatabase(owner) : owner;
  const ids = await seedDemo(db);
  const clock = { now: start };
  const transport = memoryTransport();
  const notify = recordingNotifier({ db, transport, appUrl: "https://app.test", fromClient: "tasees@mkwadvisors.test", fromPartner: "partners@mkwadvisors.test", now: () => clock.now, log: (m) => (process.env.NOTIFY_DEBUG ? console.log(m) : undefined) });
  const storage = memoryStorage();
  const provider = memoryProvider("test-secret", "https://app.test", () => clock.now);
  // E22: the test scanner unless a test asks for none (staging until T6) or its own.
  const app = await buildApp({ db, notify, storage, provider, model: memoryModel(), now: () => clock.now, devLogin: true, webhookSecret: "test-secret", scanner: memoryScanner(), ...extra });
  const tokens: Record<string, string> = {};
  for (const [k, email] of Object.entries(EMAILS)) tokens[k] = await createSession(db, email);
  const send = async (who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: { ...(who === "anon" ? {} : { authorization: `Bearer ${tokens[who]}` }), ...headers },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    await notify.flush(); // deliveries happen after the request, as in production
    // A JSON body is parsed; anything else (a CSV download) comes back as text.
    const parsed = (() => { try { return res.body ? JSON.parse(res.body) : null; } catch { return res.body; } })();
    return { status: res.statusCode, body: parsed, headers: res.headers as Record<string, unknown> };
  };
  const call = async (who: string, method: string, url: string, body?: unknown) => {
    const { status, body: b } = await send(who, method, url, body);
    return { status, body: b };
  };
  return { app, db, ids, notify, emails: transport.delivered, transport, storage, provider, clock, tokens, call, send };
}

/** A fresh runtime login on the owner's test database, and a connection as that login (E19). Dropped on close. */
async function runtimeDatabase(owner: Database & { url?: string }): Promise<Database> {
  const user = `tasees_rt_${randomBytes(5).toString("hex")}`;
  const password = randomBytes(24).toString("base64url");
  await ensureRuntimeLogin(owner, user, password);
  const url = new URL(owner.url!);
  url.username = user;
  url.password = password;
  const runtime = await openPostgres(url.toString());
  return {
    ...runtime,
    async close() {
      await runtime.close();
      await owner.close(); // drops the test database
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`drop role if exists ${user}`);
      await admin.end();
    },
  };
}

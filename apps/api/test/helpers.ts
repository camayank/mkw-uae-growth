import type { FastifyInstance } from "fastify";
import { createSession } from "../src/lib/auth.ts";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate, openPglite, openPostgres, type Database } from "../src/lib/db.ts";
import { memoryTransport, recordingNotifier, type Notifier, type OutboundEmail } from "../src/lib/notify.ts";
import { memoryProvider } from "../src/lib/payments.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { seedCatalogue, seedDemo, type DemoIds } from "../src/db/seed.ts";
import { DEMO } from "../src/db/seed-data.ts";
import { buildApp } from "../src/server.ts";

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
async function openTestDatabase(): Promise<Database> {
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
    async close() {
      await db.close();
      const drop = new pg.Client({ connectionString: url });
      await drop.connect();
      await drop.query(`drop database ${name} with (force)`);
      await drop.end();
    },
  };
}

export async function makeEnv(start = new Date("2026-10-19T06:00:00Z")): Promise<TestEnv> {
  const db = await openTestDatabase();
  await migrate(db);
  await seedCatalogue(db);
  const ids = await seedDemo(db);
  const clock = { now: start };
  const transport = memoryTransport();
  const notify = recordingNotifier({ db, transport, appUrl: "https://app.test", fromClient: "tasees@mkwadvisors.test", fromPartner: "partners@mkwadvisors.test", now: () => clock.now, log: (m) => (process.env.NOTIFY_DEBUG ? console.log(m) : undefined) });
  const storage = memoryStorage();
  const provider = memoryProvider("test-secret", "https://app.test", () => clock.now);
  const app = await buildApp({ db, notify, storage, provider, now: () => clock.now, devLogin: true, webhookSecret: "test-secret" });
  const tokens: Record<string, string> = {};
  for (const [k, email] of Object.entries(EMAILS)) tokens[k] = await createSession(db, email);
  const call = async (who: string, method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: who === "anon" ? {} : { authorization: `Bearer ${tokens[who]}` },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    await notify.flush(); // deliveries happen after the request, as in production
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return { app, db, ids, notify, emails: transport.delivered, transport, storage, provider, clock, tokens, call };
}

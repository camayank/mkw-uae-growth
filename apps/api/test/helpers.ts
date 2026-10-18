import type { FastifyInstance } from "fastify";
import { createSession } from "../src/lib/auth.ts";
import { migrate, openPglite, type Database } from "../src/lib/db.ts";
import { consoleNotifier, type Notifier } from "../src/lib/notify.ts";
import { memoryStorage } from "../src/lib/storage.ts";
import { seedCatalogue, seedDemo, type DemoIds } from "../src/db/seed.ts";
import { DEMO } from "../src/db/seed-data.ts";
import { buildApp } from "../src/server.ts";

export interface TestEnv {
  app: FastifyInstance;
  db: Database;
  ids: DemoIds;
  notify: Notifier;
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

export async function makeEnv(start = new Date("2026-10-19T06:00:00Z")): Promise<TestEnv> {
  const db = await openPglite();
  await migrate(db);
  await seedCatalogue(db);
  const ids = await seedDemo(db);
  const notify = consoleNotifier(() => undefined);
  const clock = { now: start };
  const app = await buildApp({ db, notify, storage: memoryStorage(), now: () => clock.now, devLogin: true, webhookSecret: "test-secret" });
  const tokens: Record<string, string> = {};
  for (const [k, email] of Object.entries(EMAILS)) tokens[k] = await createSession(db, email);
  const call = async (who: string, method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: who === "anon" ? {} : { authorization: `Bearer ${tokens[who]}` },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return { app, db, ids, notify, clock, tokens, call };
}

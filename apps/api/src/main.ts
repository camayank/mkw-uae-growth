import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, openDatabase } from "./lib/db.ts";
import { consoleNotifier } from "./lib/notify.ts";
import { localStorage } from "./lib/storage.ts";
import { runJobs } from "./jobs/run.ts";
import { buildApp } from "./server.ts";
import { seedCatalogue } from "./db/seed.ts";

const here = dirname(fileURLToPath(import.meta.url));

const db = await openDatabase();
const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
await seedCatalogue(db);

const notify = consoleNotifier();
// Development sign-in shows the code on screen. Opt-in only, and never in production.
const devLogin = process.env.DEV_LOGIN === "1" && process.env.NODE_ENV !== "production";
const app = await buildApp({
  db,
  notify,
  storage: localStorage(),
  devLogin,
  webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  webDir: process.env.WEB_DIR ?? join(here, "../../web/public"),
  logger: process.env.LOG !== "0",
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
console.log(`Tasees platform on http://localhost:${port}${devLogin ? " (development sign-in codes shown on screen)" : ""}`);

// In-process sweeps every 15 minutes. In production prefer an external cron calling `pnpm jobs`.
if (process.env.IN_PROCESS_JOBS !== "0") {
  setInterval(() => {
    runJobs(db, { notify }).catch((e) => console.error("jobs failed", e));
  }, 15 * 60 * 1000).unref();
}

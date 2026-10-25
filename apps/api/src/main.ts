import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, openDatabase } from "./lib/db.ts";
import { notifierFromEnv } from "./lib/notify.ts";
import { providerFromEnv } from "./lib/payments.ts";
import { modelFromEnv } from "./lib/ai.ts";
import { storageFromEnv } from "./lib/storage.ts";
import { runJobs } from "./jobs/run.ts";
import { buildApp } from "./server.ts";
import { seedCatalogue } from "./db/seed.ts";
import { checkConfigOrExit } from "./lib/config.ts";
import { asPlatform } from "./lib/context.ts";
import { sweepAlerts } from "./services/system.ts";

checkConfigOrExit();

const here = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date();

const db = await openDatabase();
const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
await seedCatalogue(db);

// Every message is recorded in the notifications table and delivered by the configured transport.
const { notify, transport } = notifierFromEnv(db);
if (process.env.NODE_ENV === "production" && transport.kind !== "ses") {
  console.warn("WARNING: EMAIL is not ses; messages are recorded and printed, not emailed. Set EMAIL=ses before real clients.");
}
// Evidence files: S3-compatible object storage in a UAE region in production (STORAGE=s3), local disk otherwise.
const { storage, kind: storageKind } = storageFromEnv();
if (process.env.NODE_ENV === "production" && storageKind !== "s3") {
  console.warn("WARNING: STORAGE is not s3; evidence files are on local disk. Fine for one instance; set STORAGE=s3 before running more.");
}
// Development sign-in shows the code on screen. Opt-in only, and never in production.
const devLogin = process.env.DEV_LOGIN === "1" && process.env.NODE_ENV !== "production";
const app = await buildApp({
  db,
  notify,
  storage,
  provider: providerFromEnv(),
  model: modelFromEnv(),
  devLogin,
  trustProxy: process.env.TRUST_PROXY && process.env.TRUST_PROXY !== "0" ? process.env.TRUST_PROXY : false,
  webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  webDir: process.env.WEB_DIR ?? join(here, "../../web/public"),
  logger: process.env.LOG !== "0",
  alertEmail: process.env.ALERT_EMAIL || undefined,
  startedAt,
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
console.log(`Tasees platform on http://localhost:${port} · db ${db.kind} · files ${storageKind} · email ${transport.kind}${devLogin ? " · development sign-in codes shown on screen" : ""}`);

// In-process sweeps every 15 minutes. In production prefer an external cron calling `pnpm jobs`.
const alertEmail = process.env.ALERT_EMAIL || undefined;
if (!alertEmail) console.warn("ALERT_EMAIL is not set: platform alerts are logged and shown on the System page, not emailed.");
else if (transport.kind !== "ses") console.warn("ALERT_EMAIL is set but EMAIL is not ses: alerts are recorded and printed, not emailed.");
if (process.env.IN_PROCESS_JOBS !== "0") {
  setInterval(() => {
    runJobs(db, { notify, storage, provider: providerFromEnv() }, null, { alertEmail, log: (line) => app.log.info(line) }).catch((e) => app.log.error({ err: e }, "jobs failed"));
  }, 15 * 60 * 1000).unref();
}
// The watchdog (O13): every five minutes, open or close alerts. It runs here, not in the jobs, because its main
// question is whether the jobs ran at all.
setInterval(() => {
  asPlatform(db, null, (tx) => sweepAlerts(tx, { notify, alertEmail, since: startedAt, log: (line) => app.log.warn(line) }))
    .then(() => notify.flush())
    .catch((e) => app.log.error({ err: e }, "watchdog failed"));
}, 5 * 60 * 1000).unref();

// Graceful shutdown: finish in-flight requests, then close the database. PGlite in particular cannot reopen a
// data directory that was not closed cleanly, and a container runtime sends SIGTERM before it kills the process.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    const deadline = setTimeout(() => process.exit(1), 10_000).unref();
    app
      .close()
      .then(() => db.close())
      .then(() => {
        clearTimeout(deadline);
        process.exit(0);
      })
      .catch((e) => {
        console.error("shutdown failed", e);
        process.exit(1);
      });
  });
}

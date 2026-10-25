// One sweep of the scheduled jobs, for cron when IN_PROCESS_JOBS=0. Uses the same recording notifier as the
// server, so digests and reminders raised here are recorded, emailed and shown in the bell like any other.
import { openDatabase, migrate } from "../lib/db.ts";
import { notifierFromEnv } from "../lib/notify.ts";
import { providerFromEnv } from "../lib/payments.ts";
import { storageFromEnv } from "../lib/storage.ts";
import { runJobs } from "../jobs/run.ts";
import { modelFromEnv } from "../lib/ai.ts";
import { registerDocumentChecker } from "../services/doccheck.ts";

const db = await openDatabase();
await migrate(db);
const { notify } = notifierFromEnv(db);
// The same outbox subscribers as the server, so work left by a stopped app task is finished here (O11).
registerDocumentChecker(notify, db, modelFromEnv());
const result = await runJobs(db, { notify, storage: storageFromEnv().storage, provider: providerFromEnv() });
console.log(JSON.stringify(result));
await db.close();
process.exit(result.errors.length ? 1 : 0);

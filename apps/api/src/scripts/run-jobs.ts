// One sweep of the scheduled jobs, for cron when IN_PROCESS_JOBS=0. Uses the same recording notifier as the
// server, so digests and reminders raised here are recorded, emailed and shown in the bell like any other.
import { openDatabase, migrate } from "../lib/db.ts";
import { notifierFromEnv } from "../lib/notify.ts";
import { providerFromEnv } from "../lib/payments.ts";
import { storageFromEnv } from "../lib/storage.ts";
import { runJobs } from "../jobs/run.ts";

const db = await openDatabase();
await migrate(db);
const { notify } = notifierFromEnv(db);
const result = await runJobs(db, { notify, storage: storageFromEnv().storage, provider: providerFromEnv() });
await notify.flush();
console.log(JSON.stringify(result));
await db.close();
process.exit(result.errors.length ? 1 : 0);

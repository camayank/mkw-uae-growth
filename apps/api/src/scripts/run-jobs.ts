import { openDatabase, migrate } from "../lib/db.ts";
import { consoleNotifier } from "../lib/notify.ts";
import { runJobs } from "../jobs/run.ts";

const db = await openDatabase();
await migrate(db);
const result = await runJobs(db, { notify: consoleNotifier() });
console.log(JSON.stringify(result));
await db.close();
process.exit(result.errors.length ? 1 : 0);

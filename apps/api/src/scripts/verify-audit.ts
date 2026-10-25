// Recompute every audit hash in the database and exit non-zero if the chain is broken.
// Used by the restore drill and safe to run in production at any time (read-only).
import { verifyAuditChain } from "../lib/audit.ts";
import { asPlatform } from "../lib/context.ts";
import { openDatabase } from "../lib/db.ts";
import { checkConfigOrExit } from "../lib/config.ts";

checkConfigOrExit();

const db = await openDatabase();
try {
  const result = await asPlatform(db, null, (tx) => verifyAuditChain(tx));
  if (result.intact) {
    console.log(`Audit chain intact: ${result.checked} events verified.`);
  } else {
    console.error(`Audit chain BROKEN at event ${result.brokenId} (after ${result.checked - 1} good events).`);
    process.exitCode = 2;
  }
} finally {
  await db.close();
}

// E19: the migration step. Runs as the database owner (staging: the RDS master secret), applies pending migrations,
// seeds the service catalogue, and creates or updates the application's runtime login when APP_DB_USER and
// APP_DB_PASSWORD are given (staging: the app's own secret). The application and the scheduled jobs then log in as
// that runtime login, which owns nothing, and never migrate (`prepareDatabase`).
import { ensureRuntimeLogin, loginOwnsSchema, migrate, openDatabase } from "../lib/db.ts";
import { seedCatalogue } from "../db/seed.ts";
import { checkConfigOrExit } from "../lib/config.ts";

checkConfigOrExit();

const db = await openDatabase();
try {
  const applied = await migrate(db);
  console.log(JSON.stringify({ step: "migrate", applied }));
  if (db.kind === "postgres" && !(await loginOwnsSchema(db))) throw new Error("The migration step must log in as the owner of the tables");
  await seedCatalogue(db);
  const user = process.env.APP_DB_USER;
  const password = process.env.APP_DB_PASSWORD;
  if (user || password) {
    if (!user || !password) throw new Error("Set both APP_DB_USER and APP_DB_PASSWORD, or neither");
    await ensureRuntimeLogin(db, user, password);
    console.log(JSON.stringify({ step: "runtime-login", user }));
  }
} catch (e) {
  console.error(JSON.stringify({ step: "failed", error: (e as Error).message }));
  await db.close();
  process.exit(1);
}
await db.close();

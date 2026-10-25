import { migrate, openDatabase } from "../lib/db.ts";
import { seedCatalogue, seedDemo } from "../db/seed.ts";
import { seedGoLiveDemo } from "../db/seed-golive.ts";
import { DEMO } from "../db/seed-data.ts";
import { checkConfigOrExit } from "../lib/config.ts";

checkConfigOrExit();

const db = await openDatabase();
await migrate(db);
await seedCatalogue(db);
if (process.env.NODE_ENV === "production") {
  console.log("Catalogue seeded. Demo data is not loaded in production.");
} else {
  await seedDemo(db);
  await seedGoLiveDemo(db);
  console.log("Seeded catalogue and demo data. Sign in with any of:");
  for (const [email, , role] of DEMO.platform.users) console.log(`  ${role.padEnd(14)} ${email}`);
  for (const p of DEMO.partners) console.log(`  partner_admin  ${p.email}  (${p.name})`);
  console.log(`  client_owner   ${DEMO.client.email}`);
}
await db.close();

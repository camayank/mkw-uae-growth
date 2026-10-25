/**
 * Create MKW Advisors' platform organisation and the first founder account (O10), replacing the one-off SQL in
 * docs/DEPLOY.md. Idempotent: an existing organisation or account is reported, never changed. Sends nothing; the
 * founder signs in with an email code once email is configured (or the code printed by a development server).
 *
 *   pnpm --filter @tasees/api create-founder connect@mkwadvisors.com "Mayank Wadhera"
 */
import { asPlatform, audit } from "../lib/context.ts";
import { migrate, openDatabase } from "../lib/db.ts";
import { checkConfigOrExit } from "../lib/config.ts";

checkConfigOrExit();

const [emailArg, ...nameParts] = process.argv.slice(2);
const email = (emailArg ?? "").trim().toLowerCase();
const name = nameParts.join(" ").trim();
if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || name.length < 2) {
  console.error('Usage: create-founder <email> "<full name>"');
  process.exit(2);
}

const db = await openDatabase();
await migrate(db);
const result = await asPlatform(db, null, async (tx) => {
  let org = (await tx.query<{ id: string }>("select id from orgs where type = 'platform' order by created_at limit 1")).rows[0];
  const createdOrg = !org;
  if (!org) {
    org = (await tx.query<{ id: string }>("insert into orgs (type, name) values ('platform', 'MKW Advisors') returning id")).rows[0]!;
    await audit(tx, null, "org.created", "org", org.id, { type: "platform", name: "MKW Advisors", by: "create-founder script" });
  }
  const existing = (await tx.query<{ id: string; role: string; status: string; org_id: string }>("select id, role, status, org_id from users where email = $1", [email])).rows[0];
  if (existing) return { createdOrg, createdUser: false, note: `${email} already exists (${existing.role}, ${existing.status}); nothing changed` };
  const u = (await tx.query<{ id: string }>("insert into users (org_id, email, name, role) values ($1, $2, $3, 'founder') returning id", [org.id, email, name])).rows[0]!;
  await audit(tx, null, "user.created", "user", u.id, { orgId: org.id, role: "founder", by: "create-founder script" });
  return { createdOrg, createdUser: true, note: `founder account created for ${email}` };
});
console.log(`${result.createdOrg ? "MKW Advisors organisation created. " : ""}${result.note}.`);
await db.close();

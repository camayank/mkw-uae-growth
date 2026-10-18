import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Role } from "@tasees/core";
import type { FastifyRequest } from "fastify";
import { asPlatform, type SessionUser } from "./context.ts";
import type { Database } from "./db.ts";
import { forbidden, unauthorised } from "./errors.ts";

const SESSION_DAYS = 14;
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
/** Codes per email per hour. With 5 guesses per code this caps guessing at 25 tries an hour per account. */
const MAX_CODES_PER_HOUR = 5;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Sign-in by one-time code sent to the user's email. Returns the code so dev and tests can use it. */
export async function issueLoginCode(db: Database, email: string): Promise<{ code: string; known: boolean; limited: boolean }> {
  const normalised = email.trim().toLowerCase();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  let limited = false;
  const known = await asPlatform(db, null, async (tx) => {
    // Deactivated and erased people get no code; the response to the caller is the same either way.
    const u = await tx.query("select 1 from users where email = $1 and status = 'active'", [normalised]);
    if (u.rows.length === 0) return false;
    const recent = await tx.query<{ n: number }>(
      "select count(*)::int as n from login_codes where email = $1 and expires_at > now() - interval '50 minutes'",
      [normalised],
    );
    if ((recent.rows[0]?.n ?? 0) >= MAX_CODES_PER_HOUR) {
      limited = true;
      return true;
    }
    await tx.query("update login_codes set used_at = now() where email = $1 and used_at is null", [normalised]);
    await tx.query(
      `insert into login_codes (email, code_hash, expires_at) values ($1, $2, now() + interval '${CODE_MINUTES} minutes')`,
      [normalised, sha256(`${normalised}:${code}`)],
    );
    return true;
  });
  return { code, known, limited };
}

export async function verifyLoginCode(db: Database, email: string, code: string): Promise<{ token: string; user: SessionUser }> {
  const normalised = email.trim().toLowerCase();
  return asPlatform(db, null, async (tx) => {
    const r = await tx.query<{ id: string; code_hash: string; attempts: number }>(
      `select id, code_hash, attempts from login_codes
       where email = $1 and used_at is null and expires_at > now() order by expires_at desc limit 1`,
      [normalised],
    );
    const row = r.rows[0];
    if (!row || row.attempts >= MAX_ATTEMPTS) throw unauthorised("That code has expired. Ask for a new one.");
    const expected = Buffer.from(row.code_hash, "hex");
    const actual = Buffer.from(sha256(`${normalised}:${code.trim()}`), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await tx.query("update login_codes set attempts = attempts + 1 where id = $1", [row.id]);
      throw unauthorised("That code is not right. Check the email and try again.");
    }
    await tx.query("update login_codes set used_at = now() where id = $1", [row.id]);
    const token = randomBytes(32).toString("base64url");
    const user = await loadUserByEmail(tx, normalised);
    await tx.query(
      `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [sha256(token), user.id],
    );
    return { token, user };
  });
}

/** Create a session directly. Used by the seed script and tests; never exposed over HTTP. */
export async function createSession(db: Database, email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await asPlatform(db, null, async (tx) => {
    const user = await loadUserByEmail(tx, email.toLowerCase());
    await tx.query(
      `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [sha256(token), user.id],
    );
  });
  return token;
}

type Tx = Parameters<Parameters<typeof asPlatform>[2]>[0];

async function loadUserByEmail(tx: Tx, email: string): Promise<SessionUser> {
  const r = await tx.query<UserRow>(USER_SQL + " where u.email = $1 and u.status = 'active'", [email]);
  if (!r.rows[0]) throw unauthorised("No account for that email");
  return toSessionUser(r.rows[0]);
}

interface UserRow {
  id: string;
  org_id: string;
  org_type: SessionUser["orgType"];
  org_name: string;
  role: Role;
  email: string;
  name: string;
}

const USER_SQL = `select u.id, u.org_id, o.type as org_type, o.name as org_name, u.role, u.email, u.name
  from users u join orgs o on o.id = u.org_id`;

const toSessionUser = (r: UserRow): SessionUser => ({
  id: r.id,
  orgId: r.org_id,
  orgType: r.org_type,
  orgName: r.org_name,
  role: r.role,
  email: r.email,
  name: r.name,
});

export async function userFromToken(db: Database, token: string): Promise<SessionUser | null> {
  return asPlatform(db, null, async (tx) => {
    const r = await tx.query<UserRow>(
      USER_SQL + " join sessions s on s.user_id = u.id where s.token_hash = $1 and s.expires_at > now() and u.status = 'active'",
      [sha256(token)],
    );
    return r.rows[0] ? toSessionUser(r.rows[0]) : null;
  });
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await asPlatform(db, null, (tx) => tx.query("delete from sessions where token_hash = $1", [sha256(token)]));
}

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorised();
  return req.user;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): SessionUser {
  const user = requireUser(req);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

export const CLIENT_ROLES: Role[] = ["client_owner", "client_member"];
export const PARTNER_ROLES: Role[] = ["partner_admin", "partner_staff"];
export const PLATFORM_ROLES: Role[] = ["ops", "finance", "founder"];

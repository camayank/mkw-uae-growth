import { ROLE_ORG, type OrgType, type Role } from "@tasees/core";
import type { Database, Queryable } from "./db.ts";

export interface SessionUser {
  id: string;
  orgId: string;
  orgType: OrgType;
  orgName: string;
  role: Role;
  email: string;
  name: string;
}

const DB_ROLE: Record<OrgType, string> = {
  client: "app_client",
  partner: "app_partner",
  platform: "app_platform",
};

async function enter(tx: Queryable, orgType: OrgType, orgId: string | null, userId: string | null, role: string) {
  const dbRole = DB_ROLE[orgType];
  // Role names come from a fixed map, never from input, so this interpolation is safe.
  await tx.query(`set local role ${dbRole}`);
  await tx.query(
    "select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.role', $3, true)",
    [orgId ?? "", userId ?? "", role],
  );
}

/**
 * Run reads as the signed-in user. The database role, row-level security and column grants
 * limit what comes back, whatever the query asks for.
 */
export function asUser<T>(db: Database, user: SessionUser, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (ROLE_ORG[user.role] !== user.orgType) throw new Error("role does not match organisation type");
  return db.transaction(async (tx) => {
    await enter(tx, user.orgType, user.orgId, user.id, user.role);
    return fn(tx);
  });
}

/** Run server-side commands with full access, after the caller has been authorised in code. */
export function asPlatform<T>(db: Database, actor: SessionUser | null, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await enter(tx, "platform", actor?.orgId ?? null, actor?.id ?? null, actor?.role ?? "system");
    return fn(tx);
  });
}

export async function audit(
  tx: Queryable,
  actor: SessionUser | null,
  action: string,
  entity: string,
  entityId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await tx.query("select audit_append($1, $2, $3, $4, $5, $6)", [
    actor?.id ?? null,
    actor?.orgId ?? null,
    action,
    entity,
    entityId,
    JSON.stringify(data),
  ]);
}

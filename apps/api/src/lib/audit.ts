import type { Queryable } from "./db.ts";

export interface AuditCheck {
  checked: number;
  /** Id of the first event whose hash or link does not match, or null when the whole chain is intact. */
  brokenId: number | null;
  intact: boolean;
}

/** Walk the whole audit chain in the database and recompute every hash. */
export async function verifyAuditChain(tx: Queryable): Promise<AuditCheck> {
  const r = await tx.query<{ checked: number | string; broken_id: number | string | null }>("select * from audit_verify()");
  const row = r.rows[0] ?? { checked: 0, broken_id: null };
  const brokenId = row.broken_id === null || row.broken_id === undefined ? null : Number(row.broken_id);
  return { checked: Number(row.checked), brokenId, intact: brokenId === null };
}

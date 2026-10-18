import { buildScope, type IntakeAnswers } from "@tasees/core";
import { z } from "zod";
import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { badRequest, forbidden } from "../lib/errors.ts";
import { loadDeliverables } from "./repo.ts";

export const IntakeSchema = z.object({
  mode: z.enum(["new_company", "services"]),
  jurisdiction: z.enum(["free_zone", "mainland", "offshore", "difc_adgm", "not_sure"]).optional(),
  emirate: z.string().min(2).max(40),
  freeZone: z.string().max(60).nullish(),
  visas: z.number().int().min(0).max(50).optional(),
  dependants: z.number().int().min(0).max(20).optional(),
  addOns: z.array(z.string().max(20)).max(20).optional(),
  services: z.array(z.string().max(20)).max(20).optional(),
});

/**
 * Create a request and its scope sheet. Clients create their own; ops may create one for a client
 * (for example from a lead captured on the Tasees page) by passing `clientOrgId`.
 */
export async function createRequest(
  tx: Queryable,
  user: SessionUser,
  answers: IntakeAnswers,
  clientOrgId?: string,
  sourcedByPartnerId?: string | null,
): Promise<{ id: string; lines: number; notes: string[] }> {
  const parsed = IntakeSchema.safeParse(answers);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  let orgId = user.orgId;
  if (user.orgType === "platform") {
    if (!clientOrgId) throw badRequest("Choose the client this request is for");
    orgId = clientOrgId;
  } else if (user.orgType !== "client") {
    throw forbidden("Partners cannot create client requests");
  }
  const known = new Set((await loadDeliverables(tx)).keys());
  const scope = buildScope(parsed.data as IntakeAnswers, known);
  const r = (
    await tx.query<{ id: string }>(
      `insert into requests (client_org_id, answers, scope, notes, status, sourced_by_partner_id, created_by)
       values ($1,$2,$3,$4,'scoped',$5,$6) returning id`,
      [orgId, JSON.stringify(parsed.data), JSON.stringify({ lines: scope.lines }), scope.notes, sourcedByPartnerId ?? null, user.id],
    )
  ).rows[0]!;
  await audit(tx, user, "request.created", "request", r.id, { lines: scope.lines.length });
  return { id: r.id, lines: scope.lines.length, notes: scope.notes };
}

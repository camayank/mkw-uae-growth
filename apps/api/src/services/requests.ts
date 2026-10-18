import { advise, buildScope, type AdviceInput, type IntakeAnswers } from "@tasees/core";
import { loadScopingRules, loadZones } from "./scoping.ts";
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
  // Scoping intelligence (O5)
  activity: z.enum(["trading", "consulting", "ecommerce", "tech", "holding", "finance", "health", "education", "food", "construction", "other"]).optional(),
  customers: z.enum(["uae_mainland", "international", "both"]).optional(),
  officeNeeded: z.boolean().optional(),
  budgetAed: z.number().min(0).max(100_000_000).nullish(),
  expectedTurnoverAed: z.number().min(0).max(10_000_000_000).nullish(),
  description: z.string().max(2000).optional(),
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
  source: Record<string, unknown> = {},
): Promise<{ id: string; lines: number; notes: string[]; adviceStatus: string }> {
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
  // Scoping advice: computed from the rules and zones as they stand, stored with their confidence, and shown
  // to the client only once ops has approved it. A request with no scoping questions answered gets none.
  const hasScopingAnswers = parsed.data.mode === "new_company" && (parsed.data.activity || parsed.data.customers || parsed.data.expectedTurnoverAed != null);
  const advice = hasScopingAnswers ? advise(parsed.data as AdviceInput, await loadScopingRules(tx), await loadZones(tx)) : null;
  const r = (
    await tx.query<{ id: string }>(
      `insert into requests (client_org_id, answers, scope, notes, status, sourced_by_partner_id, created_by, advice, advice_status, source)
       values ($1,$2,$3,$4,'scoped',$5,$6,$7,$8,$9) returning id`,
      [orgId, JSON.stringify(parsed.data), JSON.stringify({ lines: scope.lines }), scope.notes, sourcedByPartnerId ?? null, user.id, advice ? JSON.stringify(advice) : null, advice ? "pending_review" : "none", JSON.stringify(source)],
    )
  ).rows[0]!;
  await audit(tx, user, "request.created", "request", r.id, { lines: scope.lines.length, advice: !!advice, hasUncertain: advice?.hasUncertain ?? false, source: source.channel ?? "console" });
  return { id: r.id, lines: scope.lines.length, notes: scope.notes, adviceStatus: advice ? "pending_review" : "none" };
}

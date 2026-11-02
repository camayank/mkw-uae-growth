import { z } from "zod";
import { CLIENT_ROLES, requireRole } from "../lib/auth.ts";
import { asPlatform } from "../lib/context.ts";
import { convertHeldLead, renewalRequest, requestFromAssessment } from "../services/handoff.ts";
import { draftScopeForRequest } from "../services/drafts.ts";
import type { RouteContext } from "./context.ts";

/** The handoff into Tasees (E5): a saved result or a held enquiry becomes a request; a renewal is asked for. */
export function registerHandoffRoutes(ctx: RouteContext) {
  const { app, db, opts } = ctx;

  const FromAssessmentBody = z.object({ code: z.string().regex(/^[A-Za-z0-9]{10}$/, "a 10-character code"), description: z.string().max(2000).optional(), addOns: z.array(z.string().max(20)).max(20).optional() });
  app.post("/api/requests/from-assessment", { config: { body: FromAssessmentBody } }, async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES);
    const body = FromAssessmentBody.parse(req.body);
    return asPlatform(db, user, async (tx) => {
      const created = await requestFromAssessment(tx, user, body.code, { description: body.description, addOns: body.addOns });
      const draft = body.description?.trim() ? await draftScopeForRequest(tx, user, created.id, opts.model) : null;
      return { ...created, aiDraft: draft ? draft.id : null };
    });
  });

  const ConvertBody = z.object({ note: z.string().max(300).default("") });
  app.post<{ Params: { id: string } }>("/api/ops/leads/:id/convert", { config: { body: ConvertBody.optional() } }, async (req) => {
    const user = requireRole(req, "ops", "founder");
    const { note } = ConvertBody.parse(req.body ?? {});
    return asPlatform(db, user, async (tx) => {
      const created = await convertHeldLead(tx, user, z.string().uuid().parse(req.params.id), note);
      // A free-text description gets an AI draft into the review queue, as the public intake would have done.
      const draft = created.description ? await draftScopeForRequest(tx, user, created.id, opts.model) : null;
      return { ...created, aiDraft: draft ? draft.id : null };
    });
  });

  app.post<{ Params: { id: string } }>("/api/obligations/:id/renewal-request", { config: { body: null } }, async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES, "ops", "founder");
    return asPlatform(db, user, (tx) => renewalRequest(tx, user, z.string().uuid().parse(req.params.id)));
  });
}

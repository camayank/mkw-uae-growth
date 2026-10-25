import { z } from "zod";
import { CLIENT_ROLES, requireRole, requireUser } from "../lib/auth.ts";
import { asPlatform, asUser } from "../lib/context.ts";
import { notFound } from "../lib/errors.ts";
import { UPLOAD_RULES } from "../lib/storage.ts";
import { draftScopeForRequest } from "../services/drafts.ts";
import { acceptOffer, clientReviewMilestone, decideChangeOrder, postMessage } from "../services/engagements.ts";
import { loadCalendar } from "../services/calendar.ts";
import { createRequest, IntakeSchema, previewRequest } from "../services/requests.ts";
import { clientHome, clientOffer, clientOfferProposal, opsEngagement, partyEngagement } from "../services/views.ts";
import type { RouteContext } from "./context.ts";

/** The catalogue, the client's own screens and the shared engagement view. */
export function registerClientRoutes(ctx: RouteContext) {
  const { app, db, opts, deps } = ctx;

  // Catalogue (any signed-in user) ------------------------------------------------
  app.get("/api/deliverables", async (req) => {
    const user = requireUser(req);
    return asUser(db, user, async (tx) =>
      (await tx.query("select code, name, category, model, billing from deliverables where active order by category, code")).rows,
    );
  });

  // Client -------------------------------------------------------------------
  app.get("/api/client/home", async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES);
    const cal = await asPlatform(db, user, (tx) => loadCalendar(tx));
    return clientHome(db, user, opts.now ? opts.now() : new Date(), cal);
  });

  // What the intake would scope, without saving anything (O12): the services that follow from the answers. Structure
  // and place advice is not shown here: it reaches a client only after a person at MKW has reviewed it (rule 5).
  const RequestsPreviewBody = z.object({ answers: IntakeSchema });
  app.post("/api/requests/preview", { config: { body: RequestsPreviewBody } }, async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES, "ops", "founder");
    const { answers } = RequestsPreviewBody.parse(req.body);
    // Read under the person's own role: it only needs the catalogue, which every role may read.
    return asUser(db, user, (tx) => previewRequest(tx, answers));
  });

  // The page checks a file against these before sending it (O12); the storage adapter enforces the same rules.
  app.get("/api/upload-rules", async () => UPLOAD_RULES);

  const RequestsBody = z.object({ answers: IntakeSchema, clientOrgId: z.string().uuid().optional(), sourcedByPartnerId: z.string().uuid().nullish() });
  app.post("/api/requests", { config: { body: RequestsBody } }, async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES, "ops", "founder");
    const body = RequestsBody.parse(req.body);
    return asPlatform(db, user, async (tx) => {
      const created = await createRequest(tx, user, body.answers, body.clientOrgId, body.sourcedByPartnerId);
      // A free-text description gets an AI draft into the review queue; nothing changes until ops approves it.
      const draft = body.answers.description?.trim() ? await draftScopeForRequest(tx, user, created.id, opts.model) : null;
      return { ...created, aiDraft: draft ? draft.id : null };
    });
  });

  app.get<{ Params: { id: string } }>("/api/client/offers/:id", async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES);
    const offer = (await clientOffer(db, user, req.params.id)) as Parameters<typeof clientOfferProposal>[2];
    return { ...offer, proposal: await clientOfferProposal(db, user, offer) };
  });

  const ClientOffersAcceptBody = z.object({ termsVersion: z.number().int().positive().optional() });
  app.post<{ Params: { id: string } }>("/api/client/offers/:id/accept", { config: { body: ClientOffersAcceptBody.optional() } }, async (req) => {
    const user = requireRole(req, "client_owner");
    const body = ClientOffersAcceptBody.parse(req.body ?? {});
    const engagementId = await asPlatform(db, user, (tx) => acceptOffer(tx, user, req.params.id, deps, body.termsVersion));
    return { engagementId };
  });

  const MilestonesReviewBody = z.object({ approve: z.boolean(), reason: z.string().max(2000).optional() });
  app.post<{ Params: { id: string } }>("/api/milestones/:id/review", { config: { body: MilestonesReviewBody } }, async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES);
    const body = MilestonesReviewBody.parse(req.body);
    await asPlatform(db, user, (tx) => clientReviewMilestone(tx, user, req.params.id, body.approve, body.reason, deps));
    return { ok: true };
  });

  const ChangeOrdersDecideBody = z.object({ approve: z.boolean() });
  app.post<{ Params: { id: string } }>("/api/change-orders/:id/decide", { config: { body: ChangeOrdersDecideBody } }, async (req) => {
    const user = requireRole(req, "client_owner");
    const { approve } = ChangeOrdersDecideBody.parse(req.body);
    await asPlatform(db, user, (tx) => decideChangeOrder(tx, user, req.params.id, approve, deps));
    return { ok: true };
  });

  // Shared engagement view and messages -----------------------------------------------
  app.get<{ Params: { id: string } }>("/api/engagements/:id", async (req) => {
    const user = requireUser(req);
    if (user.orgType === "platform") return opsEngagement(db, user, req.params.id);
    const cal = user.orgType === "client" ? await asPlatform(db, user, (tx) => loadCalendar(tx)) : undefined;
    return partyEngagement(db, user, req.params.id, opts.now ? opts.now() : new Date(), cal);
  });

  const EngagementsMessagesBody = z.object({ body: z.string() });
  app.post<{ Params: { id: string } }>("/api/engagements/:id/messages", { config: { body: EngagementsMessagesBody } }, async (req) => {
    const user = requireUser(req);
    const { body } = EngagementsMessagesBody.parse(req.body);
    await asPlatform(db, user, (tx) => postMessage(tx, user, req.params.id, body));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/evidence/:id/file", async (req, reply) => {
    const user = requireUser(req);
    // The visibility check runs under the user's own database role.
    const row =
      user.orgType === "platform"
        ? await asPlatform(db, user, async (tx) => (await tx.query<{ file_key: string; file_name: string }>("select file_key, file_name from evidence where id = $1", [req.params.id])).rows[0])
        : await asUser(db, user, async (tx) => (await tx.query<{ id: string; file_name: string }>("select id, file_name from evidence where id = $1", [req.params.id])).rows[0]);
    if (!row) throw notFound("File not found");
    const key = await asPlatform(db, user, async (tx) => (await tx.query<{ file_key: string }>("select file_key from evidence where id = $1", [req.params.id])).rows[0]!.file_key);
    const data = await opts.storage.get(key);
    reply.header("content-disposition", `attachment; filename="${row.file_name.replace(/"/g, "")}"`);
    return reply.type("application/octet-stream").send(data);
  });
}

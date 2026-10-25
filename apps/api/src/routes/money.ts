import { z } from "zod";
import { aed } from "@tasees/core";
import { CLIENT_ROLES, PLATFORM_ROLES, requireRole, requireUser } from "../lib/auth.ts";
import { asPlatform, asUser } from "../lib/context.ts";
import { num } from "../lib/db.ts";
import { forbidden, notFound } from "../lib/errors.ts";
import { issueHeldInvoices, loadCompany, refundPayment, statement, updateCompany } from "../services/invoices.ts";
import { cancelPayoutRun, createPayoutRun, exportPayoutRun, listPayoutRuns, markPayoutRunPaid, payablePayouts, setPartnerBank, uploadPartnerInvoice } from "../services/payouts.ts";
import type { RouteContext } from "./context.ts";

/** Statements, invoices, partner bank details and payout runs. */
export function registerMoneyRoutes(ctx: RouteContext) {
  const { app, db, opts } = ctx;

  // Statements and invoices (O3) ------------------------------------------------------------------
  app.get("/api/client/statement", async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES);
    return asPlatform(db, user, (tx) => statement(tx, user.orgId));
  });

  app.get<{ Params: { id: string } }>("/api/ops/clients/:id/statement", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, (tx) => statement(tx, req.params.id));
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id/pdf", async (req, reply) => {
    const user = requireUser(req);
    if (user.orgType === "partner") throw forbidden("Partners do not see client invoices");
    // Clients read under their own database role: row-level security decides whether the invoice is theirs.
    const visible =
      user.orgType === "platform"
        ? await asPlatform(db, user, async (tx) => (await tx.query<{ id: string }>("select id from invoices where id = $1", [req.params.id])).rows[0])
        : await asUser(db, user, async (tx) => (await tx.query<{ id: string }>("select id from invoices where id = $1", [req.params.id])).rows[0]);
    if (!visible) throw notFound("Invoice not found");
    const inv = await asPlatform(db, user, async (tx) => (await tx.query<{ file_key: string | null; number: string }>("select file_key, number from invoices where id = $1", [req.params.id])).rows[0]!);
    if (!inv.file_key) throw notFound("This invoice has no document yet");
    const data = await opts.storage.get(inv.file_key);
    reply.header("content-disposition", `attachment; filename="${inv.number}.pdf"`);
    return reply.type("application/pdf").send(data);
  });

  const OpsPaymentsRefundBody = z.object({ reference: z.string().min(3).max(120), reason: z.string().min(3).max(500) });
  app.post<{ Params: { id: string } }>("/api/ops/payments/:id/refund", { config: { body: OpsPaymentsRefundBody } }, async (req) => {
    const user = requireRole(req, "finance", "founder");
    const body = OpsPaymentsRefundBody.parse(req.body);
    return asPlatform(db, user, (tx) => refundPayment(tx, user, req.params.id, body.reference, body.reason, opts.storage, opts.notify));
  });

  app.get("/api/admin/company", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    const c = await asPlatform(db, user, (tx) => loadCompany(tx));
    const held = await asPlatform(db, user, async (tx) => num((await tx.query<{ n: number }>("select count(*)::int as n from invoices where status = 'pending_trn'")).rows[0]?.n));
    return { ...c, iban: user.role === "ops" ? (c.iban ? "set" : "") : c.iban, heldInvoices: held };
  });

  const AdminCompanyBody = z.object({
      legalName: z.string().min(2).max(200).optional(),
      trn: z.string().max(20).nullable().optional(),
      address: z.string().max(500).optional(),
      bankName: z.string().max(120).optional(),
      iban: z.string().max(40).optional(),
      swift: z.string().max(20).optional(),
      govFeesConfirmed: z.boolean().optional(),
      note: z.string().min(3).max(500),
    });
  app.put("/api/admin/company", { config: { body: AdminCompanyBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminCompanyBody.parse(req.body);
    const { note, ...patch } = body;
    return asPlatform(db, user, (tx) => updateCompany(tx, user, patch, note));
  });

  app.post("/api/admin/invoices/issue-held", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "founder");
    return asPlatform(db, user, (tx) => issueHeldInvoices(tx, user, opts.storage, opts.notify));
  });

  // Partner bank details and invoices; payout runs (O3) -------------------------------------------
  const PartnerBankBody = z.object({ beneficiary: z.string().min(2).max(140), iban: z.string().min(10).max(40), bank: z.string().min(2).max(120) });
  app.put("/api/partner/bank", { config: { body: PartnerBankBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = PartnerBankBody.parse(req.body);
    return asPlatform(db, user, (tx) => setPartnerBank(tx, user, body));
  });

  const PayoutsInvoiceBody = z.object({ number: z.string().min(1).max(60), amountAed: z.number().min(0), vatAed: z.number().min(0).default(0), fileName: z.string().min(1).max(200), contentBase64: z.string().min(1) });
  app.post<{ Params: { id: string } }>("/api/payouts/:id/invoice", { config: { body: PayoutsInvoiceBody } }, async (req) => {
    const user = requireRole(req, "partner_admin");
    const body = PayoutsInvoiceBody.parse(req.body);
    return asPlatform(db, user, (tx) =>
      uploadPartnerInvoice(tx, user, { payoutId: req.params.id, number: body.number, amountFils: aed(body.amountAed), vatFils: aed(body.vatAed), fileName: body.fileName, content: Buffer.from(body.contentBase64, "base64") }, opts.storage),
    );
  });

  app.get("/api/ops/payouts/payable", async (req) => {
    const user = requireRole(req, "finance", "founder");
    return asPlatform(db, user, (tx) => payablePayouts(tx));
  });

  app.get("/api/ops/payout-runs", async (req) => {
    const user = requireRole(req, "finance", "founder");
    return asPlatform(db, user, (tx) => listPayoutRuns(tx));
  });

  app.post("/api/ops/payout-runs", { config: { body: null } }, async (req) => {
    const user = requireRole(req, "finance", "founder");
    return asPlatform(db, user, (tx) => createPayoutRun(tx, user));
  });

  app.get<{ Params: { id: string } }>("/api/ops/payout-runs/:id/file", async (req, reply) => {
    const user = requireRole(req, "finance", "founder");
    const { csv, fileName } = await asPlatform(db, user, (tx) => exportPayoutRun(tx, user, req.params.id, opts.storage));
    reply.header("content-disposition", `attachment; filename="${fileName}"`);
    return reply.type("text/csv; charset=utf-8").send(csv);
  });

  const OpsPayoutRunsPaidBody = z.object({ bankReference: z.string().min(3).max(120) });
  app.post<{ Params: { id: string } }>("/api/ops/payout-runs/:id/paid", { config: { body: OpsPayoutRunsPaidBody } }, async (req) => {
    const user = requireRole(req, "finance", "founder");
    const { bankReference } = OpsPayoutRunsPaidBody.parse(req.body);
    return asPlatform(db, user, (tx) => markPayoutRunPaid(tx, user, req.params.id, bankReference, opts.notify));
  });

  const OpsPayoutRunsCancelBody = z.object({ reason: z.string().min(3).max(300), confirmNotSubmitted: z.boolean().default(false) });
  app.post<{ Params: { id: string } }>("/api/ops/payout-runs/:id/cancel", { config: { body: OpsPayoutRunsCancelBody } }, async (req) => {
    const user = requireRole(req, "finance", "founder");
    const body = OpsPayoutRunsCancelBody.parse(req.body);
    return asPlatform(db, user, (tx) => cancelPayoutRun(tx, user, req.params.id, body.reason, body.confirmNotSubmitted));
  });
}

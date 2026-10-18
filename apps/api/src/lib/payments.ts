import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Card payment provider behind one interface. `memoryProvider` serves tests and development and defines the
 * generic signed-webhook contract; the real provider (Network International, Telr, Checkout.com or Stripe UAE)
 * implements the same two calls once MKW has a merchant account.
 *
 * Webhook contract (generic): the provider POSTs JSON with headers
 *   x-webhook-timestamp: unix seconds
 *   x-webhook-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the shared secret>
 * Replays older than five minutes and any signature mismatch are refused before the body is read.
 */
export interface PaymentLinkRequest {
  paymentId: string;
  amountFils: number;
  /** Shown to the payer; never free text typed by a user. */
  description: string;
  /** MKW's reference the payer sees on the statement. */
  reference: string;
}

export interface PaymentLink {
  url: string;
  providerRef: string;
}

export interface PaidEvent {
  kind: "payment.paid";
  paymentId: string;
  amountFils: number;
  reference: string;
}

export interface PaymentProvider {
  kind: string;
  createLink(req: PaymentLinkRequest): Promise<PaymentLink>;
  /** Throws when the message is not authentic. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaidEvent;
}

export const WEBHOOK_WINDOW_SECONDS = 300;

export function signWebhook(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): { timestamp: string; signature: string } {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return { timestamp: String(timestamp), signature: `sha256=${sig}` };
}

export function verifySignedWebhook(secret: string, rawBody: string, headers: Record<string, string | string[] | undefined>, now = () => new Date()): PaidEvent {
  if (!secret) throw new Error("webhook secret not configured");
  const ts = String(headers["x-webhook-timestamp"] ?? "");
  const given = String(headers["x-webhook-signature"] ?? "");
  if (!/^\d{9,11}$/.test(ts)) throw new Error("missing or malformed timestamp");
  const age = Math.abs(Math.floor(now().getTime() / 1000) - Number(ts));
  if (age > WEBHOOK_WINDOW_SECONDS) throw new Error("timestamp outside the five-minute window");
  const expected = signWebhook(secret, rawBody, Number(ts)).signature;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("signature does not match");
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new Error("body is not JSON");
  }
  const e = body as Partial<PaidEvent> & { status?: string };
  if ((e.kind ?? (e.status === "paid" ? "payment.paid" : "")) !== "payment.paid") throw new Error("unsupported event");
  if (typeof e.paymentId !== "string" || !/^[0-9a-f-]{36}$/i.test(e.paymentId)) throw new Error("bad paymentId");
  if (!Number.isInteger(e.amountFils) || (e.amountFils as number) <= 0) throw new Error("bad amount");
  if (typeof e.reference !== "string" || e.reference.length < 3) throw new Error("bad reference");
  return { kind: "payment.paid", paymentId: e.paymentId, amountFils: e.amountFils as number, reference: e.reference };
}

/** Links point at a local page; webhooks follow the generic contract. The secret doubles as the "provider" key. */
export function memoryProvider(secret: string, appUrl = "http://localhost:8787", now?: () => Date): PaymentProvider & { links: Array<PaymentLink & { amountFils: number }> } {
  const links: Array<PaymentLink & { amountFils: number }> = [];
  return {
    kind: "memory",
    links,
    async createLink(req) {
      const link = { url: `${appUrl.replace(/\/$/, "")}/#/pay/${req.paymentId}`, providerRef: `link_${randomUUID().slice(0, 8)}` };
      links.push({ ...link, amountFils: req.amountFils });
      return link;
    },
    verifyWebhook(rawBody, headers) {
      return verifySignedWebhook(secret, rawBody, headers, now);
    },
  };
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentProvider {
  // Only the memory provider exists until a merchant account is chosen; PAYMENT names the future adapter.
  return memoryProvider(env.PAYMENT_WEBHOOK_SECRET ?? "", env.APP_URL ?? `http://localhost:${env.PORT ?? 8787}`);
}

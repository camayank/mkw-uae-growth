import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { userFromToken } from "./lib/auth.ts";
import { withClock, type Database } from "./lib/db.ts";
import { badRequest, errorForLog, HttpError } from "./lib/errors.ts";
import type { Storage } from "./lib/storage.ts";
import type { Notifier } from "./lib/notify.ts";
import type { PaymentProvider } from "./lib/payments.ts";
import type { AiModel } from "./lib/ai.ts";
import { registerDocumentChecker } from "./services/doccheck.ts";
import { registerIdempotency } from "./lib/idempotency.ts";
import { collectRoutes } from "./lib/openapi.ts";
import { type Deps } from "./services/engagements.ts";
import { COOKIE, bearer, cookie } from "./routes/common.ts";
import type { RouteContext } from "./routes/context.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerClientRoutes } from "./routes/client.ts";
import { registerPartnerRoutes } from "./routes/partner.ts";
import { registerOpsRoutes } from "./routes/ops.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerDeliveryRoutes } from "./routes/delivery.ts";
import { registerReportingRoutes } from "./routes/reporting.ts";
import { registerScopingRoutes } from "./routes/scoping.ts";
import { registerMoneyRoutes } from "./routes/money.ts";
import { registerSystemRoutes } from "./routes/system.ts";

export interface AppOptions {
  db: Database;
  notify: Notifier;
  storage: Storage;
  provider: PaymentProvider;
  model: AiModel;
  now?: () => Date;
  /** Return one-time login codes in the response. Development only. */
  devLogin?: boolean;
  /** Number of trusted proxy hops in front of the API; 0/undefined ignores X-Forwarded-For. */
  trustProxy?: number;
  webhookSecret?: string;
  webDir?: string;
  /** MKW's alert address (ALERT_EMAIL, O13). */
  alertEmail?: string;
  /** When this process started: a platform whose jobs never ran is late this long after it (O13). */
  startedAt?: Date;
  /** JSON request logs (O13); tests pass a stream to read the lines. */
  logger?: boolean | { stream: { write(line: string): void } };
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  // trustProxy: only when told how many proxy hops sit in front (TRUST_PROXY=1 behind one load balancer), so
  // X-Forwarded-For cannot be spoofed by a direct caller and every visitor behind a proxy is not one address.
  const app = Fastify({
    logger: opts.logger ? loggerOptions(typeof opts.logger === "object" ? opts.logger.stream : undefined) : false,
    genReqId: requestId,
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: opts.trustProxy ?? false,
  });
  // Every route as it is registered, for the contract (O13). Must come before the first route.
  const routeDocs = collectRoutes(app);
  const db = withClock(opts.db, opts.now);
  const deps: Deps = { notify: opts.notify, now: opts.now, provider: opts.provider, storage: opts.storage };
  // Agents subscribed to the outbox (O11). The scheduled jobs process registers the same ones.
  registerDocumentChecker(opts.notify, db, opts.model);

  // Keep the raw JSON body: the payment webhook signature covers the bytes as sent, not a re-serialisation.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body === "" ? null : JSON.parse(body as string));
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  // Queued notifications go out once the response is on its way, after every transaction of the request.
  app.addHook("onResponse", async () => {
    await opts.notify.flush();
  });

  app.addHook("onRequest", async (req, reply) => {
    const token = bearer(req) ?? cookie(req, COOKIE);
    if (token) req.user = (await userFromToken(db, token)) ?? undefined;
    // Every later line of this request says whose it is: ids only, never the email or the name (O13).
    if (req.user) reply.log = req.log = req.log.child({ userId: req.user.id, orgId: req.user.orgId, role: req.user.role });
  });

  // A repeated change with the same Idempotency-Key gets the first answer (O13).
  registerIdempotency(app, db);

  // Per-IP limit on the sign-in endpoints, per 15 minutes. In-process; put a shared limiter at the proxy when running
  // more than one instance.
  const hits = new Map<string, { n: number; until: number }>();
  const throttle = (req: FastifyRequest, bucket: string, max: number) => {
    const key = `${bucket}:${req.ip}`;
    const t = Date.now();
    const h = hits.get(key);
    if (!h || h.until < t) hits.set(key, { n: 1, until: t + 15 * 60 * 1000 });
    else if (++h.n > max) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.", "too_many_requests");
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < t) hits.delete(k);
  };

  // Security headers for every response. The web app uses only same-origin scripts and styles.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!opts.devLogin) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "bad_request", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    if ((err as Error).name === "TransitionError") return reply.status(409).send({ error: "conflict", message: (err as Error).message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
    req.log.error({ err }, "request failed");
    // The request id lets a person quote the failure and MKW find its log lines.
    return reply.status(500).send({ error: "server_error", message: `Something went wrong on our side. Try again in a minute. If it keeps happening, quote reference ${req.id}.`, requestId: req.id });
  });

  // What every route module shares.
  const ctx: RouteContext = {
    app,
    db,
    opts,
    deps,
    throttle,
    fileBody: z.object({ fileName: z.string().min(1).max(200), contentBase64: z.string().min(1) }),
    putFile: async (folder, fileName, contentBase64) => {
      try {
        return await opts.storage.put(folder, fileName, Buffer.from(contentBase64, "base64"));
      } catch (e) {
        throw badRequest((e as Error).message);
      }
    },
    routeDocs,
    arabic: { flag: null },
  };

  // Routes, by area (src/routes/).
  registerAuthRoutes(ctx);
  registerClientRoutes(ctx);
  registerPartnerRoutes(ctx);
  registerOpsRoutes(ctx);
  registerAdminRoutes(ctx);
  registerDeliveryRoutes(ctx);
  registerReportingRoutes(ctx);
  registerScopingRoutes(ctx);
  registerMoneyRoutes(ctx);
  registerSystemRoutes(ctx);

  // Web app ------------------------------------------------------------------
  if (opts.webDir) registerStatic(app, opts.webDir);

  return app;
}

/** A load balancer's request id is kept when it is well formed; otherwise one is made here. */
export function requestId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const h = req.headers["x-request-id"];
  return typeof h === "string" && /^[A-Za-z0-9._:-]{8,64}$/.test(h) ? h : randomUUID();
}

/**
 * One JSON line per request: method, path without its query (a search can carry a name or an email), status, time,
 * request id, and after sign-in the user, organisation and role ids. Headers, bodies and addresses are never logged,
 * and error text is cleaned of the values a database or provider error can quote.
 */
function loggerOptions(stream?: { write(line: string): void }) {
  return {
    level: "info",
    ...(stream ? { stream } : {}),
    serializers: {
      // No address: the request id and, after sign-in, the user id identify a request; an address is personal data.
      req: (r: { method: string; url: string }) => ({ method: r.method, path: r.url.split("?")[0] }),
      err: errorForLog,
      res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
    },
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function registerStatic(app: FastifyInstance, dir: string) {
  const root = resolve(dir);
  app.get("/*", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = (req.params as { "*": string })["*"] || "index.html";
    if (url.startsWith("api/")) return reply.status(404).send({ error: "not_found", message: "No such endpoint" });
    let path = normalize(join(root, url));
    if (!path.startsWith(root)) return reply.status(404).send();
    try {
      if (!(await stat(path)).isFile()) path = join(root, "index.html");
    } catch {
      path = join(root, "index.html");
    }
    reply.header("cache-control", "no-cache");
    return reply.type(TYPES[extname(path)] ?? "application/octet-stream").send(await readFile(path));
  });
}

/**
 * Idempotency keys (O13). A change sent with `Idempotency-Key` runs once: a repeat with the same key, method, path and
 * body gets the first answer again (`idempotent-replay: true`); the same key on a different request is refused (422);
 * a repeat while the first is still running is told to wait (409). Keys belong to the signed-in person, are kept 24
 * hours and erased with the person; public routes do not take them (they have their own duplicate checks).
 *
 * The key is claimed before the handler runs and its answer recorded as the response leaves. A server error (5xx)
 * rolled the change back, so its key is released for a retry. If the process stops between the change committing and
 * the answer being recorded, the key stays "running" and every repeat gets 409 until it expires: the person checks
 * the screen instead of the change happening twice.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { asPlatform } from "./context.ts";
import type { Database } from "./db.ts";
import { HttpError } from "./errors.ts";

const CHANGES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
export const KEEP_HOURS = 24;

declare module "fastify" {
  interface FastifyRequest {
    idempotency?: { userId: string; key: string };
  }
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function registerIdempotency(app: FastifyInstance, db: Database) {
  app.addHook("preHandler", async (req, reply) => {
    const raw = req.headers["idempotency-key"];
    if (raw === undefined || !CHANGES.has(req.method)) return;
    const key = Array.isArray(raw) ? raw[0]! : raw;
    if (!KEY_PATTERN.test(key)) throw new HttpError(400, "Idempotency-Key must be 8 to 100 letters, digits or . _ : -", "bad_request");
    if (!req.user) throw new HttpError(400, "Idempotency keys are for signed-in requests only.", "bad_request");
    const userId = req.user.id;
    const bodyHash = hash(bodyText(req));
    const result = await asPlatform(db, null, async (tx) => {
      const claimed = await tx.query(
        `insert into idempotency_keys (user_id, key, method, path, body_hash) values ($1, $2, $3, $4, $5)
           on conflict (user_id, key) do nothing returning key`,
        [userId, key, req.method, req.url, bodyHash],
      );
      if (claimed.rows.length) return { claimed: true as const };
      const prior = (
        await tx.query<{ method: string; path: string; body_hash: string; state: string; status_code: number | null; response: string | null }>(
          "select method, path, body_hash, state, status_code, response from idempotency_keys where user_id = $1 and key = $2",
          [userId, key],
        )
      ).rows[0]!;
      return { claimed: false as const, prior };
    });
    if (result.claimed) {
      req.idempotency = { userId, key };
      return;
    }
    const { prior } = result;
    if (prior.method !== req.method || prior.path !== req.url || prior.body_hash !== bodyHash) {
      throw new HttpError(422, "This Idempotency-Key was already used for a different request. Use a new key.", "idempotency_mismatch");
    }
    if (prior.state !== "done") {
      throw new HttpError(409, "This request is still being processed. Check the page before trying again.", "in_progress");
    }
    reply.header("idempotent-replay", "true").type("application/json; charset=utf-8").status(prior.status_code ?? 200);
    return reply.send(prior.response ?? "");
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const idem = req.idempotency;
    if (!idem) return payload;
    req.idempotency = undefined;
    const keep = reply.statusCode < 500 && (typeof payload === "string" || payload === null || payload === undefined);
    await asPlatform(db, null, (tx) =>
      keep
        ? tx.query("update idempotency_keys set state = 'done', status_code = $3, response = $4 where user_id = $1 and key = $2", [
            idem.userId,
            idem.key,
            reply.statusCode,
            (payload as string | null | undefined) ?? "",
          ])
        : tx.query("delete from idempotency_keys where user_id = $1 and key = $2", [idem.userId, idem.key]),
    );
    return payload;
  });
}

function bodyText(req: FastifyRequest): string {
  if (typeof req.rawBody === "string") return req.rawBody;
  return req.body === undefined || req.body === null ? "" : JSON.stringify(req.body);
}

/** Jobs step: drop keys older than a day. */
export async function purgeIdempotencyKeys(tx: { query: (sql: string) => Promise<{ rowCount?: number | null; rows: unknown[] }> }): Promise<number> {
  const r = await tx.query(`delete from idempotency_keys where created_at < app_now() - interval '${KEEP_HOURS} hours' returning 1`);
  return r.rows.length;
}

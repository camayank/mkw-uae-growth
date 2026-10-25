import { z } from "zod";
import { CLIENT_ROLES, issueLoginCode, PLATFORM_ROLES, requireRole, requireUser, revokeSession, verifyLoginCode } from "../lib/auth.ts";
import { asPlatform } from "../lib/context.ts";
import { arabicAvailable, arabicGaps, arabicStatus, recordArabicReview, reportGaps, setLocale } from "../services/locale.ts";
import { COOKIE, publicUser, bearer, cookie } from "./common.ts";
import type { RouteContext } from "./context.ts";

/** Sign-in, the signed-in person and their language. */
export function registerAuthRoutes(ctx: RouteContext) {
  const { app, db, opts, throttle } = ctx;

  // Auth ---------------------------------------------------------------------
  const AuthRequestCodeBody = z.object({ email: z.string().email() });
  app.post("/api/auth/request-code", { config: { body: AuthRequestCodeBody } }, async (req) => {
    throttle(req, "request-code", 20);
    const { email } = AuthRequestCodeBody.parse(req.body);
    const { code, known, limited } = await issueLoginCode(db, email);
    const issued = known && !limited;
    if (issued) await opts.notify.send({ to: email.toLowerCase(), channel: "email", template: "login_code", vars: { code } });
    // Same answer whether or not the email has an account (or was throttled), so it cannot be used to probe accounts.
    return { ok: true, ...(opts.devLogin && issued ? { devCode: code } : {}) };
  });

  const AuthVerifyBody = z.object({ email: z.string().email(), code: z.string().min(4).max(10) });
  app.post("/api/auth/verify", { config: { body: AuthVerifyBody } }, async (req, reply) => {
    throttle(req, "verify", 30);
    const body = AuthVerifyBody.parse(req.body);
    const { token, user } = await verifyLoginCode(db, body.email, body.code);
    reply.header("set-cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${opts.devLogin ? "" : "; Secure"}`);
    const arabic = await asPlatform(db, user, (tx) => arabicAvailable(tx, user));
    return { token, user: { ...publicUser(user), locale: user.locale ?? "en", arabic } };
  });

  app.post("/api/auth/logout", { config: { body: null } }, async (req, reply) => {
    const token = bearer(req) ?? cookie(req, COOKIE);
    if (token) await revokeSession(db, token);
    reply.header("set-cookie", `${COOKIE}=; Path=/; Max-Age=0`);
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const user = requireUser(req);
    const arabic = await asPlatform(db, user, (tx) => arabicAvailable(tx, user));
    return { ...publicUser(user), locale: user.locale ?? "en", arabic };
  });
  const MeLocaleBody = z.object({ locale: z.enum(["en", "ar"]) });
  app.put("/api/me/locale", { config: { body: MeLocaleBody } }, async (req) => {
    const user = requireUser(req);
    const { locale } = MeLocaleBody.parse(req.body);
    return asPlatform(db, user, (tx) => setLocale(tx, user, locale));
  });
  app.get("/api/admin/arabic", async (req) => {
    const user = requireRole(req, ...PLATFORM_ROLES);
    return asPlatform(db, user, async (tx) => ({ ...(await arabicStatus(tx)), gaps: await arabicGaps(tx) }));
  });
  const MeI18nGapsBody = z.object({ strings: z.array(z.string().max(200)).max(200) });
  app.post("/api/me/i18n-gaps", { config: { body: MeI18nGapsBody } }, async (req) => {
    const user = requireRole(req, ...CLIENT_ROLES, ...PLATFORM_ROLES);
    const { strings } = MeI18nGapsBody.parse(req.body);
    return asPlatform(db, user, (tx) => reportGaps(tx, user, strings));
  });
  const AdminArabicReviewBody = z.object({ reviewed: z.boolean(), reviewedBy: z.string().max(120).optional(), note: z.string().max(500).optional(), previewEmails: z.array(z.string().email()).max(10).optional() });
  app.post("/api/admin/arabic/review", { config: { body: AdminArabicReviewBody } }, async (req) => {
    const user = requireRole(req, "founder");
    const body = AdminArabicReviewBody.parse(req.body);
    const result = await asPlatform(db, user, (tx) => recordArabicReview(tx, user, body));
    ctx.arabic.flag = null; // the health endpoint reads the new state at once
    return result;
  });
}

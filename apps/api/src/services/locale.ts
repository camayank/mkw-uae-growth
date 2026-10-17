import { audit, type SessionUser } from "../lib/context.ts";
import type { Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden } from "../lib/errors.ts";

/**
 * Language (O9). Arabic is a draft until an Arabic speaker the owner names has reviewed it: before the
 * sign-off a client is kept on English by the server, and MKW staff may preview Arabic to review it.
 */
export type Locale = "en" | "ar";

export interface ArabicStatus {
  reviewed: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  note: string;
}

export async function arabicStatus(tx: Queryable): Promise<ArabicStatus> {
  const r = await tx.query<{ value: ArabicStatus }>("select value from settings where key = 'arabic'");
  return r.rows[0]?.value ?? { reviewed: false, reviewedBy: null, reviewedAt: null, note: "" };
}

/** Whether this person may see Arabic right now: staff always (as a preview), clients only once reviewed. */
export async function arabicAvailable(tx: Queryable, user: SessionUser): Promise<{ available: boolean; preview: boolean; reviewed: boolean }> {
  const status = await arabicStatus(tx);
  if (user.orgType === "platform") return { available: true, preview: !status.reviewed, reviewed: status.reviewed };
  return { available: status.reviewed, preview: false, reviewed: status.reviewed };
}

export async function setLocale(tx: Queryable, user: SessionUser, locale: Locale) {
  if (locale !== "en" && locale !== "ar") throw badRequest("Language must be en or ar");
  if (locale === "ar") {
    const a = await arabicAvailable(tx, user);
    if (!a.available) throw conflict("Arabic is being reviewed and is not yet available");
  }
  await tx.query("update users set locale = $2 where id = $1", [user.id, locale]);
  await audit(tx, user, "user.locale", "user", user.id, { locale });
  return { ok: true, locale };
}

/** The founder records the reviewer's sign-off (or withdraws it). Audited; from then on clients may choose Arabic. */
export async function recordArabicReview(tx: Queryable, actor: SessionUser, input: { reviewed: boolean; reviewedBy?: string; note?: string }) {
  if (actor.role !== "founder") throw forbidden("Only the founder records the Arabic review");
  if (input.reviewed && (!input.reviewedBy || input.reviewedBy.trim().length < 2)) throw badRequest("Name the Arabic reviewer");
  const before = await arabicStatus(tx);
  const value: ArabicStatus = input.reviewed
    ? { reviewed: true, reviewedBy: input.reviewedBy!.trim(), reviewedAt: new Date().toISOString(), note: (input.note ?? "").trim() }
    : { reviewed: false, reviewedBy: null, reviewedAt: null, note: (input.note ?? "").trim() };
  await tx.query("insert into settings (key, value) values ('arabic', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(value)]);
  if (!value.reviewed) {
    // Withdrawn: clients go back to English until the next sign-off.
    await tx.query("update users set locale = 'en' where locale = 'ar' and org_id in (select id from orgs where type = 'client')");
  }
  await audit(tx, actor, "arabic.review_recorded", "settings", "arabic", { before, after: value });
  return value;
}

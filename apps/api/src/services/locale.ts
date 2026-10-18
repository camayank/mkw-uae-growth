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
  /** Client accounts allowed to preview Arabic before the sign-off (the reviewer's test client). */
  previewEmails?: string[];
}

export async function arabicStatus(tx: Queryable): Promise<ArabicStatus> {
  const r = await tx.query<{ value: ArabicStatus }>("select value from settings where key = 'arabic'");
  return r.rows[0]?.value ?? { reviewed: false, reviewedBy: null, reviewedAt: null, note: "" };
}

/**
 * Whether this person may see Arabic right now: staff always (as a preview); clients once reviewed, or
 * before that when the founder listed their email as a preview account (the reviewer's own test client);
 * partners never (their screens are English by design).
 */
export async function arabicAvailable(tx: Queryable, user: SessionUser): Promise<{ available: boolean; preview: boolean; reviewed: boolean }> {
  const status = await arabicStatus(tx);
  if (user.orgType === "platform") return { available: true, preview: !status.reviewed, reviewed: status.reviewed };
  if (user.orgType === "partner") return { available: false, preview: false, reviewed: status.reviewed };
  const previewer = (status.previewEmails ?? []).includes(user.email.toLowerCase());
  return { available: status.reviewed || previewer, preview: !status.reviewed && previewer, reviewed: status.reviewed };
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
export async function recordArabicReview(tx: Queryable, actor: SessionUser, input: { reviewed: boolean; reviewedBy?: string; note?: string; previewEmails?: string[] }) {
  if (actor.role !== "founder") throw forbidden("Only the founder records the Arabic review");
  if (input.reviewed && (!input.reviewedBy || input.reviewedBy.trim().length < 2)) throw badRequest("Name the Arabic reviewer");
  const before = await arabicStatus(tx);
  const now = String((await tx.query<{ t: string }>("select app_now()::text as t")).rows[0]!.t);
  const previewEmails = (input.previewEmails ?? before.previewEmails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)).slice(0, 10);
  const value: ArabicStatus = input.reviewed
    ? { reviewed: true, reviewedBy: input.reviewedBy!.trim(), reviewedAt: now, note: (input.note ?? "").trim(), previewEmails }
    : { reviewed: false, reviewedBy: null, reviewedAt: null, note: (input.note ?? "").trim(), previewEmails };
  await tx.query("insert into settings (key, value) values ('arabic', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(value)]);
  if (!value.reviewed) {
    // Withdrawn: every client and partner on Arabic goes back to English, each change on the record.
    const reset = (
      await tx.query<{ id: string }>("update users set locale = 'en' where locale = 'ar' and org_id in (select id from orgs where type in ('client', 'partner')) and lower(email) <> all($1::text[]) returning id", [previewEmails])
    ).rows;
    for (const u of reset) await audit(tx, actor, "user.locale", "user", u.id, { locale: "en", reason: "arabic_review_withdrawn" });
  }
  await audit(tx, actor, "arabic.review_recorded", "settings", "arabic", { before, after: value });
  return value;
}

/** Strings a client's Arabic screen could not translate, reported by the page for the reviewer (capped, deduplicated). */
export async function reportGaps(tx: Queryable, user: SessionUser, strings: string[]) {
  if (user.orgType !== "client" && user.orgType !== "platform") throw forbidden("Not for partners");
  const clean = [...new Set(strings.map((s) => s.trim().slice(0, 200)).filter((s) => s.length > 1 && /[a-zA-Z]{2,}/.test(s) && !/@|https?:/.test(s)))].slice(0, 200);
  const current = (await tx.query<{ value: string[] }>("select value from settings where key = 'arabic_gaps'")).rows[0]?.value ?? [];
  const merged = [...new Set([...current, ...clean])].slice(0, 500);
  await tx.query("insert into settings (key, value) values ('arabic_gaps', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(merged)]);
  return { ok: true, total: merged.length };
}

export async function arabicGaps(tx: Queryable): Promise<string[]> {
  return (await tx.query<{ value: string[] }>("select value from settings where key = 'arabic_gaps'")).rows[0]?.value ?? [];
}

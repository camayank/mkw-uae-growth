import { createHash } from "node:crypto";
import { audit, type SessionUser } from "../lib/context.ts";
import { num, type Queryable } from "../lib/db.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";

/**
 * Client terms and the Partner Network Agreement (O10). Each text is stored as numbered versions. The latest
 * version is the one shown; it carries "Draft, pending legal review" until the founder records the lawyer's
 * name and date for that version. Clients accept the terms with the offer (the engagement keeps the version);
 * the partner admin accepts the agreement during onboarding (the firm's profile keeps the version). Accepting
 * on the platform is not the signed agreement: a partner still uploads the signed copy to reach `signed`.
 */

export type LegalKind = "client_terms" | "partner_agreement";
export const LEGAL_KINDS: LegalKind[] = ["client_terms", "partner_agreement"];

export interface LegalDocument {
  kind: LegalKind;
  version: number;
  title: string;
  body: string;
  createdAt: string;
  draft: boolean;
  approvedByLawyer: string | null;
  approvedOn: string | null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const normalise = (body: string) => body.replace(/\r\n/g, "\n").trim() + "\n";

function toDoc(r: Record<string, unknown>): LegalDocument {
  return {
    kind: r.kind as LegalKind,
    version: num(r.version),
    title: String(r.title),
    body: String(r.body),
    createdAt: String(r.created_at),
    draft: !r.approved_by_lawyer,
    approvedByLawyer: (r.approved_by_lawyer as string | null) ?? null,
    approvedOn: r.approved_on ? String(r.approved_on).slice(0, 10) : null,
  };
}

export async function currentLegal(tx: Queryable, kind: LegalKind): Promise<LegalDocument | null> {
  const r = await tx.query<Record<string, unknown>>(
    "select kind, version, title, body, created_at, approved_by_lawyer, approved_on::text as approved_on from legal_documents where kind = $1 order by version desc limit 1",
    [kind],
  );
  return r.rows[0] ? toDoc(r.rows[0]) : null;
}

/** What a person may read: clients the terms, partners the agreement, MKW staff both. */
export function assertMayRead(actor: SessionUser, kind: LegalKind) {
  if (actor.orgType === "platform") return;
  if (kind === "client_terms" && actor.orgType === "client") return;
  if (kind === "partner_agreement" && actor.orgType === "partner") return;
  throw forbidden("Not available to you");
}

/** Overview for the founder's Settings page: each text's latest version and its review state. */
export async function legalOverview(tx: Queryable) {
  const out: Array<Omit<LegalDocument, "body"> & { versions: number }> = [];
  for (const kind of LEGAL_KINDS) {
    const d = await currentLegal(tx, kind);
    if (!d) continue;
    const { body: _b, ...rest } = d;
    out.push({ ...rest, versions: d.version });
  }
  return out;
}

/**
 * Store a text as a new version when it differs from the latest one; identical text changes nothing. Used by the
 * import and by the demo seed. A new version is always a draft: an earlier sign-off does not carry over.
 */
export async function upsertLegalText(tx: Queryable, kind: LegalKind, title: string, body: string, source: string): Promise<{ action: "created" | "unchanged"; version: number }> {
  if (!LEGAL_KINDS.includes(kind)) throw badRequest("Unknown legal text");
  const text = normalise(body);
  if (text.trim().length < 50) throw badRequest("The text is too short to be the document");
  const latest = (await tx.query<{ version: number; body_sha256: string }>("select version, body_sha256 from legal_documents where kind = $1 order by version desc limit 1", [kind])).rows[0];
  if (latest && latest.body_sha256 === sha(text)) return { action: "unchanged", version: num(latest.version) };
  const version = latest ? num(latest.version) + 1 : 1;
  await tx.query("insert into legal_documents (kind, version, title, body, body_sha256) values ($1, $2, $3, $4, $5)", [kind, version, title.trim().slice(0, 200), text, sha(text)]);
  await audit(tx, null, "legal.version_added", "legal_document", `${kind}:${version}`, { kind, version, title: title.trim(), sha256: sha(text), source });
  return { action: "created", version };
}

/** The founder records that a named lawyer reviewed this exact version. */
export async function recordLegalSignOff(tx: Queryable, actor: SessionUser, kind: LegalKind, version: number, lawyer: string, approvedOn: string) {
  if (actor.role !== "founder") throw forbidden("Only the founder records a legal sign-off");
  if (lawyer.trim().length < 2) throw badRequest("Name the lawyer who reviewed it");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(approvedOn)) throw badRequest("Give the review date as YYYY-MM-DD");
  const row = (await tx.query<Record<string, unknown>>("select approved_by_lawyer, approved_on::text as approved_on from legal_documents where kind = $1 and version = $2", [kind, version])).rows[0];
  if (!row) throw notFound("No such version");
  const latest = await currentLegal(tx, kind);
  if (latest && latest.version !== version) throw conflict(`Version ${version} has been replaced by version ${latest.version}; record the review of the current text`);
  await tx.query("update legal_documents set approved_by_lawyer = $3, approved_on = $4, approved_recorded_by = $5 where kind = $1 and version = $2", [kind, version, lawyer.trim(), approvedOn, actor.id]);
  await audit(tx, actor, "legal.signed_off", "legal_document", `${kind}:${version}`, {
    kind,
    version,
    before: { lawyer: row.approved_by_lawyer ?? null, on: row.approved_on ?? null },
    after: { lawyer: lawyer.trim(), on: approvedOn },
  });
  return { ok: true };
}

/**
 * The version a client must accept with an offer: the current one, if any text is loaded. A stale or missing
 * version is refused so nobody accepts terms they did not see. With no terms loaded (development, tests) the
 * acceptance proceeds and records no version.
 */
export async function requiredTermsVersion(tx: Queryable, given: number | undefined): Promise<number | null> {
  const current = await currentLegal(tx, "client_terms");
  if (!current) return null;
  if (given !== current.version) throw conflict(`Read and accept the current client terms (version ${current.version}) first`);
  return current.version;
}

/** The partner admin accepts the current agreement; the firm's profile keeps who, when and which version. */
export async function acceptPartnerAgreement(tx: Queryable, actor: SessionUser, version: number) {
  if (actor.orgType !== "partner" || actor.role !== "partner_admin") throw forbidden("Only the firm's admin accepts the agreement");
  const current = await currentLegal(tx, "partner_agreement");
  if (!current) throw notFound("No agreement has been published yet");
  if (version !== current.version) throw conflict(`Read and accept the current agreement (version ${current.version})`);
  const accepted = { version, at: new Date().toISOString(), byUserId: actor.id, draft: current.draft };
  await tx.query("update orgs set profile = profile || jsonb_build_object('agreementAccepted', $2::jsonb) where id = $1 and type = 'partner'", [actor.orgId, JSON.stringify(accepted)]);
  await audit(tx, actor, "partner.agreement_accepted", "org", actor.orgId, { version, draft: current.draft });
  return { ok: true, version };
}

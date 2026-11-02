import { assessStructure, buildScope, FORMATION_CODES, Rulebook, SETUP_CODE, type AdviceInput, type Advice, type IntakeAnswers, type Structure } from "@tasees/core";
import type { Queryable } from "../lib/db.ts";
import { conflict } from "../lib/errors.ts";
import { loadScopingRules } from "./scoping.ts";
import { loadDeliverables } from "./repo.ts";

/**
 * Is the legal structure of a new-company request settled enough to quote for (E1)? A formation quote is a firm
 * price for one structure, so it may go to a client only when that structure is known and not excluded:
 *  - ops approved the scoping advice with a structure, or
 *  - the founder asked for a structure, the advice (if any) agrees, and the structure is not excluded by the rules.
 * "Not sure", an advice that disagrees with the request, and an excluded structure (offshore with visas) all wait
 * for ops to settle the structure at the scoping review. Eligibility is re-checked against today's rules, so advice
 * computed under older rules cannot carry a structure the rules now exclude.
 */
export interface Settled {
  ok: boolean;
  structure: Structure | null;
  reason: string;
}

const STRUCTURES = new Set<string>(["free_zone", "mainland", "offshore", "difc_adgm"]);
const words = (s: string) => s.replace(/_/g, " ");

export async function structureSettlement(tx: Queryable, requestId: string): Promise<Settled> {
  const r = (
    await tx.query<{ answers: AdviceInput; advice: Advice | null; advice_status: string }>("select answers, advice, advice_status from requests where id = $1", [requestId])
  ).rows[0];
  if (!r) return { ok: false, structure: null, reason: "Request not found" };
  if (r.answers.mode !== "new_company") return { ok: true, structure: null, reason: "No company formation in this request" };
  const requested = STRUCTURES.has(String(r.answers.jurisdiction)) ? (r.answers.jurisdiction as Structure) : null;
  let structure: Structure | null = null;
  if (r.advice && r.advice_status === "approved") {
    structure = (r.advice.structure.recommendation as Structure | null) ?? null;
    if (!structure) return { ok: false, structure: null, reason: "The approved advice names no structure: a specialist assessment is needed before a formation quote." };
  } else if (!requested) {
    return { ok: false, structure: null, reason: "The client is not sure which structure fits: settle it at the scoping review before quoting." };
  } else if (r.advice && r.advice.structure.recommendation !== requested) {
    return {
      ok: false,
      structure: null,
      reason: `The client asked for ${words(requested)} but the advice points to ${r.advice.structure.recommendation ? words(r.advice.structure.recommendation) : "a specialist review"}: settle it at the scoping review before quoting.`,
    };
  } else structure = requested;

  const book = new Rulebook(await loadScopingRules(tx));
  const check = assessStructure(structure, r.answers, book);
  if (check.status === "INELIGIBLE") {
    const why = check.findings.filter((f) => f.outcome === "fail").map((f) => f.text).join(" ");
    return { ok: false, structure, reason: `${words(structure)} does not fit this request: ${why}` };
  }
  return { ok: true, structure, reason: `Structure settled: ${words(structure)}` };
}

/**
 * Refuse to publish a formation offer until its structure is settled and the offer prices that structure, once. A
 * company formation priced on a request that is not a new-company request (as a service or an add-on) has no
 * structure check behind it, so it is refused too.
 */
export async function assertQuotable(tx: Queryable, requestId: string, offerCodes: string[]): Promise<void> {
  const setup = offerCodes.filter((c) => FORMATION_CODES.has(c));
  const s = await structureSettlement(tx, requestId);
  if (!s.ok) throw conflict(`This offer cannot go to the client yet. ${s.reason}`);
  if (!s.structure) {
    if (setup.length) throw conflict(`This offer prices a company formation (${setup.join(", ")}) but the request is not for a new company: record it as a new-company request so its structure is checked before quoting.`);
    return;
  }
  const expected = SETUP_CODE[s.structure]!;
  if (setup.length > 1) throw conflict(`This offer prices more than one company formation (${setup.join(", ")}); the settled structure is ${words(s.structure)} (${expected}). Build the offers again.`);
  if (setup.length === 1 && setup[0] !== expected) {
    throw conflict(`This offer prices ${setup[0]} but the settled structure is ${words(s.structure)} (${expected}). Build the offers again.`);
  }
}

/**
 * Settle the structure on the request itself when ops approves a different one: the answers and the scope sheet
 * follow, so the next offers price the right licence. Returns the scope lines before and after, for the audit.
 */
export async function rescopeForStructure(tx: Queryable, requestId: string, structure: Structure) {
  const r = (await tx.query<{ answers: IntakeAnswers; scope: { lines: Array<{ code: string; qty: number }> } }>("select answers, scope from requests where id = $1 for update", [requestId])).rows[0]!;
  if (r.answers.jurisdiction === structure) return null;
  // Once partners have been asked to quote, their sealed quotes are for the scope as sent: the structure then changes
  // through a new request, not a silent re-scope. (Offers built from rate cards are withdrawn instead, below.)
  const rfq = (await tx.query("select 1 from quote_requests where request_id = $1 limit 1", [requestId])).rows.length;
  if (rfq) throw conflict("Partners have already been asked to quote this scope; their sealed quotes are for the structure as sent, so the structure can no longer change at the scoping review");
  // Lines ops added after intake (an approved AI draft, an add-on) are kept; only the formation and its visas follow
  // the new structure.
  const fresh = buildScope({ ...r.answers, jurisdiction: structure }, new Set((await loadDeliverables(tx)).keys()));
  const derived = new Set(["VISA-RES", "VISA-FAM", ...FORMATION_CODES]);
  const kept = (r.scope?.lines ?? []).filter((l) => !derived.has(l.code) && !fresh.lines.some((f) => f.code === l.code));
  const answers = { ...r.answers, jurisdiction: structure };
  const scope = { lines: [...fresh.lines, ...kept], notes: fresh.notes };
  await tx.query("update requests set answers = $2, scope = $3 where id = $1", [requestId, JSON.stringify(answers), JSON.stringify({ lines: scope.lines })]);
  return { before: r.scope?.lines ?? [], after: scope.lines, notes: scope.notes, from: r.answers.jurisdiction ?? null };
}

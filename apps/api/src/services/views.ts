import { clientNextActions, clientTimeline, clientWhatsNext } from "./journey.ts";
import { FEE_STALE_DAYS, loadDeliverables, loadFeeDisclosures } from "./repo.ts";
import { CLIENT_REVIEW_DAYS } from "./engagements.ts";
import { opsQueue } from "./queue.ts";
import { documentPlan, milestonesFor, paymentPlan, serialize, UAE_CALENDAR, type DocumentStatus, type Role, type WorkCalendar } from "@tasees/core";
import { asPlatform, asUser, type SessionUser } from "../lib/context.ts";
import { num, type Database, type Queryable } from "../lib/db.ts";
import { notFound } from "../lib/errors.ts";

/**
 * Read models. Client and partner reads run under their database role, so each query may only name
 * columns that role was granted; the database refuses anything else. Platform reads are filtered
 * by role in code (ops never sees margin; finance and the founder do).
 */

/** API field names for line amounts, matching the visibility maps in @tasees/core. */
const RENAME: Record<string, string> = {
  clientUnit: "clientUnitPrice",
  partnerUnit: "partnerUnitCost",
  govUnit: "govUnitFee",
};

const camel = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      const c = k.replace(/_fils$/, "").replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
      return [RENAME[c] ?? c, typeof v === "bigint" ? Number(v) : v];
    }),
  );

// Client ----------------------------------------------------------------------------

export function clientHome(db: Database, user: SessionUser, now: Date = new Date(), cal: WorkCalendar = UAE_CALENDAR) {
  return asUser(db, user, async (tx) => {
    // Advice reaches the client only once ops has approved it; it keeps its confidence labels.
    const requests = await tx.query(
      "select id, status, scope, notes, created_at, advice_status, app_approved_advice(id) as advice, advice_reviewed_at, assessment_id, obligation_id, answers->>'mode' as mode from requests order by created_at desc",
    );
    // E2: the client sees the day the advice's rules and data stand at; the digest and fact id are internal.
    for (const r of requests.rows as Array<{ advice: { dataVersion?: { asOf: string } } | null }>) {
      if (r.advice?.dataVersion) r.advice.dataVersion = { asOf: r.advice.dataVersion.asOf };
    }
    const offers = await tx.query(
      `select id, request_id, tier, status, valid_to, professional_fils, mkw_fees_fils, vat_fils, government_fils, client_total_fils
       from offers order by created_at desc`,
    );
    const engagements = await tx.query(
      `select e.id, e.status, e.emirate, e.created_at,
         (select count(*)::int from milestones m where m.engagement_id = e.id) as milestones,
         (select count(*)::int from milestones m where m.engagement_id = e.id and m.status = 'client_approved') as approved,
         (select count(*)::int from milestones m where m.engagement_id = e.id and m.status = 'qa_passed') as to_review
       from engagements e order by e.created_at desc`,
    );
    // O12: the one thing Tasees needs from the client (first), or what is happening when nothing is needed.
    const nextActions = await clientNextActions(tx, now, cal);
    return {
      nextActions,
      whatsNext: nextActions.length ? null : await clientWhatsNext(tx),
      requests: requests.rows.map(camel),
      offers: offers.rows.map(camel),
      engagements: engagements.rows.map(camel),
    };
  });
}

export function clientOffer(db: Database, user: SessionUser, offerId: string) {
  return asUser(db, user, async (tx) => {
    const o = (
      await tx.query(
        `select id, request_id, tier, status, valid_to, professional_fils, mkw_fees_fils, vat_fils, government_fils, client_total_fils
         from offers where id = $1`,
        [offerId],
      )
    ).rows[0];
    if (!o) throw notFound("Offer not found");
    const lines = await tx.query(
      `select l.code, d.name, l.qty, l.model, l.gov_unit_fils, l.client_unit_fils, l.mkw_fee_unit_fils
       from offer_lines l join deliverables d on d.code = l.code where l.offer_id = $1 order by d.category, l.code`,
      [offerId],
    );
    return serialize("offer", user.role, { ...camel(o), lines: lines.rows.map(camel) }, { lines: "offerLine" });
  });
}

/**
 * The offer as a proposal (O12): how the work will run, what is paid when, the guarantee, and a plain sentence for any
 * government fee that is not confirmed. Read as the platform because the line reasons are internal; only the
 * client-safe sentence leaves this function, never the reason itself.
 */
export function clientOfferProposal(db: Database, user: SessionUser, offer: { id: string; professional?: number; mkwFees?: number; vat?: number; government?: number; lines: Array<{ code: string; name: string; qty: number; govUnitFee?: number }> }) {
  return asPlatform(db, user, async (tx) => {
    // E18: each government fee's standing is what the offer line recorded when it was priced, never MKW's fee table as
    // it stands today (a fee verified or added since would otherwise rewrite what the client was told).
    const disclosures = await loadFeeDisclosures(tx, offer.id);
    const guaranteeBp = num((await tx.query<{ value: number }>("select value from settings where key = 'guarantee_bp'")).rows[0]?.value ?? 1000);
    // `feeNotes` keeps its meaning for older pages: a sentence for every fee that is not verified.
    const feeNotes: Record<string, string> = Object.fromEntries(disclosures.filter((d) => !d.confirmed).map((d) => [d.code, d.text]));
    const catalogue = await loadDeliverables(tx);
    const plan = offer.lines.map((l) => {
      const steps = milestonesFor(l.code, l.qty).map((m) => ({ name: m.name, afterWorkingDays: m.dueOffsetDays, isKey: m.isKey }));
      // A yearly or monthly service runs on; its first cycle is not part of how long the setup takes.
      const recurring = (catalogue.get(l.code)?.billing ?? "one_off") !== "one_off";
      return { code: l.code, name: l.name, qty: l.qty, steps, recurring, workingDays: Math.max(0, ...steps.map((s) => s.afterWorkingDays)) };
    });
    const payment = paymentPlan({
      professional: offer.professional ?? 0,
      mkwFees: offer.mkwFees ?? 0,
      vat: offer.vat ?? 0,
      government: offer.government ?? 0,
      clientTotal: 0,
      partnerPayout: 0,
      margin: 0,
      marginBp: 0,
      linesNeedingReview: 0,
    });
    return {
      plan,
      // Lines run side by side, so the longest one-off line is the estimate; recurring services are left out.
      estimateWorkingDays: Math.max(0, ...plan.filter((p) => !p.recurring).map((p) => p.workingDays)),
      feeNotes,
      feeDisclosures: disclosures,
      depositFils: payment.clientOnAcceptance,
      balanceFils: payment.clientOnCompletion,
      // The guarantee rate is a promise made to the client, so it is stated here (D60).
      guaranteeBp,
      reviewWorkingDays: CLIENT_REVIEW_DAYS,
    };
  });
}

// Shared engagement view for clients and partners --------------------------------------

export function partyEngagement(db: Database, user: SessionUser, engagementId: string, now: Date = new Date(), cal: WorkCalendar = UAE_CALENDAR) {
  return asUser(db, user, async (tx) => {
    const e = (await tx.query("select id, status, emirate, free_zone, created_at, completed_at from engagements where id = $1", [engagementId])).rows[0];
    if (!e) throw notFound("Engagement not found");
    const lineCols =
      user.orgType === "client"
        ? "l.code, d.name, l.qty, l.gov_unit_fils, l.client_unit_fils"
        : "l.code, d.name, l.qty, l.gov_unit_fils, l.partner_unit_fils";
    const lines = await tx.query(`select ${lineCols} from engagement_lines l join deliverables d on d.code = l.code where l.engagement_id = $1 order by l.code`, [engagementId]);
    const milestones = await tx.query(
      `select id, code, seq, name, is_key, due_date, status, evidence_required, qa_note, dispute_reason, updated_at
       from milestones where engagement_id = $1 order by seq`,
      [engagementId],
    );
    const evidence = await tx.query(
      "select id, milestone_id, type, file_name, created_at, file_scan_status('evidence', id) as scan from evidence where engagement_id = $1 and superseded_at is null order by created_at",
      [engagementId],
    );
    const messages = await tx.query(
      "select id, author_name, author_org_id, body_shown, masked, created_at from messages where engagement_id = $1 order by created_at",
      [engagementId],
    );
    const parties = await tx.query(
      "select o.id, o.name, p.party from engagement_parties p join orgs o on o.id = p.org_id where p.engagement_id = $1",
      [engagementId],
    );
    const changeCols =
      user.orgType === "client"
        ? "id, description, client_fils, status, created_at, decided_at"
        : "id, description, partner_fils, status, created_at, decided_at";
    // E19: a partner firm reads only its own change orders (also the database's rule, migration 024).
    const changes =
      user.orgType === "partner"
        ? await tx.query(`select ${changeCols} from change_orders where engagement_id = $1 and raised_by_org = $2 order by created_at`, [engagementId, user.orgId])
        : await tx.query(`select ${changeCols} from change_orders where engagement_id = $1 order by created_at`, [engagementId]);
    // Partner staff see no money figure (PRODUCT_SPEC, roles; the visibility map gives them "public" only).
    const staff = user.role === "partner_staff";
    const money =
      user.orgType === "client"
        ? await tx.query("select id, kind, amount_fils, status, paid_at, pay_url, refunded_at from payments where engagement_id = $1 order by created_at, case kind when 'deposit' then 0 when 'balance' then 1 else 2 end", [engagementId])
        : await tx.query(
            `select p.id, p.stage, p.amount_fils, p.status, p.released_at, p.run_id, pi.number as invoice_number, pi.uploaded_at as invoice_uploaded_at
             from payouts p left join partner_invoices pi on pi.payout_id = p.id and pi.superseded_at is null where p.engagement_id = $1 order by p.stage`,
            [engagementId],
          );
    const invoices =
      user.orgType === "client"
        ? (await tx.query("select id, kind, number, payment_id, issued_at, gross_fils, net_fils, vat_fils, disbursements_fils from invoices where engagement_id = $1 and status = 'issued' order by issued_at", [engagementId])).rows.map(camel)
        : [];
    // O6: the client's document checklist, delays (without attribution), the client's credits, the rating.
    const documentRequests = await tx.query("select id, engagement_id, milestone_id, kind, note, status, file_name, uploaded_at, decided_at, decision_note, created_at, file_scan_status('document_request', id) as scan from document_requests where engagement_id = $1 order by created_at", [engagementId]);
    const delays = await tx.query("select id, milestone_id, engagement_id, due_date, noticed_at, expected_date from delays where engagement_id = $1 order by noticed_at", [engagementId]);
    const credits = user.orgType === "client" ? await tx.query("select id, engagement_id, milestone_id, amount_fils, status, settled_reference, created_at from guarantee_credits where engagement_id = $1 order by created_at", [engagementId]) : { rows: [] };
    const rating = (await tx.query("select engagement_id, stars, comment_shown as comment, created_at from ratings where engagement_id = $1", [engagementId])).rows[0];
    return {
      engagement: camel(e),
      lines: lines.rows.map((l) => {
        const line = serialize("engagementLine", user.role, camel(l)) as Record<string, unknown>;
        if (staff) delete line.govUnitFee; // E19: partner staff see no money figure, government fees included
        return line;
      }),
      milestones: milestones.rows.map(camel),
      documentRequests: documentRequests.rows.map(camel),
      // E15: the client's documents as needed now, needed later (by step) and already sent.
      ...(user.orgType === "client"
        ? {
            documentPlan: documentPlan(
              documentRequests.rows.map((d) => ({ id: d.id as string, milestoneId: d.milestone_id as string, status: d.status as DocumentStatus })),
              (await tx.query<{ id: string; seq: number; due_date: string | null; status: string }>("select id, seq, due_date::text as due_date, status from milestones where engagement_id = $1", [engagementId])).rows.map((m) => ({ id: m.id, seq: num(m.seq), dueDate: m.due_date, approved: m.status === "client_approved" })),
              (await tx.query<{ d: string }>("select gulf(app_now())::text as d")).rows[0]!.d.slice(0, 10),
            ),
          }
        : {}),
      delays: delays.rows.map((d) => serialize("delay", user.role, camel(d) as Record<string, unknown>)),
      ...(user.orgType === "client" ? { credits: credits.rows.map((c) => serialize("guaranteeCredit", user.role, { ...(camel(c) as Record<string, unknown>), amount: num((c as { amount_fils: number }).amount_fils) })) } : {}),
      rating: rating ? serialize("rating", user.role, camel(rating) as Record<string, unknown>) : null,
      evidence: evidence.rows.map(camel),
      messages: messages.rows.map(camel),
      parties: parties.rows.map(camel),
      changeOrders: changes.rows.map((c) => {
        const row = camel(c) as Record<string, unknown>;
        if (staff) delete row.partner;
        return row;
      }),
      [user.orgType === "client" ? "payments" : "payouts"]: staff ? [] : money.rows.map(camel),
      ...(user.orgType === "client" ? { invoices } : {}),
      // O12: the client's timeline with the next action pinned above it.
      ...(user.orgType === "client"
        ? await (async () => {
            const actions = await clientNextActions(tx, now, cal, engagementId);
            return { journey: { nextAction: actions[0] ?? null, actions, whatsNext: actions.length ? null : await clientWhatsNext(tx, engagementId), timeline: await clientTimeline(tx, engagementId, cal) } };
          })()
        : {}),
    };
  });
}

// Partner ---------------------------------------------------------------------------

export function partnerHome(db: Database, user: SessionUser) {
  return asUser(db, user, async (tx) => {
    const allocations = await tx.query(
      // The engagement row becomes visible only once this partner accepts (it is then a party).
      `select a.id, a.engagement_id, a.codes, a.offered_at, a.deadline, a.accepted_at, a.declined_at, a.timed_out_at, a.payout_lines,
         a.brief, e.status as engagement_status
       from allocations a left join engagements e on e.id = a.engagement_id order by a.offered_at desc`,
    );
    const rfqs = await tx.query(
      `select q.id, q.deadline, q.status, r.scope, r.notes,
         exists (select 1 from partner_quotes pq where pq.quote_request_id = q.id) as submitted
       from quote_requests q join requests r on r.id = q.request_id order by q.deadline desc`,
    );
    const payouts = await tx.query(
      `select p.id, p.engagement_id, p.stage, p.amount_fils, p.status, p.released_at, p.run_id, pi.number as invoice_number
       from payouts p left join partner_invoices pi on pi.payout_id = p.id and pi.superseded_at is null
       order by p.engagement_id, case p.stage when 'kickoff' then 0 when 'key_milestone' then 1 when 'completion' then 2 else 3 end`,
    );
    // Only the partner admin, who maintains them, sees the firm's bank details.
    const bank = user.role === "partner_admin" ? ((await tx.query<{ bank: unknown }>("select app_partner_bank() as bank")).rows[0]?.bank ?? null) : null;
    const cards = await tx.query(
      `select c.id, c.code, d.name, c.professional_fils, c.gov_stated_fils, c.third_party_fils, c.working_days, c.exclusions, c.valid_to
       from rate_cards c join deliverables d on d.code = c.code order by c.code`,
    );
    const deliverables = await tx.query("select code, name, category, model, billing from deliverables order by category, code");
    const firm = (await tx.query<{ profile: Record<string, unknown> }>("select app_partner_profile() as profile")).rows[0]?.profile ?? {};
    // E19: partner staff see the work, never a money figure: no payouts, no payout lines, no rate-card amounts.
    const staff = user.role === "partner_staff";
    return {
      firm,
      allocations: allocations.rows.map((r) => {
        const row = camel(r) as Record<string, unknown>;
        const lines = (row.payoutLines as Array<{ qty: number; unitFils: number }>) ?? [];
        if (staff) {
          delete row.payoutLines;
          return row;
        }
        return { ...row, payoutTotal: lines.reduce((s, l) => s + l.qty * l.unitFils, 0) };
      }),
      rfqs: rfqs.rows.map(camel),
      payouts: staff ? [] : payouts.rows.map(camel),
      rateCards: cards.rows.map((c) => {
        const row = camel(c) as Record<string, unknown>;
        if (staff) for (const k of ["professional", "govStated", "thirdParty"]) delete row[k];
        return row;
      }),
      deliverables: deliverables.rows.map(camel),
      bank,
    };
  });
}

// Platform --------------------------------------------------------------------------

const seesMargin = (role: Role) => role === "finance" || role === "founder";
/** A copy of audit data with every margin figure removed, at any depth (E18 review). */
const withoutMargin = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(withoutMargin) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !/margin/i.test(k)).map(([k, x]) => [k, withoutMargin(x)])) : v;

export function opsOverview(db: Database, user: SessionUser) {
  return asPlatform(db, user, async (tx) => {
    const [requests, offers, engagements, exceptions, partners, payouts] = await Promise.all([
      tx.query(
        `select r.id, r.status, r.scope, r.notes, r.created_at, r.advice_status, r.source->>'channel' as channel, o.name as client from requests r join orgs o on o.id = r.client_org_id
         order by r.created_at desc limit 100`,
      ),
      tx.query(
        `select f.id, f.request_id, f.tier, f.status, f.valid_to, f.professional_fils, f.mkw_fees_fils, f.vat_fils, f.government_fils,
           f.client_total_fils, f.partner_payout_fils, f.margin_fils, f.margin_bp, f.lines_needing_review, o.name as client
         from offers f join orgs o on o.id = f.client_org_id where f.status <> 'withdrawn' order by f.created_at desc limit 100`,
      ),
      tx.query(
        `select e.id, e.status, e.emirate, e.created_at, o.name as client,
           (select string_agg(distinct p.name, ', ') from engagement_lines l join orgs p on p.id = l.partner_org_id where l.engagement_id = e.id) as partners,
           (select count(*)::int from milestones m where m.engagement_id = e.id) as milestones,
           (select count(*)::int from milestones m where m.engagement_id = e.id and m.status = 'client_approved') as approved
         from engagements e join orgs o on o.id = e.client_org_id order by e.created_at desc limit 100`,
      ),
      exceptionQueue(tx),
      tx.query("select id, name, status, profile from orgs where type = 'partner' order by name"),
      tx.query(
        `select p.id, p.engagement_id, p.stage, p.amount_fils, p.status, o.name as partner from payouts p join orgs o on o.id = p.partner_org_id
         where p.status in ('eligible', 'pending') order by p.status, p.engagement_id`,
      ),
    ]);
    return {
      requests: requests.rows.map(camel),
      offers: offers.rows.map((r) => serialize("offer", user.role, camel(r) as Record<string, unknown>)).map((o, i) => ({
        ...o,
        client: offers.rows[i]?.client,
      })),
      engagements: engagements.rows.map(camel),
      exceptions,
      partners: partners.rows.map((p) => {
        const row = camel(p) as Record<string, unknown>;
        const profile = (row.profile as Record<string, unknown>) ?? {};
        return { ...row, profile: seesMargin(user.role) ? profile : Object.fromEntries(Object.entries(profile).filter(([k]) => k !== "bank")) };
      }),
      payouts: payouts.rows.map(camel),
      seesMargin: seesMargin(user.role),
    };
  });
}

export function opsOffer(db: Database, user: SessionUser, offerId: string) {
  return asPlatform(db, user, async (tx) => {
    const o = (await tx.query("select * from offers where id = $1", [offerId])).rows[0];
    if (!o) throw notFound("Offer not found");
    const lines = await tx.query(
      `select l.*, l.gov_fee_verified_at::text as gov_fee_verified_on, l.gov_fee_quoted_on::text as gov_fee_quoted_day, d.name, p.name as partner_name
       from offer_lines l join deliverables d on d.code = l.code left join orgs p on p.id = l.partner_org_id where l.offer_id = $1 order by l.code`,
      [offerId],
    );
    const shaped = { ...camel(o), lines: lines.rows.map((l) => ({ ...camel(l), partnerId: l.partner_org_id })) };
    const out = serialize("offer", user.role, shaped, { lines: "offerLine" });
    (out.lines as Array<Record<string, unknown>>).forEach((l, i) => (l.partnerName = lines.rows[i]?.partner_name));
    // E18 (Codex review): the count the Publish button reads includes a verified fee that has gone past 90 days since
    // pricing, by the same test publication applies, so the screen asks for the acknowledgement publication needs.
    const due = (
      await tx.query<{ n: number }>(
        `select count(*)::int as n from offer_lines where offer_id = $1 and (status <> 'ok' or gov_fee_review = 'required'
           or (gov_fee_basis = 'verified' and gov_fee_verified_at < app_now()::date - ${FEE_STALE_DAYS}))`,
        [offerId],
      )
    ).rows[0]!.n;
    out.linesNeedingReview = Math.max(num(out.linesNeedingReview), num(due));
    const disclosed = new Map((await loadFeeDisclosures(tx, offerId)).map((d) => [d.code, d]));
    (out.lines as Array<Record<string, unknown>>).forEach((l, i) => {
      const r = lines.rows[i]!;
      l.govFee = {
        basis: r.gov_fee_basis ?? null,
        disclosure: disclosed.get(String(r.code)) ?? null,
        recordId: r.gov_fee_id ?? null,
        emirate: r.gov_fee_emirate ?? null,
        freeZone: r.gov_fee_free_zone ?? null,
        sourceUrl: r.gov_fee_source_url ?? null,
        verifiedBy: r.gov_fee_verified_by ?? null,
        // Dates as the database's own text, so a server east of UTC does not show the day before (E18 review).
        verifiedAt: (r.gov_fee_verified_on as string | null) ?? null,
        quotedOn: (r.gov_fee_quoted_day as string | null) ?? null,
        review: r.gov_fee_review ?? null,
        acknowledgedAt: r.gov_fee_ack_at ? new Date(r.gov_fee_ack_at as string).toISOString() : null,
      };
    });
    return out;
  });
}

export function opsEngagement(db: Database, user: SessionUser, engagementId: string) {
  return asPlatform(db, user, async (tx) => {
    const e = (await tx.query("select * from engagements where id = $1", [engagementId])).rows[0];
    if (!e) throw notFound("Engagement not found");
    const q = (sql: string) => tx.query(sql, [engagementId]).then((r) => r.rows.map(camel));
    const lines = await q(
      `select l.code, d.name, l.qty, l.gov_unit_fils, l.client_unit_fils, l.partner_unit_fils, p.name as partner
       from engagement_lines l join deliverables d on d.code = l.code left join orgs p on p.id = l.partner_org_id where l.engagement_id = $1`,
    );
    return {
      engagement: camel(e),
      lines: lines.map((l) => ({
        ...l,
        ...(seesMargin(user.role) ? { marginUnit: num(l.clientUnitPrice) - num(l.partnerUnitCost) } : {}),
      })),
      allocations: await q(
        `select a.id, a.codes, a.reason, a.offered_at, a.deadline, a.accepted_at, a.declined_at, a.decline_reason, a.timed_out_at, o.name as partner
         from allocations a join orgs o on o.id = a.partner_org_id where a.engagement_id = $1 order by a.offered_at`,
      ),
      milestones: await q("select * from milestones where engagement_id = $1 order by seq"),
      evidence: await q("select id, milestone_id, type, file_name, created_at, file_scan_status('evidence', id) as scan from evidence where engagement_id = $1 and superseded_at is null"),
      messages: await q(
        "select id, author_name, body_original, body_shown, masked, created_at from messages where engagement_id = $1 order by created_at",
      ),
      payments: await q("select id, kind, amount_fils, status, paid_at, pay_url, refunded_at, refund_reference from payments where engagement_id = $1 order by created_at, case kind when 'deposit' then 0 when 'balance' then 1 else 2 end"),
      payouts: await q(
        `select p.id, p.stage, p.amount_fils, p.status, p.run_id, o.name as partner, pi.number as invoice_number
         from payouts p join orgs o on o.id = p.partner_org_id left join partner_invoices pi on pi.payout_id = p.id and pi.superseded_at is null where p.engagement_id = $1`,
      ),
      invoices: await q("select id, kind, number, status, payment_id, issued_at, gross_fils from invoices where engagement_id = $1 order by created_at"),
      changeOrders: await q("select * from change_orders where engagement_id = $1 order by created_at"),
      documentRequests: await q("select id, milestone_id, kind, note, status, file_name, uploaded_at, decided_at, decision_note, created_at, file_scan_status('document_request', id) as scan from document_requests where engagement_id = $1 order by created_at"),
      delays: await q("select d.*, m.name as step from delays d join milestones m on m.id = d.milestone_id where d.engagement_id = $1 order by d.noticed_at"),
      credits: await q("select g.*, m.name as step from guarantee_credits g join milestones m on m.id = g.milestone_id where g.engagement_id = $1 order by g.created_at"),
      rating: (await q("select r.stars, r.comment_original, r.comment_shown, r.created_at, u.name as author_name from ratings r join users u on u.id = r.author_user_id where r.engagement_id = $1"))[0] ?? null,
      // Partners who could take the open lines by hand: ops sees names and eligibility, never costs.
      candidates: await q(
        `select o.id, o.name, o.profile->>'status' as status, (o.profile->>'quality')::int as quality from orgs o where o.type = 'partner'
           and exists (select 1 from engagement_lines l where l.engagement_id = $1 and l.partner_org_id is null) order by o.name`,
      ),
    };
  });
}

/**
 * The ops queue as a flat list (kind, ref, detail, arrival), for the overview and the digest. Since O11 it is the
 * ranked command-centre queue, so every consumer sees the same items in the same order.
 */
export async function exceptionQueue(tx: Queryable) {
  const now = (await tx.query<{ n: Date }>("select app_now() as n")).rows[0]!.n;
  const items = await opsQueue(tx, null, new Date(now));
  return items.map((i) => ({ kind: i.kind, ref: i.ref, detail: i.detail, at: i.at, level: i.level }));
}

export function auditTrail(db: Database, user: SessionUser, limit = 200) {
  return asPlatform(db, user, async (tx) => {
    const r = await tx.query("select id, at, actor_user_id, action, entity, entity_id, data, prev_hash, hash from audit_events order by id desc limit $1", [limit]);
    // Rule 1 (E18 review): offer events record the margin for finance and the founder; ops read the trail without it.
    // The stored event and its hash are unchanged; only what ops are shown is filtered.
    return r.rows.map((row) => camel(seesMargin(user.role) ? row : { ...row, data: withoutMargin(row.data) }));
  });
}

// Notifications -------------------------------------------------------------------------

/** The signed-in person's own in-app notifications. Clients and partners read under their database role. */
export function myNotifications(db: Database, user: SessionUser) {
  const run = user.orgType === "platform" ? asPlatform : asUser;
  return run(db, user, async (tx) => {
    const rows = await tx.query(
      `select id, template, subject, body, created_at, read_at from notifications
       where user_id = $1 and in_app order by created_at desc limit 50`,
      [user.id],
    );
    const unread = await tx.query<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and in_app and read_at is null", [user.id]);
    return { items: rows.rows.map(camel), unread: num(unread.rows[0]?.n) };
  });
}

/** Delivery log for MKW staff: what went out, to whom, and whether it arrived at the provider. */
export function deliveryLog(db: Database, user: SessionUser, limit = 200) {
  return asPlatform(db, user, async (tx) => {
    const r = await tx.query(
      `select n.id, n.to_email, n.channel, n.template, n.audience, n.subject, n.status, n.provider_ref, n.error, n.created_at, n.sent_at, n.read_at,
         u.name as recipient from notifications n left join users u on u.id = n.user_id order by n.created_at desc limit $1`,
      [limit],
    );
    return r.rows.map(camel);
  });
}

import { serialize, type Role } from "@tasees/core";
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

export function clientHome(db: Database, user: SessionUser) {
  return asUser(db, user, async (tx) => {
    const requests = await tx.query("select id, status, scope, notes, created_at from requests order by created_at desc");
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
    return {
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

// Shared engagement view for clients and partners --------------------------------------

export function partyEngagement(db: Database, user: SessionUser, engagementId: string) {
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
      "select id, milestone_id, type, file_name, created_at from evidence where engagement_id = $1 order by created_at",
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
    const changes = await tx.query(`select ${changeCols} from change_orders where engagement_id = $1 order by created_at`, [engagementId]);
    const money =
      user.orgType === "client"
        ? await tx.query("select id, kind, amount_fils, status, paid_at from payments where engagement_id = $1 order by created_at", [engagementId])
        : await tx.query("select id, stage, amount_fils, status, released_at from payouts where engagement_id = $1 order by stage", [engagementId]);
    return {
      engagement: camel(e),
      lines: lines.rows.map((l) => serialize("engagementLine", user.role, camel(l))),
      milestones: milestones.rows.map(camel),
      evidence: evidence.rows.map(camel),
      messages: messages.rows.map(camel),
      parties: parties.rows.map(camel),
      changeOrders: changes.rows.map(camel),
      [user.orgType === "client" ? "payments" : "payouts"]: money.rows.map(camel),
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
    const payouts = await tx.query("select id, engagement_id, stage, amount_fils, status, released_at from payouts order by engagement_id, stage");
    const cards = await tx.query(
      `select c.id, c.code, d.name, c.professional_fils, c.gov_stated_fils, c.third_party_fils, c.working_days, c.exclusions, c.valid_to
       from rate_cards c join deliverables d on d.code = c.code order by c.code`,
    );
    const deliverables = await tx.query("select code, name, category, model, billing from deliverables order by category, code");
    return {
      allocations: allocations.rows.map((r) => {
        const row = camel(r) as Record<string, unknown>;
        const lines = (row.payoutLines as Array<{ qty: number; unitFils: number }>) ?? [];
        return { ...row, payoutTotal: lines.reduce((s, l) => s + l.qty * l.unitFils, 0) };
      }),
      rfqs: rfqs.rows.map(camel),
      payouts: payouts.rows.map(camel),
      rateCards: cards.rows.map(camel),
      deliverables: deliverables.rows.map(camel),
    };
  });
}

// Platform --------------------------------------------------------------------------

const seesMargin = (role: Role) => role === "finance" || role === "founder";

export function opsOverview(db: Database, user: SessionUser) {
  return asPlatform(db, user, async (tx) => {
    const [requests, offers, engagements, exceptions, partners, payouts] = await Promise.all([
      tx.query(
        `select r.id, r.status, r.scope, r.notes, r.created_at, o.name as client from requests r join orgs o on o.id = r.client_org_id
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
      partners: partners.rows.map(camel),
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
      `select l.*, d.name, p.name as partner_name from offer_lines l join deliverables d on d.code = l.code
       left join orgs p on p.id = l.partner_org_id where l.offer_id = $1 order by l.code`,
      [offerId],
    );
    const shaped = { ...camel(o), lines: lines.rows.map((l) => ({ ...camel(l), partnerId: l.partner_org_id })) };
    const out = serialize("offer", user.role, shaped, { lines: "offerLine" });
    (out.lines as Array<Record<string, unknown>>).forEach((l, i) => (l.partnerName = lines.rows[i]?.partner_name));
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
      evidence: await q("select id, milestone_id, type, file_name, created_at from evidence where engagement_id = $1"),
      messages: await q(
        "select id, author_name, body_original, body_shown, masked, created_at from messages where engagement_id = $1 order by created_at",
      ),
      payments: await q("select id, kind, amount_fils, status, paid_at from payments where engagement_id = $1 order by created_at"),
      payouts: await q(
        "select p.id, p.stage, p.amount_fils, p.status, o.name as partner from payouts p join orgs o on o.id = p.partner_org_id where engagement_id = $1",
      ),
      changeOrders: await q("select * from change_orders where engagement_id = $1 order by created_at"),
    };
  });
}

async function exceptionQueue(tx: Queryable) {
  const rows = await tx.query<{ kind: string; ref: string; detail: string; at: string }>(
    `select 'offer_review' as kind, id::text as ref, 'Offer needs review: ' || lines_needing_review || ' line(s)' as detail, created_at::text as at
       from offers where status = 'ops_review'
     union all
     select 'offer_ready', id::text, 'Draft offer ready to publish (' || tier || ')', created_at::text from offers where status = 'draft'
     union all
     select 'needs_quote', id::text, 'No rate card for part of this request: open a request for quote', created_at::text
       from requests where status = 'quoting'
     union all
     select 'qa', m.engagement_id::text, 'Evidence to check: ' || m.name, m.updated_at::text from milestones m where m.status = 'evidence_submitted'
     union all
     select 'dispute', m.engagement_id::text, 'Client raised an issue: ' || coalesce(m.dispute_reason, ''), m.updated_at::text
       from milestones m where m.status = 'disputed'
     union all
     select 'unallocated', e.id::text, 'Lines with no partner and no open offer', e.created_at::text from engagements e
       where e.status = 'allocating' and exists (
         select 1 from engagement_lines l where l.engagement_id = e.id and l.partner_org_id is null
           and not exists (select 1 from allocations a where a.engagement_id = e.id and l.code = any(a.codes)
                           and a.accepted_at is null and a.declined_at is null and a.timed_out_at is null))
     union all
     select 'payout', p.engagement_id::text, 'Payout ready to release: ' || p.stage, app_now()::text from payouts p where p.status = 'eligible'
     order by at`,
  );
  return rows.rows;
}

export function auditTrail(db: Database, user: SessionUser, limit = 200) {
  return asPlatform(db, user, async (tx) => {
    const r = await tx.query("select id, at, actor_user_id, action, entity, entity_id, data, prev_hash, hash from audit_events order by id desc limit $1", [limit]);
    return r.rows.map(camel);
  });
}

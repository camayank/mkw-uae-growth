/**
 * Load test for the allocation and payout paths (O13). Run on PostgreSQL:
 *
 *   TEST_DATABASE_URL=postgres://user@host:5432/postgres pnpm --filter @tasees/api load [engagements] [concurrency] [report.md]
 *
 * It drives many engagements at once through the real HTTP routes (offer accepted, deposit paid, allocation answered by
 * each partner, partner invoices, one payout run exported and paid), times each step, then checks the invariants that
 * matter when requests overlap. It exits 1 if any invariant fails. A fresh database is made and dropped.
 */
import { writeFileSync } from "node:fs";
import { asPlatform } from "../src/lib/context.ts";
import { verifyAuditChain } from "../src/lib/audit.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

const N = Number(process.argv[2] ?? 40);
const CONCURRENCY = Number(process.argv[3] ?? 10);
const OUT = process.argv[4];
const pdf = Buffer.from("%PDF-1.4 load").toString("base64");
const partnerKey = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");
const ANSWERS = [
  { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 },
  { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 2 },
  { mode: "new_company", jurisdiction: "mainland", emirate: "Dubai", visas: 0 },
];

const timings = new Map<string, number[]>();
async function timed<T>(step: string, fn: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T }> {
  const t = performance.now();
  const r = await fn();
  (timings.get(step) ?? timings.set(step, []).get(step)!).push(performance.now() - t);
  if (r.status >= 400) throw new Error(`${step}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function main() {
  const env: TestEnv = await makeEnv();
  if (env.db.kind !== "postgres") console.warn("Not on PostgreSQL: requests queue one at a time on PGlite. Set TEST_DATABASE_URL.");
  const rows = <R = any>(sql: string, params: unknown[] = []) => asPlatform(env.db, null, async (tx) => (await tx.query<R & Record<string, unknown>>(sql, params)).rows);
  // Capacity that binds part-way through, so the run tests both allocation and running out of partners.
  await rows("update orgs set profile = jsonb_set(profile, '{capacity}', to_jsonb(greatest(1, ($1::int * (profile->>'capacity')::int) / 40))) where type = 'partner'", [N]);
  const started = performance.now();

  // Offers are built and published first (ops work, not the path under test).
  const offers: string[] = [];
  for (let i = 0; i < N; i++) {
    const req = await env.call("client", "POST", "/api/requests", { answers: ANSWERS[i % ANSWERS.length] });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    await env.call("ops", "POST", `/api/ops/offers/${built.body.offerIds[0]}/publish`);
    offers.push(built.body.offerIds[0]);
  }
  const pathStart = performance.now();

  // The path under test, many engagements at once.
  await pool(offers, CONCURRENCY, async (offerId) => {
    const { body } = await timed("accept offer", () => env.call("client", "POST", `/api/client/offers/${offerId}/accept`));
    const engagementId = (body as { engagementId: string }).engagementId;
    const deposit = (await rows("select id from payments where engagement_id = $1 and kind = 'deposit'", [engagementId]))[0]!.id;
    await timed("deposit paid + allocation", () => env.call("finance", "POST", `/api/ops/payments/${deposit}/mark-paid`, { reference: `TT-${offerId.slice(0, 8)}` }));
    const e = (await env.call("ops", "GET", `/api/engagements/${engagementId}`)).body;
    await Promise.all(e.allocations.map((a: any) => timed("allocation accepted", () => env.call(partnerKey(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" }))));
    const payouts = await rows<{ id: string; amount_fils: string; name: string }>(
      "select p.id, p.amount_fils, o.name from payouts p join orgs o on o.id = p.partner_org_id where p.engagement_id = $1 and p.status = 'eligible' and p.amount_fils > 0",
      [engagementId],
    );
    await Promise.all(payouts.map((p) => {
      const fils = Number(p.amount_fils);
      return timed("partner invoice", () => env.call(partnerKey(p.name), "POST", `/api/payouts/${p.id}/invoice`, { number: `INV-${p.id.slice(0, 8)}`, amountAed: fils / 100, vatAed: Math.round(fils / 20) / 100, fileName: "invoice.pdf", contentBase64: pdf }));
    }));
  });
  for (const who of ["setup", "corp", "tax"]) await env.call(who, "PUT", "/api/partner/bank", { beneficiary: `${who} LLC`, iban: "AE07 0331 2345 6789 0123 456", bank: "Emirates NBD" });
  // Two finance users press "create run" together: one run.
  const runs = await Promise.all([1, 2].map(() => env.call("finance", "POST", "/api/ops/payout-runs")));
  const run = runs.find((r) => r.status === 200)!;
  await timed("payout run exported", async () => {
    const r = await env.app.inject({ method: "GET", url: `/api/ops/payout-runs/${run.body.id}/file`, headers: { authorization: `Bearer ${env.tokens.finance}` } });
    return { status: r.statusCode, body: null };
  });
  await timed("payout run paid", () => env.call("finance", "POST", `/api/ops/payout-runs/${run.body.id}/paid`, { bankReference: "BULK-LOAD-1" }));
  const pathMs = performance.now() - pathStart;

  // Invariants.
  const checks: Array<[string, boolean, string]> = [];
  const dupPayouts = await rows("select engagement_id, partner_org_id, stage from payouts where stage <> 'change_order' group by 1, 2, 3 having count(*) > 1");
  checks.push(["one payout per engagement, partner and stage", dupPayouts.length === 0, `${dupPayouts.length} duplicates`]);
  const over = await rows(
    `select p.engagement_id, p.partner_org_id, sum(p.amount_fils) as paid,
            (select sum(l.partner_unit_fils * l.qty) from engagement_lines l where l.engagement_id = p.engagement_id and l.partner_org_id = p.partner_org_id) as cost
       from payouts p where p.stage <> 'change_order' group by 1, 2 having sum(p.amount_fils) > (select coalesce(sum(l.partner_unit_fils * l.qty), 0) from engagement_lines l where l.engagement_id = p.engagement_id and l.partner_org_id = p.partner_org_id)`,
  );
  checks.push(["no partner paid above the priced cost", over.length === 0, `${over.length} over`]);
  const dupLines = await rows("select engagement_id, code from allocations, unnest(codes) code where accepted_at is not null group by 1, 2 having count(*) > 1");
  checks.push(["each line accepted by one partner", dupLines.length === 0, `${dupLines.length} lines twice`]);
  checks.push(["one payout run from two simultaneous presses", runs.filter((r) => r.status === 200).length === 1, runs.map((r) => r.status).join(", ")]);
  const inRuns = await rows("select count(*)::int as n from payouts where run_id is not null");
  const released = await rows("select count(*)::int as n from payouts where status = 'released'");
  checks.push(["every payout in the run released once", inRuns[0]!.n === released[0]!.n && inRuns[0]!.n === run.body.payouts, `${released[0]!.n} released of ${run.body.payouts}`]);
  // Live work counts against capacity whether the partner has accepted it yet or not (repo.ts loadPartners).
  const overCapacity = await rows(
    `select o.name, (o.profile->>'capacity')::int as capacity, count(distinct a.engagement_id)::int as live
       from orgs o join allocations a on a.partner_org_id = o.id join engagements e on e.id = a.engagement_id
      where (a.accepted_at is not null or (a.declined_at is null and a.timed_out_at is null)) and e.status in ('allocating', 'in_delivery', 'disputed')
      group by o.id having count(distinct a.engagement_id) > (o.profile->>'capacity')::int`,
  );
  checks.push(["no partner given more live work than its capacity", overCapacity.length === 0, overCapacity.map((o) => `${o.name}: ${o.live} of ${o.capacity}`).join("; ") || "within capacity"]);
  const engagements = await rows("select count(*)::int as n from engagements");
  checks.push(["one engagement per accepted offer", engagements[0]!.n === N, `${engagements[0]!.n} of ${N}`]);
  const t = performance.now();
  const chain = await asPlatform(env.db, null, (tx) => verifyAuditChain(tx));
  const chainMs = performance.now() - t;
  checks.push(["audit chain intact", chain.intact, `${chain.checked} events in ${Math.round(chainMs)} ms`]);

  const waiting = (await rows("select count(*)::int as n from engagements e where status = 'allocating' and not exists (select 1 from allocations a where a.engagement_id = e.id and a.accepted_at is not null)"))[0]!.n;
  const lines = [
    `# Load test: allocation and payouts`,
    "",
    `${N} engagements, ${CONCURRENCY} at a time, on ${env.db.kind}. Path time ${(pathMs / 1000).toFixed(1)} s (${((N / pathMs) * 1000).toFixed(1)} engagements a second); total with set-up ${((performance.now() - started) / 1000).toFixed(1)} s.`,
    "",
    `Partner capacity is set to bind part-way: ${waiting} engagement(s) ended waiting for a partner with room (the ops queue shows them as "No partner for some lines"), as they would in production.`,
    "",
    "| Step | Requests | p50 ms | p95 ms | max ms |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...[...timings].map(([step, xs]) => `| ${step} | ${xs.length} | ${pct(xs, 50).toFixed(0)} | ${pct(xs, 95).toFixed(0)} | ${Math.max(...xs).toFixed(0)} |`),
    "",
    "| Invariant | Holds | Detail |",
    "| --- | --- | --- |",
    ...checks.map(([name, ok, detail]) => `| ${name} | ${ok ? "yes" : "**NO**"} | ${detail} |`),
    "",
  ];
  console.log(lines.join("\n"));
  if (OUT) writeFileSync(OUT, lines.join("\n"));
  await env.db.close();
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

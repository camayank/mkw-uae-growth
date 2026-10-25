import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTransition, MACHINES, nextStates, TransitionError, type Actor, type MachineName } from "@tasees/core";
import { asPlatform } from "../src/lib/context.ts";
import { transition } from "../src/lib/transition.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/** O13: milestones, offers and engagements change status only through one `transition()`, driven by data. */

const ACTORS: Actor[] = ["client", "partner", "platform", "system"];
const statuses = (m: MachineName) => [...new Set((MACHINES[m] as ReadonlyArray<{ from: string; to: string }>).flatMap((t) => [t.from, t.to]))];
const machines = Object.keys(MACHINES) as MachineName[];

describe("transition tables", () => {
  it("allow exactly what each table lists, for exactly who it lists", () => {
    for (const m of machines) {
      const table = MACHINES[m] as ReadonlyArray<{ from: string; to: string; by: readonly Actor[] }>;
      for (const from of statuses(m))
        for (const to of statuses(m))
          for (const by of ACTORS) {
            const listed = table.some((t) => t.from === from && t.to === to && t.by.includes(by));
            if (listed) expect(() => assertTransition(m, from, to, by)).not.toThrow();
            else expect(() => assertTransition(m, from, to, by), `${m} ${from}->${to} by ${by}`).toThrow(TransitionError);
          }
    }
  });

  it("say what can happen next, in the refusal too", () => {
    expect(nextStates("milestone", "qa_passed").sort()).toEqual(["client_approved", "disputed"]);
    expect(nextStates("milestone", "qa_passed", "system")).toEqual(["client_approved"]);
    expect(nextStates("offer", "accepted")).toEqual([]);
    expect(() => assertTransition("milestone", "qa_passed", "qa_rejected", "client")).toThrow(
      "client cannot move from qa_passed to qa_rejected; from qa_passed client can move to client_approved or disputed",
    );
    expect(() => assertTransition("offer", "accepted", "withdrawn", "platform")).toThrow("nothing platform can do changes accepted");
  });
});

describe("transition()", () => {
  let env: TestEnv;
  const ids: Record<MachineName, string> = { milestone: "", offer: "", engagement: "" };
  const table: Record<MachineName, string> = { milestone: "milestones", offer: "offers", engagement: "engagements" };
  const run = (fn: (tx: any) => Promise<any>): Promise<any> => asPlatform(env.db, null, fn);
  beforeAll(async () => {
    env = await makeEnv();
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    ids.offer = built.body.offerIds[0];
    await env.call("ops", "POST", `/api/ops/offers/${ids.offer}/publish`);
    ids.engagement = (await env.call("client", "POST", `/api/client/offers/${ids.offer}/accept`)).body.engagementId;
    const deposit = (await env.call("finance", "GET", `/api/engagements/${ids.engagement}`)).body.payments.find((p: any) => p.kind === "deposit");
    await env.call("finance", "POST", `/api/ops/payments/${deposit.id}/mark-paid`, { reference: "BANK-TT-1" });
    const e = (await env.call("ops", "GET", `/api/engagements/${ids.engagement}`)).body;
    const key = (name: string) => (name.startsWith("Example Setup") ? "setup" : name.startsWith("Example Corporate") ? "corp" : "tax");
    for (const a of e.allocations) await env.call(key(a.partner), "POST", `/api/allocations/${a.id}/respond`, { decision: "accept" });
    ids.milestone = (await run((tx) => tx.query("select id from milestones where engagement_id = $1 limit 1", [ids.engagement]))).rows[0].id;
  });
  afterAll(() => env.db.close());

  it("makes every listed move on a real row, with its timestamp and an audit event", async () => {
    for (const m of machines) {
      for (const t of MACHINES[m] as ReadonlyArray<{ from: string; to: string; by: readonly Actor[] }>) {
        await run(async (tx) => {
          await tx.query(`update ${table[m]} set status = $2 where id = $1`, [ids[m], t.from]); // test set-up only
          const r = await transition(tx, m, ids[m], t.to, t.by[0]!, { audit: { actor: null, action: `test.${m}` } });
          expect(r).toEqual({ from: t.from, changed: true });
          expect((await tx.query(`select status from ${table[m]} where id = $1`, [ids[m]])).rows[0].status).toBe(t.to);
        });
      }
    }
    const stamped = (await run((tx) => tx.query("select qa_passed_at is not null as qa, first_submitted_at is not null as sub from milestones where id = $1", [ids.milestone]))).rows[0];
    expect(stamped).toEqual({ qa: true, sub: true });
    const events = (await run((tx) => tx.query("select data from audit_events where action = 'test.milestone' order by id"))).rows;
    expect(events).toHaveLength(MACHINES.milestone.length);
    expect(events[0].data).toMatchObject({ from: MACHINES.milestone[0]!.from, to: MACHINES.milestone[0]!.to });
  });

  it("audits every move, including the ones a caller does not describe", async () => {
    // The deposit moved the engagement to allocating without the caller naming an audit event.
    const moves = (await run((tx) => tx.query("select data from audit_events where action = 'engagement.status_changed' and entity_id = $1 order by id", [ids.engagement]))).rows;
    expect(moves[0].data).toMatchObject({ from: "awaiting_payment", to: "allocating" });
  });

  it("refuses an unlisted move and leaves the row as it was", async () => {
    await run((tx) => tx.query("update milestones set status = 'qa_passed' where id = $1", [ids.milestone]));
    await expect(run((tx) => transition(tx, "milestone", ids.milestone, "qa_rejected", "client"))).rejects.toThrow(/can move to client_approved or disputed/);
    expect((await run((tx) => tx.query("select status from milestones where id = $1", [ids.milestone]))).rows[0].status).toBe("qa_passed");
    // Over HTTP the refusal is a 409 that says what can happen next.
    const res = await env.call("ops", "POST", `/api/ops/milestones/${ids.milestone}/qa`, { pass: true });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/platform cannot move from qa_passed to qa_passed; nothing platform can do changes qa_passed/);
  });

  it("sets only the columns a move may carry, and can treat an arrived row as done", async () => {
    await expect(run((tx) => transition(tx, "milestone", ids.milestone, "client_approved", "client", { set: { partner_org_id: null } }))).rejects.toThrow(/not a column/);
    await run((tx) => tx.query("update engagements set status = 'in_delivery' where id = $1", [ids.engagement])); // test set-up only
    expect(await run((tx) => transition(tx, "engagement", ids.engagement, "completed", "system", { idempotent: true }))).toMatchObject({ changed: true });
    expect(await run((tx) => transition(tx, "engagement", ids.engagement, "completed", "system", { idempotent: true }))).toEqual({ from: "completed", changed: false });
    await expect(run((tx) => transition(tx, "offer", "00000000-0000-0000-0000-000000000000", "expired", "system"))).rejects.toThrow(/Offer not found/);
  });
});

describe("the source", () => {
  it("changes these statuses nowhere but transition()", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(join("lib", "transition.ts"))) files.push(p);
      }
    };
    walk(join(__dirname, "..", "src"));
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/update\s+(?:only\s+)?(milestones|offers|engagements)(?:\s+(?:as\s+)?(?!set\b)\w+)?\s+set\s+([\s\S]*?)\swhere\s/gi)) {
        if (/(^|[\s,])status\s*=/.test(m[2]!)) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(30);
  });
});

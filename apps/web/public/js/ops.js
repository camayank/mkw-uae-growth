// Tasees workspace: ops module (split from app.js in O12; plain ES modules, no build step).
import { $app, MILESTONE_LABEL, OBLIGATION_KINDS, act, aed, api, badge, date, dateTime, download, esc, isClient, nameOf, obligationLabel, obligationTone, pct, render, role, seesMargin, state, table, words } from "./core.js";

export async function renderDelays() {
  const q = await api("GET", "/api/ops/delays");
  const canAttribute = ["ops", "founder"].includes(role());
  $app.innerHTML = `<h1>Delays and service guarantee</h1>
  <p class="muted">Overdue steps are noticed daily; the client is told the new expected date and the partner is chased. Ops records who bears each delay. After five working days a credit is due by rule; finance approves or waives it, and a partner-borne delay reduces the completion payout.</p>
  <div class="card flush"><h2>Late steps</h2>${table(
    ["Noticed", "Client · step", "Partner", "Due → expected", "Step now", "Borne by", ""],
    q.delays.map((d) => `<tr><td class="small">${dateTime(d.noticedAt)}</td><td>${esc(d.client)}<br><span class="small muted">${esc(d.step)}</span> <a class="small" href="#/engagement/${d.engagementId}">open</a></td><td>${esc(d.partner)}</td><td class="small">${date(d.dueDate)} → ${date(d.expectedDate)}</td><td>${badge(d.stepStatus, MILESTONE_LABEL[d.stepStatus])}</td>
      <td>${d.cause ? `${esc(d.cause)}<br><span class="small muted">${esc(d.causeNote ?? "")}</span>` : badge("pending", "not attributed")}</td>
      <td>${canAttribute && !d.cause ? `<form class="row" data-form="attribute" data-id="${d.id}"><select name="cause" style="width:auto"><option value="partner">partner</option><option value="client">client</option><option value="government">government</option><option value="mkw">MKW</option></select><input name="note" placeholder="Why" required style="max-width:200px" /><button class="sm" type="submit">Record</button></form>` : ""}</td></tr>`),
    "No late steps.",
  )}</div>
  <h2 style="margin-top:20px">Guarantee credits</h2>
  <div class="card flush">${table(
    ["Created", "Client · step", "Partner", "#Base", "#Credit", "Borne by", "Status", ""],
    q.credits.map((c) => `<tr><td class="small">${date(c.createdAt)}</td><td>${esc(c.client)}<br><span class="small muted">${esc(c.step)}</span> <a class="small" href="#/engagement/${c.engagementId}">open</a></td><td>${esc(c.partner)}</td><td class="num">${aed(c.base)}</td><td class="num"><b>${aed(c.amount)}</b> <span class="small muted">${(c.guaranteeBp / 100).toFixed(0)}%</span></td>
      <td class="small">${c.borneByPartner ? "partner" : c.cause ? `MKW (${esc(c.cause)})` : "MKW (not attributed)"}${c.payoutReduction ? `<br>payout −${aed(c.payoutReduction)}` : ""}</td><td>${badge(c.status === "applied" || c.status === "settled" ? "ok" : c.status === "waived" ? "expired" : "pending", words(c.status))}${c.settledReference ? `<br><span class="small muted">${esc(c.settledReference)}</span>` : ""}</td>
      <td>${seesMargin() && c.status === "pending" ? `<button class="sm primary" data-act="credit" data-id="${c.id}" data-decision="approve">Approve</button> <button class="sm" data-act="credit" data-id="${c.id}" data-decision="waive">Waive</button>` : seesMargin() && c.status === "approved" ? `<button class="sm" data-act="credit-settle" data-id="${c.id}">Record refund</button>` : ""}</td></tr>`),
    "No credits.",
  )}</div>`;
}

export async function renderOpsCompliance(clientId) {
  const list = await api("GET", `/api/ops/compliance${clientId ? `?client=${encodeURIComponent(clientId)}` : ""}`);
  const canAct = ["ops", "founder"].includes(role());
  const orgs = canAct ? (await api("GET", "/api/admin/orgs")).filter((o) => o.type === "client") : [];
  $app.innerHTML = `<h1>Compliance calendar</h1>
  <p class="muted">Obligations generated when an engagement completes arrive as "date to confirm": check the date against the licence, the FTA portal or the registrar, record what it was checked against, and only then the client sees it. Evidence uploaded by a client is checked here before the obligation counts as met; nothing is filed by the platform.</p>
  ${canAct ? `<div class="card"><form class="grid cols-3" data-form="obligation-add">
    <div><label>Client</label><select name="client">${orgs.map((o) => `<option value="${o.id}" ${o.id === clientId ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></div>
    <div><label>Kind</label><select name="kind">${OBLIGATION_KINDS.map((k) => `<option value="${k}">${esc(words(k))}</option>`).join("")}</select></div>
    <div><label>Title</label><input name="title" required minlength="3" placeholder="VAT return Q4 2026" /></div>
    <div><label>Due date</label><input name="dueDate" type="date" required /></div>
    <div><label>Recurs</label><select name="recurrence"><option value="none">once</option><option value="monthly">monthly</option><option value="quarterly">quarterly</option><option value="yearly">yearly</option></select></div>
    <div><label>Basis (what the date comes from)</label><input name="basis" placeholder="FTA portal, tax period Oct–Dec" /></div>
    <div style="grid-column:1/-1"><button class="sm primary" type="submit">Add obligation (confirmed by you)</button></div></form></div>` : ""}
  <div class="card flush">${table(
    ["Due", "Client", "Obligation", "Status", "Evidence", ""],
    list.map((o) => {
      let action = "";
      if (canAct && ["pending_review", "open"].includes(o.status)) action += `<form class="row" data-form="obligation-confirm" data-id="${o.id}"><input name="dueDate" type="date" value="${esc(o.dueDate)}" style="width:auto" /><input name="note" placeholder="Checked against…" required style="max-width:200px" /><button class="sm ${o.status === "pending_review" ? "primary" : ""}" type="submit">${o.status === "pending_review" ? "Confirm" : "Re-date"}</button></form>`;
      if (canAct && o.status === "evidence_uploaded") action += `<button class="sm primary" data-act="obligation-met" data-id="${o.id}">Checked: met</button> `;
      if (canAct && !["met", "waived"].includes(o.status)) action += `<button class="sm" data-act="obligation-waive" data-id="${o.id}">Does not apply</button>`;
      return `<tr><td><b>${date(o.dueDate)}</b></td><td>${esc(o.client)}</td><td>${esc(o.title)} ${o.confidence !== "confirmed" ? badge("UNCERTAIN") : ""}<br><span class="small muted">${esc(words(o.kind))}${o.recurrence !== "none" ? ` · ${esc(o.recurrence)}` : ""}</span>${o.basis ? `<br><span class="small muted">${esc(o.basis)}</span>` : ""}${o.metNote ? `<br><span class="small">Checked: ${esc(o.metNote)}</span>` : ""}${o.waiveReason ? `<br><span class="small">Waived: ${esc(o.waiveReason)}</span>` : ""}</td>
        <td>${badge(obligationTone(o), obligationLabel(o))}${(o.remindersSent ?? []).length ? `<br><span class="small muted">reminded ${o.remindersSent.map((r) => (r === -1 ? "overdue" : `${r}d`)).join(", ")}</span>` : ""}</td>
        <td class="small">${o.evidenceName ? `<a href="/api/obligations/${o.id}/file" target="_blank" rel="noopener">${esc(o.evidenceName)}</a><br><span class="muted">${dateTime(o.evidenceUploadedAt)}</span>` : "–"}</td><td>${action}</td></tr>`;
    }),
    "No obligations yet.",
  )}</div>`;
}

export async function renderDashboard(periodArg) {
  const now = new Date();
  const period = periodArg ? decodeURIComponent(periodArg) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const d = await api("GET", `/api/admin/dashboard?period=${encodeURIComponent(period)}`);
  const c = d.current;
  const p = d.previous;
  const delta = (a, b, money = true) => {
    if (b === 0 && a === 0) return "";
    const diff = a - b;
    return `<span class="small ${diff >= 0 ? "muted" : "muted"}">${diff >= 0 ? "▲" : "▼"} ${money ? aed(Math.abs(diff)) : Math.abs(diff)} vs ${esc(p.period.label)}</span>`;
  };
  const kpi = (label, value, sub = "") => `<div class="kpi"><b>${value}</b><span>${label}</span>${sub ? `<br>${sub}` : ""}</div>`;
  const y = Number(period.slice(0, 4));
  const options = [];
  for (let m = 12; m >= 1; m--) options.push(`${y}-${String(m).padStart(2, "0")}`);
  const choices = [String(y), `${y}-Q1`, `${y}-Q2`, `${y}-Q3`, `${y}-Q4`, ...options];
  $app.innerHTML = `<div class="row between"><h1>Dashboard</h1><form class="row" data-form="period"><select name="period" style="width:auto">${choices.map((x) => `<option ${x === period ? "selected" : ""}>${x}</option>`).join("")}</select><button class="sm" type="submit">Show</button></form></div>
  <p class="muted">Figures come from the same invoice, payment and payout rows the accounting export uses. ${d.seesMargin ? "" : "Margin is shown to finance and the founder."}</p>
  <div class="kpis">
    ${kpi("Revenue (net of VAT, issued invoices)", aed(c.revenueNetFils), delta(c.revenueNetFils, p.revenueNetFils))}
    ${kpi("VAT on fees", aed(c.vatFils), delta(c.vatFils, p.vatFils))}
    ${kpi("Cash collected", aed(c.cashCollectedFils), delta(c.cashCollectedFils, p.cashCollectedFils))}
    ${kpi("Refunded", aed(c.refundedFils))}
    ${d.seesMargin ? kpi("Margin on accepted offers", `${aed(c.marginFils)} <span class="small muted">${pct(c.marginBp)}</span>`, delta(c.marginFils, p.marginFils)) : ""}
    ${kpi("Payouts paid to partners", aed(c.payoutsPaidFils), delta(c.payoutsPaidFils, p.payoutsPaidFils))}
    ${kpi("Payouts due now", aed(c.payoutsDueFils))}
    ${kpi("Guarantee credits", aed(c.guaranteeCreditsFils))}
  </div>
  <div class="kpis">
    ${kpi("Requests", c.requests, delta(c.requests, p.requests, false))}
    ${kpi("Offers accepted", c.offersAccepted, delta(c.offersAccepted, p.offersAccepted, false))}
    ${kpi("Request → acceptance", `${(c.requestToAcceptance * 100).toFixed(0)}%`)}
    ${kpi("Engagements completed", c.engagementsCompleted)}
    ${kpi("Steps on time", `${(c.onTimeRate * 100).toFixed(0)}%`, `<span class="small muted">${c.milestonesOnTime} of ${c.milestonesDone}</span>`)}
  </div>
  <div class="grid cols-2">
    <div class="card flush"><h2>Partner share by category (accepted work, ${esc(c.period.label)})</h2>${table(
      ["Category", "Partner", "#Share"],
      Object.entries(c.partnerShareByCategory).flatMap(([cat, m]) => Object.entries(m).map(([partner, share]) => `<tr><td>${esc(cat)}</td><td>${esc(partner)}</td><td class="num">${(share * 100).toFixed(0)}%</td></tr>`)),
      "No work accepted in this period.",
    )}<p class="small muted pad" style="padding-top:0">The 35% fairness cap is measured on this share, per category.</p></div>
    <div class="stack">
      ${d.queue ? `<div class="card flush"><h2>Ops queue (${esc(c.period.label)})</h2>
        <p class="small muted" style="padding:0 18px">${d.queue.resolved} item(s) resolved${d.queue.withinTargetRate === null ? "" : `, ${Math.round(d.queue.withinTargetRate * 100)}% within target`}; ${d.queue.opsMinutes} ops minute(s) handling them${d.queue.opsMinutesPerEngagement === null ? "" : `, ${d.queue.opsMinutesPerEngagement} per engagement`} (from opening an item to its leaving the queue, at most 30 minutes each).</p>
        ${table(["Kind", "#Resolved", "#Median hours waiting", "#Within target"], d.queue.byKind.map((k) => `<tr><td>${esc(words(k.kind))}</td><td class="num">${k.resolved}</td><td class="num">${k.medianHoursInQueue}</td><td class="num">${k.withinTarget}</td></tr>`), "Nothing resolved in this period.")}</div>` : ""}
      <div class="card flush"><h2>Engagements by status</h2>${table(["Status", "#Count"], d.pipeline.map((r) => `<tr><td>${badge(r.status)}</td><td class="num">${r.n}</td></tr>`), "None yet.")}</div>
      <div class="card flush"><h2>Compliance calendar</h2>${table(["Status", "#Count"], d.obligations.map((r) => `<tr><td>${esc(words(r.status))}</td><td class="num">${r.n}</td></tr>`), "No obligations yet.")}</div>
      ${["ops", "finance", "founder"].includes(role()) ? `<div class="card"><h2>Accounting export</h2>
        <p class="small muted">CSV for the accounting system (generic layout; the final column mapping for Zoho Books, Xero or QuickBooks is an owner decision, ${badge("UNCERTAIN")} until named). Every export is logged.</p>
        <form class="grid cols-3" data-form="accounting-export">
          <div><label>Set</label><select name="set"><option value="sales">Sales: tax invoices and credit notes</option><option value="payments">Payments received and refunded</option><option value="payouts">Partner payouts released</option>${seesMargin() ? `<option value="margin">Margin per line (finance)</option>` : ""}</select></div>
          <div><label>From</label><input name="from" type="date" value="${esc(c.period.from)}" required /></div>
          <div><label>To</label><input name="to" type="date" value="${esc(new Date(new Date(c.period.to).getTime() - 86400000).toISOString().slice(0, 10))}" required /></div>
          <div style="grid-column:1/-1"><button class="sm primary" type="submit">Download CSV</button> <a class="small" href="#/settings">export log on Settings</a></div></form></div>` : ""}
    </div>
  </div>`;
}

// The ops command centre (O11): one list ranked by risk and target time. The ranking orders; a person decides.
export let queueItems = [];
export let queueFilter = "all";
export const LEVEL_LABEL = { overdue: "Overdue", due_soon: "Due soon", on_track: "On track" };
export const LEVEL_TONE = { overdue: "bad", due_soon: "warn", on_track: "ok" };

export function queueDraft(d, describedBy = "") {
  const desc = describedBy ? ` aria-describedby="${esc(describedBy)}"` : "";
  const c = d.check ?? {};
  const issues = Array.isArray(c.issues) ? c.issues : [];
  const state = d.status === "pending" ? badge("UNCERTAIN") : badge(d.status === "approved" ? "approved" : "rejected", d.status === "approved" ? "check confirmed" : "check disputed");
  const buttons =
    d.status === "pending" && ["ops", "founder"].includes(role())
      ? `<div class="row"><span class="small muted">Is the check right?</span><button class="sm" data-act="draft-agree" data-id="${esc(d.id)}"${desc}>Check is right</button><button class="sm" data-act="draft-disagree" data-id="${esc(d.id)}"${desc}>Check is wrong</button></div>`
      : "";
  return `<div class="qdraft"><div class="row between"><span class="small"><b>Document check</b> · ${esc(c.basis ?? "")}</span>${state}</div>
    <p class="small">${esc(c.summary ?? "")}</p>${issues.length ? `<ul class="small">${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}${buttons}</div>`;
}

export function queueCard(x) {
  const due = x.level === "overdue" ? `was due ${dateTime(x.dueAt)}` : `due ${dateTime(x.dueAt)}`;
  const buttons = x.actions
    .map((a, n) => `<button class="sm${a.primary ? " primary" : ""}" data-act="queue-act" data-item="${esc(x.id)}" data-n="${n}" aria-describedby="q-${esc(x.id)}">${esc(a.label)}</button>`)
    .join("");
  return `<li class="qitem ${esc(x.level)}"><article aria-labelledby="q-${esc(x.id)}">
    <div class="row between qhead"><div class="row"><span class="badge ${LEVEL_TONE[x.level]}">${LEVEL_LABEL[x.level]}</span><span class="small muted">${esc(x.label)}</span></div><span class="small muted">${esc(due)}</span></div>
    <h2 id="q-${esc(x.id)}" class="qtitle">${esc(x.detail)}</h2>
    <p class="qwhy">${esc(x.why)}</p>
    <p class="small muted">Ranked here because ${esc(x.factors.join("; "))}.</p>
    ${x.drafts.map((d) => queueDraft(d, `q-${x.id}`)).join("")}
    <div class="row qactions">${buttons}<a href="${esc(x.link)}" data-act="queue-open" data-item="${esc(x.id)}" aria-describedby="q-${esc(x.id)}">Open</a></div>
  </article></li>`;
}

export function setQueueFilter(kind) {
  queueFilter = kind;
  drawQueue();
}

export function drawQueue() {
  const shown = queueFilter === "all" ? queueItems : queueItems.filter((x) => x.kind === queueFilter);
  const kinds = [...new Set(queueItems.map((x) => x.kind))];
  const count = (k) => queueItems.filter((x) => x.kind === k).length;
  const label = (k) => queueItems.find((x) => x.kind === k)?.label ?? words(k);
  const filters = `<div class="row qfilters" role="group" aria-label="Show">${[["all", `All (${queueItems.length})`], ...kinds.map((k) => [k, `${label(k)} (${count(k)})`])]
    .map(([k, l]) => `<button class="sm chip" data-act="queue-filter" data-kind="${esc(k)}" aria-pressed="${queueFilter === k}">${esc(l)}</button>`)
    .join("")}</div>`;
  const list = document.getElementById("queue-list");
  if (!list) return;
  document.getElementById("queue-filters").innerHTML = queueItems.length ? filters : "";
  list.innerHTML = shown.length ? shown.map(queueCard).join("") : `<li class="empty">The queue is empty.</li>`;
}

export async function renderQueue() {
  const o = await api("GET", "/api/ops/queue");
  queueItems = o.items;
  if (queueFilter !== "all" && !queueItems.some((x) => x.kind === queueFilter)) queueFilter = "all";
  const overdue = queueItems.filter((x) => x.level === "overdue").length;
  const soon = queueItems.filter((x) => x.level === "due_soon").length;
  $app.innerHTML = `
  <h1>What needs a person today</h1>
  <p class="muted">Everything else runs on its own: pricing from rate cards, allocation, reminders, auto-approval after 5 working days. The list is ordered by risk and target time; the order never decides anything.</p>
  <div class="kpis"><div class="kpi"><b>${queueItems.length}</b><span>Waiting</span></div><div class="kpi"><b>${overdue}</b><span>Past their target</span></div><div class="kpi"><b>${soon}</b><span>Due within 2 working hours</span></div></div>
  <div id="queue-filters"></div>
  <ol id="queue-list" class="qlist" aria-label="Queue, highest risk first"></ol>
  <div class="row" style="margin-top:12px"><button class="sm" data-act="run-jobs">Run timers now</button><span class="small muted">Checks partner reply deadlines, client auto-approvals and offer expiry. Runs every 15 minutes on its own.</span></div>`;
  drawQueue();
}

export async function renderPipeline() {
  const o = await api("GET", "/api/ops/overview");
  const canAct = ["ops", "founder"].includes(role());
  const offersFor = (rid) => o.offers.filter((f) => f.requestId === rid);
  $app.innerHTML = `
  <h1>Pipeline</h1>
  <div class="stack">
  <div class="card flush"><h2>Requests</h2>${table(
    ["Received", "Client", "Scope", "Status", "Offers", ""],
    o.requests.map((r) => {
      const codes = (r.scope?.lines ?? []).map((l) => l.code);
      return `<tr><td>${date(r.createdAt)}</td><td>${esc(r.client)}</td>
      <td class="small">${esc((r.scope?.lines ?? []).map((l) => `${nameOf(l.code)}${l.qty > 1 ? ` ×${l.qty}` : ""}`).join(", "))}${(r.notes ?? []).length ? `<br><span class="muted">${esc(r.notes.join("; "))}</span>` : ""}</td>
      <td>${badge(r.status)}${r.adviceStatus === "pending_review" ? `<br>${badge("UNCERTAIN", "advice to review")}` : ""}${r.channel === "public_intake" ? `<br><span class="small muted">from the lead page</span>` : ""}<br><a class="small" href="#/request/${r.id}">Scoping</a></td>
      <td class="small">${offersFor(r.id).map((f) => `<a href="#/offer/${f.id}">${esc(f.tier)}</a> ${badge(f.status)}`).join("<br>") || "–"}</td>
      <td>${canAct && ["scoped", "quoting", "offered"].includes(r.status) ? `<button class="sm" data-act="build" data-id="${r.id}">Price it</button>${r.status === "quoting" ? ` <button class="sm" data-act="rfq" data-id="${r.id}" data-codes="${esc(codes.join(","))}">Ask partners</button>` : ""}` : ""}</td></tr>`;
    }),
    "No requests yet.",
  )}</div>
  <div class="card flush"><h2>Offers</h2>${table(
    ["Client", "Tier", "Status", "#Client total", "#Partner payout", ...(o.seesMargin ? ["#Margin", "#Margin %"] : []), ""],
    o.offers.map(
      (f) => `<tr><td>${esc(f.client)}</td><td>${esc(f.tier)}</td><td>${badge(f.status)}${f.linesNeedingReview ? ` ${badge("ops_review", `${f.linesNeedingReview} to review`)}` : ""}</td>
      <td class="num">${aed(f.clientTotal)}</td><td class="num">${aed(f.partnerPayout)}</td>
      ${o.seesMargin ? `<td class="num">${aed(f.margin)}</td><td class="num">${pct(f.marginBp)}</td>` : ""}<td><a href="#/offer/${f.id}">Open</a></td></tr>`,
    ),
    "No offers yet.",
  )}</div>
  <div class="card flush"><h2>Engagements</h2>${table(
    ["Started", "Client", "Partners", "Progress", "Status", ""],
    o.engagements.map(
      (e) => `<tr><td>${date(e.createdAt)}</td><td>${esc(e.client)}</td><td>${esc(e.partners ?? "–")}</td><td>${e.approved} of ${e.milestones}</td>
      <td>${badge(e.status)}</td><td><a href="#/engagement/${e.id}">Open</a></td></tr>`,
    ),
    "No engagements yet.",
  )}</div>
  </div>`;
}

export async function renderOpsOffer(id) {
  const f = await api("GET", `/api/ops/offers/${id}`);
  const canAct = ["ops", "founder"].includes(role());
  $app.innerHTML = `
  <p><a href="#/pipeline">← Pipeline</a></p>
  <div class="row between"><h1 style="text-transform:capitalize">${esc(f.tier)} offer</h1>${badge(f.status)}</div>
  <div class="kpis">
    <div class="kpi"><b>${aed(f.clientTotal)}</b><span>Client total incl. VAT and government fees</span></div>
    <div class="kpi"><b>${aed(f.partnerPayout)}</b><span>Paid to partners</span></div>
    ${seesMargin() ? `<div class="kpi"><b>${aed(f.margin)}</b><span>MKW margin · ${pct(f.marginBp)} of fees</span></div>` : ""}
    <div class="kpi"><b>${f.linesNeedingReview ?? 0}</b><span>Lines needing a decision</span></div>
  </div>
  <div class="card flush">${table(
    ["Service", "#Qty", "Partner", "#Partner cost", "#Cap", "#Client price", ...(seesMargin() ? ["#Margin"] : []), "Check", ...(canAct ? ["Set price, AED"] : [])],
    f.lines.map(
      (l) => `<tr><td>${esc(l.name)}<br><span class="small muted">${esc(l.code)} · ${esc(l.model)}</span></td><td class="num">${l.qty}</td><td>${esc(l.partnerName ?? "–")}</td>
      <td class="num">${aed(l.partnerUnitCost)}</td><td class="num">${aed(l.capUnit)}</td><td class="num">${aed(l.clientUnitPrice)}</td>
      ${seesMargin() ? `<td class="num">${aed(l.marginUnit)}</td>` : ""}<td>${badge(l.status)}${l.reason ? `<br><span class="small muted">${esc(l.reason)}</span>` : ""}</td>
      ${canAct && ["draft", "ops_review"].includes(f.status) ? `<td><form class="row" data-form="override" data-id="${f.id}" data-code="${esc(l.code)}"><input name="aed" type="number" min="1" style="width:110px" /><button class="sm">Set</button></form></td>` : canAct ? "<td></td>" : ""}</tr>`,
    ),
  )}</div>
  <p class="small muted">Prices follow the margin rule: cost plus the category rate or floor, rounded up to AED 50 and capped at 1.25× the market mid. A line goes to review when the cap would push the margin below the floor. A price you set here is recorded in the audit trail.</p>
  ${canAct && ["draft", "ops_review"].includes(f.status) ? `<button class="primary" data-act="publish" data-id="${f.id}" data-review="${f.linesNeedingReview ?? 0}">${f.linesNeedingReview ? "Publish anyway (I have checked the flagged lines)" : "Publish to client"}</button>` : ""}`;
}

export async function renderPartners() {
  const o = await api("GET", "/api/ops/overview");
  const canAct = ["ops", "founder"].includes(role());
  $app.innerHTML = `<h1>Partner network</h1>
  <p class="muted">Allocation picks from partners with an active licence, a signed agreement, the right emirate and capacity, then by quote, relationship and a 35% monthly fairness cap measured per service category.</p>
  ${["ops", "founder"].includes(role()) ? `<p><button class="sm" data-act="scorecards">Recompute scorecards now</button> <span class="small muted">Otherwise weekly, from on-time delivery, first-pass QA, disputes, acceptance strikes and client ratings.</span></p>` : ""}
  <div class="card flush">${table(
    ["Partner", "Status", "#Quality", "#Capacity", "Emirates", "Checks", "Services", ""],
    o.partners.map((p) => {
      const pr = p.profile ?? {};
      const checks = [pr.licenceActive ? "licence" : null, pr.agreementSigned ? "agreement" : null, pr.ftaTaxAgent ? "FTA agent" : null, (pr.approvedAuditorZones ?? []).length ? "auditor" : null]
        .filter(Boolean)
        .join(", ");
      return `<tr><td><a href="#/partner/${p.id}">${esc(p.name)}</a>${pr.licenceExpiry ? `<br><span class="small muted">licence to ${date(pr.licenceExpiry)}</span>` : ""}</td><td>${badge(pr.status ?? p.status)}</td><td class="num">${pr.quality ?? "–"}</td><td class="num">${pr.capacity ?? "–"}</td>
      <td class="small">${esc((pr.emirates ?? []).join(", "))}</td><td class="small">${esc(checks || "–")}</td><td class="small">${esc((pr.codes ?? []).join(", "))}</td>
      <td>${canAct ? `<a class="btn sm" href="#/partner/${p.id}">Onboarding</a>` : ""}</td></tr>`;
    }),
  )}</div>
  <h2 style="margin-top:20px">Payouts due</h2>
  <div class="card flush">${table(
    ["Partner", "Stage", "#Amount", "Status", ""],
    o.payouts.map(
      (p) => `<tr><td>${esc(p.partner)}</td><td>${esc(words(p.stage))}</td><td class="num">${aed(p.amount)}</td><td>${badge(p.status)}</td>
      <td><a href="#/engagement/${p.engagementId}">Open</a></td></tr>`,
    ),
    "Nothing due.",
  )}</div>
  ${seesMargin() ? await renderPayoutRuns() : ""}`;
}

export async function renderPayoutRuns() {
  const [payable, runs] = await Promise.all([api("GET", "/api/ops/payouts/payable"), api("GET", "/api/ops/payout-runs")]);
  const ready = payable.filter((p) => p.payable);
  const open = runs.find((r) => ["open", "exported"].includes(r.status));
  return `<h2 style="margin-top:20px">Payout runs</h2>
  <p class="muted">A payout is paid in the weekly run once the partner's invoice and bank details are on file. Create the run, download the bank bulk-transfer file, pay it at the bank, then mark the run paid: that releases the payouts and sends each partner a remittance advice.</p>
  <div class="card flush"><h2 style="padding:16px 18px 0">Ready and blocked payouts</h2>${table(
    ["Partner", "Stage", "#Amount", "Partner invoice", "Bank", "Status"],
    payable.map((p) => `<tr><td>${esc(p.partner)}</td><td>${esc(words(p.stage))}</td><td class="num">${aed(p.amount)}${p.invoiceVat ? `<br><span class="small muted">+ VAT ${aed(p.invoiceVat)}</span>` : ""}</td>
      <td class="small">${p.invoiceNumber ? esc(p.invoiceNumber) : badge("pending", "missing")}</td><td class="small">${p.bank?.iban ? "on file" : badge("pending", "missing")}</td><td>${p.payable ? badge("eligible", "ready") : badge("pending", p.blocked)}</td></tr>`),
    "No eligible payouts.",
  )}
  <div class="pad" style="padding-top:8px">${open ? `<span class="small muted">Run ${esc(open.reference)} is ${esc(open.status)}; finish it before opening another.</span>` : `<button class="sm primary" data-act="run-create" ${ready.length ? "" : "disabled"}>Create payout run (${ready.length} ready)</button>`}</div></div>
  <div class="card flush" style="margin-top:12px">${table(
    ["Run", "Created", "#Payouts", "#Total", "Status", ""],
    runs.map((r) => `<tr><td class="mono small">${esc(r.reference)}</td><td>${dateTime(r.createdAt)}<br><span class="small muted">${esc(r.createdBy ?? "")}</span></td><td class="num">${r.payouts}</td><td class="num">${aed(r.total)}</td>
      <td>${badge(r.status === "paid" ? "paid" : r.status === "cancelled" ? "cancelled" : "pending", r.status)}${r.bankReference ? `<br><span class="small muted">${esc(r.bankReference)}</span>` : ""}</td>
      <td><div class="actions">${["open", "exported"].includes(r.status) ? `<a class="btn sm" href="/api/ops/payout-runs/${r.id}/file" target="_blank" rel="noopener" data-act-link="run-file">Download bank file</a>` : ""}
      ${r.status === "exported" ? `<button class="sm primary" data-act="run-paid" data-id="${r.id}">Mark paid</button>` : ""}${["open", "exported"].includes(r.status) ? `<button class="sm" data-act="run-cancel" data-id="${r.id}" data-exported="${r.status === "exported" ? 1 : 0}">Cancel</button>` : ""}</div></td></tr>`),
    "No payout runs yet.",
  )}</div>`;
}

export async function renderAudit() {
  const rows = await api("GET", "/api/ops/audit");
  let intact = true;
  for (let i = 0; i < rows.length - 1; i++) if (rows[i].prevHash !== rows[i + 1].hash) intact = false;
  $app.innerHTML = `<h1>Audit trail</h1>
  <p class="${intact ? "muted" : "notice"}">${intact ? "Each event is chained to the one before by a SHA-256 hash; the chain on this page is intact." : "The hash chain does not line up on this page. Investigate before relying on these records."}</p>
  <div class="card flush">${table(
    ["When", "Action", "Entity", "Detail", "Hash"],
    rows.map(
      (r) => `<tr><td>${dateTime(r.at)}</td><td>${esc(r.action)}</td><td class="small">${esc(r.entity)}</td>
      <td class="small mono">${esc(JSON.stringify(r.data))}</td><td class="mono small">${esc(String(r.hash).slice(0, 12))}…</td></tr>`,
    ),
  )}</div>`;
}


// Notifications: each person's bell ------------------------------------------------------------

export const CONF_LABEL = { verified: "verified rule", rule_of_thumb: "rule of thumb", UNCERTAIN: "UNCERTAIN" };
export const confBadge = (c) => badge(c === "verified" ? "ok" : c === "rule_of_thumb" ? "pending" : "UNCERTAIN", CONF_LABEL[c] ?? c);
export const STRUCTURE_LABEL = { free_zone: "Free zone", mainland: "Mainland", offshore: "Offshore", difc_adgm: "DIFC or ADGM" };

export function adviceHtml(a, opts = {}) {
  const item = (r) => `<li>${opts.editable && r.ruleKey ? `<label><input type="checkbox" name="keep" value="${esc(r.ruleKey)}" checked /> ` : ""}<span data-no-i18n>${esc(r.text)}</span> ${confBadge(r.confidence)}${opts.editable && r.ruleKey ? "</label>" : ""}</li>`;
  return `
  <div class="grid cols-2">
    <div class="card"><h2>Structure: ${esc(STRUCTURE_LABEL[a.structure.recommendation] ?? "to be confirmed")}</h2>
      ${opts.editable ? `<div class="field"><label>Set the structure the client sees</label><select name="structure">${Object.entries(STRUCTURE_LABEL).map(([k, v]) => `<option value="${k}" ${a.structure.recommendation === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>` : ""}
      <ul class="plain">${a.structure.reasons.map(item).join("")}</ul>
      ${a.licences.length ? `<h3>Licences and approvals</h3><ul class="plain">${a.licences.map(item).join("")}</ul>` : ""}
    </div>
    <div class="card"><h2>Where to register</h2>
      ${a.places.length ? `<ul class="plain">${a.places.map((p) => `<li>${opts.editable ? `<label><input type="checkbox" name="keepPlace" value="${esc(p.zone)}" checked /> ` : ""}<b>${esc(p.zone)}</b> (${esc(p.emirate)}) · ${aed(p.costMinFils)} to ${aed(p.costMaxFils)} · ${p.visaQuota} visa(s) · about ${p.timelineDays} working days ${confBadge(p.confidence)}<br><span class="small muted">${esc(p.why.join("; "))}</span>${opts.editable ? "</label>" : ""}</li>`).join("")}</ul>` : `<p class="muted">No candidate places for this structure yet.</p>`}
      <h3>What follows after setup</h3><ul class="plain">${a.obligations.map(item).join("")}</ul>
    </div>
  </div>
  <p class="small muted">${a.hasUncertain ? "Items marked UNCERTAIN or rule of thumb have not yet been verified by a qualified person; MKW Advisors confirms them before anything is filed." : "Every item above is a verified rule with a named sign-off."} Nothing is filed automatically: a person at MKW Advisors handles every registration.</p>`;
}

export async function renderRequest(id) {
  if (isClient()) {
    const h = await api("GET", "/api/client/home");
    const r = h.requests.find((x) => x.id === id);
    if (!r || !r.advice) {
      $app.innerHTML = `<p><a href="#/">← Overview</a></p><h1>Our advice</h1><p class="muted">${r?.adviceStatus === "pending_review" ? "A person at MKW Advisors is checking the advice for your case; it appears here once approved." : "No advice for this request."}</p>`;
      return;
    }
    $app.innerHTML = `<p><a href="#/">← Overview</a></p><h1>Our advice for your request</h1><p class="muted">Reviewed by MKW Advisors on ${date(r.adviceReviewedAt)}. Confidence is shown for each statement.</p>${adviceHtml(r.advice)}`;
    return;
  }
  const r = await api("GET", `/api/ops/requests/${id}/scoping`);
  const canAct = ["ops", "founder"].includes(role());
  const a = r.answers ?? {};
  $app.innerHTML = `<p><a href="#/pipeline">← Pipeline</a></p>
  <div class="row between"><h1>Scoping · ${esc(r.client)}</h1>${badge(r.advice_status === "approved" ? "ok" : r.advice_status === "pending_review" ? "UNCERTAIN" : "pending", words(r.advice_status))}</div>
  <div class="grid cols-2">
    <div class="card"><h2>What the founder told us</h2>
      <table><tr><td>Starting point</td><td>${esc(words(a.mode))}</td></tr><tr><td>Emirate / zone</td><td>${esc(a.emirate)}${a.freeZone ? ` · ${esc(a.freeZone)}` : ""}</td></tr>
      <tr><td>Asked for</td><td>${esc(words(a.jurisdiction ?? "–"))}</td></tr><tr><td>Activity</td><td>${esc(a.activity ?? "–")}</td></tr><tr><td>Customers</td><td>${esc(words(a.customers ?? "–"))}</td></tr>
      <tr><td>Office needed</td><td>${a.officeNeeded == null ? "–" : a.officeNeeded ? "yes" : "no"}</td></tr><tr><td>Visas</td><td>${a.visas ?? 0}</td></tr>
      <tr><td>Budget</td><td>${a.budgetAed ? aed(a.budgetAed * 100) : "–"}</td></tr><tr><td>Expected sales</td><td>${a.expectedTurnoverAed ? aed(a.expectedTurnoverAed * 100) : "–"}</td></tr></table>
      ${a.description ? `<p class="small" style="white-space:pre-wrap"><b>In their words:</b> ${esc(a.description)}</p>` : ""}
      <p class="small muted">Source: ${esc(r.source?.channel ?? "console")}${r.source?.campaign ? ` · campaign ${esc(r.source.campaign)}` : ""}</p>
    </div>
    <div class="card"><h2>Scope sheet</h2>${table(["Service", "#Qty"], (r.scope?.lines ?? []).map((l) => `<tr><td>${esc(nameOf(l.code))}</td><td class="num">${l.qty}</td></tr>`))}
      ${(r.notes ?? []).length ? `<p class="small muted">${esc(r.notes.join("; "))}</p>` : ""}
      ${(r.drafts ?? []).length ? `<h3>AI drafts</h3>${r.drafts.map((d) => `<div class="small">${badge(d.status === "pending" ? "UNCERTAIN" : d.status === "approved" ? "ok" : "rejected", d.status)} ${esc(d.kind)} by ${esc(d.model)} · ${esc(d.output?.summary ?? "")}${d.status === "pending" ? ` <a href="#/agent">decide in the AI queue</a>` : ""}</div>`).join("")}` : ""}
    </div>
  </div>
  ${r.advice ? `<form data-form="approve-advice" data-id="${r.id}"><h2 style="margin-top:16px">Advice ${r.advice_status === "approved" ? `(approved by ${esc(r.reviewed_by ?? "")} on ${date(r.advice_reviewed_at)})` : "to review"}</h2>
    ${adviceHtml(r.advice, { editable: canAct && r.advice_status !== "approved" })}
    ${canAct ? `<div class="row" style="margin-top:8px">${r.advice_status !== "approved" ? `<input name="note" placeholder="Note for the audit trail (optional)" style="max-width:360px" /><button class="primary" type="submit">Approve for the client (untick anything to leave out)</button>` : ""}<button type="button" class="sm" data-act="recompute-advice" data-id="${r.id}">Recompute from current rules</button></div>` : ""}</form>` : `<p class="muted">No scoping advice: the founder answered no scoping questions.</p>`}`;
}

export async function renderScoping() {
  const o = await api("GET", "/api/admin/scoping");
  const founder = role() === "founder";
  const verifyForm = (kind, key, c) => founder ? `<form class="row" data-form="verify-${kind}" data-id="${esc(key)}" style="flex-wrap:wrap;gap:4px">
      <select name="confidence">${["verified", "rule_of_thumb", "UNCERTAIN"].map((v) => `<option value="${v}" ${c === v ? "selected" : ""}>${CONF_LABEL[v]}</option>`).join("")}</select>
      <input name="verifiedBy" placeholder="Verified by (name, qualification)" style="width:200px" /><input name="sourceUrl" type="url" placeholder="https://source" style="width:180px" /><button class="sm" type="submit">Save</button></form>` : "";
  $app.innerHTML = `<h1>Scoping rules and places</h1>
  <p class="muted">The advice shown to founders is built only from these. Each starts UNCERTAIN; a qualified person verifies it with a source, the founder records that here, and from then on the advice built on it says "verified rule" with the date. ${o.pendingReviews ? `${o.pendingReviews} request(s) have advice waiting for review on the Pipeline.` : ""}</p>
  <div class="card flush"><h2 style="padding:16px 18px 0">Rules</h2>${table(
    ["Kind", "Rule", "Confidence", "Verified", ...(founder ? ["Record verification"] : [])],
    o.rules.map((r) => `<tr><td class="small">${esc(r.kind)}</td><td>${esc(r.statement)}<br><span class="small mono muted">${esc(r.key)}</span>${r.sourceUrl ? ` · <a class="small" href="${esc(r.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>` : ""}</td>
      <td>${confBadge(r.confidence)}</td><td class="small">${r.verifiedBy ? `${esc(r.verifiedBy)}<br><span class="muted">${date(r.verifiedAt)}</span>` : "–"}</td>${founder ? `<td>${verifyForm("rule", r.key, r.confidence)}</td>` : ""}</tr>`),
  )}</div>
  <div class="card flush" style="margin-top:16px"><h2 style="padding:16px 18px 0">Places</h2>${table(
    ["Place", "Type", "#Visas", "#Cost from", "#Cost to", "#Days", "Known for", "Confidence", "Verified", ...(founder ? ["Record verification"] : [])],
    o.zones.map((z) => `<tr><td>${esc(z.name)}<br><span class="small muted">${esc(z.emirate)}</span></td><td class="small">${esc(words(z.type))}</td><td class="num">${z.visaQuota}</td><td class="num">${aed(z.costMin)}</td><td class="num">${aed(z.costMax)}</td><td class="num">${z.timelineDays}</td>
      <td class="small">${esc((z.activities ?? []).join(", "))}</td><td>${confBadge(z.confidence)}</td><td class="small">${z.verifiedBy ? `${esc(z.verifiedBy)}<br><span class="muted">${date(z.verifiedAt)}</span>` : "–"}</td>${founder ? `<td>${verifyForm("zone", z.name, z.confidence)}</td>` : ""}</tr>`),
  )}</div>`;
}

export async function renderAgentQueue() {
  const drafts = await api("GET", "/api/ops/drafts");
  const canAct = ["ops", "founder"].includes(role());
  const leads = canAct ? (await api("GET", "/api/ops/leads")).filter((l) => l.status === "held") : [];
  $app.innerHTML = `<h1>AI review queue</h1>
  <p class="muted">Drafts written by the model: scopes from what founders typed, and first checks of uploaded documents. Nothing here changes a request, a document or what a client sees until a person approves it; discarded drafts are kept for the record.</p>
  <div class="stack">${
    drafts.length
      ? drafts.map((d) => d.kind === "document_check" ? `<div class="card"><div class="row between"><h2>Document check: ${esc(words(d.input?.declaredType ?? "document"))}</h2><span class="small muted">${dateTime(d.createdAt)} · model ${esc(d.model)}</span></div><p class="small muted">File name as the model saw it (names and numbers removed): <span class="mono">${esc(d.input?.fileName ?? "")}</span></p>${queueDraft({ ...d, check: d.output })}</div>` : `<form class="card" data-form="draft" data-id="${d.id}"><div class="row between"><h2>${esc(words(d.kind))} draft for ${esc(d.client ?? "")} ${badge("UNCERTAIN")}</h2><span class="small muted">${dateTime(d.createdAt)} · model ${esc(d.model)}</span></div>
        <p class="small muted">In the founder's words: <span style="white-space:pre-wrap">${esc(d.input?.description ?? "")}</span></p>
        ${d.output?.lines?.length ? `<ul class="plain">${d.output.lines.map((l) => `<li><label><input type="checkbox" name="keep" value="${esc(l.code)}" checked /> ${esc(nameOf(l.code))}${l.qty > 1 ? ` ×${l.qty}` : ""} <span class="small muted">(${esc(l.why)})</span></label></li>`).join("")}</ul>` : `<p class="small">No lines suggested.</p>`}
        ${d.output?.flags?.length ? `<p class="small">Flags: ${esc(d.output.flags.join("; "))}</p>` : ""}
        <p class="small muted">${esc(d.output?.summary ?? "")} <a href="#/request/${d.requestId}">Open the request</a></p>
        ${canAct ? `<div class="row"><input name="note" placeholder="Note (optional)" style="max-width:300px" /><button class="sm primary" type="submit" name="decision" value="approve">Approve: set the scope from the ticked lines</button><button class="sm" type="submit" name="decision" value="discard">Discard</button></div>` : ""}</form>`).join("")
      : `<p class="empty">Nothing waiting.</p>`
  }</div>
  ${canAct ? `<h2 style="margin-top:24px">Held leads</h2>
  <p class="muted small">Public-page submissions for an email that already has an account. Nothing was attached to that account; a person decides whether to call, merge or discard.</p>
  <div class="card flush">${table(["Received", "Email", "Company", "Name", "Answers", ""], leads.map((l) => `<tr><td class="small">${dateTime(l.createdAt ?? l.created_at)}</td><td class="mono small">${esc(l.email)}</td><td>${esc(l.company)}</td><td>${esc(l.name)}${l.phone_given ? ' <span class="small muted">(phone given)</span>' : ""}</td>
    <td class="small">${esc(words(l.answers?.jurisdiction ?? ""))} · ${esc(l.answers?.emirate ?? "")} · ${l.answers?.visas ?? 0} visa(s)${l.answers?.description ? `<br><span class="muted">${esc(l.answers.description.slice(0, 160))}</span>` : ""}</td>
    <td><form data-form="lead" data-id="${l.id}" class="row"><input name="note" placeholder="What was done" style="max-width:180px" /><button class="sm" type="submit">Handled</button></form></td></tr>`), "No held leads.")}</div>` : ""}`;
}

export async function renderSearch(q) {
  const r = await api("GET", `/api/ops/search?q=${encodeURIComponent(q)}`);
  const list = (title, rows, render) => `<div class="card flush"><h2 style="padding:16px 18px 0">${title}</h2>${table(["Name", "", ""], rows.map(render), "No matches.")}</div>`;
  $app.innerHTML = `<h1>Search: ${esc(q)}</h1><div class="grid cols-2">
    ${list("Clients", r.clients, (c) => `<tr><td>${esc(c.name)}</td><td class="mono small">${esc(c.id.slice(0, 8))}</td><td><a href="#/pipeline">pipeline</a></td></tr>`)}
    ${list("Partners", r.partners, (p) => `<tr><td>${esc(p.name)}</td><td>${badge(p.status ?? "prospect")}</td><td><a href="#/partners">partners</a></td></tr>`)}
    ${list("Engagements", r.engagements, (e) => `<tr><td>${esc(e.client)} · ${esc(e.emirate)}</td><td>${badge(e.status)}</td><td><a href="#/engagement/${e.id}">open</a></td></tr>`)}
    ${list("Offers", r.offers, (o) => `<tr><td>${esc(o.client)} · ${esc(o.tier)}</td><td>${badge(o.status)}</td><td><a href="#/offer/${o.id}">open</a></td></tr>`)}
  </div>`;
}

// People: organisations, users, data requests ------------------------------------------------

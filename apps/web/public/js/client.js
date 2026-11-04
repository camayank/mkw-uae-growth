// Tasees workspace: client module (split from app.js in O12; plain ES modules, no build step).
import { STRUCTURE_LABEL } from "./ops.js";
import { $app, aed, api, badge, date, deliverables, dropzone, esc, flag, isPlatform, journey, legalBlock, nameOf, obligationLabel, obligationTone, panel, role, table, translatePage, words } from "./core.js";

/** How an offer's tier reads to the client (U1). The priority tier is priced on the quickest partner quote, but the proposal's
 * estimate and the delivery plan come from the scope templates, so the screen makes no pace promise (gap 85). */
export const TIER_LABEL = { essential: "Essential", standard: "Standard", priority: "Priority" };
export const tierLabel = (t) => TIER_LABEL[t] ?? words(t);

// What each kind of next action asks the client to do, as a button.
const ACTION_BUTTON = { offer: "Review the offer", payment: "Pay now", change: "Review the change", approve: "Review and approve", documents: "Upload documents", filing: "Upload the confirmation" };
// On the engagement page these actions jump to their card instead of reloading the page.
const JUMP = { documents: "docs", change: "changes" };

/** The one thing Tasees needs from the client, pinned at the top of a screen; or, with nothing to do, what is happening. */
export function nextActionCard(actions, whatsNext, opts = {}) {
  if (!actions.length)
    return `<section class="nextaction calm" aria-labelledby="next-h"><p class="eyebrow">Your next action</p><h2 id="next-h">Nothing needed from you right now</h2><p>${esc(whatsNext ?? "")}</p></section>`;
  const [a, ...more] = actions;
  const evidence = opts.inline && a.kind === "approve" ? (opts.evidenceFor?.(a.ref) ?? []) : [];
  const button = a.kind === "payment" && /^https?:/.test(a.link) ? `<a class="btn primary gold" href="${esc(a.link)}">Pay by card</a>` : opts.inline && a.kind === "approve" ? "" : `<a class="btn primary gold" href="${esc(opts.inline && JUMP[a.kind] ? `#${JUMP[a.kind]}` : a.link)}"${opts.inline && JUMP[a.kind] ? ` data-act="jump" data-target="${JUMP[a.kind]}"` : ""}>${esc(ACTION_BUTTON[a.kind])}</a>`;
  const approve =
    opts.inline && a.kind === "approve"
      ? `${evidence.length ? `<p class="small">Evidence checked by MKW Advisors: ${evidence.map((x) => `<a href="/api/evidence/${x.id}/file" target="_blank" rel="noopener">${esc(x.fileName)}</a>`).join(" · ")}</p>` : ""}
         <div class="row"><button class="primary gold" data-act="ms-review" data-id="${esc(a.ref)}" data-approve="1" aria-describedby="next-h">Approve this step</button><button data-act="ms-review" data-id="${esc(a.ref)}" data-approve="0" aria-describedby="next-h">Raise an issue</button></div>`
      : "";
  const dueLabel = a.kind === "approve" ? `approved automatically on ${date(a.due)}` : a.kind === "offer" ? `valid until ${date(a.due)}` : `due ${date(a.due)}`;
  return `<section class="nextaction" aria-labelledby="next-h"><p class="eyebrow"><span>Your next action</span>${a.due ? ` · <span>${esc(dueLabel)}</span>` : ""}</p>
    <h2 id="next-h">${esc(a.title)}</h2><p>${esc(a.why)}</p>${a.detail ? `<p class="small">Note: <span data-no-i18n>${esc(a.detail)}</span></p>` : ""}${approve}${button ? `<div class="row">${button}</div>` : ""}
    ${more.length ? `<details class="more"><summary>${more.length} more thing${more.length > 1 ? "s" : ""} to do</summary><ul class="plain">${more.map((m) => `<li><a href="${esc(m.link)}">${esc(m.title)}</a>${m.due ? ` <span class="small muted">· ${date(m.due)}</span>` : ""}</li>`).join("")}</ul></details>` : ""}</section>`;
}

const progress = (done, total) =>
  `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="${done} of ${total} steps approved"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></div>`;

/**
 * E9: where the client's most advanced piece of work stands, from what the platform holds (no estimate, no invented
 * step): a live engagement first, else the newest open request. Advice is a step only when advice exists.
 */
export function clientJourney(h) {
  const live = h.engagements.filter((e) => !["completed", "cancelled"].includes(e.status));
  const e = live[0];
  if (e) {
    const paid = e.status !== "awaiting_payment";
    const working = ["in_delivery", "disputed"].includes(e.status);
    return [
      ["Request", "done"],
      ["Offer accepted", "done"],
      ["Deposit", paid ? "done" : "now", paid ? "" : "due now"],
      ["Partner assigned", working ? "done" : paid ? "now" : "todo", paid && !working ? "MKW Advisors is assigning" : ""],
      ["Delivery", working ? "now" : "todo", e.status === "disputed" ? "an issue is open" : working ? `${e.approved} of ${e.milestones} steps approved` : ""],
      ["Complete", "todo"],
    ];
  }
  const open = h.requests.filter((r) => r.status !== "closed");
  const r = open[0]; // the newest (the list comes newest first)
  if (!r) return h.engagements.some((x) => x.status === "completed") ? [["Request", "done"], ["Offer accepted", "done"], ["Deposit", "done"], ["Partner assigned", "done"], ["Delivery", "done"], ["Complete", "done"]] : null;
  const offers = h.offers.filter((o) => o.requestId === r.id && o.status !== "withdrawn");
  const published = offers.some((o) => o.status === "published");
  const accepted = offers.some((o) => o.status === "accepted");
  // "Being priced" only while MKW is pricing; an offer that lapsed is said as such (accepting it is refused).
  const pricing = !published && !accepted && (["draft", "scoped", "quoting"].includes(r.status) || offers.some((o) => ["draft", "ops_review"].includes(o.status)));
  const expired = !published && !accepted && !pricing && offers.some((o) => o.status === "expired");
  // Advice is a step only when there is advice to review ("none" is stored for a services request: no advice at all).
  const advice = r.adviceStatus === "pending_review" || r.adviceStatus === "approved";
  const adviceDone = r.adviceStatus === "approved";
  const steps = [
    ["Request", "done"],
    ...(advice ? [["Advice", adviceDone ? "done" : "now", adviceDone ? "" : "being checked by a person"]] : []),
    ["Offer", accepted ? "done" : advice && !adviceDone ? "todo" : "now", published ? "ready to review" : expired ? "expired: ask for a fresh offer" : pricing ? "being priced" : ""],
    ["Deposit", accepted ? "now" : "todo"],
    ["Delivery", "todo"],
    ["Complete", "todo"],
  ];
  return oneNow(steps);
}

/** One step is current: an offer can be published while advice is still being checked, so later "now"s wait. */
const oneNow = (steps) => {
  let seen = false;
  return steps.map(([n, st, what]) => (st === "now" ? (seen ? [n, "todo", what] : ((seen = true), [n, st, what])) : [n, st, what]));
};

export async function renderClientHome() {
  // The statement and the calendar are the client's own too; a failure in either leaves the overview standing.
  const [h, st, cal] = await Promise.all([api("GET", "/api/client/home"), api("GET", "/api/client/statement").catch(() => null), api("GET", "/api/client/compliance").catch(() => [])]);
  const offersByRequest = new Map();
  for (const o of h.offers) offersByRequest.set(o.requestId, [...(offersByRequest.get(o.requestId) ?? []), o]);
  const open = h.requests.filter((r) => r.status !== "closed");
  // Advice reaches the client only once a person at MKW has reviewed it; until then it says so.
  const advised = h.requests.filter((r) => r.adviceStatus === "approved" || r.adviceStatus === "pending_review");
  const live = h.engagements.filter((e) => e.status !== "completed");
  const done = h.engagements.filter((e) => e.status === "completed");
  const engagementCard = (e) => `<a class="card link-card" href="#/engagement/${e.id}">
      <div class="row between"><b>${flag(e.emirate)}${esc(e.emirate)} engagement</b>${badge(e.status)}</div>
      ${progress(e.approved, e.milestones)}
      <div class="small muted">${e.approved} of ${e.milestones} steps approved · started ${date(e.createdAt)}${e.toReview ? ` · <b>${e.toReview} to approve</b>` : ""}</div></a>`;
  const requestCard = (r) => {
    const offers = (offersByRequest.get(r.id) ?? []).filter((o) => o.status !== "withdrawn");
    const what = (r.scope?.lines ?? []).map((l) => `${nameOf(l.code)}${l.qty > 1 ? ` ×${l.qty}` : ""}`).join(", ");
    return `<div class="card"><div class="row between"><b>Request of ${date(r.createdAt)}</b>${badge(r.status)}</div>
      <p class="small">${esc(what)}</p>
      ${offers.length ? `<div class="row">${offers.map((o) => `<a class="btn sm${o.status === "published" ? " primary" : ""}" href="#/offer/${o.id}">${esc(tierLabel(o.tier))} · ${aed(o.clientTotal)}</a>`).join("")}${offers.some((o) => o.status === "published") ? `<span class="small muted">valid until ${date(offers.find((o) => o.status === "published").validTo)}</span>` : ""}</div>` : `<p class="small muted">Being priced: partner firms quote sealed prices and MKW Advisors checks them.</p>`}
      ${r.adviceStatus === "approved" ? `<p class="small"><a href="#/request/${r.id}">Our advice on structure and place</a></p>` : r.adviceStatus === "pending_review" ? `<p class="small muted">Advice on structure and place: being checked by a person</p>` : ""}</div>`;
  };
  // Money, from the statement the client already reads; the next dates, from the compliance calendar.
  const moneyCard = st
    ? `<section class="card money panel-dark" aria-labelledby="money-h"><h2 id="money-h">Money</h2>
      <dl><dt>Paid to date</dt><dd class="num">${aed(st.totals.paid)}</dd><dt>Invoiced, net of credit notes</dt><dd class="num">${aed(st.totals.invoiced)}</dd><dt class="total">Due now</dt><dd class="num total">${aed(st.totals.due)}</dd></dl>
      <p class="small muted">Government fees are passed on at cost; a tax invoice is issued for every payment.</p><p class="small"><a href="#/statement">Statement and invoices</a></p></section>`
    : "";
  const upcoming = cal.filter((o) => !["met", "waived"].includes(o.status)).slice(0, 3);
  const calendarCard = upcoming.length
    ? `<h2 class="section">Compliance calendar</h2><div class="card flush">${table(
        ["Due", "Obligation", "Status"],
        upcoming.map((o) => `<tr><td><b>${date(o.dueDate)}</b></td><td>${esc(o.title)}${o.confidence !== "confirmed" ? ` ${badge("UNCERTAIN")}` : ""}</td><td>${badge(obligationTone(o), obligationLabel(o))}</td></tr>`),
      )}<p class="small muted pad" style="padding-top:8px">Dates confirmed by a person at MKW Advisors; nothing is filed for you unless it is part of an offer. <a href="#/compliance">Full calendar</a></p></div>`
    : "";
  $app.innerHTML = `
  <div class="row between"><h1>Your company with Tasees</h1><a class="btn" href="#/new">Start a new request</a></div>
  ${(() => { const j = clientJourney(h); return j ? journey(j, "Where your work stands") : ""; })()}
  ${nextActionCard(h.nextActions, h.whatsNext)}
  <div class="grid cols-2">
    ${live.length ? live.map(engagementCard).join("") : `<section class="card" aria-labelledby="eng-h"><h2 id="eng-h">Engagements</h2><p class="muted">No engagement in progress. Accept an offer to start one.</p></section>`}
    ${moneyCard}
  </div>
  ${done.length ? `<details class="more"><summary>${done.length} completed engagement${done.length > 1 ? "s" : ""}</summary><div class="grid cols-2" style="margin-top:12px">${done.map(engagementCard).join("")}</div></details>` : ""}
  <h2 class="section">Requests and offers</h2>
  ${open.length ? `<div class="grid cols-2">${open.map(requestCard).join("")}</div>` : `<p class="muted">No open requests. <a href="#/new">Tell us what you need</a> and we come back with offers.</p>`}
  ${
    advised.length
      ? `<h2 class="section">Advice on structure and place</h2><div class="card flush">${table(
          ["Request", "Structure", "Status", ""],
          advised.map(
            (r) => `<tr><td>${date(r.createdAt)} · ${esc((r.scope?.lines ?? []).map((l) => nameOf(l.code)).join(", "))}</td><td>${r.advice ? esc(STRUCTURE_LABEL[r.advice.structure.recommendation] ?? "to be confirmed") : "–"}</td>
              <td>${r.adviceStatus === "approved" ? badge("ok", "reviewed by MKW Advisors") : badge("pending", "being checked by a person")}</td><td>${r.adviceStatus === "approved" ? `<a href="#/request/${r.id}">Read</a>` : ""}</td></tr>`,
          ),
        )}</div>`
      : ""
  }
  ${calendarCard}`;
}

export async function renderClientOffer(id) {
  const o = await api("GET", `/api/client/offers/${id}`);
  const h = await api("GET", "/api/client/home");
  const p = o.proposal;
  const terms = o.status === "published" && role() === "client_owner" ? await api("GET", "/api/legal/client_terms") : null;
  const siblings = h.offers.filter((x) => x.requestId === o.requestId && ["published", "accepted"].includes(x.status));
  // E18: every government fee with where its figure came from, as recorded when the offer was priced.
  const fees = p.feeDisclosures ?? [];
  const estimates = fees.filter((f) => !f.confirmed);
  const guaranteePct = (p.guaranteeBp ?? 1000) / 100;
  $app.innerHTML = `
  <p><a href="#/">← Overview</a></p>
  <div class="row between"><h1>Your offer</h1>${badge(o.status)}</div>
  <p class="lead">A proposal from MKW Advisors for ${esc(o.lines.map((l) => l.name).join(", "))}. Vetted partner firms do the work; MKW Advisors manages the scope, the price, the quality and the payments.</p>
  ${
    siblings.length > 1
      ? `<section class="card" aria-labelledby="pick-h"><div class="row between"><h2 id="pick-h">One offer, with ${siblings.length === 2 ? "another option" : "other options"}</h2><span class="small muted">The same scope and the same partner standard either way; the price and the partner firm differ.</span></div>
          <nav class="tiers" aria-label="Choose an option">${siblings
            .map((s) =>
              s.id === o.id
                ? `<div class="tier best" aria-current="page"><span class="row between"><b>${esc(tierLabel(s.tier))}</b>${badge("ok", "selected")}</span><span class="price">${aed(s.clientTotal)}</span>${s.tier === o.tier ? `<span class="small muted">about ${p.estimateWorkingDays} working days</span>` : ""}</div>`
                : `<a class="tier" href="#/offer/${s.id}"><span class="row between"><b>${esc(tierLabel(s.tier))}</b></span><span class="price">${aed(s.clientTotal)}</span><span class="switch small">Switch to ${esc(tierLabel(s.tier))}</span></a>`,
            )
            .join("")}</nav></section>`
      : ""
  }
  <div class="proposal">
    <section class="card"><h2>What we will do</h2>
      <ul class="plain checklist-static">${o.lines.map((l) => `<li><b>${esc(l.name)}</b>${l.qty > 1 ? ` ×${l.qty}` : ""}${l.model === "agent" ? `<br><span class="small muted">Billed by the licensed firm; MKW fee shown separately</span>` : ""}</li>`).join("")}</ul></section>
    <section class="card"><h2>How it will run</h2>
      <p>About <b>${p.estimateWorkingDays} working days</b> once work starts, with the services running side by side. Every step is checked by MKW Advisors before it comes to you.</p>
      ${p.plan.map((l) => `<h3>${esc(l.name)}${l.recurring ? ` <span class="small muted">(recurring: not counted in the estimate)</span>` : ""}</h3><ol class="steps">${l.steps.map((s) => `<li><span>${esc(s.name)}</span><span class="small muted">by working day ${s.afterWorkingDays}</span></li>`).join("")}</ol>`).join("")}</section>
    <section class="card"><h2>What it costs</h2>
      <table>
        <tr><td>Professional fees</td><td class="num">${aed(o.professional)}</td></tr>
        ${o.mkwFees ? `<tr><td>MKW coordination fees</td><td class="num">${aed(o.mkwFees)}</td></tr>` : ""}
        <tr><td>VAT at 5%</td><td class="num">${aed(o.vat)}</td></tr>
        <tr><td>Government fees, at cost${estimates.length ? ` ${badge("UNCERTAIN", "estimate")}` : ""}</td><td class="num">${aed(o.government)}</td></tr>
        <tfoot><tr><td>Total</td><td class="num">${aed(o.clientTotal)}</td></tr></tfoot>
      </table>
      ${fees.length ? `<ul class="small notes" data-fee-disclosures>${fees.map((f) => `<li data-fee="${esc(f.code)}"><b>${esc(o.lines.find((l) => l.code === f.code)?.name ?? f.code)}</b> ${badge(f.confirmed ? "verified" : "UNCERTAIN", f.label)} ${esc(f.text)}</li>`).join("")}</ul>` : ""}
      <div class="paysplit"><div><span class="small muted">On acceptance</span><b>${aed(p.depositFils)}</b><span class="small muted">half the fees and VAT, plus the government fees</span></div>
        <div><span class="small muted">When every step is approved</span><b>${aed(p.balanceFils)}</b><span class="small muted">the balance, with your tax invoice</span></div></div>
      <p><a class="btn sm" href="/api/client/offers/${o.id}/pdf" target="_blank" rel="noopener" data-offer-pdf>Download the offer (PDF)</a></p></section>
    <section class="card"><h2>Our guarantee</h2>
      <p>If a step is still not delivered five working days after its due date, a credit of ${guaranteePct}% of that step's share of the professional fee is raised for you automatically. MKW Advisors' finance team confirms it; a delay caused by something only you can provide, such as a missing document, may not qualify.</p></section>
    <section class="card"><h2>Before you accept</h2>
      <ul class="rules">
        <li>This offer is valid until <b>${date(o.validTo)}</b>.</li>
        <li>Each step comes to you once MKW Advisors has checked it. You approve it or raise an issue; if you do nothing for ${p.reviewWorkingDays} working days, it is approved automatically.</li>
        <li>We do not file returns or notifications with the authorities for you unless that service is part of this offer.</li>
        ${estimates.length ? `<li>${estimates.length === 1 ? "One government fee is an estimate" : `${estimates.length} government fees are estimates`} (marked above): the authority's actual fee may differ, and you pay it at cost.</li>` : ""}
      </ul>
      ${
        o.status === "published"
          ? role() === "client_owner"
            ? `${
                terms?.version
                  ? `${legalBlock(terms, "Tasees client terms")}
                     <label class="small accept-terms"><input type="checkbox" data-terms-version="${esc(terms.version)}" /> I have read and accept the Tasees client terms, version ${esc(terms.version)}${terms.draft ? " (draft, pending legal review)" : ""}</label>`
                  : ""
              }<button class="primary gold big" data-act="accept-offer" data-id="${o.id}">Accept this offer · ${aed(o.clientTotal)}</button>`
            : `<p class="notice small">Only the account owner can accept an offer.</p>`
          : `<p class="small muted">This offer is ${esc(words(o.status))}.</p>`
      }</section>
  </div>`;
}

// New request: a short conversation for clients, the full form for MKW staff ----------------------------------------

const EMIRATES = ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Umm Al Quwain", "Fujairah"];
const ACTIVITIES = [
  ["consulting", "Consulting or professional services (incl. accounting and bookkeeping)"],
  ["trading", "Trading goods"],
  ["ecommerce", "Selling online"],
  ["tech", "Software or technology"],
  ["holding", "Holding company"],
  ["finance", "Regulated financial services (banking, lending, investment, insurance, payments)"],
  ["virtual_assets", "Virtual assets or crypto"],
  ["health", "Health or medical"],
  ["education", "Education or training"],
  ["food", "Food and restaurants"],
  ["construction", "Construction or real estate"],
  ["manufacturing", "Manufacturing"],
  ["other", "Something else"],
];

/** The intake answers in the shape the API takes, from the form as it stands (also used for the live preview). */
export function intakeAnswers(fd) {
  const mode = String(fd.get("mode") || "new_company");
  const extras = fd.getAll("extra").map(String);
  return {
    mode,
    emirate: String(fd.get("emirate") || "Dubai"),
    ...(mode === "new_company"
      ? {
          jurisdiction: String(fd.get("jurisdiction") || "not_sure"),
          freeZone: String(fd.get("freeZone") || "") || null,
          visas: Number(fd.get("visas") || 0),
          dependants: Number(fd.get("dependants") || 0),
          addOns: extras,
          ...(fd.get("activity") ? { activity: String(fd.get("activity")) } : {}),
          ...(fd.get("customers") ? { customers: String(fd.get("customers")) } : {}),
          ...(fd.get("officeNeeded") ? { officeNeeded: fd.get("officeNeeded") === "yes" } : {}),
          ...(fd.get("budgetAed") ? { budgetAed: Number(fd.get("budgetAed")) } : {}),
          ...(fd.get("expectedTurnoverAed") ? { expectedTurnoverAed: Number(fd.get("expectedTurnoverAed")) } : {}),
        }
      : { services: extras }),
    ...(String(fd.get("description") || "").trim() ? { description: String(fd.get("description")).trim() } : {}),
  };
}

// The conversation's questions, in order; each is shown on its own. Services-only requests skip the company questions.
const INTAKE_STEPS = ["start", "business", "where", "people", "extras", "review"];
const stepsFor = (mode) => (mode === "services" ? ["start", "where", "extras", "review"] : INTAKE_STEPS);
let intakeStep = 0;

export async function renderIntake() {
  const list = await deliverables();
  const setup = new Set(["SET-FZ-LIC", "SET-ML-LIC", "SET-OFF", "VISA-RES", "VISA-FAM"]);
  const extras = list.filter((d) => !setup.has(d.code));
  if (isPlatform()) return renderIntakeForm(extras);
  intakeStep = 0;
  const radio = (name, value, label, checked = false) => `<label class="choice"><input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""} /> <span>${esc(label)}</span></label>`;
  $app.innerHTML = `
  <h1>What do you need?</h1>
  <p class="muted">A few questions, one at a time. Your plan builds as you answer; nothing is sent until you ask for your offers.</p>
  <form class="card" data-form="from-assessment" style="margin-bottom:16px"><h2>Already answered on our public page?</h2>
    <p class="small muted">Enter the code of your saved result and we start the request from those answers; nothing to type again. MKW Advisors checks them against today's rules before anything is priced.</p>
    <div class="row"><label class="small" for="saved-code">Saved result code</label><input id="saved-code" name="code" maxlength="10" autocapitalize="characters" placeholder="ABCDE23456" style="max-width:160px" /><button class="sm" type="submit">Start from my saved result</button></div></form>
  <div class="intake-convo">
    <form class="card convo" data-form="intake" novalidate>
      <fieldset class="q" data-step="start"><legend tabindex="-1">Where are you starting from?</legend>
        <div class="choices one">${radio("mode", "new_company", "Set up a new company in the UAE", true)}${radio("mode", "services", "Services for a company I already have")}</div></fieldset>
      <fieldset class="q" data-step="business" hidden><legend tabindex="-1">Tell us about the business</legend>
        <div class="field"><label for="i-activity">What will the company do?</label><select id="i-activity" name="activity"><option value="">Choose</option>${ACTIVITIES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></div>
        <div class="field"><label for="i-customers">Who are your customers?</label><select id="i-customers" name="customers"><option value="">Not sure yet</option><option value="international">Mostly outside the UAE</option><option value="uae_mainland">Inside the UAE</option><option value="both">Both</option></select></div>
        <div class="field"><label for="i-description">In your own words (optional)</label><textarea id="i-description" name="description" maxlength="2000" placeholder="e.g. Three partners starting a software company; we need two visas and a bank account"></textarea></div></fieldset>
      <fieldset class="q" data-step="where" hidden><legend tabindex="-1">Where will it be?</legend>
        <div class="grid cols-2">
          <div class="field"><label for="i-emirate">Emirate</label><select id="i-emirate" name="emirate">${EMIRATES.map((e) => `<option>${e}</option>`).join("")}</select></div>
          <div class="field" data-company><label for="i-jurisdiction">Licence type</label><select id="i-jurisdiction" name="jurisdiction"><option value="not_sure">Not sure yet; advise me</option><option value="free_zone">Free zone</option><option value="mainland">Mainland</option><option value="offshore">Offshore</option><option value="difc_adgm">DIFC or ADGM</option></select></div>
          <div class="field" data-company><label for="i-freezone">Free zone, if you know it</label><input id="i-freezone" name="freeZone" placeholder="e.g. IFZA, Meydan, RAKEZ" /></div>
          <div class="field" data-company><label for="i-office">A physical office, shop or site?</label><select id="i-office" name="officeNeeded"><option value="">Not sure</option><option value="no">No</option><option value="yes">Yes</option></select></div>
        </div></fieldset>
      <fieldset class="q" data-step="people" hidden><legend tabindex="-1">Who needs a visa?</legend>
        <div class="grid cols-2">
          <div class="field"><label for="i-visas">Residence visas (you and staff)</label><input id="i-visas" name="visas" type="number" min="0" max="50" value="1" /></div>
          <div class="field"><label for="i-dependants">Family visas</label><input id="i-dependants" name="dependants" type="number" min="0" max="20" value="0" /></div>
        </div></fieldset>
      <fieldset class="q" data-step="extras" hidden><legend tabindex="-1">Anything else?</legend>
        <p class="small muted" data-services-hint hidden>Choose at least one service.</p>
        <div class="choices">${extras.map((d) => `<label><input type="checkbox" name="extra" value="${d.code}" /> ${esc(d.name)}</label>`).join("")}</div>
        <div class="grid cols-2" data-company style="margin-top:12px">
          <div class="field"><label for="i-budget">Setup budget, AED (optional)</label><input id="i-budget" name="budgetAed" type="number" min="0" /></div>
          <div class="field"><label for="i-turnover">Expected yearly sales, AED (optional)</label><input id="i-turnover" name="expectedTurnoverAed" type="number" min="0" /></div>
        </div></fieldset>
      <fieldset class="q" data-step="review" hidden><legend tabindex="-1">Ready for your offers?</legend>
        <p>We turn your answers into a scope, collect sealed prices from vetted partner firms and send you up to three offers. Where a rule is not certain for your case, we say so and a person checks it.</p>
        <dl class="answers" id="intake-summary"></dl></fieldset>
      <p class="field-msg" id="intake-msg" role="alert"></p>
      <div class="row between convo-nav">
        <button type="button" data-act="intake-back" hidden>Back</button>
        <span class="small muted" id="intake-count" aria-live="polite"></span>
        <button type="button" class="primary" data-act="intake-next">Next</button>
        <button type="submit" class="primary" data-intake-submit hidden>Get my offers</button>
      </div>
    </form>
    <aside class="card plan" aria-labelledby="plan-h"><h2 id="plan-h">Your plan so far</h2><p class="small muted" id="intake-plan-status" role="status"></p><div id="intake-plan"><p class="small muted">Your services appear here as you answer.</p></div></aside>
  </div>`;
  intakeGo(0);
}

/** Move the conversation by `delta` questions, after checking the current one; then refresh the plan. */
export function intakeGo(delta) {
  const form = document.querySelector('form[data-form="intake"]');
  if (!form) return;
  const fd = new FormData(form);
  const mode = String(fd.get("mode") || "new_company");
  const steps = stepsFor(mode);
  const msg = document.getElementById("intake-msg");
  msg.textContent = "";
  if (delta > 0 && steps[intakeStep] === "extras" && mode === "services" && !fd.getAll("extra").length) {
    msg.textContent = "Choose at least one service to continue.";
    return;
  }
  intakeStep = Math.max(0, Math.min(steps.length - 1, intakeStep + delta));
  const current = steps[intakeStep];
  for (const q of form.querySelectorAll("fieldset.q")) q.hidden = q.dataset.step !== current;
  for (const el of form.querySelectorAll("[data-company]")) el.hidden = mode === "services";
  form.querySelector("[data-services-hint]").hidden = mode !== "services";
  form.querySelector('[data-act="intake-back"]').hidden = intakeStep === 0;
  form.querySelector('[data-act="intake-next"]').hidden = current === "review";
  form.querySelector("[data-intake-submit]").hidden = current !== "review";
  document.getElementById("intake-count").textContent = `Question ${intakeStep + 1} of ${steps.length}`;
  if (current === "review") document.getElementById("intake-summary").innerHTML = intakeSummary(fd, mode);
  if (delta !== 0) form.querySelector(`fieldset[data-step="${current}"] legend`)?.focus();
  refreshPlan(form);
}

function intakeSummary(fd, mode) {
  const label = (sel, v) => document.querySelector(`${sel} option[value="${CSS.escape(v)}"]`)?.textContent ?? v;
  const rows = [["Starting point", mode === "services" ? "Services for a company I already have" : "Set up a new company"]];
  if (mode === "new_company") {
    if (fd.get("activity")) rows.push(["The business", label("#i-activity", String(fd.get("activity")))]);
    rows.push(["Licence type", label("#i-jurisdiction", String(fd.get("jurisdiction")))]);
    rows.push(["Visas", `${fd.get("visas") || 0} residence, ${fd.get("dependants") || 0} family`]);
  }
  rows.push(["Emirate", String(fd.get("emirate"))]);
  const extras = fd.getAll("extra").map(String);
  if (extras.length) rows.push(["Also", extras.map(nameOf).join(", ")]);
  return rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
}

let planTimer = 0;
let planSeq = 0;
function refreshPlan(form) {
  clearTimeout(planTimer);
  planTimer = setTimeout(async () => {
    const seq = ++planSeq;
    const box = document.getElementById("intake-plan");
    if (!box) return;
    try {
      const p = await api("POST", "/api/requests/preview", { answers: intakeAnswers(new FormData(form)) });
      if (seq !== planSeq) return;
      // Screen readers hear a one-line summary, not the whole panel again.
      const status = document.getElementById("intake-plan-status");
      if (status) status.textContent = `${p.lines.length} service${p.lines.length === 1 ? "" : "s"} in your plan`;
      box.innerHTML = `${p.lines.length ? `<ul class="plain planlist">${p.lines.map((l) => `<li><span>${esc(l.name)}</span>${l.qty > 1 ? `<span class="small muted">×${l.qty}</span>` : ""}</li>`).join("")}</ul>` : `<p class="small muted">No services yet.</p>`}
        ${p.notes.map((n) => `<p class="small notice">${esc(n)}</p>`).join("")}
        ${p.adviceFollows ? `<p class="small muted">Structure and place: MKW Advisors advises on them once a person has checked your answers. ${badge("UNCERTAIN", "we will verify this")}</p>` : ""}
        <p class="small muted">Prices come in your offers: partner firms quote sealed prices and MKW Advisors checks every line.</p>`;
      translatePage();
    } catch {
      /* the plan is a help, not a step: a failed preview leaves the last one in place */
    }
  }, 250);
}

/** The full form, for MKW staff entering a request for a client. */
function renderIntakeForm(extras) {
  return api("GET", "/api/ops/clients").then((clients) => {
    $app.innerHTML = `
  <h1>New request for a client</h1>
  <form class="card" data-form="intake" style="max-width:820px">
    <div class="field"><label>Client</label><select name="clientOrgId" required>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
    <details class="field"><summary class="small">Add a new client</summary><div class="grid cols-3" style="margin-top:8px">
      <input name="newCompany" placeholder="Company name" /><input name="newOwner" placeholder="Owner name" /><input name="newEmail" type="email" placeholder="Owner email" /></div>
      <button type="button" class="sm" data-act="add-client" style="margin-top:8px">Add client</button></details>
    <fieldset><legend>Starting point</legend>
      <div class="choices">
        <label><input type="radio" name="mode" value="new_company" checked /> Set up a new company</label>
        <label><input type="radio" name="mode" value="services" /> Services for a company the client already has</label>
      </div>
    </fieldset>
    <div class="grid cols-3">
      <div class="field"><label>Emirate</label><select name="emirate">${EMIRATES.map((e) => `<option>${e}</option>`).join("")}</select></div>
      <div class="field"><label>Licence type</label><select name="jurisdiction">
        <option value="not_sure">Not sure yet</option><option value="free_zone">Free zone</option><option value="mainland">Mainland</option>
        <option value="offshore">Offshore</option><option value="difc_adgm">DIFC or ADGM</option></select></div>
      <div class="field"><label>Free zone, if known</label><input name="freeZone" placeholder="e.g. IFZA, Meydan, RAKEZ" /></div>
      <div class="field"><label>Residence visas</label><input name="visas" type="number" min="0" max="50" value="1" /></div>
      <div class="field"><label>Family visas</label><input name="dependants" type="number" min="0" max="20" value="0" /></div>
    </div>
    <fieldset data-scoping><legend>About the business (for advice on structure and place)</legend>
      <div class="grid cols-3">
        <div class="field"><label>Main activity</label><select name="activity"><option value="">Choose</option>${ACTIVITIES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></div>
        <div class="field"><label>Customers</label><select name="customers"><option value="">Choose</option><option value="international">Outside the UAE</option><option value="uae_mainland">Inside the UAE (mainland)</option><option value="both">Both</option></select></div>
        <div class="field"><label>Physical office, shop or site?</label><select name="officeNeeded"><option value="">Not sure</option><option value="no">No</option><option value="yes">Yes</option></select></div>
        <div class="field"><label>Setup budget, AED (optional)</label><input name="budgetAed" type="number" min="0" /></div>
        <div class="field"><label>Expected yearly sales, AED (optional)</label><input name="expectedTurnoverAed" type="number" min="0" /></div>
      </div>
      <div class="field"><label>Description (optional)</label><textarea name="description" maxlength="2000"></textarea></div>
    </fieldset>
    <fieldset><legend>Add services</legend><div class="choices">
      ${extras.map((d) => `<label><input type="checkbox" name="extra" value="${d.code}" /> ${esc(d.name)}</label>`).join("")}
    </div></fieldset>
    <button class="primary" type="submit">Create the request</button>
  </form>`;
  });
}

export async function renderStatement() {
  const st = await api("GET", "/api/client/statement");
  $app.innerHTML = `<h1>Statement of account</h1>
  <div class="kpis">
    <div class="kpi"><b>${aed(st.totals.paid)}</b><span>Paid to date</span></div>
    <div class="kpi"><b>${aed(st.totals.due)}</b><span>Due now</span></div>
    <div class="kpi"><b>${aed(st.totals.invoiced)}</b><span>Invoiced (net of credit notes)</span></div>
  </div>
  <div class="grid cols-2">
    <div class="card flush"><h2>Payments</h2>${table(
      ["Engagement", "What", "#Amount", "Status", ""],
      st.payments.map((p) => `<tr><td><a href="#/engagement/${p.engagementId}">${esc(p.engagementId.slice(0, 8).toUpperCase())}</a></td><td>${esc(words(p.kind))}</td><td class="num">${aed(p.amount)}</td>
        <td>${badge(p.status)}${p.paidAt ? `<br><span class="small muted">${date(p.paidAt)}</span>` : ""}</td><td>${p.status === "pending" && p.payUrl ? `<a class="btn sm primary" href="${esc(p.payUrl)}">Pay by card</a>` : ""}</td></tr>`),
      "No payments yet.",
    )}</div>
    <div class="card flush"><h2>Tax invoices and credit notes</h2>${table(
      ["Number", "Issued", "#Net", "#VAT", "#Govt fees", "#Total", ""],
      st.invoices.map((i) => `<tr><td class="mono small">${esc(i.number)}</td><td>${date(i.issuedAt)}</td><td class="num">${aed(i.net)}</td><td class="num">${aed(i.vat)}</td><td class="num">${aed(i.disbursements)}</td><td class="num">${aed(i.gross)}</td><td><a href="/api/invoices/${i.id}/pdf" target="_blank" rel="noopener">PDF</a></td></tr>`),
      "Invoices appear here once a payment is received.",
    )}</div>
  </div>
  <p class="small muted" style="margin-top:12px">Invoices are issued by MKW Advisors. Government fees are passed through at cost and shown as disbursements.</p>`;
}

/** The target of a card payment link while no card provider is connected. Honest about what it is. */
export function renderPayPage(paymentId) {
  $app.innerHTML = `<div class="signin"><div class="card"><h1>Pay by card</h1>
    <p class="muted">Card payments switch on once MKW Advisors connects its payment provider. Until then, please pay by bank transfer to MKW Advisors and quote the reference shown on your engagement page; finance records it the same day and your tax invoice follows.</p>
    <p class="small muted mono">Payment ${esc(paymentId.slice(0, 8))}</p>
    <a class="btn" href="#/">Back to your overview</a></div></div>`;
}

export async function renderClientCompliance() {
  const list = await api("GET", "/api/client/compliance");
  const live = list.filter((o) => !["met", "waived"].includes(o.status));
  $app.innerHTML = `<h1>Your compliance calendar</h1>
  <p class="muted">The recurring obligations that follow from what we set up for you: renewals, returns, registers. We remind you 30 and 7 days ahead. An obligation counts as met when your filing confirmation is uploaded and we have checked it. Dates marked ${badge("UNCERTAIN")} are our estimates until a person confirms them; we do not file on your behalf unless you ask for it as a service.</p>
  <div class="card flush">${table(
    ["Due", "Obligation", "Status", "Evidence", ""],
    list.map((o) => `<tr><td><b>${date(o.dueDate)}</b>${o.periodLabel ? `<br><span class="small muted">${esc(o.periodLabel)}</span>` : ""}</td><td>${esc(o.title)}${o.confidence !== "confirmed" ? ` ${badge("UNCERTAIN")}` : ""}<br><span class="small muted">${esc(words(o.kind))}${o.recurrence !== "none" ? ` · ${esc(o.recurrence)}` : ""}</span>${o.basis ? `<br><span class="small muted">${esc(o.basis)}</span>` : ""}</td>
      <td>${badge(obligationTone(o), obligationLabel(o))}${o.metAt ? `<br><span class="small muted">${date(o.metAt)}</span>` : ""}</td>
      <td class="small">${o.evidenceName ? `<a href="/api/obligations/${o.id}/file" target="_blank" rel="noopener">${esc(o.evidenceName)}</a>` : "–"}</td>
      <td>${o.kind === "licence_renewal" && o.status === "open" ? (o.renewalRequestId ? `<p class="small">${o.renewalEngagementId ? `Renewal in progress ${badge(o.renewalEngagementStatus)} <a href="#/engagement/${o.renewalEngagementId}">follow it</a>` : `Renewal requested ${badge(o.renewalRequestStatus)}: your offers appear on the <a href="#/">overview</a>`}</p>` : `<button class="sm primary" data-act="renewal-request" data-id="${o.id}">Ask for a renewal offer</button>`) : ""}${["open", "evidence_uploaded"].includes(o.status) ? `<form data-form="obligation-evidence" data-id="${o.id}">${dropzone("filing confirmation", "Drop the filing confirmation here, or choose it")}<button class="sm primary" type="submit">Upload filing confirmation</button></form>` : ""}</td></tr>`),
    "Nothing on your calendar yet. Obligations appear when an engagement completes and MKW Advisors confirms the dates.",
  )}</div>
  <p class="small muted">${live.length} open · ${list.length - live.length} done</p>`;
}

// Tasees workspace: client module (split from app.js in O12; plain ES modules, no build step).
import { $app, act, aed, api, badge, date, deliverables, esc, isPlatform, legalBlock, nameOf, obligationLabel, obligationTone, role, table, words } from "./core.js";
import { STRUCTURE_LABEL } from "./ops.js";

export async function renderClientHome() {
  const h = await api("GET", "/api/client/home");
  const offersByRequest = new Map();
  for (const o of h.offers) offersByRequest.set(o.requestId, [...(offersByRequest.get(o.requestId) ?? []), o]);
  const open = h.requests.filter((r) => r.status !== "closed");
  $app.innerHTML = `
  <div class="row between"><h1>Your company with Tasees</h1><a class="btn primary" href="#/new">Start a new request</a></div>
  <div class="kpis">
    <div class="kpi"><b>${h.engagements.filter((e) => e.status !== "completed").length}</b><span>Engagements in progress</span></div>
    <div class="kpi"><b>${h.engagements.reduce((s, e) => s + e.toReview, 0)}</b><span>Steps waiting for your approval</span></div>
    <div class="kpi"><b>${h.offers.filter((o) => o.status === "published").length}</b><span>Offers to review</span></div>
  </div>
  <div class="grid cols-2">
    <div class="card flush"><h2>Engagements</h2>
      ${table(
        ["Started", "Emirate", "Progress", "Status", ""],
        h.engagements.map(
          (e) => `<tr><td>${date(e.createdAt)}</td><td>${esc(e.emirate)}</td><td>${e.approved} of ${e.milestones} steps</td>
            <td>${badge(e.status)}${e.toReview ? ` ${badge("qa_passed", `${e.toReview} to approve`)}` : ""}</td>
            <td><a href="#/engagement/${e.id}">Open</a></td></tr>`,
        ),
        "No engagements yet. Accept an offer to start one.",
      )}
    </div>
    <div class="card flush"><h2>Requests and offers</h2>
      ${table(
        ["Requested", "What", "Status", "Offers"],
        open.map((r) => {
          const offers = (offersByRequest.get(r.id) ?? []).filter((o) => o.status !== "withdrawn");
          return `<tr><td>${date(r.createdAt)}</td><td>${esc((r.scope?.lines ?? []).map((l) => `${nameOf(l.code)}${l.qty > 1 ? ` ×${l.qty}` : ""}`).join(", "))}${
            r.adviceStatus === "approved" ? `<br><a href="#/request/${r.id}">Our advice on structure and place</a>` : r.adviceStatus === "pending_review" ? `<br><span class="small muted">Advice being checked by a person</span>` : ""
          }</td>
            <td>${badge(r.status)}</td>
            <td>${offers.length ? offers.map((o) => `<a href="#/offer/${o.id}">${esc(o.tier)} · ${aed(o.clientTotal)}</a>`).join("<br>") : `<span class="muted small">Being priced</span>`}</td></tr>`;
        }),
        "No open requests.",
      )}
    </div>
  </div>
  ${
    h.requests.some((r) => r.adviceStatus === "approved" || r.adviceStatus === "pending_review")
      ? `<div class="card flush" style="margin-top:16px"><h2>Advice on structure and place</h2>${table(
          ["Request", "Structure", "Status", ""],
          h.requests
            .filter((r) => r.adviceStatus === "approved" || r.adviceStatus === "pending_review")
            .map((r) => `<tr><td>${date(r.createdAt)} · ${esc((r.scope?.lines ?? []).map((l) => nameOf(l.code)).join(", "))}</td><td>${r.advice ? esc(STRUCTURE_LABEL[r.advice.structure.recommendation] ?? "to be confirmed") : "–"}</td>
              <td>${r.adviceStatus === "approved" ? badge("ok", "reviewed by MKW Advisors") : badge("pending", "being checked by a person")}</td><td>${r.adviceStatus === "approved" ? `<a href="#/request/${r.id}">Read</a>` : ""}</td></tr>`),
        )}</div>`
      : ""
  }`;
}

export async function renderClientOffer(id) {
  const o = await api("GET", `/api/client/offers/${id}`);
  const h = await api("GET", "/api/client/home");
  const terms = o.status === "published" && role() === "client_owner" ? await api("GET", "/api/legal/client_terms") : null;
  const siblings = h.offers.filter((x) => x.requestId === o.requestId && ["published", "accepted"].includes(x.status));
  const deposit = Math.round(((o.professional ?? 0) + (o.mkwFees ?? 0) + (o.vat ?? 0)) / 2) + (o.government ?? 0);
  $app.innerHTML = `
  <p><a href="#/">← Overview</a></p>
  <h1>Your offer</h1>
  ${
    siblings.length > 1
      ? `<div class="tiers">${siblings
          .map(
            (s) => `<a class="tier ${s.id === o.id ? "best" : ""}" href="#/offer/${s.id}" style="text-decoration:none;color:inherit">
              <div class="row between"><b style="text-transform:capitalize">${esc(s.tier)}</b>${badge(s.status)}</div>
              <div class="price">${aed(s.clientTotal)}</div>
              <div class="small muted">${s.tier === "essential" ? "Lowest price" : s.tier === "priority" ? "Fastest delivery" : "Best balance of price, speed and quality"}</div></a>`,
          )
          .join("")}</div><br>`
      : ""
  }
  <div class="grid cols-2">
    <div class="card flush"><h2 style="text-transform:capitalize">${esc(o.tier)} offer ${badge(o.status)}</h2>
      ${table(
        ["Service", "#Qty", "#Fee each", "#Govt fee each"],
        o.lines.map(
          (l) => `<tr><td>${esc(l.name)}${l.model === "agent" ? `<br><span class="small muted">Billed by the licensed firm; MKW fee shown separately</span>` : ""}</td>
            <td class="num">${l.qty}</td><td class="num">${aed(l.clientUnitPrice)}</td><td class="num">${aed(l.govUnitFee)}</td></tr>`,
        ),
      )}
    </div>
    <div class="card stack">
      <h2>Total</h2>
      <table>
        <tr><td>Professional fees</td><td class="num">${aed(o.professional)}</td></tr>
        ${o.mkwFees ? `<tr><td>MKW coordination fees</td><td class="num">${aed(o.mkwFees)}</td></tr>` : ""}
        <tr><td>VAT at 5%</td><td class="num">${aed(o.vat)}</td></tr>
        <tr><td>Government fees, at cost</td><td class="num">${aed(o.government)}</td></tr>
        <tfoot><tr><td>Total</td><td class="num">${aed(o.clientTotal)}</td></tr></tfoot>
      </table>
      <p class="small muted">On acceptance you pay ${aed(deposit)}: half the fees plus all government fees, which we pass on at cost. The rest is due on completion. Valid until ${date(o.validTo)}.</p>
      <p><a class="btn sm" href="/api/client/offers/${o.id}/pdf" target="_blank" rel="noopener" data-offer-pdf>Download the offer (PDF)</a></p>
      ${
        o.status === "published"
          ? role() === "client_owner"
            ? `${
                terms?.version
                  ? `${legalBlock(terms, "Tasees client terms")}
                     <label class="small accept-terms"><input type="checkbox" data-terms-version="${terms.version}" /> I have read and accept the Tasees client terms, version ${terms.version}${terms.draft ? " (draft, pending legal review)" : ""}</label>`
                  : ""
              }<button class="primary" data-act="accept-offer" data-id="${o.id}">Accept this offer</button>`
            : `<p class="notice small">Only the account owner can accept an offer.</p>`
          : ""
      }
    </div>
  </div>`;
}

export async function renderIntake() {
  const list = await deliverables();
  let clients = [];
  if (isPlatform()) clients = await api("GET", "/api/ops/clients");
  const setup = new Set(["SET-FZ-LIC", "SET-ML-LIC", "SET-OFF", "VISA-RES", "VISA-FAM"]);
  const extras = list.filter((d) => !setup.has(d.code));
  $app.innerHTML = `
  <h1>${isPlatform() ? "New request for a client" : "What do you need?"}</h1>
  <form class="card" data-form="intake" style="max-width:820px">
    ${
      isPlatform()
        ? `<div class="field"><label>Client</label><select name="clientOrgId" required>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
           <details class="field"><summary class="small">Add a new client</summary><div class="grid cols-3" style="margin-top:8px">
             <input name="newCompany" placeholder="Company name" /><input name="newOwner" placeholder="Owner name" /><input name="newEmail" type="email" placeholder="Owner email" /></div>
             <button type="button" class="sm" data-act="add-client" style="margin-top:8px">Add client</button></details>`
        : ""
    }
    <fieldset><legend>Starting point</legend>
      <div class="choices">
        <label><input type="radio" name="mode" value="new_company" checked /> Set up a new company</label>
        <label><input type="radio" name="mode" value="services" /> Services for a company I already have</label>
      </div>
    </fieldset>
    <div class="grid cols-3">
      <div class="field"><label>Emirate</label><select name="emirate">${["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Umm Al Quwain", "Fujairah"].map((e) => `<option>${e}</option>`).join("")}</select></div>
      <div class="field"><label>Licence type</label><select name="jurisdiction">
        <option value="not_sure">Not sure yet; advise me</option><option value="free_zone">Free zone</option><option value="mainland">Mainland</option>
        <option value="offshore">Offshore</option><option value="difc_adgm">DIFC or ADGM</option></select></div>
      <div class="field"><label>Free zone, if known</label><input name="freeZone" placeholder="e.g. IFZA, Meydan, RAKEZ" /></div>
      <div class="field"><label>Residence visas</label><input name="visas" type="number" min="0" max="50" value="1" /></div>
      <div class="field"><label>Family visas</label><input name="dependants" type="number" min="0" max="20" value="0" /></div>
    </div>
    <fieldset data-scoping><legend>About the business (helps us advise on structure and place)</legend>
      <div class="grid cols-3">
        <div class="field"><label>Main activity</label><select name="activity"><option value="">Choose</option>${["consulting", "trading", "ecommerce", "tech", "holding", "finance", "health", "education", "food", "construction", "other"].map((a) => `<option value="${a}">${esc(a)}</option>`).join("")}</select></div>
        <div class="field"><label>Who are your customers?</label><select name="customers"><option value="">Choose</option><option value="international">Outside the UAE</option><option value="uae_mainland">Inside the UAE (mainland)</option><option value="both">Both</option></select></div>
        <div class="field"><label>Need a physical office, shop or site?</label><select name="officeNeeded"><option value="">Not sure</option><option value="no">No</option><option value="yes">Yes</option></select></div>
        <div class="field"><label>Setup budget, AED (optional)</label><input name="budgetAed" type="number" min="0" /></div>
        <div class="field"><label>Expected yearly sales, AED (optional)</label><input name="expectedTurnoverAed" type="number" min="0" /></div>
      </div>
      <div class="field"><label>Describe what you want to do (optional)</label><textarea name="description" maxlength="2000" placeholder="e.g. We are three partners starting a software company, need 2 visas and a bank account"></textarea></div>
    </fieldset>
    <fieldset><legend>Add services</legend><div class="choices">
      ${extras.map((d) => `<label><input type="checkbox" name="extra" value="${d.code}" /> ${esc(d.name)}</label>`).join("")}
    </div></fieldset>
    <p class="small muted">We turn your answers into a scope, collect sealed prices from vetted partner firms and send you up to three offers. Where a rule is not certain for your case, we say so and a person checks it.</p>
    <button class="primary" type="submit">Get my offers</button>
  </form>`;
}

// Engagement (all roles) ------------------------------------------------------------

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

// Partner -------------------------------------------------------------------------------

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
      <td>${["open", "evidence_uploaded"].includes(o.status) ? `<form class="row" data-form="obligation-evidence" data-id="${o.id}"><input type="file" name="file" required style="width:auto;max-width:100%" /><button class="sm primary" type="submit">Upload filing confirmation</button></form>` : ""}</td></tr>`),
    "Nothing on your calendar yet. Obligations appear when an engagement completes and MKW Advisors confirms the dates.",
  )}</div>
  <p class="small muted">${live.length} open · ${list.length - live.length} done</p>`;
}

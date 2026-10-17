// Tasees workspace: one page for clients, partners and MKW Advisors staff.
// Plain ES modules, no build step. Every money figure arrives from the API in fils (1/100 AED),
// already filtered by role on the server and in the database; this file only displays it.

const $app = document.getElementById("app");
const $nav = document.getElementById("nav");
const $who = document.getElementById("who");
const $brand = document.getElementById("brand");
const $toast = document.getElementById("toast");

const state = { me: null, health: null, deliverables: null, unread: 0 };

// Helpers ---------------------------------------------------------------------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const aed = (fils) => {
  if (fils == null) return "–";
  const whole = Number(fils) % 100 === 0;
  return "AED " + (Number(fils) / 100).toLocaleString("en-AE", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
};
const STAGE_ORDER = { kickoff: 0, key_milestone: 1, completion: 2, change_order: 3 };
const byStage = (a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9);

const pct = (bp) => (bp == null ? "–" : (Number(bp) / 100).toFixed(1) + "%");

const date = (v) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
const dateTime = (v) =>
  v ? new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" }) + " GST" : "–";

const words = (s) => String(s ?? "").replace(/_/g, " ");
const addDaysIso = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const TONE = {
  ok: ["client_approved", "completed", "accepted", "released", "paid", "published", "signed", "approved", "eligible", "ok", "active", "verified"],
  info: ["in_progress", "in_delivery", "evidence_submitted", "qa_passed", "allocating", "draft", "scoped", "offered", "priced", "proposed"],
  warn: ["awaiting_payment", "ops_review", "quoting", "pending", "pilot", "open", "prospect", "contacted", "UNCERTAIN"],
  bad: ["disputed", "qa_rejected", "expired", "withdrawn", "cancelled", "rejected", "withheld", "paused", "deactivated", "erased"],
};
const tone = (s) => Object.keys(TONE).find((k) => TONE[k].includes(s)) ?? "";
const badge = (s, label) => `<span class="badge ${tone(s)}">${esc(label ?? words(s))}</span>`;

const MILESTONE_LABEL = {
  pending: "Not started",
  in_progress: "In progress",
  evidence_submitted: "Evidence with MKW for checking",
  qa_passed: "Checked, waiting for client approval",
  qa_rejected: "Sent back for rework",
  client_approved: "Approved",
  disputed: "Issue raised",
};

const isPlatform = () => state.me?.orgType === "platform";
const isPartner = () => state.me?.orgType === "partner";
const isClient = () => state.me?.orgType === "client";
const role = () => state.me?.role;
const seesMargin = () => ["finance", "founder"].includes(role());

function toast(msg, err = false) {
  $toast.textContent = msg;
  $toast.className = "show" + (err ? " err" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.className = ""), err ? 6000 : 3000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = new Error(data?.message ?? `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/** Run an action, show the outcome, re-render. */
async function act(fn, ok = "Done") {
  try {
    await fn();
    if (ok) toast(ok);
    await render();
  } catch (e) {
    toast(e.message, true);
  }
}

const table = (head, rows, empty = "Nothing here yet.") =>
  rows.length
    ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith("#") ? "num" : ""}">${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p class="empty">${esc(empty)}</p>`;

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function deliverables() {
  if (!state.deliverables) state.deliverables = await api("GET", "/api/deliverables");
  return state.deliverables;
}
const nameOf = (code) => state.deliverables?.find((d) => d.code === code)?.name ?? code;

// Routing ----------------------------------------------------------------------

const route = () => {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { page: parts[0] ?? "home", id: parts[1] ?? null };
};
window.addEventListener("hashchange", () => render());
// Coming back to the tab shows fresh data, unless the person is typing in a form.
document.addEventListener("visibilitychange", () => {
  const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
  if (document.visibilityState === "visible" && state.me && !typing) render();
});

function navFor() {
  if (isClient()) return [["home", "Overview"], ["new", "New request"], ["statement", "Statement"]];
  if (isPartner()) return [["home", "Work"], ["rates", "Rate card"], ["payouts", "Payouts"]];
  return [["home", "Queue"], ["pipeline", "Pipeline"], ["partners", "Partners"], ["people", "People"], ["catalogue", "Catalogue"], ["rules", "Rules"], ["scoping", "Scoping"], ["agent", "AI queue"], ["new", "New request"], ["settings", "Settings"], ["audit", "Audit trail"]];
}

function chrome() {
  const { page } = route();
  if (!state.me) {
    $nav.innerHTML = "";
    $who.innerHTML = "";
    $brand.innerHTML = "Tasees <small>by MKW Advisors</small>";
    return;
  }
  $brand.innerHTML = isPartner()
    ? "MKW Advisors <small>Partner Network</small>"
    : isPlatform()
      ? "MKW Advisors <small>Operations</small>"
      : "Tasees <small>by MKW Advisors</small>";
  $nav.innerHTML = navFor()
    .map(([p, label]) => `<a href="#/${p}" class="${page === p ? "on" : ""}">${esc(label)}</a>`)
    .join("");
  $who.innerHTML = `${isPlatform() ? `<form data-form="search" class="search"><input name="q" type="search" placeholder="Search clients, partners, refs" aria-label="Search" /></form>` : ""}<span>${esc(state.me.name)} · ${esc(state.me.orgName)} · ${esc(words(state.me.role))}</span>
    <a class="bell ${page === "notifications" ? "on" : ""}" href="#/notifications" aria-label="Notifications${state.unread ? `, ${state.unread} unread` : ""}" title="Notifications">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
      ${state.unread ? `<b class="count" data-unread>${state.unread > 99 ? "99+" : state.unread}</b>` : ""}</a>
    <button class="sm" data-act="logout">Sign out</button>`;
}

// Renders run one at a time; a request made mid-render runs once more afterwards, so the
// screen always ends on the latest route and data.
let rendering = null;
let renderAgain = false;
function render() {
  if (rendering) {
    renderAgain = true;
    return rendering;
  }
  rendering = (async () => {
    do {
      renderAgain = false;
      await renderOnce();
    } while (renderAgain);
    rendering = null;
  })();
  return rendering;
}

async function refreshUnread() {
  try {
    state.unread = (await api("GET", "/api/notifications")).unread ?? 0;
  } catch {
    state.unread = 0;
  }
}

async function renderOnce() {
  if (state.me && route().page !== "notifications") await refreshUnread();
  chrome();
  if (!state.me) return renderSignIn();
  const { page, id } = route();
  try {
    await deliverables();
    if (page === "notifications") return await renderNotifications();
    if (page === "engagement" && id) return await renderEngagement(id);
    if (page === "pay" && id) return renderPayPage(id);
    if (page === "request" && id) return await renderRequest(id);
    if (isClient()) {
      if (page === "offer" && id) return await renderClientOffer(id);
      if (page === "statement") return await renderStatement();
      if (page === "new") return await renderIntake();
      return await renderClientHome();
    }
    if (isPartner()) {
      if (page === "rates") return await renderRateCards();
      if (page === "payouts") return await renderPartnerPayouts();
      return await renderPartnerHome();
    }
    if (page === "offer" && id) return await renderOpsOffer(id);
    if (page === "pipeline") return await renderPipeline();
    if (page === "partners") return await renderPartners();
    if (page === "new") return await renderIntake();
    if (page === "audit") return await renderAudit();
    if (page === "people") return await renderPeople();
    if (page === "catalogue") return await renderCatalogue();
    if (page === "rules") return await renderRules();
    if (page === "scoping") return await renderScoping();
    if (page === "agent") return await renderAgentQueue();
    if (page === "search") return await renderSearch(decodeURIComponent(id ?? ""));
    if (page === "settings") return await renderSettings();
    return await renderQueue();
  } catch (e) {
    if (e.status === 401) {
      state.me = null;
      return render();
    }
    $app.innerHTML = `<div class="card"><h1>Could not load this page</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Back to start</a></div>`;
  }
}

// Sign in ------------------------------------------------------------------------

const DEMO_ACCOUNTS = [
  ["founder@sample-client.test", "Client owner (Sample Trading FZ-LLC)"],
  ["accounts@sample-client.test", "Client member (view and message only)"],
  ["admin@setup-partner.test", "Partner admin (setup and visas)"],
  ["admin@corporate-services.test", "Partner admin (banking and PRO, pilot)"],
  ["admin@tax-accounts.test", "Partner admin (tax and audit)"],
  ["ops@mkwadvisors.test", "MKW ops (no margin view)"],
  ["finance@mkwadvisors.test", "MKW finance (margin and payouts)"],
  ["founder@mkwadvisors.test", "MKW founder"],
];

function renderSignIn(email = "", sent = false, devCode = "") {
  $app.innerHTML = `
  <div class="signin">
    <div class="card">
      <h1>Sign in</h1>
      <p class="muted">We email you a six-digit code. No passwords.</p>
      <form data-form="${sent ? "verify" : "request-code"}">
        <div class="field"><label for="email">Work email</label>
          <input id="email" name="email" type="email" required autocomplete="email" value="${esc(email)}" ${sent ? "readonly" : ""} /></div>
        ${
          sent
            ? `<div class="field"><label for="code">Code from the email</label>
                 <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required pattern="\\d{6}" value="${esc(devCode)}" /></div>
               ${devCode ? `<p class="notice small">Development mode: the code is filled in for you. Production sends it by email only.</p>` : ""}
               <div class="row"><button class="primary" type="submit">Sign in</button><button type="button" class="link" data-act="restart">Use another email</button></div>`
            : `<button class="primary" type="submit">Email me a code</button>`
        }
      </form>
      ${
        state.health?.devLogin && !sent
          ? `<div class="demo"><p class="small muted">Demo accounts (development only):</p>${DEMO_ACCOUNTS.map(
              ([e, l]) => `<button type="button" class="sm" data-act="demo" data-email="${esc(e)}"><b>${esc(l)}</b><br><span class="muted">${esc(e)}</span></button>`,
            ).join("")}</div>`
          : ""
      }
    </div>
    <p class="small muted pad">Tasees is a service of MKW Advisors. Partner firms deliver the work; MKW Advisors manages scope, price, quality and payment.</p>
  </div>`;
}

async function requestCode(email) {
  const r = await api("POST", "/api/auth/request-code", { email });
  renderSignIn(email, true, r.devCode ?? "");
  document.getElementById("code")?.focus();
}

// Client ---------------------------------------------------------------------------

async function renderClientHome() {
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

async function renderClientOffer(id) {
  const o = await api("GET", `/api/client/offers/${id}`);
  const h = await api("GET", "/api/client/home");
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
      ${
        o.status === "published"
          ? role() === "client_owner"
            ? `<button class="primary" data-act="accept-offer" data-id="${o.id}">Accept this offer</button>`
            : `<p class="notice small">Only the account owner can accept an offer.</p>`
          : ""
      }
    </div>
  </div>`;
}

async function renderIntake() {
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

async function renderEngagement(id) {
  const e = await api("GET", `/api/engagements/${id}`);
  const ms = e.milestones;
  const done = ms.filter((m) => m.status === "client_approved").length;
  const evidenceFor = (mid) => e.evidence.filter((x) => x.milestoneId === mid);
  const back = isPlatform() ? "#/pipeline" : "#/";
  const nextOpenId = ms.find((m) => ["pending", "in_progress", "qa_rejected"].includes(m.status))?.id;
  const partnerNames = (e.parties ?? []).filter((p) => p.party === "partner").map((p) => p.name);

  const milestoneActions = (m) => {
    const out = [];
    if (isPartner() && ["pending", "in_progress", "qa_rejected"].includes(m.status)) {
      const work = `<form class="row" data-form="evidence" data-id="${m.id}">
        <select name="type" style="width:auto">${(m.evidenceRequired ?? []).map((t) => `<option value="${esc(t)}">${esc(words(t))}</option>`).join("")}<option value="other">other</option></select>
        <input type="file" name="file" required style="width:auto;max-width:100%" /><button class="sm" type="submit">Upload</button></form>
        <div class="actions"><button class="sm primary" data-act="ms-submit" data-id="${m.id}">Submit for checking</button></div>`;
      // The step in hand shows its tools; later steps keep them folded away.
      if (m.status !== "pending" || m.id === nextOpenId) {
        if (m.status === "pending") out.push(`<button class="sm" data-act="ms-start" data-id="${m.id}">Start</button>`);
        out.push(work);
      } else {
        out.push(`<details><summary class="small">Upload evidence for this step</summary>${work}</details>`);
      }
    }
    if (isPlatform() && m.status === "evidence_submitted" && ["ops", "founder"].includes(role())) {
      out.push(`<button class="sm primary" data-act="ms-qa" data-id="${m.id}" data-pass="1">Evidence is right</button>`);
      out.push(`<button class="sm danger" data-act="ms-qa" data-id="${m.id}" data-pass="0">Send back</button>`);
    }
    if (isPlatform() && m.status === "disputed" && ["ops", "founder"].includes(role())) {
      out.push(`<button class="sm" data-act="ms-resolve" data-id="${m.id}" data-outcome="rework">Partner reworks</button>`);
      out.push(`<button class="sm" data-act="ms-resolve" data-id="${m.id}" data-outcome="approve">Approve as delivered</button>`);
    }
    if (isClient() && m.status === "qa_passed") {
      out.push(`<button class="sm primary" data-act="ms-review" data-id="${m.id}" data-approve="1">Approve</button>`);
      out.push(`<button class="sm danger" data-act="ms-review" data-id="${m.id}" data-approve="0">Raise an issue</button>`);
    }
    return out.length ? `<div class="actions">${out.join("")}</div>` : "";
  };

  const dotTone = (s) => ({ client_approved: "ok", qa_passed: "info", evidence_submitted: "info", in_progress: "info", qa_rejected: "bad", disputed: "bad" })[s] ?? "";

  const moneyCard = () => {
    if (isClient())
      return `<div class="card flush"><h2>Payments</h2>${table(
        ["What", "#Amount", "Status", ""],
        (e.payments ?? []).map(
          (p) => `<tr><td>${esc(words(p.kind))}</td><td class="num">${aed(p.amount)}</td><td>${badge(p.status)}${p.paidAt ? ` <span class="small muted">${date(p.paidAt)}</span>` : ""}</td>
          <td>${p.status === "pending" && p.payUrl ? `<a class="btn sm primary" href="${esc(p.payUrl)}">Pay by card</a>` : ""}</td></tr>`,
        ),
      )}
      ${(e.invoices ?? []).length ? `<h2 style="padding:16px 18px 0">Tax invoices</h2>${table(
        ["Number", "Issued", "#Amount", ""],
        e.invoices.map((i) => `<tr><td class="mono small">${esc(i.number)}${i.kind === "credit_note" ? ` ${badge("refunded", "credit note")}` : ""}</td><td>${date(i.issuedAt)}</td><td class="num">${aed(i.gross)}</td><td><a href="/api/invoices/${i.id}/pdf" target="_blank" rel="noopener">Download PDF</a></td></tr>`),
      )}` : ""}
      <p class="small muted pad" style="padding-top:0">Pay by bank transfer to MKW Advisors quoting reference ${esc(e.engagement.id.slice(0, 8).toUpperCase())}, or by card. A tax invoice is issued for every payment.</p></div>`;
    if (isPartner())
      return `<div class="card flush"><h2>Your payouts</h2>${table(
        ["Stage", "#Amount", "Status", "Your invoice"],
        [...(e.payouts ?? [])].sort(byStage).map((p) => `<tr><td>${esc(words(p.stage))}</td><td class="num">${aed(p.amount)}</td><td>${badge(p.status)}</td><td class="small">${p.invoiceNumber ? esc(p.invoiceNumber) : p.status === "eligible" ? `<a href="#/payouts">upload on Payouts</a>` : "–"}</td></tr>`),
        "Payouts appear once you accept the work.",
      )}</div>`;
    return `<div class="card flush"><h2>Money</h2>
      ${table(
        ["Client payment", "#Amount", "Status", ""],
        e.payments.map(
          (p) => `<tr><td>${esc(words(p.kind))}${p.payUrl ? `<br><span class="small muted">card link issued</span>` : ""}</td><td class="num">${aed(p.amount)}</td><td>${badge(p.status)}${p.refundReference ? `<br><span class="small muted">refund ${esc(p.refundReference)}</span>` : ""}</td>
          <td>${p.status === "pending" && seesMargin() ? `<button class="sm" data-act="mark-paid" data-id="${p.id}">Mark received</button>` : p.status === "paid" && seesMargin() ? `<button class="sm danger" data-act="refund" data-id="${p.id}">Refund</button>` : ""}</td></tr>`,
        ),
      )}
      ${(e.invoices ?? []).length ? table(["Invoice", "Status", "#Amount", ""], e.invoices.map((i) => `<tr><td class="mono small">${esc(i.number ?? "(held: no TRN)")} <span class="muted">${esc(words(i.kind))}</span></td><td>${badge(i.status === "issued" ? "ok" : "UNCERTAIN", i.status === "issued" ? "issued" : "held, no TRN")}</td><td class="num">${aed(i.gross)}</td><td>${i.status === "issued" ? `<a href="/api/invoices/${i.id}/pdf" target="_blank" rel="noopener">PDF</a>` : ""}</td></tr>`)) : ""}
      ${table(
        ["Partner payout", "#Amount", "Status", ""],
        e.payouts.map(
          (p) => `<tr><td>${esc(p.partner)} · ${esc(words(p.stage))}${p.invoiceNumber ? `<br><span class="small muted">partner invoice ${esc(p.invoiceNumber)}</span>` : `<br><span class="small muted">no partner invoice yet</span>`}</td><td class="num">${aed(p.amount)}</td><td>${badge(p.status)}${p.runId ? ` <span class="small muted">in run</span>` : ""}</td>
          <td>${p.status === "eligible" && seesMargin() && p.invoiceNumber && !p.runId ? `<button class="sm" data-act="release" data-id="${p.id}">Release</button>` : ""}</td></tr>`,
        ),
        "No payouts yet.",
      )}<p class="small muted pad" style="padding-top:0">Payouts are normally paid in a weekly payout run from the Partners page; a single release here needs the partner's invoice too.</p></div>`;
  };

  const linesCard = () => {
    if (isPlatform())
      return `<div class="card flush"><h2>Scope and partners</h2>${table(
        ["Service", "#Qty", "Partner", "#Client", "#Partner cost", ...(seesMargin() ? ["#Margin"] : [])],
        e.lines.map(
          (l) => `<tr><td>${esc(l.name)}</td><td class="num">${l.qty}</td><td>${l.partner ? esc(l.partner) : badge("pending", "not yet allocated")}</td>
          <td class="num">${aed(l.clientUnitPrice)}</td><td class="num">${aed(l.partnerUnitCost)}</td>${seesMargin() ? `<td class="num">${aed(l.marginUnit)}</td>` : ""}</tr>`,
        ),
      )}
      <h2 style="padding:16px 18px 0">Allocation history</h2>${table(
        ["Partner", "Lines", "Why", "Offered", "Outcome"],
        e.allocations.map(
          (a) => `<tr><td>${esc(a.partner)}</td><td class="small">${esc(a.codes.map(nameOf).join(", "))}</td><td>${esc(words(a.reason))}</td><td>${dateTime(a.offeredAt)}</td>
          <td>${a.acceptedAt ? badge("accepted") : a.declinedAt ? badge("rejected", "declined: " + (a.declineReason ?? "")) : a.timedOutAt ? badge("expired", "no reply in time") : badge("pending", "waiting until " + dateTime(a.deadline))}</td></tr>`,
        ),
        "Allocation starts when the deposit is received.",
      )}
      ${["ops", "founder"].includes(role()) ? `<div class="pad" style="padding-top:8px"><button class="sm" data-act="reallocate" data-id="${e.engagement.id}">Allocate open lines now</button></div>` : ""}</div>`;
    const priceCol = isClient() ? "clientUnitPrice" : "partnerUnitCost";
    const showMoney = e.lines.some((l) => l[priceCol] != null);
    return `<div class="card flush"><h2>Scope</h2>${table(
      ["Service", "#Qty", ...(showMoney ? [isClient() ? "#Fee each" : "#Your fee each"] : []), "#Govt fee each"],
      e.lines.map(
        (l) => `<tr><td>${esc(l.name)}</td><td class="num">${l.qty}</td>${showMoney ? `<td class="num">${aed(l[priceCol])}</td>` : ""}<td class="num">${aed(l.govUnitFee)}</td></tr>`,
      ),
    )}</div>`;
  };

  const changeOrders = () => {
    const list = e.changeOrders ?? [];
    const rows = list.map((c) => {
      const amount = isClient() ? c.client : isPartner() ? c.partner : c.client;
      const decide =
        isClient() && role() === "client_owner" && c.status === "priced"
          ? `<button class="sm primary" data-act="co-decide" data-id="${c.id}" data-approve="1">Approve</button> <button class="sm" data-act="co-decide" data-id="${c.id}" data-approve="0">Decline</button>`
          : "";
      return `<tr><td>${esc(c.description)}</td><td class="num">${aed(amount)}${isPlatform() ? `<br><span class="small muted">partner ${aed(c.partner)}</span>` : ""}</td><td>${badge(c.status)}</td><td>${decide}</td></tr>`;
    });
    const form =
      isPartner() && role() === "partner_admin" && e.engagement.status === "in_delivery"
        ? `<form class="pad grid cols-3" data-form="change-order" data-id="${e.engagement.id}" style="padding-top:8px">
            <input name="description" placeholder="What changed and why" required minlength="3" />
            <input name="partnerCostAed" type="number" min="1" step="1" placeholder="Your fee, AED" required />
            <button class="sm" type="submit">Propose change</button></form>
           <p class="small muted pad" style="padding-top:0">MKW Advisors prices the change for the client. Start the extra work only after the client approves it here.</p>`
        : "";
    if (!rows.length && !form) return "";
    return `<div class="card flush"><h2>Changes to scope</h2>${table(["Change", "#Amount", "Status", ""], rows, "No changes.")}${form}</div>`;
  };

  $app.innerHTML = `
  <p><a href="${back}">← Back</a></p>
  <div class="row between"><h1>Engagement · ${esc(e.engagement.emirate)}${e.engagement.freeZone ? ` · ${esc(e.engagement.freeZone)}` : ""}</h1>${badge(e.engagement.status)}</div>
  <p class="muted">${done} of ${ms.length} steps approved${partnerNames.length && !isPartner() ? ` · Delivered by ${esc(partnerNames.join(", "))}, managed by MKW Advisors` : ""}</p>
  <div class="stack">${linesCard()}</div><br>
  <div class="grid cols-2">
    <div class="card"><h2>Steps</h2>
      ${
        ms.length
          ? `<ul class="milestones">${ms
              .map(
                (m) => `<li><span class="dot ${dotTone(m.status)}"></span><div>
                <div class="row between"><b>${esc(m.name)}</b>${badge(m.status, MILESTONE_LABEL[m.status])}</div>
                <div class="small muted">Due ${date(m.dueDate)}${m.isKey ? " · key step" : ""} · Evidence: ${esc((m.evidenceRequired ?? []).map(words).join(", ") || "none")}</div>
                ${m.qaNote ? `<div class="small">MKW note: ${esc(m.qaNote)}</div>` : ""}
                ${m.disputeReason ? `<div class="small">Client issue: ${esc(m.disputeReason)}</div>` : ""}
                ${evidenceFor(m.id).length ? `<div class="small">${evidenceFor(m.id).map((x) => `<a href="/api/evidence/${x.id}/file" target="_blank" rel="noopener">${esc(x.fileName)}</a> <span class="muted">(${esc(words(x.type))})</span>`).join(" · ")}</div>` : ""}
                ${milestoneActions(m)}</div></li>`,
              )
              .join("")}</ul>`
          : `<p class="muted">Steps appear when a partner accepts the work.</p>`
      }
    </div>
    <div class="stack">
      ${moneyCard()}
      ${changeOrders()}
      <div class="card"><h2>Messages</h2>
        <div class="messages">${
          e.messages.length
            ? e.messages
                .map(
                  (m) => `<div class="msg"><div class="meta">${esc(m.authorName)} · ${dateTime(m.createdAt)}${m.masked ? " · contact details hidden" : ""}</div>
                  <div>${esc(isPlatform() ? m.bodyOriginal : m.bodyShown)}</div>${isPlatform() && m.masked ? `<div class="small muted">Shown to parties: ${esc(m.bodyShown)}</div>` : ""}</div>`,
                )
                .join("")
            : `<p class="muted small">No messages yet.</p>`
        }</div>
        <form data-form="message" data-id="${e.engagement.id}"><textarea name="body" required placeholder="Write a message. Phone numbers and emails are hidden from the other side; MKW Advisors sees everything."></textarea>
        <div class="row" style="margin-top:8px"><button class="sm primary" type="submit">Send</button></div></form>
      </div>
    </div>
  </div>`;
}

async function renderStatement() {
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
function renderPayPage(paymentId) {
  $app.innerHTML = `<div class="signin"><div class="card"><h1>Pay by card</h1>
    <p class="muted">Card payments switch on once MKW Advisors connects its payment provider. Until then, please pay by bank transfer to MKW Advisors and quote the reference shown on your engagement page; finance records it the same day and your tax invoice follows.</p>
    <p class="small muted mono">Payment ${esc(paymentId.slice(0, 8))}</p>
    <a class="btn" href="#/">Back to your overview</a></div></div>`;
}

// Partner -------------------------------------------------------------------------------

async function renderPartnerHome() {
  const h = await api("GET", "/api/partner/home");
  const offered = h.allocations.filter((a) => !a.acceptedAt && !a.declinedAt && !a.timedOutAt);
  const active = h.allocations.filter((a) => a.acceptedAt);
  const rfqs = h.rfqs.filter((q) => q.status === "open" && !q.submitted);
  const admin = role() === "partner_admin";
  $app.innerHTML = `
  <h1>Work from MKW Advisors</h1>
  <div class="kpis">
    <div class="kpi"><b>${offered.length}</b><span>Offers waiting for your answer</span></div>
    <div class="kpi"><b>${active.filter((a) => a.engagementStatus !== "completed").length}</b><span>Engagements in delivery</span></div>
    <div class="kpi"><b>${rfqs.length}</b><span>Requests for a price</span></div>
    <div class="kpi"><b>${aed(h.payouts.filter((p) => p.status === "eligible").reduce((s, p) => s + p.amount, 0))}</b><span>Payouts due to you</span></div>
  </div>
  <div class="stack">
    <div class="card flush"><h2>Offered to you</h2>
      ${table(
        ["Where", "Work", "#Your payout", "Reply by", ""],
        offered.map(
          (a) => `<tr><td>${esc(a.brief?.emirate ?? "")}${a.brief?.freeZone ? ` · ${esc(a.brief.freeZone)}` : ""}</td>
          <td>${esc((a.brief?.lines ?? a.codes.map((c) => ({ code: c, qty: 1 }))).map((l) => `${l.name ?? nameOf(l.code)}${l.qty > 1 ? ` ×${l.qty}` : ""}`).join(", "))}</td>
          <td class="num">${aed(a.payoutTotal)}</td><td>${dateTime(a.deadline)}</td>
          <td>${admin ? `<button class="sm primary" data-act="alloc" data-id="${a.id}" data-decision="accept">Accept</button> <button class="sm" data-act="alloc" data-id="${a.id}" data-decision="decline">Decline</button>` : `<span class="small muted">Your admin replies</span>`}</td></tr>`,
        ),
        "Nothing waiting. New work arrives here and by email; you have 4 working hours to reply.",
      )}
    </div>
    <div class="card flush"><h2>Requests for a price</h2>
      ${
        rfqs.length
          ? rfqs
              .map(
                (q) => `<form class="pad" data-form="quote" data-id="${q.id}" style="border-top:1px solid var(--line)">
              <div class="row between"><b>Sealed quote · reply by ${dateTime(q.deadline)}</b><span class="small muted">Other firms cannot see your price.</span></div>
              ${(q.scope?.lines ?? [])
                .map(
                  (l) => `<div class="grid cols-3" style="margin-top:10px" data-line="${esc(l.code)}">
                  <div><label>${esc(nameOf(l.code))} ×${l.qty}</label><input name="prof-${esc(l.code)}" type="number" min="0" placeholder="Your fee, AED" required /></div>
                  <div><label>Government fee you expect, AED</label><input name="gov-${esc(l.code)}" type="number" min="0" value="0" /></div>
                  <div><label>Working days</label><input name="days-${esc(l.code)}" type="number" min="1" max="365" value="10" required /></div>
                  <div style="grid-column:1/-1"><label>Not included (one per line)</label><textarea name="excl-${esc(l.code)}" placeholder="Each exclusion adds a gap cost when we compare quotes"></textarea></div></div>`,
                )
                .join("")}
              ${admin ? `<button class="sm primary" type="submit" style="margin-top:10px">Send sealed quote</button>` : ""}</form>`,
              )
              .join("")
          : `<p class="empty">No open requests for a price.</p>`
      }
    </div>
    <div class="card flush"><h2>In delivery</h2>
      ${table(
        ["Accepted", "Where", "Work", "Status", ""],
        active.map(
          (a) => `<tr><td>${date(a.acceptedAt)}</td><td>${esc(a.brief?.emirate ?? "")}</td><td>${esc(a.codes.map(nameOf).join(", "))}</td>
          <td>${badge(a.engagementStatus ?? "in_delivery")}</td><td><a href="#/engagement/${a.engagementId}">Open</a></td></tr>`,
        ),
        "No work in delivery.",
      )}
    </div>
  </div>`;
}

async function renderPartnerPayouts() {
  const h = await api("GET", "/api/partner/home");
  const admin = role() === "partner_admin";
  const bank = h.bank ?? {};
  $app.innerHTML = `<h1>Payouts</h1>
  <p class="muted">Paid in three stages (kick-off, key step, completion) in MKW Advisors' weekly payout run, once the client has paid and your invoice for the stage is on file. Upload your invoice to MKW Advisors for each payout below.</p>
  <div class="card flush">${table(
    ["Engagement", "Stage", "#Amount", "Status", "Your invoice", "Released"],
    h.payouts.map(
      (p) => `<tr><td><a href="#/engagement/${p.engagementId}">${esc(p.engagementId.slice(0, 8))}</a></td><td>${esc(words(p.stage))}</td>
      <td class="num">${aed(p.amount)}</td><td>${badge(p.status)}${p.runId ? `<br><span class="small muted">in a payout run</span>` : ""}</td>
      <td class="small">${
        p.invoiceNumber
          ? esc(p.invoiceNumber)
          : admin && ["eligible", "pending"].includes(p.status)
            ? `<form class="row" data-form="partner-invoice" data-id="${p.id}" data-amount="${p.amount}" style="flex-wrap:wrap;gap:4px">
                <input name="number" placeholder="Invoice no." required style="width:110px" /><input name="vatAed" type="number" min="0" step="0.01" placeholder="VAT (0 or 5%)" title="0 if your firm is not VAT-registered, otherwise exactly 5% of the payout" style="width:110px" />
                <input type="file" name="file" required style="width:auto;max-width:160px" /><button class="sm" type="submit">Upload</button></form>`
            : "–"
      }</td><td>${date(p.releasedAt)}</td></tr>`,
    ),
    "No payouts yet.",
  )}</div>
  <form class="card" data-form="bank" style="margin-top:16px"><h2>Bank account for payouts ${bank.iban ? badge("ok", "on file") : badge("pending", "needed before you can be paid")}</h2>
    <div class="grid cols-3">
      <div class="field"><label>Account name (as the bank has it)</label><input name="beneficiary" value="${esc(bank.beneficiary ?? "")}" required ${admin ? "" : "readonly"} /></div>
      <div class="field"><label>IBAN (UAE)</label><input name="iban" value="${esc(bank.iban ?? "")}" placeholder="AE.. 21 digits" required ${admin ? "" : "readonly"} /></div>
      <div class="field"><label>Bank</label><input name="bank" value="${esc(bank.bank ?? "")}" required ${admin ? "" : "readonly"} /></div>
    </div>${admin ? `<button class="primary" type="submit">Save bank details</button>` : `<p class="small muted">Your admin keeps these details.</p>`}</form>`;
}

async function renderRateCards() {
  const h = await api("GET", "/api/partner/home");
  const admin = role() === "partner_admin";
  $app.innerHTML = `<h1>Your rate card</h1>
  <p class="muted">Standing prices MKW Advisors can use to offer your services without asking each time. Each card is valid for 90 days. Quote your own fee; government fees are taken from MKW's official fee table.</p>
  <div class="card flush">${table(
    ["Service", "#Your fee", "#Govt fee stated", "#Third party", "#Days", "Not included", "Valid to"],
    h.rateCards.map(
      (c) => `<tr><td>${esc(c.name)}</td><td class="num">${aed(c.professional)}</td><td class="num">${aed(c.govStated)}</td><td class="num">${aed(c.thirdParty)}</td>
      <td class="num">${c.workingDays}</td><td class="small">${esc((c.exclusions ?? []).join("; ") || "–")}</td><td>${date(c.validTo)}</td></tr>`,
    ),
    "No rate cards yet.",
  )}</div><br>
  ${
    admin
      ? `<form class="card" data-form="rate-card"><h2>Add or update a price</h2><div class="grid cols-3">
      <div class="field"><label>Service</label><select name="code">${h.deliverables.map((d) => `<option value="${d.code}">${esc(d.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Your fee, AED</label><input name="professionalAed" type="number" min="0" required /></div>
      <div class="field"><label>Government fee you expect, AED</label><input name="govStatedAed" type="number" min="0" value="0" /></div>
      <div class="field"><label>Third-party costs, AED</label><input name="thirdPartyAed" type="number" min="0" value="0" /></div>
      <div class="field"><label>Working days</label><input name="workingDays" type="number" min="1" max="365" value="10" required /></div>
      <div class="field"><label>Not included (one per line)</label><textarea name="exclusions"></textarea></div></div>
      <button class="primary" type="submit">Save price</button></form>`
      : ""
  }`;
}

// MKW operations --------------------------------------------------------------------------

const EXCEPTION_LABEL = {
  offer_review: "Offer needs a price decision",
  offer_ready: "Offer ready to publish",
  needs_quote: "Needs a request for quote",
  qa: "Evidence to check",
  dispute: "Client raised an issue",
  unallocated: "No partner for some lines",
  payout: "Payout ready",
  scoping: "Scoping advice to review",
  ai_draft: "AI draft to decide",
};

async function renderQueue() {
  const o = await api("GET", "/api/ops/overview");
  const linkFor = (x) =>
    ["offer_review", "offer_ready"].includes(x.kind) ? `#/offer/${x.ref}` : x.kind === "needs_quote" ? `#/pipeline` : x.kind === "scoping" ? `#/request/${x.ref}` : x.kind === "ai_draft" ? `#/agent` : `#/engagement/${x.ref}`;
  const counts = Object.fromEntries(Object.keys(EXCEPTION_LABEL).map((k) => [k, o.exceptions.filter((x) => x.kind === k).length]));
  $app.innerHTML = `
  <h1>What needs a person today</h1>
  <p class="muted">Everything else runs on its own: pricing from rate cards, allocation, reminders, auto-approval after 5 working days.${o.seesMargin ? "" : " Margin figures are visible to finance and the founder only."}</p>
  <div class="kpis">${Object.entries(EXCEPTION_LABEL)
    .map(([k, l]) => `<div class="kpi"><b>${counts[k]}</b><span>${esc(l)}</span></div>`)
    .join("")}</div>
  <div class="card flush">${table(
    ["Since", "Kind", "Detail", ""],
    o.exceptions.map(
      (x) => `<tr><td>${dateTime(x.at)}</td><td>${badge(x.kind === "dispute" ? "disputed" : x.kind === "payout" ? "eligible" : "pending", EXCEPTION_LABEL[x.kind] ?? x.kind)}</td>
      <td>${esc(x.detail)}</td><td><a href="${linkFor(x)}">Open</a></td></tr>`,
    ),
    "The queue is empty.",
  )}</div>
  <div class="row" style="margin-top:12px"><button class="sm" data-act="run-jobs">Run timers now</button><span class="small muted">Checks partner reply deadlines, client auto-approvals and offer expiry. Runs every 15 minutes on its own.</span></div>`;
}

async function renderPipeline() {
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

async function renderOpsOffer(id) {
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

async function renderPartners() {
  const o = await api("GET", "/api/ops/overview");
  const canAct = ["ops", "founder"].includes(role());
  $app.innerHTML = `<h1>Partner network</h1>
  <p class="muted">Allocation picks from partners with an active licence, a signed agreement, the right emirate and capacity, then by quote, relationship and a 35% monthly fairness cap.</p>
  <div class="card flush">${table(
    ["Partner", "Status", "#Quality", "#Capacity", "Emirates", "Checks", "Services", ""],
    o.partners.map((p) => {
      const pr = p.profile ?? {};
      const checks = [pr.licenceActive ? "licence" : null, pr.agreementSigned ? "agreement" : null, pr.ftaTaxAgent ? "FTA agent" : null, (pr.approvedAuditorZones ?? []).length ? "auditor" : null]
        .filter(Boolean)
        .join(", ");
      return `<tr><td>${esc(p.name)}</td><td>${badge(pr.status ?? p.status)}</td><td class="num">${pr.quality ?? "–"}</td><td class="num">${pr.capacity ?? "–"}</td>
      <td class="small">${esc((pr.emirates ?? []).join(", "))}</td><td class="small">${esc(checks || "–")}</td><td class="small">${esc((pr.codes ?? []).join(", "))}</td>
      <td>${canAct ? `<button class="sm" data-act="partner-status" data-id="${p.id}" data-status="${pr.status === "paused" ? "signed" : "paused"}">${pr.status === "paused" ? "Resume" : "Pause"}</button>` : ""}</td></tr>`;
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

async function renderPayoutRuns() {
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

async function renderAudit() {
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

async function renderNotifications() {
  const n = await api("GET", "/api/notifications");
  state.unread = n.unread ?? 0;
  chrome();
  $app.innerHTML = `
  <div class="row between"><h1>Notifications</h1>${n.unread ? `<button class="sm" data-act="read-all">Mark all as read</button>` : ""}</div>
  <p class="muted">${isClient() ? "Notices from Tasees, by MKW Advisors." : "Notices from MKW Advisors."} ${n.unread ? `${n.unread} unread.` : "All read."} The same notices are sent to your email.</p>
  <div class="stack">${
    n.items.length
      ? n.items
          .map(
            (i) => `<div class="card notice-item ${i.readAt ? "" : "unread"}" data-act="read-one" data-id="${i.id}">
            <div class="row between"><b>${esc(i.subject)}</b><span class="small muted">${dateTime(i.createdAt)}</span></div>
            <div class="small" style="white-space:pre-wrap;margin-top:6px">${linkify(i.body)}</div></div>`,
          )
          .join("")
      : `<p class="empty">Nothing yet.</p>`
  }</div>`;
}

/** Turn in-app links to this workspace into anchors; everything else stays escaped text. */
function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s]+#\/[^\s]*?)([.,;:]?)(?=\s|$)/g, (_m, url, tail) => {
    const hash = url.slice(url.indexOf("#"));
    return `<a href="${esc(hash)}">${esc(hash)}</a>${tail}`;
  });
}

async function renderDeliveryLog() {
  const rows = await api("GET", "/api/admin/notifications");
  return `<h2 style="margin-top:24px">Delivery log</h2>
  <p class="muted">Every message the platform raised, who it went to and whether the email provider accepted it. Clients see "Tasees, by MKW Advisors"; partners and staff see "MKW Advisors".</p>
  <div class="card flush">${table(
    ["When", "To", "Audience", "Message", "Status", "Provider"],
    rows.map(
      (r) => `<tr><td>${dateTime(r.createdAt)}</td><td class="small">${esc(r.recipient ?? "")}<br><span class="muted">${esc(r.toEmail)}</span></td><td>${esc(r.audience)}</td>
      <td class="small">${esc(words(r.template))}<br><span class="muted">${esc(r.subject)}</span></td>
      <td>${badge(r.status === "sent" ? "ok" : r.status === "failed" ? "rejected" : "pending", r.status)}${r.error ? `<br><span class="small muted">${esc(r.error)}</span>` : ""}${r.readAt ? `<br><span class="small muted">read ${dateTime(r.readAt)}</span>` : ""}</td>
      <td class="small mono">${esc(r.providerRef ?? "–")}</td></tr>`,
    ),
    "Nothing sent yet.",
  )}</div>`;
}

// Catalogue and rules (O4) -------------------------------------------------------------------------

async function renderCatalogue() {
  const list = await api("GET", "/api/admin/catalogue");
  const { id: filter } = route();
  const cats = [...new Set(list.map((d) => d.category))];
  const shown = filter ? list.filter((d) => d.category === filter) : list;
  $app.innerHTML = `
  <h1>Service catalogue</h1>
  <p class="muted">${list.length} services from the Service Catalogue (83 services; business setup is two codes, free zone and mainland). Market mids are tentative Oct 2026 figures and the government fee table is UNCERTAIN until a named person verifies each row on the Rules page.</p>
  <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:12px"><a class="sm btn ${filter ? "" : "primary"}" href="#/catalogue">All</a>${cats.map((c) => `<a class="sm btn ${filter === c ? "primary" : ""}" href="#/catalogue/${encodeURIComponent(c)}">${esc(c)}</a>`).join("")}</div>
  <div class="card flush">${table(
    ["Code", "Service", "Category", "Model", "Billing", "#Market mid", "Basis", "Rule", "Govt fee rows", "#Rate cards", "Evidence", "Sheet row"],
    shown.map(
      (d) => `<tr><td class="mono small">${esc(d.code)}</td><td>${esc(d.name)}</td><td class="small">${esc(d.category)}</td><td>${badge(d.model === "agent" ? "pilot" : "ok", d.model)}</td><td class="small">${esc(words(d.billing))}</td>
      <td class="num">${aed(d.marketMid)}</td><td class="small">${d.midBasis === "incl_govt" ? "incl. govt" : "service only"}</td>
      <td class="small">${d.rule === undefined ? `<span class="muted">finance</span>` : d.rule ? `${pct(d.rule.rateBp)} / ${aed(d.rule.floor)}` : badge("UNCERTAIN", "no rule")}</td>
      <td class="small">${d.feeRows ? `${d.verifiedFeeRows} verified of ${d.feeRows}` : `<span class="muted">none</span>`}</td><td class="num">${d.rateCards}</td>
      <td class="small">${esc((d.requiredEvidence ?? []).map(words).join(", "))}</td><td class="num small">${d.sheetRow ?? "–"}</td></tr>`,
    ),
  )}</div>`;
}

async function renderRules() {
  const founder = role() === "founder";
  const canFees = ["ops", "founder"].includes(role());
  // Rates and floors are margin policy: ops sees and maintains the fee table only.
  const r = await api("GET", seesMargin() ? "/api/admin/rules" : "/api/admin/fees");
  const list = await deliverables();
  const emirates = ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Umm Al Quwain", "Fujairah"];
  $app.innerHTML = `
  <h1>${seesMargin() ? "Pricing rules and government fees" : "Government fees"}</h1>
  <p class="muted">${seesMargin() ? `One margin rule prices every offer, change order and re-allocation: price = max(cost × (1 + rate), cost + floor), rounded up to ${aed(r.settings.roundTo)}, capped at ${(r.settings.capFactorBp / 10000).toFixed(2)}× the market mid. Rule changes take effect from tomorrow at the earliest; offers already built keep the rule they were priced under. ` : "Margin rates and floors are visible to finance and the founder. "}Government fees are charged at cost from the table below and are UNCERTAIN until a named person verifies them; a verified fee is stale after ${r.staleAfterDays} days. An offer line priced on an UNCERTAIN or stale fee stops for a person before it can be published.</p>
  ${seesMargin() ? `<h2>Margin rules by category</h2>
  <div class="card flush">${table(
    ["Category", "#Services", "Rate", "#Floor", "Scheduled change", ...(founder ? ["Schedule a change"] : [])],
    r.categories.map(
      (c) => `<tr><td>${esc(c.category)}${c.history[0]?.note?.includes("UNCERTAIN") ? ` ${badge("UNCERTAIN", "default, confirm")}` : ""}</td><td class="num">${c.codes}</td>
      <td>${c.current ? pct(c.current.rateBp) : "–"}</td><td class="num">${c.current ? aed(c.current.floor) : "–"}</td>
      <td class="small">${c.scheduled.length ? c.scheduled.map((v) => `${pct(v.rateBp)} / ${aed(v.floor)} from ${date(v.effectiveFrom)}<br><span class="muted">${esc(v.note)}</span>`).join("<br>") : `<span class="muted">none</span>`}</td>
      ${
        founder
          ? `<td><form class="row" data-form="rule" data-id="${esc(c.category)}" style="flex-wrap:wrap;gap:4px">
              <input name="ratePct" type="number" min="0" max="100" step="0.5" value="${c.current ? c.current.rateBp / 100 : 20}" style="width:70px" title="Rate %" />%
              <input name="floorAed" type="number" min="0" value="${c.current ? c.current.floor / 100 : 500}" style="width:90px" title="Floor AED" />
              <input name="effectiveFrom" type="date" value="${addDaysIso(r.asOf, 1)}" min="${addDaysIso(r.asOf, 1)}" style="width:150px" />
              <input name="note" placeholder="Why" required minlength="3" style="width:160px" />
              <button class="sm" type="submit">Schedule</button></form></td>`
          : ""
      }</tr>`,
    ),
  )}</div>
  ${
    founder
      ? `<form class="card" data-form="pricing-settings" style="margin-top:16px"><h2>Pricing settings</h2><div class="grid cols-3">
          <div class="field"><label>Market cap factor (× market mid)</label><input name="capFactor" type="number" min="1" max="3" step="0.05" value="${(r.settings.capFactorBp / 10000).toFixed(2)}" /></div>
          <div class="field"><label>Round client prices up to, AED</label><select name="roundToAed">${[1, 5, 10, 50, 100].map((v) => `<option value="${v}" ${r.settings.roundTo === v * 100 ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          <div class="field"><label>VAT</label><input value="5% (set by law)" readonly /></div>
          <div class="field" style="grid-column:1/-1"><label>Why</label><input name="note" required minlength="3" /></div></div>
          <button class="primary" type="submit">Save settings</button></form>`
      : `<p class="small muted">Market cap ${(r.settings.capFactorBp / 10000).toFixed(2)}×, rounding ${aed(r.settings.roundTo)}, VAT ${pct(r.settings.vatBp)}. Only the founder changes rules and settings.</p>`
  }` : ""}
  <h2 style="margin-top:20px">Government fee table</h2>
  <div class="card flush">${table(
    ["Service", "Emirate", "Free zone", "#Fee", "Source", "From", "Confidence", "Verified", ""],
    r.fees.filter((f) => !f.retired).map(
      (f) => `<tr><td class="small">${esc(f.name)}<br><span class="mono muted">${esc(f.code)}</span></td><td>${esc(f.emirate)}</td><td>${esc(f.freeZone ?? "–")}</td><td class="num">${aed(f.fee)}</td>
      <td class="small">${f.sourceUrl ? `<a href="${esc(f.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>` : `<span class="muted">none</span>`}${f.sourceNote ? `<br><span class="muted">${esc(f.sourceNote)}</span>` : ""}</td>
      <td>${date(f.effectiveFrom)}</td><td>${badge(f.confidence)}${f.stale ? ` ${badge("expired", "stale")}` : ""}</td>
      <td class="small">${f.verifiedBy ? `${esc(f.verifiedBy)}<br><span class="muted">${date(f.verifiedAt)}</span>` : "–"}</td>
      <td><div class="actions">${founder && (f.confidence === "UNCERTAIN" || f.stale) ? `<button class="sm primary" data-act="fee-verify" data-id="${f.id}">Mark verified</button>` : ""}${canFees ? `<button class="sm" data-act="fee-retire" data-id="${f.id}">Retire</button>` : ""}</div></td></tr>`,
    ),
    "No fees in the table yet: partners' stated fees are used and every such line says so on the offer.",
  )}
  ${
    canFees
      ? `<form class="pad grid cols-3" data-form="fee" style="padding-top:8px;border-top:1px solid var(--line)">
        <div class="field"><label>Service</label><select name="code">${list.map((d) => `<option value="${d.code}">${esc(d.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Emirate</label><select name="emirate">${emirates.map((e) => `<option>${e}</option>`).join("")}</select></div>
        <div class="field"><label>Free zone (blank = emirate-wide)</label><input name="freeZone" placeholder="e.g. IFZA" /></div>
        <div class="field"><label>Fee, AED</label><input name="feeAed" type="number" min="0" required /></div>
        <div class="field"><label>Source link</label><input name="sourceUrl" type="url" placeholder="https://..." /></div>
        <div class="field"><label>Source note</label><input name="sourceNote" placeholder="Page, package, date seen" /></div>
        <div class="field"><label>Effective from</label><input name="effectiveFrom" type="date" value="${r.asOf}" /></div>
        <div class="field" style="align-self:end"><button class="sm primary" type="submit">Add fee (UNCERTAIN until verified)</button></div></form>`
      : ""
  }</div>`;
}


// Scoping intelligence (O5) --------------------------------------------------------------------------

const CONF_LABEL = { verified: "verified rule", rule_of_thumb: "rule of thumb", UNCERTAIN: "UNCERTAIN" };
const confBadge = (c) => badge(c === "verified" ? "ok" : c === "rule_of_thumb" ? "pending" : "UNCERTAIN", CONF_LABEL[c] ?? c);
const STRUCTURE_LABEL = { free_zone: "Free zone", mainland: "Mainland", offshore: "Offshore", difc_adgm: "DIFC or ADGM" };

function adviceHtml(a, opts = {}) {
  const item = (r) => `<li>${opts.editable && r.ruleKey ? `<label><input type="checkbox" name="keep" value="${esc(r.ruleKey)}" checked /> ` : ""}${esc(r.text)} ${confBadge(r.confidence)}${opts.editable && r.ruleKey ? "</label>" : ""}</li>`;
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

async function renderRequest(id) {
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

async function renderScoping() {
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

async function renderAgentQueue() {
  const drafts = await api("GET", "/api/ops/drafts");
  const canAct = ["ops", "founder"].includes(role());
  $app.innerHTML = `<h1>AI review queue</h1>
  <p class="muted">Drafts written by the model from what founders typed. Nothing here changes a request or reaches a client until a person approves it; discarded drafts are kept for the record.</p>
  <div class="stack">${
    drafts.length
      ? drafts.map((d) => `<form class="card" data-form="draft" data-id="${d.id}"><div class="row between"><h2>${esc(words(d.kind))} draft for ${esc(d.client ?? "")} ${badge("UNCERTAIN")}</h2><span class="small muted">${dateTime(d.createdAt)} · model ${esc(d.model)}</span></div>
        <p class="small muted">In the founder's words: <span style="white-space:pre-wrap">${esc(d.input?.description ?? "")}</span></p>
        ${d.output?.lines?.length ? `<ul class="plain">${d.output.lines.map((l) => `<li><label><input type="checkbox" name="keep" value="${esc(l.code)}" checked /> ${esc(nameOf(l.code))}${l.qty > 1 ? ` ×${l.qty}` : ""} <span class="small muted">(${esc(l.why)})</span></label></li>`).join("")}</ul>` : `<p class="small">No lines suggested.</p>`}
        ${d.output?.flags?.length ? `<p class="small">Flags: ${esc(d.output.flags.join("; "))}</p>` : ""}
        <p class="small muted">${esc(d.output?.summary ?? "")} <a href="#/request/${d.requestId}">Open the request</a></p>
        ${canAct ? `<div class="row"><input name="note" placeholder="Note (optional)" style="max-width:300px" /><button class="sm primary" type="submit" name="decision" value="approve">Approve: set the scope from the ticked lines</button><button class="sm" type="submit" name="decision" value="discard">Discard</button></div>` : ""}</form>`).join("")
      : `<p class="empty">Nothing waiting.</p>`
  }</div>`;
}

async function renderSearch(q) {
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

const ROLES_FOR = {
  client: ["client_owner", "client_member"],
  partner: ["partner_admin", "partner_staff"],
  platform: ["ops", "finance", "founder", "agent"],
};
const ORG_LABEL = { platform: "MKW Advisors", partner: "Partner firm", client: "Client" };

async function renderPeople() {
  const orgs = await api("GET", "/api/admin/orgs");
  const canWrite = ["ops", "founder"].includes(role());
  const founder = role() === "founder";
  // Ops manages clients and partners; MKW Advisors' own staff are the founder's business.
  const canManage = (o) => canWrite && (o.type !== "platform" || founder);
  const me = state.me.id;
  const userRow = (o, u) => {
    const manage = canManage(o) && u.status !== "erased";
    const roleSelect = manage && u.id !== me
      ? `<form class="row" data-form="role" data-id="${u.id}"><select name="role" style="width:auto">${ROLES_FOR[o.type]
          .map((r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${esc(words(r))}</option>`)
          .join("")}</select><button class="sm" type="submit">Change</button></form>`
      : esc(words(u.role));
    const actions = [];
    if (manage && u.id !== me && u.status === "active") actions.push(`<button class="sm" data-act="user-deactivate" data-id="${u.id}">Deactivate</button>`);
    if (manage && u.status === "deactivated") actions.push(`<button class="sm" data-act="user-reactivate" data-id="${u.id}">Reactivate</button>`);
    if (canWrite && (o.type !== "platform" || founder)) actions.push(`<button class="sm" data-act="user-export" data-id="${u.id}" data-name="${esc(u.name)}">Export data</button>`);
    if (founder && u.id !== me && u.status !== "erased") actions.push(`<button class="sm danger" data-act="user-erase" data-id="${u.id}" data-name="${esc(u.name)}">Erase</button>`);
    return `<tr><td>${esc(u.name)}${u.id === me ? ` <span class="small muted">(you)</span>` : ""}</td><td class="small">${esc(u.email)}</td><td>${roleSelect}</td>
      <td>${badge(u.status)}</td><td>${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}</td></tr>`;
  };
  const inviteForm = (o) =>
    canManage(o)
      ? `<form class="pad grid cols-3" data-form="invite" data-id="${o.id}" style="padding-top:8px;border-top:1px solid var(--line)">
          <input name="name" placeholder="Full name" required minlength="2" /><input name="email" type="email" placeholder="Work email" required />
          <div class="row"><select name="role">${ROLES_FOR[o.type].filter((r) => r !== "agent").map((r) => `<option value="${r}">${esc(words(r))}</option>`).join("")}</select>
          <button class="sm primary" type="submit">Invite</button></div></form>`
      : "";
  const orgCard = (o) => `<div class="card flush"><div class="row between" style="padding:16px 18px 0"><h2 style="padding:0">${esc(o.name)}</h2>
      <span>${badge(o.type, ORG_LABEL[o.type])}${o.profile ? ` ${badge(o.profile.status ?? o.status)}` : ""}</span></div>
    ${table(["Name", "Email", "Role", "Status", ""], o.users.map((u) => userRow(o, u)), "No users yet.")}
    ${inviteForm(o)}</div>`;
  const platform = orgs.filter((o) => o.type === "platform");
  const partners = orgs.filter((o) => o.type === "partner");
  const clients = orgs.filter((o) => o.type === "client");
  $app.innerHTML = `
  <h1>People and organisations</h1>
  <p class="muted">Invite people, change roles and deactivate accounts here, so nobody touches the database by hand. Every change is in the audit trail.
    ${canWrite ? "" : " Finance can view this page but not change it."}${canWrite && !founder ? " MKW Advisors staff are managed by the founder." : ""}</p>
  <div class="kpis">
    <div class="kpi"><b>${partners.length}</b><span>Partner firms</span></div>
    <div class="kpi"><b>${clients.length}</b><span>Client companies</span></div>
    <div class="kpi"><b>${orgs.reduce((n, o) => n + o.users.filter((u) => u.status === "active").length, 0)}</b><span>Active users</span></div>
    <div class="kpi"><b>${orgs.reduce((n, o) => n + o.users.filter((u) => u.status !== "active").length, 0)}</b><span>Deactivated or erased</span></div>
  </div>
  ${
    canWrite
      ? `<form class="card" data-form="new-partner"><h2>Add a partner firm</h2>
        <p class="small muted">Creates the firm and its first admin, who can sign in at once. The firm starts as a prospect: it receives work only after its licence and the signed Partner Network Agreement are on file and ops marks it signed on the Partners page.</p>
        <div class="grid cols-3">
          <div class="field"><label>Firm name</label><input name="name" required minlength="2" placeholder="e.g. Example Corporate Services LLC" /></div>
          <div class="field"><label>Admin name</label><input name="adminName" required minlength="2" /></div>
          <div class="field"><label>Admin work email</label><input name="adminEmail" type="email" required /></div>
          <div class="field"><label>Emirates served (comma separated)</label><input name="emirates" placeholder="Dubai, Sharjah" /></div>
          <div class="field"><label>Service codes (comma separated)</label><input name="codes" placeholder="SET-FZ-LIC, VISA-RES" /></div>
          <div class="field"><label>Capacity (live jobs)</label><input name="capacity" type="number" min="0" max="500" value="10" /></div>
        </div><button class="primary" type="submit">Create partner firm</button></form><br>`
      : ""
  }
  <div class="stack">
    <h2 style="margin:0">MKW Advisors</h2>${platform.map(orgCard).join("")}
    <h2 style="margin:8px 0 0">Partner firms</h2>${partners.map(orgCard).join("") || `<p class="empty">No partner firms yet.</p>`}
    <h2 style="margin:8px 0 0">Clients</h2>${clients.map(orgCard).join("") || `<p class="empty">No clients yet.</p>`}
  </div>
  <p class="small muted" style="margin-top:16px">Data requests under the UAE PDPL: <b>Export data</b> downloads everything held about a person as JSON. <b>Erase</b> (founder only) replaces the person's name, email and messages with tombstones and ends their access, while payments, offers and the audit trail stay as tax law requires. Erasure cannot be undone.</p>`;
}

// Settings: retention -------------------------------------------------------------------------

const RETENTION_LABEL = {
  taxRecords: "Tax and accounting records",
  clientDocuments: "Client documents and evidence files",
  messages: "Engagement messages",
  auditTrail: "Audit trail",
  sessions: "Sign-in sessions",
  loginCodes: "Sign-in codes",
};

async function renderSettings() {
  const r = await api("GET", "/api/admin/settings/retention");
  const founder = role() === "founder";
  const periodText = (p) => (p.years === null && p.days == null ? "Indefinitely" : p.years != null ? `${p.years} years` : `${p.days} days`);
  $app.innerHTML = `
  <h1>Settings</h1>
  <h2>Retention periods ${badge(r.confirmed ? "verified" : "UNCERTAIN", r.confirmed ? "confirmed" : "not yet confirmed")}</h2>
  <p class="muted">How long each kind of record is kept. ${
    r.confirmed ? `Confirmed on ${date(r.confirmedAt)} after legal advice.` : "The defaults below are working assumptions marked UNCERTAIN until the founder confirms them after legal advice."
  } Nothing is deleted automatically yet; these periods are recorded so that deletion, when it is built, follows a confirmed rule.</p>
  <form class="card flush" data-form="retention">${table(
    ["Record", founder ? "Period (edit)" : "Period", "Basis", "Confidence"],
    Object.entries(r.periods).map(
      ([k, p]) => `<tr><td>${esc(RETENTION_LABEL[k] ?? k)}</td>
        <td>${founder && (p.years != null || p.days != null) ? `<input name="${k}" type="number" min="0" max="${p.years != null ? 100 : 36500}" value="${p.years ?? p.days}" style="width:90px" /> ${p.years != null ? "years" : "days"}` : esc(periodText(p))}</td>
        <td class="small">${esc(p.basis)}</td><td>${badge(p.confidence)}</td></tr>`,
    ),
  )}
  ${
    founder
      ? `<div class="pad" style="padding-top:8px"><div class="field"><label>Who confirmed these periods, and when</label><input name="note" required minlength="3" placeholder="e.g. Confirmed with [law firm] on 20 Oct 2026" /></div>
        <button class="primary" type="submit">Confirm retention periods</button></div>`
      : `<p class="small muted pad">Only the founder can confirm these periods.</p>`
  }</form>
  ${await renderCompany()}
  ${await renderDeliveryLog()}`;
}

async function renderCompany() {
  const c = await api("GET", "/api/admin/company");
  const founder = role() === "founder";
  const fields = (ro) => `<div class="grid cols-3">
    <div class="field"><label>Legal name on invoices</label><input name="legalName" value="${esc(c.legalName)}" ${ro} /></div>
    <div class="field"><label>TRN (15 digits) ${c.trn ? badge("ok", "set") : badge("UNCERTAIN", "missing: invoices held")}</label><input name="trn" value="${esc(c.trn ?? "")}" inputmode="numeric" pattern="\\d{15}" ${ro} /></div>
    <div class="field"><label>Address</label><input name="address" value="${esc(c.address ?? "")}" ${ro} /></div>
    <div class="field"><label>Bank name (for client transfers)</label><input name="bankName" value="${esc(c.bankName ?? "")}" ${ro} /></div>
    <div class="field"><label>IBAN</label><input name="iban" value="${esc(c.iban ?? "")}" ${ro} /></div>
    <div class="field"><label>SWIFT</label><input name="swift" value="${esc(c.swift ?? "")}" ${ro} /></div>
  </div>`;
  return `<h2 style="margin-top:24px">Company details for invoices ${c.heldInvoices ? badge("UNCERTAIN", `${c.heldInvoices} invoice(s) held`) : ""}</h2>
  <form class="card" data-form="company">${fields(founder ? "" : "readonly")}
    <p class="small muted">Government fees are shown on invoices as disbursements at cost with no VAT: ${badge(c.govFeesAsDisbursements?.confidence ?? "UNCERTAIN")} ${esc(c.govFeesAsDisbursements?.basis ?? "")}</p>
    ${
      founder
        ? `<div class="field"><label>Why</label><input name="note" required minlength="3" placeholder="e.g. TRN from the FTA certificate dated ..." /></div>
           <label class="small"><input type="checkbox" name="govFeesConfirmed" /> The tax adviser has confirmed the disbursement treatment</label>
           <div class="row" style="margin-top:8px"><button class="primary" type="submit">Save company details</button>${c.heldInvoices && c.trn ? `<button type="button" class="sm" data-act="issue-held">Issue ${c.heldInvoices} held invoice(s)</button>` : ""}</div>`
        : `<p class="small muted">Only the founder changes these.</p>`
    }</form>`;
}

// Events ----------------------------------------------------------------------------------

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const { act: a, id } = el.dataset;
  const handlers = {
    logout: () =>
      act(async () => {
        await api("POST", "/api/auth/logout");
        state.me = null;
        location.hash = "#/";
      }, "Signed out"),
    restart: () => renderSignIn(),
    demo: () => requestCode(el.dataset.email).catch((e) => toast(e.message, true)),
    "accept-offer": () => {
      if (!confirm("Accept this offer? We will send the deposit invoice and start allocating the work once it is paid.")) return;
      act(async () => {
        const r = await api("POST", `/api/client/offers/${id}/accept`);
        location.hash = `#/engagement/${r.engagementId}`;
      }, "Offer accepted. Your deposit invoice is on its way.");
    },
    "ms-start": () => act(() => api("POST", `/api/milestones/${id}/start`), "Started"),
    "ms-submit": () => act(() => api("POST", `/api/milestones/${id}/submit`), "Sent to MKW Advisors for checking"),
    "ms-qa": () => {
      const pass = el.dataset.pass === "1";
      const note = pass ? undefined : prompt("What needs to change? The partner sees this note.");
      if (!pass && !note) return;
      act(() => api("POST", `/api/ops/milestones/${id}/qa`, { pass, note }), pass ? "Passed to the client for approval" : "Sent back to the partner");
    },
    "ms-resolve": () => act(() => api("POST", `/api/ops/milestones/${id}/resolve`, { outcome: el.dataset.outcome }), "Resolved"),
    "ms-review": () => {
      const approve = el.dataset.approve === "1";
      const reason = approve ? undefined : prompt("What is wrong? MKW Advisors will look at it with the partner.");
      if (!approve && !reason) return;
      act(() => api("POST", `/api/milestones/${id}/review`, { approve, reason }), approve ? "Approved. Thank you." : "Issue raised");
    },
    "co-decide": () => act(() => api("POST", `/api/change-orders/${id}/decide`, { approve: el.dataset.approve === "1" })),
    alloc: () => {
      const decision = el.dataset.decision;
      const reason = decision === "decline" ? prompt("Why are you declining? This helps us route work better.") : undefined;
      if (decision === "decline" && !reason) return;
      act(() => api("POST", `/api/allocations/${id}/respond`, { decision, reason }), decision === "accept" ? "Accepted. The steps are now on the engagement." : "Declined");
    },
    "mark-paid": () => {
      const reference = prompt("Bank or card reference for this payment");
      if (!reference) return;
      act(() => api("POST", `/api/ops/payments/${id}/mark-paid`, { reference }), "Payment recorded");
    },
    release: () => {
      if (!confirm("Release this payout? Record the bank transfer reference in your accounts.")) return;
      act(() => api("POST", `/api/ops/payouts/${id}/release`), "Payout released");
    },
    reallocate: () => act(() => api("POST", `/api/ops/engagements/${id}/reallocate`), "Allocation run"),
    build: () =>
      act(async () => {
        const r = await api("POST", `/api/ops/requests/${id}/build-offers`, {});
        if (r.missing?.length) toast(`No rate card for ${r.missing.join(", ")}. Ask partners for a price.`, true);
      }, "Offers built"),
    rfq: () => {
      const codes = (prompt("Service codes to ask partners about (comma separated)", el.dataset.codes) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!codes.length) return;
      act(() => api("POST", `/api/ops/requests/${id}/rfq`, { codes }), "Sent to up to 5 partners for sealed quotes");
    },
    publish: () => {
      const flagged = Number(el.dataset.review || 0);
      if (flagged && !confirm(`${flagged} line(s) are flagged (margin below the floor or a government fee that is UNCERTAIN or stale). Publishing records that you checked them. Publish?`)) return;
      act(() => api("POST", `/api/ops/offers/${id}/publish`, { acknowledgeReview: flagged > 0 }), "Published to the client");
    },
    "run-jobs": () =>
      act(async () => {
        const r = await api("POST", "/api/ops/jobs/run");
        toast(`Timers run: ${r.allocationTimeouts} re-routed, ${r.autoApprovals} auto-approved, ${r.offersExpired} offers expired`);
      }, null),
    "partner-status": () => act(() => api("PUT", `/api/ops/partners/${id}`, { status: el.dataset.status }), "Partner updated"),
    refund: () => {
      const reference = prompt("Bank or card reference of the refund");
      if (!reference) return;
      const reason = prompt("Why is this payment being refunded? (recorded in the audit trail)");
      if (!reason) return;
      if (!confirm("Refund this payment in full? A credit note is issued and unreleased partner payouts on the engagement are withheld.")) return;
      act(() => api("POST", `/api/ops/payments/${id}/refund`, { reference, reason }), "Refund recorded; credit note issued");
    },
    "run-create": () => {
      if (!confirm("Create a payout run with every ready payout?")) return;
      act(async () => {
        const r = await api("POST", "/api/ops/payout-runs");
        toast(`Run ${r.reference} created: ${r.payouts} payout(s), ${aed(r.total)}`);
      }, null);
    },
    "run-paid": () => {
      const bankReference = prompt("Bank reference of the bulk transfer");
      if (!bankReference) return;
      if (!confirm("Mark this run paid? Every payout in it is released and each partner receives a remittance advice.")) return;
      act(() => api("POST", `/api/ops/payout-runs/${id}/paid`, { bankReference }), "Run paid; payouts released");
    },
    "run-cancel": () => {
      const reason = prompt("Why cancel this run? Payouts return to the ready list.");
      if (!reason) return;
      const exported = el.dataset.exported === "1";
      if (exported && !confirm("This run's bank file was already downloaded. Cancel ONLY if the file was never submitted to the bank; otherwise partners would be paid twice. Confirm the file was not submitted?")) return;
      act(() => api("POST", `/api/ops/payout-runs/${id}/cancel`, { reason, confirmNotSubmitted: exported }), "Run cancelled");
    },
    "issue-held": () => act(async () => {
      const r = await api("POST", "/api/admin/invoices/issue-held");
      toast(`Issued ${r.issued.length} invoice(s): ${r.issued.join(", ")}`);
    }, null),
    "recompute-advice": () => act(() => api("POST", `/api/ops/requests/${id}/scoping/recompute`), "Advice recomputed; review it again"),
    "fee-verify": () => {
      const verifiedBy = prompt("Who verified this fee against its source? Name and qualification.");
      if (!verifiedBy) return;
      act(() => api("POST", `/api/admin/fees/${id}/verify`, { verifiedBy }), "Fee marked verified");
    },
    "fee-retire": () => {
      const reason = prompt("Why is this fee row being retired?");
      if (!reason) return;
      act(() => api("POST", `/api/admin/fees/${id}/retire`, { reason }), "Fee retired");
    },
    "read-all": () => act(() => api("POST", "/api/notifications/read", {}), "All read"),
    "read-one": () => {
      if (!el.classList.contains("unread") || ev.target.closest("a")) return;
      act(() => api("POST", "/api/notifications/read", { ids: [id] }), null);
    },
    "user-deactivate": () => {
      if (!confirm("Deactivate this account? They are signed out everywhere and cannot sign in again until reactivated.")) return;
      act(() => api("POST", `/api/admin/users/${id}/deactivate`), "Account deactivated");
    },
    "user-reactivate": () => act(() => api("POST", `/api/admin/users/${id}/reactivate`), "Account reactivated"),
    "user-export": () =>
      act(async () => {
        const data = await api("POST", `/api/admin/users/${id}/export`);
        download(`person-${id}.json`, JSON.stringify(data, null, 2));
      }, `Export of ${el.dataset.name}'s data downloaded and recorded`),
    "user-erase": () => {
      const typed = prompt(`Erase ${el.dataset.name}'s personal data? This cannot be undone. Their name, email and messages become tombstones; payments and the audit trail stay. Type ERASE to confirm.`);
      if (typed !== "ERASE") return typed === null ? undefined : toast("Not erased: type ERASE exactly to confirm", true);
      act(() => api("POST", `/api/admin/users/${id}/erase`, { confirm: "ERASE" }), "Personal data erased and recorded");
    },
    "add-client": () => {
      const f = el.closest("form");
      const body = { company: f.newCompany.value.trim(), ownerName: f.newOwner.value.trim(), ownerEmail: f.newEmail.value.trim() };
      act(() => api("POST", "/api/ops/clients", body), "Client added");
    },
  };
  handlers[a]?.();
});

document.addEventListener("submit", (ev) => {
  const form = ev.target.closest("form[data-form]");
  if (!form) return;
  ev.preventDefault();
  const fd = new FormData(form);
  const id = form.dataset.id;
  const kind = form.dataset.form;
  if (kind === "request-code") return requestCode(String(fd.get("email"))).catch((e) => toast(e.message, true));
  if (kind === "verify")
    return api("POST", "/api/auth/verify", { email: String(fd.get("email")), code: String(fd.get("code")) })
      .then((r) => {
        state.me = r.user;
        if (location.hash && location.hash !== "#/") location.hash = "#/";
        else render();
      })
      .catch((e) => toast(e.message, true));
  if (kind === "intake") {
    const mode = String(fd.get("mode"));
    const extras = fd.getAll("extra").map(String);
    const answers = {
      mode,
      emirate: String(fd.get("emirate")),
      ...(mode === "new_company"
        ? {
            jurisdiction: String(fd.get("jurisdiction")),
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
    if (mode === "services" && !extras.length) return toast("Choose at least one service", true);
    return act(async () => {
      const r = await api("POST", "/api/requests", { answers, ...(isPlatform() ? { clientOrgId: String(fd.get("clientOrgId")) } : {}) });
      if (r.notes?.length) toast(r.notes.join(". "));
      location.hash = isPlatform() ? "#/pipeline" : "#/";
    }, "Request received. We will send your offers shortly.");
  }
  if (kind === "evidence") {
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) return toast("Choose a file", true);
    if (file.size > 15 * 1024 * 1024) return toast("Files must be under 15 MB", true);
    return act(async () => {
      await api("POST", `/api/milestones/${id}/evidence`, { type: String(fd.get("type")), fileName: file.name, contentBase64: await fileToBase64(file) });
    }, "Evidence uploaded");
  }
  if (kind === "message") return act(() => api("POST", `/api/engagements/${id}/messages`, { body: String(fd.get("body")) }), "Sent");
  if (kind === "change-order")
    return act(
      () => api("POST", `/api/engagements/${id}/change-orders`, { description: String(fd.get("description")), partnerCostAed: Number(fd.get("partnerCostAed")) }),
      "Sent to MKW Advisors to price for the client",
    );
  if (kind === "override") return act(() => api("POST", `/api/ops/offers/${id}/lines/${form.dataset.code}/price`, { clientUnitAed: Number(fd.get("aed")) }), "Price set");
  if (kind === "rate-card") {
    const card = {
      code: String(fd.get("code")),
      professionalAed: Number(fd.get("professionalAed")),
      govStatedAed: Number(fd.get("govStatedAed") || 0),
      thirdPartyAed: Number(fd.get("thirdPartyAed") || 0),
      workingDays: Number(fd.get("workingDays")),
      exclusions: String(fd.get("exclusions") || "").split("\n").map((s) => s.trim()).filter(Boolean),
    };
    return act(() => api("PUT", "/api/partner/rate-cards", { cards: [card] }), "Price saved for 90 days");
  }
  if (kind === "search") {
    const q = String(fd.get("q") || "").trim();
    if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
    return;
  }
  if (kind === "approve-advice") {
    const all = [...form.querySelectorAll('input[name="keep"]')].map((i) => i.value);
    const kept = fd.getAll("keep").map(String);
    const allPlaces = [...form.querySelectorAll('input[name="keepPlace"]')].map((i) => i.value);
    const keptPlaces = fd.getAll("keepPlace").map(String);
    const body = { removeRuleKeys: all.filter((k) => !kept.includes(k)), removePlaces: allPlaces.filter((p) => !keptPlaces.includes(p)), structure: String(fd.get("structure") || "") || undefined, note: String(fd.get("note") || "") || undefined };
    if (!confirm("Approve this advice for the client? Items left UNCERTAIN are shown with that label.")) return;
    return act(() => api("POST", `/api/ops/requests/${id}/scoping/approve`, body), "Advice approved; the client can see it now");
  }
  if (kind === "verify-rule" || kind === "verify-zone") {
    const body = { confidence: String(fd.get("confidence")), verifiedBy: String(fd.get("verifiedBy") || "") || undefined, sourceUrl: String(fd.get("sourceUrl") || "") || undefined };
    return act(() => api("PUT", `/api/admin/scoping/${kind === "verify-rule" ? "rules" : "zones"}/${encodeURIComponent(id)}`, body), "Recorded");
  }
  if (kind === "draft") {
    const decision = ev.submitter?.value || "discard";
    const keepCodes = fd.getAll("keep").map(String);
    if (decision === "approve" && !confirm("Set the request's scope from the ticked lines? The request is then priced from them.")) return;
    return act(() => api("POST", `/api/ops/drafts/${id}/review`, { decision, note: String(fd.get("note") || ""), ...(decision === "approve" ? { keepCodes } : {}) }), decision === "approve" ? "Draft approved and applied" : "Draft discarded");
  }
  if (kind === "bank") return act(() => api("PUT", "/api/partner/bank", { beneficiary: String(fd.get("beneficiary")), iban: String(fd.get("iban")), bank: String(fd.get("bank")) }), "Bank details saved");
  if (kind === "partner-invoice") {
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) return toast("Attach your invoice file", true);
    return act(async () => {
      await api("POST", `/api/payouts/${id}/invoice`, { number: String(fd.get("number")), amountAed: Number(form.dataset.amount) / 100, vatAed: Number(fd.get("vatAed") || 0), fileName: file.name, contentBase64: await fileToBase64(file) });
    }, "Invoice uploaded; MKW Advisors pays it in the next run");
  }
  if (kind === "company") {
    const body = { note: String(fd.get("note")), govFeesConfirmed: fd.get("govFeesConfirmed") === "on" };
    for (const k of ["legalName", "trn", "address", "bankName", "iban", "swift"]) body[k] = String(fd.get(k) ?? "");
    if (!body.trn) body.trn = null;
    return act(() => api("PUT", "/api/admin/company", body), "Company details saved");
  }
  if (kind === "rule") {
    const body = { rateBp: Math.round(Number(fd.get("ratePct")) * 100), floorAed: Number(fd.get("floorAed")), effectiveFrom: String(fd.get("effectiveFrom")), note: String(fd.get("note")) };
    if (!confirm(`Set ${id} to ${Number(fd.get("ratePct"))}% with a floor of AED ${body.floorAed} from ${body.effectiveFrom}? Offers already built keep their rules.`)) return;
    return act(() => api("PUT", `/api/admin/rules/${encodeURIComponent(id)}`, body), "Rule scheduled");
  }
  if (kind === "pricing-settings")
    return act(() => api("PUT", "/api/admin/pricing-settings", { capFactorBp: Math.round(Number(fd.get("capFactor")) * 10000), roundToAed: Number(fd.get("roundToAed")), note: String(fd.get("note")) }), "Settings saved");
  if (kind === "fee") {
    const body = {
      code: String(fd.get("code")),
      emirate: String(fd.get("emirate")),
      freeZone: String(fd.get("freeZone") || "") || null,
      feeAed: Number(fd.get("feeAed")),
      sourceUrl: String(fd.get("sourceUrl") || ""),
      sourceNote: String(fd.get("sourceNote") || ""),
      effectiveFrom: String(fd.get("effectiveFrom") || "") || undefined,
    };
    return act(() => api("POST", "/api/admin/fees", body), "Fee added as UNCERTAIN");
  }
  if (kind === "new-partner") {
    const list = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
    const body = {
      name: String(fd.get("name")),
      adminName: String(fd.get("adminName")),
      adminEmail: String(fd.get("adminEmail")),
      emirates: list(fd.get("emirates")),
      codes: list(fd.get("codes")).map((c) => c.toUpperCase()),
      capacity: Number(fd.get("capacity") || 10),
    };
    return act(() => api("POST", "/api/admin/partners", body), "Partner firm created; its admin can sign in now");
  }
  if (kind === "invite") return act(() => api("POST", `/api/admin/orgs/${id}/users`, { name: String(fd.get("name")), email: String(fd.get("email")), role: String(fd.get("role")) }), "Invited");
  if (kind === "role") return act(() => api("POST", `/api/admin/users/${id}/role`, { role: String(fd.get("role")) }), "Role changed");
  if (kind === "retention") {
    const periods = {};
    for (const [k, v] of fd.entries()) {
      if (k === "note" || v === "") continue;
      periods[k] = ["sessions", "loginCodes"].includes(k) ? { days: Number(v) } : { years: Number(v) };
    }
    if (!confirm("Confirm these retention periods? Each becomes 'verified' and the change is recorded in the audit trail with your note.")) return;
    return act(() => api("PUT", "/api/admin/settings/retention", { periods, note: String(fd.get("note")) }), "Retention periods confirmed");
  }
  if (kind === "quote") {
    const lines = [...form.querySelectorAll("[data-line]")].map((row) => {
      const code = row.dataset.line;
      return {
        code,
        professionalAed: Number(fd.get(`prof-${code}`)),
        govStatedAed: Number(fd.get(`gov-${code}`) || 0),
        workingDays: Number(fd.get(`days-${code}`)),
        exclusions: String(fd.get(`excl-${code}`) || "").split("\n").map((s) => s.trim()).filter(Boolean),
      };
    });
    return act(() => api("POST", `/api/rfqs/${id}/quote`, { lines }), "Sealed quote sent");
  }
});

// Start -------------------------------------------------------------------------------------

(async () => {
  try {
    state.health = await api("GET", "/api/health");
  } catch {
    state.health = { ok: false };
  }
  try {
    state.me = await api("GET", "/api/me");
  } catch {
    state.me = null;
  }
  render();
})();

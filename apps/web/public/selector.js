// Right UAE Entity public selector (E3, D80; E7A): a homepage, questions one at a time ordered by the industry, a
// public assessment from the platform shown as a decision (profile, structures, places compared, approved guidance,
// one next action), and a review request through the public intake. No sign-in, nothing stored until the person asks.
import { translateTree } from "./i18n-ar.js";

(async () => {
  const want = new URLSearchParams(location.search).get("lang") === "ar";
  if (!want) return;
  try {
    const h = await (await fetch("/api/health")).json();
    if (!h.arabic) return;
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
    translateTree(document.body);
  } catch {}
})();

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const aed = (fils) => "AED " + (Number(fils) / 100).toLocaleString("en-AE", { maximumFractionDigits: 0 });
const words = (s) => String(s ?? "").replace(/_/g, " ");
const STRUCTURE = { free_zone: "Free zone", mainland: "Mainland", offshore: "Offshore", difc_adgm: "DIFC or ADGM" };
const STATUS = {
  ELIGIBLE_VERIFIED: ["ok", "fits"],
  ELIGIBLE_CONDITIONAL: ["info", "fits, with conditions"],
  REQUIRES_VERIFICATION: ["", "to be verified"],
  DATA_UNAVAILABLE: ["warn", "data missing"],
  INELIGIBLE: ["bad", "does not fit"],
};
const badge = (status) => `<span class="badge ${STATUS[status]?.[0] ?? ""}">${esc(STATUS[status]?.[1] ?? words(status))}</span>`;
const verify = `<span class="verify">to be verified by a person</span>`;
const isAr = () => document.documentElement.lang === "ar";
const $ = (id) => document.getElementById(id);

// The questions, each shown when it applies, with the reason it is asked. Answers are kept in memory only.
const answers = { emirate: "Dubai" };
const QUESTIONS = {
  activity: { title: "What will the business mainly do?", why: "The activity decides which licences apply, which places list it, and whether a regulator is involved.", type: "choice", options: [
    ["consulting", "Consulting or professional services", "including accounting and bookkeeping"], ["trading", "Trading goods"], ["ecommerce", "Selling online"], ["tech", "Software or technology"],
    ["holding", "Holding company", "owning shares or assets, no trading"], ["finance", "Regulated financial services", "banking, lending, investment, insurance, payments"], ["virtual_assets", "Virtual assets or crypto"],
    ["health", "Health or medical"], ["education", "Education or training"], ["food", "Food and restaurants"], ["construction", "Construction or real estate"], ["manufacturing", "Manufacturing"], ["other", "Something else"],
  ] },
  customers: { title: "Where are your customers?", why: "Selling inside the UAE is the main difference between a mainland and a free zone licence.", type: "choice", options: [["international", "Outside the UAE"], ["uae_mainland", "Inside the UAE"], ["both", "Both"]] },
  visas: { title: "How many residence visas do you need?", why: "Each place comes with a number of visas, and some structures sponsor none.", type: "number", hint: "Count yourself, partners and staff who will live in the UAE. Zero is fine.", min: 0, max: 50 },
  premises: { title: "What premises does the business need?", why: "Premises decide which places can host the business, and a licence usually needs a matching lease.", type: "choice", when: () => answers.activity !== "holding", options: [
    ["none", "None", "no physical place of business"], ["virtual", "A virtual office or desk"], ["office", "An office"], ["retail", "A shop or showroom"], ["warehouse", "A warehouse"], ["industrial", "An industrial plot or unit"], ["clinic", "A clinic or licensed premises"],
  ] },
  budgetAed: { title: "What is your setup budget, in AED?", why: "Places whose checked setup estimate is above it are shown as not fitting; leave it empty to see every place.", type: "number", hint: "Optional. Places above it are shown as not fitting.", min: 0, max: 100000000, optional: true },
  owners: { title: "Who will own the company?", why: "A company as owner brings its own documents, beneficial-owner checks and tax questions.", type: "choice", options: [["individuals", "One or more individuals"], ["company", "A company"]] },
  foreignTaxResident: { title: "Is any owner tax resident outside the UAE?", why: "Another country's tax rules can reach a UAE company through its owners; a specialist reviews that.", type: "choice", options: [["yes", "Yes"], ["no", "No"], ["unsure", "Not sure"]] },
  turnover: { title: "What yearly revenue do you expect, in AED?", why: "It decides which tax registration points apply. Nothing is calculated here.", type: "number", hint: "Optional. A rough figure is enough.", min: 0, max: 10000000000, optional: true, when: () => answers.activity !== "holding" },
  startWithin: { title: "When do you want to start?", why: "It tells MKW Advisors how soon to act; it changes nothing in the result.", type: "choice", optional: true, hint: "Optional.", options: [["1_month", "Within a month"], ["3_months", "Within three months"], ["later", "Later, I am exploring"]] },
  structure: { title: "Do you already have a structure in mind?", why: "If your answers point elsewhere, the result says so and a person confirms which fits.", type: "choice", options: [["not_sure", "Not yet", "show me what fits"], ["free_zone", "A free zone company"], ["mainland", "A mainland company"], ["offshore", "An offshore company"], ["difc_adgm", "DIFC or ADGM"]] },
  emirate: { title: "Which emirate, and is there a place you have in mind?", why: "The emirate narrows the places; naming one puts it at the top of the comparison.", type: "emirate" },
};
const EMIRATES = ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Umm Al Quwain", "Fujairah"];
// The order follows what matters first for the industry chosen: premises for manufacturing, owners for a holding
// company, the customers and owners for regulated activity. The engine reads the same answers whatever the order.
const DEFAULT_ORDER = ["activity", "customers", "visas", "premises", "budgetAed", "owners", "foreignTaxResident", "turnover", "structure", "startWithin", "emirate"];
const ORDER = {
  manufacturing: ["activity", "premises", "customers", "visas", "budgetAed", "owners", "foreignTaxResident", "turnover", "structure", "startWithin", "emirate"],
  holding: ["activity", "owners", "foreignTaxResident", "customers", "visas", "budgetAed", "structure", "startWithin", "emirate"],
  finance: ["activity", "customers", "owners", "foreignTaxResident", "visas", "premises", "budgetAed", "turnover", "structure", "startWithin", "emirate"],
  virtual_assets: ["activity", "customers", "owners", "foreignTaxResident", "visas", "premises", "budgetAed", "turnover", "structure", "startWithin", "emirate"],
};
const visible = () => (ORDER[answers.activity] ?? DEFAULT_ORDER).map((k) => ({ key: k, ...QUESTIONS[k] })).filter((q) => !q.when || q.when());

let i = 0;
// Attribution (E4): the UTM fields, the referrer and the landing page, read once and kept for the session.
const params = new URLSearchParams(location.search);
const attribution = {
  source: params.get("utm_source") || undefined, medium: params.get("utm_medium") || undefined, campaign: params.get("utm_campaign") || params.get("campaign") || undefined,
  term: params.get("utm_term") || undefined, content: params.get("utm_content") || undefined, referrer: document.referrer || undefined,
  // The landing page without the recovery code: the code is a key to the saved answers and is never recorded.
  landing: (() => { const p = new URLSearchParams(location.search); p.delete("code"); return (location.pathname + (p.toString() ? `?${p}` : "")).slice(0, 200); })(),
};
let savedCode = null;
let lastResult = null;
// E7C: aggregate, anonymous measurement. A random id the browser keeps for this session only (no cookie, nothing
// stored beyond the tab's session), the stage reached and the question step; sent in small batches, repeats ignored
// by the platform. It never carries a contact detail; the review request carries the same id so the funnel joins.
const visitor = (() => {
  try {
    let v = sessionStorage.getItem("tasees-visitor");
    if (!v || !/^[A-Za-z0-9_-]{8,32}$/.test(v)) { v = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join(""); sessionStorage.setItem("tasees-visitor", v); }
    return v;
  } catch { return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join(""); }
})();
attribution.visitor = visitor;
let pending = [];
let flushTimer = null;
const sent = new Set();
function track(stage, key = "") {
  const id = `${stage}:${key}`;
  if (sent.has(id)) return;
  sent.add(id);
  pending.push({ stage, ...(key ? { key } : {}) });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 800);
}
function flush() {
  if (!pending.length) return;
  const events = pending.splice(0, 40);
  fetch("/api/public/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visitor, events, attribution }), keepalive: true }).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { clearTimeout(flushTimer); flush(); } });
track("visited");
// The consent texts come from the platform, so the page and the record always carry the same version.
fetch("/api/public/consent-texts").then((r) => r.json()).then((t) => { $("marketing-text").textContent = t.marketing.text; $("partner-text").textContent = t.partner_disclosure.text; }).catch(() => {});

// Which of the three views is on: the homepage, the questions or the result.
function show(view) {
  $("landing").hidden = view !== "landing";
  $("questions").hidden = view !== "questions";
  $("result").hidden = view !== "result";
  $("review").hidden = view !== "result";
  $("recover").hidden = view === "questions";
}

function render() {
  const qs = visible();
  const q = qs[i];
  $("progress").textContent = `Question ${i + 1} of ${qs.length}`;
  $("progress-left").textContent = i === qs.length - 1 ? "Last one" : `${qs.length - i - 1} to go`;
  $("bar").value = Math.round((100 * i) / qs.length);
  $("back").hidden = i === 0;
  $("next").textContent = i === qs.length - 1 ? "See what fits" : "Next";
  const v = answers[q.key];
  let html = `<h2 id="qtitle">${esc(q.title)}</h2>${q.hint ? `<p class="small muted">${esc(q.hint)}</p>` : ""}`;
  if (q.type === "choice") {
    html += `<div class="choices" role="group" aria-labelledby="qtitle">${q.options.map(([val, label, sub]) => `<button type="button" class="choice" data-val="${esc(val)}" aria-pressed="${v === val}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</button>`).join("")}</div>`;
  } else if (q.type === "number") {
    html += `<div class="field"><label for="qnum" class="small">${q.optional ? "Amount (leave empty to skip)" : "Number"}</label><input id="qnum" type="number" inputmode="numeric" min="${q.min}" max="${q.max}" value="${v ?? ""}" style="max-width:200px" /></div>`;
  } else {
    html += `<div class="grid cols-2"><div class="field"><label for="qemirate">Emirate</label><select id="qemirate">${EMIRATES.map((e) => `<option ${answers.emirate === e ? "selected" : ""}>${e}</option>`).join("")}</select></div>
      <div class="field"><label for="qzone">A free zone or authority you have in mind (optional)</label><input id="qzone" value="${esc(answers.freeZone ?? "")}" placeholder="for example IFZA, SHAMS, DIFC" /></div></div>`;
  }
  html += `<p class="why"><b>Why we ask:</b> ${esc(q.why)}</p>`;
  track("step_reached", q.key);
  $("step").innerHTML = html;
  $("qmsg").hidden = true;
  for (const b of $("step").querySelectorAll(".choice")) {
    b.addEventListener("click", () => {
      answers[q.key] = b.dataset.val;
      for (const o of $("step").querySelectorAll(".choice")) o.setAttribute("aria-pressed", String(o === b));
    });
  }
  // Enter on a number field moves on, as on a form.
  $("step").querySelector("#qnum, #qzone")?.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); $("next").click(); } });
  if (isAr()) translateTree($("questions"));
  ($("step").querySelector(".choice[aria-pressed='true']") ?? $("step").querySelector("#qnum, .choice, #qemirate") ?? $("next")).focus();
}

function take() {
  const q = visible()[i];
  if (q.type === "choice" && !answers[q.key] && !q.optional) return "Choose one to continue.";
  if (q.type === "number") {
    const raw = $("qnum").value.trim();
    if (!raw && !q.optional) return "Enter a number (zero is fine).";
    if (raw && !/^\d+$/.test(raw)) return "Whole numbers only.";
    const n = raw ? Number(raw) : null;
    if (n !== null && (n < q.min || n > q.max)) return `Between ${q.min} and ${q.max}.`;
    answers[q.key] = n;
  }
  if (q.type === "emirate") {
    answers.emirate = $("qemirate").value;
    answers.freeZone = $("qzone").value.trim() || undefined;
  }
  return null;
}

// Only the answers to questions that apply are sent: a premises answer given before "holding" was chosen is dropped.
const body = () => {
  const keys = new Set(visible().map((q) => q.key));
  for (const k of Object.keys(answers)) if (k !== "emirate" && k !== "freeZone" && !keys.has(k)) delete answers[k];
  return {
    emirate: answers.emirate,
    jurisdiction: answers.structure ?? "not_sure",
    freeZone: answers.freeZone,
    activity: answers.activity,
    customers: answers.customers,
    visas: answers.visas ?? 0,
    ...(answers.premises ? { premises: answers.premises } : {}),
    ...(answers.budgetAed != null ? { budgetAed: answers.budgetAed } : {}),
    ...(answers.turnover != null ? { expectedTurnoverAed: answers.turnover } : {}),
    ...(answers.startWithin ? { startWithin: answers.startWithin } : {}),
    ownerType: answers.owners,
    ...(answers.foreignTaxResident === "yes" ? { foreignTaxResident: true } : answers.foreignTaxResident === "no" ? { foreignTaxResident: false } : {}),
  };
};

const statement = (s) => `<li>${s.text ? `<span data-no-i18n>${esc(s.text)}</span> <span class="badge ok">checked</span>` : `${verify} <span class="small muted">(${esc(s.topic)})</span>`}</li>`;
const list = (items, empty) => (items.length ? `<ul class="plain">${items.map(statement).join("")}</ul>` : `<p class="small muted">${esc(empty)}</p>`);
const specialist = (items) => (items.length ? `<ul class="plain">${items.map((s) => `<li>${s.text ? `<span data-no-i18n>${esc(s.text)}</span> <span class="badge ok">checked</span>` : `${verify} <span class="small muted">(${esc(s.topic)})</span>`} <span class="badge spec">specialist review</span></li>`).join("")}</ul>` : "");

// The founder's answers as they read back, each with a link to change that one answer.
function profile() {
  const label = (key, val) => {
    const q = QUESTIONS[key];
    if (!q || val == null || val === "") return null;
    if (q.type === "choice") return q.options.find((o) => o[0] === val)?.[1] ?? words(val);
    if (q.type === "number") return key === "visas" ? String(val) : aed(val * 100);
    return val;
  };
  const rows = visible().map((q, idx) => {
    const v = q.key === "emirate" ? `${answers.emirate}${answers.freeZone ? `, ${answers.freeZone}` : ""}` : label(q.key, answers[q.key]);
    return { key: q.key, idx, title: q.title, value: v ?? "not given" };
  });
  return `<dl class="profile">${rows.map((r) => `<div><dt>${esc(r.title)}</dt><dd><span data-no-i18n>${esc(r.value)}</span><a href="#q" class="noprint" data-edit="${r.idx}">Change</a></dd></div>`).join("")}</dl>`;
}

const LEGEND = `<ul class="legend" aria-label="What the labels mean">
  <li><span class="badge ok">checked</span> approved for public display by a named person</li>
  <li><span class="badge info">condition</span> fits if this is confirmed</li>
  <li><span class="badge general">general information</span> educational, approved wording</li>
  <li><span class="verify">to be verified</span> exists, not yet approved to state</li>
  <li><span class="badge warn">data missing</span> no record held</li>
  <li><span class="badge spec">specialist review</span> a qualified person decides</li></ul>`;

const placeFigures = (p) => (p.figures
  ? `${aed(p.figures.costMinFils)} to ${aed(p.figures.costMaxFils)} to set up (estimate) · ${p.figures.visaQuota} visa(s) in the standard package · about ${p.figures.timelineDays} working days${p.figures.renewalMinFils ? ` · renews at about ${aed(p.figures.renewalMinFils)} to ${aed(p.figures.renewalMaxFils)} a year` : ""} <span class="badge ok">figures checked</span>`
  : `Figures ${verify}`);

function place(p, idx, compared) {
  // Only approved findings say what they are; the rest are counted as points a person will go through.
  const conditions = p.findings.filter((f) => f.outcome === "condition");
  const checks = p.findings.filter((f) => f.outcome === "unknown");
  const pending = p.findings.filter((f) => f.toBeVerified).length;
  const shown = [...conditions, ...checks];
  const summary = [conditions.length ? `${conditions.length} condition(s)` : "", checks.length ? `${checks.length} point(s) to confirm` : "", pending ? `${pending} point(s) a person reviews first` : ""].filter(Boolean).join(", ");
  return `<div class="place${compared ? " cmp-on" : ""}" data-idx="${idx}"><div class="head"><div><b>${esc(p.zone)}</b> <span class="small muted">(${esc(p.emirate)}${p.authority ? `, licensed by ${esc(p.authority)}` : ""})</span></div>${badge(p.status)}</div>
    <div class="small">${placeFigures(p)}</div>
    ${p.facilities ? `<div class="small muted">Facilities on record: ${esc(p.facilities.map(words).join(", "))}</div>` : ""}
    ${p.why.length ? `<div class="small muted">${esc(p.why.join("; "))}</div>` : ""}
    ${summary ? `<details class="small"><summary>${summary}</summary><ul class="plain">${shown.map((f) => `<li><span data-no-i18n>${esc(f.text)}</span> <span class="badge ${f.outcome === "condition" ? "info" : ""}">${f.outcome === "condition" ? "condition" : "to confirm"}</span></li>`).join("")}${pending ? `<li>${verify}: ${pending} point(s)</li>` : ""}</ul></details>` : ""}
    ${p.sourceUrl ? `<a class="small" href="${esc(p.sourceUrl)}" target="_blank" rel="noopener noreferrer">Official source</a>` : ""}
    <label class="cmp noprint"><input type="checkbox" class="cmp" data-idx="${idx}" ${compared ? "checked" : ""} /> Compare</label>
  </div>`;
}

// Side by side: up to five places the founder ticked. Every cell says what it is, including "not on record".
function compareTable(places) {
  if (!places.length) return `<p class="small muted">Tick "Compare" on up to five places to see them side by side.</p>`;
  const cell = (p, f) => f(p) ?? `<span class="muted">not on record</span>`;
  const three = (p) => (p.figures?.renewalMinFils ? `${aed(p.figures.costMinFils + 2 * p.figures.renewalMinFils)} to ${aed(p.figures.costMaxFils + 2 * p.figures.renewalMaxFils)} <span class="small muted">(setup plus two renewals, estimate)</span>` : null);
  const rows = [
    ["Fit", (p) => badge(p.status)],
    ["Setup estimate", (p) => (p.figures ? `${aed(p.figures.costMinFils)} to ${aed(p.figures.costMaxFils)} <span class="badge ok">checked</span>` : verify)],
    ["Yearly renewal", (p) => (p.figures ? (p.figures.renewalMinFils ? `${aed(p.figures.renewalMinFils)} to ${aed(p.figures.renewalMaxFils)} <span class="badge ok">checked</span>` : p.figures.renewalToBeVerified ? verify : null) : verify)],
    ["Three-year estimate", (p) => (p.figures ? (three(p) ?? (p.figures.renewalToBeVerified ? verify : `<span class="muted">needs the yearly renewal on record</span>`)) : verify)],
    ["Visas in the package", (p) => (p.figures ? String(p.figures.visaQuota) : verify)],
    ["Facilities on record", (p) => (p.figures ? (p.facilities ? esc(p.facilities.map(words).join(", ")) : null) : verify)],
    ["Timeline", (p) => (p.figures ? `about ${p.figures.timelineDays} working days` : verify)],
    ["Conditions", (p) => { const n = p.findings.filter((f) => f.outcome === "condition").length; return n ? `${n} <span class="badge info">condition</span>` : "none shown"; }],
    ["Points a person checks", (p) => String(p.findings.filter((f) => f.toBeVerified || f.outcome === "unknown").length)],
    ["Licensed by", (p) => (p.authority ? esc(p.authority) : p.figures ? null : verify)],
    ["Official source", (p) => (p.sourceUrl ? `<a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>` : p.figures ? null : verify)],
  ];
  return `<div class="compare"><table><caption class="small muted" style="text-align:start;padding:0 0 6px">Estimates include government fees as recorded; a price comes only from a partner firm's quote through MKW Advisors.</caption>
    <thead><tr><th scope="col">Compared</th>${places.map((p) => `<th scope="col">${esc(p.zone)}<br><span class="small muted">${esc(p.emirate)}</span></th>`).join("")}</tr></thead>
    <tbody>${rows.map(([label, f]) => `<tr><th scope="row">${esc(label)}</th>${places.map((p) => `<td>${cell(p, f)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function nextAction(p) {
  if (p.noViableOption) return ["Ask for a specialist review", "No option fits every answer as they stand. We will not guess: a person tells you what would make it work, or which answer to revisit."];
  if (p.contradictions.length) return ["Check the answers flagged above, then ask for a review", "Two of your answers cannot both be true. Change one, or send it as it is and a person will ask you which applies."];
  if (p.crossBorder.length) return ["Ask for a review with a cross-border specialist", "Your owners' tax residence or ownership brings points a cross-border specialist reviews before the structure is settled."];
  if (p.structure.confirmed) return [`Ask MKW Advisors to review a ${(STRUCTURE[p.structure.recommendation] ?? words(p.structure.recommendation)).toLowerCase()} company`, "A person confirms what applies to you against the current rules and sends priced offers from vetted partner firms. No payment now."];
  return ["Ask MKW Advisors to review this result", "The structure is confirmed by a person, not by this page. A review checks every point marked to be verified and sends priced offers from vetted partner firms."];
}

let compared = [];
function showResult(p, recovered = null) {
  lastResult = p;
  const rec = p.structure.recommendation;
  const head = rec && p.structure.confirmed ? `Structure: ${STRUCTURE[rec] ?? words(rec)}` : p.noViableOption ? "No structure fits every answer yet" : "The structure is to be confirmed by a person";
  // Compared by default: the place the founder named, then the best-ranked places that fit, three in all.
  const fitting = p.places.filter((x) => x.status !== "INELIGIBLE");
  const named = answers.freeZone ? fitting.filter((x) => x.zone.toLowerCase() === answers.freeZone.toLowerCase() || (x.authority ?? "").toLowerCase() === answers.freeZone.toLowerCase()) : [];
  compared = [...new Set([...named, ...fitting].slice(0, 3))].map((x) => p.places.indexOf(x));
  const [actionTitle, actionText] = nextAction(p);
  $("result").innerHTML = `
    <div class="notice" role="note"><b>Preliminary, general information, not advice.</b> <span data-no-i18n>${esc(p.disclaimer)}</span>${p.asOf ? ` Rules and place data as of ${esc(p.asOf)}.` : ""}</div>
    <p class="small muted" style="margin-top:8px">${p.approved.statements} of ${p.approved.ofStatements} statements and ${p.approved.places} of ${p.approved.ofPlaces} places shown have been checked by a named person for public display; the rest are shown as "to be verified".</p>
    ${LEGEND}
    <h1 class="sr-only">Your result</h1>
    <div class="card"><div class="row between"><h2>Your business profile</h2><button type="button" class="sm noprint" id="edit">Change my answers</button></div>${profile()}</div>
    ${p.noViableOption ? `<div class="card" role="status"><h2>No option fits every answer yet</h2><p>We will not guess. Ask for a review and a person tells you what would make it work.</p></div>` : ""}
    ${p.contradictions.length ? `<div class="card"><h2>Answers to check</h2><ul class="plain">${p.contradictions.map((c) => `<li><span data-no-i18n>${esc(c)}</span></li>`).join("")}</ul></div>` : ""}
    <div class="card"><h2 id="result-head" tabindex="-1">${esc(head)}</h2>${list(p.structure.reasons, "No reasons to show yet.")}
      <h3>Every structure compared</h3><div class="pathways">${p.structures.map((s) => { const f = s.findings.find((x) => (s.status === "INELIGIBLE" ? x.outcome === "fail" : x.outcome === "condition" || x.outcome === "fail")); return `<div class="pathway${rec === s.structure && p.structure.confirmed ? " rec" : ""}"><b>${esc(STRUCTURE[s.structure] ?? s.structure)}</b>${badge(s.status)}${f ? `<p class="small muted">${f.text ? `<span data-no-i18n>${esc(f.text)}</span>` : verify}</p>` : ""}</div>`; }).join("")}</div></div>
    <div class="card"><h2>Where to register</h2>
      ${p.places.length ? `<div class="places" id="places">${p.places.map((x, idx) => place(x, idx, compared.includes(idx))).join("")}</div>` : `<p class="muted">${p.noViableOption ? "No place fits every answer yet." : "No places to show yet; a person reviews which fit."}</p>`}
      ${p.places.length ? `<h3 id="compare-h">Side by side</h3><div id="compare">${compareTable(compared.map((idx) => p.places[idx]))}</div>` : ""}
      ${p.excluded.length ? `<details><summary class="small">${p.excluded.length} other place(s) do not fit, and why</summary><ul class="plain small">${p.excluded.map((x) => { const f = x.findings.find((y) => y.outcome === "fail" && y.text); return `<li><b>${esc(x.zone)}</b>: ${f ? `<span data-no-i18n>${esc(f.text)}</span>` : verify}</li>`; }).join("")}</ul></details>` : ""}</div>
    <div class="card"><h2>Licences, approvals and what follows after setup</h2>${list([...p.licences, ...p.obligations], "Nothing to show yet.")}
      ${p.crossBorder.length ? `<h3>For a cross-border specialist</h3>${specialist(p.crossBorder)}` : ""}
      ${p.missingFacts.length ? `<h3>What would sharpen this</h3><ul class="plain small">${p.missingFacts.map((m) => `<li><span class="badge warn">data missing</span> ${esc(m)}</li>`).join("")}</ul>` : ""}</div>
    <div class="card"><h2>General guidance</h2>${(p.guidance ?? []).length ? `<div class="guides">${p.guidance.map((g) => `<div class="guide"><h3><span data-no-i18n>${esc(g.title)}</span> <span class="badge general">general information</span></h3><p data-no-i18n>${esc(g.text)}</p></div>`).join("")}</div>` : `<p class="small muted">General notes on the structures and situations in your result appear here once a named person at MKW Advisors has approved their wording.</p>`}</div>
    <div class="card next-action"><h2>${esc(actionTitle)}</h2><p>${esc(actionText)}</p><div class="row noprint"><a class="btn primary" href="#review">Ask for a review</a><button type="button" class="sm" id="save">${savedCode ? "Saved: code " + esc(savedCode) : "Save my result"}</button><button type="button" class="sm" id="report">Download the report (PDF)</button><button type="button" class="sm" id="print">Print this page</button><button type="button" class="sm" id="restart">Start again</button></div>
    <p class="small muted noprint" id="save-msg" hidden aria-live="polite"></p></div>
    ${recovered ? `<p class="small muted">Saved ${esc(recovered.savedAt.slice(0, 10))}, opened ${recovered.recovered} time(s); shown again on today's rules.</p>` : ""}`;
  show("result");
  track("result_viewed");
  $("print").addEventListener("click", () => { track("report_printed"); window.print(); });
  // The report is built from the saved result, so an unsaved result is saved first (the code is shown as usual).
  const save = async () => {
    const res = await fetch("/api/public/assessments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: body(), attribution }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Could not save");
    savedCode = data.code;
    track("result_saved");
    $("save").textContent = `Saved: code ${savedCode}`;
    $("save-msg").hidden = false;
    $("save-msg").textContent = `Keep this code to come back to your result: ${savedCode}. It holds your answers only, no contact details, and is kept for a limited time.`;
  };
  $("report").addEventListener("click", async () => {
    $("report").disabled = true;
    try {
      if (!savedCode) await save();
      track("report_printed");
      const a = document.createElement("a");
      a.href = `/api/public/assessments/${encodeURIComponent(savedCode)}/report.pdf`;
      a.download = "";
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { $("save-msg").hidden = false; $("save-msg").textContent = e.message; } finally { $("report").disabled = false; }
  });
  $("edit").addEventListener("click", () => edit(0));
  for (const a of $("result").querySelectorAll("a[data-edit]")) a.addEventListener("click", (ev) => { ev.preventDefault(); edit(Number(a.dataset.edit)); });
  for (const c of $("result").querySelectorAll("input.cmp")) c.addEventListener("change", () => {
    const idx = Number(c.dataset.idx);
    if (c.checked && compared.length >= 5) { c.checked = false; $("compare").querySelector("[role=alert]")?.remove(); $("compare").insertAdjacentHTML("afterbegin", `<p class="notice small" role="alert">Five places at most: untick one to add another.</p>`); return; }
    compared = c.checked ? [...compared, idx] : compared.filter((x) => x !== idx);
    track("compared");
    c.closest(".place").classList.toggle("cmp-on", c.checked);
    $("compare").innerHTML = compareTable(compared.map((k) => p.places[k]));
    if (isAr()) translateTree($("compare"));
  });
  $("save").addEventListener("click", async () => {
    if (savedCode) return;
    $("save").disabled = true;
    try { await save(); } catch (e) { $("save-msg").hidden = false; $("save-msg").textContent = e.message; $("save").disabled = false; }
  });
  $("restart").addEventListener("click", () => { for (const k of Object.keys(answers)) delete answers[k]; answers.emirate = "Dubai"; i = 0; savedCode = null; lastResult = null; $("review").reset(); $("review").querySelector("button[type=submit]").disabled = false; $("rmsg").hidden = true; show("landing"); window.scrollTo(0, 0); $("start").focus(); });
  if (isAr()) translateTree($("result"));
  $("result").scrollIntoView({ block: "start" });
  $("result-head").focus();
}

// Change one answer, or all of them: the questions open with the answers kept; the saved code stays with the old
// answers, so a changed result is saved again under a new code.
function edit(idx) {
  i = Math.min(idx, visible().length - 1);
  savedCode = null;
  show("questions");
  render();
  $("questions").scrollIntoView({ block: "start" });
}

async function assess() {
  $("next").disabled = true;
  $("next").classList.add("busy");
  $("qmsg").hidden = false; $("qmsg").textContent = "Checking your answers against the current rules…";
  try {
    const res = await fetch("/api/public/assess", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Something went wrong");
    track("assessment_completed");
    showResult(data);
  } catch (e) { $("qmsg").textContent = `${e.message}. Check your connection and try again; your answers are still here.`; } finally { $("next").disabled = false; $("next").classList.remove("busy"); }
}

$("back").addEventListener("click", () => { i = Math.max(0, i - 1); render(); });
$("next").addEventListener("click", async () => {
  const err = take();
  if (err) { $("qmsg").hidden = false; $("qmsg").textContent = err; return; }
  if (i < visible().length - 1) { i++; render(); return; }
  await assess();
});
$("to-landing").addEventListener("click", () => { savedCode = null; show("landing"); window.scrollTo(0, 0); $("start").focus(); });

// The homepage: the call to action starts at question one; an industry starts at question two with the activity set.
// Regulated finance covers two activities the engine treats differently (financial services, virtual assets), so that
// card preselects the first and keeps question one on screen for the founder to confirm or change.
const CONFIRM_ACTIVITY = new Set(["finance"]);
function start(activity) {
  savedCode = null;
  track("assessment_started");
  if (activity && QUESTIONS.activity.options.some((o) => o[0] === activity)) { answers.activity = activity; i = CONFIRM_ACTIVITY.has(activity) ? 0 : 1; } else i = 0;
  show("questions");
  render();
  $("questions").scrollIntoView({ block: "start" });
}
$("start").addEventListener("click", () => start());
$("nav-start").addEventListener("click", (ev) => { ev.preventDefault(); start(); });
for (const b of document.querySelectorAll(".industry")) b.addEventListener("click", () => start(b.dataset.activity));

// Recovery by code: from the box, the ?code= parameter, or the code this browser saved last.
async function recover(code) {
  const msg = $("recover-msg");
  msg.textContent = "Opening…";
  try {
    const res = await fetch(`/api/public/assessments/${encodeURIComponent(code.trim().toUpperCase())}`);
    const data = await res.json();
    if (!res.ok || !data.found) { msg.textContent = "No saved result with that code (saved results are kept for a limited time)."; return; }
    // Only the recovered answers: nothing typed or recovered before stays behind.
    for (const k of Object.keys(answers)) delete answers[k];
    Object.assign(answers, data.answers, { owners: data.answers.ownerType, foreignTaxResident: data.answers.foreignTaxResident === true ? "yes" : data.answers.foreignTaxResident === false ? "no" : undefined, structure: data.answers.jurisdiction, turnover: data.answers.expectedTurnoverAed ?? undefined, startWithin: data.answers.startWithin ?? undefined });
    savedCode = code.trim().toUpperCase();
    msg.textContent = "";
    showResult(data.result, { savedAt: data.savedAt, recovered: data.recovered });
  } catch (e) { msg.textContent = e.message; }
}
$("recover").addEventListener("submit", (ev) => { ev.preventDefault(); const c = $("code").value.trim(); if (c) recover(c); });
$("call").addEventListener("change", () => { $("times-field").hidden = !$("call").checked; });

const review = $("review");
review.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!review.reportValidity()) return;
  const fd = new FormData(review);
  const msg = $("rmsg");
  const payload = {
    company: String(fd.get("company")), name: String(fd.get("name")), email: String(fd.get("email")), phone: String(fd.get("phone") || "") || undefined,
    consent: fd.get("consent") === "on", consentVersion: String(fd.get("consentVersion")), website: String(fd.get("website") || ""),
    campaign: attribution.campaign || "selector", referrer: attribution.referrer, attribution,
    marketingConsent: fd.get("marketing") === "on", partnerDisclosureConsent: fd.get("partner") === "on",
    consultation: fd.get("call") === "on" ? { wanted: true, times: String(fd.get("times") || "") } : undefined,
    ...(savedCode ? { assessmentCode: savedCode } : {}),
    answers: { mode: "new_company", ...body() },
  };
  msg.hidden = false; msg.textContent = "Sending…";
  const btn = review.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await fetch("/api/public/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Something went wrong");
    msg.textContent = "Thank you. A person at MKW Advisors reviews your case; check your email for how to sign in and follow progress.";
  } catch (e) { msg.textContent = e.message; btn.disabled = false; }
});

// Where to open: a saved code, a deep link to the questions or an industry, else the homepage.
if (params.get("code")) { show("landing"); recover(params.get("code")); }
else if (params.get("industry")) start(params.get("industry"));
else if (location.hash === "#start") start();
else show("landing");

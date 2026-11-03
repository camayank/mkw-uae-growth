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
let lastStep = "";
function track(stage, key = "") {
  // Each stage is sent once; a step is sent again when the visitor comes back to it, so the platform knows the last
  // step they really reached (the server keeps one row per step and refreshes its time).
  if (stage === "step_reached") { if (lastStep === key) return; lastStep = key; }
  else { const id = `${stage}:${key}`; if (sent.has(id)) return; sent.add(id); }
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

// Which view is on: the homepage, the quick match (E8), the questions or the result.
function show(view) {
  $("landing").hidden = view !== "landing";
  $("quick").hidden = view !== "quick";
  $("questions").hidden = view !== "questions";
  $("result").hidden = view !== "result";
  $("review").hidden = !(view === "result" || (view === "quick" && quick.step === 5));
  $("recover").hidden = view === "questions" || view === "quick";
  $("main").classList.toggle("wide", view === "quick" || view === "landing");
  // Leaving the quick match drops any count still on its way, so it can neither redraw nor touch the answers.
  if (view !== "quick") quickSeq++;
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
  const head = p.noViableOption ? "No structure fits every answer yet" : rec && p.structure.confirmed ? `Structure: ${STRUCTURE[rec] ?? words(rec)}` : "The structure is to be confirmed by a person";
  // Compared by default: the place the founder named, then the first places in the public order (E13), three in all.
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
      a.href = `/api/public/assessments/${encodeURIComponent(savedCode)}/report.pdf${isAr() ? "?lang=ar" : ""}`; // E16: the report in the page's language
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
  $("restart").addEventListener("click", restartAll);
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

// Start again from the full result: every answer, the quick match, the saved code and the review form are cleared.
function restartAll() {
  for (const k of Object.keys(answers)) delete answers[k];
  answers.emirate = "Dubai"; i = 0; savedCode = null; lastResult = null;
  Object.assign(quick, { step: 1, activity: null, emirate: undefined, visas: null, budget: null, data: null, dataFor: null, failed: false });
  $("review").reset(); $("review").querySelector("button[type=submit]").disabled = false; $("rmsg").hidden = true;
  show("landing"); window.scrollTo(0, 0); $("quick-start").focus();
}

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
$("quick-start").addEventListener("click", () => startQuick());
$("try-next").addEventListener("click", () => startQuick());
$("cta-start").addEventListener("click", () => startQuick());

// E11: the homepage in the canvas look, filled from the platform: the places on record, the package cards (an
// approved place's lowest estimate, else "to be verified") and the emirates map. Nothing is invented while it loads.
const HOME_TRY = [["tech", "Tech"], ["ecommerce", "E-commerce"], ["consulting", "Consulting"], ["trading", "Trading"]];
const PACKAGES = [
  ["free_zone", "Free zone company", "Licensed by one of the free zone authorities in the emirates.", "M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18"],
  ["mainland", "Mainland company", "Licensed by the emirate's economic department.", "M4 21V8l8-5 8 5v13M9 21v-6h6v6M4 21h16"],
  ["financial", "Financial centre company", "Registered in a financial centre such as DIFC or ADGM.", "M3 9l9-5 9 5M5 9v9M10 9v9M14 9v9M19 9v9M3 21h18"],
  ["offshore", "Offshore company", "Registered with an offshore registry, usually to hold shares or assets.", "M12 3v18M5 8l7-5 7 5M5 16a7 4 0 0 0 14 0"],
];
async function renderHome() {
  $("try-tiles").innerHTML = HOME_TRY.map(([id, label]) => `<button type="button" class="try" data-try="${id}" title="${esc(activityLabel(id))}"><span class="ico">${icon(id)}</span><b>${esc(label)}</b></button>`).join("");
  for (const b of $("try-tiles").querySelectorAll("[data-try]")) b.addEventListener("click", () => startQuick(b.dataset.try));
  const draw = (d) => {
    // A redraw when the platform answers must not drop a keyboard user's place on the page.
    const was = document.activeElement?.closest?.("#landing") ? (document.activeElement.dataset.pkg ? `[data-pkg="${document.activeElement.dataset.pkg}"]` : document.activeElement.dataset.homeEm ? `[data-home-em="${CSS.escape(document.activeElement.dataset.homeEm)}"]` : null) : null;
    $("home-count").textContent = d ? `${Object.values(d.onRecord).reduce((a, b) => a + b, 0)} across the seven emirates` : "–";
    $("packages").innerHTML = PACKAGES.map(([type, title, line, path]) => {
      const t = d?.byType?.[type];
      return `<article class="pkg"><span class="ico"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg></span>
        <h3 id="pkg-${type}">${esc(title)}</h3><p class="small muted">${esc(line)}</p>
        ${t?.fromFils ? `<p class="from"><span class="small muted">from</span> ${esc(aed(t.fromFils))} <span class="small muted">at</span> <span data-no-i18n>${esc(t.fromZone)}</span> <span class="badge ok">checked</span></p><p class="small muted">Preliminary estimate${d.asOf ? `, as of ${esc(d.asOf)}` : ""}. Not advice.</p>` : `<p class="from tbv">Price to be verified</p>`}
        <p class="small">${t ? `${esc(t.onRecord)} place${t.onRecord === 1 ? "" : "s"} on record` : ""}</p>
        <button type="button" class="btn" data-pkg="${type}" aria-describedby="pkg-${type}">Start the four questions</button></article>`;
    }).join("");
    for (const b of $("packages").querySelectorAll("[data-pkg]")) b.addEventListener("click", () => startQuick());
    const n = (e) => (d ? d.onRecord[e] ?? 0 : null);
    $("home-map").innerHTML = `<div class="uaemap" role="group" aria-label="The seven emirates"><span class="sea" style="grid-column:1 / 4;grid-row:1 / 3">Arabian Gulf</span><span class="sea" style="grid-column:5 / 6;grid-row:5 / 6;text-align:center">Gulf of Oman</span>
      ${MAP.map(([e, ar, , col, row]) => `<button type="button" class="em${n(e) === 0 ? " none" : ""}" data-home-em="${esc(e)}" aria-label="${esc(e)}${n(e) == null ? "" : n(e) === 0 ? ", no places on record yet" : `, ${esc(n(e))} place(s) on record`}" style="grid-column:${col};grid-row:${row}"><span class="top-row">${flagOf(e)}<span class="n">${n(e) === 0 ? "–" : esc(n(e) ?? "·")}</span></span><span><b>${esc(e)}</b><br><span class="ar" lang="ar" data-no-i18n>${ar}</span></span></button>`).join("")}</div>
      <p class="small muted" style="margin:6px 0 0">Schematic map, not to scale.</p>`;
    for (const b of $("home-map").querySelectorAll("[data-home-em]")) b.addEventListener("click", () => startQuick(undefined, { emirate: b.dataset.homeEm }));
    if (isAr()) translateTree($("landing"));
    if (was) $("landing").querySelector(was)?.focus();
  };
  draw(null);
  try {
    const res = await fetch("/api/public/quick", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (res.ok) draw(await res.json());
  } catch {}
}
$("nav-start").addEventListener("click", (ev) => { ev.preventDefault(); startQuick(); });
for (const b of document.querySelectorAll(".industry")) b.addEventListener("click", () => startQuick(b.dataset.activity));

// E8 quick match: four answers (what the business does, the emirate, the visas, a budget band) to the places worth
// reviewing (a lead only for an approved place, E13), with the count of places not yet ruled out after each answer. The platform runs the same engine and public
// filter as the full assessment (D80): a count falls only on an exclusion a named person approved, and a figure shows
// only for an approved place. The answers stay in memory; "see the full comparison" carries them into the questions.
const QUICK_LABELS = ["Activity", "Location", "Visas", "Budget", "Your match"];
const QUICK_KEYS = ["activity", "emirate", "visas", "budget"];
const ICONS = {
  consulting: "M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18",
  trading: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
  ecommerce: "M4 7h16l-1.5 11a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2zM9 10V6a3 3 0 0 1 6 0v4",
  tech: "M3 4h18v12H3zM8 20h8M12 16v4M9 9l-2 2 2 2M15 9l2 2-2 2",
  holding: "M3 9l9-5 9 5M5 9v9M10 9v9M14 9v9M19 9v9M3 21h18",
  finance: "M12 3v18M17 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H7",
  virtual_assets: "M12 2l8 4.5v9L12 20l-8-4.5v-9zM9 12h6M12 9v6",
  health: "M9 3h6v6h6v6h-6v6H9v-6H3V9h6z",
  education: "M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5",
  food: "M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c-2 2-2 6 0 8v10",
  construction: "M4 21V8l6-4v17M10 21h10V10l-10-2M14 13h2M14 17h2",
  manufacturing: "M3 21V10l6 4V10l6 4V6h6v15zM3 21h18",
  other: "M5 12h.01M12 12h.01M19 12h.01",
};
const icon = (id) => `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="${id === "other" ? 3.5 : 1.8}" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[id] ?? ICONS.other}"/></svg>`;
// Simplified emirate flags, drawn for recognition only (gap 107: checked against official artwork before launch).
const FLAG = {
  auh: '<rect width="30" height="20" fill="#CE1126"/><rect width="11" height="8" fill="#fff"/>',
  band: '<rect width="30" height="20" fill="#CE1126"/><rect width="7" height="20" fill="#fff"/>',
  border: '<rect width="30" height="20" fill="#fff"/><rect x="2.5" y="2.5" width="25" height="15" fill="#CE1126"/>',
  uaq: '<rect width="30" height="20" fill="#CE1126"/><rect width="7" height="20" fill="#fff"/><circle cx="17" cy="10" r="4.2" fill="#fff"/><circle cx="18.6" cy="10" r="3.5" fill="#CE1126"/><circle cx="22.6" cy="10" r="1.3" fill="#fff"/>',
  uae: '<rect width="30" height="20" fill="#fff"/><rect x="8" width="22" height="6.67" fill="#00732F"/><rect x="8" y="13.33" width="22" height="6.67" fill="#16201C"/><rect width="8" height="20" fill="#CE1126"/>',
};
// The seven emirates on a schematic map (not to scale): grid column and row, the flag and the Arabic name.
const MAP = [
  ["Abu Dhabi", "أبوظبي", "auh", "1 / 4", "4 / 6"], ["Dubai", "دبي", "band", "3 / 5", "3 / 4"], ["Sharjah", "الشارقة", "border", "4 / 5", "2 / 3"],
  ["Ajman", "عجمان", "band", "5 / 6", "2 / 3"], ["Umm Al Quwain", "أم القيوين", "uaq", "5 / 6", "1 / 2"], ["Ras Al Khaimah", "رأس الخيمة", "border", "6 / 7", "1 / 3"],
  ["Fujairah", "الفجيرة", "uae", "6 / 7", "3 / 5"],
];
const flagOf = (emirate) => { const m = MAP.find((x) => x[0] === emirate); return m ? `<span class="flag"><svg width="30" height="20" viewBox="0 0 30 20" aria-hidden="true">${FLAG[m[2]]}</svg></span>` : ""; };
const BANDS = [["up_to_15k", "Up to AED 15,000", 15_000], ["up_to_25k", "Up to AED 25,000", 25_000], ["up_to_50k", "Up to AED 50,000", 50_000], ["open", "More, or not sure yet", null]];
const TYPE = { free_zone: "Free zone company", mainland: "Mainland company", offshore: "Offshore company", financial: "Financial centre company" };
const QSTATUS = { ELIGIBLE_VERIFIED: ["ok", "fits your answers"], ELIGIBLE_CONDITIONAL: ["info", "fits, with conditions"], REQUIRES_VERIFICATION: ["", "to be verified by a person"], DATA_UNAVAILABLE: ["warn", "data missing"] };
const qbadge = (s) => `<span class="badge ${QSTATUS[s]?.[0] ?? ""}">${esc(QSTATUS[s]?.[1] ?? words(s))}</span>`;

// The quick answers: emirate undefined is unanswered, null is "anywhere".
const quick = { step: 1, activity: null, emirate: undefined, visas: null, budget: null, data: null, dataFor: null, failed: false };
let quickSeq = 0;
const answeredCount = () => [quick.activity, quick.emirate !== undefined, quick.visas != null, quick.budget].filter(Boolean).length;
const activityLabel = (id) => QUESTIONS.activity.options.find((o) => o[0] === id)?.[1] ?? words(id);
// A match is shown only for the answers it was computed from: while a newer request is on its way, the result, the
// exact-price action and the review form wait, so a request never pairs new answers with an earlier place.
const fresh = () => (quick.data && quick.dataFor === JSON.stringify(quickBody()) ? quick.data : null);
const quickBody = () => ({ ...(quick.activity ? { activity: quick.activity } : {}), ...(quick.emirate !== undefined ? { emirate: quick.emirate } : {}), ...(quick.visas != null ? { visas: quick.visas } : quick.step === 3 ? { visas: 1 } : {}), ...(quick.budget ? { budget: quick.budget } : {}) });

// The quick answers as the full questionnaire and the review request read them. Once the match is shown, the request
// is about the place shown first: its emirate (also when the founder said "anywhere" or skipped the question) and, only
// when it is presented as the place to review first (an approved place, E13), the place itself, as the place they have
// in mind. A place listed first only by name is not one the founder chose. No emirate is ever invented: pricing and
// allocation read it.
let quickZone = null;
function syncAnswers() {
  if (quick.activity) answers.activity = quick.activity;
  if (quick.emirate) answers.emirate = quick.emirate;
  const d = quick.step === 5 ? fresh() : null;
  if (d?.best) answers.emirate = d.best.emirate;
  if (d?.best && d.lead) answers.freeZone = quickZone = d.best.zone;
  else if (d && quickZone && answers.freeZone === quickZone) { delete answers.freeZone; quickZone = null; }
  if (quick.visas != null) answers.visas = quick.visas;
  const band = BANDS.find((b) => b[0] === quick.budget);
  if (band) { if (band[2] != null) answers.budgetAed = band[2]; else delete answers.budgetAed; }
}

async function refreshQuick() {
  const seq = ++quickSeq;
  const asked = JSON.stringify(quickBody());
  try {
    const res = await fetch("/api/public/quick", { method: "POST", headers: { "content-type": "application/json" }, body: asked });
    const data = await res.json();
    if (seq !== quickSeq) return; // a later answer asked again, or the founder left the quick match
    if (!res.ok) throw new Error(data.message || "Something went wrong");
    quick.data = data;
    quick.dataFor = asked;
    quick.failed = false;
    syncAnswers();
    $("quick-msg").hidden = true;
  } catch (e) {
    if (seq !== quickSeq) return;
    // A match for earlier answers is never shown under new ones.
    quick.data = null;
    quick.failed = true;
    $("quick-msg").hidden = false;
    $("quick-msg").textContent = `${String(e.message).replace(/\.$/, "")}. Check your connection and try again; your answers are still here.`;
  }
  // The founder may have moved on to the full questions or the result: only the quick match is redrawn.
  if (!$("quick").hidden) renderQuick({ keepFocus: true });
}
let visaTimer = null;
const refreshSoon = () => { clearTimeout(visaTimer); visaTimer = setTimeout(refreshQuick, 250); };

function quickPanel() {
  const d = quick.data;
  const n = d ? d.options : null;
  $("quick-count").textContent = n == null ? "–" : String(n);
  $("quick-count-word").textContent = n === 1 ? "place not yet ruled out" : "places not yet ruled out";
  const top = d ? [d.best, ...d.alternatives].filter(Boolean) : [];
  $("quick-top").innerHTML = top.map((p) => `<li><span data-no-i18n>${esc(p.zone)}</span><span>${p.figures ? `from ${esc(aed(p.figures.costMinFils))}` : "to be verified"}</span></li>`).join("");
  const pct = answeredCount() * 25;
  $("quick-pct").textContent = `${pct}%`;
  $("quick-meter").style.width = `${pct}%`;
  const rows = [
    ["Activity", quick.activity ? activityLabel(quick.activity) : null, 1],
    ["Location", quick.emirate === undefined ? null : quick.emirate ?? "Anywhere in the UAE", 2],
    ["Visas", quick.visas == null ? null : String(quick.visas), 3],
    ["Budget", BANDS.find((b) => b[0] === quick.budget)?.[1] ?? null, 4],
  ];
  $("quick-answers").innerHTML = rows.map(([label, value, step]) => `<button type="button" data-go="${step}"><span><small>${esc(label)}</small><b>${esc(value ?? "Not answered")}</b></span><span class="act">${value ? "Change" : "Answer"}</span></button>`).join("");
  for (const b of $("quick-answers").querySelectorAll("button")) b.addEventListener("click", () => goQuick(Number(b.dataset.go)));
}

function quickStepHtml() {
  const d = quick.data;
  const head = (n, title, sub) => `<div class="qhead"><p class="eyebrow">Question ${n} of 4</p><h2 id="quick-title" tabindex="-1">${esc(title)}</h2><p class="small muted">${esc(sub)}</p></div>`;
  if (quick.step === 1) {
    return head(1, "What will your company do?", "Pick the closest. Each place licenses different activities, so this narrows things fast.") +
      `<div class="tiles" role="group" aria-labelledby="quick-title">${QUESTIONS.activity.options.map(([id, label, sub]) => `<button type="button" class="tile" data-act="${esc(id)}" aria-pressed="${quick.activity === id}"><span class="ico">${icon(id)}</span><span><b>${esc(label)}</b>${sub ? `<br><small>${esc(sub)}</small>` : ""}</span></button>`).join("")}</div>`;
  }
  if (quick.step === 2) {
    const n = (e) => (d ? d.byEmirate[e] ?? 0 : null);
    const none = (e) => d && !d.onRecord?.[e];
    const any = d ? d.everywhere : null;
    return head(2, "Where would you like to be based?", "Tap an emirate. The number is how many places there are not yet ruled out by your answers.") +
      `<div class="uaemap" role="group" aria-labelledby="quick-title"><span class="sea" style="grid-column:1 / 4;grid-row:1 / 3">Arabian Gulf</span><span class="sea" style="grid-column:5 / 6;grid-row:5 / 6;text-align:center">Gulf of Oman</span>
        ${MAP.map(([e, ar, , col, row]) => `<button type="button" class="em${n(e) === 0 ? " none" : ""}" data-em="${esc(e)}" aria-pressed="${quick.emirate === e}" aria-label="${esc(e)}${n(e) == null ? "" : none(e) ? ", no places on record yet" : `, ${esc(n(e))} place(s)`}" style="grid-column:${col};grid-row:${row}"><span class="top-row">${flagOf(e)}<span class="n">${none(e) ? "–" : esc(n(e) ?? "·")}</span></span><span><b>${esc(e)}</b><br><span class="ar" lang="ar" data-no-i18n>${ar}</span></span></button>`).join("")}</div>
      <p class="small muted" style="margin:6px 0 10px">Schematic map, not to scale. A dash: we hold no places on record there yet.</p>
      <button type="button" class="anyplace" data-em="" aria-pressed="${quick.emirate === null}"><span><b>No preference: anywhere in the UAE</b><br><small class="muted">All seven emirates compared.</small></span><span class="badge general">${esc(any ?? "·")} places</span></button>`;
  }
  if (quick.step === 3) {
    const v = quick.visas ?? 1; // shown as the starting point; recorded when the founder changes it or moves on
    const people = Array.from({ length: Math.min(v, 8) }, () => '<svg width="26" height="32" viewBox="0 0 30 36" aria-hidden="true"><circle cx="15" cy="9" r="7" fill="currentColor"/><path d="M2 36c0-9 6-14 13-14s13 5 13 14z" fill="currentColor"/></svg>').join("") + (v > 8 ? `<b style="align-self:center">+${v - 8}</b>` : "");
    return head(3, "How many residence visas do you need?", "Count yourself and anyone who will live and work in the UAE in the first year. Zero is fine.") +
      `<div class="stepper"><button type="button" id="visa-dec" aria-label="One visa fewer">−</button><label class="sr-only" for="quick-visas">Residence visas</label><input id="quick-visas" type="number" inputmode="numeric" min="0" max="50" value="${v}" /><button type="button" id="visa-inc" aria-label="One visa more">+</button></div>
      <div class="people" aria-hidden="true">${people}</div>`;
  }
  if (quick.step === 4) {
    return head(4, "What would you like to spend on set-up?", "Licence, registration and your first visas. You see the exact price from MKW Advisors before you pay anything.") +
      `<div class="bands" role="group" aria-labelledby="quick-title">${BANDS.map(([id, label]) => { const c = d?.byBudget.find((b) => b.id === id)?.options; const empty = d && quick.emirate && !d.onRecord?.[quick.emirate]; return `<button type="button" class="tile" data-band="${id}" aria-pressed="${quick.budget === id}"><b>${esc(label)}</b><span class="fit${c === 0 ? " zero" : ""}">${c == null ? "" : empty ? "No places on record in this emirate yet" : c === 0 ? "No place fits yet" : `${esc(c)} not yet ruled out`}</span></button>`; }).join("")}</div>`;
  }
  return quickResultHtml();
}

function quickResultHtml() {
  const d = fresh();
  if (!d) return `<div class="qhead"><p class="eyebrow">Your match</p><h2 id="quick-title" tabindex="-1">${quick.failed ? "Your match could not be loaded" : "Finding your match…"}</h2>${quick.failed ? `<button type="button" class="btn" id="quick-retry">Try again</button>` : ""}</div>`;
  const where = quick.emirate ?? "the UAE";
  const legend = `<div class="notice small" role="note"><b>Preliminary, general information, not advice.</b> <span data-no-i18n>${esc(d.disclaimer)}</span>${d.asOf ? ` Rules and place data as of ${esc(d.asOf)}.` : ""}</div>
    <p class="small muted">${esc(d.approved.places)} of ${esc(d.approved.ofPlaces)} places not yet ruled out have figures checked by a named person; the rest show "to be verified".</p>`;
  if (!d.best) {
    return `<div class="qhead"><p class="eyebrow">Your match</p><h2 id="quick-title" tabindex="-1">No place on record fits these four answers yet</h2><p class="small muted">An adviser can usually find a way: a different package, budget or emirate. Ask, free of charge.</p></div>
      <div class="row"><a class="btn gold" href="#review">Ask an adviser</a><button type="button" class="sm" data-go="4">Change my budget</button></div>${legend}`;
  }
  const b = d.best;
  const fig = b.figures;
  const price = fig ? `<div><span class="muted">From</span> <span class="price">${esc(aed(fig.costMinFils))}</span> <span class="muted">to ${esc(aed(fig.costMaxFils))} to set up (estimate)</span> <span class="badge ok">figures checked</span></div>`
    : `<div><span class="price" style="font-size:1.3rem">Price to be verified by a person</span><p class="small muted" style="margin:4px 0 0">No figure is shown until a named person at MKW Advisors has checked it against the official source.</p></div>`;
  const facts = fig ? [`${fig.visaQuota} visa(s) in the standard package`, `About ${fig.timelineDays} working days`, fig.renewalMinFils ? `Renews at about ${aed(fig.renewalMinFils)} a year` : null, b.authority ? `Licensed by ${b.authority}` : null].filter(Boolean) : [];
  const alt = (p) => `<div class="card"><span><span class="row" style="gap:8px">${flagOf(p.emirate)}<b data-no-i18n>${esc(p.zone)}</b></span><small class="muted" data-no-i18n>${esc(p.emirate)} · ${esc(TYPE[p.type] ?? words(p.type))}</small></span><span class="small">${p.figures ? `from ${esc(aed(p.figures.costMinFils))}` : '<span class="verify">to be verified</span>'}</span></div>`;
  const shownIn = quick.emirate && !d.bestElsewhere ? where : d.lead ? b.emirate : "the UAE";
  const elsewhere = d.bestElsewhere ? `<p class="notice small">${d.onRecord?.[quick.emirate] ? `No place in ${esc(quick.emirate)} fits these answers yet; ${d.lead ? "this is the closest place elsewhere." : "these are places elsewhere."}` : `We hold no places on record in ${esc(quick.emirate)} yet; ${d.lead ? "this is the closest place elsewhere." : "these are places elsewhere."}`}</p>` : "";
  const cta = `<div class="cta noprint"><a class="btn gold" href="#review" id="quick-price">Get my exact price</a><button type="button" class="btn" id="quick-full">See the full comparison</button></div>`;
  // E13 (D95): a place is presented as the one to review first only when a named person approved it for public
  // display; otherwise the places are listed side by side, by the founder's answers and then by name, with no lead.
  if (!d.lead) {
    return `<div class="qhead"><p class="eyebrow">Your shortlist</p><h2 id="quick-title" tabindex="-1">${shownIn === "the UAE" ? "Places to review across the UAE" : `Places to review in <span data-no-i18n>${esc(shownIn)}</span>`}</h2>
      <p class="small muted">None of these places has been checked by a named person yet, so none is put first: they are listed by your answers, then by name.</p>
      ${elsewhere}</div>
    <div class="alts" id="quick-places">${[b, ...d.alternatives].map(alt).join("")}</div>
    <div class="card best">
      <p style="margin:0"><b>A person at MKW Advisors checks which of these fits, and the exact price.</b></p>
      ${cta}
      <p class="small muted" style="margin:0">No payment now. A person checks your case and sends priced offers, usually within one working day.</p>
    </div>
    ${legend}`;
  }
  return `<div class="qhead"><p class="eyebrow">Your match</p><h2 id="quick-title" tabindex="-1">A place worth reviewing first in <span data-no-i18n>${esc(shownIn)}</span></h2>
      <p class="small muted">Put first on what a named person has checked and on your answers. A person confirms it fits before anything is priced.</p>
      ${elsewhere}</div>
    <div class="card best">
      <div class="row" style="gap:8px">${flagOf(b.emirate)}<span class="badge general">${esc(TYPE[b.type] ?? words(b.type))}</span>${qbadge(b.status)}${d.structure.confirmed ? `<span class="badge ok">structure: ${esc(STRUCTURE[d.structure.recommendation] ?? words(d.structure.recommendation))}</span>` : ""}</div>
      <h3 data-no-i18n>${esc(b.zone)}</h3>
      ${price}
      ${facts.length ? `<ul class="facts">${facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      ${b.conditions || b.toConfirm ? `<p class="small muted">${esc([b.conditions ? `${b.conditions} condition(s)` : "", b.toConfirm ? `${b.toConfirm} point(s) a person confirms` : ""].filter(Boolean).join(", "))} before anything is priced.</p>` : ""}
      ${cta}
      <p class="small muted" style="margin:0">No payment now. A person at MKW Advisors checks your case and sends priced offers, usually within one working day.${b.sourceUrl ? ` <a href="${esc(b.sourceUrl)}" target="_blank" rel="noopener noreferrer">Official source</a>` : ""}</p>
    </div>
    ${d.alternatives.length ? `<h3 style="margin:8px 0 0;font-size:1.05rem">Also worth a look</h3><div class="alts">${d.alternatives.map(alt).join("")}</div>` : ""}
    ${legend}`;
}

function renderQuick({ keepFocus = false } = {}) {
  const active = document.activeElement;
  const activeKey = active?.dataset ? Object.entries(active.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}="${CSS.escape(v)}"]`).join("") : "";
  const activeId = active?.id;
  $("quick-track").innerHTML = QUICK_LABELS.map((label, idx) => { const n = idx + 1; const cls = n < quick.step ? "done" : n === quick.step ? "now" : ""; return `<li class="${cls}"${n === quick.step ? ' aria-current="step"' : ""}><span class="dot">${n < quick.step ? "✓" : n}</span><span class="lbl">${esc(label)}</span></li>`; }).join("");
  $("quick-step").innerHTML = quickStepHtml();
  const answered = [quick.activity, quick.emirate !== undefined, quick.visas != null || quick.step === 3, quick.budget][quick.step - 1];
  $("quick-back").disabled = quick.step === 1;
  $("quick-next").hidden = quick.step === 5;
  $("quick-next").disabled = !answered;
  $("quick-next").textContent = quick.step === 4 ? "See my match" : "Next";
  $("quick-back").textContent = quick.step === 5 ? "Change my answers" : "Back";
  $("review").hidden = quick.step !== 5 || !fresh();
  quickPanel();
  bindQuick();
  if (isAr()) { translateTree($("quick")); if (quick.step === 5) translateTree($("review")); }
  if (keepFocus) {
    // A refreshed count must not move the founder's place on the page.
    (activeId && $(activeId)) ? $(activeId).focus() : activeKey && $("quick").querySelector(activeKey)?.focus();
  }
}

function bindQuick() {
  const step = $("quick-step");
  for (const b of step.querySelectorAll("[data-act]")) b.addEventListener("click", () => { quick.activity = b.dataset.act; syncAnswers(); goQuick(2); });
  for (const b of step.querySelectorAll("[data-em]")) b.addEventListener("click", () => { quick.emirate = b.dataset.em || null; syncAnswers(); renderQuick(); b.isConnected || step.querySelector(`[data-em="${CSS.escape(b.dataset.em)}"]`)?.focus(); refreshQuick(); });
  for (const b of step.querySelectorAll("[data-band]")) b.addEventListener("click", () => { quick.budget = b.dataset.band; syncAnswers(); renderQuick(); step.querySelector(`[data-band="${b.dataset.band}"]`)?.focus(); refreshQuick(); });
  for (const b of step.querySelectorAll("[data-go]")) b.addEventListener("click", () => goQuick(Number(b.dataset.go)));
  const input = $("quick-visas");
  if (input) {
    const setV = (v) => { quick.visas = Math.max(0, Math.min(50, Number.isFinite(v) ? v : 0)); syncAnswers(); refreshSoon(); };
    $("visa-dec").addEventListener("click", () => { setV((quick.visas ?? 1) - 1); renderQuick({ keepFocus: true }); });
    $("visa-inc").addEventListener("click", () => { setV((quick.visas ?? 1) + 1); renderQuick({ keepFocus: true }); });
    // A typed number is taken when the field is left; focus stays wherever the founder moved it.
    input.addEventListener("change", () => { setV(Math.round(Number(input.value))); renderQuick({ keepFocus: true }); });
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); setV(Math.round(Number(input.value))); goQuick(4); } });
  }
  $("quick-price")?.addEventListener("click", (ev) => { ev.preventDefault(); $("review").scrollIntoView({ block: "start" }); $("company").focus(); });
  step.querySelector('a[href="#review"]:not(#quick-price)')?.addEventListener("click", (ev) => { ev.preventDefault(); $("review").scrollIntoView({ block: "start" }); $("company").focus(); });
  $("quick-full")?.addEventListener("click", toFullQuestions);
  $("quick-retry")?.addEventListener("click", () => { quick.failed = false; renderQuick(); $("quick-title")?.focus(); refreshQuick(); });
}

function goQuick(step) {
  quick.step = step;
  if (step <= 4) track("step_reached", `quick_${QUICK_KEYS[step - 1]}`);
  if (step === 5) { track("assessment_completed"); track("result_viewed"); }
  renderQuick();
  $("quick").scrollIntoView({ block: "start" });
  ($("quick-step").querySelector('[aria-pressed="true"]') ?? $("quick-title"))?.focus();
  refreshQuick();
}

// The full comparison: the questionnaire opens at the first question the quick match did not ask, answers kept.
function toFullQuestions() {
  syncAnswers();
  savedCode = null;
  const qs = visible();
  const firstOpen = qs.findIndex((q) => q.key !== "emirate" && answers[q.key] == null);
  i = firstOpen < 0 ? qs.length - 1 : firstOpen;
  show("questions");
  render();
  $("questions").scrollIntoView({ block: "start" });
}

function startQuick(activity, { emirate } = {}) {
  savedCode = null;
  track("assessment_started");
  // E11: an emirate tapped on the homepage's map is the answer to question 2, and the questions start again at 1.
  if (emirate) { quick.emirate = emirate; quick.step = 1; syncAnswers(); }
  show("quick");
  if (activity && QUESTIONS.activity.options.some((o) => o[0] === activity)) { quick.activity = activity; syncAnswers(); goQuick(CONFIRM_ACTIVITY.has(activity) ? 1 : 2); }
  else goQuick(quick.step || 1);
}
$("quick-back").addEventListener("click", () => goQuick(quick.step === 5 ? 1 : Math.max(1, quick.step - 1)));
$("quick-next").addEventListener("click", () => { if (quick.step === 3 && quick.visas == null) { quick.visas = 1; syncAnswers(); } goQuick(Math.min(5, quick.step + 1)); });

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

renderHome();
// Where to open: a saved code, a deep link to the questions or an industry, else the homepage.
if (params.get("code")) { show("landing"); recover(params.get("code")); }
else if (params.get("industry")) startQuick(params.get("industry"));
else if (location.hash === "#start") start();
else if (location.hash === "#quick") startQuick();
else show("landing");

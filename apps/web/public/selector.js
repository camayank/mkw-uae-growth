// Right UAE Entity public selector (E3, D80): questions one at a time, a public assessment from the platform, and a
// review request through the public intake. No sign-in, nothing stored until the person asks for a review.
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

// The questions, each shown when it applies. Answers are kept in memory only.
const answers = { emirate: "Dubai" };
const QUESTIONS = [
  { key: "activity", title: "What will the business mainly do?", type: "choice", options: [
    ["consulting", "Consulting or professional services", "including accounting and bookkeeping"], ["trading", "Trading goods"], ["ecommerce", "Selling online"], ["tech", "Software or technology"],
    ["holding", "Holding company", "owning shares or assets, no trading"], ["finance", "Regulated financial services", "banking, lending, investment, insurance, payments"], ["virtual_assets", "Virtual assets or crypto"],
    ["health", "Health or medical"], ["education", "Education or training"], ["food", "Food and restaurants"], ["construction", "Construction or real estate"], ["manufacturing", "Manufacturing"], ["other", "Something else"],
  ] },
  { key: "customers", title: "Where are your customers?", type: "choice", options: [["international", "Outside the UAE"], ["uae_mainland", "Inside the UAE"], ["both", "Both"]] },
  { key: "visas", title: "How many residence visas do you need?", type: "number", hint: "Count yourself, partners and staff who will live in the UAE. Zero is fine.", min: 0, max: 50 },
  { key: "premises", title: "What premises does the business need?", type: "choice", when: () => answers.activity !== "holding", options: [
    ["none", "None", "no physical place of business"], ["virtual", "A virtual office or desk"], ["office", "An office"], ["retail", "A shop or showroom"], ["warehouse", "A warehouse"], ["industrial", "An industrial plot or unit"], ["clinic", "A clinic or licensed premises"],
  ] },
  { key: "budgetAed", title: "What is your setup budget, in AED?", type: "number", hint: "Optional. Places above it are shown as not fitting.", min: 0, max: 100000000, optional: true },
  { key: "owners", title: "Who will own the company?", type: "choice", options: [["individuals", "One or more individuals"], ["company", "A company"]] },
  { key: "foreignTaxResident", title: "Is any owner tax resident outside the UAE?", type: "choice", options: [["yes", "Yes"], ["no", "No"], ["unsure", "Not sure"]] },
  { key: "emirate", title: "Which emirate, and is there a place you have in mind?", type: "emirate" },
];
const EMIRATES = ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Umm Al Quwain", "Fujairah"];

const $ = (id) => document.getElementById(id);
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
// The consent texts come from the platform, so the page and the record always carry the same version.
fetch("/api/public/consent-texts").then((r) => r.json()).then((t) => { $("marketing-text").textContent = t.marketing.text; $("partner-text").textContent = t.partner_disclosure.text; }).catch(() => {});
const visible = () => QUESTIONS.filter((q) => !q.when || q.when());

function render() {
  const qs = visible();
  const q = qs[i];
  $("progress").textContent = `Question ${i + 1} of ${qs.length}`;
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
  $("step").innerHTML = html;
  $("qmsg").hidden = true;
  for (const b of $("step").querySelectorAll(".choice")) {
    b.addEventListener("click", () => {
      answers[q.key] = b.dataset.val;
      for (const o of $("step").querySelectorAll(".choice")) o.setAttribute("aria-pressed", String(o === b));
    });
  }
  if (isAr()) translateTree($("step"));
  ($("step").querySelector("#qnum, .choice, #qemirate") ?? $("next")).focus();
}

function take() {
  const q = visible()[i];
  if (q.type === "choice" && !answers[q.key]) return "Choose one to continue.";
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
  jurisdiction: "not_sure",
  freeZone: answers.freeZone,
  activity: answers.activity,
  customers: answers.customers,
  visas: answers.visas ?? 0,
  ...(answers.premises ? { premises: answers.premises } : {}),
  ...(answers.budgetAed != null ? { budgetAed: answers.budgetAed } : {}),
  ownerType: answers.owners,
  ...(answers.foreignTaxResident === "yes" ? { foreignTaxResident: true } : answers.foreignTaxResident === "no" ? { foreignTaxResident: false } : {}),
  };
};

const statement = (s) => `<li>${s.text ? `<span data-no-i18n>${esc(s.text)}</span> <span class="badge ok">checked</span>` : `${verify} <span class="small muted">(${esc(s.topic)})</span>`}</li>`;
const list = (items, empty) => (items.length ? `<ul class="plain">${items.map(statement).join("")}</ul>` : `<p class="small muted">${esc(empty)}</p>`);
const countVerify = (items) => items.filter((s) => s.toBeVerified).length;

function place(p) {
  // Only approved findings say what they are; the rest are counted as points a person will go through.
  const conditions = p.findings.filter((f) => f.outcome === "condition");
  const checks = p.findings.filter((f) => f.outcome === "unknown");
  const pending = p.findings.filter((f) => f.toBeVerified).length;
  const shown = [...conditions, ...checks];
  const summary = [conditions.length ? `${conditions.length} condition(s)` : "", checks.length ? `${checks.length} point(s) to confirm` : "", pending ? `${pending} point(s) a person reviews first` : ""].filter(Boolean).join(", ");
  return `<div class="place"><b>${esc(p.zone)}</b> <span class="small muted">(${esc(p.emirate)}${p.authority ? `, licensed by ${esc(p.authority)}` : ""})</span> ${badge(p.status)}
    <div class="small">${p.figures ? `${aed(p.figures.costMinFils)} to ${aed(p.figures.costMaxFils)} to set up (estimate) · ${p.figures.visaQuota} visa(s) in the standard package · about ${p.figures.timelineDays} working days${p.figures.renewalMinFils ? ` · renews at about ${aed(p.figures.renewalMinFils)} to ${aed(p.figures.renewalMaxFils)} a year` : ""} <span class="badge ok">figures checked</span>` : `Figures ${verify}`}</div>
    ${p.why.length ? `<div class="small muted">${esc(p.why.join("; "))}</div>` : ""}
    ${summary ? `<details class="small"><summary>${summary}</summary><ul class="plain">${shown.map((f) => `<li><span data-no-i18n>${esc(f.text)}</span> <span class="badge ${f.outcome === "condition" ? "info" : ""}">${f.outcome === "condition" ? "condition" : "to confirm"}</span></li>`).join("")}${pending ? `<li>${verify}: ${pending} point(s)</li>` : ""}</ul></details>` : ""}
  </div>`;
}

function showResult(p, recovered = null) {
  lastResult = p;
  const rec = p.structure.recommendation;
  const head = rec && p.structure.confirmed ? `Structure: ${STRUCTURE[rec] ?? words(rec)}` : p.noViableOption ? "No structure fits every answer yet" : "The structure is to be confirmed by a person";
  $("result").innerHTML = `
    <div class="notice" role="note"><b>Preliminary, general information, not advice.</b> <span data-no-i18n>${esc(p.disclaimer)}</span>${p.asOf ? ` Rules and place data as of ${esc(p.asOf)}.` : ""}</div>
    <p class="small muted" style="margin-top:8px">${p.approved.statements} of ${p.approved.ofStatements} statements and ${p.approved.places} of ${p.approved.ofPlaces} places shown have been checked by a named person for public display; the rest are shown as "to be verified".</p>
    ${p.noViableOption ? `<div class="card" role="status"><h2>No option fits every answer yet</h2><p>We will not guess. Ask for a review and a person tells you what would make it work.</p></div>` : ""}
    ${p.contradictions.length ? `<div class="card"><h2>Answers to check</h2><ul class="plain">${p.contradictions.map((c) => `<li><span data-no-i18n>${esc(c)}</span></li>`).join("")}</ul></div>` : ""}
    <div class="card"><h2 id="result-head" tabindex="-1">${esc(head)}</h2>${list(p.structure.reasons, "No reasons to show yet.")}
      <h3>Every structure compared</h3><ul class="plain">${p.structures.map((s) => { const f = s.findings.find((x) => (s.status === "INELIGIBLE" ? x.outcome === "fail" : x.outcome === "condition" || x.outcome === "fail")); return `<li><b>${esc(STRUCTURE[s.structure] ?? s.structure)}</b> ${badge(s.status)}${f ? `<br><span class="small muted">${f.text ? `<span data-no-i18n>${esc(f.text)}</span>` : verify}</span>` : ""}</li>`; }).join("")}</ul></div>
    <div class="card"><h2>Where to register</h2>${p.places.length ? p.places.map(place).join("") : `<p class="muted">${p.noViableOption ? "No place fits every answer yet." : "No places to show yet; a person reviews which fit."}</p>`}
      ${p.excluded.length ? `<details><summary class="small">${p.excluded.length} other place(s) do not fit, and why</summary><ul class="plain small">${p.excluded.map((x) => { const f = x.findings.find((y) => y.outcome === "fail" && y.text); return `<li><b>${esc(x.zone)}</b>: ${f ? `<span data-no-i18n>${esc(f.text)}</span>` : verify}</li>`; }).join("")}</ul></details>` : ""}</div>
    <div class="card"><h2>Licences, approvals and what follows after setup</h2>${list([...p.licences, ...p.obligations], "Nothing to show yet.")}
      ${p.crossBorder.length ? `<h3>For a cross-border specialist</h3>${list(p.crossBorder, "")}` : ""}
      ${p.missingFacts.length ? `<h3>What would sharpen this</h3><ul class="plain small">${p.missingFacts.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}</div>
    ${recovered ? `<p class="small muted">Saved ${esc(recovered.savedAt.slice(0, 10))}, opened ${recovered.recovered} time(s); shown again on today's rules.</p>` : ""}
    <div class="row noprint" style="margin-top:12px"><button type="button" class="sm" id="print">Print or save this page</button><button type="button" class="sm" id="save">${savedCode ? "Saved: code " + esc(savedCode) : "Save my result"}</button><button type="button" class="sm" id="restart">Start again</button></div>
    <p class="small muted noprint" id="save-msg" hidden></p>`;
  $("result").hidden = false;
  $("review").hidden = false;
  $("print").addEventListener("click", () => window.print());
  $("save").addEventListener("click", async () => {
    if (savedCode) return;
    $("save").disabled = true;
    try {
      const res = await fetch("/api/public/assessments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: body(), attribution }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Could not save");
      savedCode = data.code;
      $("save").textContent = `Saved: code ${savedCode}`;
      $("save-msg").hidden = false;
      $("save-msg").textContent = `Keep this code to come back to your result: ${savedCode}. It holds your answers only, no contact details, and is kept for a limited time.`;
    } catch (e) { $("save-msg").hidden = false; $("save-msg").textContent = e.message; $("save").disabled = false; }
  });
  $("restart").addEventListener("click", () => { for (const k of Object.keys(answers)) delete answers[k]; answers.emirate = "Dubai"; i = 0; savedCode = null; lastResult = null; $("result").hidden = true; $("review").hidden = true; $("review").reset(); $("review").querySelector("button[type=submit]").disabled = false; $("rmsg").hidden = true; $("questions").hidden = false; render(); });
  if (isAr()) translateTree($("result"));
  $("result").scrollIntoView({ block: "start" });
  $("result-head").focus();
}

$("back").addEventListener("click", () => { i = Math.max(0, i - 1); render(); });
$("next").addEventListener("click", async () => {
  const err = take();
  if (err) { $("qmsg").hidden = false; $("qmsg").textContent = err; return; }
  if (i < visible().length - 1) { i++; render(); return; }
  $("next").disabled = true;
  $("qmsg").hidden = false; $("qmsg").textContent = "Checking your answers against the current rules…";
  try {
    const res = await fetch("/api/public/assess", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Something went wrong");
    $("questions").hidden = true;
    showResult(data);
  } catch (e) { $("qmsg").textContent = e.message; } finally { $("next").disabled = false; }
});

// Recovery by code: from the box, the ?code= parameter, or the code this browser saved last.
async function recover(code) {
  const msg = $("recover-msg");
  msg.textContent = "Opening…";
  try {
    const res = await fetch(`/api/public/assessments/${encodeURIComponent(code.trim().toUpperCase())}`);
    const data = await res.json();
    if (!res.ok || !data.found) { msg.textContent = "No saved result with that code (saved results are kept for a limited time)."; return; }
    Object.assign(answers, data.answers, { owners: data.answers.ownerType, foreignTaxResident: data.answers.foreignTaxResident === true ? "yes" : data.answers.foreignTaxResident === false ? "no" : undefined });
    savedCode = code.trim().toUpperCase();
    $("questions").hidden = true;
    msg.textContent = "";
    showResult(data.result, { savedAt: data.savedAt, recovered: data.recovered });
  } catch (e) { msg.textContent = e.message; }
}
$("recover").addEventListener("submit", (ev) => { ev.preventDefault(); const c = $("code").value.trim(); if (c) recover(c); });
if (params.get("code")) recover(params.get("code"));
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
  try {
    const res = await fetch("/api/public/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Something went wrong");
    review.querySelector("button[type=submit]").disabled = true;
    msg.textContent = "Thank you. A person at MKW Advisors reviews your case; check your email for how to sign in and follow progress.";
  } catch (e) { msg.textContent = e.message; }
});

render();

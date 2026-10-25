// Tasees workspace: core module (split from app.js in O12; plain ES modules, no build step).
import { translateTree } from "../i18n-ar.js";

// The shell registers the real renderer (js/shell.js); everything else calls render() from here.
export const hooks = { render: () => Promise.resolve() };
export function render() {
  return hooks.render();
}

export const $app = document.getElementById("app");
export const $nav = document.getElementById("nav");
export const $who = document.getElementById("who");
export const $brand = document.getElementById("brand");
export const $toast = document.getElementById("toast");

export const state = { me: null, health: null, deliverables: null, unread: 0, lang: "en", untranslated: new Set() };

// Language (O9): Arabic for clients only once the reviewer's sign-off is recorded; staff may preview it.
export const lang = () => state.lang;
export function applyLang() {
  const ar = lang() === "ar";
  document.documentElement.lang = ar ? "ar" : "en";
  document.documentElement.dir = ar ? "rtl" : "ltr";
}
// Accessibility (O9): every control gets an accessible name. Labels written as a bare <label> before a control
// are linked to it; a control with only a placeholder gets that text as its name; file inputs say so.
export let labelSeq = 0;
export function ensureLabels(root) {
  for (const label of root.querySelectorAll("label:not([for])")) {
    if (label.querySelector("input, select, textarea")) continue;
    let el = label.nextElementSibling;
    if (el && !el.matches("input:not([type=hidden]), select, textarea")) el = el.querySelector?.("input:not([type=hidden]), select, textarea") ?? null;
    if (!el || el.id) {
      if (el && el.id) label.htmlFor = el.id;
      continue;
    }
    el.id = `f-${++labelSeq}`;
    label.htmlFor = el.id;
  }
  for (const el of root.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea")) {
    if (el.id && root.querySelector(`label[for="${el.id}"]`)) continue;
    if (el.closest("label") || el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") || el.hasAttribute("title")) continue;
    if (el.placeholder) el.setAttribute("aria-label", el.placeholder);
    else if (el.type === "file") el.setAttribute("aria-label", "Choose a file");
    else if (el.type === "date") el.setAttribute("aria-label", "Date");
    else if (el.type === "checkbox") el.setAttribute("aria-label", el.value || "Select");
    else if (el.tagName === "SELECT") el.setAttribute("aria-label", el.name ? words(el.name) : "Choose");
    else el.setAttribute("aria-label", el.name ? words(el.name) : "Field");
  }
}

export function translatePage() {
  if (lang() !== "ar") return;
  const skip = document.querySelector(".skip");
  for (const root of [$brand, $nav, $who, $app, skip].filter(Boolean)) {
    const missing = translateTree(root);
    // The gap list is for the reviewer: client screens only, never staff screens or people's own words.
    if (root === $app && (isClient() || !state.me)) for (const m of missing) state.untranslated.add(m);
  }
  document.title = translateText(document.title);
  reportGaps();
}
export let reported = new Set();
export function reportGaps() {
  if (!state.me || !isClient()) return;
  const fresh = [...state.untranslated].filter((m) => !reported.has(m));
  if (!fresh.length) return;
  for (const m of fresh) reported.add(m);
  api("POST", "/api/me/i18n-gaps", { strings: fresh.slice(0, 200) }).catch(() => {});
}

// Screen readers hear where they are after every route change: the page title follows the heading and the
// main region takes focus. The skip link moves focus without changing the route.
// A table wider than the screen scrolls sideways; when nothing inside it can take focus, keyboard users could not
// scroll it, so it becomes a named region they can tab to (O10, axe at 390 px). Tables that fit get no tab stop.
export function keyboardScrollables() {
  for (const wrap of $app.querySelectorAll(".table-wrap")) {
    const scrolls = wrap.scrollWidth > wrap.clientWidth + 1;
    const focusable = wrap.querySelector("a[href], button, input, select, textarea, [tabindex]");
    if (scrolls && !focusable) {
      let heading = null;
      for (let el = wrap; el && el !== $app && !heading; el = el.parentElement)
        for (let sib = el.previousElementSibling; sib && !heading; sib = sib.previousElementSibling) if (/^H[1-3]$/.test(sib.tagName)) heading = sib;
      wrap.setAttribute("tabindex", "0");
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", heading?.textContent?.trim() || document.querySelector("h1")?.textContent?.trim() || "Table");
    } else if (wrap.getAttribute("role") === "region") {
      for (const a of ["tabindex", "role", "aria-label"]) wrap.removeAttribute(a);
    }
  }
}
export let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(keyboardScrollables, 200);
});

export let lastAnnounced = "";
export function announceRoute() {
  const h1 = $app.querySelector("h1")?.textContent?.trim();
  document.title = h1 ? `${h1} · Tasees` : "Tasees workspace";
  const key = location.hash;
  if (key !== lastAnnounced) {
    lastAnnounced = key;
    if (document.activeElement === document.body || document.activeElement === null) $app.focus({ preventScroll: true });
  }
}
document.querySelector(".skip")?.addEventListener("click", (ev) => {
  ev.preventDefault();
  $app.focus();
});
export function translateText(text) {
  if (lang() !== "ar" || !text) return text;
  const span = document.createElement("span");
  span.textContent = text;
  translateTree(span);
  return span.textContent;
}
export function pickLang() {
  // The person's saved choice wins; before sign-in, the browser's own preference when Arabic is available.
  if (state.me) return state.me.locale === "ar" && state.me.arabic?.available ? "ar" : "en";
  try {
    const saved = localStorage.getItem("tasees.lang");
    if (saved === "ar" && state.health?.arabic) return "ar";
  } catch {}
  return "en";
}

// Helpers ---------------------------------------------------------------------

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const aed = (fils) => {
  if (fils == null) return "–";
  const whole = Number(fils) % 100 === 0;
  return "AED " + (Number(fils) / 100).toLocaleString("en-AE", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
};
export const STAGE_ORDER = { kickoff: 0, key_milestone: 1, completion: 2, change_order: 3 };
export const byStage = (a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9);

export const pct = (bp) => (bp == null ? "–" : (Number(bp) / 100).toFixed(1) + "%");

export const date = (v) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
export const dateTime = (v) =>
  v ? new Date(v).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" }) + " GST" : "–";

export const words = (s) => String(s ?? "").replace(/_/g, " ");
export const addDaysIso = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const TONE = {
  ok: ["client_approved", "completed", "accepted", "released", "paid", "published", "signed", "approved", "eligible", "ok", "active", "verified"],
  info: ["in_progress", "in_delivery", "evidence_submitted", "qa_passed", "allocating", "draft", "scoped", "offered", "priced", "proposed"],
  warn: ["awaiting_payment", "ops_review", "quoting", "pending", "pilot", "open", "prospect", "contacted", "UNCERTAIN"],
  bad: ["disputed", "qa_rejected", "expired", "withdrawn", "cancelled", "rejected", "withheld", "paused", "deactivated", "erased"],
};
export const tone = (s) => Object.keys(TONE).find((k) => TONE[k].includes(s)) ?? "";
export const badge = (s, label) => `<span class="badge ${tone(s)}">${esc(label ?? words(s))}</span>`;

export const MILESTONE_LABEL = {
  pending: "Not started",
  in_progress: "In progress",
  evidence_submitted: "Evidence with MKW for checking",
  qa_passed: "Checked, waiting for client approval",
  qa_rejected: "Sent back for rework",
  client_approved: "Approved",
  disputed: "Issue raised",
};

export const isPlatform = () => state.me?.orgType === "platform";
export const isPartner = () => state.me?.orgType === "partner";
export const isClient = () => state.me?.orgType === "client";
export const role = () => state.me?.role;
export const seesMargin = () => ["finance", "founder"].includes(role());

export function toast(msg, err = false) {
  $toast.textContent = translateText(msg);
  $toast.className = "show" + (err ? " err" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.className = ""), err ? 6000 : 3000);
}

export async function api(method, url, body) {
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
export async function act(fn, ok = "Done") {
  try {
    await fn();
    if (ok) toast(ok);
    await render();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * Legal texts arrive as markdown. Render a safe subset: everything is escaped first, then headings, lists, bold and
 * paragraphs are recognised. No HTML from the text ever reaches the page.
 */
export function mdToHtml(text) {
  const inline = (t) => esc(t.replace(/\\([\[\]()*_#-])/g, "$1")).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (!line) {
      flush();
      continue;
    }
    if (h) {
      flush();
      const level = Math.min(4, h[1].length + 2);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (ul || ol) {
      if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`), (para = []);
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        if (list) out.push(`</${list}>`);
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
    } else {
      if (list) out.push(`</${list}>`), (list = null);
      para.push(line);
    }
  }
  flush();
  return out.join("");
}

/** A legal text with its version and review state, the full text behind a disclosure. */
export function legalBlock(doc, heading) {
  const state = doc.draft
    ? `${badge("UNCERTAIN", "Draft, pending legal review")}`
    : `${badge("verified", `Reviewed by ${esc(doc.approvedByLawyer)} on ${date(doc.approvedOn)}`)}`;
  return `<div class="legal stack"><div class="row between"><b>${esc(heading)} · version ${doc.version}</b>${state}</div>
    <details><summary class="small">Read the full text</summary><div class="legal-text">${mdToHtml(doc.body)}</div></details></div>`;
}

export const table = (head, rows, empty = "Nothing here yet.") =>
  rows.length
    ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th class="${h.startsWith("#") ? "num" : ""}">${esc(h.replace(/^#/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p class="empty">${esc(empty)}</p>`;

export const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });

export function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function deliverables() {
  if (!state.deliverables) state.deliverables = await api("GET", "/api/deliverables");
  return state.deliverables;
}
export const nameOf = (code) => state.deliverables?.find((d) => d.code === code)?.name ?? code;

// Routing ----------------------------------------------------------------------

export const route = () => {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { page: parts[0] ?? "home", id: parts[1] ?? null };
};
export const OBLIGATION_KINDS = ["licence_renewal", "visa_expiry", "vat_return", "ct_return", "esr_notification", "ubo_update", "audit_filing", "custom"];
export const obligationTone = (o) => (o.status === "met" ? "ok" : o.status === "waived" ? "expired" : o.status === "evidence_uploaded" ? "info" : o.status === "pending_review" ? "UNCERTAIN" : new Date(o.dueDate) < new Date() ? "bad" : "pending");
export const obligationLabel = (o) => (o.status === "open" && new Date(o.dueDate) < new Date() ? "overdue" : o.status === "evidence_uploaded" ? "evidence uploaded, MKW checking" : o.status === "pending_review" ? "date to confirm" : words(o.status));

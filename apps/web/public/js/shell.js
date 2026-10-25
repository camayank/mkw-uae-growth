// Tasees workspace: shell module (split from app.js in O12; plain ES modules, no build step).
import { $app, $brand, $nav, $who, act, announceRoute, api, applyLang, deliverables, ensureLabels, esc, hooks, isClient, isPartner, isPlatform, keyboardScrollables, lang, pickLang, render, route, state, translatePage, words } from "./core.js";
import { renderNotifications } from "./common.js";
import { renderClientCompliance, renderClientHome, renderClientOffer, renderIntake, renderPayPage, renderStatement } from "./client.js";
import { renderEngagement } from "./engagement.js";
import { renderFirm, renderPartnerHome, renderPartnerPayouts, renderPartnerPerformance, renderRateCards } from "./partner.js";
import { renderAgentQueue, renderAudit, renderDashboard, renderDelays, renderOpsCompliance, renderOpsOffer, renderPartners, renderPipeline, renderQueue, renderRequest, renderScoping, renderSearch } from "./ops.js";
import { renderCatalogue, renderPeople, renderRules, renderSettings } from "./admin.js";

hooks.render = renderNow;

window.addEventListener("hashchange", () => render());
// Coming back to the tab shows fresh data, unless the person is typing in a form.
document.addEventListener("visibilitychange", () => {
  const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
  if (document.visibilityState === "visible" && state.me && !typing) render();
});

export function navFor() {
  if (isClient()) return [["home", "Overview"], ["new", "New request"], ["compliance", "Compliance"], ["statement", "Statement"]];
  if (isPartner()) return [["home", "Work"], ["performance", "Performance"], ["firm", "Your firm"], ["rates", "Rate card"], ["payouts", "Payouts"]];
  // MKW staff: fourteen pages in four entries, so the bar stays on one row at desktop and phone width.
  return [
    { group: "Work", items: [["home", "Queue"], ["pipeline", "Pipeline"], ["new", "New request"], ["delays", "Delays"], ["compliance", "Compliance"], ["agent", "AI queue"]] },
    ["partners", "Partners"],
    ["dashboard", "Dashboard"],
    { group: "Setup", items: [["people", "People"], ["catalogue", "Catalogue"], ["rules", "Rules"], ["scoping", "Scoping"], ["settings", "Settings"], ["audit", "Audit trail"]] },
  ];
}

/** A link in the menu bar, marked when it is the page on screen. */
export const navLink = (p, label, page) => `<a href="#/${p}" class="${page === p ? "on" : ""}" ${page === p ? 'aria-current="page"' : ""}>${esc(label)}</a>`;

/** A disclosure menu (button + list of links): opens on click, Enter or Space; Escape closes and returns focus. */
export function navGroup(g, page) {
  const id = `nav-${g.group.toLowerCase()}`;
  const current = g.items.find(([p]) => p === page);
  return `<div class="navgroup"><button type="button" class="navbtn ${current ? "on" : ""}" aria-expanded="false" aria-controls="${id}" data-act="nav-group">${esc(g.group)}${current ? `<span class="navcur">: ${esc(current[1])}</span>` : ""}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
    <div class="navmenu" id="${id}" hidden>${g.items.map(([p, label]) => navLink(p, label, page)).join("")}</div></div>`;
}

export function closeNavMenus(except) {
  for (const b of document.querySelectorAll("#nav .navbtn[aria-expanded='true']")) {
    if (b === except) continue;
    b.setAttribute("aria-expanded", "false");
    document.getElementById(b.getAttribute("aria-controls"))?.setAttribute("hidden", "");
  }
}
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  const open = document.querySelector("#nav .navbtn[aria-expanded='true']");
  if (!open) return;
  closeNavMenus();
  open.focus();
});
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".navgroup")) closeNavMenus();
});
// Tabbing out of an open menu closes it, so it never hangs over the page behind the focus.
document.addEventListener("focusout", (ev) => {
  const group = ev.target.closest?.("#nav .navgroup");
  if (group && !(ev.relatedTarget && group.contains(ev.relatedTarget))) closeNavMenus();
});

export function langSwitch() {
  const available = state.me ? state.me.arabic?.available : !!state.health?.arabic;
  if (!available) return "";
  const other = lang() === "ar" ? "en" : "ar";
  return `<button class="sm" type="button" data-act="lang" data-lang="${other}" lang="${other}" aria-label="${other === "ar" ? "العربية" : "English"}">${other === "ar" ? "العربية" : "English"}</button>`;
}

export function chrome() {
  const { page } = route();
  state.lang = pickLang();
  applyLang();
  if (!state.me) {
    $nav.innerHTML = "";
    $who.innerHTML = langSwitch();
    $brand.innerHTML = "Tasees <small>by MKW Advisors</small>";
    return;
  }
  $brand.innerHTML = isPartner()
    ? "MKW Advisors <small>Partner Network</small>"
    : isPlatform()
      ? "MKW Advisors <small>Operations</small>"
      : "Tasees <small>by MKW Advisors</small>";
  $nav.innerHTML = navFor()
    .map((item) => (Array.isArray(item) ? navLink(item[0], item[1], page) : navGroup(item, page)))
    .join("");
  $who.innerHTML = `${isPlatform() ? `<form data-form="search" class="search"><input name="q" type="search" placeholder="Search clients, partners, refs" aria-label="Search" /></form>` : ""}<span>${esc(state.me.name)}${isPlatform() ? "" : ` · ${esc(state.me.orgName)}`} · ${esc(words(state.me.role))}</span>${langSwitch()}
    <a class="bell ${page === "notifications" ? "on" : ""}" href="#/notifications" aria-label="Notifications${state.unread ? `, ${state.unread} unread` : ""}" title="Notifications">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
      ${state.unread ? `<b class="count" data-unread>${state.unread > 99 ? "99+" : state.unread}</b>` : ""}</a>
    <button class="sm" data-act="logout">Sign out</button>`;
}

// Renders run one at a time; a request made mid-render runs once more afterwards, so the
// screen always ends on the latest route and data.
export let rendering = null;
export let renderAgain = false;
export function renderNow() {
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

export async function refreshUnread() {
  try {
    state.unread = (await api("GET", "/api/notifications")).unread ?? 0;
  } catch {
    state.unread = 0;
  }
}

export async function renderOnce() {
  if (state.me && route().page !== "notifications") await refreshUnread();
  chrome();
  if (!state.me) {
    renderSignIn();
    ensureLabels($app);
    announceRoute();
    translatePage();
    return;
  }
  const { page, id } = route();
  try {
    await deliverables();
    try {
      await renderPage(page, id);
    } finally {
      ensureLabels($app);
      ensureLabels($who);
      announceRoute();
      if (lang() === "ar" && state.me.arabic?.preview) $app.insertAdjacentHTML("afterbegin", `<p class="notice small" data-no-i18n>النسخة العربية مسودة إلى أن يعتمدها المراجع؛ أنت تعاينها بصفتك من فريق MKW. <span lang="en" dir="ltr">Arabic is a draft until the reviewer signs it off; you are previewing it as MKW staff.</span></p>`);
      translatePage();
      keyboardScrollables();
    }
  } catch (e) {
    if (e.status === 401) {
      state.me = null;
      return render();
    }
    $app.innerHTML = `<div class="card"><h1>Could not load this page</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Back to start</a></div>`;
  }
}

export async function renderPage(page, id) {
  {
    if (page === "notifications") return await renderNotifications();
    if (page === "engagement" && id) return await renderEngagement(id);
    if (page === "pay" && id) return renderPayPage(id);
    if (page === "request" && id) return await renderRequest(id);
    if (isClient()) {
      if (page === "offer" && id) return await renderClientOffer(id);
      if (page === "statement") return await renderStatement();
      if (page === "compliance") return await renderClientCompliance();
      if (page === "new") return await renderIntake();
      return await renderClientHome();
    }
    if (isPartner()) {
      if (page === "firm") return await renderFirm(state.me.orgId);
      if (page === "performance") return await renderPartnerPerformance();
      if (page === "rates") return await renderRateCards();
      if (page === "payouts") return await renderPartnerPayouts();
      return await renderPartnerHome();
    }
    if (page === "offer" && id) return await renderOpsOffer(id);
    if (page === "pipeline") return await renderPipeline();
    if (page === "partners") return await renderPartners();
    if (page === "partner" && id) return await renderFirm(id);
    if (page === "delays") return await renderDelays();
    if (page === "dashboard") return await renderDashboard(id);
    if (page === "compliance") return await renderOpsCompliance(id);
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
  }
}

// Sign in ------------------------------------------------------------------------

export const DEMO_ACCOUNTS = [
  ["founder@sample-client.test", "Client owner (Sample Trading FZ-LLC)"],
  ["accounts@sample-client.test", "Client member (view and message only)"],
  ["admin@setup-partner.test", "Partner admin (setup and visas)"],
  ["admin@corporate-services.test", "Partner admin (banking and PRO, pilot)"],
  ["admin@tax-accounts.test", "Partner admin (tax and audit)"],
  ["ops@mkwadvisors.test", "MKW ops (no margin view)"],
  ["finance@mkwadvisors.test", "MKW finance (margin and payouts)"],
  ["founder@mkwadvisors.test", "MKW founder"],
];

export function renderSignIn(email = "", sent = false, devCode = "") {
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

export async function requestCode(email) {
  const r = await api("POST", "/api/auth/request-code", { email });
  renderSignIn(email, true, r.devCode ?? "");
  ensureLabels($app);
  translatePage();
  document.getElementById("code")?.focus();
}

// Client ---------------------------------------------------------------------------

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

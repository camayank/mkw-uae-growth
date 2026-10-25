// Tasees workspace: admin module (split from app.js in O12; plain ES modules, no build step).
import { $app, act, addDaysIso, aed, api, badge, date, dateTime, deliverables, esc, lang, pct, role, route, seesMargin, state, table, words } from "./core.js";

export async function renderArabicSection() {
  const a = await api("GET", "/api/admin/arabic");
  const founder = role() === "founder";
  const missing = [...new Set([...(a.gaps ?? []), ...state.untranslated])].sort();
  return `<h2 style="margin-top:20px">Arabic ${badge(a.reviewed ? "verified" : "UNCERTAIN", a.reviewed ? "reviewed" : "draft, not yet reviewed")}</h2>
  <div class="card" data-no-i18n>
    <p class="muted small">${a.reviewed ? `Signed off by ${esc(a.reviewedBy)} on ${date(a.reviewedAt)}${a.note ? `: ${esc(a.note)}` : ""}. Clients may choose Arabic; their emails go out in Arabic.` : "Until an Arabic speaker signs off the screens and the emails, clients see English only. Give the reviewer a test client account and list its email below: that account sees Arabic with a draft banner and its emails arrive in Arabic, and the strings the dictionary does not cover are listed here when that account signs in. MKW staff can preview the Arabic header and staff screens with the language button."}</p>
    ${missing.length ? `<details><summary class="small">${missing.length} English string(s) seen on client screens without an Arabic entry</summary><ul class="plain small">${missing.map((m) => `<li lang="en" dir="ltr">${esc(m)}</li>`).join("")}</ul></details>` : lang() === "ar" ? `<p class="small muted">No gaps seen on the screens visited in this session.</p>` : ""}
    ${founder ? `<form class="row" data-form="arabic-review" style="margin-top:10px">
      <input name="reviewedBy" placeholder="Reviewer's name and role" style="max-width:260px" ${a.reviewed ? `value="${esc(a.reviewedBy ?? "")}"` : ""} />
      <input name="note" placeholder="What was reviewed (dictionary version, templates)" style="max-width:320px" />
      <input name="previewEmails" placeholder="Preview client emails, comma-separated" value="${esc((a.previewEmails ?? []).join(", "))}" style="max-width:320px" />
      <button class="sm" type="submit" name="reviewed" value="${a.reviewed ? "1" : "preview"}">Save preview accounts</button>
      <button class="sm primary" type="submit" name="reviewed" value="1">Record sign-off</button>${a.reviewed ? `<button class="sm danger" type="submit" name="reviewed" value="0">Withdraw</button>` : ""}</form>` : ""}
  </div>`;
}

export async function renderExportLog() {
  const log = await api("GET", "/api/admin/accounting/exports");
  return `<h2 style="margin-top:20px">Accounting exports</h2><div class="card flush">${table(["When", "Set", "Range", "#Rows", "By"], log.map((l) => `<tr><td class="small">${dateTime(l.exportedAt)}</td><td>${esc(l.setName)}</td><td class="small">${date(l.fromDate)} – ${date(l.toDate)}</td><td class="num">${l.rows}</td><td class="small">${esc(l.exportedBy)}</td></tr>`), "No exports yet (from the Dashboard).")}</div>`;
}

export async function renderDeliveryLog() {
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

export async function renderCatalogue() {
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

export async function renderRules() {
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

export const ROLES_FOR = {
  client: ["client_owner", "client_member"],
  partner: ["partner_admin", "partner_staff"],
  platform: ["ops", "finance", "founder", "agent"],
};
export const ORG_LABEL = { platform: "MKW Advisors", partner: "Partner firm", client: "Client" };

export async function renderPeople() {
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

export const RETENTION_LABEL = {
  taxRecords: "Tax and accounting records",
  clientDocuments: "Client documents and evidence files",
  messages: "Engagement messages",
  auditTrail: "Audit trail",
  sessions: "Sign-in sessions",
  loginCodes: "Sign-in codes",
};

export async function renderSettings() {
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
  ${await renderLegalSection()}
  ${await renderHolidaySection()}
  ${await renderCompany()}
  ${await renderArabicSection()}
  ${["ops", "finance", "founder"].includes(role()) ? await renderExportLog() : ""}
  ${await renderDeliveryLog()}`;
}

export const LEGAL_TITLE = { client_terms: "Tasees client terms", partner_agreement: "MKW Partner Network Agreement" };

export async function renderLegalSection() {
  const docs = await api("GET", "/api/admin/legal");
  const founder = role() === "founder";
  return `<h2 style="margin-top:24px">Legal texts</h2>
  <p class="muted">Clients accept the client terms with an offer; partners accept the agreement during onboarding. Each shows "Draft, pending legal review" until you record the lawyer's review of that exact version. A new text arrives as a new version through the import and starts as a draft again.</p>
  <div class="card flush">${table(
    ["Text", "#Version", "Review", founder ? "Record the lawyer's review" : ""],
    docs.map(
      (d) => `<tr><td>${esc(LEGAL_TITLE[d.kind] ?? d.kind)}</td><td class="num">${d.version}</td>
      <td>${d.draft ? badge("UNCERTAIN", "Draft, pending legal review") : badge("verified", `${esc(d.approvedByLawyer)}, ${date(d.approvedOn)}`)}</td>
      <td>${founder && d.draft ? `<form class="row" data-form="legal-signoff" data-kind="${d.kind}" data-version="${d.version}"><input name="lawyer" required minlength="2" placeholder="Lawyer or firm" aria-label="Lawyer who reviewed version ${d.version}" style="max-width:200px" /><input name="approvedOn" type="date" required aria-label="Date of the review" style="width:auto" /><button class="sm primary" type="submit">Record review</button></form>` : ""}</td></tr>`,
    ),
    "No legal texts loaded yet. Import them with: pnpm import legal <file>.",
  )}</div>`;
}

export async function renderHolidaySection() {
  const list = await api("GET", "/api/admin/holidays");
  const founder = role() === "founder";
  return `<h2 style="margin-top:24px">Public holidays</h2>
  <p class="muted">The working-time clock (Monday to Friday, 09:00 to 18:00 GST) skips these dates for every deadline: partner replies, auto-approval, delays and the ops digest. Lunar dates stay "expected" until the government announces them; expected dates count as holidays meanwhile.</p>
  <div class="card flush">${table(
    ["Date", "Holiday", "Status", "Note", ""],
    list.map(
      (h) => `<tr><td>${date(h.date)}</td><td>${esc(h.name)}</td><td>${h.status === "confirmed" ? badge("verified", "confirmed") : badge("UNCERTAIN", "expected")}</td><td class="small">${esc(h.note || "")}</td>
      <td>${founder ? `${h.status === "expected" ? `<button class="sm" data-act="holiday-confirm" data-date="${h.date}" data-name="${esc(h.name)}" data-note="${esc(h.note || "")}" aria-label="Confirm ${esc(h.name)} on ${date(h.date)}">Confirm</button> ` : ""}<button class="sm" data-act="holiday-remove" data-date="${h.date}" aria-label="Remove ${esc(h.name)} on ${date(h.date)}">Remove</button>` : ""}</td></tr>`,
    ),
    "No holidays loaded: every weekday counts as a working day.",
  )}
  ${
    founder
      ? `<form class="pad row" data-form="holiday-set" style="padding-top:8px"><input name="date" type="date" required aria-label="Date" style="width:auto" /><input name="name" required minlength="2" placeholder="Holiday" aria-label="Holiday name" style="max-width:220px" />
         <select name="status" aria-label="Status" style="width:auto"><option value="expected">expected</option><option value="confirmed">confirmed</option></select>
         <input name="reason" required minlength="3" placeholder="Source (recorded)" aria-label="Why, for the audit trail" style="max-width:240px" /><button class="sm primary" type="submit">Add or update</button></form>`
      : ""
  }</div>`;
}

export async function renderCompany() {
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

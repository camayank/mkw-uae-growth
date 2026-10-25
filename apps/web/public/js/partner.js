// Tasees workspace: partner module (split from app.js in O12; plain ES modules, no build step).
import { $app, act, aed, api, badge, date, dateTime, deliverables, esc, isPartner, isPlatform, legalBlock, nameOf, role, table, words } from "./core.js";

export async function renderPartnerHome() {
  const h = await api("GET", "/api/partner/home");
  const offered = h.allocations.filter((a) => !a.acceptedAt && !a.declinedAt && !a.timedOutAt);
  const active = h.allocations.filter((a) => a.acceptedAt);
  const rfqs = h.rfqs.filter((q) => q.status === "open" && !q.submitted);
  const admin = role() === "partner_admin";
  $app.innerHTML = `
  <h1>Work from MKW Advisors</h1>
  ${h.firm && h.firm.status !== "signed" ? `<p class="notice small">Your firm is <b>${esc(words(h.firm.status ?? "prospect"))}</b>${h.firm.status === "paused" ? "; no new work is offered until MKW Advisors lifts the pause" : h.firm.status === "pilot" ? ": up to three jobs at a time until five are delivered on time" : ": complete your application and documents on <a href=\"#/firm\">Your firm</a>"}.</p>` : ""}
  <div class="kpis">
    <div class="kpi"><b>${offered.length}</b><span>Offers waiting for your answer</span></div>
    <div class="kpi"><b>${active.filter((a) => a.engagementStatus !== "completed").length}</b><span>Engagements in delivery</span></div>
    <div class="kpi"><b>${rfqs.length}</b><span>Requests for a price</span></div>
    <div class="kpi"><b>${aed(h.payouts.filter((p) => p.status === "eligible").reduce((s, p) => s + p.amount, 0))}</b><span>Payouts due to you</span></div>
    <div class="kpi"><b>${h.firm?.latestScore ?? h.firm?.quality ?? "–"}</b><span>Quality score · <a href="#/firm">scorecard</a></span></div>
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

export const DOC_KINDS = ["trade_licence", "insurance", "bank_letter", "agreement", "other"];
export const PARTNER_STATUSES = ["prospect", "contacted", "applied", "under_review", "pilot", "signed", "paused"];

export async function renderFirm(orgId) {
  const f = await api("GET", `/api/partners/${orgId}/onboarding`);
  const pr = f.profile ?? {};
  const mine = isPartner();
  const admin = role() === "partner_admin";
  const agreement = await api("GET", "/api/legal/partner_agreement");
  const accepted = pr.agreementAccepted;
  const agreementCard = agreement?.version
    ? `<div class="card stack"><h2>Partner Network Agreement</h2>
        ${legalBlock(agreement, "MKW Partner Network Agreement")}
        <p class="small">${
          accepted
            ? `Accepted online: version ${accepted.version}${accepted.version !== agreement.version ? ` (the current version is ${agreement.version}; please read and accept it)` : ""}, ${dateTime(accepted.at)}.`
            : "Not yet accepted online."
        } The signed copy is still uploaded under Documents and verified by MKW Advisors before the firm is signed.</p>
        ${mine && admin && (!accepted || accepted.version !== agreement.version) ? `<button class="sm primary" data-act="agreement-accept" data-version="${agreement.version}">I accept version ${agreement.version}</button>` : ""}
      </div>`
    : "";
  const roster = isPlatform()
    ? `<div class="card"><h2>From the partner roster</h2><dl class="small">
        <dt>Partner ID</dt><dd>${esc(pr.sourceId ?? "–")}</dd>
        <dt>Segment</dt><dd>${esc(pr.segment ?? "–")}</dd>
        <dt>Business contact</dt><dd>${esc([pr.contact?.email, pr.contact?.phone, pr.contact?.website].filter(Boolean).join(" · ") || "–")}</dd>
        <dt>Free zones served</dt><dd>${esc((pr.freeZones ?? []).join(", ") || "–")}</dd>
        <dt>Licensing authority</dt><dd>${esc(pr.licensingAuthority ?? "–")}</dd>
        <dt>FTA tax agent</dt><dd>${pr.ftaTaxAgent ? "confirmed" : `not confirmed${pr.ftaTaxAgentClaim && !/^no$/i.test(pr.ftaTaxAgentClaim) ? ` ${badge("UNCERTAIN", "check the FTA register")}` : ""}`}</dd>
        <dt>Notes</dt><dd>${esc(pr.importNotes ?? "–")}</dd></dl></div>`
    : "";
  const canAct = isPlatform() && ["ops", "founder"].includes(role());
  const all = await deliverables();
  const emirates = ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Umm Al Quwain", "Fujairah", "All"];
  const latest = f.scorecards?.[0];
  const docRow = (d) => `<tr><td>${esc(words(d.kind))}${d.reference ? `<br><span class="small muted">${esc(d.reference)}</span>` : ""}</td><td class="small"><a href="/api/partner-documents/${d.id}/file" target="_blank" rel="noopener">${esc(d.fileName)}</a><br><span class="muted">${dateTime(d.uploadedAt)}</span></td><td class="small">${d.expiresOn ? date(d.expiresOn) : "–"}</td>
    <td>${badge(d.status === "verified" ? "ok" : d.status === "rejected" ? "bad" : d.status === "superseded" ? "expired" : "UNCERTAIN", d.status === "uploaded" ? "awaiting MKW check" : words(d.status))}${d.note ? `<br><span class="small muted">${esc(d.note)}</span>` : ""}</td>
    <td>${canAct && d.status === "uploaded" ? `<button class="sm primary" data-act="doc-review" data-id="${d.id}" data-decision="verified">Verify</button> <button class="sm" data-act="doc-review" data-id="${d.id}" data-decision="rejected">Reject</button>` : ""}</td></tr>`;
  $app.innerHTML = `
  ${isPlatform() ? `<p><a href="#/partners">← Partners</a></p>` : ""}
  <div class="row between"><h1>${esc(f.org.name)}</h1>${badge(pr.status ?? "prospect")}</div>
  <p class="muted">${mine ? "Your application, documents, staff and scorecard with MKW Advisors." : "Onboarding pipeline: prospect → contacted → applied → under review → pilot → signed. Pilot needs a verified, unexpired trade licence; signed needs the agreement and insurance too."}</p>
  <div class="kpis">
    <div class="kpi"><b>${latest ? latest.score : pr.quality ?? "–"}</b><span>Quality score${latest?.provisional ? " (provisional)" : ""}</span></div>
    <div class="kpi"><b>${pr.licenceActive ? "active" : "not active"}</b><span>Trade licence${pr.licenceExpiry ? ` · expires ${date(pr.licenceExpiry)}` : ""}</span></div>
    <div class="kpi"><b>${pr.agreementSigned ? "signed" : "not yet"}</b><span>Partner Network Agreement</span></div>
    <div class="kpi"><b>${pr.capacity ?? "–"}</b><span>Capacity (jobs at a time)</span></div>
  </div>
  ${canAct ? `<div class="card"><form class="row" data-form="partner-move" data-id="${orgId}"><label>Move to</label><select name="status" style="width:auto">${(f.moves ?? []).map((m) => `<option value="${m}">${esc(words(m))}</option>`).join("")}</select><input name="note" placeholder="Why (recorded and sent to the firm)" required minlength="3" style="max-width:360px" /><button class="sm primary" type="submit">Record</button></form></div>` : ""}
  <div class="grid cols-2">
    <div class="card"><h2>Application</h2>
      ${mine && admin && ["prospect", "contacted", "applied", "under_review"].includes(pr.status ?? "prospect") ? `<form data-form="application" class="stack">
        <div class="grid cols-2">
          <div class="field"><label>Trade licence number</label><input name="licenceNumber" value="${esc(pr.licenceNumber ?? "")}" required /></div>
          <div class="field"><label>Licence expiry (as on the licence; MKW verifies the document)</label><input name="licenceExpiry" type="date" value="${esc(pr.declaredLicenceExpiry ?? pr.licenceExpiry ?? "")}" required /></div>
          <div class="field"><label>Capacity (jobs at a time)</label><input name="capacity" type="number" min="0" max="500" value="${pr.capacity ?? 5}" required /></div>
          <div class="field"><label>Regulated capabilities</label>
            <label class="small"><input type="checkbox" name="ftaTaxAgent" ${pr.ftaTaxAgent ? "checked" : ""} /> FTA registered tax agent</label><br>
            <label class="small"><input type="checkbox" name="registeredLiquidator" ${pr.registeredLiquidator ? "checked" : ""} /> Registered liquidator</label><br>
            <label class="small"><input type="checkbox" name="licensedLawFirm" ${pr.licensedLawFirm ? "checked" : ""} /> Licensed law firm</label><br>
            <label class="small"><input type="checkbox" name="regulatoryAdviser" ${pr.regulatoryAdviser ? "checked" : ""} /> DFSA/FSRA/VARA adviser</label></div>
        </div>
        <div class="field"><label>Emirates covered</label><div class="row">${emirates.map((em) => `<label class="small"><input type="checkbox" name="emirates" value="${em}" ${(pr.emirates ?? []).includes(em) ? "checked" : ""} /> ${em}</label>`).join(" ")}</div></div>
        <div class="field"><label>Services offered</label><details><summary class="small">${(pr.codes ?? []).length} selected</summary><div class="grid cols-3">${all.map((d) => `<label class="small"><input type="checkbox" name="codes" value="${esc(d.code)}" ${(pr.codes ?? []).includes(d.code) ? "checked" : ""} /> ${esc(d.name)}</label>`).join("")}</div></details></div>
        <div class="field"><label>About the firm</label><textarea name="about" maxlength="2000">${esc(pr.about ?? "")}</textarea></div>
        <div class="row"><button class="sm primary" type="submit">${pr.status === "prospect" || pr.status === "contacted" ? "Submit application" : "Update application"}</button></div></form>`
      : `${mine ? `<p class="small muted">Your application is on record. Ask MKW Advisors to change coverage, services or capacity.</p>` : ""}<dl class="small"><dt>Licence</dt><dd>${esc(pr.licenceNumber ?? "–")}${pr.licenceExpiry ? `, verified to ${date(pr.licenceExpiry)}` : pr.declaredLicenceExpiry ? `, declared to ${date(pr.declaredLicenceExpiry)} (not yet verified)` : ""}</dd><dt>Emirates</dt><dd>${esc((pr.emirates ?? []).join(", ") || "–")}</dd><dt>Services</dt><dd>${esc((pr.codes ?? []).join(", ") || "–")}</dd><dt>Capabilities</dt><dd>${esc([pr.ftaTaxAgent && "FTA tax agent", pr.registeredLiquidator && "liquidator", pr.licensedLawFirm && "law firm", pr.regulatoryAdviser && "regulatory adviser"].filter(Boolean).join(", ") || "–")}</dd><dt>About</dt><dd>${esc(pr.about ?? "–")}</dd></dl>`}
    </div>
    <div class="stack">
      ${agreementCard}
      ${roster}
      <div class="card flush"><h2>Documents</h2>
        ${table(["Document", "File", "Expires", "Status", ""], (f.documents ?? []).map(docRow), "No documents yet.")}
        ${(mine && admin) || canAct ? `<form class="pad grid cols-3" data-form="partner-doc" data-id="${orgId}" style="padding-top:8px">
          <div><label>Kind</label><select name="kind">${DOC_KINDS.map((k) => `<option value="${k}">${esc(words(k))}</option>`).join("")}</select></div>
          <div><label>Reference (optional)</label><input name="reference" placeholder="Licence or policy number" /></div>
          <div><label>Expiry (licence, insurance)</label><input name="expiresOn" type="date" /></div>
          <div style="grid-column:1/-1" class="row"><input type="file" name="file" required style="width:auto;max-width:100%" /><button class="sm primary" type="submit">Upload</button></div></form>
          <p class="small muted pad" style="padding-top:0">Trade licence, professional indemnity insurance, bank letter and the signed Partner Network Agreement. MKW Advisors verifies each one.</p>` : ""}
      </div>
      <div class="card flush"><h2>People</h2>
        ${table(["Name", "Email", "Role", "Status", ""], (f.staff ?? []).map((u) => `<tr><td>${esc(u.name)}</td><td class="mono small">${esc(u.email)}</td><td>${esc(words(u.role))}</td><td>${badge(u.status === "active" ? "ok" : "expired", u.status)}</td>
          <td>${mine && admin && u.role === "partner_staff" && u.status !== "erased" ? `<button class="sm" data-act="staff-active" data-id="${u.id}" data-active="${u.status === "active" ? "0" : "1"}">${u.status === "active" ? "Remove" : "Reactivate"}</button>` : ""}</td></tr>`))}
        ${mine && admin ? `<form class="pad row" data-form="staff-invite" style="padding-top:8px"><input name="name" placeholder="Name" required minlength="2" style="max-width:200px" /><input name="email" type="email" placeholder="Work email" required style="max-width:260px" /><button class="sm" type="submit">Add staff</button></form><p class="small muted pad" style="padding-top:0">Staff can work steps and upload evidence; only you accept work, set prices and bank details.</p>` : ""}
      </div>
      <div class="card flush"><h2>Scorecard</h2>
        ${table(["Computed", "#Score", "On time", "First-pass QA", "Disputes", "Strikes", "Rating"], (f.scorecards ?? []).map((c) => `<tr><td class="small">${date(c.computedAt ?? c.computed_at)}${c.provisional ? ` ${badge("UNCERTAIN", "provisional")}` : ""}</td><td class="num"><b>${c.score}</b></td><td class="num">${c.inputs.milestonesOnTime}/${c.inputs.milestonesDone}</td><td class="num">${c.inputs.qaFirstPass}/${c.inputs.qaSubmissions}</td><td class="num">${c.inputs.disputes}</td><td class="num">${c.inputs.slaStrikes}</td><td class="num">${c.inputs.rating ?? "–"}</td></tr>`), "Recomputed weekly from the last 90 days: on-time 40, first-pass QA 20, disputes 15, acceptance strikes 15, client rating 10.")}
      </div>
    </div>
  </div>`;
}

export async function renderPartnerPerformance() {
  const d = await api("GET", "/api/partner/dashboard");
  const by = (s) => d.jobs.find((j) => j.status === s)?.n ?? 0;
  const pay = (s) => d.payouts.find((p) => p.status === s)?.total ?? 0;
  $app.innerHTML = `<h1>Your performance</h1>
  <p class="muted">What MKW Advisors sees of your firm: jobs, on-time delivery, payouts and the weekly scorecard that decides who gets work.</p>
  <div class="kpis">
    <div class="kpi"><b>${by("in_delivery") + by("allocating") + by("disputed")}</b><span>Jobs in delivery</span></div>
    <div class="kpi"><b>${by("completed")}</b><span>Jobs completed</span></div>
    <div class="kpi"><b>${(d.milestones.onTimeRate * 100).toFixed(0)}%</b><span>Steps on time (${d.milestones.onTime} of ${d.milestones.done})</span></div>
    <div class="kpi"><b>${d.milestones.late}</b><span>Steps late now</span></div>
    <div class="kpi"><b>${aed(pay("released"))}</b><span>Paid to you</span></div>
    <div class="kpi"><b>${aed(pay("eligible"))}</b><span>Due now (invoice us)</span></div>
    <div class="kpi"><b>${d.rating.average ?? "–"}</b><span>Client rating (${d.rating.count})</span></div>
    <div class="kpi"><b>${d.scorecards[0]?.score ?? "–"}</b><span>Quality score</span></div>
  </div>
  <div class="card flush"><h2>Scorecard trend</h2>${table(["Computed", "#Score", "On time", "First-pass QA", "Disputes", "Strikes", "Rating"], d.scorecards.map((c) => `<tr><td class="small">${date(c.computedAt)}${c.provisional ? ` ${badge("UNCERTAIN", "provisional")}` : ""}</td><td class="num"><b>${c.score}</b></td><td class="num">${c.inputs.milestonesOnTime}/${c.inputs.milestonesDone}</td><td class="num">${c.inputs.qaFirstPass}/${c.inputs.qaSubmissions}</td><td class="num">${c.inputs.disputes}</td><td class="num">${c.inputs.slaStrikes}</td><td class="num">${c.inputs.rating ?? "–"}</td></tr>`), "No scorecard yet; MKW Advisors computes it weekly.")}</div>`;
}

export async function renderPartnerPayouts() {
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

export async function renderRateCards() {
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

// Tasees workspace: engagement module (split from app.js in O12; plain ES modules, no build step).
import { $app, MILESTONE_LABEL, aed, api, badge, byStage, date, dateTime, dropzone, esc, isClient, isPartner, isPlatform, nameOf, role, seesMargin, table, uploadRules, words } from "./core.js";
import { nextActionCard } from "./client.js";

export async function renderEngagement(id) {
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
        <input type="file" name="file" required style="width:auto;max-width:100%" /><button class="sm" type="submit">Upload</button><p class="field-msg small" aria-live="polite"></p></form>
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
  const delayFor = (mid) => (e.delays ?? []).find((d) => d.milestoneId === mid);
  const delayLine = (m) => {
    const d = delayFor(m.id);
    if (!d || m.status === "client_approved") return "";
    return `<div class="small"><span class="badge bad">late</span> due ${date(d.dueDate)}, now expected by ${date(d.expectedDate)}${isPlatform() ? d.cause ? ` · ${esc(d.cause)}: ${esc(d.causeNote ?? "")}` : ` · <a href="#/delays">attribute on Delays</a>` : ""}</div>`;
  };
  const docsFor = (mid) => (e.documentRequests ?? []).filter((r) => r.milestoneId === mid);
  const docsCard = () => {
    const list = e.documentRequests ?? [];
    if (!list.length) return "";
    const open = list.filter((r) => ["requested", "rejected"].includes(r.status)).length;
    const row = (r) => {
      const step = ms.find((m) => m.id === r.milestoneId);
      const file = r.fileName ? `<a href="/api/document-requests/${r.id}/file" target="_blank" rel="noopener">${esc(r.fileName)}</a>` : "–";
      let action = "";
      if (isClient() && ["requested", "rejected"].includes(r.status)) action = `<form class="row" data-form="doc-upload" data-id="${r.id}"><input type="file" name="file" required style="width:auto;max-width:100%" /><button class="sm primary" type="submit">Upload</button></form>`;
      if ((isPartner() || ["ops", "founder"].includes(role())) && r.status === "uploaded") action = `<button class="sm primary" data-act="doc-decide" data-id="${r.id}" data-decision="received">Received</button> <button class="sm" data-act="doc-decide" data-id="${r.id}" data-decision="rejected">Ask again</button>`;
      return `<tr><td>${esc(words(r.kind))}${r.note ? `<br><span class="small muted" data-no-i18n>${esc(r.note)}</span>` : ""}<br><span class="small muted">${esc(step?.name ?? "")}</span></td><td>${badge(r.status === "received" ? "ok" : r.status === "rejected" ? "bad" : r.status, r.status === "rejected" ? `ask again: ${r.decisionNote ?? ""}` : words(r.status))}</td><td class="small">${file}</td><td>${action}</td></tr>`;
    };
    const addForm = isPartner() && nextOpenId ? `<form class="pad row" data-form="doc-request" data-id="${nextOpenId}" style="padding-top:8px"><input name="kind" placeholder="Document to ask for" required minlength="3" style="max-width:240px" /><input name="note" placeholder="Note to the client (optional)" style="max-width:300px" /><button class="sm" type="submit">Ask the client</button></form>` : "";
    return `<div class="card flush"><h2>Documents from the client ${open ? badge("pending", `${open} to upload`) : badge("ok", "complete")}</h2>
      ${isClient() ? `<p class="small muted pad" style="padding-top:0">Upload what each step needs. Files are stored in the UAE and shared only with the firm doing the work.</p>` : ""}
      ${table(["Document", "Status", "File", ""], list.map(row))}${addForm}</div>`;
  };
  const creditsCard = () => {
    const list = e.credits ?? [];
    if (!list.length) return "";
    return `<div class="card flush"><h2>Service guarantee</h2>${table(
      ["Step", "#Credit", "Status", ...(isPlatform() ? ["Borne by", ""] : [])],
      list.map((c) => `<tr><td>${esc(c.step ?? ms.find((m) => m.id === c.milestoneId)?.name ?? "")}</td><td class="num">${aed(c.amount)}</td><td>${badge(c.status === "applied" || c.status === "settled" ? "ok" : c.status === "waived" ? "expired" : "pending", c.status === "applied" ? "deducted from your balance" : words(c.status))}${c.settledReference ? ` <span class="small muted">${esc(c.settledReference)}</span>` : ""}</td>
        ${isPlatform() ? `<td class="small">${c.borneByPartner ? "partner" : "MKW"}${c.payoutReduction ? ` · payout −${aed(c.payoutReduction)}` : ""}</td><td>${c.status === "pending" && seesMargin() ? `<button class="sm primary" data-act="credit" data-id="${c.id}" data-decision="approve">Approve</button> <button class="sm" data-act="credit" data-id="${c.id}" data-decision="waive">Waive</button>` : c.status === "approved" && seesMargin() ? `<button class="sm" data-act="credit-settle" data-id="${c.id}">Record refund</button>` : ""}</td>` : ""}</tr>`),
    )}${isClient() ? `<p class="small muted pad" style="padding-top:0">A step more than five working days late earns you a credit of part of its fee, by rule.</p>` : ""}</div>`;
  };
  const ratingCard = () => {
    if (e.engagement.status !== "completed") return "";
    const r = e.rating;
    if (r) return `<div class="card"><h2>${isPartner() ? "Client rating" : "Your rating"}</h2><p>${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)} <span class="small muted">${date(r.createdAt)}</span></p>${(isPlatform() ? r.commentOriginal : r.comment) ? `<p class="small" data-no-i18n>${esc(isPlatform() ? r.commentOriginal : r.comment)}</p>` : ""}</div>`;
    if (isClient() && role() === "client_owner")
      return `<form class="card" data-form="rating" data-id="${e.engagement.id}"><h2>How did it go?</h2><p class="small muted">Your rating feeds the partner's scorecard, which decides who gets work.</p>
        <div class="row"><select name="stars" style="width:auto"><option value="5">5 ★ excellent</option><option value="4">4 ★ good</option><option value="3">3 ★ fair</option><option value="2">2 ★ poor</option><option value="1">1 ★ bad</option></select></div>
        <textarea name="comment" placeholder="What went well, what did not (optional)"></textarea><div class="row" style="margin-top:8px"><button class="sm primary" type="submit">Send rating</button></div></form>`;
    return "";
  };
  const manualAllocation = () => {
    if (!isPlatform() || !["ops", "founder"].includes(role()) || e.engagement.status !== "allocating") return "";
    const openLines = e.lines.filter((l) => !l.partner);
    if (!openLines.length || !(e.candidates ?? []).length) return "";
    return `<form class="pad grid cols-3" data-form="manual-alloc" data-id="${e.engagement.id}" style="padding-top:8px">
      <div><label>Allocate by hand to</label><select name="partnerId">${e.candidates.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(words(c.status ?? ""))}, quality ${c.quality ?? "–"})</option>`).join("")}</select></div>
      <div><label>Lines</label>${openLines.map((l) => `<label class="small"><input type="checkbox" name="codes" value="${esc(l.code)}" checked /> ${esc(l.name)}</label>`).join("<br>")}</div>
      <div><label>Why (recorded)</label><input name="reason" required minlength="5" placeholder="Client asked for this firm after the call" /><button class="sm" type="submit" style="margin-top:6px">Offer to this partner</button></div></form>
      <p class="small muted pad" style="padding-top:0">Eligibility and the priced-cost check still apply; the audit trail records who chose and why.</p>`;
  };

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
      ${["ops", "founder"].includes(role()) ? `<div class="pad" style="padding-top:8px"><button class="sm" data-act="reallocate" data-id="${e.engagement.id}">Allocate open lines now</button></div>` : ""}${manualAllocation()}</div>`;
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
    return `<div class="card flush" id="changes" tabindex="-1"><h2>Changes to scope</h2>${table(["Change", "#Amount", "Status", ""], rows, "No changes.")}${form}</div>`;
  };

  const messagesCard = () => `<div class="card"><h2>Messages</h2>
        <div class="messages">${
          e.messages.length
            ? e.messages
                .map(
                  (m) => `<div class="msg"><div class="meta"><span data-no-i18n>${esc(m.authorName)}</span> · ${dateTime(m.createdAt)}${m.masked ? " · contact details hidden" : ""}</div>
                  <div data-no-i18n>${esc(isPlatform() ? m.bodyOriginal : m.bodyShown)}</div>${isPlatform() && m.masked ? `<div class="small muted">Shown to parties: ${esc(m.bodyShown)}</div>` : ""}</div>`,
                )
                .join("")
            : `<p class="muted small">No messages yet.</p>`
        }</div>
        <form data-form="message" data-id="${e.engagement.id}"><textarea name="body" required placeholder="Write a message. Phone numbers and emails are hidden from the other side; MKW Advisors sees everything."></textarea>
        <div class="row" style="margin-top:8px"><button class="sm primary" type="submit">Send</button></div></form>
      </div>`;

  if (isClient()) return renderClientEngagement(e, { evidenceFor, delayLine, moneyCard, creditsCard, ratingCard, changeOrders, messagesCard, partnerNames, done });

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
                ${delayLine(m)}
                ${docsFor(m.id).length ? `<div class="small muted">Client documents: ${docsFor(m.id).filter((r) => r.status === "received").length}/${docsFor(m.id).length} received</div>` : ""}
                ${m.qaNote ? `<div class="small">MKW note: <span data-no-i18n>${esc(m.qaNote)}</span></div>` : ""}
                ${m.disputeReason ? `<div class="small">Client issue: <span data-no-i18n>${esc(m.disputeReason)}</span></div>` : ""}
                ${evidenceFor(m.id).length ? `<div class="small">${evidenceFor(m.id).map((x) => `<a href="/api/evidence/${x.id}/file" target="_blank" rel="noopener">${esc(x.fileName)}</a> <span class="muted">(${esc(words(x.type))})</span>`).join(" · ")}</div>` : ""}
                ${milestoneActions(m)}</div></li>`,
              )
              .join("")}</ul>`
          : `<p class="muted">Steps appear when a partner accepts the work.</p>`
      }
    </div>
    <div class="stack">
      ${docsCard()}
      ${ratingCard()}
      ${moneyCard()}
      ${creditsCard()}
      ${changeOrders()}
      ${messagesCard()}
    </div>
  </div>`;
}

// The client's engagement (O12): the next action pinned above a timeline, the documents as a checklist ---------------

const STATE_LABEL = { done: "Done", now: "Waiting for you", mkw: "MKW Advisors is checking", partner: "In progress", upcoming: "Coming up", issue: "Issue raised" };
const STATE_TONE = { done: "ok", now: "warn", mkw: "info", partner: "info", upcoming: "", issue: "bad" };

function renderClientEngagement(e, parts) {
  const j = e.journey;
  const payments = new Map((e.payments ?? []).map((p) => [p.id, p]));
  const entry = (t) => {
    const pay = t.kind === "payment" ? payments.get(t.ref) : null;
    const when =
      t.kind === "step"
        ? t.state === "done"
          ? `Approved ${date(t.date)}`
          : t.date
            ? `Expected by ${date(t.date)}`
            : ""
        : t.date
          ? date(t.date)
          : "";
    const evidence = t.kind === "step" && ["done", "now"].includes(t.state) ? parts.evidenceFor(t.ref) : [];
    const step = t.kind === "step" ? e.milestones.find((m) => m.id === t.ref) : null;
    return `<li class="tl ${t.state}"><span class="tl-dot" aria-hidden="true"></span><div class="tl-body">
      <div class="row between"><b id="tl-${esc(t.ref ?? t.kind)}">${esc(t.label)}</b><span class="badge ${STATE_TONE[t.state]}">${STATE_LABEL[t.state]}</span></div>
      ${when ? `<div class="small muted">${esc(when)}</div>` : ""}
      ${t.note ? `<div class="small">${esc(t.note)}</div>` : ""}
      ${t.detail ? `<div class="small">Your words: <span data-no-i18n>${esc(t.detail)}</span></div>` : ""}
      ${step ? parts.delayLine(step) : ""}
      ${evidence.length ? `<div class="small">Evidence: ${evidence.map((x) => `<a href="/api/evidence/${x.id}/file" target="_blank" rel="noopener">${esc(x.fileName)}</a>`).join(" · ")}</div>` : ""}
      ${t.kind === "step" && t.state === "now" ? `<div class="actions"><button class="sm primary" data-act="ms-review" data-id="${t.ref}" data-approve="1" aria-describedby="tl-${esc(t.ref)}">Approve</button><button class="sm danger" data-act="ms-review" data-id="${t.ref}" data-approve="0" aria-describedby="tl-${esc(t.ref)}">Raise an issue</button></div>` : ""}
      ${pay && pay.status === "pending" && pay.payUrl ? `<div class="actions"><a class="btn sm primary" href="${esc(pay.payUrl)}">Pay by card</a></div>` : ""}
    </div></li>`;
  };
  const docs = e.documentRequests ?? [];
  const missing = docs.filter((r) => ["requested", "rejected"].includes(r.status)).length;
  const docItem = (r) => {
    const status =
      r.status === "received"
        ? badge("ok", "received")
        : r.status === "uploaded"
          ? badge("info", "uploaded: being checked")
          : r.status === "rejected"
            ? badge("bad", "sent back")
            : badge("pending", "needed");
    return `<li class="${esc(r.status)}"><div class="row between"><b>${esc(words(r.kind))}</b>${status}</div>
      ${r.note ? `<div class="small muted" data-no-i18n>${esc(r.note)}</div>` : ""}
      ${r.status === "rejected" && r.decisionNote ? `<div class="small">Why it was sent back: <span data-no-i18n>${esc(r.decisionNote)}</span></div>` : ""}
      ${
        ["requested", "rejected"].includes(r.status)
          ? `<form class="upload-row" data-form="doc-upload" data-id="${r.id}">${dropzone(r.kind, "Drop the file here, or choose it")}<button class="sm primary" type="submit">Upload</button></form>`
          : r.fileName
            ? `<div class="small"><a href="/api/document-requests/${r.id}/file" target="_blank" rel="noopener">${esc(r.fileName)}</a></div>`
            : ""
      }</li>`;
  };
  const checklist = docs.length
    ? `<section class="card" id="docs" tabindex="-1" aria-labelledby="docs-h"><h2 id="docs-h">Documents we need from you ${missing ? badge("pending", `${missing} to upload`) : badge("ok", "complete")}</h2>
      <p class="small muted">Each file is checked here before it is sent: PDF, a photo, Word or Excel, up to ${Math.round(uploadRules.maxBytes / 1024 / 1024)} MB. Files are stored in the UAE and shared only with the firm doing the work.</p>
      ${[...new Set(docs.map((r) => r.milestoneId))]
        .map((mid) => `<h3 class="checklist-step">Needed for ${esc(e.milestones.find((m) => m.id === mid)?.name ?? "this step")}</h3><ul class="checklist">${docs.filter((r) => r.milestoneId === mid).map(docItem).join("")}</ul>`)
        .join("")}</section>`
    : "";
  $app.innerHTML = `
  <p><a href="#/">← Overview</a></p>
  <div class="row between"><h1>Your engagement · ${esc(e.engagement.emirate)}${e.engagement.freeZone ? ` · ${esc(e.engagement.freeZone)}` : ""}</h1>${badge(e.engagement.status)}</div>
  <p class="muted">${parts.done} of ${e.milestones.length} steps approved${parts.partnerNames.length ? ` · Delivered by ${esc(parts.partnerNames.join(", "))}, managed by MKW Advisors` : ""}</p>
  ${nextActionCard(j.actions, j.whatsNext, { inline: true, evidenceFor: parts.evidenceFor })}
  <div class="grid cols-2 eng">
    <section class="card" aria-labelledby="steps-h"><h2 id="steps-h">Steps</h2>
      <ol class="timeline">${j.timeline.map(entry).join("")}</ol>
      <p class="small muted">Every step is checked by MKW Advisors before it comes to you. Approving it releases the partner's payment for that step; if you do nothing for five working days after our check, it is approved automatically.</p>
    </section>
    <div class="stack">
      ${checklist}
      ${parts.moneyCard()}
      ${parts.creditsCard()}
      ${parts.ratingCard()}
      ${parts.changeOrders()}
      ${parts.messagesCard()}
      <details class="card"><summary><b>What you bought</b></summary>${table(
        ["Service", "#Qty", "#Fee each", "#Govt fee each"],
        e.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${l.qty}</td><td class="num">${aed(l.clientUnitPrice)}</td><td class="num">${aed(l.govUnitFee)}</td></tr>`),
      )}</details>
    </div>
  </div>`;
}

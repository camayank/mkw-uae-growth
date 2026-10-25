// Tasees workspace: events module (split from app.js in O12; plain ES modules, no build step).
import { act, aed, api, date, download, fileToBase64, isPlatform, lang, render, role, route, state, toast, translatePage, translateText } from "./core.js";
import { queueItems, setQueueFilter } from "./ops.js";
import { closeNavMenus, renderSignIn, requestCode } from "./shell.js";

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
    restart: () => {
      renderSignIn();
      translatePage();
    },
    lang: async () => {
      const next = el.dataset.lang;
      try {
        localStorage.setItem("tasees.lang", next);
      } catch {}
      if (state.me) {
        try {
          await api("PUT", "/api/me/locale", { locale: next });
          state.me.locale = next;
        } catch (e) {
          return toast(e.message, true);
        }
      }
      state.untranslated = new Set();
      render();
    },
    demo: () => requestCode(el.dataset.email).catch((e) => toast(e.message, true)),
    "accept-offer": () => {
      const box = document.querySelector("input[data-terms-version]");
      if (box && !box.checked) {
        toast(translateText("Tick the box to accept the client terms first."), true);
        box.focus();
        return;
      }
      if (!confirm(translateText("Accept this offer? We will send the deposit invoice and start allocating the work once it is paid."))) return;
      act(async () => {
        const r = await api("POST", `/api/client/offers/${id}/accept`, box ? { termsVersion: Number(box.dataset.termsVersion) } : {});
        location.hash = `#/engagement/${r.engagementId}`;
      }, "Offer accepted. Your deposit invoice is on its way.");
    },
    "nav-group": () => {
      const open = el.getAttribute("aria-expanded") !== "true";
      closeNavMenus(el);
      el.setAttribute("aria-expanded", String(open));
      const menu = document.getElementById(el.getAttribute("aria-controls"));
      if (open) {
        menu?.removeAttribute("hidden");
        menu?.querySelector("a")?.focus();
      } else menu?.setAttribute("hidden", "");
    },
    "agreement-accept": () => {
      if (!confirm(`Accept version ${el.dataset.version} of the MKW Partner Network Agreement for your firm? MKW Advisors records who accepted and when.`)) return;
      act(() => api("POST", "/api/partner/agreement/accept", { version: Number(el.dataset.version) }), "Accepted. Upload the signed copy under Documents as well.");
    },
    "holiday-remove": () => {
      const reason = prompt("Why is this date being removed? (recorded in the audit trail)");
      if (!reason) return;
      act(() => api("DELETE", `/api/admin/holidays/${el.dataset.date}`, { reason }), "Holiday removed");
    },
    "holiday-confirm": () => {
      const reason = prompt("Where was it announced? (recorded in the audit trail)");
      if (!reason) return;
      act(() => api("PUT", "/api/admin/holidays", { date: el.dataset.date, name: el.dataset.name, note: el.dataset.note || "", status: "confirmed", reason }), "Holiday confirmed");
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
    "queue-filter": () => {
      setQueueFilter(el.dataset.kind);
      translatePage();
    },
    "queue-open": () => {
      // Handling time starts when a person opens the item; the link still navigates as usual.
      api("POST", "/api/ops/queue/open", { id: el.dataset.item }).catch(() => {});
    },
    "queue-act": () => {
      const item = queueItems.find((x) => x.id === el.dataset.item);
      const a = item?.actions[Number(el.dataset.n)];
      if (!a) return;
      let body = { ...a.body };
      if (a.prompt) {
        const note = prompt(a.prompt, "");
        if (note === null) return;
        if (!/optional/i.test(a.prompt) && !note.trim()) return toast("A note is needed for this one", true);
        body = { ...body, note: note.trim() };
      }
      act(async () => {
        await api("POST", "/api/ops/queue/open", { id: item.id }).catch(() => {});
        await api(a.method, a.path, body);
      }, `${a.label}: done`);
    },
    "draft-agree": () => act(() => api("POST", `/api/ops/drafts/${id}/review`, { decision: "approve" }), "Recorded: you agree with the check"),
    "draft-disagree": () => {
      const note = prompt("What is wrong with the check? (optional)", "");
      if (note === null) return;
      act(() => api("POST", `/api/ops/drafts/${id}/review`, { decision: "discard", note }), "Recorded: you disagree with the check");
    },
    "run-jobs": () =>
      act(async () => {
        const r = await api("POST", "/api/ops/jobs/run");
        toast(`Timers run: ${r.allocationTimeouts} re-routed, ${r.autoApprovals} auto-approved, ${r.offersExpired} offers expired`);
      }, null),
    scorecards: () => act(() => api("POST", "/api/ops/scorecards/recompute"), "Scorecards recomputed"),
    "doc-review": () => {
      const decision = el.dataset.decision;
      const note = decision === "rejected" ? prompt("Why is the document rejected? (sent to the firm)") : prompt("Note (optional)", "") ?? "";
      if (decision === "rejected" && !note) return;
      return act(() => api("POST", `/api/ops/partner-documents/${id}/review`, { decision, note: note || "" }), decision === "verified" ? "Document verified" : "Document rejected");
    },
    "staff-active": () => act(() => api("POST", `/api/partner/staff/${id}/active`, { active: el.dataset.active === "1" }), "Updated"),
    "doc-decide": () => {
      const decision = el.dataset.decision;
      const note = decision === "rejected" ? prompt("What is wrong with it? (sent to the client)") : "";
      if (decision === "rejected" && !note) return;
      return act(() => api("POST", `/api/document-requests/${id}/decide`, { decision, note: note || "" }), decision === "received" ? "Marked received" : "Client asked again");
    },
    credit: () => {
      const decision = el.dataset.decision;
      const note = decision === "waive" ? prompt("Why is the credit waived? (recorded)") : prompt("Note (optional)", "") ?? "";
      if (decision === "waive" && !note) return;
      return act(() => api("POST", `/api/ops/credits/${id}/decide`, { decision, note: note || "" }), decision === "approve" ? "Credit approved" : "Credit waived");
    },
    "obligation-met": () => {
      const note = prompt("What was the evidence checked against? (recorded)", "") ?? "";
      return act(() => api("POST", `/api/ops/obligations/${id}/met`, { note }), "Marked met; next occurrence scheduled where it recurs");
    },
    "obligation-waive": () => {
      const reason = prompt("Why does this obligation not apply? (recorded)");
      if (!reason) return;
      return act(() => api("POST", `/api/ops/obligations/${id}/waive`, { reason }), "Waived");
    },
    "credit-settle": () => {
      const reference = prompt("Refund or transfer reference");
      if (!reference) return;
      return act(() => api("POST", `/api/ops/credits/${id}/settle`, { reference }), "Settled");
    },
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
  if (kind === "doc-upload" || kind === "partner-doc") {
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) return toast("Choose a file", true);
    if (file.size > 15 * 1024 * 1024) return toast("Files must be under 15 MB", true);
    return act(async () => {
      const contentBase64 = await fileToBase64(file);
      if (kind === "doc-upload") await api("POST", `/api/document-requests/${id}/upload`, { fileName: file.name, contentBase64 });
      else await api("POST", `/api/partners/${id}/documents`, { kind: String(fd.get("kind")), fileName: file.name, contentBase64, reference: String(fd.get("reference") || "") || undefined, expiresOn: String(fd.get("expiresOn") || "") || undefined });
    }, "Uploaded");
  }
  if (kind === "obligation-evidence") {
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) return toast("Choose a file", true);
    if (file.size > 15 * 1024 * 1024) return toast("Files must be under 15 MB", true);
    return act(async () => {
      await api("POST", `/api/obligations/${id}/evidence`, { fileName: file.name, contentBase64: await fileToBase64(file) });
    }, "Uploaded; MKW Advisors will check it and mark the obligation met");
  }
  if (kind === "arabic-review") {
    const value = ev.submitter?.value;
    const reviewed = value === "1";
    const previewEmails = String(fd.get("previewEmails") || "").split(",").map((e) => e.trim()).filter(Boolean);
    if (value === "0" && !confirm("Withdraw the Arabic sign-off? Clients on Arabic go back to English at once.")) return;
    return act(() => api("POST", "/api/admin/arabic/review", { reviewed, reviewedBy: String(fd.get("reviewedBy") || "") || undefined, note: String(fd.get("note") || ""), previewEmails }), reviewed ? "Arabic sign-off recorded; clients may now choose Arabic" : value === "preview" ? "Preview accounts saved" : "Sign-off withdrawn");
  }
  if (kind === "obligation-add") return act(() => api("POST", `/api/ops/clients/${String(fd.get("client"))}/obligations`, { kind: String(fd.get("kind")), title: String(fd.get("title")), dueDate: String(fd.get("dueDate")), recurrence: String(fd.get("recurrence")), basis: String(fd.get("basis") || "") || undefined }), "Added");
  if (kind === "obligation-confirm") {
    const dueDate = String(fd.get("dueDate") || "") || undefined;
    const allowPast = dueDate && dueDate < new Date().toISOString().slice(0, 10) ? confirm("That date is in the past: the client will be emailed that it is overdue at once. Continue?") : false;
    if (dueDate && dueDate < new Date().toISOString().slice(0, 10) && !allowPast) return;
    return act(() => api("POST", `/api/ops/obligations/${id}/confirm`, { dueDate, note: String(fd.get("note")), ...(allowPast ? { allowPast: true } : {}) }), "Confirmed; the client now sees it");
  }
  if (kind === "period") {
    location.hash = `#/dashboard/${encodeURIComponent(String(fd.get("period")))}`;
    return;
  }
  if (kind === "accounting-export") {
    const url = `/api/admin/accounting/export?set=${encodeURIComponent(String(fd.get("set")))}&from=${encodeURIComponent(String(fd.get("from")))}&to=${encodeURIComponent(String(fd.get("to")))}`;
    window.open(url, "_blank", "noopener");
    return;
  }
  if (kind === "doc-request") return act(() => api("POST", `/api/milestones/${id}/document-requests`, { kind: String(fd.get("kind")), note: String(fd.get("note") || "") }), "Client asked");
  if (kind === "rating") return act(() => api("POST", `/api/engagements/${id}/rating`, { stars: Number(fd.get("stars")), comment: String(fd.get("comment") || "") }), "Thank you for rating");
  if (kind === "manual-alloc") {
    const codes = fd.getAll("codes").map(String);
    if (!codes.length) return toast("Tick at least one line", true);
    return act(() => api("POST", `/api/ops/engagements/${id}/allocate`, { partnerId: String(fd.get("partnerId")), codes, reason: String(fd.get("reason")) }), "Offered to the partner");
  }
  if (kind === "attribute") return act(() => api("POST", `/api/ops/delays/${id}/attribute`, { cause: String(fd.get("cause")), note: String(fd.get("note")) }), "Recorded");
  if (kind === "partner-move") return act(() => api("POST", `/api/ops/partners/${id}/status`, { status: String(fd.get("status")), note: String(fd.get("note")) }), "Recorded and sent to the firm");
  if (kind === "application") {
    const body = {
      emirates: fd.getAll("emirates").map(String), codes: fd.getAll("codes").map(String), capacity: Number(fd.get("capacity")), licenceNumber: String(fd.get("licenceNumber")), licenceExpiry: String(fd.get("licenceExpiry")),
      ftaTaxAgent: fd.get("ftaTaxAgent") === "on", registeredLiquidator: fd.get("registeredLiquidator") === "on", licensedLawFirm: fd.get("licensedLawFirm") === "on", regulatoryAdviser: fd.get("regulatoryAdviser") === "on", about: String(fd.get("about") || ""),
    };
    return act(() => api("PUT", "/api/partner/application", body), "Application saved");
  }
  if (kind === "staff-invite") return act(() => api("POST", "/api/partner/staff", { name: String(fd.get("name")), email: String(fd.get("email")) }), "Invited");
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
  if (kind === "lead") return act(() => api("POST", `/api/ops/leads/${id}/handle`, { note: String(fd.get("note") || "") }), "Lead marked handled");
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
  if (kind === "legal-signoff") {
    if (!confirm(`Record that ${fd.get("lawyer")} reviewed version ${form.dataset.version} on ${fd.get("approvedOn")}? The draft note disappears for everyone who reads it.`)) return;
    return act(() => api("POST", `/api/admin/legal/${form.dataset.kind}/${form.dataset.version}/sign-off`, { lawyer: String(fd.get("lawyer")), approvedOn: String(fd.get("approvedOn")) }), "Review recorded");
  }
  if (kind === "holiday-set") {
    return act(() => api("PUT", "/api/admin/holidays", { date: String(fd.get("date")), name: String(fd.get("name")), status: String(fd.get("status")), reason: String(fd.get("reason")) }), "Holiday saved");
  }
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

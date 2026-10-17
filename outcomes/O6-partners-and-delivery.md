# O6 Partners and delivery

Status: in-progress (branch `outcome/O6-partners-and-delivery`, stacked on O5)

## Business result

A partner firm can be brought from prospect to signed without email threads: it applies, uploads its trade
licence, insurance, bank letter and the signed Partner Network Agreement, MKW reviews and moves it to pilot
and signed, and the platform watches the licence so an expired one pauses the partner before it is given
work. Delivery gets the pieces that make a job run without MKW chasing: the client is asked for its documents
per step, overdue steps alert ops and the client, a late step past the guarantee window earns the client a
credit by rule (borne by the partner when the delay is theirs), the client rates the work at the end, and the
scorecard that drives allocation is recomputed weekly from what actually happened. Ops can allocate by hand
with a recorded reason, fairness is measured per service category as the agreement says, and the client gets
a branded offer document.

## Scope

1. **Onboarding.** Partner status pipeline `prospect → contacted → applied → under_review → pilot → signed`
   (and `paused` from any live state). The partner admin submits an application (coverage, codes, capacity,
   licence number and expiry, regulated capabilities) and uploads documents of fixed kinds (`trade_licence`,
   `insurance`, `bank_letter`, `agreement`, `other`) into `partner_documents` via the storage adapter. Ops
   verifies each document (audited), moves the partner to pilot (needs a verified trade licence with a
   future expiry) and to signed (needs a verified agreement, which sets `agreementSigned`). Every move is
   audited with a note; the partner is told from "MKW Advisors".
2. **Licence watch.** `profile.licenceExpiry` (date). Daily job: 30 days before expiry the partner and ops
   are warned once; on expiry `licenceActive` becomes false and a signed/pilot partner is paused
   automatically, audited and notified. A new verified trade licence with a later expiry reactivates the
   licence; ops unpauses explicitly.
3. **Scorecard.** `packages/core/src/scorecard.ts` (pure): quality 0–100 from on-time rate (40), first-pass
   QA rate (20), dispute rate (15), SLA strikes (15, each −5), client rating (10). Weekly job writes a
   `scorecards` row per partner (inputs and score) and updates `profile.quality`, `deliveredOnTime` and
   `changeOrderRate`. Partner sees its own score and trend; ops sees all.
4. **Partner staff.** Partner admin invites, deactivates and reactivates `partner_staff` of its own firm;
   staff can work steps but never accept work, maintain rate cards, bank details or invoices (as today).
5. **Client document requests.** `document_requests` per milestone from a per-code checklist
   (`CLIENT_DOCUMENTS` in core: passport, photo, Emirates ID, NOC, …), created when the partner accepts;
   partner may add one. Client uploads (storage adapter), partner marks received or asks again; the partner
   is told when a step's set is complete. Clients see only their own; partners only their steps.
6. **Delay watch and service guarantee.** Daily job: an `in_progress`/`pending` milestone past its due date
   gets a `delays` row once (ops alerted, client told with the new expected date = due + 5 working days,
   partner told). Ops attributes the delay (`partner`, `client`, `government`, `mkw`) with a note. Past
   `GUARANTEE_DAYS` (5 working days) a `guarantee_credits` row is created by rule: `guarantee_bp` (1000 =
   10%, owner decision, in settings) of the late step's share of that line's professional fee, state
   `pending`; finance approves (credit note against the balance invoice or a refund, O3 machinery) or waives
   with a reason. When the delay is the partner's, the completion payout is reduced by the same amount
   (never below zero), audited. No money moves without finance's action.
7. **Ratings.** Client owner rates a completed engagement once (1–5, comment); partner sees stars and the
   comment with contacts masked; feeds the scorecard. Ops and founder see all.
8. **Fairness by category.** Month share measured within the service category of the lines being allocated
   (`deliverables.category`), not across the whole platform.
9. **Manual allocation.** Ops offers specific lines to a chosen partner with a reason: eligibility and
   priced-cost checks still apply, reason `manual_override`, audited with who and why.
10. **Offer document.** Branded PDF for a published offer (`GET /api/client/offers/:id/pdf`): scope with
    quantities, prices, government fees at cost, VAT, exclusions and assumptions, timeline, validity, how to
    accept; "Tasees, by MKW Advisors". Never partner names or costs.

## Exclusions

E-signature (upload only); partner dashboard trends beyond the scorecard history (O8); automatic refunds
(finance acts); public holidays calendar (owner supplies); WhatsApp.

## Acceptance evidence

- Tests: onboarding pipeline with gates; partners never see other partners' documents or scorecards;
  clients never see partner documents, scorecards, delays attribution or payout reductions; licence expiry
  pauses and reactivation works; scorecard arithmetic from fixed inputs; staff invite/removal scoped to the
  firm; document request lifecycle and visibility; delay creates one record, notifies, guarantee credit at
  exactly the window with the right amount, partner-attributed delay reduces the completion payout, finance
  approve/waive; rating once, masked for partner; fairness per category; manual allocation refused for
  ineligible or over-cost partners; offer PDF contains no partner name or cost.
- Smoke: partner onboarding screens (application, documents, ops review), client document upload, ops
  delay/guarantee queue, client rating, offer PDF download; 1280 px and 390 px.

## Dependencies and owner decisions

- Service guarantee figure (default 10%, `guarantee_bp` in settings, founder-editable); public holidays.

## Risks

- A guarantee credit computed on the wrong base would under- or over-credit: the base is the late step's
  share of the line's professional fee (government fees excluded), the arithmetic is a pure function with
  tests, and finance sees the base before approving.
- Auto-pausing on expiry could stop live work: in-flight milestones continue; only new allocations stop.

## Rollback

Additive migration; jobs are no-ops without rows; the guarantee needs finance's action to move money.

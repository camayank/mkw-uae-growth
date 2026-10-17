# O6 Partners and delivery

Status: verified-pending-merge (branch `outcome/O6-partners-and-delivery`, stacked on O5, 17 Oct 2026)

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

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 45 core + 140 API = 185 (O5: 168); `packages/core/test/scorecard.test.ts`, `apps/api/test/partners.test.ts` (5), `apps/api/test/delivery.test.ts` (7) |
| Onboarding | prospect → applied on the firm's application (expired licence refused); pilot 409 without a verified unexpired licence; signed 409 without verified agreement and insurance; moves audited and emailed from "MKW Advisors" without the word Tasees; another firm and clients get 403/404 on onboarding, documents and files; `app_partner` denied `partner_documents` at the database |
| Licence watch | one warning at 28 days to the admin and ops, none on the next run; pause on expiry with `pausedFrom`, email; verified renewal lifts the pause and supersedes the old licence |
| Staff | admin invites (email from MKW Advisors), cannot take an existing email, staff cannot invite, cannot touch another firm's people (404) or itself |
| Scorecard | recompute writes a row per partner; a partner reads only its own (403 for others and clients); partner home shows status and latest score without bank or conflicts; after a rated delivery `inputs.rating` = 4 and the card is no longer provisional; arithmetic in core tests |
| Documents | checklist created on acceptance with the client told (Tasees brand); partner adds one on its own step only (404 on another's) with contacts masked in the note; client-only upload with file-type rules; partner told when complete; received / ask-again with reason and the client told; files openable by the client, its partner and MKW, 404 for another partner; partner view carries no file key; `file_key` denied at the database |
| Delays | noticed once; client told (Tasees) with the new date, partner told (MKW Advisors); client and partner see the delay without `cause`; finance cannot attribute; ops attribution visible to ops only |
| Guarantee | nothing at four working days; credit at five with amount = floor(step share of the line's professional fee × 10%); client sees amount and status only; partner sees no credit; ops cannot decide; finance approve applies to the unpaid balance and reduces the partner-borne completion payout by the same amount; second decision 409; audit order credit_due → payment.reduced → payout.reduced → approved |
| Ratings | 409 before completion; member 403; stars 1–5; once; partner sees stars and the masked comment and no author; ops sees the original; rating email to the partner from MKW Advisors |
| Fairness | setup and tax categories measured separately: a setup allocation leaves the accounting share empty |
| Manual allocation | finance 403; ineligible partner 409 naming the failure; short reason 400; success records `manual_override` with the reason and the engine's own choice; lines already offered 409; the partner can accept |
| Offer PDF | 404 while unpublished; PDF with brand, validity, VAT, government fees at cost, assumptions, every code; no partner name; partner 403; ops 200 |
| Smoke | `docs/evidence/O6/log.txt` (68 checks OK); screenshots `43-ops-partner-onboarding.png`, `44-partner-firm.png`, `45-client-documents.png`, `46-ops-delays.png` (1280 px), `47-mobile-delays.png`, `48-mobile-firm.png` (390 px) |

## Could not verify

A delay and a credit in the browser (the smoke test cannot move the application clock; the API tests do).
The guarantee percentage and holiday list against the owner. E-signature (upload only).

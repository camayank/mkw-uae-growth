# E5 Assessment to Tasees handoff, and renewals as a product

Status: verified-pending-merge (branch `outcome/E5-handoff`, built on E4 and rebased onto `main` after camayank/mkw-uae-growth#20
merged; released by the owner on 2 Nov 2026 with the Right UAE Entity programme, `docs/ENTITY-PROGRAMME.md`)

## Business result

What a founder answered on the public selector becomes a priced request for the same customer without re-typing,
re-checked against the rules and data of the day it is created, with the review showing what changed since the
assessment. An existing client's enquiry becomes a request on a person's decision, not a duplicate account. A client
whose licence is due for renewal asks for a renewal offer in one step, and it is quoted, bought and delivered through
Tasees like any other work.

## Scope

1. **From a saved assessment to a request** (migration 018: `requests.assessment_id`, assessments gain the status
   `request`). A signed-in client enters the recovery code on the New request page; the answers pre-fill the intake
   and the request is created from them with the link recorded. The advice is computed on today's rules (E2's data
   version), so the request is always re-checked; nothing from the public result is copied into it.
2. **A held enquiry becomes a request on a person's action.** When a review request came from an email that already
   has an account, the enquiry is held (O5). Ops can now turn it into a request for that client with one action from
   the AI queue, where held enquiries are listed (`POST /api/ops/leads/:id/convert`): the request is created from the held answers for the
   existing organisation, the held enquiry is marked handled with the request, and the lead (E4) is linked to the
   request. Audited. Nothing is sent.
3. **What changed since the assessment.** The scoping review shows, for a request that came from a saved assessment:
   when it was saved, what the public saw then (the structure if it was confirmed, how much was approved) and what the
   engine says now. The client's advice says the request came from their saved result.
4. **Renewals as a product** (`requests.obligation_id`). From an open licence-renewal obligation, the client or ops
   asks for a renewal offer: a services request with the renewal line (`SET-RENEW`) is created for the client and
   linked to the obligation. It goes through the ordinary quote, offer, acceptance and delivery. The obligation shows
   the request's state, then the engagement's; completing an engagement that carries the renewal line marks the
   obligation met and the next one is generated as today. One renewal in progress per obligation, where "in
   progress" is decided from the pipeline (being quoted, a live offer, or an engagement not finished), never from
   the request's status, which closes at acceptance.
5. **Leads follow.** A request created by handoff or conversion sets the lead's `request_id`; conversion to a client
   still means an accepted offer (D81).

## Exclusions

- Automatic conversion of anything: every handoff is a person's action (the client's or ops').
- Copying the public result into the request: the request's advice is always recomputed.
- Renewal pricing from the catalogue's renewal estimate: the price comes from partners' rate cards and the margin rule,
  as for every line.
- Visa renewals and other recurring products beyond the licence renewal (a later outcome).

## Acceptance evidence

- API: a client creates a request from a saved code without re-typing; the request records the assessment, the
  assessment is marked, the advice carries today's data version, and an unknown or anonymised code is refused; a
  code is used once, by whoever holds it (it carries no personal data), and a client member may use one; ops
  converts a held enquiry into a request for the existing organisation, the enquiry is handled and the lead linked;
  a partner cannot; the scoping review shows the saved summary against today's advice; a renewal
  request is created from an open obligation with the renewal line, linked both ways, once; completing its engagement
  marks the obligation met; nothing is written to the outbox by any of these beyond the existing request-created
  notifications.
- Smoke: a signed-in client starts a request from a saved code; ops converts a held enquiry; a renewal request from
  the compliance page; at 1280 and 390 px; axe clean.

## Dependencies and risks

- Depends on E4 (assessments, leads).
- Risk: a client may enter someone else's code. The code opens answers only (no personal data), and the request is
  created for the signed-in client, so nothing leaks; the audit records which assessment was used.

## Owner decisions

- None to merge. Which renewal add-ons (office, establishment card) belong in the renewal product is a product
  decision for later.

## Rollback

- Revert the pull request. Migration 018 only adds columns and a status value.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 105 core + 306 API (one PostgreSQL-only test skipped on PGlite) = 411 passing. The API suite passes 307 of 307 on PostgreSQL 16. `pnpm typecheck` is clean |
| From a saved result | `apps/api/test/handoff.test.ts`: a client creates a request from a code; the answers carry over, the advice has today's data version, the link is recorded, the assessment is marked; a partner cannot; unknown and short codes are refused; a code works once; the review shows the saved summary and source; the client sees the link |
| From a held enquiry | Ops converts a held enquiry into a request for the existing client; the enquiry is handled with the request recorded; the lead is linked; a second conversion is refused; the queue item is gone; nothing reaches the outbox |
| Renewals | A renewal request is created from an open licence-renewal obligation with the renewal line, for the right client; a VAT obligation is refused; the client's calendar shows the request; while an offer is live or an engagement is unfinished a second request is refused, and after an offer expires one can be asked for again; the delivery of an engagement carrying the renewal line meets the obligation and rolls it forward a year, and one re-scoped to something else does not |
| Smoke | `docs/evidence/E5/smoke-log.txt`: 213 checks OK on a fresh demo (E4: 206). Ops turns a held enquiry into a request; a client starts a request from a saved code and the review shows then against now; the client asks for a renewal offer and the calendar shows it; the saved-result box at 390 px |
| Screens | `89-held-enquiry-converted.png`, `90-review-from-saved-result.png`, `91-client-renewal-requested.png` (1280 px), `92-mobile-saved-result.png` (390 px). axe: 40 screens, 0 violations (`axe.json`) |

## Independent review

A separate reviewer read the whole diff before the pull request. It found 1 must-fix problem (reproduced) and 7
should-fix items; all are fixed with tests (D82 amended):
- **Must-fix.** "One open renewal per obligation" was keyed on the request's status, which closes at acceptance and
  never moves after an offer expires: a second renewal could be asked for mid-delivery, and none after an expiry.
  Liveness is now decided from the pipeline.
- **Should-fix.** A stranger's lead that quoted the same code was linked to the signing-in client; the client's
  request page did not say where the request came from, and the renewal landed on a dead-end page; the contract's
  wording on who may use a code was wrong and the anonymised case untested; the queue status disagreed; a renewal
  obligation was met even when ops had re-scoped the engagement to something else; a held enquiry's description got
  no AI draft; two uses of one code could race (now a unique index and a row lock).

## Could not verify

- **Whether a renewal needs more than the renewal line** for a given licence (establishment card, office): ops adds
  lines at scoping until the owner decides the renewal product's contents.


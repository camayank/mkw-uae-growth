# E4 Lead intelligence

Status: merged (camayank/mkw-uae-growth#20; branch `outcome/E4-lead-intelligence`, built on E3 and rebased onto `main` after
camayank/mkw-uae-growth#19 merged; released by the owner on 2 Nov 2026 with the Right UAE Entity programme,
`docs/ENTITY-PROGRAMME.md`)

## Business result

Every founder who uses the public selector can come back to their result, every lead is one identity with its own
consents, source and scores, a person at MKW knows which leads to call first and who owns each, and the founder can
see which sources turn into reviewed requests, accepted offers and revenue. Nothing is sent to a lead without a
person's action.

## Scope

1. **Assessment sessions** (migration 017, `assessments`). Saving a result is the founder's own action on the
   selector page: it stores the answers, the public result's summary, the engine and data versions and the
   attribution, and returns a recovery code. No contact details. Recovery (`GET /api/public/assessments/:code`)
   re-runs the public assessment on today's rules and says so. Sessions keep nothing after the retention period.
2. **Attribution.** `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, the referrer and the
   landing page are captured on the selector and the intake page and travel with the session, the lead and the
   request's `source`.
3. **Leads as their own identity** (`leads`). Every review request creates a lead: contact details, company, the
   session it came from, source, the client organisation and request it became (when the email is new), or the
   held intake (when the email already has an account). A lead is never a user, and a user is never a lead.
4. **Consents** (`consents`). Three purposes, each its own record with the text version, time, channel and IP:
   - `service` (required to review the case; the existing intake consent);
   - `marketing` (unticked by default; the text is the owner's, a default is used and labelled);
   - `partner_disclosure` (unticked by default: naming the client to a partner firm before an offer is accepted).
   The export and erasure paths include them. A withdrawal is a new record, never an edit.
5. **Scores and segments** (`packages/core/src/leads.ts`, pure). From the answers and the session: a complexity
   score (regulated activity, cross-border, holding, premises, visas, contradictions, missing facts), an intent
   score (budget given, visas, a named place, a saved session, a review request, a phone number, a consultation
   request) and a segment (`starter`, `standard`, `complex`, `regulated`, `cross_border`). High intent is a flag.
   Deterministic, with no commercial input.
6. **Routing.** The founder maps each segment to an owner on the Settings page (`lead_routing`); unmapped segments
   go to ops. Routing assigns the lead and puts it in the ops queue for that owner. It creates no message.
7. **Consultation requests.** The selector's review form takes an optional "I would like a call" with preferred
   times. It is recorded on the lead and shown in the queue; a person books it.
8. **The pipeline.** `#/leads` for ops and the founder: list by status, segment, owner, score and source; assign,
   change status, add a note, set a follow-up date (an internal task that appears in the queue when due). Every
   change is audited. Partners and clients never reach it.
9. **Analytics.** `GET /api/ops/pipeline/leads/analytics`: per source and campaign, sessions, leads, requests with
   a published offer, requests with an accepted offer and client revenue (client totals in fils, no margin). Ops and
   the founder see it on the leads page.
10. **Retention.** The `leads` period among the retention periods on Settings (default 365 days, UNCERTAIN until
    the owner confirms the periods): a job anonymises leads and saved assessments older than that which never became
    a client (no accepted offer on the request, no engagement), keeping the counts. Until the periods are confirmed
    the job counts and changes nothing. One audit event per run.

## Exclusions

- Sending anything to a lead (email, WhatsApp, SMS): rule 6. Follow-ups are internal tasks.
- Calendar or booking integrations (an external service, rules 7 and 11).
- Sharing a lead with a partner: never (VISION: not a lead marketplace). `partner_disclosure` governs naming the
  client on a request the partner already works on.
- The handoff of an assessment into a priced request without re-typing (E5).

## Acceptance evidence

- Core: scores and segments are deterministic, bounded 0–100, monotone in the facts that raise them, and take no
  commercial input.
- API: a saved session returns a code and stores no contact details; recovery re-runs the assessment; the review
  request creates one lead with its consents, session and source; marketing and partner disclosure default to not
  given; withdrawal appends; export includes a person's lead and consents; erasure tombstones them; routing assigns by
  segment and falls back to ops; the queue shows new leads, consultation requests and due follow-ups; nothing is
  written to the outbox by any lead action; analytics counts a source through to accepted revenue; the retention job
  anonymises old sessions and leads and is idempotent; partners and clients get 403.
- Smoke: save and recover a session, a review request with a consultation, the leads page with assignment and a
  follow-up at 1280 and 390 px; axe clean.

## Dependencies and risks

- Depends on E3 (the selector and the public assessment).
- Risk: scoring is a heuristic. It orders a person's attention; it never decides anything for a lead.

## Owner decisions

- The routing owners per segment (Settings).
- The marketing consent text (a default is used and labelled).
- The retention period for leads and sessions (default 365 days, UNCERTAIN until confirmed).

## Rollback

- Revert the pull request. Migration 017 only adds tables and a setting. The selector keeps working without saving.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 105 core + 303 API (one PostgreSQL-only test skipped on PGlite) = 408 passing. The API suite passes 304 of 304 on PostgreSQL 16. `pnpm typecheck` is clean |
| Scores | `packages/core/test/leads.test.ts`: deterministic, bounded 0–100, monotone in the facts that raise them, segments as specified, no commercial input; attribution kept to its known fields |
| Sessions | `apps/api/test/leads.test.ts`: a saved assessment stores the answers, summary and attribution only (no contact details, the code hashed); recovery re-runs the assessment and counts; unknown codes say "not found" |
| Leads and consents | One lead per review request with service, marketing and partner-disclosure consents (the last two not given unless ticked), the session, the source on the lead and the request, scores and a call request; the only email is the intake acknowledgement; partners, clients and finance get 403 |
| Routing and pipeline | Founder-only routing to active ops or founder users; routed leads carry the owner; assign, status, note, follow-up (in the queue only when due), consent withdrawal; every step audited; no email sent; consents cannot be edited or deleted |
| Analytics | A source is followed from a saved assessment to a lead, a request, a published and an accepted offer and its client revenue; no margin field; finance cannot read it |
| PDPL | The export includes a person's leads and consents; erasure tombstones the leads and keeps the consent history |
| Retention | Until the founder confirms the periods the job changes nothing (and reports 0); once confirmed, old leads and sessions that never became a client are anonymised, counts kept, and a second run does nothing |
| Smoke | `docs/evidence/E4/smoke-log.txt`: 206 checks OK on a fresh demo (E3: 198). Save and recover a result by code, unticked optional consents, a call request, the lead in the pipeline with scores and consents, a status change in its history, the leads page at 390 px |
| Screens | `86-leads-pipeline.png`, `87-lead-detail.png` (1280 px), `88-mobile-leads.png` (390 px), `84-public-selector-approved.png` (the selector with save and the consent boxes). axe: 39 screens, 0 violations (`axe.json`) |

## Independent review

A separate reviewer read the whole diff before the pull request. It found 3 must-fix problems (all reproduced), 10
should-fix items and nits; all must-fix and should-fix items are fixed with tests (D81 amended):
- **Must-fix.** Retention treated "has a client organisation" as "became a client", so a submitted form was kept for
  ever; erasure left the IP on consent records and the saved answers behind a lead; the recovery code leaked into
  the landing page, the request's source and the audit trail.
- **Should-fix.** A held enquiry made two queue items; the detail page loaded 500 rows; the engine's contradictions
  and missing facts never reached the score; malformed ids gave 500; "converted" could be set on any new lead and
  left again; free-text notes went into the audit trail; the export left out notes and the saved assessment;
  analytics counted offer tiers rather than requests; the queue status and two names in this file were wrong; an
  outbox assertion was vacuous.
- **Nits** fixed: the always-on intent factor is gone; a corporate owner is complexity, not cross-border; the code
  generator has no modulo bias; dates on the leads page are Gulf dates; the selects are labelled; the last code is
  no longer prefilled on a shared device.

## Could not verify

- **Whether the scores order leads the way a salesperson would.** They are reasoned heuristics; the pilot's real
  conversions should tune them.
- **The consent wording and the retention period** are defaults for the owner and a lawyer to settle.


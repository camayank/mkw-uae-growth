# O5 Scoping intelligence

Status: in-progress (branch `outcome/O5-scoping-intelligence`, stacked on O3)

## Business result

A founder's answers become a correct, explained scope: which structure (free zone, mainland, offshore,
DIFC/ADGM) and why, two or three candidate places with cost range, visa quota and timeline, the licences and
approvals that may apply, and the obligations that follow (corporate tax, VAT thresholds, UBO, goAML). Every
statement carries a confidence (verified rule, rule of thumb, UNCERTAIN) with its source and sign-off date;
anything UNCERTAIN goes to ops before the client sees it. Leads from the public Tasees page land in the
platform with recorded consent. An AI model may draft a scope from free text, into a review queue, and never
reaches a client unapproved.

## Scope

1. **Rules with confidence.** `scoping_rules` table: key, kind (structure, zone, licence, obligation),
   statement, parameters, source, confidence (`UNCERTAIN` until a named person verifies), verifier and date.
   Seeded with the working rules from the specification (VAT thresholds AED 375,000 / 187,500, corporate tax
   registration, UBO register, goAML for DNFBPs, offshore cannot sponsor visas, mainland for onshore trading
   and government tenders, DIFC/ADGM for funds and holdings, special approvals for health, education,
   financial activities), all UNCERTAIN. Founder verifies on the Scoping page.
2. **Zones.** `zones` table: name, emirate, type, visa quota per package, setup cost range, timeline, activity
   fit, source, confidence; seeded with well-known zones marked UNCERTAIN. Government fees from O4's table
   are used for the cost range where a verified row exists.
3. **Advice engine** (`packages/core/src/advice.ts`, pure): structure recommendation with reasons; candidate
   places; licence and approval flags; follow-on obligations; each item carrying the confidence of the rule
   it came from. Stored on the request as `advice`; shown to the client only after ops approves it
   (`advice_status`: pending_review → approved). Intake gains activity, customers, office need and budget.
4. **Public intake.** `POST /api/public/intake` and a public page `intake.html`: creates the client, owner
   and request; PDPL consent required and recorded with timestamp and text version; honeypot field; per-IP
   rate limit; source and campaign recorded. The new owner receives a sign-in invitation.
5. **AI draft queue.** `AiModel` adapter (`lib/ai.ts`) with a deterministic in-memory double; the real
   Claude API adapter is wired when the key and spend cap exist (`AI=anthropic`). Drafts land in `ai_drafts`
   (scope, quote chaser, risk flag) and ops approves or discards each; approving a scope draft applies it to
   the request. The agent review queue screen and the ops search (clients, engagements, offers, partners).

## Exclusions

Compliance calendar (O8); Arabic; automatic statutory conclusions of any kind (the engine advises, a person
approves, nothing is filed); AI for anything client-facing without approval; WhatsApp capture.

## Acceptance evidence

- Tests: 20 sample founder cases scored against expected answers written down in the test (structure and
  obligations), with UNCERTAIN flags where rules are unverified; verifying a rule changes the confidence of
  the advice; client cannot see advice before ops approves; public intake refuses without consent, with the
  honeypot filled or over the rate limit, and records consent; AI double drafts land in the queue and only an
  approval changes the request; search finds by name and reference and respects roles.
- Smoke: public intake page submits a lead; ops reviews the scoping and approves; client sees the advice;
  agent queue and Scoping page screenshots at 1280 px and 390 px.

## Dependencies and owner decisions

- A qualified person to verify the rules and zone data; the AI API key and monthly cap (USD 100 suggested).

## Risks

- A rule marked verified by mistake would reach clients as fact: verification is founder-only, named, dated
  and audited, and the client screen always shows the confidence label and the date.

## Rollback

Additive migration; without approval nothing new reaches a client; `AI=memory` keeps the queue working
without a model.

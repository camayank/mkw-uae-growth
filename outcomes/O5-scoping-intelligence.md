# O5 Scoping intelligence

Status: merged (pull request camayank/mkw-uae-growth#5 into `main`, 18 Oct 2026; was: branch `outcome/O5-scoping-intelligence`, stacked on O3, 17 Oct 2026)

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

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 40 core + 128 API = 168 (O3: 138); `apps/api/test/scoping.test.ts` (30 tests) |
| 20 founder cases | each case's expected structure, obligations, licences and first place written in the test; all pass; every statement UNCERTAIN while rules are unverified; verifying a rule flips only that statement |
| Review gate | advice pending → client sees none (the API and the `app_client` role, which cannot read the column), ops queue shows it; approve with removals → client sees it with labels; a changed structure re-ranks the places for it; audit records removals and whether UNCERTAIN items were shown; recompute returns it to review |
| Verification | ops 403; founder needs a name and an http(s) source; zone verification with cost edit; clients and partners denied at the database |
| AI queue | draft created from the description, lines and quantities recognised; finance 403; approve applies ticked lines and notes it; approve after pricing or once an RFQ is out 409; nothing about the draft or reviewer in request notes; discard works; audit trail of create/approve/discard |
| Public intake | no consent 400; honeypot 200 with nothing created; body is `{ok:true}` for every email; new company, owner, consent (version, time, channel), request with source and campaign, AI draft queued; sign-in code obtainable; repeat email held in `intake_leads` with nothing written as the account holder and consent untouched, neutral email only, ops closes it, clients/partners 403; staff/partner email the same; 429 under load; `X-Forwarded-For` honoured only with `TRUST_PROXY` |
| Smoke | `docs/evidence/O5/log.txt` (56 checks OK); screenshots `35-ops-scoping-review.png`, `36-client-advice.png`, `37-ai-queue.png`, `38-scoping-rules.png`, `39-public-intake.png` (1280 px), `40-mobile-scoping.png`, `41-mobile-ai-queue.png` (390 px), `42-held-leads.png` |

## Could not verify

The rules and zone figures against a qualified person; the AI adapter against the real model (no key); the
pack's own lead page is a separate artifact and still posts to the Sheet until it is pointed at
`/api/public/intake`.

## Review

Sceptical review found 2 blockers (public intake attached a repeat email's submission to the existing
account and wrote audit and consent as that person; the response body classified emails as client / staff /
unknown), 6 should-fix (structure change at approval kept the old places; no `trustProxy`; AI drafts could
change a scope under an open RFQ; public intake made no draft; the client DB role could read pending advice;
the draft note leaked the reviewer's name into partner-visible notes) and 4 nits (non-http sources on
unverified rules, a keyless statement, consent and answers missing from the PDPL export, unescaped LIKE
wildcards). All fixed with tests; the review's "confirmed OK" list stands.

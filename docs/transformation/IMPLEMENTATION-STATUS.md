# Implementation status

What each capability the mandate names actually is today, with the evidence. Updated in the same pull request as the
outcome that changes a row. First written by E18 on 4 Nov 2026 from `main` at d8104fb.

## The scale

| Status | Means | Needs as evidence |
| --- | --- | --- |
| NOT STARTED | No code for it | — |
| IN PROGRESS | Code on a branch, not merged | the open pull request |
| CODE COMPLETE | Merged code, but not shown working end to end, or exercised only against a test double | the merged pull request |
| TESTED | Merged and passing automated tests that exercise the behaviour, including the browser smoke for screens | the test names and the CI run |
| BLOCKED | Cannot go further without an owner input, an account, a credential or a sign-off | the named input |
| READY FOR PILOT | TESTED, running in staging against real services, and every sign-off its pilot use needs is recorded | the staging check and the sign-off |
| PRODUCTION VERIFIED | Working in production with real users, money or filings, with evidence | the production record |

A row may carry two words where the code and the live service differ, for example "CODE COMPLETE; NOT LIVE". No row
is above TESTED today, because nothing is deployed. No completion percentage is given: no agreed method exists, and
counting rows would weigh a test double the same as a live payment.

## Platform foundation (Phase 0)

| Capability | Status | Evidence |
| --- | --- | --- |
| Marketplace loop: intake, scope, quotes, offer, accept, deposit, allocate, deliver, QA, approve, balance, payout | TESTED | `flow.test.ts`, `scenarios.test.ts` (26), `pilot-journeys.test.ts` A–F |
| One margin rule, floor, cap, ops review | TESTED | core `pricing.test.ts`, `catalogue.test.ts` |
| Money as integer fils, rates as basis points | TESTED | core `money.ts`, `pricing.test.ts` |
| Append-only, hash-chained audit with nightly check | TESTED for detection; no database guard against edits (risk R1) | `pdpl.test.ts`, `hardening.test.ts` |
| Event outbox, exactly-once side effects | TESTED | `outbox.test.ts` |
| State machines for milestone, offer, engagement | TESTED | `transitions.test.ts` |
| State rules for request, payout, change order | CODE COMPLETE (direct SQL, no transition table) | `BASELINE-AUDIT.md` section 8 |
| Ops command centre, queue, digest, alerts, jobs | TESTED | `queue.test.ts`, `hardening.test.ts` |
| PDPL: consent, masking, export, erasure, retention | TESTED; texts await the lawyer (BLOCKED) | `pdpl.test.ts`, `leads.test.ts` |
| Arabic client screens, emails and report | TESTED; wording BLOCKED on the Arabic reviewer | `locale.test.ts`, `report-ar.test.ts`, smoke |

## Security (Phase 1)

| Capability | Status | Evidence |
| --- | --- | --- |
| Sign-in attempt limit, concurrent guesses, single message | TESTED on PGlite and PostgreSQL 16 | E17, `sign-in.test.ts` |
| Sessions: random token, hashed, expiry, sign-out, deactivation | TESTED | `security.test.ts` |
| Per-address throttle across instances | CODE COMPLETE for one process; multi-instance BLOCKED on infrastructure (gap 13) | `server.ts:105-113` |
| Money privacy across parties, three layers | TESTED | `security.test.ts`, `flow.test.ts`, smoke |
| Role limits within a party (ops vs finance, staff vs admin, member vs owner) | TESTED at the route and visibility layers for most paths; not at the database; gaps listed in the audit section 4.2 | E19 |
| Downloads by another tenant | TESTED for 5 of 9 download routes | audit section 4.2 |
| Upload size and extension | TESTED | `storage.test.ts` |
| Upload content check, quarantine, malware scan | NOT STARTED | gap 45, E20 |
| Browser headers and CSP | TESTED | `security.test.ts` |
| Webhook signature | TESTED | `payments.test.ts` |
| Dependency audit | TESTED (clean on 3 Nov 2026) | `docs/evidence/E7E/` |

## Jurisdiction intelligence (Phase 2)

| Capability | Status | Evidence |
| --- | --- | --- |
| Facts with source, authority, dates, verifier, confidence, version, approval | CODE COMPLETE; data BLOCKED on a named verifier | migration 015, `jurisdiction.test.ts` |
| Classification verified / rule of thumb / UNCERTAIN / stale / data unavailable | TESTED | `catalogue.ts:70-99`, `eligibility.ts:16` |
| Public display only of approved statements | TESTED | `public-selector.test.ts`, D80, D95 |
| Bulk evidence import, history, staleness, coverage matrix, backlog | TESTED | `coverage.test.ts`, `import.test.ts` |
| Conflict detection, version comparison view, stale-fact alerts | NOT STARTED | E21 |
| Entity scenarios: one activity, one entity; mainland vs free zone; international customers; regulated; foreign shareholders; renewal; visas and premises | TESTED as engine cases | core `eligibility.test.ts`, `engine-cases.test.ts` |
| Multiple activities, holding with subsidiary, India–UAE ownership | NOT STARTED (gaps 48, 75, 76) | — |
| Setup, renewal and government charges from approved figures | TESTED | `public.ts`, `report.test.ts` |
| Three-year cost, visa cost | NOT STARTED | — |

## AI (Phase 3)

| Capability | Status | Evidence |
| --- | --- | --- |
| Deterministic scoping drafts into a review queue | TESTED | `services/drafts.ts`, `queue.test.ts` |
| Live LLM provider | NOT STARTED; BLOCKED on provider, key and cap | `lib/ai.ts:212-216` |
| Agent tools, planning, run store, approvals | NOT STARTED | E23, E24 |
| Document content analysis | NOT STARTED (file names only today) | `lib/ai.ts:168` |
| Evaluation suite | NOT STARTED | E27 |

## Customer experience and conversion (Phase 4)

| Capability | Status | Evidence |
| --- | --- | --- |
| Public flow: homepage, quick match, assessment, saved result, review request | TESTED | `lead-to-tasees.test.ts`, smoke |
| Assessment report PDF in English and Arabic | TESTED | `report.test.ts`, `report-pdf.test.ts`, smoke |
| Client workspace with one next action | TESTED | `journey.test.ts`, smoke |
| Documents needed now, later, sent | TESTED | `documents.test.ts` |
| Document reuse with consent, expiry vault, partner-disclosure approval | NOT STARTED (gaps 34, 71, 125) | E26 |
| Priority tier speed in the offer and the plan | NOT STARTED (gap 85) | E26 |
| Funnel from visit to revenue, lead scores, routing | TESTED | `funnel.test.ts`, `leads.test.ts` |
| Calendar booking | NOT STARTED; BLOCKED on a provider (gap 69) | — |

## Commercial infrastructure (Phase 5)

| Capability | Status | Blocker |
| --- | --- | --- |
| Staging in me-central-1 | CODE COMPLETE (CDK synthesises in CI); NOT LIVE | cloud account, domain (gaps 6a, 122) |
| PostgreSQL backups and restore drill | CODE COMPLETE; drill not run on a real backup | staging |
| S3 storage | CODE COMPLETE; NOT LIVE | bucket |
| SES email | CODE COMPLETE; NOT LIVE | sender verification (gap 1) |
| Payment gateway | NOT STARTED (memory provider only) | provider choice (gap 2) |
| Bank payout format | CODE COMPLETE for a generic CSV | bank sample (gap 3a) |
| Tax invoices | CODE COMPLETE; held | TRN and tax adviser (gap 3) |
| External alerting | CODE COMPLETE; no address | alert address (gap 37) |
| WhatsApp | NOT STARTED | O14 |
| External security review | NOT STARTED | reviewer |

## Demonstration (Phase 6)

| Capability | Status |
| --- | --- |
| Demo mode on synthetic data, traces, `docs/competition/*` | NOT STARTED (E27) |

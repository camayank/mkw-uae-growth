# Implementation status

What each capability the mandate names actually is today, with the evidence. Each row is updated in the same pull
request as the outcome that changes it. This version was written by E20 on 4 Nov 2026, from `main` at a42c487 (E19
merged), and updated by E21. E21's rows read IN PROGRESS until its pull request is merged; they then read TESTED.

## The scale

| Status | Means | Needs as evidence |
| --- | --- | --- |
| NOT STARTED | There is no code for it | — |
| IN PROGRESS | There is code on a branch, not merged | the open pull request |
| CODE COMPLETE | The code is merged, but has not been shown working end to end, or only against a test double | the merged pull request |
| TESTED | The code is merged and passes automated tests that exercise the behaviour, including the browser smoke for screens | the test names and the CI run |
| BLOCKED | It cannot go further without an owner input, an account, a credential or a sign-off | the named input |
| READY FOR PILOT | TESTED, running in staging against real services, and every sign-off its pilot use needs is recorded | the staging check and the sign-off |
| PRODUCTION VERIFIED | Working in production with real users, money or filings, with evidence | the production record |

A row may carry two words where the code and the live service differ, for example "CODE COMPLETE; NOT LIVE". A row
may also split one capability into the part that is TESTED and the part that is NOT STARTED.

No row is above TESTED today, because nothing is deployed.

No completion percentage is given. There is no agreed method, and counting rows would weigh a test double the same
as a live payment.

## Platform foundation (Phase 0)

| Capability | Status | Evidence |
| --- | --- | --- |
| Marketplace loop: intake, scope, quotes, offer, accept, deposit, allocate, deliver, QA, approve, balance, payout | TESTED | `flow.test.ts`, `scenarios.test.ts` (26), `pilot-journeys.test.ts` A–F |
| One margin rule, floor, cap, ops review | TESTED | core `pricing.test.ts`, `catalogue.test.ts` |
| Money as integer fils, rates as basis points | TESTED | core `money.ts`, `pricing.test.ts` |
| Audit events cannot be changed or deleted at the database (revoked, and a trigger); hash-chained; checked nightly | TESTED | `runtime-login.test.ts`, `pdpl.test.ts`, `hardening.test.ts` |
| Audit events written only through `audit_append`; an append-only nightly check, recorded by the database, that compares the chain with the night before | IN PROGRESS (E21). A well-formed event naming any actor can still be appended through `audit_append` (gap 151); the owner rewriting the trail and its checks together is not caught (gap 143) | `audit-guard.test.ts`, `runtime-login.test.ts`, migration 027 |
| Event outbox, exactly-once side effects | TESTED | `outbox.test.ts` |
| State machines for milestone, offer, engagement | TESTED | `transitions.test.ts` |
| Transition tables for request, payout, change order; a check constraint on every machine's status column | IN PROGRESS (E21). Statuses outside the six machines still change by direct SQL (gap 149); the database does not check moves itself (gap 150) | `transitions.test.ts`, migration 027 |
| Ops command centre, queue, digest, alerts, jobs | TESTED | `queue.test.ts`, `hardening.test.ts` |
| PDPL: consent, masking, export, erasure, retention | TESTED; the texts are BLOCKED on the lawyer | `pdpl.test.ts`, `leads.test.ts` |
| Arabic client screens, emails and report | TESTED; the wording is BLOCKED on the Arabic reviewer | `locale.test.ts`, `report-ar.test.ts`, smoke |

## Security (Phase 1)

| Capability | Status | Evidence |
| --- | --- | --- |
| Sign-in attempt limit, concurrent guesses, one message for every failure | TESTED on PGlite and PostgreSQL 16 | E17, `sign-in.test.ts` |
| Sign-out ends that session only; an expired session is refused; deactivation ends sessions | TESTED | `role-isolation.test.ts`, `admin.test.ts` |
| Per-address throttle across instances | CODE COMPLETE for one process; multi-instance is BLOCKED on infrastructure (gap 13, shared rate limiting) | `server.ts:105-113` |
| Money privacy across parties, three layers | TESTED | `security.test.ts`, `flow.test.ts`, `role-isolation.test.ts`, smoke |
| A partner firm sees only its own change orders | TESTED at the database and the API | E19, migration 024, `role-isolation.test.ts` |
| Within a party: ops without margin, partner staff without any money figure, client member without partner cost | TESTED at the API; not in database grants (gap 142) | `role-isolation.test.ts`, `flow.test.ts`, `reporting.test.ts`, smoke |
| Downloads refused to another party | TESTED for 6 of 12 routes; the other six IN PROGRESS (E21) | `BASELINE-AUDIT.md` 4.2; `downloads.test.ts` |
| Runtime database login that owns nothing; migration step as the owner; no trigger, temporary-object or migration-list rights for application roles | TESTED on PostgreSQL 16; NOT LIVE | E19, `runtime-login.test.ts`, `docs/evidence/E19/synth.txt` |
| Upload size and extension | TESTED | `storage.test.ts` |
| Upload content check, quarantine, malware scan | NOT STARTED (E22) | gap 45 |
| Browser headers and CSP | TESTED | `security.test.ts` |
| Webhook signature | TESTED | `payments.test.ts` |
| Production dependency audit | TESTED by hand: no known vulnerabilities on 4 Nov 2026 (not run in CI) | `docs/evidence/E20/audit.txt` |

## Jurisdiction intelligence (Phase 2)

| Capability | Status | Evidence |
| --- | --- | --- |
| Facts with source, authority, dates, verifier, confidence, version, approval | CODE COMPLETE; the data is BLOCKED on a named verifier | migration 015, `jurisdiction.test.ts` |
| Classification: verified, rule of thumb, UNCERTAIN, stale, data unavailable | TESTED | core `catalogue.test.ts`, `eligibility.test.ts`, `jurisdiction.test.ts` |
| Public display only of approved statements | TESTED | `public-selector.test.ts`, D80, D95 |
| Bulk evidence import, history, staleness, coverage matrix, backlog | TESTED | `coverage.test.ts`, `import.test.ts` |
| Conflict detection, version comparison view, stale-fact alerts | NOT STARTED (E23) | — |
| Entity scenarios: one activity and one entity; mainland vs free zone; international customers; regulated activities; foreign shareholders; renewal; visas and premises | TESTED as engine cases | core `eligibility.test.ts`, `engine-cases.test.ts` |
| Multiple activities, a holding with a subsidiary, India–UAE ownership | NOT STARTED (gaps 48, 75, 76) | — |
| Setup, renewal and government charges from approved figures | TESTED | core `public.test.ts`, `report.test.ts` |
| Government fees on a quotation keep their evidence; one disclosure online, in the PDF and at acceptance | TESTED | E18, `fee-provenance.test.ts` |
| Three-year cost, visa cost | NOT STARTED | — |

## AI (Phase 3)

| Capability | Status | Evidence |
| --- | --- | --- |
| Deterministic scoping drafts into a review queue | TESTED | `scoping.test.ts`, `journey.test.ts` (document-check drafts: `queue.test.ts`) |
| Live LLM provider | NOT STARTED; BLOCKED on the provider, a key and a cap (T5). No adapter code exists | `lib/ai.ts:212-216`, gap 7 (corrected) |
| Agent tools, planning, run store, approvals | NOT STARTED (E25, E26) | — |
| Document content analysis | NOT STARTED: the checker reads file names only (E27) | `lib/ai.ts:168` |
| Evaluation suite | NOT STARTED (E29) | — |

## Customer experience and conversion (Phase 4)

| Capability | Status | Evidence |
| --- | --- | --- |
| Public flow: homepage, quick match, assessment, saved result, review request | TESTED | `lead-to-tasees.test.ts`, smoke |
| Assessment report PDF in English and Arabic | TESTED | `report.test.ts`, `report-pdf.test.ts`, smoke |
| Client workspace with one next action | TESTED | `journey.test.ts`, smoke |
| Documents needed now, needed later, already sent | TESTED | `documents.test.ts` |
| Document reuse with consent, expiry vault, partner-disclosure approval | NOT STARTED (gaps 34, 71, 125; E28) | — |
| Priority tier speed in the offer and the plan | NOT STARTED (gap 85; E28) | — |
| Funnel from visit to revenue, lead scores, routing | TESTED | `funnel.test.ts`, `leads.test.ts` |
| Calendar booking | NOT STARTED; BLOCKED on a provider (gap 69) | — |

## Commercial infrastructure (Phase 5)

| Capability | Status | Blocker |
| --- | --- | --- |
| Staging in me-central-1, with the runtime login and a migration container in each app task | CODE COMPLETE (the CDK synthesises in CI); NOT LIVE | cloud account, domain (gaps 6a, 122) |
| PostgreSQL backups and restore drill | CODE COMPLETE; the drill has not been run on a real backup | staging |
| S3 storage | CODE COMPLETE; NOT LIVE | a bucket |
| SES email | CODE COMPLETE; NOT LIVE | sender verification (gap 1) |
| Payment gateway | NOT STARTED (memory provider only) | provider choice (gap 2) |
| Bank payout format | CODE COMPLETE for a generic CSV | the bank's sample (gap 3a) |
| Tax invoices | CODE COMPLETE; held | TRN and tax adviser (gap 3) |
| External alerting | CODE COMPLETE; no address | an alert address (gap 37) |
| WhatsApp | NOT STARTED | O14 |
| External security review | NOT STARTED | a reviewer |

## Demonstration (Phase 6)

| Capability | Status |
| --- | --- |
| Demo mode on synthetic data, traces, `docs/competition/*` | NOT STARTED (E29) |

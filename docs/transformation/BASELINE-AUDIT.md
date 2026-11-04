# Baseline audit: the Tasees platform before the transformation

Date: 4 Nov 2026. Code: `main` at d8104fb (E17 merged). Outcome: E18. Delivered under the owner's transformation
mandate of 3 Nov 2026 ("TASEES AI — Product Transformation & Engineering Execution Mandate", Phase 0).

This is a reading of the code as it stands, not of what the documents say it should do. Every claim cites a file and
line, a test or an evidence file. Where something was searched for and not found, the search is named. Status words
follow the mandate's scale (see `IMPLEMENTATION-STATUS.md`); no percentage of completion is given, because there is
no agreed method for one.

How it was made: three read-only inventories of the code (routes, jobs and adapters; database and core modules;
screens and tests), each spot-checked by hand where a finding mattered (the AI model, the upload checks, the audit
table's grants, the route count, the evidence-file route), plus the full test suite and typecheck run on `main`.

## 1. Summary

The platform is a working managed marketplace with its hardest parts built and tested: a priced offer under one margin
rule, money private by role at three layers, evidenced milestones, staged payouts, an append-only hash-chained audit
trail, an event outbox, a jurisdiction engine that refuses to conclude without approved evidence, a public selector,
lead intelligence and a designed bilingual report. 529 automated tests pass on PGlite (154 core, 375 API, 1 skipped
PostgreSQL-only), the API suite also passes on PostgreSQL 16 in CI, and a 326-check browser smoke test with
accessibility scans passes on a fresh demo.

What it is not yet:

1. **Not deployed.** Nothing runs anywhere but a laptop and CI. Staging is code (`infra/`) waiting on the owner's
   cloud account, domain and email sender (gaps 6a, 18, 122). Production is NO-GO (`docs/evidence/E7E/GO-NO-GO.md`:
   every human sign-off row is blank).
2. **No real AI.** `modelFromEnv()` ignores its environment and always returns the deterministic keyword model
   (`apps/api/src/lib/ai.ts:212-216`). No LLM API is called anywhere (searched `anthropic|openai|bedrock|gpt-|
   x-api-key|generativelanguage` outside `node_modules`: comments only). The "agent" today is a scoping drafter and a
   file-name checker whose output goes to a review queue.
3. **No verified regulatory data.** Every scoping rule and place is UNCERTAIN or a rule of thumb (gaps 46, 92); nothing
   is approved for public display (gap 63). The engine is built to say so, and does.
4. **No live payments, WhatsApp, bank API, calendar or malware scanner.** Payments have only a memory provider
   (`lib/payments.ts:74-90`); WhatsApp messages are recorded as skipped (`lib/notify.ts:228-230`); the bank file is a
   generic CSV (`services/payouts.ts:121`); there is no scanner (searched `clamav|malware|virus|quarantin|scanFile`).
   Email (SES) and storage (S3) have live code selected by configuration (`EMAIL=ses`, `STORAGE=s3`), unexercised
   against a real account.

The security defect the mandate named first (the sign-in attempt counter rolled back with its own error) is fixed and
merged as E17 (camayank/mkw-uae-growth#38, D99). This audit found **no other defect that lets one party read
another's money or records**. It found four hardening items worth doing before a pilot (section 4).

## 2. Capability inventory

### 2.1 Shape of the system

| Part | What it is | Where |
| --- | --- | --- |
| API | One Fastify 5 process, 177 routes in 12 route modules plus 3 static routes | `apps/api/src/routes/*.ts`, `apps/api/src/server.ts` |
| Domain logic | 27 pure modules with no I/O (no `Date.now`, `fetch` or `Math.random`) | `packages/core/src` |
| Database | PostgreSQL 16 (PGlite for tests and the demo), 22 migrations, 63 tables, row-level security on 58 | `apps/api/migrations` |
| Web | Plain HTML and ES modules, no build step: the public homepage at `/`, the workspace at `/app/` | `apps/web/public` |
| Jobs | 15 steps every 15 minutes, in-process or as a scheduled task | `apps/api/src/jobs/run.ts` |
| Infrastructure | AWS CDK staging stack for me-central-1 (ECS Fargate, RDS, S3, SES, Secrets Manager); synthesises in CI without an AWS call | `infra/lib/staging-stack.ts` |
| CI | Four jobs: typecheck, tests, build and browser smoke; API tests, races and a load test on PostgreSQL 16; container image; infrastructure synth | `.github/workflows/ci.yml` |

### 2.2 Roles and what each can reach

| Role | Database role | Screens (workspace) | Can never see |
| --- | --- | --- | --- |
| client_owner | `app_client` | home, new request, offer (accepts), engagement, statement, compliance, advice, notifications | partner cost, margin, other quotes |
| client_member | `app_client` | the same, without accepting offers, deciding change orders or rating | the same |
| partner_admin | `app_partner` | work, engagement, performance, firm, rates, payouts (edits) | client price, margin, other partners |
| partner_staff | `app_partner` | the same screens, read-only where money or staff are concerned | as admin, plus own firm's payouts in the visibility map |
| ops | `app_platform` | the staff pages (queue, pipeline, leads, funnel, offers, partners, delays, compliance, AI drafts, rules, scoping, coverage, people, system, audit, search) | margin and margin rules |
| finance | `app_platform` | the same, with margin, payout runs, credits and refunds | — |
| founder | `app_platform` | everything, with settings, sign-offs, approvals and erasure | — |
| agent (visibility only) | none | none | everything but public and internal fields (`packages/core/src/visibility.ts:15-24`) |

Screens: route table `apps/web/public/js/shell.js:196-237`, menus `shell.js:19-29`.

### 2.3 Business services (built and tested)

| Area | What works | Tests |
| --- | --- | --- |
| Intake and scope | Client wizard and conversational intake; scope sheet and milestone templates (`packages/core/src/scope.ts`) | `flow`, `journey`, `scenarios` |
| Pricing | One margin rule with floor, cap and ops review (`packages/core/src/pricing.ts`); three tiers chosen from normalised partner quotes (`select.ts`) | core `pricing` (14), `catalogue` |
| Offers | Draft → ops review → published → accepted / expired / withdrawn as a state machine (`states.ts:39-48`); proposal PDF | `flow`, `transitions`, `delivery` |
| Allocation | Eligibility, fairness cap, cost ceiling, timeouts and re-allocation (`allocation.ts`) | core `allocation`, `exceptions`, `concurrency` |
| Delivery | Milestones with evidence, ops QA, client approval or auto-approval after five working days; delays and guarantee credits; document requests | `flow`, `delivery`, `exceptions` |
| Money | Deposit and balance links (memory provider), signed webhook, tax invoices and credit notes (held until the TRN), staged payouts, weekly payout runs, bank CSV | `payments`, `concurrency` |
| Partners | Onboarding with documents, licence watch, staff, scorecards, rate cards | `partners`, `import` |
| Compliance | Obligation calendar confirmed by a person; reminders at 30 and 7 days; renewal requests | `reporting`, `handoff` |
| Jurisdiction engine | Eligibility before recommendation (`eligibility.ts`), explained advice (`advice.ts`), append-only evidence facts with staleness (`catalogue_facts`, migration 015), coverage matrix and backlog (`coverage.ts`), public display only of approved statements (`public.ts`, D80, D95) | core `eligibility` (33), `engine-cases` (13), `jurisdiction`, `coverage`, `public-selector`, `scenarios` (26) |
| Public selector | Homepage, four-question quick match, full assessment, saved result by code, review request, intake | `public-selector`, `quick-match`, `leads`, smoke |
| Leads and funnel | Sessions, consents, attribution, scores with evidence, next best action, consultation records, funnel events | `leads`, `funnel`, `lead-to-tasees` |
| Reports | Preliminary and reviewed assessment report as a designed PDF in English and Arabic (`lib/report-pdf.ts`) | `report`, `report-pdf`, core `report`, `report-ar` |
| Ops | Risk-ordered queue with timings, digest, alerts, job runs, nightly audit check, global search | `queue`, `hardening` |
| PDPL | Consent at intake, masking between parties, export, erasure that keeps tax records, retention (anonymises only after the founder confirms periods) | `pdpl`, `leads` |
| Arabic | Client screens, emails, report; partner and staff screens English by design (O15) | `locale`, smoke |
| Importers | Go-live workbook: partners, rate cards, fees, holidays, decisions, legal texts, catalogue facts; never send anything | `import` (30) |

### 2.4 External adapters

| Adapter | Live code | Selected by | Status |
| --- | --- | --- | --- |
| Email | SES v2, SigV4-signed (`lib/notify.ts:107-149`) | `EMAIL=ses` | CODE COMPLETE, NOT LIVE (staging is set to `console`, `infra/lib/staging-stack.ts:110`) |
| Storage | S3-compatible with SSE (`lib/storage.ts:100-158`) | `STORAGE=s3` | CODE COMPLETE, NOT LIVE (no bucket yet) |
| Payments | Memory provider only; generic HMAC webhook check is real (`lib/payments.ts:48-90`) | none (`PAYMENT` is never read) | NOT STARTED for a gateway; BLOCKED on the owner's choice (gap 2) |
| AI | Memory model only (`lib/ai.ts:184-216`) | none (`AI` is never read) | NOT STARTED for a provider; BLOCKED on provider, key and monthly cap |
| WhatsApp | none (`lib/notify.ts:228-230`) | — | NOT STARTED |
| Bank file | Generic CSV (`services/payouts.ts:121-122`) | — | CODE COMPLETE for the generic format; BLOCKED on the bank's sample (gap 3a) |
| Calendar booking | none; a consultation is a record and a queued follow-up (gap 103) | — | NOT STARTED |
| Malware scan | none | — | NOT STARTED (gap 45) |

### 2.5 Scheduled jobs

`allocationTimeouts`, `autoApprovals`, `offersExpired`, `opsDigests`, `rulesRefreshed`, `licences`, `delays`,
`obligationReminders`, `queueItems`, `scorecards`, `idempotencyPurged`, `leadsAnonymised`, `auditChecked`, outbox
dispatch, `alerts` (`apps/api/src/jobs/run.ts:54-117`). Every message goes through the outbox (`lib/notify.ts:299`);
no job pays, releases a payout, files or sends WhatsApp. The one money-adjacent automatic action, auto-approval after
five working days, is an explicit tested rule (CLAUDE.md rule 6; `exceptions.test.ts`) and creates a payment link and
a queued email, not a payment.

## 3. Current implementation status

| Capability (mandate phase) | Status | Evidence or blocker |
| --- | --- | --- |
| Core marketplace loop: intake → offer → accept → deliver → approve → pay out (0) | TESTED | `flow`, `scenarios` (26 contract scenarios), `pilot-journeys` A–F |
| Money privacy at three layers (0, 1.2) | TESTED for every cross-party pair; see 4.2 for within-party gaps | `security`, `flow`, `pilot-journeys` C–E, smoke |
| Sign-in attempt limit and enumeration (1.1) | TESTED on PGlite and PostgreSQL 16 | E17, `sign-in.test.ts`, `docs/evidence/E17/` |
| Session expiry and sign-out (1.1) | TESTED | `security.test.ts` |
| Multi-instance rate limiting (1.1) | Per-code limit: TESTED (in the database). Per-address throttle: in-process only (gap 13) | `server.ts:105-113` |
| Tenant and role isolation (1.2) | TESTED across parties; gaps within a party and on some downloads (4.2) | section 4.2 |
| Upload security (1.3) | Size, extension and body caps TESTED; no content check, quarantine or scan | gap 45, `lib/storage.ts:23-34` |
| Release integrity (1.4) | Done: E16 merged green (#37), E17 merged green (#38); no open PRs | GitHub, 4 Nov 2026 |
| Evidence-classified jurisdiction facts (2.1) | CODE COMPLETE: source, authority, dates, verifier, confidence, version, approval exist; data BLOCKED on a named verifier | migration 015, `catalogue.ts`, gap 92 |
| Evidence operations (2.2) | CODE COMPLETE: imports, history, staleness, coverage, backlog; conflict detection and a version diff view are not built | E7B, `coverage.test.ts`, `jurisdiction.test.ts` |
| Entity scenarios A–L (2.3) | A, D, E, G, H, I, J, L handled as cases of one engine with specialist review where data is missing; B, C, K one entity and one activity per assessment (gaps 48, 75, 76) | core `eligibility`, `engine-cases` |
| Economic comparison (2.4) | Setup estimates, renewal and government charges from approved figures only; no three-year cost or visa cost model | `public.ts`, `report.ts` |
| AI agent (3) | NOT STARTED as an agent; a memory-model drafter exists with a review queue | `lib/ai.ts`, `services/drafts.ts` |
| Document intelligence (3.4) | NOT STARTED: the checker reads file names and declared metadata, never the file (`lib/ai.ts:168`) | `services/doccheck.ts` |
| Evaluation suite (3.5) | NOT STARTED | — |
| Public flow (4.1) | TESTED: homepage → quick match → assessment → saved result → review request → lead → request | `lead-to-tasees`, smoke |
| Client workspace (4.2) | TESTED, with one next action per screen | `journey`, smoke |
| Document vault (4.3) | Partly: needed-now / later / sent (E15); no reuse across steps, no expiry vault, no partner-disclosure approval (gaps 34, 71, 125) | `documents.test.ts` |
| Priority services (4.4) | Honest but incomplete: the tier is priced on the fastest quote but its speed is not carried into the offer or the plan, and the screen promises no pace (gap 85, D84) | `select.ts:57-66` |
| Conversion intelligence (4.5) | TESTED for visits through acceptance and revenue; contribution margin to finance only; calendar not integrated | `funnel`, `leads`, `reporting` |
| Commercial infrastructure (5) | BLOCKED on owner accounts; staging stack is code | `docs/evidence/E7E/STAGING-CHECKLIST.md` |
| Competition demo (6) | NOT STARTED | — |

## 4. Critical risks

Ordered by what could go wrong in a pilot. None is a known leak today; each is a missing guard or a missing test.

### 4.1 Security

| # | Risk | Evidence | Proposed treatment |
| --- | --- | --- | --- |
| S1 | **The audit trail can be edited by the platform's own database role.** `app_platform` has `grant all` (`migrations/001_init.sql:394`) and a "for all" policy on `audit_events` (`001_init.sql:454-456`); no trigger blocks update, delete or truncate, unlike `catalogue_facts` (`015_catalogue.sql:81-82`) and `consents` (`017`). The nightly check detects an edited row, but deleting the newest rows leaves a valid shorter chain that the check cannot tell from the real one (no chain head is kept outside the table). CLAUDE.md rule 8 says "never edit or delete audit rows"; today that is a convention plus detection, not a guard. | `002_admin_and_pdpl.sql:48-69`, `pdpl.test.ts:166`, `hardening.test.ts:231` (tests that tamper on purpose) | E19: an append-only trigger as on `catalogue_facts`, and the chain head and count recorded in `audit_checks` each night so a truncated tail is detected. Tamper tests switch to a superuser connection. |
| S2 | **Within one organisation type, the database does not separate roles.** Ops, finance and founder share `app_platform`; partner admin and staff share `app_partner` (`packages/core/src/types.ts:15-24`, `apps/api/src/lib/context.ts:38-47`). "Ops never sees margin" and "staff never see payouts" hold at the route guards and the visibility map, not at the database, so the three-layer rule (CLAUDE.md rule 1) is two layers for these pairs. | `visibility.ts:15-24`; route guards e.g. `routes/money.ts:81,95` | E19: tests for every within-party pair first (4.2); a decision record on whether to split `app_platform` into ops and finance database roles with column grants, which is a larger migration. |
| S3 | **Uploads are not inspected.** Extension and size only (`lib/storage.ts:23-34`); the MIME type is never checked; a magic-byte check exists for one path (partner invoice PDFs, `services/payouts.ts:61`); there is no quarantine and no scan. Files are always served as `application/octet-stream` attachments, which limits but does not remove the risk of passing malware between parties. | gap 45, `SECURITY-BRIEF.md` | E20: content-type sniffing by magic bytes per allowed extension, a quarantine state that blocks download until scanned, a scanner adapter with a memory double, "unavailable means not clean". A live scanner (e.g. ClamAV as a side task) costs money to run: owner decision. |
| S4 | **The per-address throttle is per process.** Ten routes use an in-memory counter (`server.ts:105-113`); with two instances an attacker gets twice the budget. The sign-in code limit no longer depends on it (E17). | gap 13 | Record the infrastructure dependency (a WAF rate rule on the load balancer, or a shared store) in the staging checklist; not a code change until there are two instances. |

### 4.2 Test coverage holes found in the role and tenant audit

The cross-party rules are tested thoroughly (section 3). These within-party and download paths are not:

| Path | What is not tested |
| --- | --- |
| `GET /api/evidence/:id/file` (`routes/client.ts:113`) | No test downloads it as any role; it relies on row-level security on `evidence` alone. The smoke test only counts the link (`scripts/smoke.mjs:326`). |
| `GET /api/invoices/:id/pdf`, `GET /api/client/offers/:id/pdf` | Not tried as another client (partner and anonymous are). |
| `GET /api/client/statement` | Not tried as another client. |
| client_member | No test reads an offer, engagement, statement or invoice as a member and checks the money fields; the smoke never signs in as a member. |
| partner_staff | `/api/partner/home`, `/api/partner/dashboard` and the payouts list are not read as staff; the smoke never signs in as staff. |
| ops | No database-level test as a platform role (all `asUser` tests use client or partner users); no assertion that ops's engagement view carries no margin. |
| Exports | Accounting export not tried as a partner; coverage backlog CSV has no refused-role test; payout bank file not tried as client or partner. |
| Agent identity | The visibility map has an `agent` audience, but no database role or route serves it yet; the mandate's AI tools must inherit least privilege when they arrive. |

### 4.3 Commercial and data

| # | Risk | Evidence |
| --- | --- | --- |
| C1 | No verified fee or rule data; the engine shows "to be verified" everywhere. A pilot client gets a reviewed opinion only through a person. | gaps 4, 46, 92; D80 |
| C2 | The priority tier's speed is priced but not promised; a client paying more for "Priority" gets the same plan dates. Honest today because the screen promises no pace, but commercially weak. | gap 85 |
| C3 | Every human sign-off for the pilot is blank (owner, lawyer, tax adviser, verifiers, security reviewer, Arabic reviewer, partners, clients, staging). | `docs/evidence/E7E/GO-NO-GO.md` |
| C4 | No AI provider: the transformation's centrepiece depends on an owner decision (provider, key, monthly spending cap). | `lib/ai.ts:213` |

## 5. Reusable components

The transformation should build on these rather than beside them:

- **Domain engines** (`packages/core`): `eligibility`, `advice`, `public`, `quick`, `coverage`, `obligations`,
  `pricing`, `allocation`, `documents`, `report`. These are the agent's natural tools: pure, typed, tested.
- **`transition()`** (`apps/api/src/lib/transition.ts:45-58`): locks a row, checks the state machine, writes the audit
  event. Agent actions that change state must go through it.
- **The outbox** (`lib/outbox.ts`): exactly-once side effects with retry and an "unknown" state for staff. Agent
  follow-ups and drafts belong here.
- **The AI draft queue** (`ai_drafts`, `services/drafts.ts`, the "AI drafts" page): UNCERTAIN drafts reviewed by a
  person. The agent's output should land here, not in a new queue.
- **Idempotency keys** (`lib/idempotency.ts`) and **the audit chain** (`lib/audit.ts`): agent runs get both for free.
- **The visibility map** (`packages/core/src/visibility.ts`) with its `agent` audience already defined.
- **Adapters with memory doubles** (`notify`, `storage`, `payments`, `ai`): the pattern for every new integration.
- **zod schemas → OpenAPI** (`lib/openapi.ts`): typed tool inputs and outputs can be the same schemas.
- **Evidence facts** (`catalogue_facts`, append-only): the store for verified regulatory knowledge.
- **The smoke test** (`scripts/smoke.mjs`): screens, phone width, axe, PDFs, privacy text checks.

## 6. Missing capabilities

Against the mandate, in its phase order:

1. Database guard on the audit trail; database separation of ops from finance (S1, S2).
2. Upload content checks, quarantine and a scanner adapter (S3).
3. Tests for the within-party and download paths in 4.2.
4. Conflict detection and a version comparison view for evidence facts (2.2).
5. Multi-activity, multi-entity and holding structures in one assessment; India–UAE ownership (2.3 B, C, K; gaps 48,
   75, 76).
6. A three-year cost and visa cost comparison from approved figures (2.4).
7. An LLM provider adapter with structured output, budgets, timeouts and the memory fallback (3.3).
8. A tool registry over the existing services, an agent run store with resume, and approval records (3.2).
9. Document content analysis (3.4), after S3.
10. An evaluation suite of at least 30 scenarios with measured, not invented, results (3.5).
11. Document reuse across steps with consent (4.3; gaps 34, 125).
12. Priority speed carried into offer lines, the proposal and the plan (4.4; gap 85).
13. Calendar booking when the owner chooses a provider (4.5; gap 69).
14. Everything in Phase 5 that needs an account: staging, domain, SES, payments, bank format, alerts (gaps 1, 2, 3a,
    6, 6a, 37, 122).
15. The competition demonstration mode and its documents (Phase 6).

## 7. Proposed architecture changes

All additive; none replaces a working module.

| Change | Why | Shape |
| --- | --- | --- |
| Audit append-only trigger and chain-head record | Rule 8 as a guard, not a convention | Migration 023: triggers like `015_catalogue.sql:68-82`; `audit_checks` gains `head_id`, `head_hash` |
| Separate platform database roles (decision first) | Rule 1's third layer for ops vs finance | Option A: `app_ops` and `app_finance` roles with column grants mirroring the visibility map. Option B: keep one role and document the two-layer exception. Recorded as an open decision in `DECISION-LOG.md` |
| Upload quarantine | Gap 45 | `scan_status` on the file-bearing tables (`evidence`, `document_requests`, `partner_documents`, `obligations`, `partner_invoices`), a `Scanner` adapter with memory and ClamAV implementations, downloads refused until `clean` |
| LLM provider adapter | Phase 3.3 | Extend `AiModel` in `lib/ai.ts`; a live implementation behind `AI=<provider>` with a key from Secrets Manager, a monthly cap in fils, a timeout, zod-validated structured output, and the memory model kept as the fallback and the test double |
| Agent run store and tool registry | Phase 3.2 | New tables `agent_runs`, `agent_steps` (append-only), `agent_approvals`; a registry mapping typed tools to existing services under an `agent` identity whose rights are the requesting user's, never wider |
| Evidence conflict and diff | Phase 2.2 | Pure functions in `packages/core/src/catalogue.ts` over `catalogue_facts` history; a page on the coverage screen |

## 8. Technical debt

| Item | Where | Cost of leaving it |
| --- | --- | --- |
| Request, payout and change-order statuses are set by direct SQL with no transition table; requests and change orders have no check constraint | `packages/core/src/states.ts` (only milestone, offer, engagement), `services/engagements.ts:82,144,548,587,630`, `services/pricing.ts:73,162` | A new path (the agent) could set an invalid state |
| `deliverables` has no row-level security and is fully readable by clients and partners, including `market_mid_fils` | `001_init.sql:399` | Low: a catalogue reference price, not partner cost or margin; recorded so it is a choice |
| Five tables without RLS (`sessions`, `login_codes`, `deliverables`, `margin_rules`, `settings`) | migration 001 | Only `deliverables` is granted to client or partner roles; the others are platform-only by grant |
| The document checker reads file names only | `lib/ai.ts:127-169` | Its draft is labelled as such; no false claim, but little value |
| Tests' per-address throttle workarounds | `sign-in.test.ts` (trusted proxy), `report.test.ts` (60 s timeout) | Slow CI on a busy runner; one flake fixed in E17 |
| Web app without a build step | `apps/web/public` | A conscious choice (D-records); keep |
| Many owner-facing defaults (margin rule, fairness cap, deposit, quality bar as code constants) | gap 24 | Each needs a person's confirmation before the pilot |

## 9. Business impact

- **Revenue is gated by people, not code.** Every capability a pilot needs to take a client's money and pay a partner
  exists and is tested; what stops the first paid engagement is the blank sign-off sheet and the missing accounts
  (C3, Phase 5). The transformation's code work does not move that date; the owner's inputs do.
- **The AI agent is the largest value and the largest open decision.** It can reduce ops minutes per engagement (the
  vision's measure) only once a provider is chosen; until then everything agent-shaped can be built against the
  memory model and labelled as such.
- **Verified data is the trust bottleneck.** The public selector and the report cannot give a definitive answer
  until a named verifier records first-wave facts (gap 92). The engine and the workflow are ready.
- **Security hardening (S1–S3) is cheap now and expensive after a pilot.** Each is one outcome.

## 10. Test evidence

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm typecheck` on `main` d8104fb | clean | `docs/evidence/E18/typecheck.txt` |
| `pnpm test` on `main` d8104fb (PGlite) | core 154 passed (18 files); API 375 passed, 1 skipped (38 files) | `docs/evidence/E18/tests-pglite.txt` |
| API tests on PostgreSQL 16, races, load test | passed in CI on every merge to `main`; E17's sign-in and security tests also run locally on PostgreSQL 16 (13 passed) | `.github/workflows/ci.yml` job `postgres`; `docs/evidence/E17/tests-postgres16.txt` |
| Browser smoke on a fresh demo | 326 checks, 0 failed, about 55 axe scans, phone width | `docs/evidence/E17/smoke-log.txt` (E17's branch); CI runs it on every merge to `main` |
| Audit chain | verified by CI after the smoke run | `.github/workflows/ci.yml` |

E18 changes documents only, so the smoke test was not re-run for it.

## 11. Prioritised execution backlog

The mandate's suggested order (P0-01 to P1-06) reconciled with the existing outcome numbers. Each line is one
reviewed pull request. "Owner" lists what only the owner can supply; everything else proceeds under the mandate.

| Order | Outcome | Mandate item | Depends on | Owner |
| --- | --- | --- | --- | --- |
| done | E17 Sign-in lockout | P0-01, 1.1 | — | — |
| this | E18 Baseline audit and tracking documents | Phase 0 | E17 | — |
| 1 | E19 Role isolation and audit guard: tests for every path in 4.2; audit append-only trigger and chain-head check (S1); decision record on platform database roles (S2) | P0-01, 1.2 | E18 | the S2 option |
| 2 | E20 Upload quarantine: magic-byte checks, quarantine state, scanner adapter with memory double, refused downloads until clean | P0-01, 1.3 | E18 | running a live scanner (cost) |
| 3 | E21 Evidence operations: conflict detection, version comparison, stale-fact alerts on the queue | P0-02, 2.2 | E18 | named verifier for real data |
| 4 | E22 AI provider adapter: live adapter behind configuration, budgets, timeouts, structured output, capability status on screen | P1-01, 3.3 | E18 | provider, key, monthly cap |
| 5 | E23 Agent tools and planning: typed tool registry over existing services, agent identity with least privilege, launch plan from the existing engines | P1-02, 3.2 A–C | E19, E22 | — |
| 6 | E24 Agent execution and approval: run store, resume, idempotency, budgets, approval records, progress on screen | P1-03, 3.2 D–F | E23 | — |
| 7 | E25 Document intelligence: content extraction for authorised uploads, reviewer checklist, never auto-approving identity | P1-04, 3.4 | E20, E22 | — |
| 8 | E26 Client journey: document reuse with consent (gaps 34, 125), priority speed carried into the offer and plan (gap 85) | P1-05, 4.3–4.4 | E18 | — |
| 9 | E27 Agent evaluation and demonstration: 30+ scenarios with measured results, demo mode on synthetic data, `docs/competition/*` | P1-06, 3.5, 6 | E24 | — |
| later | Multi-activity and holding structures (2.3 B, C, K); three-year cost (2.4) | P0-02 | E21 | verified figures |
| owner | O7 launch gate, O14 real payments and WhatsApp, O15 books and Arabic: staging and integrations | P0-03, Phase 5 | accounts | cloud, domain, SES, payment provider, bank sample, WhatsApp |

O16 "Agents round two" (fee and rule watcher, calendar agent, vetting assistant, founder analyst) overlaps E22–E24;
the proposal is that E22–E24 deliver its foundation and O16 keeps only the specific agents, to be confirmed by the
owner (`DECISION-LOG.md`, T7).

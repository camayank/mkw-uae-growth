# Baseline audit: the Tasees platform at the start of the transformation

Date: 4 Nov 2026. Code: `main` at a42c487 (E19 merged). Outcome: E20. Delivered under the owner's transformation
mandate of 3 Nov 2026 ("TASEES AI — Product Transformation & Engineering Execution Mandate", Phase 0).

This audit was first drafted on `main` at d8104fb. Its independent review found two cross-party defects and two
untested or unsafe areas; the owner had them fixed first, as E19. Since then, E18 (quote provenance) and E19 (role
isolation) have merged. This version reads the code after both, and applies the review's corrections.

This is a reading of the code as it stands, not of what the documents say it should do:
- every claim cites a file and line, a test or an evidence file;
- where something was searched for and not found, the search is named;
- status words are the mandate's seven, defined in `IMPLEMENTATION-STATUS.md`;
- no percentage of completion is given, because no agreed method for one exists.

How it was made:
- three read-only inventories of the code (routes, jobs and adapters; database and core modules; screens and tests);
- each finding the audit relies on spot-checked by hand;
- an independent adversarial review of the first draft;
- the full test suite, the typecheck and the production dependency audit run on `main` (section 10).

## 1. Summary

The platform is a working managed marketplace with its hardest parts built and tested:
- a priced offer under one margin rule, whose government fees keep the evidence they were quoted on (E18);
- money private by role, across parties at three layers and within a party at two;
- evidenced milestones and staged payouts;
- an append-only, hash-chained audit trail, guarded by the database (E19);
- an event outbox;
- a jurisdiction engine that will not conclude without approved evidence;
- a public selector, lead intelligence and a designed bilingual report.

The checks pass: 563 automated tests on PGlite (159 core, 404 API, 7 skipped that need PostgreSQL), 411 on
PostgreSQL 16, and a 337-check browser smoke test on a fresh demo with 60 accessibility scans.

What it is not yet:

1. **Not deployed.** Nothing runs anywhere but a laptop and CI.
   - Staging is code (`infra/`), waiting on the owner's cloud account, domain and email sender (gaps 6a, 18, 122).
   - Production is NO-GO: every human sign-off row in `docs/evidence/E7E/GO-NO-GO.md` is blank.
2. **No real AI.** `modelFromEnv()` ignores its environment and always returns the deterministic keyword model
   (`apps/api/src/lib/ai.ts:212-216`).
   - No LLM API is called anywhere. A search for `anthropic|openai|bedrock|gpt-|x-api-key|generativelanguage`
     outside `node_modules` finds comments only.
   - No provider adapter exists either. Gap 7 said one was written; it was not, and this outcome corrects the gap.
   - The "agent" today is a scoping drafter and a file-name checker, whose output goes to a review queue.
3. **No verified regulatory data.** Every scoping rule and place is UNCERTAIN or a rule of thumb (gaps 46, 92), and
   nothing is approved for public display (gap 63). The engine is built to say so, and does.
4. **No live payments, WhatsApp, bank API, calendar or malware scanner.**
   - Payments have only a memory provider (`lib/payments.ts:74-90`).
   - WhatsApp messages are recorded as skipped (`lib/notify.ts:228-230`).
   - The bank file is a generic CSV (`services/payouts.ts:121`).
   - There is no scanner (searched `clamav|malware|virus|quarantin|scanFile`).
   - Email (SES) and storage (S3) have live code selected by configuration (`EMAIL=ses`, `STORAGE=s3`), never run
     against a real account.

Three security outcomes have now merged:
- **E17:** the sign-in attempt counter (camayank/mkw-uae-growth#38, D99);
- **E18:** quote provenance (camayank/mkw-uae-growth#39, D100);
- **E19:** role isolation (camayank/mkw-uae-growth#40, D101).

E19 also fixed the two defects found while drafting this audit: one partner firm reading another firm's change-order
cost, and partner staff receiving money figures.

What remains is section 4: missing guards and missing tests. None of them is a known leak.

## 2. Capability inventory

### 2.1 Shape of the system

| Part | What it is | Where |
| --- | --- | --- |
| API | One Fastify 5 process: 174 routes in 12 route modules, plus 3 static routes in `server.ts` (177) | `apps/api/src/routes/*.ts`, `apps/api/src/server.ts` |
| Domain logic | 28 modules with no I/O (no `Date.now`, `fetch` or `Math.random`), `fee-disclosure.ts` the newest | `packages/core/src` |
| Database | PostgreSQL 16 (PGlite for tests and the demo); 26 migrations; 63 tables, row-level security on 58 | `apps/api/migrations` |
| Database logins | In production the app logs in as a runtime login that owns nothing. Only the migration step, the first container of each app task, holds the owner's secret (E19) | `migrations/025`, `026`, `lib/db.ts`, `infra/lib/staging-stack.ts` |
| Web | Plain HTML and ES modules with no build step: the public homepage at `/`, the workspace at `/app/` | `apps/web/public` |
| Jobs | 15 steps every 15 minutes, in-process or as a scheduled task | `apps/api/src/jobs/run.ts` |
| Infrastructure | AWS CDK staging stack for me-central-1 (ECS Fargate, RDS, S3, SES, Secrets Manager); it synthesises in CI without an AWS call | `infra/lib/staging-stack.ts` |
| CI | Four jobs: typecheck, tests, build and browser smoke; API tests, races and a load test on PostgreSQL 16; container image; infrastructure synth | `.github/workflows/ci.yml` |

### 2.2 Roles and what each can reach

| Role | Database role | Screens (workspace) | Can never see |
| --- | --- | --- | --- |
| client_owner | `app_client` | home, new request, offer (accepts), engagement, statement, compliance, advice, notifications | partner cost, margin, other quotes |
| client_member | `app_client` | the same, without accepting offers, deciding change orders or rating | the same (tested since E19) |
| partner_admin | `app_partner` | work, engagement, performance, firm, rates, payouts (edits) | client price, margin, other partners, another firm's change orders (E19) |
| partner_staff | `app_partner` | work, engagement, performance, firm, rates; no Payouts page | any money figure, government fees included (E19) |
| ops | `app_platform` | the staff pages (queue, pipeline, leads, funnel, offers, partners, delays, compliance, AI drafts, rules, scoping, coverage, people, system, audit, search) | the margin figure and margin rules; the audit trail is shown without margin (E18) |
| finance | `app_platform` | the same, with margin, payout runs, credits and refunds | — |
| founder | `app_platform` | everything, with settings, sign-offs, approvals and erasure | — |
| agent (visibility only) | none | none | everything except public and internal fields (`packages/core/src/visibility.ts:15-24`) |

Screens: route table `apps/web/public/js/shell.js:196-237`, menus `shell.js:19-29`.

Ops see a line's client price and its partner cost, so the margin is one subtraction away. That is an accepted
decision (D22a): rule 1 hides the margin figure and the margin rules from ops, not the two prices.

Within one party the split rests on route guards, the visibility map and the views, all tested; it is not in database
grants (gap 142).

### 2.3 Business services (built and tested)

| Area | What works | Tests |
| --- | --- | --- |
| Intake and scope | Client wizard and conversational intake; scope sheet and milestone templates (`packages/core/src/scope.ts`) | `flow`, `journey`, `scenarios` |
| Pricing | One margin rule with floor, cap and ops review (`packages/core/src/pricing.ts`); three tiers chosen from normalised partner quotes (`select.ts`) | core `pricing` (14), `catalogue` |
| Quote provenance | Each offer line keeps its government fee's basis, record, source, verifier and dates, frozen by a trigger. One disclosure (VERIFIED, PARTNER-STATED, UNCERTAIN, STALE, LEGACY) appears on the proposal, the PDF, the acceptance record and MKW's review (E18) | `fee-provenance` (21), core `fee-disclosure` |
| Offers | Draft, ops review, published, then accepted, expired or withdrawn, as a state machine (`states.ts:39-48`); proposal PDF | `flow`, `transitions`, `delivery` |
| Allocation | Eligibility, fairness cap, cost ceiling, timeouts and re-allocation (`allocation.ts`) | core `allocation`, `exceptions`, `concurrency` |
| Delivery | Milestones with evidence, ops QA, client approval or auto-approval after five working days; delays and guarantee credits; document requests | `flow`, `delivery`, `exceptions` |
| Money | Deposit and balance links (memory provider), signed webhook, tax invoices and credit notes (held until the TRN), staged payouts, weekly payout runs, bank CSV | `payments`, `concurrency` |
| Partners | Onboarding with documents, licence watch, staff, scorecards, rate cards | `partners`, `import` |
| Compliance | Obligation calendar confirmed by a person; reminders at 30 and 7 days; renewal requests | `reporting`, `handoff` |
| Jurisdiction engine | Eligibility before recommendation (`eligibility.ts`); explained advice (`advice.ts`); append-only evidence facts with staleness (`catalogue_facts`, migration 015); coverage matrix and backlog (`coverage.ts`); public display only of approved statements (`public.ts`, D80, D95) | core `eligibility` (33), `engine-cases` (13), `jurisdiction`, `coverage`, `public-selector`, `scenarios` (26) |
| Public selector | Homepage, four-question quick match, full assessment, saved result by code, review request, intake | `public-selector`, `quick-match`, `leads`, smoke |
| Leads and funnel | Sessions, consents, attribution, scores with evidence, next best action, consultation records, funnel events | `leads`, `funnel`, `lead-to-tasees` |
| Reports | Preliminary and reviewed assessment report as a designed PDF, in English and Arabic (`lib/report-pdf.ts`) | `report`, `report-pdf`, core `report`, `report-ar` |
| Ops | Risk-ordered queue with timings, digest, alerts, job runs, nightly audit check, global search | `queue`, `hardening` |
| PDPL | Consent at intake; masking between parties; export; erasure that keeps tax records; retention (anonymises only after the founder confirms the periods) | `pdpl`, `leads` |
| Arabic | Client screens, emails and the report; partner and staff screens English by design (O15) | `locale`, smoke |
| Importers | Go-live workbook: partners, rate cards, fees, holidays, decisions, legal texts, catalogue facts. They never send anything | `import` (30) |

### 2.4 External adapters

| Adapter | Live code | Selected by | Status |
| --- | --- | --- | --- |
| Email | SES v2, SigV4-signed (`lib/notify.ts:107-149`) | `EMAIL=ses` | CODE COMPLETE; NOT LIVE (staging is set to `console`, `infra/lib/staging-stack.ts`) |
| Storage | S3-compatible with SSE (`lib/storage.ts:100-158`) | `STORAGE=s3` | CODE COMPLETE; NOT LIVE (no bucket yet) |
| Payments | Memory provider only; the generic HMAC webhook check is real (`lib/payments.ts:48-90`) | none (`PAYMENT` is never read) | NOT STARTED for a gateway; BLOCKED on the owner's choice (gap 2) |
| AI | Memory model only (`lib/ai.ts:184-216`); no provider adapter (gap 7, corrected) | none (`AI` is never read) | NOT STARTED for a provider; BLOCKED on provider, key and monthly cap |
| WhatsApp | none (`lib/notify.ts:228-230`) | — | NOT STARTED |
| Bank file | Generic CSV (`services/payouts.ts:121-122`) | — | CODE COMPLETE for the generic format; BLOCKED on the bank's sample (gap 3a) |
| Calendar booking | None: a consultation is a record and a queued follow-up (gap 103) | — | NOT STARTED |
| Malware scan | none | — | NOT STARTED (gap 45) |

### 2.5 Scheduled jobs

The steps (`apps/api/src/jobs/run.ts:54-117`): `allocationTimeouts`, `autoApprovals`, `offersExpired`,
`opsDigests`, `rulesRefreshed`, `licences`, `delays`, `obligationReminders`, `queueItems`, `scorecards`,
`idempotencyPurged`, `leadsAnonymised`, `auditChecked`, outbox dispatch and `alerts`.

Every message goes through the outbox (`lib/notify.ts:299`). No job pays, releases a payout, files or sends WhatsApp.

Two jobs act on money by a tested rule (CLAUDE.md rule 6), and neither moves money:
- **`autoApprovals`** approves a step after five working days. On completion it creates a payment link and queues an
  email (`exceptions.test.ts`).
- **`delays`** creates guarantee credits as `pending` rows that finance decides (`services/delivery.ts:130-157`).

## 3. Current implementation status

The maintained version of this table is `IMPLEMENTATION-STATUS.md`.

| Capability (mandate phase) | Status | Evidence or blocker |
| --- | --- | --- |
| Core marketplace loop: intake, offer, accept, deliver, approve, pay out (0) | TESTED | `flow`, `scenarios` (26 contract scenarios), `pilot-journeys` A–F |
| Money privacy across parties, three layers (0, 1.2) | TESTED | `security`, `flow`, `role-isolation`, `pilot-journeys` C–E, smoke |
| Money privacy within a party (ops and finance; partner admin and staff; client owner and member) (1.2) | TESTED at the API (two layers); not in database grants (gap 142) | `role-isolation`, `flow`, `reporting`, `catalogue` |
| Sign-in attempt limit and enumeration (1.1) | TESTED on PGlite and PostgreSQL 16 | E17, `sign-in.test.ts` |
| Sign-out and session expiry (1.1) | TESTED (since E19; the first draft overstated this) | `role-isolation.test.ts` |
| Multi-instance rate limiting (1.1) | The per-code limit is TESTED (it lives in the database). The per-address throttle is in-process only (gap 13, shared rate limiting) | `server.ts:105-113` |
| Downloads refused to another party (1.2) | TESTED for 6 of 12 download routes; the other six are listed in section 4.2 | section 4.2 |
| Runtime database login and append-only audit (1.2) | TESTED on PostgreSQL 16; NOT LIVE (no staging) | E19, `runtime-login.test.ts` |
| Upload security (1.3) | Size, extension and body caps are TESTED; there is no content check, quarantine or scan | gap 45, `lib/storage.ts:23-34` |
| Release integrity (1.4) | Done: E16 to E19 merged green (#37 to #40); no open PRs | GitHub, 4 Nov 2026 |
| Quote provenance and fee disclosure (2.4, 4.4) | TESTED | E18, `fee-provenance.test.ts` |
| Evidence-classified jurisdiction facts (2.1) | CODE COMPLETE; data BLOCKED on a named verifier. Source, authority, dates, verifier, confidence, version and approval all exist | migration 015, `catalogue.ts`, gap 92 |
| Classification: verified, rule of thumb, UNCERTAIN, stale, data unavailable (2.1) | TESTED | core `catalogue`, `eligibility`, `jurisdiction.test.ts` |
| Evidence operations (2.2) | CODE COMPLETE for imports, history, staleness, coverage and backlog. Conflict detection and a version diff view are NOT STARTED | E7B, `coverage.test.ts`, `jurisdiction.test.ts` |
| Entity scenarios A–L (2.3) | A, D, E, G, H, I, J and L are TESTED as cases of one engine, with specialist review where data is missing. B, C and K are NOT STARTED: one entity and one activity per assessment (gaps 48, 75, 76) | core `eligibility`, `engine-cases` |
| Economic comparison (2.4) | Setup estimates, renewal and government charges from approved figures only are TESTED. Three-year cost and visa cost are NOT STARTED | `public.ts`, `report.ts` |
| AI agent (3) | NOT STARTED as an agent. A memory-model drafter with a review queue is TESTED | `lib/ai.ts`, `services/drafts.ts` |
| Document intelligence (3.4) | NOT STARTED: the checker reads file names and declared metadata, never the file (`lib/ai.ts:168`) | `services/doccheck.ts` |
| Evaluation suite (3.5) | NOT STARTED | — |
| Public flow (4.1) | TESTED: homepage, quick match, assessment, saved result, review request, lead, request | `lead-to-tasees`, smoke |
| Client workspace (4.2) | TESTED, with one next action per screen | `journey`, smoke |
| Document vault (4.3) | Needed now, later and sent (E15) is TESTED. Reuse across steps, an expiry vault and partner-disclosure approval are NOT STARTED (gaps 34, 71, 125) | `documents.test.ts` |
| Priority services (4.4) | The tier is TESTED as priced on the fastest quote, with no pace promised on screen. Carrying its speed into the offer and the plan is NOT STARTED (gap 85, D84) | `select.ts:57-66` |
| Conversion intelligence (4.5) | Visits through acceptance and revenue are TESTED; contribution margin goes to finance only. A calendar is NOT STARTED | `funnel`, `leads`, `reporting` |
| Commercial infrastructure (5) | BLOCKED on owner accounts; the staging stack is CODE COMPLETE and synthesises in CI | `docs/evidence/E7E/STAGING-CHECKLIST.md`, `docs/evidence/E19/synth.txt` |
| Competition demo (6) | NOT STARTED | — |

## 4. Critical risks

Ordered by what could go wrong in a pilot. None is a known leak today; each is a missing guard or a missing test.

### 4.1 Security

| # | Risk | Evidence | Treatment |
| --- | --- | --- | --- |
| S1 | **Uploads are not inspected.** Only extension and size are checked (`lib/storage.ts:23-34`), and the MIME type never is. A magic-byte check exists on one path, partner invoice PDFs (`services/payouts.ts:61`). There is no quarantine and no scan. Files are always served as `application/octet-stream` attachments, which limits the risk of passing malware between parties but does not remove it. | gap 45, `SECURITY-BRIEF.md` | E22: magic-byte checks per allowed extension; a quarantine state that blocks downloads until a file is scanned; a scanner adapter with a memory double; an unavailable scan counts as not clean. A live scanner costs money to run: owner decision (T6) |
| S2 | **Within one party, the database does not separate roles** (gap 142). Ops, finance and the founder share `app_platform`; partner admin and staff share `app_partner`. Every within-party path is tested at the API since E19, so this is two layers, not three. | D101, `visibility.ts:15-24`, `role-isolation.test.ts` | Open owner decision (T4). Recommendation: keep the API split unless the outside security reviewer asks |
| S3 | **The per-address throttle counts per process** (gap 13, shared rate limiting). With two instances an attacker gets twice the budget. The sign-in code limit no longer depends on it (E17). | `server.ts:105-113` | A WAF rate rule on the load balancer, or a shared store, when staging runs two tasks |
| S4 | **The audit trail's database owner can still switch the guard off** (gap 143). The hash has no secret, so the owner could also recompute the chain. The nightly check stores the chain's length but does not compare it with the night before. | `002_admin_and_pdpl.sql:48-69`, `services/system.ts:55-61` | Only the master secret can do this, and only the migration container and a DBA hold it (E19). E21: compare the length night to night |
| S5 | **Some states change by direct SQL with no transition table:** requests, payouts and change orders. Requests and change orders have no check constraint either. A new code path, such as the agent, could set an invalid state. | `packages/core/src/states.ts` (milestone, offer, engagement only), `services/engagements.ts:82,144,548,587,630`, `services/pricing.ts:73,162` | E21: transition tables for the three, before the agent gets write tools (E25) |

### 4.2 Download routes without a test that another party is refused

There are twelve routes that send a file (`content-disposition: attachment`). Six of them are tested against another
party:
- the client's report PDF (`report.test.ts`);
- the public report PDF (by recovery code, `report.test.ts`);
- a document-request file (`delivery.test.ts`);
- a partner document (`partners.test.ts`);
- an obligation file (`reporting.test.ts`);
- a person's PDPL export (`pdpl.test.ts`).

These six are not:

| Route | What is not tested |
| --- | --- |
| `GET /api/evidence/:id/file` (`routes/client.ts:123`) | No test downloads it at all. It relies on row-level security on `evidence` (the smoke test only counts the link) |
| `GET /api/invoices/:id/pdf` (`routes/money.ts:38`) | Not tried as another client (a partner and an anonymous caller are) |
| `GET /api/client/offers/:id/pdf` (`routes/delivery.ts:175`) | Not tried as another client (a partner is) |
| `GET /api/admin/coverage/backlog.csv` (`routes/scoping.ts:109`) | No refused role is tried |
| `GET /api/ops/payout-runs/:id/file` (`routes/money.ts:113`) | Not tried as a client or a partner (ops are) |
| `GET /api/admin/accounting/export` (`routes/reporting.ts:30`) | Not tried as a partner (a client and ops for the margin set are) |

The client statement takes no id and is scoped to the caller's organisation (`routes/money.ts:16-18`), so it is not a
cross-party test gap. It runs under `asPlatform`, as most client and partner routes that build documents do, so only
the code's own check applies there.

### 4.3 Commercial and data

| # | Risk | Evidence |
| --- | --- | --- |
| C1 | No verified fee or rule data: the engine shows "to be verified" everywhere, and a pilot client gets a reviewed opinion only through a person | gaps 4, 46, 92; D80 |
| C2 | The priority tier's speed is priced but not promised: a client paying more for "Priority" gets the same plan dates. Honest today because the screen promises no pace, but commercially weak | gap 85 |
| C3 | Every human sign-off for the pilot is blank (owner, lawyer, tax adviser, verifiers, security reviewer, Arabic reviewer, partners, clients, staging) | `docs/evidence/E7E/GO-NO-GO.md` |
| C4 | No AI provider: the transformation's centrepiece depends on an owner decision (provider, key, monthly spending cap) | `lib/ai.ts:213`, T5 |
| C5 | A partner-stated government fee publishes without a person's acknowledgement; the client sees it labelled PARTNER-STATED | gap 135, D100 |

## 5. Reusable components

The transformation should build on these, not beside them:

- **Domain engines** (`packages/core`): `eligibility`, `advice`, `public`, `quick`, `coverage`, `obligations`,
  `pricing`, `allocation`, `documents`, `report`, `fee-disclosure`. These are the agent's natural tools: pure, typed
  and tested.
- **`transition()`** (`apps/api/src/lib/transition.ts:45-58`): it locks a row, checks the state machine and writes the
  audit event. Agent actions that change state must go through it, once S5 gives every entity a table.
- **The outbox** (`lib/outbox.ts`): exactly-once side effects, with retry and an "unknown" state for staff. Agent
  follow-ups and drafts belong here.
- **The AI draft queue** (`ai_drafts`, `services/drafts.ts`, the "AI drafts" page): UNCERTAIN drafts that a person
  reviews. The agent's output should land here, not in a new queue.
- **Idempotency keys** (`lib/idempotency.ts`) and **the audit chain** (`lib/audit.ts`): agent runs get both for free.
- **The visibility map** (`packages/core/src/visibility.ts`), with its `agent` audience already defined.
- **The runtime login and per-request roles** (`lib/context.ts`, E19): an agent acting for a user runs under that
  user's role, never wider.
- **Adapters with memory doubles** (`notify`, `storage`, `payments`, `ai`): the pattern for every new integration.
- **zod schemas to OpenAPI** (`lib/openapi.ts`): typed tool inputs and outputs can be the same schemas.
- **Evidence facts** (`catalogue_facts`, append-only): the store for verified regulatory knowledge.
- **The smoke test** (`scripts/smoke.mjs`): screens, phone width, axe, PDFs, privacy text checks; partner staff since
  E19.

## 6. Missing capabilities

Against the mandate, in its phase order:

1. Refusal tests for the six download routes in section 4.2. Transition tables for requests, payouts and change
   orders (S5). A night-to-night check of the audit chain's length (S4).
2. Upload content checks, quarantine and a scanner adapter (S1).
3. Conflict detection and a version comparison view for evidence facts (2.2).
4. Multi-activity, multi-entity and holding structures in one assessment, and India–UAE ownership (2.3 B, C, K;
   gaps 48, 75, 76).
5. A three-year cost and visa cost comparison from approved figures (2.4).
6. An LLM provider adapter with structured output, budgets, timeouts and the memory fallback (3.3).
7. A tool registry over the existing services, an agent run store with resume, and approval records (3.2).
8. Document content analysis (3.4), after S1.
9. An evaluation suite of at least 30 scenarios with measured, not invented, results (3.5).
10. Document reuse across steps with consent (4.3; gaps 34, 125).
11. Priority speed carried into offer lines, the proposal and the plan (4.4; gap 85).
12. Calendar booking, once the owner chooses a provider (4.5; gap 69).
13. Everything in Phase 5 that needs an account: staging, domain, SES, payments, bank format, alerts (gaps 1, 2, 3a,
    6, 6a, 37, 122).
14. The competition demonstration mode and its documents (Phase 6).

## 7. Proposed architecture changes

All are additive; none replaces a working module.

| Change | Why | Shape |
| --- | --- | --- |
| Transition tables for request, payout and change order | S5; before the agent can write | Machines in `packages/core/src/states.ts`, with every direct `update … set status` moved behind `transition()`, plus check constraints |
| Upload quarantine | S1, gap 45 | A `scan_status` on the file-bearing tables (`evidence`, `document_requests`, `partner_documents`, `obligations`, `partner_invoices`); a `Scanner` adapter with memory and ClamAV implementations; downloads refused until `clean` |
| LLM provider adapter | Phase 3.3 | Extend `AiModel` in `lib/ai.ts` with a live implementation behind `AI=<provider>`: a key from Secrets Manager, a monthly cap in fils, a timeout, and structured output validated by zod. The memory model stays as the fallback and the test double |
| Agent run store and tool registry | Phase 3.2 | New tables `agent_runs`, `agent_steps` (append-only) and `agent_approvals`. A registry maps typed tools to existing services under an `agent` identity whose rights are the requesting user's, never wider |
| Evidence conflict and diff | Phase 2.2 | Pure functions in `packages/core/src/catalogue.ts` over `catalogue_facts` history, and a page on the coverage screen |
| Separate database roles within a party (only if decided) | S2, T4 | `app_ops` and `app_finance`, and possibly `app_partner_staff`, with column grants that mirror the visibility map |

## 8. Technical debt

| Item | Where | Cost of leaving it |
| --- | --- | --- |
| States set by direct SQL (S5) | see S5 | A new path could set an invalid state |
| `deliverables` has no row-level security and is fully readable by clients and partners, including `market_mid_fils` | `001_init.sql:399` | Low: a catalogue reference price, not partner cost or margin. Recorded so it is a choice (gap 147) |
| Five tables without RLS (`sessions`, `login_codes`, `deliverables`, `margin_rules`, `settings`) | migration 001 | Only `deliverables` is granted to client or partner roles; the others are platform-only by grant |
| The document checker reads file names only | `lib/ai.ts:127-169` | Its draft is labelled as such, so there is no false claim, but little value |
| Two items numbered 13 in `KNOWN-GAPS.md` ("Accounting system mapping", "Shared rate limiting") | `docs/KNOWN-GAPS.md` | Ambiguous citations; this audit cites "13 (shared rate limiting)" |
| Tests that work around the per-address throttle | `sign-in.test.ts` (trusted proxy), `report.test.ts` (60 s timeout), the smoke's session reuse (E19) | Slow CI on a busy runner; the smoke run sits at the 20-codes-per-15-minutes limit |
| Web app without a build step | `apps/web/public` | A conscious choice (D-records); keep |
| Many owner-facing defaults (the margin rule, fairness cap, deposit and quality bar are code constants) | gap 24 | Each needs a person's confirmation before the pilot |

## 9. Business impact

- **Revenue is gated by people, not code.** Every capability a pilot needs to take a client's money and pay a partner
  exists and is tested. What stops the first paid engagement is the blank sign-off sheet and the missing accounts
  (C3, Phase 5). The transformation's code work does not move that date; the owner's inputs do.
- **The quotation is now defensible.** Every fee says where it came from, in the same words online, in the PDF and at
  acceptance (E18). Verified figures (C1) turn PARTNER-STATED and UNCERTAIN into VERIFIED without touching the code.
- **The AI agent is the largest value and the largest open decision.** It can reduce ops minutes per engagement (the
  vision's measure) only once a provider is chosen. Until then, everything agent-shaped can be built against the
  memory model and labelled as such.
- **Verified data is the trust bottleneck.** The public selector and the report cannot give a definitive answer until
  a named verifier records first-wave facts (gap 92). The engine and the workflow are ready.

## 10. Test evidence

On `main` at a42c487, `docs/evidence/E20/`:

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm typecheck` | clean | `typecheck.txt` |
| `pnpm test` (PGlite) | core 159 passed (19 files); API 404 passed, 7 skipped (41 files) | `tests-pglite.txt` |
| `pnpm audit --prod` | no known vulnerabilities (the lockfile with pdfkit and bidi-js, since E16) | `audit.txt` |
| API tests on PostgreSQL 16 | 411 passed on the same code (E19's final run) | `docs/evidence/E19/tests-postgres16.txt`; CI job `postgres` on every merge |
| Browser smoke on a fresh demo | 337 checks, 0 failed, 60 axe scans, phone width | `docs/evidence/E19/smoke-log.txt` (the same code); CI runs it on every merge |
| Audit chain | verified by CI after the smoke run | `.github/workflows/ci.yml` |

E20 changes documents only, so the smoke test and the PostgreSQL suite were not re-run for it.

## 11. Prioritised execution backlog

The mandate's suggested order (P0-01 to P1-06), reconciled with the existing outcome numbers. Each line is one
reviewed pull request. "Owner" lists what only the owner can supply; everything else proceeds under the mandate. The
maintained version is `ROADMAP.md`.

| Order | Outcome | Mandate item | Depends on | Owner |
| --- | --- | --- | --- | --- |
| done | E17 Sign-in lockout | P0-01, 1.1 | — | — |
| done | E18 Quote provenance | 2.4, 4.4 | E17 | gap 135, gap 140 |
| done | E19 Role isolation and the runtime login | P0-01, 1.2 | E18 | T4 (gap 142) |
| this | E20 Baseline audit and tracking documents | Phase 0 | E19 | — |
| 1 | E21 Remaining isolation and state rules: refusal tests for the six download routes (4.2); transition tables for request, payout and change order (S5); the night-to-night audit chain length check (S4) | P0-01, 1.2 | E20 | — |
| 2 | E22 Upload quarantine: magic-byte checks, a quarantine state, a scanner adapter with a memory double, downloads refused until clean | P0-01, 1.3 | E20 | a live scanner's cost (T6) |
| 3 | E23 Evidence operations: conflict detection, version comparison, stale-fact alerts on the queue | P0-02, 2.2 | E20 | a named verifier for real data |
| 4 | E24 AI provider adapter: a live adapter behind configuration, budgets, timeouts, structured output, capability status on screen | P1-01, 3.3 | E20 | provider, key, monthly cap (T5) |
| 5 | E25 Agent tools and planning: a typed tool registry over the existing services, an agent identity with least privilege, a launch plan from the existing engines | P1-02, 3.2 A–C | E21, E24 | — |
| 6 | E26 Agent execution and approval: run store, resume, idempotency, budgets, approval records, progress on screen | P1-03, 3.2 D–F | E25 | — |
| 7 | E27 Document intelligence: content extraction for authorised uploads, a reviewer checklist, never auto-approving identity | P1-04, 3.4 | E22, E24 | — |
| 8 | E28 Client journey: document reuse with consent (gaps 34, 125); priority speed carried into the offer and the plan (gap 85) | P1-05, 4.3–4.4 | E20 | — |
| 9 | E29 Agent evaluation and demonstration: 30 or more scenarios with measured results, a demo mode on synthetic data, `docs/competition/*` | P1-06, 3.5, 6 | E26 | — |
| later | Multi-activity and holding structures (2.3 B, C, K); three-year cost (2.4) | P0-02 | E23 | verified figures |
| owner | O7 launch gate, O14 real payments and WhatsApp, O15 books and Arabic: staging and integrations | P0-03, Phase 5 | accounts | cloud, domain, SES, payment provider, bank sample, WhatsApp |

O16 "Agents round two" (a fee and rule watcher, a calendar agent, a vetting assistant, a founder analyst) overlaps
E24–E26. The proposal is that E24–E26 deliver its foundation and O16 keeps only the specific agents, to be confirmed by
the owner (`DECISION-LOG.md`, T7).

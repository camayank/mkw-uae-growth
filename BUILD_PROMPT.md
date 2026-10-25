# Tasees Master Build Prompt

18 Oct 2026 · MKW Advisors. The complete prompt for building the Tasees platform from idea to delivery: paste it
whole into a coding agent (or hand it to an engineering lead) and it carries the business, the rules, the method,
the outcome queue, the quality bar and the launch gate in one place. The live, editable version is the Claude doc
"Tasees Master Build Prompt"; keep this copy in step with it. `CLAUDE.md` is the short operational version.
Everything below the first section is the prompt itself.

## How to use this prompt

Paste everything from "Role and mission" to the end into the agent's first message, together with the product
pack (`docs/PRODUCT_SPEC.md`, `outcomes/QUEUE.yaml`, `docs/DECISIONS.md`, `docs/KNOWN-GAPS.md`). The agent then
works one outcome at a time and stops only for the items in the Ask-me list.

- Starting from zero (no code yet): run Phase 0 first; its output is the pack the rest of the prompt depends on.
- Continuing the existing build (the repository already holds O1 to O9): skip to "Current state and next prompts"
  and use the continuation prompt there; the rest of this document stays in force as the standing contract.
- Replace the bracketed values in the Ask-me list with your decisions before pasting; a bracket left in place
  means "use the suggested default and mark it UNCERTAIN".
- Keep this document as the single source of truth: when a rule changes, change it here and in `CLAUDE.md` in
  the same commit.

## Role and mission

You are the lead engineer building Tasees, by MKW Advisors: a managed marketplace for UAE business services. MKW
Advisors sells at one clear price; vetted partner firms in the MKW Advisors Partner Network deliver; MKW controls
scope, price, allocation, quality and payment. The owner is a chartered accountant, not a developer: you report
in plain business terms, show evidence for every claim, and never present an estimate, a statutory rule or a
machine's output as a fact a client can rely on.

You build to production quality, one outcome at a time, in the order of the outcome queue. You work autonomously
inside an outcome and stop only for the items in the Ask-me list. Working code and passing tests are assets:
extend them, never rewrite them opportunistically. When the specification and the code disagree, the
specification wins unless a rule that never bends says otherwise; when you must choose, record the choice in
`docs/DECISIONS.md` with the reason and how to undo it.

Success means: the platform runs in a UAE region, three partner firms and five real clients complete engagements
on it during a pilot with the on-time rate, margin and issues reported from the system's own data, and the owner
can hand it to another engineer with the documentation alone.

## The business on one page

Three parties and one loop. A client (a founder or a company) asks for UAE services: company setup, visas, bank
account, VAT and corporate tax, accounting, audit, PRO work. MKW Advisors (ops, finance, founder) scopes the
request, prices it, sends up to three offers, allocates the work and checks every step. A partner firm (admin and
staff) quotes, accepts, delivers with evidence and is paid in stages.

1. **Intake.** The client answers a short questionnaire (or arrives from the public page with recorded PDPL
   consent). The answers become a scope of catalogue codes and an advice on structure and place, each statement
   carrying its confidence.
2. **Pricing.** Partner rate cards or sealed quotes give the cost; one margin rule gives the price; government
   fees pass through at cost; VAT is 5% on fees only. Ops reviews anything below the floor or resting on an
   unverified fee.
3. **Offer and acceptance.** Three tiers (essential, standard, priority) at one clear price each, valid 14 days,
   with a branded PDF. The account owner accepts; the deposit (half the fees plus all government fees) is due by
   card link or bank transfer; a tax invoice follows every payment.
4. **Allocation.** Eligibility first (licence, agreement, emirate, capacity, regulated capability), then
   partner-sourced lock, existing relationship, the quoting partner, a 35% monthly fairness cap per service
   category with a quality bar of 60. Four working hours to accept; a missed deadline is a strike and re-routes.
   Ops may allocate by hand with a recorded reason, within the same checks.
5. **Delivery.** Milestones per code with due dates in UAE working days; the client supplies documents per step;
   the partner uploads evidence; MKW checks it; the client approves (or five working days of silence approves).
   Change orders are priced by the same margin rule and need the client's approval and payment before the
   partner starts. Late steps are watched; a step more than five working days late earns the client a credit by
   rule, borne by the partner when the delay is theirs.
6. **Money out.** Payouts 40% at kick-off, 40% at the key step, 20% at completion, only from money received,
   against the partner's own invoice, released by finance in weekly runs as a bank bulk-transfer file with
   remittance advices.
7. **After.** The client rates the work; the partner's scorecard is recomputed weekly; the client's compliance
   calendar carries the obligations the services created (renewals, returns, registers) with reminders and filing
   evidence; dashboards and the accounting export read from the same invoice and payment rows.

Money is integer fils and rates are basis points everywhere. Every state change writes a hash-chained audit
event. Clients see "Tasees, by MKW Advisors"; partners see "MKW Advisors" and never the word Tasees alone.

## Rules that never bend

These hold in every outcome, every screen, every job and every test. A pull request that weakens one is not
mergeable whatever else it adds.

1. **Privacy of money.** Clients never see partner cost, margin or payouts. Partners never see client price,
   margin or other partners' quotes. MKW ops never sees margin; finance and the founder do. Enforce in three
   layers: Postgres row-level security and column grants, the field visibility map in
   `packages/core/src/visibility.ts`, and tests that read each forbidden field as each role.
2. **One margin rule.** Price = max(cost × (1 + rate), cost + floor), rounded up to AED 50, capped at 1.25 ×
   market mid. A line below the floor goes to ops review. The same rule prices offers, change orders and
   re-allocations. Allocation never pays a partner above the cost the price was built on.
3. **Money is integer fils; rates are basis points.** No floating point touches an amount. VAT is 5% on fees;
   government fees pass through at cost, as disbursements, with no VAT.
4. **Done means evidenced.** A milestone closes only with its required evidence, MKW's check and the client's
   approval (or the tested five-working-day rule). UAE working time is Monday to Friday, 09:00 to 18:00 Gulf
   Standard Time.
5. **Uncertain is a state.** Unverified government fees, statutory rules, scoping advice, obligation dates and
   any AI or machine-translated output carry an explicit UNCERTAIN label and cannot reach a client without a
   named person's approval, recorded with a date and a source. No automatic statutory conclusions or filings,
   ever.
6. **No unattended side effects.** Nothing is sent, paid, released, filed or refunded without a person's action
   or an explicit, tested rule. AI writes drafts into a review queue; a person applies them.
7. **External services sit behind adapters** with an in-memory double: email, payments, storage, AI, WhatsApp,
   bank files, accounting. Tests never call the internet.
8. **Append-only audit.** Every state change writes a hash-chained audit event with actor, entity and data.
   Audit rows are never edited or deleted; erasure tombstones personal data elsewhere and leaves the chain valid.
9. **Personal data (UAE PDPL).** Consent at intake with version and timestamp; data stored in a UAE region;
   contact details masked between client and partner; export and erasure on request, keeping what tax law
   requires; business contact data only from public listings; no personal contact details of individuals scraped
   or stored without consent.
10. **Branding.** Clients see "Tasees, by MKW Advisors". Anything addressed to a partner comes from "MKW
    Advisors" or "MKW Advisors Partner Network" and never uses the name Tasees on its own.
11. **Dependencies.** Prefer the standard library and what the repository already uses. A new library needs an
    entry in `docs/DECISIONS.md` (why, licence, maintenance, security, how to remove it) and an exact pinned
    version.
12. **Extend, never rewrite.** Working code and passing tests are assets. Change the smallest thing that makes
    the outcome true; leave a trail a stranger can follow.

## Phase 0: from idea to specification

Do not write code until these documents exist and the owner has read them. Each is short, in plain English, and
names what is still uncertain.

- **`docs/VISION.md`**: where the product is going and why; the roadmap after O9.
- **`docs/PRODUCT_SPEC.md`**: what the product does (diagrams in `docs/img/`). One paragraph per actor (client,
  partner firm, MKW ops, MKW finance, founder) stating what they need to see and do. The service catalogue by
  category (company setup across mainland and the free zones; visas and immigration; VAT and corporate tax
  registration and returns; accounting and audit; ESR, UBO and AML; PRO and attestation; banking introductions),
  each line with scope, required documents, deliverables, evidence of completion and a rough duration. The
  lifecycle: intake → scoping → quotes → offer → acceptance and deposit → allocation → milestones with evidence →
  approval → invoice → payout → compliance calendar. The money model: partner cost, MKW fee, government fee at
  cost, VAT 5% on fees, deposit, milestone billing, guarantee credit.
- **`docs/DECISIONS.md`**: what the owner decided and what is still open. Record every number and rule the
  business depends on: margin rate and floor per category, deposit size, guarantee basis points, fairness cap on
  allocation share, auto-approval window, retention periods, holiday list, accounting system, financial year end,
  UNCERTAIN wording. Each entry has a date, the owner's decision or the default taken, and "Open for the owner"
  where none exists. Defaults keep the build moving; they never silently become policy.
- **`docs/THREAT-MODEL.md`**: who could be hurt and how. Clients overpaying because they saw nothing; partners
  undercut because they saw a rival's quote; ops editing a price; a stolen session; a replayed payment webhook; a
  wrong statutory date; a scraped contact list. Each threat names its control and the test that proves the
  control.
- **`BUILD_PROMPT.md` and `CLAUDE.md`**: how the builder works. The rules above, the outcome queue, the report
  format, the quality bar, and the "Ask me" list. Keep `CLAUDE.md` as the short operational version a fresh
  session can read in two minutes.
- **`outcomes/QUEUE.yaml` and one `outcomes/O<n>-<slug>.md` per outcome.** The queue lists outcomes in order
  with a status; only the first released outcome is worked. Each outcome file is a contract written before the
  code: business result in one paragraph, scope as numbered items, exclusions, acceptance evidence (which tests
  and which smoke checks), dependencies and owner decisions, risks, rollback. Status moves planned → released →
  in-progress → verified-pending-merge → merged.

**Exit from Phase 0.** The owner has answered or deferred every item on the Ask-me list; defaults are written
down; the first outcome contract is approved; a reviewer other than the builder has read the threat model.

## Phase 1: architecture and foundations

Build the smallest honest system, then grow it one outcome at a time. The shape below is the one that was built
and is proven by its tests; keep it unless an outcome contract says otherwise.

- **Repository.** A pnpm monorepo (Node 22, TypeScript 5.9, strict, `rewriteRelativeImportExtensions` so
  sources run under `node --experimental-strip-types` without a bundler). `packages/core` holds the pure domain:
  money, pricing, allocation, milestones, scorecards, obligations, reporting helpers, the visibility map; no I/O,
  no database, every function unit-tested. `apps/api` is a Fastify 5 server with zod validation, Postgres through
  `pg` (PGlite 0.3.15 in development, tests and CI so nothing needs installing), migrations as numbered SQL files
  applied in order, services per domain, jobs, adapters and an audit writer. `apps/web/public` is a
  dependency-free web app: vanilla ES modules, one `app.js` router, `styles.css` with logical properties,
  `intake.html` for the public form, `i18n-ar.js` for Arabic. No framework, no build step, nothing to upgrade.
- **Security in the database.** Three Postgres roles (`app_client`, `app_partner`, `app_platform`) with
  row-level security policies on every table that holds a party's data, column grants that deny `app_client` and
  `app_partner` the money columns outright, and session variables (`app.user_id`, `app.org_id`, `app.role`) set
  per transaction by `asUser()`; platform work runs through `asPlatform()`. `app_now()` reads an application
  clock so tests and jobs can move time; `gulf()` converts timestamps to Gulf Standard Time dates for anything
  that depends on a calendar day.
- **Identity and sessions.** Email magic links (no passwords), HTTP-only cookies, throttles on sign-in and
  verification, security headers (CSP, frame denial, referrer policy), one user belongs to one organisation with
  one role; MKW staff roles are ops, finance, founder.
- **Adapters.** storage (memory, local disk, S3), notifier (recording double, console, SES; locale-aware),
  payments (memory provider that records links and signed webhooks; a real provider is an owner decision), ai
  (memory model that returns canned drafts). Every adapter has the same interface and the double is what tests
  use.
- **Audit.** `audit_events(id, at, actor, entity, action, before, after, prev_hash, hash)`; the hash covers the
  row and the previous hash; `pnpm verify:audit` walks the chain and fails on a break.
- **Jobs.** One runner (`apps/api/src/jobs/run.ts`) with named jobs that are idempotent and clock-driven:
  allocation timeouts, auto approvals, offer expiry, ops digest, rules refresh, licence watch, delays and credits,
  obligation reminders, weekly scorecards. Each job is invoked by a scheduler outside the app (cron, a cloud
  scheduler); none sends money.
- **Quality tooling.** `pnpm test` (core + API, each API test on a fresh PGlite), `pnpm typecheck`,
  `scripts/smoke.mjs` (Playwright against a fresh demo: every screen, desktop 1280 px and phone 390 px
  screenshots, axe-core WCAG 2.1 A/AA, a keyboard-only path), `pnpm verify:audit`, a GitHub Actions workflow
  that runs all of it and surfaces failures as annotations.
- **Deployment.** Dockerfile, `docs/DEPLOY.md` (UAE region, managed Postgres, object storage, secrets, the
  scheduler, backups and the restore drill in `docs/RESTORE-DRILL.md`). Nothing in the app assumes a vendor.

## The outcome queue

Each outcome is a business result a person can see, not a layer of code. Build them in this order; each one
stacks on the last and ships with its own tests, smoke checks, review and documentation.

| # | Outcome | Business result when done | Key contents |
| --- | --- | --- | --- |
| O1 | Foundation and privacy | A client, a partner and MKW staff can sign in and see only what their role allows; every change is audited; a request can be created and tracked | monorepo, roles and RLS, magic links, audit chain, visibility map, service catalogue, request lifecycle, PDPL consent, export and erasure, security tests, smoke harness |
| O2 | Quotes, offers and acceptance | MKW turns partner quotes into one priced offer; the client accepts online; nothing about cost or margin leaks | quote requests to partners, one margin rule, offer builder with ops review for below-floor lines, offer expiry, acceptance with terms version, email notifications, allocation with fairness cap and timeouts |
| O3 | Money | Deposits and milestones are invoiced and paid; partners are paid after approval; finance sees everything, ops no margin | tax invoices with TRN and VAT, credit notes, card links and signed webhooks, bank transfers, payment matching, payout runs and bank file, refunds, milestone evidence and approval with the five-working-day rule |
| O4 | Catalogue and fee verification | Every priced line rests on a government fee with a source and a verifier's date, and a margin rule with an effective date | fee table with sources, UNCERTAIN until verified, monthly verification pass, margin rules by category with effective dates, offer builder reads them |
| O5 | Scoping and intake | A founder describes their situation and gets scoped advice with confidence levels, reviewed by a person before it reaches them | public intake with consent version, scoping rules with verifiers, AI draft queue behind the adapter, ops review, confidence labels |
| O6 | Partners and delivery | Partner firms are onboarded with documents and licences, scored, and held to time; clients get credits when MKW's rule says so | partner applications and document review, licence watch, scorecards 40/20/15/15/10, document requests, delay watch, guarantee credits, ratings, manual allocation, offer PDF |
| O7 | Launch gate | A pilot with three partner firms and five clients, legal, tax and security sign-offs, and a go / no-go report | checklist only; human work with evidence the platform produces |
| O8 | Reporting and compliance | The founder sees the business in numbers that match the books; every client has a compliance calendar that never files anything by itself | founder and partner dashboards by period, accounting CSV export, obligations with UNCERTAIN dates until confirmed, reminders, evidence and MKW check |
| O9 | Arabic and accessibility | Clients can use Tasees in Arabic once a reviewer signs it off; every screen passes WCAG 2.1 AA machine checks and works by keyboard | locale on the user, Arabic dictionary and templates, reviewer sign-off gate, preview accounts, RTL layout, axe-core in smoke, keyboard path |

After O9 the owner released O10 Real data and staging (`outcomes/O10-real-data-and-staging.md`). The queue then
follows `docs/VISION.md` (18 Oct 2026), one number later than the vision's table: O11 Ops command centre and event
outbox, O12 Client experience, O13 Observability and hardening before the pilot; then O7; then O14 Real payments
and WhatsApp, O15 Books and Arabic completeness, O16 Agents round two. They sit in `outcomes/QUEUE.yaml` as
`planned` until the owner releases one. The vision's "Where the build stands" section lists what each one adds.

## How to work one outcome

This is the loop. Run it exactly, every time, and do not skip a step because the change looks small.

1. **Read.** `CLAUDE.md`, `docs/DECISIONS.md`, `docs/KNOWN-GAPS.md`, the outcome contract, and the code the
   outcome touches. Note anything that contradicts the contract before writing a line.
2. **Contract first.** Complete `outcomes/O<n>-<slug>.md`: business result, numbered scope, exclusions,
   acceptance evidence, dependencies and owner decisions, risks, rollback. Set the queue status to in-progress.
3. **Branch.** `outcome/O<n>-<slug>` from the previous outcome's branch (stacked) or from `main` once that is
   merged. Never commit to `main`.
4. **Build in this order:** migration (additive, numbered) → pure domain functions in `packages/core` with unit
   tests → services in `apps/api` with the audit calls and the visibility map → routes with zod schemas → jobs →
   templates for both brands → screens in `apps/web/public` → seed data for the demo.
5. **Run.** `pnpm typecheck`, `pnpm test`, start the server against a fresh demo (`pnpm seed`), and use the thing
   in a browser or with the smoke script before calling it done.
6. **Smoke.** Extend `scripts/smoke.mjs` with the new screens and paths: numbered screenshots at 1280 px and
   390 px, axe-core on each new client or partner screen, keyboard path where a client acts. Save the log and
   screenshots under `docs/evidence/O<n>/`.
7. **Review.** Spawn a sceptical reviewer in a fresh git worktree that has not seen the build. Give it the
   contract and the diff, not your conclusions. Ask for should-fix and nit findings with reproduction. Fix every
   should-fix with a test, record the findings and fixes in the outcome file's Review section.
8. **Documents.** Update `docs/KNOWN-GAPS.md` (what is not verified or not built), `docs/DECISIONS.md` (defaults
   taken, new dependencies), `README.md` if a command changed, and the outcome file's Evidence table (claim →
   evidence path).
9. **Report** in at most 25 lines (format below), set the status to verified-pending-merge, open the pull
   request, and stop. The owner merges and releases the next outcome.

**When to stop and ask.** Only for the items on the Ask-me list or a decision that cannot be undone and could
reasonably go either way (deleting data, sending anything to a real address, changing a money rule the owner
already confirmed). Everything else: take the documented default, write it in `docs/DECISIONS.md` under "Open
for the owner", and carry on.

## The quality bar

An outcome is done when all of these are true, and not before.

- **Tests prove the rules.** Every rule that never bends has a test that tries to break it: read a forbidden
  money column as each role at the database level and through the API; pay a partner above cost; close a
  milestone without evidence; show an UNCERTAIN fee to a client; send an email with no actor; edit an audit row.
  Each test must fail if the control is removed.
- **Money reconciles.** Dashboard figures, invoices, payments and payouts come from the same rows and tests
  compare them to direct SQL. Credit notes carry negative amounts and sums run over all invoice rows.
- **Time is the application clock.** Jobs and date logic read `app_now()` and Gulf-time dates; tests move the
  clock rather than sleep. Working days exclude weekends and the holiday list.
- **Nothing leaks in text.** Tests assert that a partner's API body contains no client price, no margin and no
  other firm's name; a client's contains no cost; emails to partners never contain the word Tasees alone.
- **Both widths, both languages.** Every client and partner screen screenshotted at 1280 px and 390 px with no
  horizontal overflow; axe-core WCAG 2.1 A/AA zero violations; keyboard-only path for the client's main action.
- **The demo tells the story.** A fresh seed produces a coherent business: a client with a request, quotes, an
  offer, an engagement in flight, an invoice, a payout due, an obligation, a partner with a scorecard. Smoke runs
  against it from zero.
- **Reviewed by someone who did not build it.** Findings recorded, should-fixes fixed with tests, nits fixed or
  listed in KNOWN-GAPS.
- **Rollback is written.** Migrations additive; a feature off by default where a flag is sensible; the outcome
  file says what happens if the branch is reverted.
- **CI green on the branch.** Typecheck, tests, seed, server health, smoke, audit verification, all as
  annotations when they fail.
- **Honest about what was not verified.** Every outcome file has a "Could not verify" section: the statutory
  rules, the Arabic wording, the accountant's mapping, the real payment provider; named plainly so the owner
  knows what still needs a person.

## The Ask-me list, with the defaults in force

These are the owner's decisions. The builder stops for them only when an outcome cannot proceed without the real
value; otherwise it uses the default, marks it "default, confirm" wherever a person sees it, and records it under
"Open for the owner" in `docs/DECISIONS.md`.

| Decision | Default in the build today | Why it matters |
| --- | --- | --- |
| Margin rate and floor per category | 20% / AED 300–500 from the Offer Builder sheet; setup 20% / AED 500 | Every price; the only number clients pay for |
| Fairness cap and quality bar for allocation | 35% share, 60/100 | Spreads work; keeps weak partners out |
| Deposit | 50% of fees plus all government fees | Cash at risk before work starts |
| Service guarantee | 10% of the line's professional fee per step more than 5 working days late; who bears it is open | Client promise and partner contract |
| Auto-approval window | 5 working days after evidence and MKW check | Stops clients blocking payouts |
| Public holiday list | None loaded | Working-day arithmetic |
| Card payment provider | Memory double; webhook contract generic (Network International, Telr, Checkout.com, Stripe UAE) | Nothing real is charged until chosen |
| MKW TRN, legal name, address | Blank; invoices hold until set | Tax invoices must be valid |
| Government fees as disbursements | UNCERTAIN until the tax adviser confirms | VAT on invoices |
| Bank bulk-transfer file format | Generic CSV | Payout runs |
| Hosting provider and region | AWS me-central-1 suggested | PDPL residency |
| Sender addresses and template wording | tasees@mkwadvisors.com to clients, partners@mkwadvisors.com to partners | Brand and deliverability |
| Partner sees client name before accepting | No; emirate, zone and services only | Confidentiality |
| Retention periods | 5 years tax, documents and messages; audit indefinite; UNCERTAIN | PDPL and tax law |
| Who may erase | Founder only; ops exports | PDPL requests |
| Named fee verifier; ops may add fee rows | Ops adds, founder verifies | UNCERTAIN fees never reach clients |
| Scoping-rule verifier and AI key with cap | No key; memory model; USD 100/month suggested | Advice quality and cost |
| Consent wording on intake | 2026-10-privacy-v1, for the lawyer | PDPL |
| Ops digest time | Once per working day 08:00–10:00 GST | Exception handling |
| Accounting system and financial year end | Generic CSV; 31 December | Export mapping; corporate tax dates |
| Arabic reviewer | None; clients stay on English | Arabic launch |
| Pilot partners and clients | None | Launch gate |

When the owner answers, the builder records the decision with a date in `docs/DECISIONS.md`, changes the default
in settings or the seed, removes the "default, confirm" label, and adds or adjusts the test that pins the value.

## Launch gate and operations

**Before the pilot (O7 checklist, owner and MKW team).** Cloud account in a UAE region, domain, DNS, sender
domain with SPF and DKIM. Merchant account and the real payment adapter; TRN entered so invoices issue. Bank file
sample matched. AI key with a cap, or leave the double. Named fee and scoping-rule verifiers with the first
monthly pass recorded. Owner decisions confirmed. Lawyer: Partner Network Agreement, client terms (guarantee,
auto-approval), PDPL notice and consent text, UNCERTAIN wording. Tax adviser: disbursement treatment, invoice
and credit note layout, corporate tax rules in the calendar. Security review by someone outside the build:
threat model, `pnpm audit`, webhook signature and replay window, sessions and throttles, bucket policy, restore
drill, RLS tests read as a reviewer, secrets in deployment. Three partner firms at signed with rate cards; five
consenting clients.

**During the pilot (four to six weeks).** Every request priced on the platform, every offer sent from it, no
side deals. Ops digest read every working day; exception queue empty at close. Weekly: scorecards, delays
attributed, credits decided, payout run paid. Issues logged with a number, severity, fix commit and retest;
nothing fixed by hand in the database (the audit chain shows if it was). One PDPL export and one erasure on a
test person; one restore drill from a real backup.

**Pilot report.** On-time rate, request-to-acceptance rate, margin achieved against the rules, partner share by
category, payouts paid against invoices, credits issued; issues found, fixed and open; sign-offs from lawyer, tax
adviser, security reviewer, fee verifier and Arabic reviewer; the owner's go / no-go.

**Running it afterwards.** Jobs on a scheduler with alerts on failure; `pnpm verify:audit` nightly; backups
tested monthly; dependency audit on every pull request; fee and rule verification monthly with the verifier's
name; the KNOWN-GAPS file reviewed each release; a new outcome contract for every change that a person can see,
worked with the same loop.

## Reporting format

The 25-line report at the end of every outcome, in this order and nothing else:

```
O<n> <name> — verified-pending-merge (branch, date)
Business result: one sentence a client or the founder would recognise.
Built: 3–6 lines, each a thing a person can see or a rule a test proves.
Tests: <core> + <api> = <total> (previous: <n>); new test files named.
Smoke: <checks> OK; screenshots <first>–<last>; axe zero violations on <screens>.
Review: <should-fix count> fixed, <nit count> fixed/listed; one line on the worst finding.
Docs: KNOWN-GAPS, DECISIONS, README, outcome file updated.
Could not verify: the things only a person can confirm.
Ask me: only items that block the next outcome, with the default taken.
Next: the outcome that is now released.
```

**The pull request.** Title `O<n>: <name>`. Body: the business result, a short list of what changed, the
evidence table copied from the outcome file, the review summary, the "Could not verify" list, and the base
branch it stacks on. Pull requests end with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

<link to the Claude Code session that did the work>
```

**Commits.** Small, one intention each, present tense ("add delay attribution", "deny partners the margin
column"). Every commit ends with:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: <link to the Claude Code session that did the work>
```

The outcome file's Evidence table maps each claim to a path: test file, smoke log line, screenshot number, axe
report. A claim without a path is not a claim.

## Current state and the next prompts

**What exists (18 October 2026).** O1 to O6, O8 and O9 are built, reviewed and merged into `main`; O7 is a
prepared checklist. 199 tests (51 core, 148 API), typecheck clean, smoke 109 checks with screenshots 01–60 and
axe-core zero violations on 15 screens, audit chain verified, CI green on `main`.

**Where it is.** Repository `camayank/mkw-uae-growth` on GitHub; `main` is the Tasees platform. The UAE ASP
Selector that `main` carried before lives in `camayank/uae-asp-selector` (see `docs/DECISIONS.md`, D41). The
eight outcome pull requests (#1 to #8) were retargeted at `main` and merged in queue order O1, O2, O4, O3, O5,
O6, O8, O9 on 18 October 2026; the merged `outcome/*` and `tasees-base` branches can be deleted.

**Prompt to continue the build** (paste as the first message of a fresh session):

```
You are continuing the Tasees platform (MKW Advisors). Repository: camayank/mkw-uae-growth, branch main.
Read CLAUDE.md, BUILD_PROMPT.md, docs/VISION.md, docs/DECISIONS.md, docs/KNOWN-GAPS.md and
outcomes/QUEUE.yaml first. Work only the first released outcome in the queue. Contract first, one branch per outcome, build → run →
test → smoke → sceptical review in a fresh worktree → docs → verified-pending-merge, then a 25-line report
and stop. The rules that never bend apply to every line: privacy of money in RLS, visibility map and
tests; one margin rule; integer fils and basis points; evidence before done; UNCERTAIN until a person
approves; nothing sent, paid, released or filed without a person or a tested rule; adapters with doubles,
no internet in tests; append-only hash-chained audit; UAE PDPL; "Tasees, by MKW Advisors" to clients and
"MKW Advisors" to partners; new dependencies need a DECISIONS entry and a pinned version. Stop only for
the Ask-me list or an irreversible decision. Do not rewrite working code. Extend the smoke script and the
evidence folder for every new screen.
```

**Prompt to release the next outcome** (the owner, after merging):

```
Release O<n> <name>. Decisions: <answers to any Ask-me items, or "defaults stand">. Base branch: main.
Report in 25 lines when verified-pending-merge.
```

**Prompt for the pilot** (when the O7 checklist starts):

```
We are entering the O7 launch gate. Prepare the staging deployment per docs/DEPLOY.md for <provider,
region>, implement the payment adapter for <provider> against its sandbox behind the existing interface
with the memory double kept for tests, load the holiday list and the TRN from settings, and produce the
pilot evidence pack described in outcomes/O7-launch-gate.md. Nothing goes to a real client, partner or
bank account without my written go.
```

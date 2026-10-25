# O7 Launch gate

Status: in-progress (released by the owner 25 Oct 2026, after O13). The build's part is done on branch
`outcome/O7-launch-gate`: the dependency audit with its fixes, the reviewer's security brief, and this checklist
brought up to date with O10–O13. The rest is the owner's and the MKW team's work, listed below; nothing more can be
built or deployed without it.

## Business result

MKW Advisors runs a pilot with three partner firms and five real clients on the platform as built in
O1–O9, with legal and tax sign-off and a security review behind it, and leaves the pilot with a report:
on-time rate, margin, issues found and fixed, and a go / no-go for launch.

## What the build already provides for the gate

| Gate item | Where it is | Evidence to collect during the pilot |
| --- | --- | --- |
| Staging deployment in a UAE region | `docs/DEPLOY.md`, `Dockerfile`, `.github/workflows/ci.yml` | Staging URL; `pnpm verify:audit` output; restore drill log (`docs/RESTORE-DRILL.md`) |
| Partner onboarding end to end | O6: application, documents, MKW review, pilot, signed; licence watch | Three firms at `signed` with verified licence, insurance, agreement |
| Real emails | O2: SES transport, delivery log, Arabic templates after sign-off (O9) | Delivery log with zero failures over the pilot; SPF/DKIM pass on the sender domain |
| Payments and invoices | O3: card links + signed webhook, bank transfers, tax invoices with TRN, credit notes, payout runs, bank file | One card payment and one bank transfer end to end; accountant's check of a tax invoice and a credit note; one payout run paid from the bank file |
| Pricing and offers | O4: catalogue, fee table with sources and verification, margin rules with effective dates; O6 offer PDF | Ten sample requests priced and compared with the Offer Builder sheet; fee verifier's sign-off dates on the rows used |
| Scoping | O5: advice with confidence, ops review, AI draft queue, public intake with consent | Twenty founder cases scored by a qualified person; rules verified by name and date |
| Delivery | O6: document requests, delay watch, guarantee credits, ratings, manual allocation | One deliberately late step: delay noticed, client told, credit computed, finance decision, payout reduced |
| Reporting | O8: founder dashboard, accounting export, compliance calendar | Dashboard figures reconciled with the bank statement and the accountant's books for the pilot month |
| Privacy and security | O1: RLS and column grants, hash-chained audit, PDPL export/erasure, sign-in throttles, security headers; `security.test.ts` | Security review report (see below); one export and one erasure exercised on a test person |
| Accessibility and Arabic | O9: axe-core report, keyboard path, Arabic gated on the reviewer | `docs/evidence/O9/axe.json`; reviewer's sign-off recorded on Settings |

## Added since this checklist was written (O10–O13 and the O7 preparation)

| Gate item | Where it is |
| --- | --- |
| Staging as code in me-central-1 (VPC, RDS PostgreSQL 16, private encrypted buckets, Fargate behind HTTPS, scheduled jobs, alarms, secrets in Secrets Manager) and a demo stack | `infra/`, `docs/DEPLOY.md` (staging runbook) |
| Go-live data importers (partners, rate cards, fees, holidays, owner decisions, company details, legal texts), dry run first | O10, `docs/DEPLOY.md` (Go-live data) |
| Ops command centre and event outbox: nothing sent twice, nothing lost, doubtful deliveries go to a person | O11 |
| Client experience: next action, timeline, proposal, conversational intake, checked uploads | O12 |
| Nothing fails silently: configuration checked at start, structured logs, job runs and alerts, the System page, nightly audit check, idempotency keys, row locks with race tests on PostgreSQL, a load test, an OpenAPI contract | O13, `docs/evidence/O13/` |
| Dependency audit: Fastify, csv-parse and fast-uri patched; zod bounded by body caps; development tools assessed | D70, `docs/SECURITY-BRIEF.md` |
| A brief for the outside security reviewer: what the platform holds, its defences and where to look, what to try | `docs/SECURITY-BRIEF.md` |

## What is waiting on the owner, in order

1. **AWS account** in me-central-1 with credentials for the deployer, the **domain and DNS**, and an ACM certificate.
   Then: `cdk deploy TaseesStaging` (the runbook in `docs/DEPLOY.md`), shown to the owner before anything runs.
2. **SES**: verify the sender domain (SPF, DKIM), leave the sandbox, set `EMAIL=ses`.
3. **Alert address** (`ALERT_EMAIL` and the stack's `alarmEmail`).
4. **The go-live workbook and owner decisions** for the importers: dry run shown to the owner before `--apply`.
5. **Lawyer**: client terms, Partner Network Agreement, privacy notice and consent text (recorded on Settings).
6. **Tax adviser**: VAT on government fees, invoice and credit note layout; company TRN on Settings.
7. **Merchant account** for card payments (the adapter is then built against its sandbox, O14) or bank transfer only.
8. **Outside security reviewer**, with `docs/SECURITY-BRIEF.md`.
9. **Pilot partners and clients**, and the Arabic reviewer if Arabic launches.

## Checklist (owner and MKW team)

### Before the pilot

- [ ] Cloud account in a UAE region, domain, DNS and the email sender domain (SPF, DKIM) — O1/O2 asks.
- [ ] Merchant account for card payments; the provider adapter is implemented against it (O3); VAT TRN
      entered on Settings so invoices issue rather than hold.
- [ ] Bank bulk-transfer sample file matched against `scripts`' payout CSV (O3).
- [ ] AI API key with a monthly cap (O5), or leave the in-memory double and no AI drafts.
- [ ] Named fee verifier and scoping-rule verifier; first monthly verification pass recorded (O4/O5).
- [ ] Owner decisions confirmed in `docs/DECISIONS.md` ("Open for the owner"): margin rates and floors,
      deposit size, guarantee figure, fairness cap, retention periods, accounting system, holiday list.
- [ ] Lawyer: Partner Network Agreement, client terms (including the service guarantee and auto-approval
      after five working days), PDPL privacy notice and the consent text on the public intake page
      (`intake.html`, version `2026-10-privacy-v1`), the UNCERTAIN wording clients see.
- [ ] Tax adviser: VAT treatment of government fees as disbursements (`settings.company.govFeesAsDisbursements`
      is UNCERTAIN until confirmed), invoice and credit note layout, corporate tax obligations in the
      calendar rules.
- [x] Dependency audit (`pnpm audit`): production dependencies patched or bounded (D70).
- [ ] Security review by someone outside the build (brief: `docs/SECURITY-BRIEF.md`): threat model, the
      webhook signature and replay window, session and throttle settings, storage bucket policy, backup
      restore drill, RLS tests (`apps/api/test/security.test.ts`) read as a reviewer, secrets handling in
      the deployment.
- [ ] Three partner firms onboarded to `signed` through the platform, with rate cards entered.
- [ ] Five clients consented to the pilot and told what the platform records.

### During the pilot (four to six weeks)

- [ ] Every request priced on the platform; every offer sent from it; no side deals.
- [ ] Ops digest read every working day; exception queue empty at end of day.
- [ ] Weekly: scorecards recomputed, delays attributed, credits decided, payout run paid.
- [ ] Issues logged with a number, severity, fix commit and retest; nothing fixed by hand in the database
      (the audit chain shows if it was).
- [ ] One PDPL export and one erasure exercised on a test person; one restore drill from a real backup.

### Pilot report (leaves the gate)

- On-time rate (dashboard), request-to-acceptance rate, margin achieved versus the rules, partner share by
  category, payouts paid versus invoices, credits issued.
- Issues found, fixed and open, with the owner's go / no-go.
- Sign-offs: lawyer, tax adviser, security reviewer, fee verifier, Arabic reviewer (if Arabic launches).

## Exclusions

Nothing in O7 is built by the platform; the gate is a human decision with evidence the platform produces.

## Risks

- Skipping the security review because the tests are green: tests prove the rules as written; a reviewer
  looks for the rules nobody wrote.
- Pilot partners paid outside the platform: the dashboard and the books then disagree, and the fairness
  cap and scorecards are wrong from day one.

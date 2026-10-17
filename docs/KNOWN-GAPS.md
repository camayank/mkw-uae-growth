# Known gaps

What this starter does not do yet, most important first. "Built" below means working, tested and exercised
in a browser; everything listed here is not.

## Before the first real client

1. **Email account.** The SES transport, the eleven English templates, the delivery log and the in-app bell
   are built (O2); real delivery waits for the SES account, the SPF/DKIM/DMARC records on mkwadvisors.com and
   the two verified sender addresses. Until `EMAIL=ses`, messages are recorded and printed, not emailed.
2. **Payment provider.** `/api/webhooks/payments` accepts a shared-secret call marking a payment paid. Wire it
   to the chosen provider's signed webhook (verify their signature, not only the shared secret) and create
   payment links on acceptance. Finance can record bank transfers by hand today.
3. **Tax invoices.** No VAT tax invoice PDFs yet. MKW Advisors needs FTA-compliant tax invoices for every
   payment (TRN, sequential number, VAT breakdown). Generate them from `payments` and store them as evidence.
4. **Verified fee and rule data.** Government fees and market mids in `seed-data.ts` are working estimates
   from the Service Catalogue. Scope rules in `packages/core/src/scope.ts` are simplified. A qualified person
   must verify both; uncertain results must be shown as uncertain to ops, never as fact.
5. **Partner onboarding beyond creation.** The People page creates a partner firm and its first admin, and the
   Partners page pauses, resumes and edits profile fields, but the licence and agreement checks are still boxes
   ops ticks by hand; the onboarding flow with documents and licence expiry watch is O6.
6. **Object storage in a real bucket.** The S3 adapter is tested against AWS's published signature vectors and a
   loopback fake bucket; it has not yet touched a real bucket in a UAE region. Do that in staging, with one
   upload and one download of a real evidence file, before the first client file.
6a. **Staging deployment.** The compiled build, image and CI exist; nothing is deployed because no cloud account
   exists yet. The container image build is exercised only by CI (`image` job), not yet by a run of that job.

## Soon after

7. **Lead page → platform.** The public Tasees lead page and the Sheet capture leads today; ops creates the
   request here. Add a public intake endpoint with consent capture and spam protection.
8. **Fairness share by category.** The cap uses each partner's share of all jobs this month; the rule in the
   partner agreement is per category.
9. **Partner scorecard.** Quality, on-time delivery and SLA strikes are stored on the partner profile but not
   yet recomputed from delivery history.
10. **Arabic and right-to-left layout** for client screens.
11. **WhatsApp notifications** (via the WhatsApp Business API) alongside email. The notifier records a
    `whatsapp` channel as `skipped` today.
12. **Accounting export** of payments, payouts and VAT to the accounting system.
13. **Shared rate limiting.** Sign-in limits are per process; use the proxy or a shared store with more than
    one instance.
14. **Erasure residue.** A PDPL erasure tombstones the person's name, email and messages and ends their access,
    but free text they typed into fields without an author column stays (milestone dispute reasons, allocation
    decline reasons, change-order descriptions, evidence file names), and audit payloads keep what was recorded
    at the time (a name in `partner.created`, a reason in a decline). Backups taken before the erasure keep the
    pre-erasure copy until they age out (35 days locally; the bucket's lifecycle rule in the cloud). Decide with
    the lawyer whether those fields need tombstoning too; if so, add author columns first.
15. **Automatic deletion at the end of a retention period.** Periods are recorded and confirmable on the
    Settings page; nothing is deleted on their basis yet. Needs confirmed periods and a rule for what counts as
    the start of each period.
16. **Template wording approval.** The English wording in `templates.ts` needs the owner's sign-off before
    launch; Arabic versions are O9.
17a. **UAE public holidays are not loaded.** `UAE_CALENDAR.holidays` is empty, so SLA clocks and the ops digest
    treat Eid and National Day as working days until the dates are entered each year (moon-sighting holidays
    are confirmed late). Add a settings entry and a founder screen for them.
17. **Row-level security tests run on PGlite in CI.** They also pass on PostgreSQL 16 locally
    (`TEST_DATABASE_URL`); CI should add a Postgres service so that run is repeated on every pull request.

## Verified so far

- 40 domain tests (`packages/core`) and 73 API tests (`apps/api`), all passing on PGlite and on PostgreSQL 16;
  typecheck clean; `pnpm build` compiles and the compiled server runs in production mode from a fresh database.
- O1: partner creation, invitations, role changes and deactivation (sessions revoked, codes refused) are tested as
  every role; PDPL export contains one person's data and no audit payloads (a test reproduces the leak that the
  review found and shows it closed); erasure keeps payments, payouts and every audit row byte-for-byte and the
  recomputed chain verifies; a tampered audit row is detected; the S3 adapter reproduces both AWS SigV4 test
  vectors and round-trips through a loopback fake bucket; the restore drill passed on Postgres 16
  (`docs/RESTORE-DRILL.md`); the browser smoke test drives the new People and Settings screens and now fails
  the run on any of its 13 role-separation and layout checks (`docs/evidence/O1/`).
- O2: every template renders under all three audiences with the right branding; a flow records offer, deposit,
  allocation, change-order and QA notices with sender, audience and provider result; each person's bell holds
  only their rows (database-enforced); a provider failure is recorded and never blocks the action; the digest
  fires once per working morning and not on Friday evening or Saturday; the SES transport is verified against a
  loopback fake that recomputes the signature (`docs/evidence/O2/`, 21 smoke checks).
- `pricing.test.ts` reproduces the Google Sheet Offer Builder example exactly.
- `security.test.ts` shows Postgres refusing margin and partner-cost columns to clients, client price to partners,
  and other organisations' rows; sign-in throttling; security headers.
- A browser run (Chromium) drove one engagement end to end through the web app as client, ops, finance and three
  partners, with no page errors under the content security policy; the client page showed no partner cost,
  margin, phone number or email, and the mobile layout had no horizontal scroll.

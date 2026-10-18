# Known gaps

What this starter does not do yet, most important first. "Built" below means working, tested and exercised
in a browser; everything listed here is not.

## Before the first real client

1. **Email account.** The SES transport, the eleven English templates, the delivery log and the in-app bell
   are built (O2); real delivery waits for the SES account, the SPF/DKIM/DMARC records on mkwadvisors.com and
   the two verified sender addresses. Until `EMAIL=ses`, messages are recorded and printed, not emailed.
2. **Payment provider account.** Payment links, the signed webhook contract (HMAC over timestamp and raw body,
   five-minute window, amount must match) and the client "pay by card" flow exist (O3) behind the `memory`
   provider, whose links lead to a page that says card payments are not live yet. The adapter for the chosen
   provider (Network International, Telr, Checkout.com or Stripe UAE) is written once the merchant account
   exists; their signature scheme replaces the generic one in `lib/payments.ts`.
3. **Invoices wait for MKW's TRN and the tax adviser.** Tax invoices and credit notes are issued, numbered
   gap-free and rendered as PDFs (O3), but they are held as `pending_trn` until the founder enters the TRN on
   the Settings page. Government fees are shown as disbursements with no VAT; that treatment is UNCERTAIN until
   the tax adviser confirms it (checkbox on the Settings page). Partial refunds, invoice re-issue and
   e-invoicing are not built; the invoice PDF is plain text (Courier) and Latin script only until O9.
3b. **Invoice PDF is Latin-script only.** Client legal names in Arabic render as "?" until O9 replaces the
   text writer with one that embeds a font; the FTA requires the recipient's name on a tax invoice.
3a. **Bank bulk-transfer format.** The payout run exports a generic CSV (beneficiary, IBAN, bank, amount,
   reference). Replace the columns with the bank's own template when the sample file arrives.
4. **Verified fee and rule data.** The 83-service catalogue, the government fee table (source, verifier, date,
   90-day staleness) and the rules admin exist (O4). The data in them is still a working estimate: market mids
   are the Sheet's Oct 2026 mid-points, the fee table starts empty (partners' stated fees are used and every
   such line says so), and the five new margin categories carry default rules marked "default, confirm". A
   named qualified person must enter and verify fees before real clients are quoted; pricing stops any line on
   an UNCERTAIN or stale fee for ops.
5. **Partner onboarding beyond creation.** The People page creates a partner firm and its first admin, and the
   Partners page pauses, resumes and edits profile fields, but the licence and agreement checks are still boxes
   ops ticks by hand; the onboarding flow with documents and licence expiry watch is O6.
6. **Object storage in a real bucket.** The S3 adapter is tested against AWS's published signature vectors and a
   loopback fake bucket; it has not yet touched a real bucket in a UAE region. Do that in staging, with one
   upload and one download of a real evidence file, before the first client file.
6a. **Staging deployment.** The compiled build, image and CI exist; nothing is deployed because no cloud account
   exists yet. The container image build is exercised only by CI (`image` job), not yet by a run of that job.

## Soon after

7. **Scoping rules and zone data are working estimates.** The advice engine, rule confidence, zone table,
   ops approval, AI draft queue and public intake exist (O5). Every rule and zone starts UNCERTAIN and the
   advice says so to the client until the founder records a named person's verification with a source. The
   AI model is the deterministic in-memory double until an API key and spend cap exist; the Claude adapter is
   written against the same interface. The pack's lead page (`03-lead-page`) should post to
   `/api/public/intake` as `intake.html` does; WhatsApp capture waits for the Business number.
8. **E-signature and public holidays.** The Partner Network Agreement is uploaded signed and verified by MKW
   (O6); e-signature waits for the provider. The UAE working-time clock has no public holidays until the owner
   supplies the year's list (`UAE_CALENDAR.holidays`), so a delay noticed over a holiday counts those days.
9. **Guarantee settlement after the balance is paid.** When the balance was already paid, an approved credit
   is `approved` for finance to refund by card or transfer and record the reference; a partial card refund
   through the provider waits for the provider.
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
17b. **`deliverables.active` is not editable yet.** The column exists and inactive codes are hidden, but no
    screen switches a code off; do it by SQL until the catalogue screen gets the control.
17a. **UAE public holidays are not loaded.** `UAE_CALENDAR.holidays` is empty, so SLA clocks and the ops digest
    treat Eid and National Day as working days until the dates are entered each year (moon-sighting holidays
    are confirmed late). Add a settings entry and a founder screen for them.
17. **Row-level security tests run on PGlite in CI.** They also pass on PostgreSQL 16 locally
    (`TEST_DATABASE_URL`); CI should add a Postgres service so that run is repeated on every pull request.

## Verified so far

- 45 domain tests (`packages/core`) and 141 API tests (`apps/api`), all passing on PGlite and on PostgreSQL 16;
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
- O4: 82 codes cover the 83 Service Catalogue rows and every code has a rule and evidence types; fee lookup by
  emirate and zone (zone beats emirate); UNCERTAIN and stale fees send the line to review with the reason and a
  verified one clears it; a scheduled rule applies only from its date, earlier offers keep their figures and
  `rules_as_of`; founder-only writes, database denies rules and fees to clients and partners; ten sample
  requests (30+ lines, new and old codes, agent and reseller) reproduce the margin rule to the fils, and the
  Sheet's OF-0001 totals are reproduced (`docs/evidence/O4/`, 29 smoke checks).
- O3: payment link on acceptance; unsigned, mis-signed, stale, tampered and short-paid webhooks refused and
  audited, a good one idempotent; invoices held without a TRN and issued in sequence after it, lines add up to
  the payment, PDF well-formed and downloadable by the client only; refund → credit note, payouts withheld,
  statement balances; partner invoice must match the payout and only its partner may upload; payout run total
  equals the bank file total, one line per partner, marking paid releases and sends remittances without the
  name Tasees; ops locked out of runs, files and refunds (`docs/evidence/O3/`, 43 smoke checks).
- O5: 20 founder cases give the expected structure, places, licences and obligations, each exactly as confident
  as its rule; advice is held for ops review and the client sees nothing until approval, then sees confidence
  labels; recomputing after a rule is verified puts it back under review; founder-only verification with name
  and source; AI drafts change nothing until approved and never after pricing; public intake refuses without
  consent, swallows bots, records consent with version and timestamp, is rate-limited; search is staff-only
  a repeat email is held for ops rather than attached; the client role cannot read unapproved advice at the
  database; changing the structure at approval ranks places again (`docs/evidence/O5/`, 56 smoke checks).
- O6: onboarding gates (pilot needs a verified unexpired licence; signed needs the agreement and insurance);
  documents and scorecards invisible to other firms and to clients at the API and the database; licence
  warning once at 30 days, pause on expiry, pause lifted by a verified renewal; staff scoped to the firm;
  client document checklist on acceptance, partner extras, received/ask-again with masked notes, files to the
  parties only; delay noticed once with both sides told, ops attribution hidden from the parties; credit by
  rule after five working days at the step's share of the fee, finance-only decision, balance reduced and
  partner-borne delay reduces the completion payout, all audited; rating once by the owner, masked for the
  partner, feeding the scorecard; month share per category; manual allocation refused for ineligible or
  over-cost partners and audited with the engine's own choice; offer PDF names no partner
  (`docs/evidence/O6/`, 68 smoke checks).
- `pricing.test.ts` reproduces the Google Sheet Offer Builder example exactly.
- `security.test.ts` shows Postgres refusing margin and partner-cost columns to clients, client price to partners,
  and other organisations' rows; sign-in throttling; security headers.
- A browser run (Chromium) drove one engagement end to end through the web app as client, ops, finance and three
  partners, with no page errors under the content security policy; the client page showed no partner cost,
  margin, phone number or email, and the mobile layout had no horizontal scroll.

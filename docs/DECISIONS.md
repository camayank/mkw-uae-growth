# Decisions

## Made in this codebase

**D1. MKW Advisors is the merchant of record for reseller services.** The client contracts with and pays
MKW Advisors; partners are subcontractors paid their own cost. This keeps one price and one invoice for the
client and makes margin a commercial matter, not a disclosed commission. Regulated services (FTA tax agency,
statutory audit, liquidation) use the **agent model**: the licensed firm is the provider and MKW's
coordination fee is shown separately, because those services cannot be resold.

**D2. Integer fils and basis points everywhere.** No floating point in money. Rounding happens once, at the
end of each rule, and splits use the largest-remainder method so parts always add up to the whole.

**D3. Postgres enforces who sees what, not only the application.** Row-level security and column grants per
role mean a bug in a query cannot leak margin to a client or the client price to a partner. Writes go through
server-side commands that authorise in code first, then run as the platform role.

**D4. One price rule.** `max(cost × (1 + rate), cost + floor)`, rounded up to AED 50, capped at
1.25 × market mid; a line whose cap would cut margin below the floor goes to ops review. The same rule prices
change orders. Rates and floors per category live in the database (seeded from the Sheet).

**D5. Allocation protects margin before it spreads work.** The fairness cap (35% of a month's jobs) only
re-routes to a partner who passes every hard check *and* whose own cost is no higher than the cost the client's
price was built on. This was added after the browser smoke test showed a re-route to a dearer partner producing
a negative margin line; `exceptions.test.ts` now fails if it comes back.

**D6. Milestones close only on evidence.** A step moves `evidence submitted → MKW check → client approval`.
"Done" without the required evidence types is refused. Clients who do not respond are auto-approved after 5
working days, which is in the client terms.

**D7. Partners are paid from money received.** 40/40/20 staged payouts become eligible on milestones and on the
client's payment; only finance or the founder can release them.

**D8. Append-only audit chain.** Every state change writes an event hashed with the previous event's hash. The
audit screen checks the chain.

**D9. No build step for the web app.** Plain ES modules served by the API keep the starter easy to run and
audit. Move to a framework when the screens outgrow this, keeping the API unchanged.

**D10. Application clock.** Database timestamps use `app_now()`, which follows the server's clock (or a test
clock) so SLA rules and stored times agree. Sessions and sign-in codes use real database time.

**D11. Passwordless sign-in.** Six-digit email codes, hashed, 10-minute life, 5 attempts per code, 5 codes per
account per hour, per-IP limits on the endpoints. Sessions are 14-day HttpOnly cookies.

**D12. Compiled build, one condition.** Production runs `tsc` output under plain Node 22. TypeScript was raised
from 5.6.3 to 5.9.3 (pinned) for `rewriteRelativeImportExtensions`, which emits the sources' `.ts` imports as
`.js` without rewriting a single source file, so development, tests and the seed script keep running the
TypeScript directly. `@tasees/core` exports its compiled output under the `production` condition and its sources
by default; `node --conditions=production` is set by every production script and the Dockerfile. To remove:
delete the `tsconfig.build.json` files, the `build` scripts and the `exports` condition, and run `tsx` again.

**D13. S3 signing written in-house, no SDK.** The object storage adapter signs requests with AWS Signature
Version 4 using `node:crypto` and the global `fetch` (about 120 lines) instead of adding the AWS SDK (hundreds
of transitive packages, each a supply-chain exposure for the one process that holds client documents). The
algorithm is checked against AWS's two published S3 test vectors and against a loopback fake bucket that
recomputes the signature from what it receives; a real bucket must still be exercised in staging. To remove:
replace `s3Storage()` with an SDK-backed `Storage` and delete the signing functions.

**D14. Playwright 1.49.1 as a pinned development dependency** (Apache-2.0, maintained by Microsoft) for the
browser smoke test that CI runs against the compiled build. It is never installed in the production image
(`pnpm install --prod`). To remove: delete it from the root `package.json` and the smoke step from CI.

**D15. Erasure tombstones; it never deletes.** A PDPL erasure replaces the person's name, email and the text of
messages they wrote, deletes their sessions and codes, and deactivates the account. Every foreign key still
resolves, payments and payouts keep their amounts, and audit rows are untouched because each hash covers the one
before it. What a person wrote into other fields (a dispute reason, a decline reason, a change-order description,
an evidence file name) stays, because those rows have no author column and are part of the engagement record;
KNOWN-GAPS lists this. Only the founder may erase, and never their own account.

**D16. Audit functions pin their time zone.** The hash covers the event time as text, so `audit_append` and
`audit_verify` run with `timezone = UTC` and `datestyle = ISO, MDY` set on the function itself. The formula is
unchanged; events written before this setting (all under UTC sessions) still verify.

**D17. Notifications go out after the transaction commits.** Inviting a person records the account and audit
event in one transaction and sends the invitation only once that has committed, so a rolled-back change never
produces an email.

**D18. Messages are records first, emails second.** Every notice is written to the `notifications` table with
its audience, wording and delivery result before any email leaves, and rows addressed to a known user are
that user's in-app bell. Email is best-effort; the table is the record of truth, and the delivery log on the
Settings page is how MKW answers "did they get it?". Sign-in codes are email-only.

**D19. Notifications leave after the transaction commits.** `asPlatform`/`asUser` open an async scope; a
`send()` inside it is held and released only after `db.transaction` returns, so a rolled-back change never
produces an email (tested), and a slow provider never holds a database transaction open. The cron job path
uses the same recording notifier and flushes at the end. A provider failure marks the row `failed` and is
never thrown into business code. Sign-in codes are recorded as "sent" with no wording and no variables, so
the delivery log can never be used to sign in as someone else.

**D20. Amazon SES through its HTTPS API, signed in-house.** Same reasoning as D13: the SigV4 code already
exists and is tested; one more SDK is one more supply chain. `EMAIL=console` keeps everything in the log for
development and for any environment without a verified sender.

**D21. Wording by audience, no free text.** Each template exists once with typed variables; the audience
(client, partner, staff) decides the sender name and sign-off. A QA note, a decline reason or a change-order
description is read on the engagement page and never placed in a message. The one typed value that does
appear is an organisation's own name in its invitation (`user_invited`), entered by MKW staff.

**D22. Rules are versioned by effective date; offers remember the date.** `margin_rule_versions` keeps every
rate and floor with the day it took effect; pricing loads the version in force on the build date and stamps
`offers.rules_as_of`. A change can only be scheduled for tomorrow or later and a version that has been in force
is never edited, so a date on an offer always resolves to the rule it was priced under and no offer is re-priced
by a later decision. Change orders use the rule as of the engagement's offer, so one engagement carries one set
of economics. `margin_rules` stays as a cache of today's rule, refreshed by the jobs sweep (nothing reads it yet).

**D22a. Margin policy is finance's and the founder's, not ops'.** Ops already sees partner cost and client price
on lines (as the visibility map has always allowed) but the rates and floors themselves, and their history, are
shown only to finance and the founder. Ops maintains the fee table (adds rows, which start UNCERTAIN) and
nothing else on the Rules page.

**D22b. Publishing is an evidenced approval.** An offer with a line flagged for review (margin below the floor
after the cap, UNCERTAIN or stale fee) cannot be published unless the person acknowledges the flagged lines; the
`offer.published` audit event lists each acknowledged line with its reason and figures.

**D23. Government fees come from MKW's table, or say that they do not.** A fee row has a source link, who
verified it and when; it is UNCERTAIN until a named person verifies it and stale 90 days after. Pricing uses
the most specific row for the request's place (free zone over emirate), sends a line on an UNCERTAIN or stale
fee to ops review with the reason, and when there is no row at all uses the partner's stated fee and labels
the line, so gaps in the table are visible on every offer rather than hidden.

**D24. One code per Service Catalogue row, agent model for the regulated ones.** The 20 starter codes are
unchanged; 62 were added with the Sheet row recorded on each. Agent model (licensed firm contracts the client,
MKW fee disclosed) is used for FTA tax agency and representation, statutory, approved and RERA audits,
liquidation, regulatory licensing, litigation and notary work.

**D25. Money is recorded by a person or by a signed provider message, nothing else.** Finance marks a bank
transfer received; the card provider's webhook is accepted only with a valid HMAC over the timestamp and the raw
body, within five minutes, for the exact amount; every refusal is audited. The webhook is idempotent on the
payment's status, so a replay pays nothing twice.

**D26. One tax invoice per payment, numbered when issued, never without a TRN.** Numbers come from a per-year
counter row locked in the issuing transaction (`TI-2026-000001`, `CN-...`), so they are sequential and gap-free
across engagements. If MKW's TRN is not yet in settings the invoice is held and the founder issues the held
batch after entering it; a held document never reaches a client. Government fees appear as disbursements at
cost with no VAT, marked UNCERTAIN until the tax adviser confirms. PDFs are written by a small in-house writer
(no dependency), stored through the storage adapter, and served only to the client that owns them (row-level
security) and to MKW.

**D27. A payout is paid against the partner's invoice, in a weekly run.** A partner admin uploads its invoice
for the exact payout amount (its own VAT on top); without it, and without bank details, a payout is not
payable. Finance batches payable payouts into one run, exports one bank file (one line per partner, amounts
summed), and marks the run paid with the bank's reference; that single person's action releases the payouts,
audits each, and sends remittance advices. A single release outside a run still needs the invoice.

**D27a. A run is paid only if it is still whole.** Export and "mark paid" both re-check that every payout in
the run is still eligible and that the amounts still add up to the run's total; a refund is refused while any
payout of that engagement sits in an open or exported run. Cancelling an exported run requires finance to state
that the bank file was never submitted. A partner's VAT on its invoice is 0 or exactly 5% of the payout, so the
bank transfer can never exceed the priced cost plus statutory VAT. Bank files strip leading formula characters
and partner-typed names may not start with them. Finance and the founder alone see partner IBANs; ops sees
profiles without them, partner staff see no bank details.

**D28. A refund withholds what has not been paid out.** A full refund (the only kind built) marks the payment
refunded, issues a credit note and sets the engagement's unreleased payouts to withheld; it is refused once a
payout has been released, so the money leak "client refunded, partner paid" cannot happen without finance
first settling the partner side by hand.

**D29. Advice is never more certain than its rule.** The engine is pure and takes the rules and zones with
their confidence from the database; every statement it returns carries the confidence of the rule it came
from (`verified`, `rule_of_thumb`, `UNCERTAIN`). A verified rule is one a named person has signed off with a
source and date, recorded by the founder. Nothing in the engine files, registers or concludes anything
statutory; it recommends, and a person at MKW handles every registration.

**D30. Ops approves what a client reads.** Advice is stored on the request as `pending_review`; the client sees
nothing until ops approves it, choosing which statements and places to show (removed, never reworded) and
which structure to recommend. The approval is audited with exactly what was left out. Recomputing after a rule
changes puts the advice back under review.

**D31. The model writes drafts, a person applies them.** `AiModel` has one method, `draftScope`; its output
lands in `ai_drafts` as UNCERTAIN; ops approves (which sets the request's scope from the ticked lines, only
while the request is unpriced) or discards. The in-memory model is keyword rules, so tests never call the
internet; the Claude adapter will implement the same interface behind an API key and a monthly cap.

**D32. Public intake records consent and tells nobody anything.** The lead page posts to one endpoint that
requires an explicit consent flag (stored with timestamp, version and channel), silently accepts a filled
honeypot, is rate-limited per IP, and answers `{ok:true}` whatever the email. A submission for an email that
already has an account (client, partner or staff, any status) is never attached to that account: it is held
in `intake_leads` for ops, nothing is written or audited as the account holder, their consent record is left
alone, and the only email is a neutral "sign in to continue" with none of the submitted text. The client role
cannot read `requests.advice` at the database; approved advice comes through `app_approved_advice()`.

**D33. Onboarding moves are MKW's, gated by verified documents.** The partner describes itself and uploads
documents; only ops or the founder move a firm between states, with a note sent to the firm, and the gates
are checked from verified documents, not from the application form: pilot needs a verified unexpired trade
licence, signed needs the verified agreement and insurance too. The licence watch runs daily: one warning at
30 days, automatic pause on expiry (work in hand continues, nothing new is offered), reactivation only
through a verified renewal.

**D34. The scorecard is computed from what happened, weekly, and kept.** Quality = on-time 40 + first-pass QA
20 + disputes 15 + acceptance strikes 15 + client rating 10 over the last 90 days (`scorecard.ts`). A partner
with no history keeps the neutral 60 so probation, not the score, limits it. Every computation is a row the
partner can read for its own firm, so a score is always explainable.

**D35. The guarantee is computed by rule and moved by finance.** A step past due is a delay the day after;
the client is told the new expected date (five working days on) and the partner is chased. Past that date a
credit row exists by rule: `guarantee_bp` (owner decision, 10% by default) of the step's equal share of its
line's professional fee, government fees excluded. Finance approves (deducted from an unpaid balance, else
refunded and the reference recorded) or waives with a reason; ops's attribution decides whether the partner's
completion payout is reduced by the same amount, never below zero. Nothing moves without finance's action.

**D36. Manual allocation is an override, not an exception to the rules.** Ops may offer lines to a named
partner with a reason; eligibility and the priced-cost check still apply, and the audit event records which
partner the engine would have chosen and the partner's month share in that category. Fairness is measured
per service category (`deliverables.category`), as the partner agreement states.

**D37. One set of rows for the dashboard and the books.** Revenue and VAT are read from issued tax invoices
and credit notes, cash from paid and refunded payments, payouts from released payouts, margin (finance and
founder only) from accepted offers; the accounting export reads the same rows, so the two reconcile by
construction and the tests check it. Exports are generic CSV with formula text neutralised, logged and
audited; the accounting system's own mapping is an owner decision.

**D38. A statutory date reaches a client only after a person confirms it.** Obligations are generated by
rule when an engagement completes (`obligations.ts`) as `pending_review` with the rule's basis; ops confirms
or corrects the date and records what it was checked against; the row policy hides unconfirmed rows from the
client role. An obligation is met only when filing evidence is on file and MKW has checked it; a confirmed
recurring date rolls forward as open, an unconfirmed one comes back for review. The platform reminds and
records; it never files.

**D39. Arabic is a draft until a named reviewer signs it off.** The Arabic dictionary and the Arabic email
templates were drafted by the build (AI output under rule 5), so clients cannot choose Arabic until the
founder records the reviewer's name and date (`settings.arabic`, audited); MKW staff can preview it with a
visible draft banner, and the founder can list the reviewer's test client accounts, which see Arabic before
the sign-off and report the strings with no Arabic entry. Numbers, amounts, references, emails and
codes are never translated. Withdrawing the sign-off puts clients back on English at once. Partner and
staff screens stay English, as the specification says.

**D40. Accessibility is checked by a machine on every smoke run.** axe-core (MIT, Deque; `axe-core` 4.10.2,
dev dependency only, loaded into the page by the smoke test and never shipped) runs the WCAG 2.1 A/AA rule
set on the sign-in, client, partner and public screens in both languages and fails the run on any violation;
the keyboard-only path to an engagement is driven by key presses. Controls get accessible names at render
time (`ensureLabels`), the skip link and visible focus ring are global, and reduced motion is respected.
Removal: delete the dev dependency and the `axeCheck` block in `scripts/smoke.mjs`.

**D41. Tasees lives on `main` of `camayank/mkw-uae-growth`; the UAE ASP Selector moved out.** (18 Oct 2026.)
The owner chose to keep this repository for Tasees rather than create `camayank/tasees-platform`. The UAE ASP
Selector and E-Invoice Data Check, which `main` carried until then, were pushed with their full history to
`camayank/uae-asp-selector` (site URL repointed there). `main` was switched by one merge commit whose tree is the
`tasees-base` tree, so the Selector's history stays reachable below it and nothing was force-pushed; the eight
outcome pull requests (#1 to #8) were then retargeted at `main` and merged in queue order O1, O2, O4, O3, O5, O6,
O8, O9. The Pages workflow left `main` with that switch. To undo: create the separate repository, push `main`
there, and restore the Selector here from commit `28cbbe2` (the last Selector commit on `main`).
The full standing contract for the build is `BUILD_PROMPT.md`; `CLAUDE.md` is its short operational version.

**D42. Importers are dry runs of themselves.** (O10.) Every go-live importer runs its `--apply` code inside one
transaction and, without `--apply`, rolls it back, so the dry-run report is exactly what applying will do. Re-running
changes nothing (unchanged rows write no audit events); each created or updated record writes one. Importers take no
notifier, so importing cannot email or notify anyone; a test counts notification rows. The real files stay in
`data/import/` (ignored by git) or the private bucket; evidence copies drop firm names and contact details. Answers
are applied only when they are exact ("Agree" to a written suggestion, a name, a 15-digit TRN); anything else is
reported for the owner, never guessed. Draft rate-card rows are skipped even when they carry a fee: a price becomes
a commitment only when the firm has confirmed it. `import all` runs every step in one transaction (later steps see
earlier ones; applying is all or nothing). The importer never migrates: it names its target database and refuses one
with pending migrations. The console is the record for anything a person has touched since the last import: partner
fields MKW edited (three-way merge against what the file said last), fees added, verified or retired in the console,
holidays the founder confirmed or removed, rate cards the partner edited in the portal; the file never undoes them.
A fee is recorded as verified only when the import runs as the founder (`--as`), who is the audited actor.

**D43. An in-house .xlsx reader, no spreadsheet library.** (O10.) `apps/api/src/import/xlsx.ts` (about 130 lines)
reads a workbook's zip directory with `node:zlib`, the shared and inline strings and each sheet's cells, size-capped
against hostile files. The common libraries are either unmaintained on npm (SheetJS moved off npm) or pull in large
dependency trees for a job this narrow, in the process that holds client data. Tests build workbooks in the same
shape as the go-live file. To remove: export each tab as CSV and use `csv-parse`, already a dependency.

**D44. Staging as code with AWS CDK in TypeScript, in its own package.** (O10.) `infra/` uses `aws-cdk-lib` 2.270.0,
`constructs` 10.8.1 and the `aws-cdk` 2.1142.0 command line (Apache-2.0, maintained by AWS), plus `typescript` and
`@types/node` at the repository's versions, all pinned with their own lockfile. It is not part of the pnpm workspace
and never enters the application image (`.dockerignore` excludes it). Chosen over Terraform because it is the same
language as the platform, and `cdk synth` checks the whole design locally without cloud credentials (the Terraform
binary is not installable in this build environment). To remove: delete `infra/`; the runbook's steps map one to one
onto console or Terraform resources.

**D45. Legal texts are versioned and accepted per version.** (O10.) `legal_documents` keeps every version of the
client terms and the Partner Network Agreement. The latest version is shown; it carries "Draft, pending legal review"
until the founder records the lawyer's name and date for that exact version. A client accepts the current terms with
the offer (a stale or missing version is refused; the engagement stores it); with no terms loaded, acceptance works as
before. A partner admin accepts the agreement online and the firm's profile stores the version, but the firm still
uploads the signed copy, which MKW verifies before `signed`: an online tick is not a signature.

**D46. Holidays are a setting, expected until confirmed.** (O10.) The working-time clock reads the `holidays` setting
(date, name, expected or confirmed, note) instead of a code constant. Expected dates count as holidays meanwhile: the
best estimate of an Eid beats treating it as a working day. The founder adds, confirms and removes dates on Settings,
each change audited with a reason.

**D47. Imported admins wait for pilot; status moves only through the gated route.** (O10.) An admin named in the
roster is added as `invite_pending`, which cannot request a sign-in code; MKW moving the firm to pilot (which needs a
verified licence) activates the person and sends the invitation from "MKW Advisors". The partner profile edit
(`PUT /api/ops/partners/:id`) used to accept a `status` field, which skipped the licence and agreement gates; it now
refuses it, so every move goes through `POST /api/ops/partners/:id/status`. Deactivating a held admin cancels the
invitation; reactivation refuses a held one. The console email transport masks six-digit runs, so a sign-in code is
never written to a log; on staging the founder signs in once SES is live.

**D50. Migrations take turns on Postgres.** (O10.) The app, the scheduled jobs task and one-off tasks all migrate on
start. On Postgres each migration file now runs in its own transaction holding an advisory lock and re-checks
`schema_migrations` first, so tasks starting together never run the same DDL twice (checked with three processes
migrating one PostgreSQL 16 database at once). PGlite, single-process, is unchanged.

**D48. The database connection is verified, not only encrypted.** (O10.) RDS for PostgreSQL 15+ refuses plain
connections. The image carries AWS's RDS certificate bundle and the task connects with
`sslmode=verify-full&sslrootcert=...`, building `DATABASE_URL` at start from the Secrets Manager secret's parts (the
generated password excludes characters that would need URL encoding). The bundle is fetched when the image is built.

**D49. A put-and-get key for the files bucket.** (O10.) The in-house S3 signer (D13) reads a static key, so staging
creates an IAM user that may only put and get objects in the files bucket, with its key held in Secrets Manager.
Reading the ECS task role's temporary credentials instead would remove the long-lived key; that is a small change to
`lib/storage.ts` for later (KNOWN-GAPS).

**D51. Every side effect leaves through an outbox.** (O11.) A message (and agent work) is a row in `outbox`, written by
`Notifier.send()` in the caller's transaction: it exists exactly when the change does, and a crash after the commit no
longer loses it (the in-memory queue of O2 did). A dispatcher claims one row at a time with `for update skip locked`,
so several app tasks and the jobs task can run it together; it runs after each commit, after each response, and on
every jobs run, which also finishes anything a stopped process left. Templates, branding and the `notifications`
record are unchanged; each record now carries its outbox id (unique), so a message is recorded once however often it
is looked at. The topic list is closed in code (`notify`, `document_check`). Removing it means restoring the
in-memory queue in `lib/notify.ts` (the old code is in O10's history).

**D52. A message in doubt goes to a person; nothing is sent twice on its own.** (O11.) A refusal from the provider is
retried after 1, 5, 15 and 60 minutes; the fifth refusal is final (`failed`) and shows in the ops queue with Retry and
Cancel. A claim older than 10 minutes means the process stopped mid-delivery: if the record says the provider took it,
it is done; if nothing was handed over, it is retried; if it was handed over with no answer recorded, it is `unknown`
and ops decides (Mark delivered, Send again, Cancel), with a note that goes into the audit trail. The alternative,
re-sending automatically, would sometimes send a client the same invoice twice. The same applies at the moment of
sending: only a definite 4xx answer from SES is a refusal; a timeout, a dropped connection or a 5xx may mean SES took
the message, so the row goes straight to `unknown`. Every update after a handler runs checks that its claim still
stands, so a run that outlived its lease never overrides a recovery or a person's decision. Provider error text stays
out of the audit trail (it can quote an address that a later erasure must be able to remove), and erasure clears it from
the outbox.

**D53. Sign-in codes stay out of the outbox.** (O11.) The code is never written down (D11), so it cannot sit in a
table waiting for a retry; it is held in memory until the commit and sent once, as before. A lost code costs the person
one more request, which the 5-per-hour limit allows.

**D54. The document checker drafts from metadata and never acts.** (O11.) It is the first outbox subscriber: each
upload of milestone evidence, a requested client document, a partner document or filing evidence raises a
`document_check` event in the upload's transaction, and the dispatcher files the model's check as an `ai_drafts` row
(UNCERTAIN, one per event, enforced by a unique index) beside the upload. Only the declared type, reference and expiry,
what the step asked for and the file name reduced to document words, dates and the extension reach the model (other
words become "x", other numbers "#", so `Passport_Ahmed_Khan_784-….pdf` is sent as `Passport_x_x_#-….pdf`): never the
file, a person's name, an ID number, contact details or a price. A date in a file name is kept, because issue and
expiry dates are what the check is for; it could be a birth date, which on its own identifies nobody. The draft changes nothing; ops says
"Check is right" or "Check is wrong", which records the decision and the time taken (the start of the learning loop,
O16). A model that keeps failing leaves no draft and blocks nothing; its events stay in the outbox and are not shown as
messages to settle. The in-memory model reads the name only and says so on every check.

**D55. The queue is ranked by explainable factors and decides nothing.** (O11, `packages/core/src/triage.ts`.) Each
kind has a target in working hours on the UAE calendar with Settings' holidays (disputes, offers to price, scoping,
unallocated lines and offers to publish 4; messages not delivered 2; evidence, quotes, drafts, delays, obligations,
leads and overdue documents 9; payouts, credits, partner documents and expiring licences 18; partner applications 27)
and a weight (a dispute 35 down to a lead 5). Past the target adds 30 plus 2 per working hour late (up to 20); within 2
working hours adds 15; a waiting client adds 10, a waiting partner 5, money waiting 5, a partner below the quality bar
10. Each factor is shown as a sentence. Client documents count as overdue three working days after they were asked for,
and their target runs from that point; partner licences show 30 days before expiry. One-click buttons exist only where
the card shows everything the click decides (publishing a priced offer, passing evidence, a document check, a lead, a
delay's cause, a partner document, filing evidence, an undelivered message); scoping advice, scope drafts and
obligation dates are statutory or client-facing content and open their own page; payouts go in the weekly run. Only ops
and the founder act from the queue; finance reads it. The overview and the morning digest read the same ranked queue, and the
digest now says how many items are late and how many arrived since the last digest. Targets and weights are defaults
for the owner to change.

**D56. Queue timings are measured from the queue's own view.** (O11.) Each item gets a `queue_timings` row while it
waits; it is resolved when the queue is next computed without it (every view and every jobs run, so within 15
minutes). Handling time runs from a person opening or acting on the item from the queue to its resolution, capped at 30
minutes so a tab left open is not counted as work. "Ops minutes per engagement" is that handling time summed over
items tied to an engagement, divided by those engagements. It is an approximation that errs low (work started outside
the queue is not timed); the founder dashboard says how it is measured. Timings are measurements, not changes to
anything a person decided, so they are not written to the audit trail (as with a notification being read).

**D57. "On time" uses the first submission on the application clock.** (O11.) On-time rates (dashboard, partner
dashboard, scorecards) compared the audit trail's wall-clock time with due dates set on the application clock; in
production they agree, but in tests with a fixed clock three checks started failing on `main` once the real date
passed the test's due dates. Milestones now record `first_submitted_at` (resubmissions keep the first), backfilled from
the audit trail, and the comparison uses its Dubai date (it used the UTC date, which counted a submission between
00:00 and 04:00 GST on the next day as on time). The audit trail itself keeps wall-clock time, as before.

## Open for the owner

1. **Margin rates and floors per category.** Seeded from the Sheet (setup 20% / AED 500 and so on). Confirm.
2. **Fairness cap and quality bar.** 35% and 60/100. Lower the cap to spread work faster; raise the bar to
   protect quality.
3. **Deposit size.** 50% of fees plus all government fees. Some free zones need full payment up front.
4. **Service guarantee.** Client terms refund [10]% of fees if a step is more than 5 working days late. Confirm
   the figure and whether the partner bears it.
5. **Payment provider.** Network International, Telr, Checkout.com or Stripe (UAE). The webhook is generic.
6. **Hosting region and provider** (see DEPLOY.md, data residency).
7. **Whether partners may see the client's company name before accepting.** Today they see only emirate, zone
   and the services; the name appears after they accept and become a party.
8. **Retention periods** (Settings page): 5 years for tax records, client documents and messages, audit trail
   kept indefinitely. Shown as UNCERTAIN until confirmed after legal advice.
9. **Who may erase a person's data.** Built as founder-only; ops can export.
10. **Cloud provider and region for O1 staging.** AWS me-central-1 suggested (native S3 and RDS); see DEPLOY.md.
11. **Template wording** in `apps/api/src/lib/templates.ts` and the two sender addresses (suggested
    `tasees@mkwadvisors.com` for clients, `partners@mkwadvisors.com` for partners).
13. **Margin rules for the five new categories** (Private Client, HR, Advisory, Growth, Other): defaults of
    20% with floors of AED 300 to 500, shown as "default, confirm" on the Rules page.
14. **Named fee verifier** and whether ops may add fee rows (built: ops adds, founder verifies).
16. **Who verifies scoping rules and zone data** (monthly), and the AI API key with a monthly cap (USD 100
    suggested). **Consent wording** on the public intake page (`intake.html`, version 2026-10-privacy-v1) for
    the lawyer.
17. **Service guarantee figure** (`guarantee_bp`, 1000 = 10% now, per the specification) and the **public
    holiday list** for the working-time clock.
18. **Accounting system** (Zoho Books, Xero or QuickBooks) for the export mapping; **financial year end**
    for corporate tax (31 December assumed in the obligation rule).
19. **Arabic reviewer** (name and sign-off), after which clients may choose Arabic.
15. **Card payment provider**: the webhook contract is generic until chosen; Network International, Telr,
    Checkout.com or Stripe UAE. **MKW's TRN, legal name and address** for invoices. **Bank bulk-transfer
    sample** for the payout file. **Tax adviser's confirmation** that government fees are disbursements.
12. **Ops digest time**: once per working day between 08:00 and 10:00 GST, to ops and the founder.
20. **Owner-Decisions.md arrived with every answer blank (18 Oct 2026).** Every value above stays as built and
    UNCERTAIN where it shows: margin rules, fairness cap, deposit, guarantee, retention, verifiers, hosting, email,
    payment provider, web address, AI, accounting system, year end, digest time, Arabic reviewer, template wording,
    pilot partners and clients, lawyer and tax adviser. MKW-Company-Details.md gave only the three email addresses, which
    match the built defaults; legal name, licence, address and TRN are still blank, so invoices stay held.

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
the message, so the row goes straight to `unknown`; so does a message the provider took when recording that
fails afterwards (a database error after delivery is not a refusal). A replacement upload closes the earlier upload's
pending document check as superseded, so no verdict is confirmed against the wrong file. Every update after a handler runs checks that its claim still
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

**D58. The client's next action is worked out on the server.** (O12, `services/journey.ts`.) From the client's own rows,
under their own database role: an offer to decide (by its expiry), a payment due, a priced scope change waiting for the
account owner (the partner's description in `detail`), a step to approve (with the date it is
approved automatically, from the same calendar and five-working-day rule the sweep uses), documents to upload (each kind
once, with how many steps wait), filing evidence due within 30 days. The first is pinned on the home and engagement
screens; the rest fold under it. With nothing to do, the screen says what is happening and when the next step is
expected. The order is a choice for the owner's wording review.

**D59. The intake preview never shows unreviewed advice.** (O12.) The conversational intake builds a plan as the client
answers, from `POST /api/requests/preview`, which runs the same scoping and writes nothing. It returns only the services
that follow from the client's own choices and notes in the client's words. Advice on structure and place is UNCERTAIN
until a person at MKW reviews it (rule 5), so the plan says that advice follows after a person has checked the answers,
and shows none of it. It runs under the person's own database role (it only reads the catalogue). Server-built
sentences never contain people's own words (a partner's reason for sending a document back, the client's dispute):
those travel in a separate `detail` field, shown as written and never sent to the Arabic reviewer's gap list, which
keeps its 200-character limit.

**D60. The proposal's fee notes come from the fee table, as client-safe sentences.** (O12.) Each government fee on the
proposal is looked up in MKW's fee table for the request's place: UNCERTAIN or stale gives "an estimate MKW confirms
before paying"; no row gives "as quoted by the partner, paid at cost". It is never read from an offer line's free-text
reason (internal, and rewritten when ops sets a price), and that reason never reaches the client. The deposit and
balance come from the same `paymentPlan` acceptance uses. The guarantee rate (`guarantee_bp`, internal on credits) is
stated on the proposal because it is a promise to the client; the wording says finance confirms each credit and that a
delay caused by something only the client can provide may not qualify (for the owner's wording review). The working-day
estimate is the longest one-off line from the start of work; recurring services are listed but not counted.

**D61. Uploads are checked before they leave the page, by the server's rules.** (O12.) `GET /api/upload-rules` publishes
the storage adapter's own extensions and size limit; the page checks type, size and emptiness when a file is chosen or
dropped and again on submit, and asks for confirmation when the name reads like a different document. The server still
refuses what it always refused. The rules need no sign-in: they say nothing about anyone. A file dropped outside a drop
zone is ignored (the browser would otherwise open it in place of the app); several dropped on one item use the first and
say so.

**D62. The web app is ES modules with design tokens, still with no build step.** (O12.) `app.js` loads `js/core.js`,
`js/shell.js`, `js/events.js` and one module per area; `tokens.css` holds every colour, space, size, radius, shadow and
timing (`docs/DESIGN.md`). The split was made mechanically with no behaviour change and checked by the unchanged smoke
test before any screen changed.

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

**D63. Configuration is checked before anything starts.** (O13, `lib/config.ts`.) One table lists every variable the API
reads with its rule; the server, the jobs runner and every script refuse to start on any problem and print each one as
"NAME: rule". A value is never printed (a secret pasted into the wrong variable must not reach a log). Unknown values
that used to fall back silently are now refused (`EMAIL=sess`, `STORAGE=S3`). Production adds: `DEV_LOGIN=1` is refused
rather than ignored, `APP_URL` must be https, and a webhook secret, when set, has at least 16 characters (unset still
rejects every webhook, which is safe while there is no payment provider). The adapters keep reading their own variables:
the check decides only whether the set makes sense, so nothing working was rewritten.

**D64. Logs are one JSON line per event, with ids and no personal data.** (O13.) Fastify's own logger (pino, already a
dependency of Fastify; nothing added). Each request keeps a well-formed `x-request-id` from the load balancer or gets a
new one, and returns it; after sign-in every line carries the user, organisation and role ids. The request serializer
logs the method and the path without its query (a search can carry a name or an email); headers, bodies and client
addresses are never logged. Errors go through one serializer that keeps type, code, message and stack, with the values
a database or provider error quotes ("Key (email)=(…)", an address) replaced; job step errors are cleaned the same way
before they are stored, logged or audited. A server error answers with its request id, so a person can quote it.

**D65. The platform raises its own alerts, by email, through the outbox.** (O13, `services/system.ts`.) Four conditions:
the jobs have not completed for 45 minutes (three missed runs), a step failed in the last run, a message has been due
for 30 minutes without being handed to the provider, the nightly audit check failed. The watchdog runs in the server
every five minutes (the jobs cannot report that they did not run) and again at the end of each jobs run. One alert per
condition and subject is open at a time: emailed to `ALERT_EMAIL` when it opens, every four hours while open, and once
when it clears; opening and closing are audited. Alerts are about the platform only and carry no personal data (error
text is shortened and email addresses in it are replaced). Sending them is an explicit, tested rule (rule 6) to MKW's own
address, never to a client or partner. Without `ALERT_EMAIL` they are logged and shown on the System page and at the
top of the ops queue. The staging CloudWatch alarm on missing job runs stays as a second, independent signal.

**D66. Idempotency keys answer a repeat with the first answer, never a second change.** (O13, `lib/idempotency.ts`.)
The key is claimed before the handler runs and the answer stored as it leaves; a 5xx releases it (the change rolled
back). A process that stops between commit and recording leaves the key "running": every repeat gets 409 until it
expires after 24 hours, so the person checks the screen rather than the change happening twice. Keys are per person,
refused on public routes (the public intake and sign-in have their own duplicate handling) and erased with the person.
A request with no signed-in person ignores the header (the route answers 401, or a public route its usual way), so an
expired session still gets "sign in" and a provider's webhook is never refused for its headers. The PDPL export is
marked `idempotency: false`: a person's data is never stored as an answer. Erasure deletes the person's keys and any
stored answer that quotes their email or name.
Stored answers are kept only 24 hours. The web app keys every change by method, path and body, keeps the key while
the answer is unknown (a network failure, or "still running"), and retries a dropped request once with the same key.

**D67. Milestones, offers and engagements move only through `transition()`.** (O13, `lib/transition.ts`.) The tables
in `packages/core/src/states.ts` are the rule; `transition()` locks the row (`for update`), checks who may make the
move, sets the status and its timestamp, updates only where the status is still the one it read, and writes the audit
event with `from` and `to`: the caller's own event where it has one (the action names are unchanged), otherwise
`<machine>.status_changed`, so every move is audited (rule 8). A refusal names what can happen next. A source test
fails on any other status update for the three machines. Accepting an offer first locks every offer of its request in
id order: two acceptances (of one tier or of two) queue instead of deadlocking.

**D68. Rows that money and work hang on are locked before they are checked.** (O13.) The concurrency tests on
PostgreSQL 16 found that two acceptances of one allocation could both pass (both created steps and payouts). Payments,
allocations, payouts, change orders, refunds, guarantee credits, delays, document requests, AI drafts and obligations
are now read `for update` before their state is checked, and every allocation decision, automatic or manual, takes a
transaction lock (`pg_advisory_xact_lock(777003)`) before it reads anything, because the open lines and partner
capacity both come from rows another transaction may be writing. Both cost milliseconds and are proven by tests that
fail without them (two reallocations at once offered the same line twice; two tiers accepted at once deadlocked).
**One lock order:** every audit event takes the chain's lock (777001, held to commit), so anything that locks a row
or takes the allocation (777003) or payout-run (777002) lock and then audits takes 777001 first (`lockAuditChain`,
re-entrant). Without it a deposit on one engagement and a reallocation on another deadlocked (found by the Codex review
of camayank/mkw-uae-growth#14; the race test failed with a 500). The cost: writes that audit already queued on that
lock from their first audit to commit; they now queue from their first lock, a few milliseconds earlier.
On PostgreSQL the test files run in parallel databases, so `test/global-setup.ts` creates the server-wide roles once.

**D69. The API contract is generated from the schemas the handlers parse with.** (O13, `lib/openapi.ts`.) Each route
declares `config: { body }` (or `body: null`), the same zod object its handler parses with, and `GET /api/openapi.json`
builds an OpenAPI 3.1 document from them with a small converter (zod 3 has none built in; adding
`zod-to-json-schema` was not worth a dependency for the features the routes use). `docs/openapi.json` is the committed
copy; a test fails when they differ, when a route that changes something declares no body, or when a declared schema
is not the one its handler parses. It is served to MKW staff only (it maps the admin and finance surface). Objects are
described as zod treats them: unknown keys are dropped, not refused, unless the schema is strict. Refresh with
`pnpm --filter @tasees/api contract` and review the diff. Routes live in `src/routes/` by area; `server.ts` keeps the
hooks. Responses are not described yet (gap 40).

**D70. The dependency audit before the pilot: patch what ships, cap what cannot be patched yet.** (O7.) `pnpm audit` on
25 Oct 2026 found 38 advisories. In what ships in the image:
- **Fastify** 5.2.0 → 5.12.7 (MIT, the same major; actively maintained by the OpenJS Foundation). This fixes thirteen
  advisories, among them validation bypasses through content-type and schema handling and an authentication bypass
  through malformed URLs. Fastify 5.12 no longer honours a hop count for `trustProxy`, because a direct caller could
  spoof it. `TRUST_PROXY` is now the load balancer's address range, and the staging and demo stacks pass their VPC
  range. A number other than 0 is refused at start, rather than silently putting every visitor in one rate-limit
  bucket.
- **csv-parse** 5.6.0 → 7.0.3 (MIT; used only by the owner-run import scripts). Prototype replacement through column
  names. The import tests pass unchanged.
- **fast-uri** (through Fastify's validator). Pinned to the patched 3.1.9 and 4.2.3 with an override in
  `pnpm-workspace.yaml`. Remove the override once Fastify requires those versions itself.
- **zod** 3.23.8. The memory-exhaustion fix exists only in zod 4, a migration across every schema. Request bodies are
  now capped at 1 MB, and at 25 MB only for routes whose schema carries a file (`contentBase64`), which bounds what one
  request can make the validator do (gap 43).

The development tools' advisories (vitest, vite, tinypool, esbuild, playwright) are not exposed: nothing listens and
nothing ships. They wait for the next tooling change (gap 44). `pnpm audit --prod` now reports only the zod finding.
The reviewer's brief is `docs/SECURITY-BRIEF.md`.

**D71. zod 4, and the contract from zod's own JSON Schema export.** (S1.) `zod` 3.23.8 → 4.6.7 (MIT; actively
maintained; the same author and API family). This clears the last advisory in what ships: memory exhaustion while
validating oversized constrained collections. `pnpm audit --prod` now reports no known vulnerabilities.
- **Code changes.** The migration needed three: a record schema states its key type (`z.record(z.string(), …)`); the
  file-body detector no longer looks for zod 3's effect wrapper; and the hand-written zod-to-JSON-Schema converter
  (about 70 lines) is replaced by `z.toJSONSchema` in input form, with an unrepresentable schema still refused.
- **Validation is stricter in three ways that match our data:**
  - UUIDs must be RFC 9562 (ours come from `gen_random_uuid()`);
  - emails follow zod 4's pattern;
  - integers must be safe integers (amounts are fils, far below 2^53).
- **No route changed.** Every route accepts and answers what it did: the whole API suite, the race tests and the
  browser smoke test pass unchanged on PGlite and PostgreSQL 16.
- **The contract.** `docs/openapi.json` keeps the same 140 operations and fields. It adds only what zod 4 now states:
  the UUID and email patterns, safe-integer bounds, and the key type of the one record.
- **Body caps.** The 1 MB cap (D70) stays as defence in depth.

**D72. Eligibility before recommendation.** (E1, `packages/core/src/eligibility.ts`.) Every structure and place is checked
against named rules before anything is ranked. Each check yields one of four outcomes:
- **fail**: excludes the option;
- **condition**: something the founder must obtain;
- **unknown**: a missing fact, a point to confirm, or missing data;
- **pass**.

The status follows in this order:
1. Any fail makes it `INELIGIBLE`.
2. Else missing data makes it `DATA_UNAVAILABLE`.
3. Else anything unconfirmed makes it `REQUIRES_VERIFICATION`. This covers an unknown fact or point, and any rule
   or data row not verified.
4. Else conditions make it `ELIGIBLE_CONDITIONAL`.
5. Else `ELIGIBLE_VERIFIED`.

Nothing checked is not verified: no findings is `REQUIRES_VERIFICATION`.
- **Exclusions apply even when their rule is unverified.** Excluding is the safe direction. The finding carries the
  rule's confidence, and ops can see it.
- **A place finding is never more confident than the weaker of its rule and the place's data.**
- **Ranking:** the recommended structure's places first, then by status, then the founder's preferences, then the
  lower estimate, then the name. No partner, rate card or margin is an input.
- **No fit:** when nothing survives, there is no recommendation and the advice says a specialist will look.
- **Structure choice:** the structure the founder's facts point to is kept only if viable. Otherwise the closest
  viable one is shown with the reason.

**D73. A formation quote waits for a settled structure.** (E1, `services/structure.ts`.) Building offers stays open (an
internal estimate), but publishing a new-company offer needs a settled structure. Either ops approved the advice with
a structure, or the client asked for one that the advice (if any) agrees with.
- **Re-checked today.** The structure is checked again against today's rules, so a change in facts or rules after
  approval cannot carry an excluded structure into a quote.
- **Priced correctly.** The offer must price that structure's formation line, and only that one. Each structure
  has its own code (`SET-FZ-LIC`, `SET-ML-LIC`, `SET-OFF`, `SET-DIFC`), so a quote for one structure cannot pass as
  a quote for another. "Not sure" is estimated as a free zone and cannot be published until the structure is settled.
- **No formation without a structure check.** A formation code priced on a services request or as an add-on is
  refused at publishing: the request must be recorded as a new company so its structure is checked.
- **At approval.** An excluded structure cannot be approved. A different structure re-scopes the request (answers
  and scope sheet, audited with before and after), and offers priced on changed lines are withdrawn.
  - Re-scoping changes only the formation and its visas. Every other line stays as the scope now has it: lines ops
    added, quantities ops reviewed, and services ops removed stay removed.
  - It takes the audit-chain lock before the request row, in the documented lock order.
  - Once partners have been asked to quote (a quote request exists), the structure no longer changes at the
    scoping review. Their sealed quotes are for the scope as sent.
- **After acceptance.** The structure changes only by a change order.
- **Unaffected.** Services-only requests are not held.

**D74. Reporting reads step dates, not audit timestamps.** (E1, migration 013.) A step's approval date and first-dispute
date are columns on the step, set by `transition()` on the application clock and backfilled from the audit trail.
- **Why.** Audit events keep the database's real clock, which an audit trail must. Reporting by them put steps in
  the wrong month whenever the two clocks differed, which is what broke three tests on 2 Nov 2026.
- **Partner scorecards.** These now count by the step's own dates, which changes three figures:
  - **Submitted:** a step counts once, in the window of its first submission. A resubmission in a later window does
    not count again; the scorecard measures first-time quality.
  - **Rejected:** a step first submitted in the window counts as rejected if QA ever rejected it.
  - **Disputed:** a step counts once, in the window of its first dispute.
  These replace counts of audit events, which counted repeats and used the database's clock.
- **Backfill.** Migration 013 dates existing steps from their audit events (database clock); new steps are dated
  by `transition()` (application clock). The two agree in production, where no test clock is set.

**D75. The advice says what it does not know.** (E1.) Missing facts are listed in the founder's words, contradictory
answers are named rather than resolved by guessing, and cross-border points are always a specialist's review. All
three travel with the approved advice, and ops can remove a statement but not reword it (D30).

**D76. Corrections from the E1 review.** (E1, before merge.) An independent review of the E1 change found these; each
has a test that fails without the fix.
- **"Finance" means regulated financial services.** The question now says so (banking, lending, investment,
  insurance, payments). Accounting and bookkeeping are consulting. A regulated activity stays a hard exclusion for a
  commercial free zone and for offshore.
- **Virtual assets name the right regulator.** VARA in Dubai, the SCA in the other emirates, and the FSRA in ADGM.
  Free zone findings no longer mention the FSRA.
- **Small business relief is dated.** It covers tax periods ending on or before 31 December 2026. A company formed
  after 30 June 2026 cannot have one, so it is not offered as a possibility. An existing company still sees it
  until the end of 2026. The engine takes today's date from the application clock.
- **The Wage Protection System is a mainland obligation.** Free zone and DIFC/ADGM recommendations get a payroll
  point that defers to the zone's own employment rules.
- **A holding vehicle in DIFC or ADGM carries no visas on its own.** Visas need an operating licence and office
  space; the advice says so.
- **A recommendation always has a place.** If no place of the recommended structure fits the budget, visas or
  facilities, the closest structure with a place that fits is recommended, with the reason
  (`structure.no_viable_place`).
- **Places the founder names stay within the structure.** A named place is promoted only if it belongs to the
  recommended structure.
- **Removed means removed everywhere.** A statement ops removes is also removed from every structure, place and
  excluded-place finding. The status shown is the one the remaining findings support; the quote gate re-checks
  against the rules regardless.
- **Flags are recomputed at approval.** Once ops settles a structure, `noViableOption` is false. `needsVerification`
  is worked out from what the client will see.
- **Labels on findings.** Every exclusion and condition is shown with its confidence label.
- **Contradictory premises answers keep the requirement.** "Office needed" together with "no premises" counts as
  premises until ops resolves it, so a contradiction can never lift the offshore exclusion. (From the pull request's
  automated review, with the two re-scoping points above.)

**D77. Every catalogue figure is an append-only fact, and evidence goes stale.** (E2, migration 015, `services/catalogue.ts`, `packages/core/src/catalogue.ts`.)
- **What a fact holds.** Every place figure (cost, renewal, visas, timeline, facilities, activity list, legal forms,
  coordinates), authority relationship and rule verification is a fact. It records the source, evidence date,
  confidence, verifier and re-verification date.
- **Append-only.** The database refuses update and delete, both by the trigger and through the app role's grants. The
  latest fact per field is current, and the history stays readable. The value on the place is a cache, refreshed in
  the same transaction, so the E1 engine reads it unchanged.
- **Verified facts.** A verified fact needs a named verifier, an http(s) source and a re-verification date. The
  default is 180 days after the evidence date, because free zone fees and packages change often. The owner may
  change it.
- **Staleness.** A fact past its date drops one level (verified to rule of thumb, rule of thumb to UNCERTAIN) and is
  labelled stale. A place is as confident as the weakest evidence the engine uses; rules are judged the same way.
- **Nothing invented.**
  - Relationships between authorities are recorded only as facts with a source.
  - Places added without figures (Umm Al Quwain, Fujairah) are marked `placeholder`. Each of cost, visas and timeline
    counts only once it is given or recorded as a fact; a placeholder is never written as a fact, and the place
    cannot be verified or offered until all three are on record.
  - A spreadsheet alone can never make evidence verified: the importing founder must be named.
- **Dates.** Evidence is dated and judged on the Gulf day (`gulf(app_now())`), as the rest of the business is. A fact
  cannot be dated in the future, and no re-verification date may be more than two years after the evidence, so no
  fact can be made to never go stale. The database enforces both.
- **Each figure carries its own confidence.** An activity list's or a renewal estimate's confidence travels with it;
  the engine's activity finding is never more confident than the list it came from.

**D78. Advice records the rules and data it was computed from; approval needs them current.** (E2.)
- **What is recorded.** Advice carries `dataVersion`: the day, a digest of the effective rules and places it used,
  and the latest fact on record.
- **What changes it.** A new fact, a rule verification, or evidence passing its re-verification date all change the
  digest.
- **At approval.** Ops cannot approve advice whose digest no longer matches. The review says why, and one click
  recomputes it. Advice computed before E2 needs one recompute.
- **What the client sees.** The approved advice shows the date its rules and data stand at.

**D79. A listed activity is evidence, a missing one is not.** (E2.) When a place's activity list on record includes
the founder's activity group, the place finding passes at the weaker of the rule and that evidence. When it does
not, the finding stays "to confirm": activity groups are coarse, and a group missing from a list does not prove the
exact activity is refused. A place the founder names matches by its name, its authority's name or an alias.

**D80. The public selector shows approved rules only.** (E3.) The owner was asked, on 2 Nov 2026, what the public
selector may show before anyone at MKW has looked at the case, and chose "approved rules only" over "no result until
reviewed" and "structures only, no figures". This is the documented resolution of the conflict recorded in
`docs/ENTITY-PROGRAMME.md` section 3.1; rule 5 in `CLAUDE.md` and `BUILD_PROMPT.md` carries it.
- **Approval is per version.** The founder approves a rule by its version number, or a place by the digest of its
  current figures, facilities, activity list, confidence and evidence (`public_approvals`). A new verification, a new
  fact or evidence going stale changes the version and the approval lapses; the console says "lapsed: new version".
  Approving again supersedes the earlier approval, so exactly one is live per subject. Every approval and
  withdrawal is audited.
- **Only checked things can be approved.** An UNCERTAIN rule or place, or one whose evidence is stale, cannot be
  approved for public display. A rule of thumb can: the founder's approval is the named person's check under this
  rule, and the public text carries no confidence label beyond "checked".
- **What is approved is the engine's wording.** A rule's public version is its verification version, the
  confidence it deserves today and a digest of every text the engine can emit under that key (`engineTextsByRule`
  runs the engine over a matrix of founders). The console shows those texts before approval. A reworded engine, a
  new verification or a stale verification each lapse the approval.
- **Conclusions need every rule they rest on.** A statement that restates other rules' findings (`basedOn`: the
  fallback after an exclusion, "you asked for X, which does not fit", "no option fits") is public only when all of
  them are approved. A place-rule finding carries the place's figures, so it also needs the place approved.
  Unapproved findings carry no outcome, and unapproved places show no authority or preference. A place the engine
  excluded is listed as "to be verified" rather than dropped, so an empty list never implies that nothing fits.
- **The public view is a filter** (`packages/core/src/public.ts`): approved statements keep their text, approved
  places keep their figures, everything else becomes "to be verified" with no text and no figure. A recommendation
  is confirmed only when every reason behind it is approved; "does not fit" is shown only when the failing rule
  is approved; a contradiction that restates an offshore rule is gated on that rule. The founder's own open
  questions are always shown.
- **The public assessment writes nothing.** `POST /api/public/assess` runs the same engine on the same catalogue
  and keeps no answer, request, lead or audit row. It is rate-limited per IP. The review request goes through the
  existing public intake with the PDPL consent text, and only then is anything stored.
- **Disclaimer.** The default wording is `PUBLIC_DISCLAIMER` in `packages/core/src/public.ts`; the owner may change
  it.

**D81. Leads are their own identity, with consents per purpose, and nothing is sent to them.** (E4, migration 017.)
- **A saved assessment is the founder's own action** and holds answers, a result summary and attribution only: no
  contact details, no email. The recovery code is shown once and stored hashed. Recovery re-runs the assessment on
  today's rules and says so.
- **A lead is never a user.** Every review request creates a lead that points at the session it came from and at
  what it became (a client organisation and request, or a held enquiry). Scores (complexity, intent), a segment and
  a high-intent flag come from `scoreLead` in core: deterministic, bounded, with no commercial input.
- **Consents are append-only records per purpose:** service (required), marketing and partner disclosure (never
  pre-ticked), each with the text version shown. A withdrawal is a new record. Consents carry no IP (the lead row
  does, and it is tombstoned). Consents travel with the PDPL export, with the lead's notes and saved assessment, and
  are kept through erasure; the lead's personal data, notes and saved answers are tombstoned.
- **A submitted form is not a client.** A lead "became a client" only when an offer on its request was accepted or
  an engagement exists for the organisation it became. That predicate decides both the `converted` status and what
  retention keeps.
- **The recovery code is never stored in clear:** it is hashed at rest and stripped from the landing page and
  referrer before attribution is recorded, so neither the request's source nor the audit trail can carry it.
- **Free text a person types about a lead** lives in `lead_notes`, which erasure reaches; the audit trail records
  that a note or status was recorded, never its text.
- **Routing assigns, it does not send.** The founder maps segments to owners on Settings; a routed lead, a call
  request and a due follow-up are queue items for a person. No function in E4 writes to the outbox.
- **Analytics stop at client revenue.** Per source and campaign, from saved assessments to accepted offers, in
  client totals; margin never appears.
- **Retention is a confirmed rule or nothing.** Leads and sessions that never became a client are anonymised after
  the retention period only once the founder has confirmed the periods; until then the job counts and changes
  nothing. Counts stay for analytics.

**D82. Handoff is a person's action, and the request is always re-checked.** (E5, migration 018.)
- **From a saved result.** A signed-in client enters the recovery code; the answers pre-fill and the request is
  created for that client with `assessment_id` recorded and the assessment marked `request`. The advice is computed
  on the day's rules and data (E2); nothing from the public result is copied. A code is used once. A code opens
  answers only, so a mistyped or shared code can leak nothing personal.
- **From a held enquiry.** When the public page's email already has an account, the enquiry is held (O5). Ops
  converts it into a request for that client with one action; the enquiry is handled with the request recorded, and
  the lead (E4) points at the request. No automatic conversion, and no message.
- **Then against now.** The review shows when the result was saved, what the public saw (only what was approved
  for display) and what the engine says today.
- **Renewals.** A trade licence renewal is asked for by the client or ops from the open obligation; it is a services
  request with the renewal line, linked both ways, priced by partners and the margin rule like any line. One renewal
  is in progress per obligation; "in progress" is read from the pipeline (being scoped or quoted with no accepted
  offer, a published offer that has not expired, or an engagement not finished), never from the request's status,
  which closes at acceptance. A renewal asked for again after an expiry supersedes the earlier request for good
  (`requests.superseded_by`): it is never priced, sent to partners or published again, and no offer is built, sent
  out or published for a request whose obligation has another request in progress, so one obligation can never end
  in two renewal engagements. When an engagement that carries the renewal line completes, the obligation is met by
  that delivery (its evidence is on the engagement) and the next occurrence rolls forward as it would after a filing;
  an engagement re-scoped to something else leaves the obligation open and is audited.
- **A code links only its own person's lead.** When a saved result becomes a request, a lead is linked to it only if
  its email belongs to the signing-in client; a stranger who quoted the same code is left alone.

**D83. The contract's scenarios are the acceptance suite, and a missing record is said, never assumed.** (E6.)
- `apps/api/test/scenarios.test.ts` holds one end-to-end test per scenario in the owner's contract (section 11), on
  the seeded catalogue as it stands on the pilot's first day: every rule and place UNCERTAIN. Each test names the
  checks it covers; `docs/evidence/E6/SCENARIOS.md` maps every scenario and check to its tests, and names the gap
  where the platform does not model the case. A later change that breaks a scenario fails the suite.
- Where a check needs a fact the catalogue does not hold, the engine says the data is missing and ranks the place
  below those with a record, in both directions: it neither passes nor excludes on a guess. E6 closes the one place
  this was uneven: a storage need at a place with no facilities on record now says so, as industrial land did.
- When the advice finds no option that fits every answer, the structure it names is an explanation, not a
  recommendation: no formation quote is published on it, even if the client named that structure. A person's
  approval of a structure at the review (audited) is what opens the way to a quote.
- Verification is reported in three states only: executed here (command and result), verified by CI only, or
  blocked with what unblocks it (`docs/evidence/E6/VERIFICATION.md`). No staging or live readiness is claimed
  without the owner's accounts.

**D84. The workspace is read from the next action down, and what is not needed folds away.** (U1, from the design
canvas of 3 Nov 2026 and its review round.)
- A client's overview, engagement and advice, and a partner's work and engagement pages, open on the one thing that
  needs the reader, with the date something happens if they do nothing; messages sit beside it. Documents, steps,
  payments, scope and scope changes are folding panels whose headings carry their state, open only while something
  in them waits on the reader. The timeline of steps stays open: it is the record.
- The advice gets a two-sentence summary (the recommended structure, the place it points to, the first reason and
  up to two points to confirm), built only from the engine's own labelled text; the full reasoning follows in one
  panel. Nothing is added to the advice and nothing is dropped from it.
- The priority tier keeps its name on the client's screen. The design canvas called it "Faster", but the tier is priced
  on the quickest partner quote while the proposal's estimate and the delivery plan come from the scope templates
  (`milestonesFor`), so a pace promise would not be kept (gap 85, raised in review). Ops still decide which tiers to
  build; the screen handles any number, one shown as selected and the others as a switch.
- On a phone, clients and partners get a bottom tab bar with icons; MKW staff keep the grouped menu, which carries
  fifteen pages. The same `nav#nav` element serves both, so nothing about routing or keyboard access changes.
- Partner screens stay English (O15 covers Arabic for partners and staff); every new client string has an Arabic
  entry under the existing reviewer gate.

**D85. The public product reads as a decision, and general guidance is approved like a rule.** (E7A; D84 is U1's.)

- `selector.html` is the product's homepage as well as its questionnaire: value proposition, one call to action,
  industry entry points, how it works, and what the page does not do. Every existing link and test keeps the URL.
- The questions are ordered by what matters first for the industry chosen; each says why it is asked; two optional
  questions the engine already reads (a structure in mind, expected revenue) are asked rather than defaulted. The
  engine and the rules are unchanged: the order and the wording live on the page.
- The result is a profile with an edit link per answer, a legend of six labels (checked, with conditions, general
  information, to be verified, data missing, specialist review), the structures as pathways, the places as cards with
  a side-by-side table of up to five, and one next action. A three-year figure appears only when both the setup and
  the renewal figures are approved, and is labelled an estimate. A cell with no record says "not on record".
- An approved place also shows its official source link and the facilities on record; both are part of the place's
  approved version (`placeVersion`), so a changed link or a new facilities fact lapses the approval.
- General guidance notes (`packages/core/src/guidance.ts`) are educational wording with no figure, rate, fee or
  statutory verb (a core test enforces the words). Each is a draft until the founder approves its version, a digest
  of its wording, through the same `public_approvals` table (kind `guide`, migration 019); an edited note lapses the
  approval. Unlike a rule, a note has no verification behind it: the founder's approval is the named person's check,
  because the note states nothing about any case. The public sees approved notes only, labelled "general
  information". Selection reads the answers and which structures the public may still see as open, nothing else.
  The word list is a guard, not the control: a general obligation can be phrased past it (the tax note says a
  company "is expected to register" with the Federal Tax Authority), so the founder reads each note before
  approving it, and the review of E7A read every note for UAE accuracy.
- A renewal estimate that exists but is unverified reads "to be verified" on an approved place (never "not on
  record", which is for a missing record): the public view says so with `renewalToBeVerified`.
- The ten acceptance criteria of the E7 contract are tracked in `outcomes/E7A-public-product-ux.md` (Phase 0 table);
  funnel events, reports and dashboards are E7C and E7D, not hidden in this outcome.

**D86. The catalogue is counted once, the evidence says where it came from, and the backlog is the importer's own file.** (E7B, migration 020.)

- Each place is one of six kinds (free zone operating location, sub-zone or specialised district, offshore registry,
  mainland authority, regulated financial centre, non-free-zone industrial development) and in one of three states
  (active, inactive, historical). A sub-zone is a place under its parent authority, recorded as a fact, never a second
  authority; a historical place is kept for the record and counted nowhere. `active` remains the engine's switch and
  follows the status, in the classification service and in the verify-zone path.
- A fact can carry the date the figure takes effect, the exact reference in the source, and whether the source is
  the authority itself or an intermediary. An intermediary's figure is labelled and can be at most a rule of thumb:
  the database refuses a verified fact from an intermediary, and so does the service. The importer and the console
  carry the three fields; the history shows them.
- The verifier's new fields (exact licence activities with their codes, the authority's own charges, conditions and
  exceptions, additional charges and exclusions) are recorded and shown; the engine does not read them. The
  activity check still confirms the activity group only, at the evidence's confidence, and the exact activity is
  confirmed at scoping: matching a founder's words to an authority's codes is a person's judgement until the
  authorities' lists are on record in a machine-readable form.
- The coverage matrix (`packages/core/src/coverage.ts`) is pure: counts by emirate and kind, verification per field,
  expiring evidence, public-display approvals outstanding, and one task per place and field still to obtain, with
  the reason (missing, unverified, stale, due, intermediary). The backlog downloads in the importer's column layout
  with the Value left blank, so what the verifier sends back is what the importer reads, and importing the backlog
  untouched writes nothing.
- The first commercial wave is a priority flag on fifteen places by name, chosen to cover the seven service lines the
  contract names. The seed applies it once (a marker in settings), so a priority the founder clears stays cleared
  across restarts. Two places (KEZAD, JAFZA) are added by name only and stay inactive until their figures are
  recorded. The flag orders the verifier's work; it verifies nothing and changes no figure or recommendation.
- No official page was read in this outcome (the container has no internet access): the data pipeline is ready and
  the backlog names what to obtain; filling it is the named verifier's work, through the importer.

**D87. The funnel is measured in aggregate and anonymously, the scores show their evidence, and the next action is a rule a person can overrule.** (E7C, migration 021.)

- The public page records the stages a browser session reaches (visited, started, each question step, completed,
  viewed, compared, printed, saved) under a random id the browser keeps for the session only. The row holds that
  id, the stage, the step and the attribution the page already sends; never a cookie, an IP, a user agent or a
  contact detail, and no audit or outbox row, because nobody acts on it. One row per visitor, stage and step (a
  unique index), so a repeat never counts twice. The later stages (consultation, lead, qualified, proposal, accepted,
  engagement, revenue) are derived from the platform's records, counted once per request and offer, never sent by
  the browser; a proposal counts as issued once published, whatever became of it later; the pipeline counts a
  request once, at its highest published tier. The review request carries the
  same id in its attribution; it is kept on the lead only (not on the request, not in the audit payload) and the
  funnel joins a lead to its measured session by it, so a lead counts under the label of the session it came from.
  The page says what is measured (owner wording, default labelled). Rows older than 400 days are deleted on every
  retention sweep whether or not the personal-data periods are confirmed, and older than the leads period once they
  are; they hold nothing personal, so this is housekeeping.
- A second review request from the same email and company within a day with the same answers is the same lead: the
  existing lead takes a note, keeps a call request if one is added (the first times given stay), has the consents
  decided this time appended, has its scores recomputed on the merged signals, and nothing else is created or sent: no held enquiry, no account, no request, no
  email. A changed answer, another company or a later day is a new case and a new lead, as before.
- The two scores keep their columns (`intent`, `complexity`) and gain their evidence: the factors and points behind
  each (base 10 plus the points, capped at 100), stored on the lead and shown on its page under the labels purchase
  readiness and commercial value. New
  factors: a start date (one optional question on the selector, read by the scores only), a clear activity,
  investment size, expected revenue, a payroll. The segments are unchanged.
- Erasure and anonymisation clear the adviser's free text on the lead (the override, its reason, the closure
  reason) along with the rest, since an adviser may type a person's details there. For the same reason the
  audit row of an override records only that it changed (`{ overridden }`), never its wording, which lives in the
  erasable lead fields and notes (as follow-ups already do): the audit chain is never edited (rule 8).
- Commercial outcomes (proposals, acceptances, engagements, revenue, pipeline) count once per request, on one
  attributed lead: the one with a measured browser session, then the earliest, then by id, so two leads of one saved
  result (the handoff attaches every one) never double a figure; lead counts stay per lead. A lead whose client
  accepted or is on an engagement leaves the attention list, as the next-action rule already says.
- A visitor's source and campaign are one pair from their first event (first touch wins, as E4 decided for leads),
  never a source from one link and a campaign from another opened later in the same session. A step the visitor
  comes back to is sent again by the page and moves to the end of the sequence on the server (one row per step, a
  fresh id and time, not counted again), so the abandonment breakdown names the question they really stopped at.
- The next best action is a rule over the lead's state (status, readiness, call request, owner, follow-ups, what the
  request became), returning one action and the reason; it is computed on read, never stored, so it is always
  current. The adviser overrides it with a reason, audited; the override is shown beside the rule's suggestion and
  can be cleared. "Qualified" is one expression in one place (`QUALIFIED`), written on the Funnel page.
- The Funnel page (founder and ops) shows every figure from recorded rows: by source and campaign from visitors to
  revenue, completion and abandonment with the last step reached, won and lost with reasons, revenue by segment,
  revenue per qualified lead, days to first contact and to proposal, the high-readiness leads that need a person,
  and realised revenue (payments received) against the pipeline (proposals published and not yet decided). Client
  totals only; finance, clients and partners cannot read it. The demo seeds no funnel rows.

**D88. The assessment report is the page as a document, in two kinds, from the repository's own PDF writer.** (E7D.)

- A report is built in core (`packages/core/src/report.ts`) from the same data the screen reads: the preliminary
  kind from the public view (D80, so only approved statements and figures appear and the rest reads "to be
  verified"), the reviewed kind from the advice a named person approved for the client. Each section the contract
  asks for is there (profile, structures, jurisdictions with evidence labels, rejected alternatives, licences and
  obligations, cross-border risks for a specialist, unresolved questions, the recommendation and its limits, the
  official sources, approved guidance on the preliminary kind, next steps), and the status line on top says which
  kind it is: "PRELIMINARY, not reviewed by a person, not advice" or "REVIEWED by <name> on <date>".
- The PDF is the in-house text writer (D26): monospaced, Latin only, no dependency. A designed document is a later
  choice; the content would not change. The reference on the document is a prefix of the row id, never the
  recovery code, which stays the capability it is.
- The public report is served for a saved result by its code (rate-limited, writing nothing: a download is not a
  return visit, so the recovery count the lead score reads is untouched); the client's
  report is read as the client (row-level security and the column grants decide what they see) with the reviewer's
  name looked up by the platform for that one request. Nothing is emailed; the person downloads it.
- Booking a call is a record on the lead (when, for when, by whom), a status move to consultation, and a follow-up
  due at that time that reaches the queue; no calendar provider (rules 7 and 11, an owner decision). The booker
  owns the lead when nobody did. Times are Gulf Standard Time: the lead page sends the entered time as +04:00 and
  the follow-up note says "GST". A rebooking closes the earlier call's follow-up so the queue shows one call.
  Every lead write that locks the row and then audits takes the audit-chain lock first (the O13 lock order), in
  `loadLead`, so a booking and the handoff's conversion of the same lead queue rather than deadlock; completing a
  follow-up takes it before its note row lock for the same reason (a rebooking closes that row under the chain lock).
- The reviewed report's closing sentence ("every point rests on a verified rule or figure" or "some points are
  unverified") is decided by the labels the report actually prints, not by the advice's flags alone: a renewal
  figure can be unverified while every rule and setup figure is verified.
- The client's report exists for a new-company request only: a services request for an existing company has no
  assessment behind it, so the route answers 404 and the page offers no link (the engine would otherwise have
  compared structures for a company that already exists).

**D89. The pilot is decided from one record, and the development tools are off the advisory list.** (E7E, 3 Nov 2026.)

- The go/no-go for the commercial pilot rests on `docs/evidence/E7E/`: the six pilot journeys run end to end on a
  fresh environment (`apps/api/test/pilot-journeys.test.ts`, one suite, one pilot day, every launch-gate invariant
  asserted at every step), the quality and security regression on the final code with each check marked executed
  here, CI-only or blocked, the staging checklist with a state and an owner for every item, and the decision sheet
  whose human rows stay blank until the named person signs. No cloud resource, spend, message, payment or filing
  came out of writing it; staging stays blocked on the owner's inputs (gap 80) and no live readiness is claimed.
- The six journeys are the six people the pilot has (founder on the public page, adviser, client, partner firms,
  the founder of MKW, the data subject). The contract's own wording for its journeys A to F is held in the owner's
  prompt; if the list differs, the suite is renamed, not rebuilt (an owner decision on the outcome).
- Development tooling (gap 44): vitest 2.1.8 to 4.1.12 with vite pinned at 7.3.7 (vitest 4 accepts vite 6 to 8 and
  the lockfile had kept 5.4, which carries the advisories), tsx 4.19.2 to 4.23.15 (esbuild 0.28.2), playwright 1.49.1
  to 1.64.1, `@types/node` 22.10.2 to 22.20.5 for vite's peer range. All exact (rule 11); `pnpm audit` is clean for
  everything and for production alone. Licences unchanged (MIT, Apache-2.0 for playwright). Every suite was rerun on
  PGlite and PostgreSQL 16 and the smoke test on the new browser driver before this was recorded. To remove: pin the
  previous versions back in the three `package.json` files and reinstall; nothing in the application depends on them.
- A test that builds a second whole environment (the trusted-proxy test) gets a 30-second budget on PostgreSQL: the
  5-second default timed out when two suites shared the server, which is a budget problem, not a defect.

**D90. The quick match is the selector's front door, on the same engine and the same public filter.** (E8, 3 Nov 2026.)

- Four answers (activity, emirate, visas, a budget band) lead to the place to look at first, two alternatives and
  live counts; the eleven-question assessment stays, one click away and prefilled. The owner asked for a simple,
  conversion-first start ("the initial inputs should be simple and helpful ... so that conversion chances are
  high"); the engine needs no new input for it, because the unanswered questions are simply unanswered, as they
  are in the full assessment.
- A count falls only on a conclusion the public may see: a place counts as open unless an approved rule (and, for
  a place rule, the approved place) excludes it. The rule that decides that is the public view's own, now one
  function (`publicStatus` in `packages/core/src/public.ts`) used by both. In the pilot, with few approvals, the
  counts move little; that is the honest reading of D80, not a defect.
- The counts come from the eligibility check over every place on record, not from the advice (which keeps its
  first five fits). The structure, "no option fits" and the ranking come from the full assessment on the same
  answers over every place (its recommended structure first), filtered to the chosen emirate only afterwards, so
  "see the full comparison" never opens on a different structure or conclusion. (An earlier draft ran the engine on
  one emirate's places, which could switch the structure; the independent review caught it and a test now compares
  against the full assessment.)
- An emirate where MKW holds no place on record shows a dash and says so ("we hold no places on record there yet"),
  never "nothing fits": that would be a conclusion no approved rule supports.
- The review request is about the place shown first: its emirate and the place itself go into the request as the
  emirate and "the place you have in mind". The page never sends an emirate the founder did not choose or see;
  "anywhere" is not an emirate (pricing and allocation read the request's emirate).
- No match percentage: the engine gives statuses, so the page shows the status ("fits your answers", "fits, with
  conditions", "to be verified by a person"). The canvas's percentage ring was a design figure.
- Budget bands are AED 15,000, 25,000 and 50,000 and "more, or not sure yet" (`QUICK_BUDGETS`): defaults for the
  owner to change in one place; the full assessment still takes any figure.
- The endpoint allows 240 requests per IP per window (the assessment allows 60), because the page asks again after
  each answer to keep the counts live. It writes nothing; the funnel records the quick steps under the existing
  step stage with `quick_` keys.
- The emirate flags are simplified inline drawings for recognition (no image files, no library), and the map is a
  labelled schematic, "not to scale"; the flags are to be checked against official artwork before launch (gap 107).

**D91. The workspace takes the canvas's look without changing what any screen says or how staff find a page.** (E9, 3 Nov 2026.)

- Built from the design canvas "Tasees App Redesign" on the existing screens, data and markup: the UAE colours above
  the bar, one gold button for the strongest action, a dark summary panel with gold figures, icons in the menus and
  on the staff figures, emirate flags beside a place, and the client's journey tracker. The canvas's invented
  figures (an on-time streak, "cleared today", a readiness ring, a match percentage) are not built: every number on
  a screen still comes from the platform.
- The journey is derived from states the platform already holds (a live engagement's status and approved steps, else
  the newest open request with its advice and offers); a step the platform cannot see is never marked done. Advice
  is a step only when the request has advice to review (pending or approved), never for a services request.
- The staff console keeps the grouped one-row menu decided in O10 (four entries, menus by keyboard), now on a dark
  bar with icons and a gold marker. The owner chose this over the canvas's sidebar on 3 Nov 2026 ("keep the grouped
  staff menu").
  At 1024 px and wider the menu never wraps; the name, search and buttons take a second line first if the bar
  is short of room, so a wider font (as on the CI runner) cannot break the one-row rule.
- The brand mark is T for Tasees only for clients and signed-out visitors; partners and staff see M for MKW Advisors
  (rule 10: nothing addressed to a partner carries Tasees). The browser tab's title follows the same rule, "· MKW
  Advisors" for partners and staff (gap 86 closed). Before the first render after a reload the static page still
  shows the T for an instant, until the session is read.
- System fonts stay (no web font: no new dependency, nothing loaded from a third party on a client's screen).

**D92. Partners see the same look, branded MKW Advisors, with their scorecard first.** (E10, 3 Nov 2026.)

- The partner workspace takes the E9 look: the dark MKW Advisors bar (the phone tab bar stays light, as in U1), the M
  mark, icon tiles, flags beside each emirate, a steps progress bar on the engagement, and one gold action per screen
  (the first offer's Accept on Work, Submit for checking on the next step).
- Performance leads with the quality score on the dark panel, because it decides who gets work (O3 scorecard); the
  on-time rate carries a progress bar; Payouts sums the partner's own payouts by state (due now, paid, not yet
  payable, withheld). Every figure is one the partner already saw; nothing about clients' prices, margins or other
  partners is added (rule 1).
- At 1024 px and wider the partner's menu never wraps either (the rule D91 set for staff).
- The gold Accept goes to the open offer whose reply time ends first; the gold on the next step is asked for by name
  (`milestoneActions(m, { goldSubmit: true })`), never found by matching markup.
- The tab's icon carries the same letter as the mark (T for clients and visitors, M for partners and staff), so a
  partner's browser tab no longer shows the Tasees T.

**D93. The homepage takes the canvas's shape; its figures come from the platform and its prices only from approvals.** (E11, 3 Nov 2026.)

- The public homepage follows the canvas "Homepage" board: a hero with the first question to try, a strip of four
  promises, a card per kind of place, the emirates map, the industries, how it works, what it does and does not
  do, three questions, and a closing call to action. The quick match is the main action; the eleven questions stay.
- A package card shows a "from" figure only when a named person approved at least one place of that kind for public
  display, and then quotes that place by name ("from AED 12,000 at IFZA", `byType` in the quick match, D80), labelled
  checked and "preliminary estimate, as of" the rules' date: the approval is of one place's figures, never a claim
  about the whole kind (independent review). Else "Price to be verified". The canvas's prices were design figures and
  are not used. The counts on the cards and the map are places on record (`onRecord`), not places still open.
- The cards describe each kind by what licenses or registers it, not by what it allows (a benefit is a rule's
  conclusion and needs an approved statement); approved guidance notes remain the place for that.
- The strip's promises are the platform's own ("4 questions", "7 emirates on one map", "1 person checks your case
  before any price", "0 to pay before you accept an offer"); the canvas's "one fixed price" is not used, because a
  review returns priced offers by tier.
- Tapping an emirate on the homepage map starts the quick match with that emirate as the answer to question 2.

**D94. The emirates map is geography: on the Arabic page it keeps west on the left.** (E12, 3 Nov 2026.)

- A right-to-left page flips a CSS grid, which put Abu Dhabi on the right and Ras Al Khaimah on the left. The map's
  grid is laid out left to right on every page; the labels inside each emirate still read right to left in Arabic.
- On the Arabic page the small Arabic name under each emirate is hidden, because the emirate's own name is already
  translated there and would show twice.
- On a phone the map is a two-column list rather than a map, so there it follows the page's direction.

**D95. The public order of places uses approved facts and the founder's answers only.** (E13, the owner's decision of
3 Nov 2026: "Approved facts only".)

- Before, the public list and the quick match followed the engine's order, which uses every status and estimate on
  record, approved or not. An unapproved condition or a lower unapproved estimate could put one place ahead of another
  while the public saw neither, and the quick match made that order a headline ("the place to look at first").
- Now `publicOrder` (`packages/core/src/public.ts`) is the engine's order computed on what the public may see: the
  confirmed structure, the public status, the founder's answers (the place they named, the emirate) and, for an
  approved place only, its approved record (activities, visa package) and lowest estimate; then the name. With
  everything approved (and an estimate on every place) it equals the engine's order; with nothing approved it is the
  answers, then the name. Core tests hold both, and that changing an unapproved place's estimates, activities,
  facilities or visa limits moves neither the order, nor a status, nor the confirmed structure.
- A place no one approved reads "to be verified" unless an approved rule excludes it: never a fit or "data
  unavailable", since which place checks ran, and what its record lacks, come from its unapproved record.
- While any place is unapproved, the structure the public sees is the one the structure rules reach on the answers
  alone (`structureOnRules`). The engine's move to another structure when no place of the first one fits
  (`structure.no_viable_place`), and "no place fits every answer", rest on the places' own figures: the public sees them
  only when every place is approved. Found by the independent review of E13: an unapproved estimate could switch the
  confirmed structure and with it the order. The licences, obligations and cross-border points are then stated for
  that structure too (`statementsFor`, extracted from `advise`; Codex review of E13), so an approved free zone tax
  point is not lost because unchecked figures moved the engine to the mainland.
- An approved place with no estimate on record sorts with the places that have none, not as the cheapest.
- The place the founder named is recognised by its name, its authority or an alias, as in the engine: it is the
  founder's own answer, and the alias only recognises it.
- The public assessment now runs over every place on record (`publicAssessment`), not the advice's first five, which
  the engine chose on everything it holds. The preliminary report and the saved result read the same order.
- The quick match presents a place as "a place worth reviewing first" only when a named person approved it for public
  display; otherwise it shows "places to review", three side by side, with no lead. Counts say "not yet ruled out",
  never that places fit, because a count falls only on an approved exclusion.
- Staff (the review, the offers, allocation) keep the engine's full order. The page's "No preference: show me the best
  value anywhere" became "No preference: anywhere in the UAE".

**D96. The public homepage is the site's front door at `/`; the workspace lives at `/app/`.** (E14, released by the
owner on 3 Nov 2026: "start E14".)

- Before, `/` served the workspace (clients, partners, MKW staff) and the public homepage lived at `/selector.html`, so
  a visitor arriving at the bare address met a sign-in screen. Paid or search traffic needs the product page first.
- Now `/` serves the homepage, `/app/` the workspace (its files are served from there too, so its relative links
  work), and `/intake.html` stays as it is. The workspace path is fixed in code; the domain stays the owner's choice
  (`APP_URL`, DNS: gap 18).
- **Old addresses keep working.** `/selector.html` and `/index.html` redirect permanently, keeping the query (a saved
  result's `?code=`). A link sent before the move (`/#/engagement/…` in an email, `/#/pay/…`) opens the homepage,
  whose first script (`forward.js`, before anything draws) sends it to the same place under `/app/`.
- Email and payment links now point at `APP_URL/app/#/…` directly. Payment links stored before E14 keep the old form
  and are forwarded. While forwarding, the homepage stays hidden and does not load its script, so no funnel visit is
  counted and a partner never sees it.
- The E7C funnel's landing path for the homepage is `/` from E14 on (it was `/selector.html`): a report that compares
  landing pages across the change should read both as the homepage.
- Any other address is a 404 page with the way home, never the workspace. Under `/app/` an unknown path still opens
  the workspace, whose routes are in the fragment.
- **Search.** The public pages carry a canonical link, made absolute from `APP_URL` when it is set. `robots.txt`
  keeps `/app/` and `/api/` out of search, and `/sitemap.xml` lists `/` and `/intake.html` (no sitemap until
  `APP_URL` is set). The workspace and the 404 page carry `noindex`.

**D97. A client's documents come in three groups: needed now, needed later and already sent.** (E15, released by the
owner on 3 Nov 2026: "start E15", after the portal assessment's point on the 13-document upload.)

- Every line's first step asks for its documents when the offer is accepted (O6). So a company with a licence, two
  visas, a bank account and VAT was asked for 13 at once: one intimidating total, some for steps weeks away.
- **The rule** (`documentPlan` in `packages/core/src/documents.ts`, pure). Needed now is:
  - anything sent back;
  - anything for a step due today or already late;
  - the documents for the step due first among those still waiting, with every step due the same day.

  Needed later is the rest, step by step in due order, each with its date. Uploading the current batch brings the
  next one forward, so "now" is never empty while a step not yet approved is missing a document. Already sent is
  what is uploaded or received.
- A document still open on a step the client already approved never counts as needed now. It is listed last among
  the later ones, with "send it only if the firm asks for it again". Found by the independent review of E15: such a
  step, due first, had pushed the documents that hold up real work aside, and the next action said it "cannot
  finish".
- **The next action** counts only what is needed now ("Upload 8 documents" on the demo engagement). It says how many more are needed later (for steps still to come) and
  from when, and carries the most urgent date among the steps it is for. The client's engagement view carries the plan, and the page
  draws it: the documents needed now first, the later ones folded by step with "Expected by", what was sent folded
  last. Early upload stays possible.
- Partners and MKW staff see the documents as before; the plan is the client's.

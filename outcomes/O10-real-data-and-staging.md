# O10 Real data and staging

Status: verified-pending-merge (branch `outcome/O10-real-data-and-staging`, stacked on camayank/mkw-uae-growth#10, 18 Oct 2026)

## Business result

MKW Advisors' own data goes into the platform without retyping, without anyone being emailed, and without a
single unverified figure becoming a fact. The 60 firms on the partner roster appear in the console as
prospects, partners' rate cards load straight from the operating Sheet, the government fee table and the UAE
holiday calendar load from the go-live workbook, and MKW's company details and owner decisions apply through
the same Settings and Rules services a person would use. Clients read the client terms when they accept an
offer, partners read the Partner Network Agreement during onboarding, each marked "Draft, pending legal
review" until the founder records the lawyer's sign-off, and the platform remembers which version each party
accepted. The staging environment in AWS me-central-1 exists as code with a runbook, ready to stand up the day
the cloud account and domain exist. The staff console fits on one line.

## Scope

1. **Importers** (`pnpm import <kind> <file> [--apply]`), one per kind: `partners`, `rate-cards`, `fees`,
   `holidays`, `company`, `decisions`, `legal`. Each:
   - runs as a dry run by default: the same code path as `--apply`, inside a transaction that is rolled back,
     so the dry-run report is exactly what `--apply` would do;
   - is idempotent: a second `--apply` reports every row as unchanged and writes nothing;
   - writes one audit event per created or updated record (actor: the import, source file named);
   - prints a report of created, updated, unchanged and skipped rows, each skip with its reason;
   - takes no notifier and sends nothing; a test proves the notifications table is untouched.
2. **Partners.** From the workbook's Partners tab: a partner organisation per row, status `prospect`, matched
   on Partner ID (`profile.sourceId`, unique) so re-imports update. Emirates and service codes are checked
   against the platform's lists; unknown values are reported, never guessed. Business email, phone, website,
   segment, free zones served, capacity, licence number, authority and declared expiry, approved auditor
   zones and registered liquidator are stored on the profile. `ftaTaxAgent` is never set by an import: a
   person confirms the firm on the FTA register and ticks it in the console ("Likely" and "Yes" are both
   reported as "to confirm"). Fields MKW has changed in the console since (status, FTA, licence checks) are
   not overwritten. A partner admin user is created only when "Admin email" is filled, with the new user
   status `invite_pending`, which cannot sign in; MKW moving the firm to `pilot` activates the user and sends
   the invitation, from "MKW Advisors".
3. **Rate cards.** `rate-cards` accepts the Sheet's real headers ("Professional fee (AED, excl. VAT)",
   "Government fee stated (AED)", "Third-party costs (AED)", "Timeline (working days)") and the short ones,
   from a CSV export or the workbook's "Rate card template" tab. Partners match on Partner ID, then exact name.
   Rows with status Example or Draft, or with a blank professional fee, are skipped and listed.
4. **Government fees.** From the Government fees tab into the fee table. Rows without a fee are skipped.
   A row is `verified` only when "Verified by" is the fee verifier named in Owner-Decisions (row 12), "Verified
   on" is a date and the source is an http(s) link; every other row is UNCERTAIN.
5. **Holidays.** The working-time calendar moves from a code constant to the `holidays` setting
   (date, name, status expected or confirmed, note). Every SLA clock reads it. The founder adds, confirms and
   removes dates on Settings, each change audited; expected dates show as expected.
6. **Company details and owner decisions.** Applied through the existing services: company fields through
   `updateCompany`, margin rules through `scheduleRule` from the next day (earlier offers keep their rules),
   retention through `confirmRetention`, the guarantee through its setting, the verifier names into settings.
   A blank answer changes nothing; an answer that is not "Agree" and cannot be parsed with confidence is
   reported for the owner, not guessed. Decisions the platform holds as code or deployment settings are
   reported as such.
7. **Legal texts.** `legal_documents` holds each version of the client terms and the Partner Network
   Agreement. The client sees the current terms (version, "Draft, pending legal review" until signed off) and
   ticks to accept when accepting an offer; the engagement stores the version. The partner admin reads and
   accepts the agreement on the onboarding page; the firm's profile stores the version. The founder records
   the lawyer's name and date on Settings, which removes the draft note for that version.
8. **Staging as code.** `infra/` (AWS CDK in TypeScript) for me-central-1: VPC, RDS PostgreSQL 16 with
   automated backups, a private encrypted S3 bucket, ECS Fargate running the Dockerfile image behind an HTTPS
   load balancer, secrets in AWS Secrets Manager, `TRUST_PROXY=1`, `DEV_LOGIN` unset, the jobs on an
   EventBridge schedule, and a separate demo service for the smoke test. Validated locally with `cdk synth`.
   `docs/DEPLOY.md` gets the step-by-step staging runbook.
9. **Console menu.** The MKW staff menu groups its fourteen links into four entries: Work and Setup as
   keyboard-accessible disclosure menus, Partners and Dashboard as direct links (a "Money" menu would have held the
   dashboard alone; payout runs live on the Partners page). One row at 1280 px, a compact bar at 390 px.

## Exclusions

- Deploying anything: no cloud credentials, domain or DNS were provided ("not yet"). Nothing is created in AWS.
- Running `--apply` against any staging database (there is none yet); the owner sees the dry-run reports first.
- The Prospect pool tab (not imported, by instruction).
- Google Maps ratings, review counts and the roster's priority score and routing rank (not stored).
- Bank account details (entered by the founder on Settings, never imported).
- Changing the fairness cap, deposit or quality bar: they are code constants today; answers are reported.

## Acceptance evidence

- `apps/api/test/import.test.ts`: per importer, dry run writes nothing, apply writes, a second apply reports
  every row unchanged and adds no audit events, no notification rows are created, bad rows are reported with
  reasons; the real Sheet header row parses.
- `apps/api/test/legal.test.ts`: acceptance stores the terms version; a stale version is refused; the partner
  accepts the agreement; sign-off clears the draft note and is founder-only and audited.
- `apps/api/test/legal.test.ts` ("holiday calendar") and `import.test.ts` ("holidays"): a loaded holiday moves an
  SLA deadline and stops the ops digest; holiday edits are founder-only and audited.
- Partner status `invite_pending` cannot sign in; moving to pilot activates and invites (test).
- Dry-run reports of the real workbook under `docs/evidence/O10/` with contact details removed.
- `scripts/smoke.mjs` passes with screenshots of the grouped menu, the holiday and legal sections of Settings,
  the terms at acceptance and the agreement in onboarding, at 1280 px and 390 px, axe-core clean.
- `pnpm --dir infra synth` produces a CloudFormation template.

## Dependencies and owner decisions

Depends on O1–O9 (merged). Owner-Decisions.md and MKW-Company-Details.md arrived blank apart from the three
email addresses, so every decision keeps today's value and stays UNCERTAIN where it shows. Needed from the
owner: AWS account access, the domain and DNS, the SES sender verification, the named fee verifier, and the
lawyer's sign-off on both legal texts.

## Risks

- A wrong mapping silently puts a firm on services it does not offer: mitigated by refusing unknown codes and
  by every firm staying a prospect until MKW reviews it.
- An import that emails 60 firms: the importers take no notifier, invitations only happen on the pilot move,
  and a test counts notification rows.
- Real contact data in the repository: `data/import/` is ignored by git, and evidence files are redacted.
- Staging code that has never met AWS: `cdk synth` checks structure, not behaviour; the first deployment
  follows the runbook step by step.

## Rollback

Migration `010_real_data.sql` is additive (a table, a column, an index, one widened check). Reverting the
branch leaves imported rows in place; they are ordinary partner, rate card, fee and settings rows that the
console edits or removes. The holiday setting falls back to no holidays if the key is absent.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 51 core + 184 API = 235 (O9: 199), all passing on PGlite and on PostgreSQL 16; `pnpm typecheck` clean; `pnpm build` compiles; `apps/api/test/import.test.ts` (30), `apps/api/test/legal.test.ts` (6) |
| Importers | per importer: dry run writes nothing, `--apply` writes, a second apply is all "unchanged" with no new audit events, the notifications table is untouched, bad rows are skipped with reasons; the real Sheet header row parses; hostile workbooks are refused within the test's 3-second bound |
| Real data | dry runs of the five supplied files, redacted by the importer: `docs/evidence/O10/*.md` (partners 60 created; holidays 14 created; fees 29 skipped, no fee yet; rate cards 2 skipped, drafts; company 9 unchanged, 3 skipped; decisions 22 unchanged; client terms and partner agreement version 1 each) and the CLI refusing an unnamed, missing or unmigrated target (`docs/evidence/O10/README.md`) |
| Invitations | `invite_pending` users get no sign-in code; moving the firm to pilot activates them and sends one invitation from "MKW Advisors"; deactivating cancels a held invitation; reactivation refuses one |
| Legal | acceptance stores the terms version on the engagement; a stale or missing version is refused (409); the partner admin accepts the agreement; the founder's sign-off clears the draft note for that version only, audited |
| Holidays | a loaded holiday moves an SLA deadline and stops the ops digest; holiday edits are founder-only and audited; re-imports never undo the founder's calendar |
| Staging | `pnpm --dir infra synth:check` synthesises `TaseesStaging` and `TaseesDemo` for me-central-1 (also a CI job); three processes migrating one PostgreSQL 16 database at once apply each file once |
| Screens | `docs/evidence/O10/`: `61-console-menu.png`, `62-settings-legal-holidays.png`, `63-ops-imported-prospect.png`, `64-partner-agreement.png`, `07-client-offer.png` (1280 px); `65-mobile-console-menu.png`, `66-mobile-settings-legal.png`, `67-mobile-partner-agreement.png` (390 px) |
| Smoke and accessibility | `docs/evidence/O10/log.txt` (all checks OK against a freshly seeded demo); axe-core WCAG 2.1 AA zero violations on 22 screens including the six O10 screens at both widths (`docs/evidence/O10/axe.json`); keyboard: the menus open with Enter or Space, close with Escape and when focus leaves them |

## Could not verify

Anything in AWS: `cdk synth` checks the template, not a deployment, and the container image was not built locally (no
Docker daemon here; CI builds it). The real data loaded with `--apply` into a running platform (only into a scratch
copy, rolled back). The legal texts' content (the lawyer's job), the fees and the FTA register status of each firm.
Screen-reader behaviour beyond what axe-core checks.

## Review

A reviewer who had not seen the build read the contract and the diff in a separate worktree (18 Oct 2026) and ran
the new tests. Nine should-fix findings, all fixed with a test unless noted:

| Finding | Fix | Evidence |
| --- | --- | --- |
| A 580-byte crafted workbook (row 300,000,000, column AAAAAA, unclosed rows) hangs or exhausts the reader | Linear scanning with indexOf; caps on rows, columns, cells and total size; only the tabs asked for are unpacked | `import.test.ts` "refuses hostile workbooks quickly" |
| The dry run of `all` ran each kind in its own transaction, so rate cards could not see partners created just before | `import all` runs every step in one transaction; applying is all or nothing | "several importers at once" |
| The importer migrated the target database even on a dry run, and silently used an empty local database | Never migrates; refuses a database with pending migrations; requires `DATABASE_URL` or an existing `PGLITE_DIR` | CLI run in `docs/evidence/O10/README.md` |
| A re-import undid console changes (verified or retired fees, the founder's holidays, ops edits to a prospect, partner portal rate cards) | The console is the record: partners merge three ways against what the file said last; fees, holidays and rate cards changed by a person are kept and reported | "keeps what MKW changed…", "never undoes the console…", "keeps the founder's calendar…", "does not overwrite a card…" |
| A fee with no effective date became a new row every day | A blank date matches the latest live row for that code and place | "a fee with no effective date is the same row tomorrow" |
| A held invitation could not be cancelled, and reactivation skipped the pilot gate | Deactivating cancels it; reactivation refuses a held one | "a held invitation can be cancelled…" |
| Staging with `EMAIL=console` would write sign-in codes to CloudWatch | The console transport masks six-digit runs; the runbook signs the founder in after SES | "the console email transport never writes a sign-in code…" |
| A spreadsheet cell could make a fee verified with no accountable person; any text counted as the verifier's name | Verified only when the import runs as the founder (`--as`, the audited actor); only a person's name counts | fee tests; "only a person's name counts as a verifier" |
| App, jobs and one-off tasks could run the same migration at once on first deploy | Each file in a transaction under an advisory lock, re-checked first | three processes migrating one PostgreSQL 16 database at once: 2 + 2 + 6 files, no error |

Nits fixed: the RDS bundle download is pinned by checksum; a non-numeric version on the sign-off route is a 400; dates
are checked for real (no 30 February, no month 13, no stray serial numbers); redaction keeps dates; an unknown Partner
ID is never matched by name and a shared name is refused; the holiday Confirm keeps the note and both buttons name
their date; an open menu closes when focus leaves it; the contract now names the menus as built and points to the
holiday tests where they live. Left as a known gap: the static storage key (D49, KNOWN-GAPS 25).

Found while getting the final smoke run green: (1) axe-core at 390 px flagged the Settings delivery log, a table that
scrolls sideways with nothing inside it a keyboard can reach; such tables now become a named region that takes focus
(tables that fit get no extra tab stop). (2) The smoke test's own waits used Playwright's `waitForFunction`, whose
in-page polling the content security policy refuses, so any wait not already true failed at once; the smoke test now
polls from Node, and its fixed pauses before positive checks became waits for the condition (checks that something is
absent stay one-shot, so they cannot pass before the page draws). (3) The console transport's code masking also hid
invoice numbers in development logs; it now masks only standalone six-digit runs (test added).

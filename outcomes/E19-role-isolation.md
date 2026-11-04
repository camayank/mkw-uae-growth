# E19 Role isolation: each party and each person sees only theirs; the app logs in as a role that owns nothing

Status: verified-pending-merge (branch `outcome/E19-role-isolation`, on `main` at 95ee18d with E18 merged; released
by the owner on 4 Nov 2026: "start E19", the four security problems the paused baseline audit's independent review
found.)

## Business result

- A partner firm never learns what another firm charges.
- A partner firm's staff work the steps without seeing what the firm is paid.
- A compromised application process cannot reach past the rules the database enforces: it cannot read without a
  role, add or switch off a guard, rewrite the audit trail or skip a migration.

These are the conditions an outside security reviewer and a partner firm will check before the pilot.

## The defects, reproduced first

`apps/api/test/role-isolation.test.ts` was written before any fix and run against `main` at 95ee18d. Two tests failed
(`docs/evidence/E19/before-fix.txt`):

1. **One partner firm read the cost another firm put on its change order** on an engagement they both deliver. The
   change orders policy let every party read every change order, and partners are granted `partner_fils`.
2. **Partner staff were sent money figures:** payouts, payout lines and totals on offered work, rate-card amounts,
   and dashboard payout totals. The product spec gives partner staff no money figure.

The other two were checks, not defects. Both passed on the old code and are now tested:
- signing out ends that session only, and a session past its time is refused;
- a client member reads the offer, the engagement and the statement with no partner cost or margin.

The fourth problem is the database login. Staging logged in as the RDS master user, which owns every table, so a
compromised process could `RESET ROLE`, read anything, disable a trigger or edit the audit trail.
`runtime-login.test.ts` shows each of these is refused for the new runtime login.

## Scope

1. **Migration 024:** a partner firm reads only the change orders it raised; the client reads all of its own. The
   engagement view filters the same way.
2. **Partner staff and money.** No payout, payout line, payout total, rate-card amount, change-order cost or
   government fee reaches partner staff (`partnerHome`, `partnerDashboard`, `partyEngagement`). On their screens:
   - the work list, the performance page, the rate card and the engagement leave those columns, tiles and panels
     out, and say the admin sees them;
   - the Payouts page leaves their menu.
3. **Migration 025:**
   - `app_runtime`: owns nothing; may switch to the three application roles but never inherits them
     (`with inherit false, set true`); reads the migration list;
   - the audit trail becomes append-only for every application role: update, delete and truncate are revoked, and a
     trigger refuses them, even for the owner.
4. **Migration 026 (from the independent review):**
   - the application roles lose TRIGGER and REFERENCES on every table, every right on the migration list, and
     temporary objects;
   - every security-definer function's search path is pinned.
5. **`apps/api/src/lib/db.ts`:**
   - `loginOwnsSchema` and `prepareDatabase`: the owner migrates (development, tests, the demo). In production the
     owner is refused and the runtime login only checks that the schema is current;
   - `ensureRuntimeLogin`: create or update the login, check its attributes, clear its own settings. It works as a
     non-superuser owner (RDS);
   - `scramVerifier`, so the password never appears in a statement.
6. **`apps/api/src/scripts/migrate.ts`** (`pnpm migrate`): the migration step, run as the owner. The app, the jobs and
   `create-founder` use `prepareDatabase`; the importers' messages point at the migration step.
7. **Staging (`infra/`):**
   - `AppDbSecret` for the runtime login: the app and the jobs use it;
   - each app task starts with a `migrate` container that alone holds the master secret, and the app container
     waits for it to succeed. Every deploy, the first included, is one step;
   - only the execution role can read the master secret;
   - the restore drill creates `app_runtime` and its memberships.
8. **Docs:** D101, gaps 142–144, the security brief, the deploy runbook, the queue (E18 merged).

## Exclusions

- **Separate database roles for ops and finance, or for partner admin and staff** (gap 142). Within one party the
  split is in the API, and every path is now tested.
- **Comparing the audit chain's length night to night** (gap 143).
- **Stopping the runtime login from changing its own password or settings** (gap 144). PostgreSQL allows it; the next
  migration step resets both.

## Acceptance evidence

`docs/evidence/E19/`:

| Check | Result | File |
| --- | --- | --- |
| The reproduction on the old code | 2 of 4 failed (the two defects); sign-out, expiry and client member passed (tested, not broken) | `before-fix.txt` |
| `pnpm typecheck` | clean | `tests-pglite.txt` |
| `pnpm test` (PGlite) | core 159 passed (19 files); API 404 passed, 7 skipped (the PostgreSQL-only tests; 41 files) | `tests-pglite.txt` |
| API suite on PostgreSQL 16 | 411 passed (41 files); verbose list of the E19, tamper and concurrency tests (56) | `tests-postgres16.txt` |
| Staging stack | `synth:check` passes. The template shows: the app container waits for the `migrate` container; only `migrate` holds the master secret; only the execution role can read it; the jobs use the runtime login | `synth.txt` |
| Browser smoke on a fresh demo | 337 checks, 0 failed (7 new for E19); partner staff signed in for the first time: no Payouts menu, no AED on work, performance and rates, phone width with axe | `smoke-log.txt`, `screens/` |

The tests that prove each claim, on PostgreSQL 16 (`runtime-login.test.ts`, `role-isolation.test.ts`):
- **A whole engagement as a fresh runtime login:** request, offer, acceptance, payment, allocation, every step
  delivered and approved, the jobs and the nightly audit check.
- **What that login cannot do:** read without a role, read after `RESET ROLE`, change the audit trail, switch off or
  add a trigger, create temporary code, or write the migration list.
- **The migration step run twice as a non-superuser owner,** as on RDS. The second run clears a default role the
  login gave itself.
- **The owner refused in production.**
- **The SCRAM verifier** equals Python's computation.
- **No application role holds TRIGGER or REFERENCES** on any table, or temporary rights. With migration 026 removed,
  this test fails.

## Independent review

An independent reviewer probed the branch on a PostgreSQL 16 set up like RDS: a non-superuser owner and password
logins. Found and fixed, each with a test:

- **(Blocking) The migration step failed on its second run on RDS.** `ALTER ROLE ... NOSUPERUSER` is refused to a
  non-superuser. The login is now altered without naming SUPERUSER, and its attributes are checked afterwards.
- **(Blocking) The runtime login could still rewrite the audit trail.** As the platform role it could add a trigger to
  `audit_events` that ran as the owner inside the security-definer `audit_append`, then switch the guard off. It could
  also change the migration list. Migration 026 closes both.
- **(Blocking) "Run the migration task, then deploy" could not work,** because the new image exists only after the
  deploy. The migration step now runs in each app task, before the app container.
- **`app_runtime`'s memberships** now name `inherit false`. The restore drill grants them.
- **The partner staff engagement screen** no longer shows payouts, fees, change-order costs or government fees.
- **The importers' messages** point at the migration step.
- **The SCRAM verifier and the truncate trigger** are now tested directly.

Recorded: the runtime login can change its own password or settings (gap 144).

## Codex review

Two findings, both fixed:
- **A fresh development database no longer migrated on start.** With no tables yet, the owner looked like the
  runtime login. Owning the database now counts as being the owner; a PostgreSQL test migrates a fresh database on
  start.
- **Migration 025 used PostgreSQL 16 grant options** although 15 is supported. The grant now depends on the server
  version (executed as a string, so 15 never parses the 16-only options), and the group is also set NOINHERIT, which
  is what 15 goes by. The restore drill does the same. Only PostgreSQL 16 was available to run it on.

## Dependencies

E18 (merged).

## Risks

- **A migration step that fails** leaves the new app task's app container unstarted, and the deployment circuit
  breaker rolls back. The old tasks keep serving.
- **On the first staging deploy,** a scheduled jobs run may start before the runtime login exists and fail once. The
  runbook says so.

## Owner decisions

- **Open:** separate database roles within a party (D101, gap 142). The recommendation is to keep the API split, now
  tested, unless the outside security reviewer asks for the database layer too.

## Rollback

Revert the merge.
- Migration 024's policies are replaced by the old one with `create policy co_party ...` from migration 001.
- Migrations 025 and 026 only remove rights the reverted code does not use, so they can stay.
- To roll back the login, point the app's secret at the master user again, which the reverted code accepts.

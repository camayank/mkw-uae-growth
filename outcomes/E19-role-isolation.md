# E19 Role isolation: each party and each person sees only theirs; the app logs in as a role that owns nothing

Status: verified-pending-merge (branch `outcome/E19-role-isolation`, on `main` at 95ee18d with E18 merged; released
by the owner on 4 Nov 2026: "start E19", the four security problems the paused baseline audit's independent review
found.)

## Business result

- A partner firm never learns what another firm charges.
- A partner firm's staff work the steps without seeing what the firm is paid.
- A compromised application process cannot reach past the rules the database enforces: it cannot read without a
  role, switch a guard off or rewrite the audit trail.

These are the conditions an outside security reviewer and a partner firm will check before the pilot.

## The defects, reproduced first

`apps/api/test/role-isolation.test.ts` was written before any fix and run against `main` at 95ee18d. Two tests failed
(`docs/evidence/E19/before-fix.txt`):

1. **One partner firm read the cost another firm put on its change order** on an engagement they both deliver. The
   change orders policy let every party read every change order, and partners are granted `partner_fils`.
2. **Partner staff were sent money figures:** payouts, payout lines and totals on offered work, rate-card amounts,
   and dashboard payout totals. The product spec gives partner staff no money figure.

The other two items were checks, not defects. Both passed on the old code and are now tested:
- signing out ends that session only, and a session past its time is refused;
- a client member reads the offer, the engagement and the statement with no partner cost or margin.

The fourth problem is the database login. Staging logged in as the RDS master user, which owns every table. A
compromised process could `RESET ROLE` out of its per-request role, read anything, disable a trigger or edit the
audit trail. `runtime-login.test.ts` shows each of these is refused for the new runtime login.

## Scope

1. **Migration 024:** a partner firm reads only the change orders it raised; the client reads all of its own. The
   engagement view filters the same way.
2. **Partner staff and money.**
   - The API (`partnerHome`, `partnerDashboard`, `partyEngagement`) sends partner staff no payout, payout line, payout
     total, rate-card amount or change-order cost.
   - Their screens leave those columns and tiles out and say the admin sees them. The Payouts page leaves their menu.
3. **Migration 025.**
   - `app_runtime`: owns nothing and may only switch to the three application roles; it reads the migration list.
   - The audit trail becomes append-only for every application role: update, delete and truncate are revoked, and a
     trigger refuses them.
4. **`apps/api/src/lib/db.ts`.**
   - `loginOwnsSchema` and `prepareDatabase`: the owner migrates (development, tests, the demo). In production the
     owner is refused, and the runtime login only checks that the schema is current.
   - `ensureRuntimeLogin`, with `scramVerifier`, so the password never appears in a statement.
5. **`apps/api/src/scripts/migrate.ts`** (`pnpm migrate`): the migration step, run as the owner. The app, the jobs and
   `create-founder` use `prepareDatabase`.
6. **Staging (`infra/`).**
   - `AppDbSecret` for the runtime login: the app and the jobs use it, and only the new migration task holds the
     master secret.
   - The `appDesiredCount` setting lets the first deploy run before the login exists.
   - The restore drill creates `app_runtime`.
7. **Docs:** D101, gaps 142–144, the security brief, the deploy runbook, the queue (E18 merged).

## Exclusions

- **Separate database roles for ops and finance, or for partner admin and staff** (gap 142). Within one party the
  split is in the API, and every path is now tested.
- **Comparing the audit chain's length night to night** (gap 143).
- **A deploy pipeline that runs the migration task itself** (gap 144).

## Acceptance evidence

`docs/evidence/E19/`:

| Check | Result | File |
| --- | --- | --- |
| The reproduction on the old code | 2 of 4 failed (the two defects); sign-out, expiry and client-member passed (tested, not broken) | `before-fix.txt` |
| `pnpm typecheck` | clean | `tests-pglite.txt` |
| `pnpm test` (PGlite) | core 159 passed (19 files); API 402 passed, 5 skipped (the PostgreSQL-only tests; 41 files) | `tests-pglite.txt` |
| API suite on PostgreSQL 16 | 407 passed (41 files): a whole engagement as the runtime login, the owner refused in production, what the login cannot do | `tests-postgres16.txt` |
| Staging stack | `pnpm --dir infra synth:check` passes; the template shows the app and jobs on the runtime secret and only the migration task on the master's; `appDesiredCount=0` synthesises | `synth.txt` |
| Browser smoke on a fresh demo | 337 checks, 0 failed (7 new for E19); partner staff signed in for the first time: no Payouts menu, no AED on work, performance and rates, phone width with axe | `smoke-log.txt`, `screens/` |

## Dependencies

E18 (merged).

## Risks

- **A deploy that forgets the migration task** starts app tasks that refuse to start, naming the missing migration.
  The deployment circuit breaker rolls back. The runbook and gap 144 say so.
- **The first staging deploy changes order:** no app task, then the migration task, then the app. It is written in
  `docs/DEPLOY.md` step by step.

## Owner decisions

- **Open:** separate database roles within a party (D101, gap 142). The recommendation is to keep the API split, now
  tested, unless the outside security reviewer asks for the database layer too.

## Rollback

Revert the merge.
- Migration 024's policies are replaced by the old one with `create policy co_party ...` from migration 001.
- Migration 025's role and triggers can stay. To roll back the login, point the app's secret at the master user
  again, which the reverted code accepts.

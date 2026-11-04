# E21 Remaining isolation and state rules: the audit trail, downloads and every status move

Status: verified-pending-merge (branch `outcome/E21-audit-and-state-rules`, from `main` at 0b16552 with E20 merged;
released by the owner on 4 Nov 2026: "start E21". It covers the transformation mandate's P0-01, item 1.2, as
`docs/transformation/ROADMAP.md` orders it.)

## Business result

- **The audit trail.** No application role can write an audit event except through `audit_append`, or write, change
  or remove a nightly check. A removed or rewritten tail of the trail is found the next night, even after new events
  have made the trail longer again.
- **Downloads.** Each of the six download routes that had no such test is now tried by every party it does not belong
  to, and refused.
- **Status changes.** Requests, payouts and change orders change status only through the one checked
  `transition()`, as milestones, offers and engagements already did. Each move is audited. A closed request is never
  priced again; before this outcome, the client could accept a second engagement on it.

## Scope

1. **Audit events (S6, gap 148, R20).** Migration 027:
   - revokes insert on `audit_events`, and every right on its id sequence, from the application roles;
   - makes the platform's policy read-only;
   - adds a trigger that refuses an insert by any application role, including one granted the privilege later.
2. **The nightly check (S4, gaps 143 and 148, R8).**
   - `audit_checks` is append-only: no application role may insert, update, delete or truncate it, and a trigger
     refuses any change or removal.
   - The database records each check itself, through `audit_check_run()` (security definer). It verifies the chain,
     keeps the last event it saw (id and hash), and compares the result with the latest earlier check:
     - `changed`: an event no longer matches its hash or link;
     - `tail_removed`: the last event of the previous check is missing or different;
     - `shortened`: the chain has fewer events than the night before (the only comparison for a check from before
       E21, which kept no last event).
   - A finding opens a critical alert that names it, and the System page shows it.
   - The check's day is never later than the real clock, so the test clock (a session setting) cannot record a later
     day's check ahead of time.
3. **Download refusal tests (gap 145, R4).** `downloads.test.ts` covers:
   - the evidence file;
   - the invoice PDF;
   - the offer PDF;
   - the coverage backlog CSV;
   - the payout bank file;
   - the accounting export.

   Each route is tried by its owner, by another client, by a partner firm (on the engagement or not, as fits), by
   partner staff where relevant, and anonymously. No refusal carries the file's bytes.
4. **Transition tables (S5, gap 146, R7).**
   - `packages/core/src/states.ts` adds the request, payout and change-order machines, and `STATUSES`, every status
     each machine's row may hold.
   - `transition()` handles the three, with their timestamps.
   - The ten direct status writes go through it, each with an audit event:
     - requests: built, quoting, offered, closed;
     - payouts: eligible by rule, released singly or by run, withheld on a refund;
     - change orders: decided.
   - Two guards follow from the machine: a request whose offer was accepted is never priced or quoted again, and a
     change order is decided once.
   - The source test (`transitions.test.ts`) now fails if any code outside `transition()` sets one of the six
     statuses.
   - A check constraint on each of the five status columns that lacked one (payouts had one). A test compares each
     constraint with `STATUSES`.

## Exclusions

- **Payments, payout runs, document requests, obligations and leads** keep their direct status writes. Each column has a
  check constraint, and each service checks the status it expects. Gap 149 records them for the agent's tool
  boundary (E25).
- **No database-level transition guard.** Code outside `transition()` is caught by the source test, not by the
  database (gap 150).
- **The database owner can still rewrite both the trail and its checks.** The master secret is needed for that. An
  anchor outside the database is the remaining step (gap 143, narrowed).
- **No new screen.** The System page's audit row shows the new findings.

## Acceptance evidence

`docs/evidence/E21/`:

- **`before-fix.txt`.** The new tests on `main` at 0b16552: 12 failed. A probe on the same code shows the closed
  request defect: offers rebuilt on a closed request, published, and accepted as a second engagement on the same
  request.
- **`tests-pglite.txt`.** Core 159 passed (19 files). API 421 passed, 7 skipped (43 files).
- **`tests-postgres16.txt`.** API 428 passed (43 files), on PostgreSQL 16.15, with the runtime-login suite.
- **`typecheck.txt`.** Clean.
- **`smoke-log.txt`.** 337 checks and 60 axe scans passed, on a fresh demo. They include the System page with the
  audit chain checked and "intact".
- **`screens/79-system.png` and `screens/80-mobile-system.png`.** The System page at 1280 and 390 px.

The new and changed tests:
- `audit-guard.test.ts` (7);
- `downloads.test.ts` (6);
- `transitions.test.ts`: four new tests, and the generic tests now run every move of all six machines on real rows;
- `runtime-login.test.ts`: a forged insert and a forged check row, as the runtime login;
- `hardening.test.ts`: it clears check rows as the owner.

## Business invariants touched

- **Rule 8 (append-only audit).** Strengthened: insert is now guarded, and checks are append-only. Every request,
  payout and change-order move is now audited. Before, no request move had its own event, nor did a payout becoming
  eligible or being withheld.
- **Rule 6 (no unattended side effects).** Unchanged: payouts become eligible by the same tested rule (actor null,
  `payout.eligible`); finance alone releases.
- **Rule 1 (money privacy).** Unchanged, with six more routes now proven.

## Dependencies

E20 (merged).

## Risks

- **A status move a flow needs that the table does not list.** Mitigated:
  - every direct write was mapped to a move first;
  - `quoting → closed` is listed because offers published earlier stay open while quotes are awaited;
  - the full suite (26 contract scenarios, pilot journeys A–F) and the smoke pass.
- **Lock order.** Every new `transition()` call takes the audit chain first, then the row; an RFQ now moves the
  request before inserting rows that refer to it.
- **Check constraints on existing data.** Staging and production hold no data yet, and the migration fails loudly if
  a row breaks a constraint.

## Owner decisions

None needed. Open, unchanged: T4 to T8.

## Rollback

Revert the merge. Migration 027 only adds things: grants revoked, triggers, a function, columns and constraints. A
follow-up migration can restore the grants. Code rolled back to before E21 still runs against a migrated database,
with one exception: the old nightly check inserts into `audit_checks` directly, which is now refused, so that step
fails and opens its "step failed" alert. Nothing else the old code does is refused.

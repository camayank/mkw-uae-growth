# E17 Sign-in lockout: a wrong code is counted, and every failure reads the same

Status: verified-pending-merge (branch `outcome/E17-sign-in-lockout`, on `main` at 71ae116 with E16 merged; released
by the owner on 3 Nov 2026 in the transformation mandate, Phase 1.1: "Investigate the reported OTP failure-counter
rollback… Begin with the OTP security defect and write a failing reproduction test")

## Business result

Nobody can sign in to a client's, partner's or MKW staff member's account by guessing the six-digit code: five wrong
guesses spend the code, guesses sent at the same moment cannot get past five, and the answer to a failed sign-in never
tells whether an email has an account.

## Scope

1. `verifyLoginCode` (`apps/api/src/lib/auth.ts`):
   - It reads the code's row `for update`.
   - A wrong guess is counted and the refusal is returned rather than thrown, so the count is committed.
   - After five wrong guesses the code is spent.
   - Every failure gets one message.
2. A regression test (`apps/api/test/sign-in.test.ts`), written first and failing on the old code.
3. Docs: D99, the security brief's sign-in row, and gap 13 (the per-address throttle is still per process).

## Exclusions

- A shared rate-limit store for the per-address throttles (gap 13). The per-code limit no longer depends on it.
- Session expiry and sign-out are unchanged and already covered by `security.test.ts`, which passes on both databases.

## Acceptance evidence

`docs/evidence/E17/`:

- `before-fix.txt`: the new tests run against the old code. Three of the four fail:
  - the count stays at 0 after a wrong code;
  - twelve simultaneous wrong guesses leave it at 0;
  - the three failures give three different answers, and after six wrong guesses the right code still signed in
    (HTTP 200 with a session; the token is redacted).
- `tests-postgres16.txt`: `sign-in.test.ts` and `security.test.ts` on PostgreSQL 16: 12 passed.
- `tests-pglite.txt`: `pnpm test` gives core 154 passed and API 374 passed, 1 skipped (38 files).
- `typecheck.txt`: clean.
- Smoke: `scripts/smoke.mjs` against a fresh demo: 326 checks OK, 0 failed, unchanged (`smoke-log.txt`).

## Dependencies

None. No new library, no migration.

## Risks

- **A person who mistypes five times must ask for a new code.** That is the intended limit, and they can ask again,
  up to 5 codes an hour.
- **The single message is less specific** ("not right or has expired"). That is the price of not revealing accounts.

## Owner decisions

None.

## Rollback

Revert the merge. No data or migration depends on it.

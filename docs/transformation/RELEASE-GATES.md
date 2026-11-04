# Release gates

There are three gates. Each lists what must be true and where the evidence lives. A gate is passed only with its
evidence; a blank is a no.

## Gate 1: an outcome's pull request is ready to merge

Every outcome passes this before its status is set to `verified-pending-merge` (CLAUDE.md, "How work is done"):

| # | Check | Command or place |
| --- | --- | --- |
| 1 | Typecheck clean | `pnpm typecheck` |
| 2 | Unit tests | `pnpm test` (core) |
| 3 | API and integration tests on PGlite | `pnpm test` (API) |
| 4 | API tests on PostgreSQL 16, where the change touches the database, roles, locks or concurrency | `TEST_DATABASE_URL=… pnpm --filter @tasees/api test`; CI job `postgres` |
| 5 | Security regression: the money-privacy and isolation tests still pass, and new paths get their own | `security.test.ts`, `role-isolation.test.ts`, `runtime-login.test.ts`, and the tests named in the outcome |
| 6 | Browser smoke for changed screens on a fresh demo | `node scripts/smoke.mjs` |
| 7 | Phone width and accessibility for new screens | smoke (390×844, axe), plus screenshots at desktop and phone width |
| 8 | Actual outputs recorded | `docs/evidence/<outcome>/` |
| 9 | Business invariants unchanged | the rules in CLAUDE.md; the outcome file says which ones it touches |
| 10 | CI green on the pull request's head | GitHub |
| 11 | Independent review agent run, and Codex findings handled | the outcome file's review sections |
| 12 | `docs/KNOWN-GAPS.md`, `docs/DECISIONS.md` and the transformation documents updated | the pull request |
| 13 | Infrastructure synthesises, where the change touches `infra/` | `pnpm --dir infra synth:check`; CI job `infra` |

A document-only outcome runs checks 1–3 and 10–12 locally and says so. It relies on CI (check 10) for the browser
smoke on its head, as CLAUDE.md's smoke requirement is met there.

The owner merges. A merge deploys nothing.

## Gate 2: the commercial pilot starts

This is the existing go/no-go record, `docs/evidence/E7E/GO-NO-GO.md`, which the transformation does not change. In
short:
- every platform row passes on the final code;
- staging runs in the UAE region with a health check, delivered email, a stored file, a received alert and a restore
  drill from a real backup;
- the app runs there as the runtime login (E19);
- every human row is signed: owner decisions, lawyer, tax adviser, fee and rule verifiers, public display, outside
  security reviewer, Arabic reviewer (if Arabic launches), three signed partners with rate cards, and five consenting
  clients.

The transformation adds three conditions for any AI capability used in the pilot:
- the provider decision (T5) is recorded, with the monthly cap configured and tested;
- the evaluation suite (E29) has been run on the pilot's code, with its measured results recorded;
- every consequential agent action is shown, by test, to stop for a person's approval.

Today: **NO-GO** (staging is blocked, and every human row is blank).

## Gate 3: production

After the pilot, production needs:
- the pilot report's measures (GO-NO-GO section 4);
- every finding of the outside security review fixed, each with a test that failed before the fix and passes after;
- the owner's written go.

Today: not started.

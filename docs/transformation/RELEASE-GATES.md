# Release gates

Three gates, each with what must be true and where the evidence lives. A gate is passed only with its evidence; a blank
is a no.

## Gate 1: an outcome's pull request is ready to merge

Every outcome, before its status is set to `verified-pending-merge` (CLAUDE.md, "How work is done"):

| # | Check | Command or place |
| --- | --- | --- |
| 1 | Typecheck clean | `pnpm typecheck` |
| 2 | Unit tests | `pnpm test` (core) |
| 3 | API and integration tests on PGlite | `pnpm test` (API) |
| 4 | API tests on PostgreSQL 16 where the change touches the database, locks or concurrency | `TEST_DATABASE_URL=… pnpm --filter @tasees/api test`; CI job `postgres` |
| 5 | Security regression: the money-privacy and isolation tests still pass, and new paths get their own | `security.test.ts` and the tests named in the outcome |
| 6 | Browser smoke for changed screens on a fresh demo | `node scripts/smoke.mjs` |
| 7 | Phone width and accessibility for new screens | smoke (390×844, axe) and screenshots at desktop and phone width |
| 8 | Actual outputs recorded | `docs/evidence/<outcome>/` |
| 9 | Business invariants unchanged | the rules in CLAUDE.md; the outcome file says which it touches |
| 10 | CI green on the pull request's head | GitHub |
| 11 | Independent review agent, and Codex findings handled | the outcome file's review sections |
| 12 | `docs/KNOWN-GAPS.md`, `docs/DECISIONS.md` and the transformation documents updated | the pull request |

A document-only outcome runs 1–3 and 10–12 and says so.

The owner merges. Nothing is deployed by a merge.

## Gate 2: the commercial pilot starts

The existing go/no-go record, `docs/evidence/E7E/GO-NO-GO.md`, unchanged by the transformation. In short: every
platform row passes on the final code; staging runs in the UAE region with a health check, delivered email, a stored
file, a received alert and a restore drill from a real backup; and every human row is signed (owner decisions, lawyer,
tax adviser, fee and rule verifiers, public display, outside security reviewer, Arabic reviewer if Arabic launches,
three signed partners with rate cards, five consenting clients). The transformation adds, for any AI capability used
in the pilot:

- the provider decision (T5) recorded, with the monthly cap configured and tested;
- the evaluation suite (E27) run on the pilot's code, with its measured results recorded;
- every consequential agent action shown, by test, to stop for a person's approval.

Today: **NO-GO** (staging blocked; every human row blank).

## Gate 3: production

After the pilot: the pilot report's measures (GO-NO-GO section 4), every finding of the outside security review fixed
with a failing-then-passing test, the owner's written go. Today: not started.

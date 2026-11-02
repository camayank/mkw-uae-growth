# E6 verification report

Run on 2 Nov 2026 on branch `outcome/E6-pilot-readiness` (E5 at `6e026b2` plus E6), in the development container
(Node 22, pnpm 10, PostgreSQL 16 at a local socket, Chromium through Playwright). Three states are distinguished and
nothing is claimed beyond them: **executed here** (the command ran in this environment, with its result),
**CI** (the same check runs on every pull request in `.github/workflows/ci.yml`; cited where it could not run here),
**blocked** (needs an input only the owner can provide).

| Check (contract list) | State | Command and result |
| --- | --- | --- |
| Install | executed here | `pnpm install --frozen-lockfile` (offline store): clean |
| Typecheck | executed here | `pnpm typecheck`: clean in `packages/core` and `apps/api` |
| Unit tests (domain) | executed here | `packages/core`: 105 tests, 10 files, pass |
| API tests, PGlite | executed here | `apps/api`: 333 pass, 1 skipped (PostgreSQL-only), 29 files, including the 26 contract scenarios (`scenarios.test.ts`); output in `tests-pglite.txt` |
| API tests, PostgreSQL 16 | executed here | `TEST_DATABASE_URL=… npx vitest run`: 334 of 334 pass (the races overlap for real); output in `tests-pg16.txt` |
| Migrations | executed here | Migrations 001–018 applied from empty on PGlite (every test environment, the smoke demo) and on PostgreSQL 16 (every test environment, the load test); the append-only and evidence-date triggers are exercised by tests |
| Authorisation | executed here | `security.test.ts`, `pdpl.test.ts`, `journey.test.ts`, `flow.test.ts`, scenarios 22–26: every forbidden field as every role, RLS at the database, cross-client and cross-partner doors |
| Build | executed here | `pnpm build`: `packages/core` and `apps/api` compile |
| Browser smoke test | executed here | `scripts/smoke.mjs` against a fresh demo of this build: 213 checks OK (`smoke-log.txt`); 91 screenshots in the run's output folder, four kept here |
| Public selector in the browser | executed here | 9 selector checks in the smoke run (questions, result labels, print, review request, Arabic); screens 83–85 |
| Mobile | executed here | 39 checks at 390 px in the smoke run; `92-mobile-saved-result.png` |
| Accessibility | executed here | axe (WCAG 2.1 AA) on 40 screens at 1280 and 390 px: 0 violations (`axe.json`) |
| Audit chain of the smoke run | executed here | `pnpm verify:audit` on the smoke demo's database: intact (`verify-audit.txt`) |
| Load test | executed here | `pnpm --filter @tasees/api load 40 10` on PostgreSQL 16: every invariant holds (`load-test.md`) |
| Infrastructure synthesises | executed here | `pnpm --dir infra synth:check`: both stacks synthesise with example values, no AWS call |
| Container image builds and answers health checks | CI | Docker is not available in this container, so it has not run on this branch; the `image` job runs on every pull request (it passed on E5's, camayank/mkw-uae-growth#21, and will run on E6's) |
| Staging deployment | blocked | Needs the owner's AWS account, domain and DNS, SES sender verification (O7, `docs/DEPLOY.md`). Nothing is deployed; no live readiness is claimed |
| Staging checks (TLS, SES delivery, S3 in a UAE region, payment provider, alerts) | blocked | Same inputs; the adapters are tested against fakes only (rule 7) |
| Real-data correctness | blocked | The catalogue, fees and rules are unverified; every result says so. A named verifier and authoritative data are the owner's inputs (E2) |

## What was found and fixed while verifying

- **Storage without a facilities record was passed silently.** For a business that needs a warehouse, a place with
  no facilities on record raised no finding, while the same gap for industrial land said "not on record". The engine
  now says the data is missing in both cases (`packages/core/src/eligibility.ts`, D83); the core and scenario tests
  assert it.
- **A formation quote could be published for a request whose advice found no option** (scenario 16): the engine
  names the closest structure to explain itself, and the quote gate read that as a settled structure. The gate now
  refuses while the advice stands; only a person's audited approval of a structure at the review opens the way to a
  quote (`apps/api/src/services/structure.ts`).
- **E5 review findings** (Codex, on the pull request, four rounds): lock order in the handoff and renewal paths; a
  renewal's liveness while its offers were drafts; the free zone lost on a renewal; a superseded renewal request that
  could be priced or quoted again. All fixed with tests on the E5 branch and carried here.
- **The suite's own first draft** (independent review): a vacuous "nothing sent" check, a value compared with
  itself, a scenario that depended on another's side effects, a tag that claimed the screens, and two wrong counts
  in this report. Fixed; every scenario now runs alone and puts back what it verified.

## Scenario outcomes that are by design, not defects

- The public selector withholds the "no option fits" conclusion (scenario 16) and every exclusion reason until the
  rules behind them are approved for public display (D80): the public sees no recommendation and no figure.
- With nothing verified, no place is `ELIGIBLE_VERIFIED` anywhere and every public place is "to be verified".

## Not executed, and why

- No message was sent, no payment taken, no filing made: the tests run on the in-memory adapters, and the smoke demo
  records email to its log.
- No real person's data was used: the demo seed and synthetic names only.

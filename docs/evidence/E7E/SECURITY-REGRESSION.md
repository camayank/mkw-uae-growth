# E7E quality and security regression

Run on 3 Nov 2026 on branch `outcome/E7E-pilot-readiness` (E7A to E7D plus E7E), in the development container
(Node 22, pnpm 10, PostgreSQL 16 at a local socket, Chromium through Playwright 1.64.1). Three states, nothing
claimed beyond them: **executed here** (the command ran in this environment, with its result), **CI** (the same
check runs on every pull request in `.github/workflows/ci.yml`; cited where it cannot run here), **blocked** (needs
an input only the owner can provide). No cloud resource, spend, message, payment or filing came out of any row.

## 1. The runs

| # | Check | State | Command and result |
| --- | --- | --- | --- |
| 1 | Install | executed here | `pnpm install` from the registry after the tooling upgrade (D89), lockfile updated; `pnpm install --frozen-lockfile --offline` in a clean worktree: clean |
| 2 | Typecheck | executed here | `pnpm typecheck`: clean in `packages/core` and `apps/api` on vitest 4 and the new Node types |
| 3 | Unit and API tests, PGlite | executed here | `pnpm test`: core __CORE__ tests, __COREFILES__ files; api __API__ pass, 1 skipped (PostgreSQL-only), __APIFILES__ files, including the six pilot journeys; `tests-pglite.txt` |
| 4 | API tests, PostgreSQL 16 | executed here | `TEST_DATABASE_URL=… npx vitest run`: __PG__ of __PG__ pass (the races and the lost-connection test run for real); `tests-pg16.txt` |
| 5 | Browser smoke test on a fresh demo | executed here | `scripts/smoke.mjs` with Playwright 1.64.1 against this build: __SMOKE__ checks OK, 0 failed; `smoke-log.txt` |
| 6 | Phone width and accessibility | executed here | 390 px checks inside the smoke run; axe (WCAG 2.1 AA) on __AXE__ screens at 1280 and 390 px: 0 violations; `axe.json` |
| 7 | Audit chain of the smoke run | executed here | `pnpm verify:audit` on the smoke demo's database: intact, __AUDIT__ events; `verify-audit.txt` |
| 8 | Load test, allocation and payouts on PostgreSQL 16 | executed here | `pnpm --filter @tasees/api load 40 10`: every invariant holds; `load-test.md` |
| 9 | Dependency audit | executed here | `pnpm audit`: no known vulnerabilities (everything); `pnpm audit --prod`: none; `audit.txt`. Before E7E: 18 advisories in development tools (gap 44); none after the upgrade (D89) |
| 10 | Infrastructure synthesises | executed here | `pnpm --dir infra synth:check`: both stacks synthesise with example values, no AWS call |
| 11 | Container image builds and answers health checks | CI | The Docker daemon is not reachable in this container; the `image` job runs on every pull request and passed on E7D's (camayank/mkw-uae-growth#27) |
| 12 | OpenAPI contract | executed here | `contract.test.ts` inside row 3: `docs/openapi.json` matches the routes |
| 13 | Pilot journeys A to F | executed here | `pilot-journeys.test.ts` inside rows 3 and 4 on both databases; `PILOT-JOURNEYS.md` |
| 14 | Staging deployment and live checks (TLS, SES, S3 region, provider, alerts) | blocked | The owner's AWS account, domain, DNS, SES (`STAGING-CHECKLIST.md`, section 2). Nothing deployed; no live readiness claimed |
| 15 | Real-data correctness | blocked | Every rule and place is UNCERTAIN until the named verifier works the coverage backlog (E2, E7B); the public sees no figure until a named person approves it (D80) |

## 2. What was found and fixed while running them

- **The funnel's per-request attribution was not stable.** E7C counted commercial outcomes once per request on
  "the first lead", tie-broken by uuid when two leads shared a timestamp (the test clock is frozen, so they always
  do). The suites passed by luck on earlier runs and failed on this one. The attributed lead is now the one with a
  measured browser session, then the earliest, then by id (E7C, D87); the funnel test was run repeatedly.
- **A PostgreSQL test timed out under load.** The trusted-proxy test builds a second whole environment (migrations
  and seed); with two suites sharing the server it passed the 5-second default. It has a 30-second budget now; the
  behaviour it tests was never in doubt.
- **The suite's own first draft** of the journeys assumed the document checklist opens at the client's acceptance
  (it opens when the partners accept) and that a payout run takes a released payout (it takes eligible payouts with
  an invoice and bank details; a single release is finance's separate action). Recorded in `PILOT-JOURNEYS.md`.

## 3. The security brief's eight items, mapped to what already tries them

For the outside reviewer (`docs/SECURITY-BRIEF.md`, "What we ask you to try"): each item names the tests that attempt
it today, so a finding is written as a failing test next to them.

| Item | Tried by |
| --- | --- |
| 1 Read another party's money through any route, export, notification, file or the contract | `security.test.ts` (RLS and column grants as each role); `flow.test.ts` (client sees prices, never cost or margin; partner sees cost, never price; ops never margin); `pdpl.test.ts` (exports carry no other party's figures, audit payloads stripped); `delivery.test.ts` (offer PDF names no partner); `reporting.test.ts` (dashboard and accounting export by role); `contract.test.ts` (no money field in a response the role may not see); journeys C, D, E |
| 2 Cross-organisation access by id | `security.test.ts` (no rows of another client's engagement; a partner sees nothing before allocation); `journey.test.ts` (another client sees none of this client's actions, offers, engagements); `delivery.test.ts` (files by party, another partner 404); `report.test.ts` (another client 404 on the report); journeys B, D |
| 3 Sign-in: brute force, session reuse, fixation, public intake abuse | `security.test.ts` (one-time code, wrong code, code limits per account); `admin.test.ts` (deactivation ends sessions); `pdpl.test.ts` (erasure kills sessions, the old address gets no code); `scoping.test.ts` (intake rate limit per IP, X-Forwarded-For only behind a trusted proxy, body caps); `leads.test.ts` and `report.test.ts` (public routes throttled per IP) |
| 4 Role escalation | `security.test.ts` (role changes through the API refused); `admin.test.ts` (invites, roles, the last-founder guard); `coverage.test.ts` and `jurisdiction.test.ts` (founder-only classification and verification) |
| 5 Bypass a state rule: evidence, payouts above cost, double payout, audit tampering | `flow.test.ts` (no submission without evidence, QA before approval, release only against an invoice, once); `payments.test.ts`, `concurrency.test.ts` and the load test (one payout per stage, never above the priced cost, one run from two presses); `pdpl.test.ts` and `hardening.test.ts` (a changed audit row is detected and alerted); journey D |
| 6 Webhook forgery and replay; idempotency keys across people or routes | `flow.test.ts` and `payments.test.ts` (unsigned 401, signature window, replay); `hardening.test.ts` (keys per person, same key on a different request refused, repeat while the first runs, keys forgotten after a day and on erasure) |
| 7 Upload abuse | `delivery.test.ts` and `storage.test.ts` (extension and content-type checks, size, file names, private keys never shown); `journey.test.ts` (upload rules published from the adapter); `hardening.test.ts` (1 MB body cap except file routes) |
| 8 The staging stack: IAM, security groups, database exposure, secrets, backups, restore drill | `infra/` synthesises (row 10): isolated subnets for RDS, private encrypted buckets, secrets generated into Secrets Manager, `DEV_LOGIN` unset, `TRUST_PROXY` the VPC range; `docs/RESTORE-DRILL.md` (procedure, local drill 16 Oct 2026); the live checks are blocked (row 14) |

## 4. Not executed, and why

- No message was sent, no payment taken, no filing made, no cloud resource created: the tests run on the in-memory
  adapters, the smoke demo records email to its log, and staging does not exist until the owner's inputs do.
- No real person's data was used: the demo seed and synthetic names only.
- The outside security review itself, the lawyer's and tax adviser's sign-offs, the verifiers' first pass: people,
  listed blank in `GO-NO-GO.md`.

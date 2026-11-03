# E7E Commercial pilot readiness: staging checklist, security regression, pilot journeys, go/no-go

Status: verified-pending-merge (branch `outcome/E7E-pilot-readiness`, built on E7D; released by the owner on 3 Nov 2026 with the E7
contract, phases 5 "Staging and pilot journeys" and 6 "Quality and security runs")

The contract's own wording for phases 5 and 6 is held in the owner's prompt; this file works from the released
outcome ("staging checklist, security regression, go/no-go") and the standing launch gate (`BUILD_PROMPT.md`,
"Launch gate and operations"; `outcomes/O7-launch-gate.md`). Where the contract named the six pilot journeys A to F,
they are taken as the six people the pilot has and the path each walks (below); if the owner's list differs, the
suite is renamed, not rebuilt.

## Business result

The owner can decide go or no-go for the pilot from one record: what the platform proves about itself today (every
check run on the final code, with its result), what the six pilot journeys do end to end on a fresh environment,
what the staging checklist still needs from people, and what is blocked until the owner's accounts exist. Nothing
in the record is claimed beyond what ran here; no cloud resource was created, nothing was spent, no customer was
contacted, nothing was sent, paid or filed.

## Scope

1. **Pilot journeys A to F** (`apps/api/test/pilot-journeys.test.ts`): one suite, six journeys in order, over HTTP
   on a fresh environment with the seeded, unverified catalogue and the in-memory adapters, as on the pilot's
   first day. A founder (public assessment, saved result, preliminary report, review request with a call request);
   the adviser (owner, booked call, next best action, advice approved, reviewed report); the client (proposal,
   acceptance, deposit recorded by finance, documents); the partners (allocation, evidence, MKW check, client
   approval, invoices, one payout released and the rest through a payout run); the founder of MKW (funnel,
   coverage, dashboard, system, audit trail); PDPL (consent withdrawal, export, erasure). Every step asserts the
   launch gate's invariants: no money field reaches the wrong party, nothing is sent, paid, released or filed
   without a person, the audit chain stays intact, personal data can be exported and erased while payments and
   payouts survive. `docs/evidence/E7E/PILOT-JOURNEYS.md` maps each journey to its steps, test and smoke checks.
2. **Quality and security regression** on the final code (`docs/evidence/E7E/SECURITY-REGRESSION.md`): typecheck,
   the full suites on PGlite and on PostgreSQL 16, the browser smoke test with axe, the audit-chain check, the load
   test on PostgreSQL, the dependency audit (`pnpm audit` for everything and `--prod`), the infrastructure
   synthesis, the container build (CI), and the security brief's eight "what to try" items mapped to the tests
   that already try them.
3. **Development tooling brought off the advisory list** (gap 44, D89): vitest 4 (tinypool is no longer a
   dependency), vite pinned, tsx (esbuild 0.28) and playwright upgraded to patched versions, the Node types with
   them, all exact; the suites and the smoke test rerun on them.
4. **Staging checklist** (`docs/evidence/E7E/STAGING-CHECKLIST.md`): every item from the launch gate and the
   staging runbook, each marked done by the build (with evidence), waiting on a named person, or blocked on an
   owner input, with the exact step that unblocks it.
5. **Go/no-go record** (`docs/evidence/E7E/GO-NO-GO.md`): the owner's decision sheet, the platform's rows filled
   from the evidence above, the human rows (legal, tax, security reviewer, verifiers, partners, clients) left for
   their signatures, and the criteria the pilot report measures.

## Exclusions

- Creating cloud resources, deploying staging or the demo, spending money, DNS, SES: the owner's inputs
  (`docs/DEPLOY.md`, "Ask me"). Reported as blocked with the unblocking step; no live readiness is claimed.
- Contacting real customers or partners, sending any message, taking any payment, filing anything: the tests run on
  the in-memory adapters and synthetic data only.
- Legal, tax and outside security sign-offs: human work the record leaves blank by design.
- New product features. Where a journey showed a defect, the fix is small and in scope, or recorded as a gap.

## Acceptance evidence

- The six journeys pass on PGlite and on PostgreSQL 16; each journey's test names its invariants.
- Every row of the security regression is executed here, CI-only or blocked, with its command and result, and the
  dependency audit is clean for everything that ships and for the development tools after the upgrade.
- The staging checklist has no row without a state and an owner; the go/no-go record names what is waiting on whom.
- `pnpm typecheck`, `pnpm test`, the smoke test on a fresh demo and `pnpm verify:audit` pass on the final code.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm typecheck` clean; `pnpm test`: 131 core (14 files) + 356 API, 1 skipped (34 files) on PGlite, `docs/evidence/E7E/tests-pglite.txt`; 357 of 357 on PostgreSQL 16, `tests-pg16.txt`; the journeys suite rerun alone on both after the review's amendments |
| Pilot journeys | `apps/api/test/pilot-journeys.test.ts`, six journeys, inside both runs; `PILOT-JOURNEYS.md` maps each to its steps, invariants and smoke checks |
| Smoke | `smoke-log.txt`: 257 checks OK on a fresh demo with Playwright 1.64.1 (E7D: 257; no new screen in E7E) |
| Accessibility | `axe.json`: 48 screens at 1280 and 390 px, 0 violations |
| Audit chain | `verify-audit.txt`: intact, 112 events, on the smoke demo's database |
| Load test | `load-test.md`: 40 engagements, 10 at a time, on PostgreSQL 16; every invariant holds |
| Dependency audit | `audit.txt`: no known vulnerabilities, for everything and for production alone |
| Infrastructure, container | `pnpm --dir infra synth:check` here; the `image` job in CI (passed on E7D's pull request) |
| Records | `SECURITY-REGRESSION.md`, `STAGING-CHECKLIST.md`, `GO-NO-GO.md`; D89; KNOWN-GAPS 44 closed, 104–106; `docs/SECURITY-BRIEF.md`; `docs/ENTITY-PROGRAMME.md` section 6; queue |

## Independent review

A separate reviewer read the whole diff before the pull request (ran the journeys suite, a core suite, the typecheck
and the audit; read the rest). Applied: the evidence files the documents cite are committed with the numbers from
the runs; three citations in the security mapping pointed at tests that do not test the claim (the contract test,
the scoping test for body caps, the leads test for throttles) and now name the ones that do; three rows of the
journeys map carried the wrong smoke screen numbers; D89 named the wrong esbuild version (0.28.2); the coverage
check in journey E could not fail (it now checks the status and the places count); the invoice loops accept exactly
one partner; journey D asserts that every email to a partner comes from MKW Advisors without the name Tasees; the
bank-details call checks its status; journey B asserts the queued follow-up; the security brief's table row and the
outcome's tooling wording were out of step with the paragraph below them. Noted, not changed: the journeys do not
re-assert rule 2 (payout at or below the priced cost) and rule 3 (integer fils), which the load test and
`payments.test.ts` assert; the exception queue at close is an operations check, not a journey.

## Could not verify

- Staging and every live check (TLS, SES, S3 region, provider, alerts): blocked on the owner's inputs; nothing deployed.
- The human sign-offs in `GO-NO-GO.md`: blank until the named people sign.
- Whether the six journeys are the contract's A to F by name: the wording is in the owner's prompt (D89).

## Dependencies and risks

- Depends on E7A to E7D (all merged to `main` on 3 Nov 2026; this branch was built on E7D and retargeted to `main`).
- Risk: a tooling upgrade changes test behaviour. Mitigated by running every suite on both databases and the smoke
  test after it; the versions are pinned (rule 11).
- Risk: the journeys pass on synthetic data and the in-memory adapters, not on staging. Stated plainly in the record.

## Owner decisions

- Go or no-go for the pilot (`docs/evidence/E7E/GO-NO-GO.md`), once the human rows are signed.
- Whether the six journeys as named here are the contract's A to F; renaming is a one-line change.

## Rollback

- Tests, documents and pinned tool versions; revert the pull request to undo it. No migration.

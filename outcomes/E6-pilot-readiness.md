# E6 Verification and pilot readiness

Status: verified-pending-merge (branch `outcome/E6-pilot-readiness`, built on E5 and rebased onto `main` once
camayank/mkw-uae-growth#21 merges; released by the owner on 2 Nov 2026 with the Right UAE Entity programme,
`docs/ENTITY-PROGRAMME.md`)

## Business result

The owner can see, for each of the contract's 26 scenarios and each of its eight checks, exactly which test proves
it, what was executed here, what only past CI shows, and what stays blocked until the owner's inputs arrive. Nothing
is claimed that was not run.

## Scope

1. **Scenario suite** (`apps/api/test/scenarios.test.ts`). One test per contract scenario, end to end over HTTP
   with synthetic data, asserting the checks that apply: eligibility status, exclusion or escalation, the
   recommendation's reasons, confidence propagation, no invented price, no unauthorised access, no irreversible
   action without a person, and the same answer through the API that the screens read.
   - Scenarios the platform does not yet model (several independently regulated activities, holding plus operating
     structures, a renewal comparison) are tested for honest behaviour: the engine escalates to a person and invents
     nothing, and the gap is named.
2. **Traceability** (`docs/evidence/E6/SCENARIOS.md`): scenario by scenario, the tests (new and existing) and the
   smoke checks that cover it, with the check categories each satisfies.
3. **Verification report** (`docs/evidence/E6/VERIFICATION.md`): every check in the contract's deployment list,
   marked executed here (with the command and result), verified through CI only, or blocked (with what unblocks it).
4. **Regression and security passes** rerun on the final code: the full PGlite and PostgreSQL 16 suites, the
   browser smoke test with the selector, mobile and accessibility checks, build and container checks from CI, and
   the audit-chain verification.
5. **Programme close-out**: `docs/ENTITY-PROGRAMME.md` gap matrix brought to the final state; `KNOWN-GAPS.md` lists
   what the pilot starts with.

## Exclusions

- Staging deployment and live checks: they need the owner's AWS account, domain and SES (O7). Reported as blocked.
- Any contact with real people, live messages, payments or filings: tests use synthetic data and the in-memory
  adapters only.
- New product features. E6 verifies; where a scenario shows a defect, the fix is small and in scope, or it is
  recorded as a gap.

## Acceptance evidence

- The scenario suite passes on PGlite and PostgreSQL 16; each scenario's test names the checks it covers.
- The traceability table has no empty cell: every scenario maps to at least one executed test for each applicable
  check, or to a named gap.
- The verification report distinguishes executed, CI-verified and blocked, with evidence paths.

## Dependencies and risks

- Depends on E1 to E5.
- Risk: a scenario may surface a defect late. That is the point; each is fixed with a test or recorded as a gap.

## Owner decisions

- None to merge. The pilot's go/no-go follows the launch gate (O7), which needs the owner's inputs.

## Rollback

- Tests and documents, plus one engine correction (a storage need at a place with no facilities record says the data
  is missing); revert the pull request to undo it.

## Evidence

| Claim | Evidence |
| --- | --- |
| Scenario suite | `apps/api/test/scenarios.test.ts`: 26 tests, one per contract scenario, each naming its checks; pass on PGlite and PostgreSQL 16 |
| Traceability | `docs/evidence/E6/SCENARIOS.md`: every scenario and check mapped to new and existing tests and smoke checks; gaps 75–79 named where the case is not modelled |
| Verification report | `docs/evidence/E6/VERIFICATION.md`: executed here (install, typecheck, 105 core + 333 API on PGlite, 334 on PostgreSQL 16, build, smoke 213 checks, selector, mobile, axe 0 violations, audit chain 108 events, load test, infra synth), CI-only (container image), blocked (staging and live checks) |
| Engine correction | `packages/core/src/eligibility.ts`: warehousing not on record is a `DATA_UNAVAILABLE` finding, as industrial land was; `packages/core/test/eligibility.test.ts` scenario 8 and `scenarios.test.ts` 8 assert it |
| Smoke | `docs/evidence/E6/smoke-log.txt`: 213 checks OK on a fresh demo of this build; `axe.json`: 40 screens, 0 violations; `load-test.md`; screens `84-public-selector-approved.png`, `89-held-enquiry-converted.png` (1280 px), `85-mobile-public-selector.png`, `92-mobile-saved-result.png` (390 px) |
| Programme close-out | `docs/ENTITY-PROGRAMME.md` section 5; `docs/KNOWN-GAPS.md` gaps 75–80 and "Verified so far"; D83 |

## Independent review

(To be completed before the pull request.)

## Could not verify

- **Anything about a real jurisdiction, fee or rule**: the catalogue is unverified and the tests assert that the
  platform says so. A named verifier and authoritative data are the owner's inputs.
- **Staging and live behaviour** (TLS, SES delivery, S3 in a UAE region, payment provider, alerts): no cloud account.

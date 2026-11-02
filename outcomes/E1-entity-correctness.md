# E1 Entity correctness

Status: verified-pending-merge (branch `outcome/E1-entity-correctness` from `main` at `a9274f4`; released by the
owner on 2 Nov 2026 with the Right UAE Entity programme, `docs/ENTITY-PROGRAMME.md`)

## Business result

The scoping engine never recommends a structure or place that the rules exclude. It explains each exclusion and
each uncertain option. A formation quote reaches a client only for a structure that is settled and fits the
request.

## Scope

1. **Baseline repaired.** Three date-dependent failures on `main` are fixed at the cause. Reporting and scorecards
   read step dates (`approved_at`, `first_disputed_at`, migration 013) rather than audit timestamps.
2. **Eligibility before recommendation** (`packages/core/src/eligibility.ts`). Each structure and each place is
   checked against named rules before anything is ranked.
   - **Statuses.** Each gets one of `ELIGIBLE_VERIFIED`, `ELIGIBLE_CONDITIONAL`, `REQUIRES_VERIFICATION`,
     `INELIGIBLE` or `DATA_UNAVAILABLE`.
   - **Ranking.** Only viable options are ranked: by status first, then the founder's preferences. No commercial
     input exists.
   - **Corrections the contract names:**
     - offshore with visas, premises or onshore customers is excluded;
     - regulated finance is never offered a generic free zone;
     - virtual assets carry the regulator condition;
     - a sector tag is never a permission;
     - visa capacity separates the standard package (a condition) from a hard limit (an exclusion);
     - affordability is checked against the estimate, with the estimate's confidence;
     - mainland access from a free zone is a condition;
     - holding companies consider visas and budget;
     - corporate tax separates the ordinary regime, the qualifying free zone person conditions and small business
       relief;
     - VAT turns on taxable supplies;
     - cross-border points go to a specialist;
     - contradictions and missing facts are named;
     - when nothing fits, no option is invented.
3. **Advice** (`advice.ts`) chooses the structure the facts point to and checks it.
   - If the rules exclude it, the advice shows the closest viable structure and why.
   - It carries every structure's assessment, up to five viable places with their findings, the excluded places
     with their reasons, cross-border points, missing facts, contradictions and the engine version.
   - Stored advice from before E1 still renders.
4. **Quotes wait for a settled structure** (`apps/api/src/services/structure.ts`). Publishing a formation offer
   needs either advice approved by ops with a structure, or a structure the client asked for that the advice agrees
   with. That structure must also pass today's rules, and the offer must price it.
   - **Refused at approval:** ops cannot approve an excluded structure.
   - **Re-scoped at approval:** approving a different structure re-scopes the request, and offers priced on changed
     lines are withdrawn.
   - **After acceptance:** the structure changes only by a change order.
5. **Screens.** The ops review and the client's advice show:
   - every structure compared, with its status;
   - each place's status, conditions and points to confirm;
   - the excluded places and why;
   - cross-border points, missing facts and contradictions;
   - costs as estimates.

   An excluded structure cannot be selected at the review. Arabic drafts are added for the new labels.

## Exclusions

These are later phases:
- exact licensing activities, authority catalogue, renewals and fees (E2);
- the public selector (E3);
- leads (E4);
- the handoff (E5).

There is no new data: all rules and places stay UNCERTAIN until a named person verifies them.

## Acceptance evidence

- **Core** (`packages/core/test/eligibility.test.ts`, 25 tests):
  - the contract's scenarios 1–13, 15, 16, 19 and 21;
  - the named corrections;
  - an invariant matrix over 4,160 founder combinations.
- **API** (`apps/api/test/entity.test.ts`, 8 tests): the quote and approval gates over HTTP.
- **The 20 founder cases** (`scoping.test.ts`): 19 unchanged. "Holding company with visas" is corrected from
  offshore to free zone, with the reason in the test.
- **The suites, the smoke test with screenshots at 1280 and 390 px, and axe:** listed below.

## Rollback

Revert the branch. Migrations 013 and 014 only add columns and widen a check constraint.

## Evidence

| Claim | Evidence |
| --- | --- |
| Baseline | `docs/evidence/E1/baseline-main-tests.txt`: `main` at `a9274f4` failed 3 API tests on 2 Nov 2026 (date dependent). Its last CI run on 25 Oct passed: [run 45](https://github.com/camayank/mkw-uae-growth/actions/runs/40231959467) |
| Tests | `pnpm test`: 82 core + 272 API (one PostgreSQL-only test skipped on PGlite) = 355 passing on PGlite. The API suite passes 273 of 273 on PostgreSQL 16. `pnpm typecheck` is clean |
| Invariants | For 4,160 combinations of activity, customers, visas, budget and premises, all hold: no recommended structure is excluded; offshore is never offered with visas, premises or onshore customers; finance never gets a generic free zone; no offered place has an exclusion or exceeds the budget; at most five options; none verified while the rules are not; no places means "no viable option" |
| Gates | not sure → refused until settled; offshore with visas → approval refused, the advice's free zone re-scopes the request (`SET-FZ-LIC`, `VISA-RES ×2`) and the audit records it; mismatch → refused until reviewed; an offer on the old licence → refused; facts changed after approval → refused; accepted → change order only; services-only requests are not held |
| Smoke | `docs/evidence/E1/smoke-log.txt`: 181 checks OK on a fresh demo (S1: 174), including every structure compared, the excluded structure disabled at review, and the client's eligibility view |
| Screens | `35-ops-scoping-review.png`, `36-client-advice.png` (1280 px), `81-mobile-client-advice.png` (390 px); axe shows zero WCAG 2.1 AA violations on all 33 screens checked (`axe.json`) |

## Could not verify

- **Whether the rules are legally right in every case.** Every rule is UNCERTAIN until a named, qualified person
  verifies it with a source (the Scoping page records this).
- **Activity permissions per place.** They are never assumed; they need each authority's activity list (E2).

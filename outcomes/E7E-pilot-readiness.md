# E7E Commercial pilot readiness: staging checklist, security regression, pilot journeys, go/no-go

Status: in-progress (branch `outcome/E7E-pilot-readiness`, built on E7D; released by the owner on 3 Nov 2026 with the E7
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
3. **Development tooling brought off the advisory list** (gap 44, D89): vitest, tinypool, esbuild (through tsx) and
   playwright upgraded to patched versions, pinned; the suites and the smoke test rerun on them.
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

## Dependencies and risks

- Depends on E7A to E7D (E7C and E7D open; this branch is built on E7D).
- Risk: a tooling upgrade changes test behaviour. Mitigated by running every suite on both databases and the smoke
  test after it; the versions are pinned (rule 11).
- Risk: the journeys pass on synthetic data and the in-memory adapters, not on staging. Stated plainly in the record.

## Owner decisions

- Go or no-go for the pilot (`docs/evidence/E7E/GO-NO-GO.md`), once the human rows are signed.
- Whether the six journeys as named here are the contract's A to F; renaming is a one-line change.

## Rollback

- Tests, documents and pinned tool versions; revert the pull request to undo it. No migration.

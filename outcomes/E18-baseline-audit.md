# E18 Baseline audit: what the platform is today, and the order of the transformation

Status: verified-pending-merge (branch `outcome/E18-baseline-audit`, on `main` at d8104fb with E17 merged; the
transformation mandate of 3 Nov 2026, Phase 0: "First deliver: docs/transformation/BASELINE-AUDIT.md", then its
reporting documents. Continued under the mandate's Step 7 after the owner's "merge when green" for E17.)

## Business result

The owner, a reviewer or a new engineer can see, with evidence, what the platform does today, what is only a test
double, what is missing, what is risky, and in which order the transformation will deliver it, without reading the
code.

## Scope

1. `docs/transformation/BASELINE-AUDIT.md`: capability inventory, current status, critical risks, reusable components,
   missing capabilities, proposed architecture changes, technical debt, business impact, test evidence, prioritised
   backlog (the mandate's list).
2. `docs/transformation/ROADMAP.md`, `IMPLEMENTATION-STATUS.md`, `DECISION-LOG.md`, `RISK-REGISTER.md`,
   `RELEASE-GATES.md` (the mandate's reporting requirements).
3. `outcomes/QUEUE.yaml`: E17 merged; E18; E19 to E27 as `planned` with their mandate items; a note on O16.
4. `docs/DECISIONS.md` D100; `docs/KNOWN-GAPS.md` gaps 135 to 140; `README.md` link.

## Exclusions

- No code change. The defects and holes the audit finds are fixed by the outcomes it proposes (E19 onwards), each
  with a failing test first.
- No owner decision is taken: T4 to T7 are written as open, with options and costs.

## Method

- Three read-only inventories of the code: routes, jobs and adapters; database, core modules and state machines;
  screens and tests. Each finding the audit relies on was spot-checked by hand: the AI model (`lib/ai.ts:212-216`),
  the upload checks (`lib/storage.ts:23-34`, `services/payouts.ts:61`), the audit table's grants
  (`001_init.sql:394, 454-456`, no trigger), the route count (177), the evidence-file route having no test, the
  staging email setting (`infra/lib/staging-stack.ts:110`) and the priority-tier record (gap 85, D84).
- The full test suite and typecheck on `main` at d8104fb.

## Acceptance evidence

`docs/evidence/E18/`:

- `typecheck.txt`: clean.
- `tests-pglite.txt`: core 154 passed (18 files); API 375 passed, 1 skipped (38 files).

Documents only: the browser smoke test was not re-run (no screen changed); CI runs it on the pull request.

## Findings that matter most

- **Audit trail editable by the application's own role** (gap 135, risk R1): fixed in E19.
- **Within-party role limits at two layers, not three** (gap 136, R2): decision T4, tests in E19.
- **Untested download and role paths** (gap 137): E19.
- **Uploads not inspected** (gap 45, R3): E20.
- **No live AI, payments, WhatsApp, scanner or calendar; email and storage live code unexercised**: named in the
  inventory, marked BLOCKED or NOT LIVE.
- No defect found that lets one party read another's money or records.

## Dependencies

E17 (merged).

## Risks

- **An audit that overstates.** Mitigated: every claim cites code or a test; searches that found nothing are named;
  statuses need stated evidence; no percentage.
- **A plan that drifts from the queue.** Mitigated: one numbering (T1), the queue and the roadmap updated together.

## Owner decisions

Open: T4 (platform database roles), T5 (AI provider, key, cap, personal data), T6 (live scanner), T7 (O16 and E22–E24).
None blocks E19's tests or the audit trigger.

## Rollback

Revert the merge. Documents only.

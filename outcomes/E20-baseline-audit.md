# E20 Baseline audit: what the platform is today, and the order of the transformation

Status: verified-pending-merge (branch `outcome/E20-baseline-audit`, on `main` at a42c487 with E19 merged; released by
the owner on 4 Nov 2026: "start E20". It is the transformation mandate's Phase 0 deliverable, "First deliver:
docs/transformation/BASELINE-AUDIT.md", with its reporting documents.)

## Business result

The owner, a reviewer or a new engineer can see, with evidence and without reading the code:
- what the platform does today;
- what is only a test double;
- what is missing;
- what is risky;
- in which order the transformation will deliver the rest.

## History

This audit was first drafted on `main` at d8104fb, on the branch `outcome/E18-baseline-audit`, which is kept and not
merged. Its independent review found two defects and two unsafe or untested areas:
- one partner firm read another firm's change-order cost;
- partner staff received money figures;
- sign-out and expiry were untested;
- the app logged in as the database owner.

The owner had those fixed first, as E19. The owner had also released E18 as quote provenance in the meantime. This
outcome is the audit, renumbered E20, re-read on the code after E18 and E19, with every finding of that review applied.

## Scope

1. **`docs/transformation/BASELINE-AUDIT.md`**, covering each item the mandate asks for:
   - capability inventory;
   - current status;
   - critical risks;
   - reusable components;
   - missing capabilities;
   - proposed architecture changes;
   - technical debt;
   - business impact;
   - test evidence;
   - prioritised backlog.
2. **The five reporting documents** the mandate asks for: `ROADMAP.md`, `IMPLEMENTATION-STATUS.md`, `DECISION-LOG.md`,
   `RISK-REGISTER.md` and `RELEASE-GATES.md`.
3. **`outcomes/QUEUE.yaml`:** E19 merged; E20; E21 to E29 as `planned`, each with its mandate item; a note on O16.
4. **`docs/DECISIONS.md` D102** and **`docs/KNOWN-GAPS.md` gaps 145 to 147.** Gap 7 is corrected: it said a Claude
   adapter had been written, and none exists.
5. **A `README.md` link.**

## Exclusions

- **No code change.** The holes the audit finds are fixed by the outcomes it proposes, from E21 onwards, each with a
  failing test first.
- **No owner decision is taken.** T4 to T8 are written as open, with their options and costs.

## Method

- Three read-only inventories of the code: routes, jobs and adapters; database, core modules and state machines;
  screens and tests.
- Each finding the audit relies on was spot-checked by hand on `main` at a42c487:
  - the AI model (`lib/ai.ts:212-216`) and the absence of any provider adapter;
  - the upload checks;
  - the counts: 174 + 3 routes, 63 tables, 26 migrations, 28 core modules, 60 axe scans;
  - the twelve download routes and the tests that touch each;
  - the direct-SQL status changes.
- The first draft's independent review was adversarial: probes on PGlite and PostgreSQL 16. All its findings are
  applied: its four main findings were fixed in E19, and its minor ones are corrected in these documents.
- The full test suite, the typecheck and `pnpm audit --prod` were run on `main` at a42c487.

## Acceptance evidence

`docs/evidence/E20/`:

- `typecheck.txt`: clean.
- `tests-pglite.txt`: core 159 passed (19 files); API 404 passed, 7 skipped (41 files).
- `audit.txt`: `pnpm audit --prod` finds no known vulnerabilities.

The PostgreSQL 16 run (411 passed) and the browser smoke (337 checks, 60 axe scans) are E19's, on the same code
(`docs/evidence/E19/`). E20 changes documents only, so neither was re-run. CI runs both on the pull request.

## Findings that matter most

- **No known leak.** What remains is missing guards and tests: six download routes have no refusal test (gap 145);
  three entities have no transition table (gap 146); uploads are not inspected (gap 45).
- **No real AI and no provider adapter.** Gap 7 overstated this, and is corrected.
- **Not deployed.** Staging is code; every pilot sign-off is blank.

## Independent review

To be recorded after the review of this version.

## Dependencies

E19 (merged).

## Risks

- **An audit that overstates.** Mitigated: every claim cites code or a test; searches that found nothing are named;
  every status needs stated evidence; no percentage is given; a second independent review is run.
- **A plan that drifts from the queue.** Mitigated: one numbering (T1), with the queue and the roadmap updated
  together.

## Owner decisions

Open: T4 (database roles within a party), T5 (AI provider), T6 (live scanner), T7 (O16), T8 (partner-stated and
emirate-wide fees).

## Rollback

Revert the merge. Documents only.

# E23 Evidence operations: conflicts flagged to the verifier, versions compared, stale facts on the queue

Status: verified-pending-merge (branch `outcome/E23-evidence-operations`, from `main` at 7f97829 with E22 merged; released by the
owner on 4 Nov 2026: "start E23". The transformation mandate's P0-02, item 2.2, as `docs/transformation/ROADMAP.md`
orders it.)

## Business result

- **A contradicting source never changes a figure on its own.** When a new fact disagrees with the current one and
  is weaker, older, or of the same date from another source, it is recorded as a conflict and flagged to the
  verifier. The current figure stays until the verifier decides: accept the new one, or keep the current one. Before
  this outcome, the newest fact always won, so an UNCERTAIN figure from an intermediary replaced a verified official
  one in the engine and on every screen.
- **Every change is explained.** A fact that supersedes the current one (newer evidence, at least as strong) is
  recorded as a change, with what it replaced; the history shows each version against the one before, with the
  difference.
- **Stale facts reach the ops queue.** A current fact past its re-verification date on an active place's engine
  field is a queue item for that place, until a new fact is recorded. Conflicts are queue items too, for the founder.

## Scope

1. **Classification** (`packages/core/src/catalogue.ts`, `classifyFactChange`): `first`, `same`, `change` or
   `conflict`, with the reason in words. A conflict is a differing value that is:
   - weaker than the current figure deserves today (its recorded confidence below the current one's effective
     level);
   - older than the current evidence; or
   - of the same date and strength, from a different source (a stronger source of the same date supersedes).

   A weaker source that agrees is a conflict too: it would replace the figure's confidence (review). Anything else
   that differs is a change. The founder's own verification of a place or rule is a decision: its facts are changes
   that say so (review).
2. **Recording** (migration 030; `appendFact`): every fact stores `supersedes_id`, `change_kind` and
   `change_reason`. A conflict does not update the current-value cache, and `latestFacts` (the engine's view) skips
   unreviewed conflicts and conflicts the verifier kept. Rule facts and the importer go through the same path.
3. **The verifier's decision** (`catalogue_fact_reviews`, append-only; `POST /api/admin/jurisdictions/facts/:id/review`,
   founder only): `accept` makes the new figure current (cache refreshed, audited) or `keep` leaves the current one.
   A later fact that supersedes the figure (a change, or an accepted conflict) closes a conflict on its own; a repeat
   of the current value does not (review). Accepting a conflict the field has moved past is refused.
4. **Version comparison** (`GET /api/admin/jurisdictions/compare?kind&subject&field`; core `diffVersions`): every
   version of one field, oldest first, each with the previous value, the difference for amounts and ranges, its
   change kind and reason, its review, and whether it is current. The history panel on the Scoping page shows the
   change beside each fact, the previous value, and the founder's Accept / Keep buttons on an open conflict.
5. **Queue items** (`fact_conflict`, `evidence_stale`): open conflicts, one per fact, with the decision as the
   action; stale engine fields, one per active place, naming the fields and the oldest due date. Each says why it is
   there and links to the Scoping page.
6. **Coverage** counts open conflicts.

## Exclusions

- **No automatic resolution.** Nothing decides a conflict but the founder (rule 5).
- **No rule-content diff.** A rule fact's "version" is compared as a whole, as before.
- **The named verifier** for real data is still the owner's (gap 92); the platform flags, a person decides.

## Acceptance evidence

`docs/evidence/E23/`:

- **`before-fix.txt`.** A probe on `main` at 7f97829: an UNCERTAIN intermediary figure with older evidence replaced
  the verified official figure in the engine and the cache; nothing said so; nothing reached the queue. The new suite
  cannot load on `main`.
- **`tests-pglite.txt`.** Core 159 passed (19 files). API 447 passed, 7 skipped (46 files).
- **`tests-postgres16.txt`.** API 454 passed (46 files), on PostgreSQL 16.15.
- **`typecheck.txt`.** Clean.
- **`smoke-log.txt`.** 337 checks and 60 axe scans passed on a fresh demo.
- **`screens/e23-history-conflict-*.png`, `e23-queue-conflict-*.png`, `e23-history-decided-desktop.png` and
  `conflict-screens.json`.** A local demo with a verified cost for IFZA and then an UNCERTAIN intermediary figure: the
  history panel shows the conflict with the previous value, the reason and the founder's buttons; the queue shows the
  item with the decision as its action; after "Keep the current figure" the history shows the decision and the queue
  is empty. At 1280 and 390 px, each axe-clean with no horizontal overflow and no page errors.

The new and changed tests:
- `evidence-ops.test.ts` (12): the classification's cases and the version diff (core); a weaker contradicting figure
  recorded as a conflict that changes nothing, flagged on the queue with the decision as its action, shown in the
  history and the comparison; the founder's decision, once, audited, `keep` and `accept`; a change that supersedes and
  closes an open conflict; the importer's dry run and apply; a stale engine fact as a queue item that a new fact
  clears; a weaker agreeing source refused; ops without the founder's buttons; a re-import that decides nothing; the
  founder's own verification as a decided change; an accept refused once the field moved on;
- `migrations.test.ts` (1): migration 030 over a database that already holds facts;
- `public-selector.test.ts`: its "new fact lapses the approval" fixture is now a superseding fact (a correction from the
  same source, today); a weaker figure is a conflict and lapses nothing, by design.

## Business invariants touched

- **Rule 5 (uncertain is a state).** Strengthened: an UNCERTAIN or weaker figure can no longer replace a verified one
  on its own, anywhere, until a person decides.
- **Rule 6 (no unattended side effects).** The jobs do nothing new; conflicts and stale facts are queue items for a
  person.
- **Rule 8 (audit).** New events: `catalogue.conflict_reviewed`; `catalogue.fact_recorded` carries the change and
  what it supersedes.

## Independent review

An independent reviewer read the change against the code and probed it on PGlite.

- **Blocking, all fixed with tests:**
  - migration 030's backfill tripped the facts table's own append-only trigger on any database holding facts, so
    staging could not have migrated; the backfill now lifts the guard for itself, and `migrations.test.ts` migrates
    over existing rows;
  - a weaker source that agreed became current and quietly downgraded a verified figure, after which a differing
    weaker figure counted as a change: a weaker source is now a conflict whether or not it agrees;
  - a routine re-import of the master sheet closed an open conflict with no decision: the importer now compares with
    the current fact and the latest row, and only a superseding change closes a conflict.
- **Minor, fixed:** the founder's own verification of a place parked their figures as a conflict (now a decided
  change); ops saw the founder's buttons; accepting a conflict the field had moved past said nothing (now refused);
  the review table had no row-level security; the backfill labelled repeats as changes.
- **Housekeeping:** a probe file of the reviewer's had been swept into a commit; removed.

The reviewer verified as correct: every reader agrees on "current"; a conflict leaves the cache alone; `keep` and
`accept` behave and are audited and append-only; the queue ids, timestamps and the jobs runner; the authorisation of
compare, history and review; the evidence counts.

## Dependencies

E20 (merged). Builds on E7B's facts, history, coverage and importer.

## Risks

- **A real update classified as a conflict.** The rule errs on the side of asking: a newer official figure of equal
  confidence is a change, and the founder can accept any conflict in one click.
- **Existing facts.** Backfilled as `first`/`change` by order; none becomes a conflict retroactively.

## Owner decisions

None new. Open: gap 92 (a named verifier); T8 (partner-stated and emirate-wide fees).

## Rollback

Revert the merge. Migration 030 adds columns, a table and a function; the old code ignores them.

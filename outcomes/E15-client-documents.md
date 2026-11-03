# E15 Client documents: needed now, needed later, already sent

Status: merged (camayank/mkw-uae-growth#36, 3 Nov 2026; previously verified-pending-merge, branch `outcome/E15-client-documents`, on `main` at db7c5ee with E14 merged; released
by the owner on 3 Nov 2026: "start E15", after the portal assessment's point that the client was asked to upload 13
documents in one action)

## Business result

A new client sees the few documents that are holding up the first step, not every document the whole engagement
will ever need. The rest are listed by step with the date each is expected, ready to upload early. What they have
already sent is set aside. On the demo engagement the next action says "Upload 8 documents… 2 steps cannot finish
without them. 1 more is needed later, from 17 Nov 2026" instead of "Upload 13 documents"; the 4 left open on the
step already approved are listed last, to send only if the firm asks.

## Scope

1. **Core** (`packages/core/src/documents.ts`, pure): `documentPlan(docs, steps, today)`.
   - **Needed now:** anything sent back, anything for a step due today or late, and the documents for the step due
     first among those still waiting (ties included). A step already approved never counts.
   - **Approved steps:** documents still open on such a step are listed last among the later ones, marked.
   - **Needed later:** the rest, by step in due order, each with its date.
   - **Already sent:** uploaded or received.
2. **Next action** (`apps/api/src/services/journey.ts`): it counts only what is needed now, names those documents and
   their step, and says how many more are needed later (for steps still to come) and from when. Its date is the most urgent (earliest) due date
   among the steps it covers. Documents left only on approved steps make no action.
3. **Engagement view** (`apps/api/src/services/views.ts`): the client's view carries `documentPlan`, computed on the
   Gulf date. Partners and staff do not get it.
4. **Page** (`apps/web/public/js/engagement.js`, `styles.css`): the documents panel shows "N to upload now", then:
   - "Needed now" by step;
   - "Needed later: N", folded, by step with "Expected by";
   - "Already sent: N", folded.

   When nothing is needed now, it says so and opens the later list. Early upload works as before.
5. **Arabic**:
   - The next action's explanation patterns now accept the "more needed later" tail.
   - The new labels are added as drafts (gap 128).

## Exclusions

- Sharing one upload across steps or firms (gap 125); the acceptance emails (gap 126); closing requests on an
  approved step (gap 127).
- Any change to what is requested, from whom, or who can read a file.

## Acceptance evidence

- Core (`packages/core/test/documents.test.ts`, new):
  - At acceptance, only the first step's documents are needed now.
  - Once they are sent, the steps due next (the same day) come forward.
  - A document that was sent back, or is for a step due today or late, is always needed now.
  - A document left open on an approved step never takes over "now"; a document whose step is unknown goes later.
  - The date is the most urgent one.
  - Over 300 random cases (today across three weeks, an approved step included):
    - every document is in exactly one group;
    - "now" is empty only when no step not yet approved is missing a document;
    - every sent-back or late document is now;
    - nothing later is due on or before the first batch;
    - the date is the earliest.
- API (`journey.test.ts`):
  - The next action's title counts the plan's "now" and its date is the plan's.
  - The explanation ends with the number needed later and their date.
  - The partner's view carries no plan.
- Smoke (`scripts/smoke.mjs`):
  - Checked against the steps themselves: nothing needed now belongs to an approved step, and the first open step's
    documents are the ones needed now.
  - The page's now and later lists match the platform's plan, with "N to upload now".
  - The next action counts only "now".
  - An uploaded document moves to "Already sent: 1" and the count needed now falls.
  - At 390 px, no overflow and axe passes.

Evidence recorded on 3 Nov 2026 (`docs/evidence/E15/`):

- `pnpm test` (`tests-pglite.txt`): core 152 passed (17 files); API 365 passed, 1 skipped (36 files), on PGlite.
- `pnpm typecheck`: clean (`typecheck.txt`).
- `scripts/smoke.mjs` against a fresh demo: 325 checks OK, 0 failed (`smoke-log.txt`; 319 after E14).
- Screenshots: `118-client-documents-grouped.png` (1280 px), `119-mobile-client-documents.png` and
  `75-mobile-client-home.png` (390 px, the next action "Upload 8 documents").

## Independent review

- **Blocking, fixed with a test and a smoke check.** On the demo engagement, the four documents "needed now" belonged
  to a step already approved. Because it was due first, it pushed the documents that hold up real work into
  "later", and the next action said the finished step "cannot finish". Approved steps no longer count.
- **Also fixed:**
  - The next action's date is the most urgent one, not the latest.
  - The property test now runs `today` across three weeks and checks sent-back and late documents, ties, approved
    steps and unknown steps.
  - Heading levels are corrected.
  - The panel opens when only later documents remain.
- **Recorded:** a late date shows as "due <date>" without the word "late".

## Dependencies

O6 (document requests), O12 (the client's engagement page and next action), E9. No new library.

## Risks

- **A client who waits for "now" may find a later step short of documents.** Mitigated: the later list shows each
  step's expected date, the next action names the date the next batch is needed from, and late steps' documents move
  to "now".

## Owner decisions

- Open: the Arabic wording of the new strings (gap 128).

## Rollback

Revert the merge: a pure function, one view field and page markup; no migration, no data.

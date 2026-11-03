# E8 Quick match: four questions to the place to look at first

Status: merged (camayank/mkw-uae-growth#29, 3 Nov 2026; previously verified-pending-merge, branch `outcome/E8-quick-match`, built on `main` at 30f3d95 with E7E merged;
released by the owner on 3 Nov 2026: "then build the new selector into the app", after reviewing the interactive
selector on the design canvas "Tasees App Redesign", board "Selector, interactive")

## Business result

A first-time visitor gets to one concrete place to look at in four answers instead of eleven: what the business
does (tiles with icons), where (a map of the seven emirates with their flags), how many visas (a counter) and a
budget band. After each answer they see how many places still fit, per emirate and per budget band, so the choice
feels like progress, not a form. The last screen names the place to look at first with its checked figures (or
"to be verified"), two alternatives, and one strong next step: "Get my exact price" (the existing review request)
or "See the full comparison" (the existing eleven-question assessment, opening at the first question not yet
asked). Nothing unapproved is stated (D80), and nothing the engine does not conclude is implied.

## Scope

1. **Core** (`packages/core/src/quick.ts`, pure): `quickMatch(answers, rules, zones, approvedRules, approvedPlaces,
   asOf)`. The counts come from the eligibility check over every place on record (the advice keeps only its first
   five fits), each place counted as open unless the public may see why it is excluded (`publicStatus`, now shared
   with the public view). The structure, "no option fits" and the ranking are the full assessment's on the same
   answers over every place; the place shown first is its first open place in the chosen emirate, else across the
   UAE, flagged `bestElsewhere`. `onRecord` tells "no place on record" apart from "nothing fits". Budget bands are
   fixed in `QUICK_BUDGETS` (D90).
2. **API**: `POST /api/public/quick` (activity, emirate or null for anywhere, visas, budget band), anonymous,
   rate-limited per IP (240 per window: the page asks again after every answer), writes nothing, keeps nothing.
   `publicAssess` and `publicQuick` share one loader (`publicInputs`). Contract refreshed (`docs/openapi.json`).
3. **Page** (`apps/web/public/selector.html`, `selector.js`): the homepage's primary call to action and the
   industry cards open the quick match; the eleven-question assessment stays one click away (`#start`) and every
   E7A path still works (saved codes, `?code=`, `#start`, change an answer, print, report, review request). New:
   a five-step tracker, activity tiles with icons, the emirate map with counts and flags (two columns on a phone),
   the visa counter, budget bands with counts, a dark side panel with the live count, the top three places and a
   profile meter, the answers with a change link each, and the result card. The quick answers feed the review
   request (about the place shown first: its emirate and the place itself; "anywhere" is never sent as an
   emirate) and the full questionnaire. The UAE flag colours run as a thin bar above the header.
4. **Measurement**: the quick steps report as `quick_activity`, `quick_emirate`, `quick_visas`, `quick_budget` on
   the existing funnel (no new stage, no new field); the result counts as completed and viewed.
5. **Arabic**: the new strings are in the dictionary, draft until the Arabic reviewer signs off (as before).

## Exclusions

- No match percentage or score: the engine produces statuses, not a percentage, and the design's "88% match" was a
  design figure. The page shows the engine's status label instead.
- No new price, package or figure: the quick match shows only what the catalogue holds and the founder approved.
- The rest of the canvas restyle (homepage package cards and map teaser, client, partner and staff screens) is a
  separate outcome; this one builds the selector.
- No change to the engine's rules, ranking or the public filter's meaning (only `publicStatus` is extracted).

## Acceptance evidence

- Core (`packages/core/test/quick.test.ts`): with nothing approved, no figure, rule text or exclusion reaches the
  public and no answer makes a count fall (over 4 activities × 3 emirates × 4 visa counts × 5 budgets); the place
  shown first equals the full assessment's first place on the same answers within the emirate; counts are not capped
  at five; with everything approved the counts fall with the budget and the visas and the figures appear; an
  emirate with nothing open shows the closest place elsewhere and says so; the engine reads only the four answers;
  the structure, "no option fits" and the place that leads agree with the full assessment over every place (with
  and without approvals, including a case where one emirate holds only a mainland place); an emirate with no place
  on record is reported as such.
- API (`apps/api/test/quick-match.test.ts`): nothing written (requests, leads, audit, outbox, funnel), no money
  word, no figure until a place is approved; an approved place's figures and source appear; an unapproved budget
  exclusion leaves the count unchanged and the approved one removes the place; bad input refused; 429 past the
  limit.
- Smoke (`scripts/smoke.mjs`): the industry cards open the quick match; the four answers with live counts on the
  map and the bands; the result with nothing approved (no AED figure, "to be verified", the exact-price call and the
  review form); the full comparison opens at question 2 of 11 with no review form or quick match left on screen; at 390 px no horizontal overflow on the map and the
  result; after the founder approves IFZA its figure reaches the quick match labelled checked; axe on the quick
  match result and the phone map.

Evidence recorded on 3 Nov 2026, after the review fixes (`docs/evidence/E8/`):

- `pnpm test`: core 139 passed (15 files); api 359 passed, 1 skipped (35 files), on PGlite (`tests-pglite.txt`).
  `pnpm typecheck` clean. `docs/openapi.json` refreshed; the contract test passes.
- `scripts/smoke.mjs` against a fresh demo: 279 checks OK, 0 failed (`smoke-log.txt`; 257 before E8).
- axe on 50 screens, 0 violations, including "quick match result (E8)" and "quick match map at 390 px (E8)"
  (`axe.json`).
- Screenshots: `103-quick-match-desktop.png` (1280 px, the result), `104-quick-match-map-phone.png` and
  `105-quick-match-phone.png` (390 px), `95-public-home.png` (the homepage with the new call to action).
- By hand in a browser: "anywhere" sends the shown place's emirate and name with the review request (no invented
  emirate); an emirate with no place on record reads "no places on record yet".

## Independent review

An independent review of the first commit found: the structure badge and "no option fits" could differ from the
full assessment (the engine was run on one emirate's places); the evidence folder was missing; an invented "No
preference" emirate could reach pricing and allocation; an emirate with no place on record read as "nothing fits";
a late count could redraw the quick match over the full questions; a failed count left an old match under new
answers; focus was lost on the side panel's links; the visa counter recorded an answer the founder never gave; and
some new strings had no Arabic. The Codex review of the pull request then found two slow-response races: a
match for earlier answers could show under new ones (with the exact-price action and the review form), and a count
arriving after the founder left for the full questions could overwrite their answers. A match now shows only for the
answers it was computed from, and leaving the quick match drops any count on its way; the smoke test slows the
platform's answers to prove both. All are fixed with a test or smoke check where one applies; the ordering of places
by unapproved data is recorded as gap 112.

## Dependencies

E3 (D80 public display), E7A (selector page), E7C (funnel). No new library.

## Risks

- A founder reads the place shown first as advice. Mitigated: the label says "the place to look at first", the
  status reads "to be verified by a person" until approved, the disclaimer and "preliminary, general information,
  not advice" are on the result, and the next step is a person's review.
- Counts look static in the pilot because few rules are approved: correct under D80 (gap 108).
- The flags are simplified drawings (gap 107).

## Owner decisions

- The budget bands (15,000, 25,000, 50,000, more or not sure) (D90, gap 109).
- The flag artwork, checked against official sources before launch (gap 107).
- The Arabic wording of the new strings (the existing Arabic reviewer sign-off).

## Rollback

Revert the merge. The endpoint is additive; the page returns to the E7A homepage and questionnaire; no migration,
no data written.

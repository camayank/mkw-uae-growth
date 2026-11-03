# E13 Recommendation trust: the public order on approved facts only

Status: verified-pending-merge (branch `outcome/E13-recommendation-trust`, on `main` at 403fcc5 with E12 merged;
released by the owner on 3 Nov 2026: "yes" to E13 as proposed after the portal assessment, with the decision
"Approved facts only" on the ranking, D95)

## Business result

A founder is never told that one place is the one to look at first on the strength of a figure or a condition that no
one has checked. Places on every public screen come in an order the public can see the reasons for. The quick match
names "a place worth reviewing first" only when a named person approved it for public display; until then it shows
"places to review", side by side, and says why there is no lead. The counts say how many places are "not yet ruled
out", which is what they measure, instead of how many "fit".

## Scope

1. **Core** (`packages/core/src/public.ts`, pure):
   - `publicOrder(places, approvedRules, approvedPlaces, confirmed, structureStatus)`: the engine's sort keys computed
     on what the public may see. These are the confirmed structure, the public status, the founder's answers (the
     place they named, the emirate), and an approved place's record (activities, visa package) and lowest estimate.
     The name breaks ties. For an unapproved place, "data unavailable" orders like "to be verified", since it comes
     from the place's unapproved record.
   - `publicStatus`: a place no one approved reads "to be verified" unless an approved rule excludes it.
   - `publicView` lists places in that order, and a conclusion resting on place rules ("no place of this structure
     fits", "no place fits") is public only when every place is approved.
   - `publicAssessment(input, …)`: the engine over every place on record (not only the advice's first five), filtered
     and ordered for the public. While any place is unapproved, the structure is the one the rules reach on the
     answers alone (`structureOnRules`, extracted from `advise` with `requestedDiffers`), and the licences, obligations
     and cross-border points are stated for it (`statementsFor`, also extracted; the engine is unchanged).
2. **Quick match** (`packages/core/src/quick.ts`): it takes its first three places from the public assessment (in the
   chosen emirate when it has an open place there). It returns `lead`: true only when the first place is approved
   for public display.
3. **API** (`apps/api/src/services/public.ts`): `publicAssess` uses `publicAssessment`, so the public result, the
   saved result, the lead's handoff and the preliminary report read the same order.
4. **Page** (`selector.html`, `selector.js`):
   - With a lead, the result reads "A place worth reviewing first in …" and says what put it first.
   - Without a lead, it reads "Places to review in …", with three equal cards and the actions in their own card.
   - Counts and bands say "not yet ruled out".
   - "show me the best value anywhere" becomes "anywhere in the UAE".
   - The homepage copy no longer promises "the place to look at first".
   - A review request without a lead no longer names the first listed place as the founder's choice.
5. **Arabic**: the new strings are in the dictionary as drafts (gap 119).
6. **Housekeeping**: E12 recorded as merged (camayank/mkw-uae-growth#33).

## Exclusions

- No change to staff screens, the review, offers, pricing or allocation: they keep the engine's full order.
- No change to what is approved or how (D80), to the counts' meaning (they already fell only on approved
  exclusions), or to the engine's rules.
- No verified data: the catalogue's first wave stays a backlog (gap 92), so with nothing approved the order is the
  founder's answers and the name (gap 118).

## Acceptance evidence

- Core (`packages/core/test/public-order.test.ts`, new):
  - With everything approved, the public order equals the engine's order, over 972 founders (activity, emirate, visas,
    budget, a named place, premises).
  - With nothing approved, the order is the founder's answers, then the name.
  - Changing an unapproved place's estimates, activities, facilities or visa limits never moves the order, a status,
    the confirmed structure or "no option fits": with and without approved places, budgets included, two or more
    places of each kind.
  - An unapproved estimate cannot switch the confirmed structure or drop its obligations; with every place approved
    the engine's move shows.
  - The perturbation test also compares every public statement (reasons, licences, obligations, cross-border).
- Core (`public.test.ts`): "no option fits" is public only when its rules and every place are approved.
  - An approved place with a checked estimate comes ahead, and approving it moves nothing else.
  - The quick match has no lead with nothing approved, and has one when the first place is approved.
- Core (`quick.test.ts`): the quick match's first place, count, structure and conclusion equal the full public
  assessment's, every time (the earlier "within the first five" caveat is gone). Nothing approved means no lead.
- API:
  - `quick-match.test.ts`: no lead, and places by name, with nothing approved; IFZA first and a lead once approved.
  - `scenarios.test.ts`: the public list holds every place the review lists, in the public order.
- Smoke (`scripts/smoke.mjs`):
  - With nothing approved, "Places to review in Dubai" shows three cards in name order, no "worth reviewing first",
    and the counts say "not yet ruled out".
  - After the founder approves IFZA, "A place worth reviewing first in Dubai" shows IFZA with its checked figures.
  - Every earlier check is unchanged.

Evidence recorded on 3 Nov 2026 (`docs/evidence/E13/`):

- Tests (`tests-pglite.txt`): core 147 passed (16 files); API 359 passed, 1 skipped (35 files), on PGlite.
- Typecheck: `pnpm typecheck` clean (`typecheck.txt`).
- `scripts/smoke.mjs` against a fresh demo: 313 checks OK, 0 failed (`smoke-log.txt`; 310 after E12).
- Screenshots:
  - `103-quick-match-desktop.png` (no lead, 1280 px);
  - `105-quick-match-phone.png` (no lead, 390 px);
  - `115-quick-match-lead.png` (IFZA approved, 1280 px);
  - `95-public-home.png` (the homepage copy).

## Independent review

One blocking finding, fixed with a test. Through the structure switch (`structure.no_viable_place`), an unapproved
estimate or visa limit could change the structure the public sees as confirmed, and with it the order.

Also fixed:
- An unapproved place could read as a fit, or as "data unavailable", from its unapproved facilities record.
- The perturbation test missed budgets, visa limits and kinds with one place.
- An approved place with no estimate could lead.
- A stale named place could reach a later review request.
- Leftover wording ("the place to look at first"), and "Your match" over a list with no lead.

Recorded rather than changed:
- The named place is still matched by authority and alias, since that is the founder's own answer (D95).
- The engine still runs about six times per answer (gap 121).
- The review request's emirate for "anywhere" (gap 120).

## Codex review

One finding, fixed with a test: when unapproved figures moved the engine to another structure, the public showed
the structure the rules reach, but the obligations still came from the engine's move. An approved free zone
corporate tax point could therefore go missing. The statements are now generated for the structure shown.

## Dependencies

E3 (D80), E8 (quick match), E11 (homepage). No new library.

## Risks

- **Weaker first impression.** With nothing approved, the places listed first can be unsuited, because the rule that
  rules them out is not approved yet. Mitigated: the page names no lead and says the list is by answers and name.
  Approving rules and places fixes the order itself (gap 118).
- **Conversion.** "Places to review" is less persuasive than a single answer. That is the owner's choice (D95), and
  the exact-price action is unchanged.

## Owner decisions

- Decided: approved facts only (D95, 3 Nov 2026).
- Open: the Arabic wording of the new strings (gap 119).

## Rollback

Revert the merge. Pure functions and page copy only; no migration, no data.

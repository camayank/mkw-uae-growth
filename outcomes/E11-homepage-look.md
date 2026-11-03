# E11 Homepage look: the public homepage in the canvas look

Status: verified-pending-merge (branch `outcome/E11-homepage-look`, on `main` at d253cb5 with E10 merged; released by
the owner on 3 Nov 2026: "restyle the homepage like the canvas too")

## Business result

A first-time visitor lands on a page shaped like the canvas homepage:
- the first question to try straight away, with the number of places on record;
- the four promises the product keeps;
- a card per kind of company with its checked starting price, or "to be verified";
- the emirates map to tap;
- a short FAQ and one closing call to action.

Every figure comes from the platform, and every price from a named person's approval (D80).

## Scope

1. **Core** (`packages/core/src/quick.ts`): `byType` on the quick match. For each kind of place (free zone,
   mainland, financial centre, offshore) it gives:
   - the places still open;
   - the lowest setup estimate among the places of that kind approved for public display, or null when there is
     none.
2. **Page** (`apps/web/public/selector.html`, `selector.js`):
   - the hero, with the existing copy and actions plus a "try the first question" card (four activity tiles, the
     places on record, Next);
   - the strip of four promises;
   - the four package cards;
   - the emirates map, where a tap starts the quick match with that emirate chosen;
   - the existing industries, how it works, and what we do and do not do;
   - three FAQ items and the closing call to action band;
   - a wide layout for the homepage, as for the quick match.
3. **Arabic**: the new strings and two patterns, as drafts.

## Exclusions

- The canvas's package prices, "most chosen" badge, "40+ free zones" and "one fixed price" (D93).
- Statements of what a structure allows (they need an approved statement; the guidance notes are the place).

## Acceptance evidence

- Core: with nothing approved no kind quotes a price; with only IFZA approved the free zone card quotes IFZA, not a
  lower unapproved place; counts follow the chosen emirate.
- API: no `fromFils` before approval; IFZA's 16,000 after it is approved.
- Smoke:
  - the homepage shows four try tiles, the strip, four kinds with no AED figure, the seven-emirate map with flags,
    three FAQ items and the call to action;
  - an emirate tapped on the map is already chosen at question 2;
  - after the founder approves IFZA, the free zone card quotes "from AED 12,000" labelled checked and the other
    three stay to be verified;
  - every earlier check holds (the homepage texts, industries, measurement notice, sign-in link);
  - axe passes on the homepage at desktop and phone width.

Evidence recorded on 3 Nov 2026 (`docs/evidence/E11/`):

- `pnpm test`: core 140 passed; api 359 passed, 1 skipped (`tests-pglite.txt`). `pnpm typecheck` clean.
- `scripts/smoke.mjs` against a fresh demo: 309 checks OK, 0 failed (`smoke-log.txt`; 303 after E10).
- axe on 56 screens, 0 violations, including the homepage at 1280 and 390 px and with a checked figure (`axe.json`).
- Screenshots: `95-public-home.png` (1280 px), `94-mobile-public-home.png` (390 px).

## Independent review

No blocking finding. Applied:
- the "from" figure names its place and carries "preliminary estimate, as of" the rules' date, so it is never a claim
  about a whole kind;
- the counts read places on record (`onRecord`);
- the try tiles' accessible names are their visible text;
- the missing Arabic strings and patterns are added;
- the heading margins on the try card and the call-to-action band are fixed;
- the package buttons now read "Start the four questions" and are described by their card's heading;
- the try card is a section;
- a map tap starts the questions at 1;
- focus is kept when the cards and map redraw;
- colours come from tokens;
- the quick result's "one fixed price" now reads "priced offers";
- the FAQ says the offers come from MKW Advisors;
- core tests cover an approved place with no estimate and an approved place excluded by an approved rule;
- the phone homepage is checked after the data arrives;
- axe runs on the homepage with a checked figure.

## Dependencies

E8 (quick match, map, flags), E10. No new library.

## Risks

- A visitor reads "from" as a price: the note under the cards says it is an estimate including government fees and
  that a price comes only from an offer.

## Owner decisions

The flag artwork (gap 107) and the Arabic wording (gap 111) remain open.

## Rollback

Revert the merge: the endpoint field is additive; the page returns to the E8 homepage.

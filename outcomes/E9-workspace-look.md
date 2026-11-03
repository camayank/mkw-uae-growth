# E9 Workspace look: the restyled client and staff screens

Status: verified-pending-merge (branch `outcome/E9-workspace-look`, on `main` at 1ca2778 with E8 merged; released by
the owner on 3 Nov 2026: "now build the restyled client and staff screens into the app", after the design canvas
"Tasees App Redesign" was restyled)

## Business result

The client's and MKW staff's screens look like the product the founder approved on the canvas: the UAE colours above
the bar, one gold button for the one thing to do, the client's money on a dark panel with gold figures, a tracker
that shows where their work stands, a flag beside each emirate, icons in the menus and on the staff figures, and a
dark console bar for staff. Nothing a screen says changes, and every number on it still comes from the platform.

## Scope

1. **Shared look** (`tokens.css`, `styles.css`, `index.html`): gold and dark-panel tokens (light and dark themes),
   rounder corners, the flag bar, `.btn.gold`, `.panel-dark`, `ol.journey`, KPI tiles with icons, flags, menu icons at
   every width, the dark staff bar with a gold marker on the open entry; the T mark for clients, M (MKW Advisors) for
   partners and staff.
2. **Helpers** (`js/core.js`): `flag(emirate)`, `journey(steps, label)`, `kpiTile(label, value, sub, icon)`.
3. **Client**: the home's journey (`clientJourney` in `js/client.js`, from the engagement's status and approved steps,
   else the newest open request with its advice and offers), the next action's button in gold, the money card as a
   dark panel, the flag on engagement cards; the offer's accept button in gold; the engagement page's flag, steps
   progress bar and gold approve.
4. **Staff**: icons on every menu entry; the dashboard's figures on icon tiles, the first on the dark panel, the
   on-time rate with a progress bar; the queue's counts as icon tiles; flags on the request, lead, search and advice
   places.
5. **Arabic**: the journey's labels in the dictionary (draft).

## Exclusions

- The staff sidebar (the owner kept the grouped menu, gap 113), the partner scorecard panels (gap 114), and the
  canvas's invented figures.
- Any new data, endpoint or wording of a rule, a price or advice.
- Web fonts (D91).

## Acceptance evidence

- Smoke (`scripts/smoke.mjs`):
  - the client's journey marks the deposit as the step now after acceptance, and delivery with the steps approved
    once in delivery;
  - the flag bar and the T mark for the client; the gold next action; the engagement's flag and progress bar; the
    money on the dark panel;
  - the staff bar is dark with an icon on each of the four entries and the M mark; the dashboard's icon tiles with
    the first on the dark panel; a partner sees the M mark and no Tasees;
  - the staff menu still on one row at 1280 px (O10 checks unchanged); the Arabic client screens leak none of the
    new labels; axe on the client home with the journey and the staff dashboard; every existing check unchanged.
- Screenshots at desktop and phone width.

Evidence recorded on 3 Nov 2026 (`docs/evidence/E9/`):

- `pnpm test`: core 139 passed; api 359 passed, 1 skipped, on PGlite (`tests-pglite.txt`). `pnpm typecheck` clean.
- `scripts/smoke.mjs` against a fresh demo: 288 checks OK, 0 failed (`smoke-log.txt`; 279 after E8).
- axe on 52 screens, 0 violations, including "client home with the journey and the money panel (E9)" and "staff
  dashboard with icon tiles (E9)" (`axe.json`).
- Screenshots: `106-client-home-journey.png`, `13-client-engagement-approved.png`, `107-staff-dashboard.png`,
  `61-console-menu.png` (1280 px); `75-mobile-client-home.png`, `77-mobile-client-timeline.png` (390 px).

## Dependencies

U1 (workspace redesign), E8 (the flag drawings, gap 107). No new library.

## Risks

- A journey step read as a promise: the tracker shows only states the platform holds and names no date.
- Contrast on the dark and gold surfaces: checked by axe on the changed screens.

## Owner decisions

- Decided: staff keep the grouped menu (3 Nov 2026). Open: the flag artwork (gap 107); the Arabic labels (gap 116).

## Rollback

Revert the merge: styles, helpers and markup only; no migration, no data.

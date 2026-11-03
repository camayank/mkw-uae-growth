# E10 Partner look: the partner screens in the restyled look

Status: verified-pending-merge (branch `outcome/E10-partner-look`, on `main` at dbedb52 with E9 merged; released by
the owner on 3 Nov 2026: "now restyle the partner screens too")

## Business result

A partner firm's screens match the client and staff workspace. They carry MKW Advisors' brand only (rule 10). The
scorecard that decides who gets work comes first, and the money they are owed is summed by state. Every figure is
one the partner already had.

## Scope

1. **Bar**: the dark MKW Advisors bar with the M mark, as for staff; at 641 px and wider the menu entries are light on
   dark, and at 1024 px and wider they never wrap. On a phone the tab bar stays light (U1).
2. **Work** (`renderPartnerHome`):
   - icon tiles, with "offers waiting" on the dark panel and the quality score linked to the scorecard;
   - a flag beside each emirate in the offers and in delivery;
   - the first offer's Accept in gold.
3. **Performance** (`renderPartnerPerformance`): the quality score first on the dark panel (with "provisional" when
   the scorecard says so), the on-time rate with a progress bar, and the rest on icon tiles.
4. **Payouts** (`renderPartnerPayouts`): tiles summing the partner's payouts by state: due now (invoice us), paid,
   not yet payable, and withheld when there is any.
5. **Engagement** (`renderPartnerEngagement`): the emirate's flag in the title, the steps approved as a progress bar,
   and the next step's "Submit for checking" in gold.

## Exclusions

- The canvas's invented partner figures, such as an on-time streak of the last twelve steps (gap 114).
- Any new data: no client price, margin or other partner's figure (rule 1).

## Acceptance evidence

- Smoke (`scripts/smoke.mjs`):
  - the partner's bar is dark with the M mark, and the menu is on one row at 1280 px;
  - the quality score leads the performance tiles, with eight icon tiles and no "Tasees" anywhere on the page;
  - payouts are summed by state with "due now" first;
  - flags appear beside emirates in delivery, with icon tiles on Work;
  - the partner engagement has the flag and the progress bar;
  - axe passes on performance and work;
  - every earlier check is unchanged, including the partner's phone tab bar and its M mark.

Evidence recorded on 3 Nov 2026 (`docs/evidence/E10/`):

- `pnpm test`: core 139 passed; api 359 passed, 1 skipped (`tests-pglite.txt`). `pnpm typecheck` clean.
- `scripts/smoke.mjs` against a fresh demo: 303 checks OK, 0 failed (`smoke-log.txt`; 290 after E9).
- axe on 55 screens, 0 violations, including the partner performance, work and the engagement at 390 px (`axe.json`).
- Screenshots at 1280 px: `10-partner-offered-work.png` (the gold Accept), `108-partner-performance.png`,
  `109-partner-work.png`, `110-partner-payouts.png`, `11-partner-engagement.png`.
- Screenshots at 390 px: `93-mobile-partner-work.png`, `111-mobile-partner-performance.png`,
  `112-mobile-partner-payouts.png`, `113-mobile-partner-engagement.png`.

## Independent review

No blocking finding. Applied:
- the screenshots now cover Payouts and the gold Accept (`10-`, `110-`), phone width for Performance, Payouts and the
  engagement (`111-` to `113-`), and the engagement from the top of the page;
- the gold Submit is set by an option rather than a string replace, with a check that it is the page's only gold;
- the gold Accept goes to the offer that is due soonest;
- the payout tiles are checked against the rows' sums; the flags against the in-delivery rows; "Tasees" on every
  partner page checked;
- the 640/641 px media-query gap is closed;
- doc wording is corrected, and the canvas's streak is kept open as gap 117;
- the M favicon for partners and staff (rule 10).

## CI

CI's smoke run (DejaVu Sans on Linux) found the partner engagement 393 px wide on a 390 px phone. The cause was the
evidence form, a flex item inside the row of step actions, which kept its content's width. It now takes the row's
width and may shrink (`.actions > form`). `SMOKE_WIDE_FONT=1` renders the partner phone pages in DejaVu Sans, which
reproduced the failure here and shows the fix (390/390 px). The phone checks now log page width, tab bar and top bar
colours.

## Dependencies

E9 (the look, helpers and tokens). No new library.

## Risks

- A dark bar on a phone would turn the light tab bar's links unreadable: the menu colours apply from 641 px only,
  and the phone tab bar check still passes.

## Owner decisions

None.

## Rollback

Revert the merge: styles and markup only.

# E12 The emirates map on the Arabic page

Status: verified-pending-merge (branch `outcome/E12-arabic-map`, on `main` at 2282009 with E11 merged; released by
the owner on 3 Nov 2026: "yes fix them and merge when green", after the Arabic screenshots of the new homepage)

## Business result

On the Arabic page the emirates map shows the UAE the right way round, with west on the left, and each emirate's
name appears once.

## Scope

- `apps/web/public/selector.html`: the `.uaemap` grid is laid out left to right on every page, while the emirates'
  labels read right to left on the Arabic page.
- The small Arabic name under each emirate is hidden on the Arabic page.
- On a phone (the two-column list) the map follows the page's direction.
- This covers the homepage map and the quick match's map, which share the styles.

## Exclusions

None: style only. D94.

## Acceptance evidence

- Smoke check on the Arabic homepage at 1280 px:
  - Abu Dhabi lies left of Dubai, and Dubai left of Ras Al Khaimah;
  - no small Arabic name is shown;
  - the tiles read right to left.
- Screenshots: `114-public-home-ar.png`, `map-ar-1280.png`, `map-ar-390.png`. `scripts/smoke.mjs` on a fresh demo: 310 checks OK, 0 failed (`smoke-log.txt`); every earlier check unchanged.

## Dependencies

E11.

## Risks

None known.

## Owner decisions

None.

## Rollback

Revert the merge.

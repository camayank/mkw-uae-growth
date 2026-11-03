# E7A Public product UX: homepage, questionnaire and comparison

Status: merged (camayank/mkw-uae-growth#24; branch `outcome/E7A-public-product-ux`; released by the owner on 3 Nov 2026 with the E7
contract "Commercial launch readiness and product excellence": "begin implementing E7A, together with any
independent, essential work needed to make the selector genuinely useful")

## Phase 0: the baseline this starts from (run on 3 Nov 2026)

`main` at `92ca94b` (E6 merged, camayank/mkw-uae-growth#22). U1 (the client and partner workspace redesign) is open
as camayank/mkw-uae-growth#23 and does not touch the public pages. Executed here before any change:

| Check | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | pass |
| Typecheck | `pnpm typecheck` | pass |
| Tests | `pnpm test` | 105 core + 333 API pass (1 PostgreSQL-only test skipped on PGlite); 108 + 334 after E7A and the U1 merge |
| Build | `pnpm build` | pass |
| Browser | `scripts/smoke.mjs` on a fresh demo | 213 checks OK (E6 evidence; rerun under U1 at 221) |

What the public product is today, against the E7 acceptance criteria (status: works / partial / unverified /
blocked):

| Criterion | Status | Where |
| --- | --- | --- |
| Discover the product and understand its purpose | partial | `selector.html` opens on question 1 with two lines of explanation; no homepage, no value proposition, no industry entry |
| Complete a relevant assessment without unnecessary questions | partial | 8 questions, one conditional (premises skipped for a holding company); no reason given for asking; progress is a sentence |
| Receive useful, appropriately verified information | partial | Only approved statements and figures show (D80); with nothing approved the page is honest but thin; no general guidance |
| Understand why structures do or do not suit | works | Every structure with its status and first finding; excluded places with the failing rule when approved |
| Compare options without misleading figures | partial | Places are a list; no side-by-side comparison; no three-year view; no source links; facilities not shown |
| Save and recover the assessment | works | Code on the founder's action, recovery re-runs on today's rules (E4) |
| Edit the assessment | missing | "Start again" wipes the answers |
| Request help with explicit consent | works | Review request with service, marketing and partner-disclosure consents (E4) |
| Mobile, tablet, desktop; keyboard and screen reader | works | 390 px and 1280 px in the smoke test; axe clean |
| Route to the authenticated workspace | missing | No link from the selector to `/` |
| Funnel measurement, lead scoring, reports, dashboards | later | E7C and E7D |

## Business result

A first-time visitor lands on a page that says what Right UAE Entity is and what it will give them, starts from
their industry, answers only the questions that apply with a reason for each, and gets a result they can read as a
decision: their profile, the structures compared, the places compared side by side, what is checked and what is
not, general guidance a named person approved, and one next action. They can save it, change an answer, print it
and ask for a review. Nothing unapproved is stated (D80); nothing that is not known is implied.

## Scope

1. **Homepage** on `selector.html` (the URL every link and test already uses): value proposition, the primary call
   to action "Find the Right UAE Entity", seven industry entry points (consulting, technology, trading, e-commerce,
   manufacturing, holding and investment, regulated finance), how it works in three steps, what the result is and
   is not, and the route to the Tasees workspace (`/`). `#start` and `?industry=` open the questionnaire directly.
2. **Questionnaire**: the questions ordered by what matters for the industry chosen (premises first for
   manufacturing, owners first for a holding company); two new optional questions the engine already reads (a
   structure the founder has in mind, expected turnover for the tax points); a "why we ask" line per question; a
   progress bar with the true count; validation, loading and error states; keyboard focus on each step.
3. **Result as a decision**: the business profile with an edit link per answer; a legend of the six labels
   (checked, with conditions, general information, to be verified, data missing, specialist review); the structure
   pathways; the places as cards with a compare control (up to five) and a side-by-side table (status, setup
   estimate, yearly renewal, three-year estimate when both are approved, visas in the package, facilities on record,
   timeline, conditions, points a person checks, authority, official source); rejected alternatives with the
   failing rule when approved; licences, what follows after setup, cross-border points for a specialist, what would
   sharpen the result; the recommended next action; save, print, change answers, start again.
4. **General guidance** (`packages/core/src/guidance.ts`): short educational notes per structure, activity and
   situation, written without figures, rates or statutory conclusions. Each is a draft until the founder approves
   its version for public display (`public_approvals`, kind `guide`, migration 019); the public sees only approved
   notes, labelled "general information", and the Scoping page lists them with approve and withdraw.
5. **Public view additions** (`packages/core/src/public.ts`): an approved place also carries its official source
   link and the facilities on record; both are part of the place's approved version, so a change lapses the approval.
6. **Arabic**: dictionary and pattern entries for every new public string (draft, under the reviewer gate).
7. **Smoke**: the homepage, an industry entry, the progress bar, the comparison table, a guide approved and shown,
   editing an answer, at 1280 and 390 px; axe on each new screen.

## Exclusions

- Funnel events and conversion dashboards (E7C); the downloadable report (E7D); jurisdiction coverage and the
  verified data pipeline (E7B). Where the comparison needs data E7B will bring (facilities, renewals, activity
  lists), the cell says "not on record".
- No change to the engine's rules or to what counts as approved (D80 stands; a guide's approval is the founder's).
- No map, no booking, no email.

## Acceptance evidence

- Core: a guide never contains a figure, a percentage or a statutory verb; selection is deterministic and depends
  on the answers only; the public view carries a source link and facilities only for an approved place.
- API: a guide is approved by the founder only, audited, lapses when its text changes, and reaches the public
  assessment only while approved; the assessment still writes nothing and carries no money field.
- Smoke on a fresh demo: the homepage at 1280 and 390 px; an industry entry starts at the right question; the
  progress bar counts the visible questions; the result shows the profile, the legend and the comparison table;
  the founder approves one guide and the selector shows it; "Change my answers" keeps the answers; axe clean.
- Screenshots under `docs/evidence/E7A/`.

## Dependencies and risks

- Depends on E3–E6 (merged). U1 (open) touches none of these files.
- Risk: the existing smoke checks drive the questionnaire by position; they are updated with the order, never
  weakened.
- Risk: guidance wording is general and figure-free by construction, but it is still the owner's to approve; nothing
  shows until they do.

## Owner decisions

- Approve the guidance notes (or edit them first) on the Scoping page; they are drafts.
- The homepage wording is a draft for the owner's marketing voice.

## Rollback

- Revert the pull request. Migration 019 only widens a check constraint.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm typecheck` clean; `pnpm test`: 108 core + 334 API (1 PostgreSQL-only test skipped on PGlite) = 442 (E6 and U1: 105 + 333). New: `packages/core/test/guidance.test.ts` (figure-free wording, deterministic selection, source and facilities gated on approval); `apps/api/test/public-selector.test.ts` (a guide is founder-only, audited as entity `guide`, versioned by its wording, public only while approved, chosen by the answers; an approved place carries its source; the assessment still writes nothing and carries no money field); the OpenAPI contract regenerated for kind `guide` |
| Smoke | `docs/evidence/E7A/smoke-log.txt`: 234 checks OK on a fresh demo (U1: 221), 13 marked E7A: the homepage states the product, the call to action, seven industries, what it does not do and the route to the workspace; an industry entry starts at question two with premises first for manufacturing and the progress bar at ten percent; going back shows the chosen activity; the result opens with the profile, the legend and the side-by-side table with no figure before approval; no guidance before approval and the next action named; the table shows the approved place's figures, the three-year cell's honest wording and the official source; the Scoping page counts the approved note; changing the answers keeps them; the approved note reaches the public labelled general information with no figure; the homepage at 390 px has no overflow; the homepage in Arabic; axe on the homepage at both widths |
| Accessibility | `axe.json`: 43 screens at 1280 and 390 px, 0 violations (U1: 41) |
| Screens | `95-public-home.png` and `94-mobile-public-home.png` (the homepage), `83-public-selector-unapproved.png` (profile, legend, pathways, places, comparison with nothing approved), `84-public-selector-approved.png` (figures, source, a guidance note), `85-mobile-public-selector.png` (the result at 390 px), `38-scoping-rules.png` (the guidance table with approve and withdraw) |
| Audit chain | `pnpm verify:audit` on the smoke demo: intact, 109 events |
| Records | D85; KNOWN-GAPS 88–91; `docs/DESIGN.md` rows marked E7A; `docs/ENTITY-PROGRAMME.md` section 6 |

## Independent review

A separate reviewer read the whole diff before the pull request, with a throwaway Playwright probe against a scratch
seed and no repository changes. It found no D80 leak (source link, facilities, guidance, comparison cells, the
three-year figure and the next action are all gated on what is approved), no money field and no branding slip, and
confirmed migration 019 on Postgres and PGlite. Applied before the pull request:
- **Must-fix.** A holding founder was never asked where the customers are, so the result carried a "data missing"
  line for a question the page did not ask: the holding order now asks it. The outcome had no evidence yet (below).
- **Should-fix.** A result reached through the homepage or "back to the start" kept the old saved code (reset now);
  the five-place notice piled up (shown once); focus landed on the first choice, not the chosen one; the three-year
  smoke check could not fail (asserts the cell now); an unverified renewal read "not on record" (reads "to be
  verified", `renewalToBeVerified`); three guidance sentences reworded for UAE accuracy and tone (residence visa
  issue, not stamping; "not enough on its own"; "is expected to register"); the profile kept its question wording
  so the Arabic dictionary matches, plus three entries and a pattern; the legend is a list, not a paragraph with
  an ARIA label; a hidden level-one heading on the result; a sticky row header in the comparison on a phone.
- **Noted, not changed.** After a review is sent, changing an answer keeps the review form sent (no second lead
  from the same result); the comparison can hold two places by default when the named place is also in the top
  three; the matrix row in `docs/ENTITY-PROGRAMME.md` is corrected.

## Could not verify

- **Whether the guidance notes are right for every founder**: they are general and figure-free by construction and
  were read by the reviewer, but the owner approves each one; the pilot starts with none approved (gap 88).
- **How real founders read the homepage and the comparison**: tested by rule and by the browser suite, not by people.
- **The comparison with five approved places**: the demo approves one; the table's shape with five columns was
  checked by the reviewer's probe at 390 px (no page overflow, the box scrolls), not by the smoke test.


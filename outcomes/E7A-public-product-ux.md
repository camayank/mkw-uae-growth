# E7A Public product UX: homepage, questionnaire and comparison

Status: in-progress (branch `outcome/E7A-public-product-ux`; released by the owner on 3 Nov 2026 with the E7
contract "Commercial launch readiness and product excellence": "begin implementing E7A, together with any
independent, essential work needed to make the selector genuinely useful")

## Phase 0: the baseline this starts from (run on 3 Nov 2026)

`main` at `92ca94b` (E6 merged, camayank/mkw-uae-growth#22). U1 (the client and partner workspace redesign) is open
as camayank/mkw-uae-growth#23 and does not touch the public pages. Executed here before any change:

| Check | Command | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | pass |
| Typecheck | `pnpm typecheck` | pass |
| Tests | `pnpm test` | 105 core + 333 API pass (1 PostgreSQL-only test skipped on PGlite) |
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

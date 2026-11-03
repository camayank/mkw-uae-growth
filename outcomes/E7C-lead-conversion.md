# E7C Lead conversion intelligence: funnel, qualification, conversion dashboard, lead-to-Tasees regression

Status: in-progress (branch `outcome/E7C-lead-conversion`, built on E7B; released by the owner on 3 Nov 2026 with the E7
contract, phase 3 "Lead generation and revenue intelligence")

## Business result

MKW can see, with defensible numbers, how visitors become assessments, leads, proposals, engagements and revenue,
source by source; which leads to call first and why, with the evidence behind each score and a next best action the
adviser can override with a reason; and where the funnel leaks. Measurement is aggregate and anonymous: no cookie,
no contact detail, nothing a person did not already choose to give; a double submission never makes two leads; and
the path from a lead into Tasees keeps the organisation, the request, the answers, the attribution, the consents and
the owner intact, proven by a regression suite.

## Scope

1. **Funnel events** (migration 021, `funnel_events`). The public pages record, per browser session, the stages a
   visitor reaches: visited, assessment started, each step reached, completed, result viewed, compared, printed,
   saved. The id is a random value the browser keeps for the session only; no cookie, no IP, no user agent, no
   contact detail. One row per visitor, stage and key (a unique index), so repeats never double-count. The later
   stages (consultation requested, lead, qualified, proposal issued, accepted, engagement, revenue) are derived from
   the platform's own records, never sent by the browser. The review request carries the visitor id in its
   attribution, which joins the two halves. A measurement notice on the page says what is counted (owner wording,
   default labelled).
2. **Duplicate leads.** A second review request from the same email within a day with the same answers adds a note
   to the existing lead instead of a second lead; a different case makes a new lead. Conversion events are counted
   once per request and per offer (derived from records, so nothing can be sent twice).
3. **Two scores with evidence** (`packages/core/src/leads.ts`): purchase readiness (budget, start date, clear
   activity, visa need, call requested, saved and returned, phone given) and commercial value (regulated activity,
   cross-border ownership, corporate owner, investment size, holding or multi-entity, industrial premises, ongoing
   compliance from visas and revenue). Each score carries the factors and points behind it; the lead page shows them.
   The existing columns keep their names (intent, complexity); the labels change. One optional question, "When do
   you want to start?", feeds readiness.
4. **Next best action** (`nextBestAction`, pure): from the lead's status, scores, consultation request, owner,
   follow-ups and what its request became, one action and the reason (call today, book the call, assign an owner,
   chase the proposal, close, nothing: the client is on the engagement). The adviser overrides it with a reason,
   audited; the override shows beside the computed one.
5. **Conversion dashboard** (`GET /api/ops/pipeline/funnel`, console page Funnel, founder and ops): by source and
   campaign, visitors, started, completed, viewed, saved, leads, consultations, qualified, proposals, accepted,
   engagements, revenue; completion and abandonment rates with the step visitors stop at; won and lost; revenue by
   campaign and by segment; revenue per qualified lead; average days from lead to first contact and to proposal;
   unassigned and overdue high-intent leads; realised revenue (payments received) against the pipeline estimate
   (proposals published and not yet decided). Every figure is from recorded rows; the demo seeds none.
6. **Lead-to-Tasees regression** (`apps/api/test/lead-to-tasees.test.ts`): one test per risk the contract lists.

## Exclusions

- No sending, no booking, no marketing automation (rule 6; E4 stands). Marketing consent governs nothing here
  because nothing is sent; the events hold no personal data.
- No cross-site or cross-session tracking, no fingerprinting, no third-party script.
- The assessment report (E7D) and the funnel's download actions beyond print and save.

## Acceptance evidence

- Core: scores deterministic, bounded, with evidence that sums to the score; the next best action covers every
  status; no commercial input.
- API: events are anonymous (the row holds stage, step, source and a random id only), de-duplicated, rate-limited and
  written by nobody signed in; a double submission makes one lead; the funnel report follows a visitor from the first
  visit to accepted revenue and counts each stage once; overdue and unassigned high-intent leads are listed; the
  override is founder- or ops-only and audited; finance, clients and partners cannot read the funnel.
- Regression suite: no duplicate organisation or request, answers and attribution kept, consent history kept,
  ops approval not bypassed, no partner cost or margin through any lead endpoint, advice on changed data refused,
  the lead's owner kept after conversion.
- Smoke: the selector records stages that appear on the Funnel page; the lead page shows the evidence and the next
  best action; the Funnel page at 1280 and 390 px, axe clean.

## Dependencies and risks

- Depends on E4, E7A and E7B (all merged; main is merged into this branch).
- Risk: "qualified" is a definition (high readiness, or a person moved the lead past routing); it is written down
  on the page and can be changed in one place.

## Owner decisions

- The measurement notice wording (default labelled).
- Whether a day is the right window for a duplicate submission.

## Rollback

- Revert the pull request. Migration 021 adds a table and nullable columns.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm typecheck` clean; `pnpm test`: 127 core + 347 API (1 PostgreSQL-only test skipped on PGlite) = 474 (E7B: 125 + 338). New: `packages/core/test/leads.test.ts` (E7C block: evidence sums to the score, the new factors, monotone start date, the next best action for every state); `apps/api/test/funnel.test.ts` (anonymous and de-duplicated events, no audit or outbox row, roles; a double submission is one lead; the evidence and the next action on the lead; the override audited and cleared; first contact and closure recorded; the funnel report from the first visit to accepted revenue with counts once per request and offer, abandonment, lost reasons, turnaround, the attention list, no money field); `apps/api/test/lead-to-tasees.test.ts` (one test per 3D risk); the OpenAPI contract regenerated |
| Smoke | `docs/evidence/E7C/smoke-log.txt`: 251 checks OK on a fresh demo (E7B: 243), 8 marked E7C: the measurement notice; the lead page's evidence and next best action; the override beside the rule's suggestion; the Funnel page counting the selector's own visits through to the lead and naming the lead that needs a person; axe and no overflow at 390 px |
| Accessibility | `axe.json`: 47 screens at 1280 and 390 px, 0 violations (E7B: 45) |
| Screens | `98-funnel.png` (1280 px, full page), `99-mobile-funnel.png` (390 px), `87-lead-detail.png` (scores with evidence, next best action with the override), `86-leads-pipeline.png` (the next-action column) |
| Audit chain | `pnpm verify:audit` on the smoke demo: intact, 111 events |
| Records | D87; KNOWN-GAPS 96–100; `docs/DESIGN.md` rows; `docs/ENTITY-PROGRAMME.md` rows and paragraph |


# O12 Client experience

Status: verified-pending-merge (branch `outcome/O12-client-experience` from `main` after O11 merged as
camayank/mkw-uae-growth#12; released by the owner 25 Oct 2026)

## Business result

A client always knows the one thing Tasees needs from them, and why. Every client screen opens with that next action,
or says plainly that nothing is needed and what happens next. The offer reads as a proposal: what we will do, how it
will run, what it costs, what we promise, and the rules that apply, with one accept button. A new request is a short
conversation in which the plan builds on screen as the client answers. Requested documents arrive as a checklist that
checks each file before it leaves the page. Underneath, the web app becomes a set of small modules over shared design
tokens, still with no build step.

## Scope

1. **Next action (server).** `services/journey.ts` works out a client's next actions from their own rows, in order:
   an offer to decide (with its expiry), a payment due (with the link), a step to approve (with the date it is approved
   automatically), documents to upload, filing evidence due within 30 days. With nothing to do it says what is
   happening and when the next step is expected. `GET /api/client/home` returns `nextActions`; the client's engagement
   view returns `nextAction` and a `timeline` (offer accepted, deposit, each step, balance, completion), each entry with
   its state and date. Auto-approval dates use the working-time calendar with the holidays from Settings.
2. **Client home.** Opens with the next action (and how many more), then each engagement as a short progress line, then
   requests and offers as cards. Nothing about partners' costs or margin, as before.
3. **Engagement timeline (client).** A vertical timeline with the next action pinned above it. Each step shows its due
   date, its evidence once MKW has checked it, and the approve and raise-an-issue buttons when it waits for the
   client, with the auto-approval date stated where they act. Payments sit on the same line. Partners and MKW staff keep
   their current engagement page.
4. **Proposal-style offer.** Sections: what we will do (each service in plain words), how it will run (the steps and
   an estimate in working days from the milestone plan), what it costs (professional fees, MKW fees, VAT, government
   fees at cost, each government fee that is not confirmed marked with one sentence; the deposit now and the balance
   later), our guarantee, before you accept (the expiry date, five-working-day auto-approval, "we do not file for
   you", the client terms with their version). The tiers sit side by side as a choice. One accept button.
5. **Conversational intake (clients).** One question at a time in the same form, with Back and Next: starting point,
   the business, where, people, extra services and timing. A panel beside it ("Your plan so far") builds from
   `POST /api/requests/preview`, which runs the same scoping as a real request and writes nothing: the services, the
   suggested structure and place, each with its confidence in plain words ("confirmed", "we will verify this"). The
   panel is announced politely to screen readers; focus moves to each new question. MKW staff keep the full form.
6. **Checklist uploads.** Documents a partner asks for are a checklist on the engagement: each with its status, a drop
   zone and a file picker. Before anything is sent the page checks the file type and size against the server's own
   rules (`GET /api/upload-rules`, from `lib/storage.ts`), refuses an empty file, and asks for confirmation when the
   file name reads like a different document. Errors are shown beside the item and announced. Filing evidence on the
   compliance page and partner evidence use the same check.
7. **Design tokens.** `tokens.css` holds colour, space, type scale, radius, elevation, motion and focus tokens for both
   themes; `styles.css` and the new components use them. `docs/DESIGN.md` lists them and the component patterns.
8. **Web app modules.** `app.js` becomes an entry that loads ES modules under `js/`: shared core (state, API, formats,
   components), shell (routing, navigation, events), and one module per area (client, engagement, partner, ops,
   admin). No build step; the content security policy is unchanged.
9. **Arabic.** Every new client-facing string has an Arabic draft in the dictionary; clients still see Arabic only after
   the reviewer's sign-off.

## Exclusions

- Partner and staff screens beyond the module split (their journeys are later work).
- The public intake page (`intake.html`) keeps its form; it already collects PDPL consent for new clients.
- Card payments (O14), the Arabic review itself, and real AI drafting of the plan (O16).

## Acceptance evidence

- `apps/api/test/journey.test.ts`: next actions for each state in order (offer, payment, approval with its
  auto-approval date across a holiday, documents, filing, nothing to do), only the client's own rows, nothing about
  partner cost or margin; the timeline's entries and states; `POST /api/requests/preview` returns scope and advice with
  confidence words, writes no row, and is refused to partners; `GET /api/upload-rules` matches the storage adapter.
- `scripts/smoke.mjs`: the client completes the conversational intake, reads the proposal and accepts it, follows the
  timeline, uploads documents through the checklist (a refused file shown before upload), and approves a step from the
  pinned action; screenshots at 1280 px and 390 px; axe-core clean in English and Arabic; no partner cost, margin or
  masked contact detail on any client screen.
- Screenshots and log under `docs/evidence/O12/`.

## Dependencies and owner decisions

Depends on O11 (camayank/mkw-uae-growth#12). Needed from the owner: a wording review of the proposal and the intake
questions (shipped as drafts in plain English; the Arabic is a draft until the reviewer signs off).

## Risks

- A large change to the web app: mitigated by splitting the modules first with no behaviour change (smoke unchanged
  and passing), then changing screens one at a time.
- Next actions that disagree with the rules: they are computed on the server from the same rows and calendar the
  sweeps use, and tested per state.
- Client-side checks drifting from the server: the page reads the server's rules; the server still refuses.

## Rollback

No migration. Reverting the branch restores the previous screens; the new endpoints are read-only.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 57 core + 217 API = 274 (O11: 260), all passing on PGlite and on PostgreSQL 16; `pnpm typecheck` clean. New: `apps/api/test/journey.test.ts` (12); replacement uploads in `queue.test.ts`; delivered-but-not-recorded in `outbox.test.ts` |
| Next actions | in order: offer (with expiry), deposit (with the payment link), approval (auto-approval date counted in working days across a holiday), documents (each kind once, how many steps wait), filing evidence due within 30 days; nothing to do says what happens next and when; only the client's own rows; no partner cost or margin in any field; people's own words (a partner's reason for sending a document back) only in `detail` |
| Timeline | offer accepted, deposit, each step, balance, completion, each with its state and date; partners and staff keep their page |
| Proposal | fee notes come from the fee table for the request's place (estimate, or partner's quote at cost), even after ops overrides a price; recurring lines are listed but not in the working-day estimate; deposit and balance from `paymentPlan` |
| Intake preview | the same scoping as a real request under the person's own role; writes no row; refused to partners; no unreviewed advice reaches the client |
| Upload rules | `GET /api/upload-rules` equals the storage adapter's rules; the page refuses a wrong type, an empty or oversized file before upload, beside the item, and marks it invalid for screen readers; the server still refuses |
| Smoke | `docs/evidence/O12/log.txt` (168 checks OK on a fresh demo): the conversational intake with focus on each question and the plan building; the proposal's sections, estimate, deposit and rules, with no partner cost or margin; the pinned deposit and timeline; the pinned approval with its automatic approval date and the evidence MKW checked; a refused `.exe` in the checklist; the public intake page's layout unchanged |
| Screens | 1280 px: `02-client-intake.png`, `02b-client-intake-review.png`, `72-client-proposal.png`, `07-client-offer.png`, `08-client-engagement-awaiting-payment.png`, `73-client-timeline-approve.png`, `13-client-engagement-approved.png`, `74-client-checklist-refused.png`, `45-client-documents.png`; 390 px: `75`–`78` (home, intake, timeline, proposal) |
| Accessibility | axe-core zero WCAG 2.1 AA violations on 28 screens, including the four new client screens at 390 px and the client screens in Arabic (`docs/evidence/O12/axe.json`) |

## Could not verify

How clients find the conversation and the proposal: no client has used them yet (the pilot). The wording and its
Arabic drafts wait for the owner and the Arabic reviewer. Screen readers themselves (axe checks the markup, not
VoiceOver or TalkBack).

## Review

A reviewer who had not seen the build read the contract and the diff, ran the suites and walked the screens. Findings,
all fixed:

| Finding | Fix |
| --- | --- |
| The new `.intake` styles broke the public intake page's layout | Renamed `.intake-convo`; the smoke test checks the public page keeps its single column |
| The pinned approve asked the client to approve a step without showing what MKW checked | The card links the evidence and the button is described by the step |
| The guarantee paragraph promised more than the credit rule does | It says finance confirms each credit and that a delay only the client can cure may not qualify (D60; owner's wording review, gap 33) |
| Fee notes were read from the offer line's reason, which ops rewrites when setting a price | Read from the fee table for the request's place (D60), tested after a price override |
| Sentences with a name, date or amount stayed English in Arabic, and people's own words were sent to the reviewer's gap list (over its limit) | Patterns in `i18n-ar.js`; people's words travel in `detail`, shown as written and never reported; the limit stays 200 (D59) |
| The intake preview ran as the platform | Runs under the person's own role (D59) |
| Recurring services made the working-day estimate months long; tier copy claimed things the tiers do not differ on | Recurring lines are listed but not counted (D60); tier claims removed |

Nits fixed: the plan panel is a polite live region; the terms version is escaped; partner evidence shows its file check
beside the field; a stray drop no longer opens the file in place of the app; the file-name check knows more document
words; "Emirates ID" is written properly in the next action and sentences about returned documents start with a capital.

# O11 Ops command centre and event outbox

Status: verified-pending-merge (branch `outcome/O11-ops-command-centre` from `main`, released by the owner 25 Oct 2026)

## Business result

Ops runs the day from one queue ordered by risk and deadline. Every item says why it is there and what happens if
nobody acts, shows the AI's draft where there is one, and offers the obvious action as one click. Messages and agent
work leave through an outbox written in the same transaction as the change: a crash can no longer lose an email, a
retry can no longer send one twice, and a message whose delivery is in doubt goes to a person instead of being
re-sent blindly. Every uploaded document gets a first check by the document checker, as a draft ops agrees or
disagrees with. MKW can see how long items wait and how many ops minutes an engagement costs.

## Scope

1. **Event outbox.** Migration `011_outbox.sql` adds `outbox` (topic, payload, status, attempts, next attempt,
   claim time, last error, who resolved it and how). `Notifier.send()` inside a transaction writes its row in that
   transaction, so the message exists exactly when the change does; outside a transaction it writes its own row.
   - A dispatcher claims rows one at a time (`for update skip locked`, safe with several app tasks), delivers, and
     marks them done. It runs after each commit, from `notify.flush()` and on every jobs run (so anything left by a
     crash is picked up within 15 minutes).
   - A provider refusal is retried after 1, 5, 15 and 60 minutes; after the fifth attempt the row is `failed` and
     ops sees "Message not delivered" with Retry and Cancel.
   - A row left mid-delivery for 10 minutes (the process died between handing the email over and recording it) is
     `unknown`: ops sees "Delivery not confirmed" with "Send again" and "Mark as delivered". Never re-sent on its own.
   - Each message's `notifications` record carries its outbox id (unique), so a dispatch is recorded once.
   - Sign-in codes stay out of the outbox: the code is never written down (D11), it is useless after 10 minutes, and
     the person asks for a new one. They are sent after commit as today.
   - Retry, cancel and "mark as delivered" are ops or founder actions, audited.
2. **Document checker (first outbox subscriber).** Uploading milestone evidence, a requested client document, a
   partner document or filing evidence writes a `document_check` event in the same transaction. The dispatcher asks
   the AI model for a check and stores it as an `ai_drafts` row (kind `document_check`, confidence UNCERTAIN):
   detected type, match to what the step asked for, dates and expiry found, problems. Only file metadata is sent
   (the file name reduced to document words, dates and the extension; declared kind, reference and expiry; what was
   required); never the file, a person's name, an ID number or contact details. The draft never changes the
   document: ops says whether the check is right with one click, recorded with the time
   taken. A model failure means no draft, never a blocked step. The in-memory model reads names and declared fields
   only; reading the file itself waits for the AI key (O16).
3. **Triage queue.** `GET /api/ops/queue` returns every item ranked by a pure function in `packages/core`
   (`triage.ts`):
   - a target time per kind in working hours (UAE calendar with the holidays from Settings);
   - a risk score from explainable factors: how far past or near its target, whether a client or partner is
     blocked, a dispute, a partner with a weak scorecard, money waiting to move; each item lists its factors;
   - the score orders the queue and decides nothing.
   Each item has a "why it is here" sentence, its due time, the inline draft (scoping, document check) and its
   one-click actions only where the card shows everything the click decides: publish an offer, pass or send back
   evidence, record whether a document check is right, mark a lead handled, attribute a delay, verify a partner
   document, mark filing evidence met, retry or settle a message. Scoping advice, scope drafts and obligation dates
   (statutory or client-facing content the card does not show) and payouts open their own page. Only ops and the
   founder act from the queue; finance reads it.
   New kinds: messages not delivered or not confirmed, client documents overdue (requested 3 working days ago and
   not uploaded), partner licences expiring within 30 days.
4. **Queue timings.** Opening or acting on an item from the queue records `opened_at`; the item's resolution time
   is recorded when it leaves the queue. Handling time is open to resolution, capped at 30 minutes. The founder
   dashboard shows, for the period: items resolved, share within target, median time in queue per kind, and ops
   minutes per engagement.
5. **Ops home.** The queue page shows the ranked list with due and overdue chips, the why line, the draft and the
   buttons, filters by kind, and the counts by kind. Accessible at 1280 px and 390 px.

## Exclusions

- A real AI model (needs the key and spend cap; O16). Agent kinds other than the document checker (O16).
- Webhook delivery to third parties (no consumer exists yet); the outbox topic list is closed in code.
- WhatsApp delivery (O14). Learning-loop metrics beyond acceptance and time to decision (O16).
- State machines as data, idempotency keys on routes, structured logs (O13).

## Acceptance evidence

- `apps/api/test/outbox.test.ts`: a rolled-back change leaves no outbox row and sends nothing; a committed change
  sends exactly once even when flushed twice or by two dispatchers at once; a refusal retries with backoff and ends
  `failed` after five attempts and shows in the queue; a stale claim becomes `unknown`, is never re-sent on its own,
  and "Send again" / "Mark as delivered" / "Cancel" are audited and staff-only; sign-in codes never enter the outbox.
- `apps/api/test/triage.test.ts` and `packages/core` tests: ranking order (overdue before due, dispute before a lead),
  targets in working hours across a weekend and a holiday, every factor listed, one-click actions per kind; the
  document checker drafts on each upload type, sends only metadata, and failure produces no draft and no block.
- Queue timings: open and resolve produce handling and waiting times; the founder dashboard shows them and ops does
  not see margin.
- `scripts/smoke.mjs`: the ranked queue with why lines and a one-click action, the document check draft beside
  evidence, at 1280 px and 390 px, axe-core clean. Screenshots and log under `docs/evidence/O11/`.

## Dependencies and owner decisions

Depends on O10 (merged). Owner decisions: none required. Defaults chosen and recorded in `docs/DECISIONS.md`:
target times per kind, the retry schedule, the 10-minute claim lease, the 30-minute handling cap.

## Risks

- A change in how every message is sent: mitigated by keeping templates, branding and the notifications record
  unchanged, and by the existing notification tests running unchanged against the outbox.
- Double sends after a crash: prevented by design (unknown → a person decides), tested.
- Ranking that hides something urgent: every item stays in the list; the score only orders it, and its factors show.

## Rollback

Migration `011_outbox.sql` is additive. Reverting the branch restores in-memory delivery; rows left in `outbox`
are ignored by the old code (anything pending at that moment would need a manual resend, listed in the runbook).

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 57 core + 203 API = 260 (O10: 235), all passing on PGlite and on PostgreSQL 16; `pnpm typecheck` clean. New: `apps/api/test/outbox.test.ts` (9), `apps/api/test/queue.test.ts` (10), `packages/core/test/triage.test.ts` (6) |
| Outbox | a rolled-back change leaves no row and sends nothing; a committed message is sent once with four dispatch calls from two notifiers; refusals retry after 1, 5, 15, 60 minutes and end `failed` in the queue; a timeout ends `unknown`, never re-sent on its own; a claim abandoned with the message handed over becomes `unknown`, one abandoned before is resent; a run that outlived its claim changes nothing; Retry, Mark delivered and Cancel are ops-only, need a reason (except retry) and are audited; sign-in codes never enter the outbox; erasure cancels and scrubs a person's unsent messages |
| Document checker | a draft per upload (UNCERTAIN), from metadata only with names and ID numbers removed from the file name; shown beside the step in QA and the partner document; "Check is right / wrong" recorded with the time taken; a failing model blocks nothing and leaves no draft; a rolled-back upload raises no check |
| Ranking | targets in working hours across a weekend and a holiday; overdue before due, a dispute before a lead; every factor listed; one bad arrival time cannot break the queue (the `applied` move that did is fixed); overdue client documents arrive at the overdue point |
| Roles | clients and partners get 403; finance reads the queue with no buttons; ops sees no payout release |
| Timings | open and resolve give handling minutes (7) and the founder dashboard shows items resolved, within target, median wait per kind and ops minutes per engagement; ops sees the same figures (no money in them) |
| Smoke | `docs/evidence/O11/log.txt` (145 checks OK on a fresh demo): the ranked queue with why lines and the check beside the licence, the filter, one-click "Check is right"; `70-ops-command-centre.png` (1280 px), `71-mobile-command-centre.png` (390 px); axe-core zero violations on 24 screens including the command centre at both widths (`docs/evidence/O11/axe.json`) |

## Could not verify

SES itself: the in-doubt rule is tested with a transport that times out after delivering, not against SES. The
document checker with a real model (O16). How the targets and weights feel to MKW's ops team over a real week.

## Review

A reviewer who had not seen the build read the contract and the diff and ran the suites on PGlite and PostgreSQL 16.
Seven should-fix findings, all fixed with a test:

| Finding | Fix |
| --- | --- |
| Moving a partner to `applied` by hand left no arrival time, and the queue, the overview, the digest and the timings job all failed (500) | The move records the time; the query falls back to the firm's creation; the ranking clamps a missing or absurd time instead of failing |
| A timeout after SES took the email was retried as a refusal: the client got it twice | Only a 4xx answer is a refusal; a timeout, a dropped connection or a 5xx marks the message `unknown` for a person |
| Overdue client documents arrived already 18 working hours past their target | The item arrives when the documents become overdue and its target runs from there |
| One click approved scoping advice and confirmed obligation dates the card did not show (rule 5) | Those open their own page; one-click stays only where the card shows everything it decides; payout release left to the weekly run |
| A run that outlived its claim could override a recovery or a person's cancel; a document check could be drafted twice | Every update after a handler checks the claim (exact timestamp text, as Postgres keeps microseconds); a unique index allows one check per event; recovery audits only what it changed |
| Erasure left provider error text (which can quote the address) in the outbox | Cleared with the address |
| Raw file names (often a person's name and ID number) were meant for the model | Reduced to document words, dates and the extension before the model sees them |

Nits fixed: the dispatcher's follow-up run no longer misses work written at the end of a run; buttons repeated on every
card name their item for screen readers; the unused attention query is removed; tests now cover Send again and Cancel
auditing and a rolled-back check. Kept, with reasons in D56: queue timings are measurements and not audited; a slow
queue view can briefly re-open an item that was just resolved (its next view closes it).

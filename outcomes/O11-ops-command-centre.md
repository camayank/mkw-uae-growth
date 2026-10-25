# O11 Ops command centre and event outbox

Status: in-progress (branch `outcome/O11-ops-command-centre` from `main`, released by the owner 25 Oct 2026)

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
   (name, type, size, declared kind, reference and expiry, what was required); never the file, never contact
   details. The draft never changes the document: ops agrees or disagrees with one click, recorded with the time
   taken. A model failure means no draft, never a blocked step. The in-memory model reads names and declared fields
   only; reading the file itself waits for the AI key (O16).
3. **Triage queue.** `GET /api/ops/queue` returns every item ranked by a pure function in `packages/core`
   (`triage.ts`):
   - a target time per kind in working hours (UAE calendar with the holidays from Settings);
   - a risk score from explainable factors: how far past or near its target, whether a client or partner is
     blocked, a dispute, a partner with a weak scorecard, money waiting to move; each item lists its factors;
   - the score orders the queue and decides nothing.
   Each item has a "why it is here" sentence, its due time, the inline draft (scoping, document check) and its
   one-click actions where the action needs no further input: publish an offer, pass evidence, approve scoping
   advice, approve or discard a draft, mark a lead handled, attribute a delay, verify a partner document, confirm an
   obligation or mark it met, retry or settle a message. Everything else opens the right page.
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

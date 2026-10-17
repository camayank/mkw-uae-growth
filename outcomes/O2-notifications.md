# O2 Notifications

Status: in-progress (branch `outcome/O2-notifications`, stacked on `outcome/O1-production-foundation`)

## Business result

Every notice the platform raises reaches the right person by email with approved wording and the right sender
name, shows up in the person's own in-app bell, and is recorded with its delivery result, so MKW can answer
"did the client get the offer?" from the console. Ops starts each working day with one digest of what needs a
person. Nothing is sent that a person or a tested rule did not trigger.

## Scope

1. **Templates.** Eleven named templates with fixed English wording in `apps/api/src/lib/templates.ts`
   (the nine existing ones, `user_invited` from O1, and `ops_digest`). Variables are typed; no free text typed
   by a user is ever placed in a message. Branding by audience: messages to clients come from
   "Tasees, by MKW Advisors"; messages to partners and MKW staff come from "MKW Advisors" and never say "Tasees".
2. **Delivery record and in-app bell.** A `notifications` table records every send with audience, subject,
   body, status (queued, sent, failed, skipped), provider reference and error. Rows addressed to a known user are
   that user's in-app notifications: `GET /api/notifications` (own rows and unread count, enforced by row-level
   security), `POST /api/notifications/read`. Sign-in codes are email-only and never appear in the bell.
3. **Email adapter.** `Transport` interface with `memoryTransport` (tests), `consoleTransport` (development)
   and `sesTransport` (Amazon SES v2 API, signed with the SigV4 code from O1, no SDK). Chosen by `EMAIL=ses|console`.
   Sender addresses from `EMAIL_FROM_CLIENT` and `EMAIL_FROM_PARTNER`. The notifier queues sends and flushes
   after the calling transaction has finished, so a rolled-back change never produces an email.
4. **Ops digest.** A scheduled rule (`jobs/run.ts`): once per UAE working day, between 08:00 and 10:00 GST, if
   no digest went out that day, ops and the founder receive the exception-queue counts. Tested with the clock.
5. **Console.** Bell with unread count in the header for every role; `#/notifications` page; delivery log for
   platform roles on the Settings page.

## Exclusions

Arabic templates (O9); WhatsApp (needs a Business number; later); SPF/DKIM DNS set-up (owner's DNS); rate
limiting of outbound email beyond the provider's own; marketing or digest emails to clients.

## Acceptance evidence

- Tests: every template renders with its branding rule (no "Tasees" to partners or staff; "Tasees, by MKW
  Advisors" to clients); user free text is never in a body; a flow produces the expected notifications for client,
  partner and ops with rows in `notifications`; a client reads only their own rows (database refuses others);
  mark-read works; the digest fires once per working day and not on Friday evening or Saturday; the SES transport
  signs correctly against a loopback fake and reports provider errors as `failed` rows; a failed delivery never
  blocks the business transaction.
- Smoke test: the client's bell shows the offer and payment notices; the notifications page is screenshotted at
  1280 px and 390 px; the delivery log on Settings is screenshotted.
- Real emails received at the owner's inbox: needs the SES account and DNS (not available in this run).

## Dependencies and owner decisions

- Email provider account (Amazon SES in me-central-1 suggested) and DNS access for SPF, DKIM and DMARC on
  mkwadvisors.com; sender addresses (suggested `hello@tasees.ae` or `tasees@mkwadvisors.com` for clients,
  `partners@mkwadvisors.com` for partners).
- Approval of the template wording in `templates.ts`.

## Risks

- A deliverability problem (no DKIM) sends client offers to spam: covered by the DNS step before launch.
- Email is best-effort by nature; the in-app bell and the delivery log are the record of truth.

## Rollback

`EMAIL=console` keeps everything in the log and the bell with no email; reverting the pull request removes the
table (additive migration) and restores the console notifier.

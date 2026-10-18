# Known gaps

What this starter does not do yet, most important first. "Built" below means working, tested and exercised
in a browser; everything listed here is not.

## Before the first real client

1. **Email sending.** `consoleNotifier` prints messages instead of sending them. Add an adapter for an email
   provider (SES in a UAE-adjacent region, Postmark, Resend) implementing `Notifier.send`. The template
   names (`login_code`, `offer_ready`, `payment_due`, `allocation_offered`, `allocation_reassigned`,
   `milestone_ready_for_review`, `milestone_qa_rejected`, `change_order_to_approve`, `payout_released`) are listed
   in `apps/api/src/lib/notify.ts`; each needs its wording written and approved.
2. **Payment provider.** `/api/webhooks/payments` accepts a shared-secret call marking a payment paid. Wire it
   to the chosen provider's signed webhook (verify their signature, not only the shared secret) and create
   payment links on acceptance. Finance can record bank transfers by hand today.
3. **Tax invoices.** No VAT tax invoice PDFs yet. MKW Advisors needs FTA-compliant tax invoices for every
   payment (TRN, sequential number, VAT breakdown). Generate them from `payments` and store them as evidence.
4. **Verified fee and rule data.** Government fees and market mids in `seed-data.ts` are working estimates
   from the Service Catalogue. Scope rules in `packages/core/src/scope.ts` are simplified. A qualified person
   must verify both; uncertain results must be shown as uncertain to ops, never as fact.
5. **Admin screens for partners and users.** Ops can pause or resume partners and edit profile fields through
   `PUT /api/ops/partners/:id`, but creating partner organisations, users and licence checks is by SQL.
6. **Object storage.** Evidence files go to local disk. Implement the `Storage` interface for S3-compatible
   storage in a UAE region, with server-side encryption, before running more than one instance.

## Soon after

7. **Lead page → platform.** The public Tasees lead page and the Sheet capture leads today; ops creates the
   request here. Add a public intake endpoint with consent capture and spam protection.
8. **Fairness share by category.** The cap uses each partner's share of all jobs this month; the rule in the
   partner agreement is per category.
9. **Partner scorecard.** Quality, on-time delivery and SLA strikes are stored on the partner profile but not
   yet recomputed from delivery history.
10. **Arabic and right-to-left layout** for client screens.
11. **WhatsApp notifications** (via the WhatsApp Business API) alongside email.
12. **Accounting export** of payments, payouts and VAT to the accounting system.
13. **Shared rate limiting.** Sign-in limits are per process; use the proxy or a shared store with more than
    one instance.
14. **Compiled production build** instead of running TypeScript with `tsx`.

## Verified so far

- 40 domain tests (`packages/core`) and 28 API tests (`apps/api`), all passing; typecheck clean.
- `pricing.test.ts` reproduces the Google Sheet Offer Builder example exactly.
- `security.test.ts` shows Postgres refusing margin and partner-cost columns to clients, client price to partners,
  and other organisations' rows; sign-in throttling; security headers.
- A browser run (Chromium) drove one engagement end to end through the web app as client, ops, finance and three
  partners, with no page errors under the content security policy; the client page showed no partner cost,
  margin, phone number or email, and the mobile layout had no horizontal scroll.

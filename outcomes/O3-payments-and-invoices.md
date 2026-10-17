# O3 Payments and invoices

Status: verified-pending-merge (branch `outcome/O3-payments-and-invoices`, stacked on O4, 17 Oct 2026)

## Business result

A client who accepts an offer gets a card payment link and a bank reference; when the money arrives (card
webhook or finance recording a transfer) an FTA-style tax invoice is issued, numbered in sequence, with MKW's
TRN and VAT in AED, and a refund produces a credit note. The client can see a statement of account. Partners
upload their own invoice against each payout; finance runs payouts weekly as one batch, downloads the bank
bulk-transfer file, and marks the run paid, which releases the payouts and sends each partner a remittance
advice. Nothing is paid, issued or refunded without a person's action or a signed message from the provider.

## Scope

1. **Payment provider adapter.** `PaymentProvider` with `createLink` and `verifyWebhook`; `memoryProvider`
   (tests and development; links to a local "pay" page) and a generic signed-webhook contract
   (`x-webhook-timestamp`, `x-webhook-signature: sha256=HMAC(secret, "<ts>.<raw body>")`, five-minute window,
   amount must match). The real provider (Network International, Telr, Checkout.com or Stripe UAE) is wired
   when the merchant account exists; until then `PAYMENT=memory`.
2. **Payment links.** Created on acceptance for the deposit and on completion for the balance; shown to the
   client and sent in the `payment_due` message. Finance can still record a bank transfer by hand.
3. **Tax invoices and credit notes.** `invoices` table, sequential numbers per year (`TI-2026-000001`,
   `CN-2026-000001`), MKW legal name, TRN and address from `settings.company`, client name and TRN, net, VAT at
   5% and gross in AED, one line per fee; government fees shown as disbursements at cost with no VAT (the tax
   adviser's confirmation is recorded as UNCERTAIN in the settings). A PDF is generated with no dependency
   and stored through the storage adapter. If MKW's TRN is not yet entered, the invoice is held as
   `pending_trn` and the founder issues the held invoices after entering it. A full refund recorded by finance
   produces a credit note.
4. **Statements.** `GET /api/client/statement` (own) and `GET /api/ops/clients/:id/statement`: payments,
   invoices, credit notes, balance due.
5. **Partner invoices.** A partner admin uploads its invoice (file, number, amount, VAT) against an eligible
   payout; a payout without one cannot be released or included in a run.
6. **Payout runs.** Finance creates a run from eligible payouts that have an invoice; downloads the bank
   bulk-transfer CSV (generic columns until the bank's sample arrives); marks the run paid with the bank
   reference, which releases every payout in the run, audits it and sends each partner a remittance advice.
   Partner bank details (beneficiary, IBAN, bank) are kept by the partner admin.

## Exclusions

Partial refunds; multi-currency; the provider-specific signature format (generic HMAC contract until the
provider is chosen); accounting export (O8); service guarantee credits (O6); e-invoicing (UAE rollout; later).

## Acceptance evidence

- Tests: link created on acceptance; webhook with a bad signature, stale timestamp or wrong amount is refused
  and changes nothing; a good one marks paid once (idempotent) and issues a numbered invoice; numbers are
  sequential and gap-free across engagements; the PDF opens (valid header, text present); TRN missing holds the
  invoice, entering it issues the held ones; refund → credit note and statement balance; clients see only their
  own invoices (database); partners never see invoices or payments; a payout cannot be released or batched
  without a partner invoice; a payout run exports a CSV whose total equals the sum of the payouts; marking it
  paid releases them and sends remittances; ops cannot do any of this.
- Smoke: client sees the payment link and, after payment, downloads the invoice; finance creates a run and
  downloads the bank file; screenshots at 1280 px and 390 px.

## Dependencies and owner decisions

- Merchant account and keys; MKW's TRN, legal name and address for invoices; the bank's bulk-transfer sample;
  the tax adviser's ruling on government fees as disbursements.

## Risks

- Invoice numbering must never skip or repeat: a per-year counter row is locked in the issuing transaction.
- A webhook replay must not pay twice: idempotent on payment status, five-minute timestamp window.

## Rollback

Additive migration; `PAYMENT=memory` keeps the flow working without a provider; reverting restores the
shared-secret webhook of the starter.

## Evidence

| Claim | Evidence |
| --- | --- |
| Tests | `pnpm test`: 40 core + 96 API = 136 (O4: 126); `apps/api/test/payments.test.ts` (10 tests); flow test updated to the signed webhook and the partner-invoice rule |
| Webhook | unsigned 401, wrong secret 401, 6 minutes old 401, tampered body 401, short amount 409; payment stays pending; refusals audited; good message 200 and idempotent |
| Invoices | held without TRN (client sees none), TRN validated (15 digits), founder-only; live payment takes 000001, held one 000002; fee lines VAT 5%, disbursement lines no VAT, lines sum to the payment; PDF header/xref/EOF and text checked; client downloads own, partner 403, anonymous 401; RLS: other client sees nothing, `file_key` denied |
| Refund | credit note CN-2026-000001 with negative totals, payment refunded, payouts withheld, second refund 409, statement totals move |
| Partner invoices and runs | wrong amount 400, staff 403, only the owning partner 200; IBAN validated; bank change audited with last four digits only; run total = sum(payout + VAT) = bank file total, one line per partner; mark paid releases all, one audit event per payout, remittances from "MKW Advisors" without "Tasees"; ops 403 everywhere |
| Smoke | `docs/evidence/O3/log.txt` (43 checks OK); screenshots `29-settings-company.png`, `30-client-statement.png`, `31-partner-payouts.png`, `32-finance-payout-runs.png` (1280 px), `33-mobile-partners-runs.png`, `34-mobile-statement.png` (390 px) |

## Could not verify

A real card payment end to end (no merchant account); the invoice against an accountant's review (no TRN yet);
the bank file against the bank's importer (no sample file).

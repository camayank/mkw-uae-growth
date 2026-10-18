# Decisions

## Made in this codebase

**D1. MKW Advisors is the merchant of record for reseller services.** The client contracts with and pays
MKW Advisors; partners are subcontractors paid their own cost. This keeps one price and one invoice for the
client and makes margin a commercial matter, not a disclosed commission. Regulated services (FTA tax agency,
statutory audit, liquidation) use the **agent model**: the licensed firm is the provider and MKW's
coordination fee is shown separately, because those services cannot be resold.

**D2. Integer fils and basis points everywhere.** No floating point in money. Rounding happens once, at the
end of each rule, and splits use the largest-remainder method so parts always add up to the whole.

**D3. Postgres enforces who sees what, not only the application.** Row-level security and column grants per
role mean a bug in a query cannot leak margin to a client or the client price to a partner. Writes go through
server-side commands that authorise in code first, then run as the platform role.

**D4. One price rule.** `max(cost × (1 + rate), cost + floor)`, rounded up to AED 50, capped at
1.25 × market mid; a line whose cap would cut margin below the floor goes to ops review. The same rule prices
change orders. Rates and floors per category live in the database (seeded from the Sheet).

**D5. Allocation protects margin before it spreads work.** The fairness cap (35% of a month's jobs) only
re-routes to a partner who passes every hard check *and* whose own cost is no higher than the cost the client's
price was built on. This was added after the browser smoke test showed a re-route to a dearer partner producing
a negative margin line; `exceptions.test.ts` now fails if it comes back.

**D6. Milestones close only on evidence.** A step moves `evidence submitted → MKW check → client approval`.
"Done" without the required evidence types is refused. Clients who do not respond are auto-approved after 5
working days, which is in the client terms.

**D7. Partners are paid from money received.** 40/40/20 staged payouts become eligible on milestones and on the
client's payment; only finance or the founder can release them.

**D8. Append-only audit chain.** Every state change writes an event hashed with the previous event's hash. The
audit screen checks the chain.

**D9. No build step for the web app.** Plain ES modules served by the API keep the starter easy to run and
audit. Move to a framework when the screens outgrow this, keeping the API unchanged.

**D10. Application clock.** Database timestamps use `app_now()`, which follows the server's clock (or a test
clock) so SLA rules and stored times agree. Sessions and sign-in codes use real database time.

**D11. Passwordless sign-in.** Six-digit email codes, hashed, 10-minute life, 5 attempts per code, 5 codes per
account per hour, per-IP limits on the endpoints. Sessions are 14-day HttpOnly cookies.

**D12. Compiled build, one condition.** Production runs `tsc` output under plain Node 22. TypeScript was raised
from 5.6.3 to 5.9.3 (pinned) for `rewriteRelativeImportExtensions`, which emits the sources' `.ts` imports as
`.js` without rewriting a single source file, so development, tests and the seed script keep running the
TypeScript directly. `@tasees/core` exports its compiled output under the `production` condition and its sources
by default; `node --conditions=production` is set by every production script and the Dockerfile. To remove:
delete the `tsconfig.build.json` files, the `build` scripts and the `exports` condition, and run `tsx` again.

**D13. S3 signing written in-house, no SDK.** The object storage adapter signs requests with AWS Signature
Version 4 using `node:crypto` and the global `fetch` (about 120 lines) instead of adding the AWS SDK (hundreds
of transitive packages, each a supply-chain exposure for the one process that holds client documents). The
algorithm is checked against AWS's two published S3 test vectors and against a loopback fake bucket that
recomputes the signature from what it receives; a real bucket must still be exercised in staging. To remove:
replace `s3Storage()` with an SDK-backed `Storage` and delete the signing functions.

**D14. Playwright 1.49.1 as a pinned development dependency** (Apache-2.0, maintained by Microsoft) for the
browser smoke test that CI runs against the compiled build. It is never installed in the production image
(`pnpm install --prod`). To remove: delete it from the root `package.json` and the smoke step from CI.

**D15. Erasure tombstones; it never deletes.** A PDPL erasure replaces the person's name, email and the text of
messages they wrote, deletes their sessions and codes, and deactivates the account. Every foreign key still
resolves, payments and payouts keep their amounts, and audit rows are untouched because each hash covers the one
before it. What a person wrote into other fields (a dispute reason, a decline reason, a change-order description,
an evidence file name) stays, because those rows have no author column and are part of the engagement record;
KNOWN-GAPS lists this. Only the founder may erase, and never their own account.

**D16. Audit functions pin their time zone.** The hash covers the event time as text, so `audit_append` and
`audit_verify` run with `timezone = UTC` and `datestyle = ISO, MDY` set on the function itself. The formula is
unchanged; events written before this setting (all under UTC sessions) still verify.

**D17. Notifications go out after the transaction commits.** Inviting a person records the account and audit
event in one transaction and sends the invitation only once that has committed, so a rolled-back change never
produces an email.

**D18. Messages are records first, emails second.** Every notice is written to the `notifications` table with
its audience, wording and delivery result before any email leaves, and rows addressed to a known user are
that user's in-app bell. Email is best-effort; the table is the record of truth, and the delivery log on the
Settings page is how MKW answers "did they get it?". Sign-in codes are email-only.

**D19. Notifications leave after the transaction commits.** `asPlatform`/`asUser` open an async scope; a
`send()` inside it is held and released only after `db.transaction` returns, so a rolled-back change never
produces an email (tested), and a slow provider never holds a database transaction open. The cron job path
uses the same recording notifier and flushes at the end. A provider failure marks the row `failed` and is
never thrown into business code. Sign-in codes are recorded as "sent" with no wording and no variables, so
the delivery log can never be used to sign in as someone else.

**D20. Amazon SES through its HTTPS API, signed in-house.** Same reasoning as D13: the SigV4 code already
exists and is tested; one more SDK is one more supply chain. `EMAIL=console` keeps everything in the log for
development and for any environment without a verified sender.

**D21. Wording by audience, no free text.** Each template exists once with typed variables; the audience
(client, partner, staff) decides the sender name and sign-off. A QA note, a decline reason or a change-order
description is read on the engagement page and never placed in a message. The one typed value that does
appear is an organisation's own name in its invitation (`user_invited`), entered by MKW staff.

## Open for the owner

1. **Margin rates and floors per category.** Seeded from the Sheet (setup 20% / AED 500 and so on). Confirm.
2. **Fairness cap and quality bar.** 35% and 60/100. Lower the cap to spread work faster; raise the bar to
   protect quality.
3. **Deposit size.** 50% of fees plus all government fees. Some free zones need full payment up front.
4. **Service guarantee.** Client terms refund [10]% of fees if a step is more than 5 working days late. Confirm
   the figure and whether the partner bears it.
5. **Payment provider.** Network International, Telr, Checkout.com or Stripe (UAE). The webhook is generic.
6. **Hosting region and provider** (see DEPLOY.md, data residency).
7. **Whether partners may see the client's company name before accepting.** Today they see only emirate, zone
   and the services; the name appears after they accept and become a party.
8. **Retention periods** (Settings page): 5 years for tax records, client documents and messages, audit trail
   kept indefinitely. Shown as UNCERTAIN until confirmed after legal advice.
9. **Who may erase a person's data.** Built as founder-only; ops can export.
10. **Cloud provider and region for O1 staging.** AWS me-central-1 suggested (native S3 and RDS); see DEPLOY.md.
11. **Template wording** in `apps/api/src/lib/templates.ts` and the two sender addresses (suggested
    `tasees@mkwadvisors.com` for clients, `partners@mkwadvisors.com` for partners).
12. **Ops digest time**: once per working day between 08:00 and 10:00 GST, to ops and the founder.
